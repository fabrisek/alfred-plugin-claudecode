/**
 * The account pool: which subscription seats exist, their persisted state, and
 * which one serves the next request.
 *
 * Every request picks its account synchronously from a snapshot and keeps it
 * for its whole life — there is no shared "current account", so parallel
 * conversations and `delegate_parallel` children each run their own CLI
 * process on whichever seat they were given.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@alfred/sdk';
import { unlinkSharedDirs } from './sharedSessions.js';
import {
  applyRateLimitInfo,
  blockingReset,
  relevantPercent,
  type AccountUsage,
  type RateLimitInfo,
} from './usage.js';

export type AuthKind = 'login' | 'token';
export type Strategy = 'fill' | 'spread';

export type Account = {
  id: string;
  label: string;
  enabled: boolean;
  /** Lower = preferred. */
  priority: number;
  auth: AuthKind;
  /**
   * `CLAUDE_CONFIG_DIR` for this seat. `null` only for the imported default
   * login, which keeps using the CLI's own default (`~/.claude`) untouched.
   */
  configDir: string | null;
  /** Also list `<model>@<id>` variants in the model picker, to pin agents to this seat. */
  exposeModels: boolean;
  createdAt: number;
};

export type AccountRuntime = {
  usage?: AccountUsage;
  /** The seat is out of quota (or rate limited) until this epoch ms. */
  exhaustedUntil?: number;
  exhaustedReason?: string;
  /** Last auth failure seen on a real request; cleared by a successful one. */
  authFailed?: string;
  lastError?: { message: string; at: number };
  lastUsedAt?: number;
  requests: number;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
};

export type PoolSettings = {
  strategy: Strategy;
  /** Percent (0-100) of any relevant window at which `fill` moves on. */
  threshold: number;
  /** Background usage poll interval, minutes. */
  usagePollMinutes: number;
  /**
   * `fill` only: requests one seat may serve at once before the next seat
   * under the threshold takes the overflow (a fan-out must not land on one
   * seat). 0 = no cap.
   */
  fillMaxInFlight: number;
};

/** Token counts as the CLI reports them in each turn's `result.usage`. */
export type Tally = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** API-equivalent cost reported by Claude Code. Informational: a seat is not billed per token. */
  costUsd: number;
  requests: number;
};

export type TokenSample = Omit<Tally, 'requests'>;

/** Compact per-seat ledger: a lifetime total plus sparse hourly buckets for the last 8 days. */
type TokenLedger = { total: Tally; hours: Array<[number, Tally]> };

export type TokenSummary = {
  window5h: Tally;
  week: Tally;
  total: Tally;
  /** Epoch ms the 5h / week sums start from (approximate to the hour). */
  window5hStart: number;
  weekStart: number;
};

export type ServedRecord = {
  at: number;
  accountId: string;
  model: string;
  outcome: 'ok' | 'error' | 'switched';
  /** Agent that made the call, when the host passes it through. */
  agent?: string;
  tokens?: TokenSample;
  detail?: string;
  /** `session` for a full Claude Code agent run (`claude_code_run`); absent for a chat completion. */
  kind?: 'session';
  /** Model id the API actually served (e.g. `claude-opus-5-5`) when `model` is an alias. */
  servedModel?: string;
};

type StateFile = {
  version: 1;
  accounts: Account[];
  runtime: Record<string, AccountRuntime>;
  settings: PoolSettings;
  recent: ServedRecord[];
  tokens: Record<string, TokenLedger>;
  /** Last real model id each requested model (alias) resolved to. */
  servedModels?: Record<string, string>;
};

type SecretsFile = { tokens: Record<string, string> };

export const DEFAULT_SETTINGS: PoolSettings = { strategy: 'fill', threshold: 90, usagePollMinutes: 5, fillMaxInFlight: 4 };

/** How long a seat sits out after a bare 429 (no quota rejection, no reset time). */
export const THROTTLE_BACKOFF_MS = 20_000;
const RECENT_MAX = 50;
const HOUR_MS = 3_600_000;
const LEDGER_KEEP_MS = 8 * 24 * HOUR_MS;

export function emptyTally(): Tally {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, requests: 0 };
}

function addTo(t: Tally, s: TokenSample, requests = 1): void {
  t.input += s.input;
  t.output += s.output;
  t.cacheRead += s.cacheRead;
  t.cacheWrite += s.cacheWrite;
  t.costUsd += s.costUsd;
  t.requests += requests;
}

const DEFAULT_ACCOUNT_ID = 'default';

export type PickResult =
  | { account: Account; reason?: undefined }
  | { account?: undefined; reason: string };

export type PoolOptions = {
  dataDir: string;
  logger: Logger;
  /** Legacy single `oauthToken` from the plugin settings; used by the default account. */
  legacyToken?: string;
  now?: () => number;
};

export class AccountPool {
  private state: StateFile;
  private secrets: SecretsFile;
  private readonly inFlight = new Map<string, number>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly secretsPath: string;

  constructor(private readonly opts: PoolOptions) {
    this.now = opts.now ?? Date.now;
    mkdirSync(opts.dataDir, { recursive: true });
    this.statePath = join(opts.dataDir, 'accounts.json');
    this.secretsPath = join(opts.dataDir, 'account-secrets.json');
    this.state = this.loadState();
    this.secrets = this.loadSecrets();
  }

  // ---- persistence -------------------------------------------------------

  private loadState(): StateFile {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<StateFile>;
      return {
        version: 1,
        accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
        runtime: raw.runtime && typeof raw.runtime === 'object' ? raw.runtime : {},
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        recent: Array.isArray(raw.recent) ? raw.recent : [],
        tokens: raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : {},
        servedModels:
          raw.servedModels && typeof raw.servedModels === 'object' ? raw.servedModels : {},
      };
    } catch {
      // First run: the login the plugin has always used becomes account #1, so
      // nothing changes for an existing install.
      return {
        version: 1,
        accounts: [
          {
            id: DEFAULT_ACCOUNT_ID,
            label: 'Default login',
            enabled: true,
            priority: 0,
            auth: 'login',
            configDir: null,
            exposeModels: false,
            createdAt: this.now(),
          },
        ],
        runtime: {},
        settings: { ...DEFAULT_SETTINGS },
        recent: [],
        tokens: {},
      };
    }
  }

  private loadSecrets(): SecretsFile {
    try {
      const raw = JSON.parse(readFileSync(this.secretsPath, 'utf8')) as Partial<SecretsFile>;
      return { tokens: raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : {} };
    } catch {
      return { tokens: {} };
    }
  }

  private writeAtomic(path: string, data: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  /** Persist now. Settings/account edits call this; runtime churn uses {@link touch}. */
  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      this.writeAtomic(this.statePath, this.state);
    } catch (err) {
      this.opts.logger.warn('could not persist account pool', { err: (err as Error).message });
    }
  }

  /** Debounced save for high-frequency runtime updates. */
  private touch(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), 1000);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) this.save();
  }

  // ---- accounts ----------------------------------------------------------

  get settings(): PoolSettings {
    return this.state.settings;
  }

  updateSettings(patch: Partial<PoolSettings>): PoolSettings {
    const s = this.state.settings;
    if (patch.strategy === 'fill' || patch.strategy === 'spread') s.strategy = patch.strategy;
    if (typeof patch.threshold === 'number' && Number.isFinite(patch.threshold)) {
      s.threshold = Math.min(100, Math.max(1, Math.round(patch.threshold)));
    }
    if (typeof patch.usagePollMinutes === 'number' && Number.isFinite(patch.usagePollMinutes)) {
      s.usagePollMinutes = Math.min(120, Math.max(1, Math.round(patch.usagePollMinutes)));
    }
    if (typeof patch.fillMaxInFlight === 'number' && Number.isFinite(patch.fillMaxInFlight)) {
      s.fillMaxInFlight = Math.min(64, Math.max(0, Math.round(patch.fillMaxInFlight)));
    }
    this.save();
    return s;
  }

  list(): Account[] {
    return [...this.state.accounts].sort((a, b) => a.priority - b.priority);
  }

  get(id: string): Account | undefined {
    return this.state.accounts.find((a) => a.id === id);
  }

  runtime(id: string): AccountRuntime {
    let rt = this.state.runtime[id];
    if (!rt) {
      rt = { requests: 0 };
      this.state.runtime[id] = rt;
    }
    return rt;
  }

  inFlightOf(id: string): number {
    return this.inFlight.get(id) ?? 0;
  }

  get recent(): ServedRecord[] {
    return this.state.recent;
  }

  /** Real model id `model` (usually an alias like `opus`) last resolved to, if known. */
  servedModelOf(model: string): string | undefined {
    return this.state.servedModels?.[model];
  }

  add(label: string, auth: AuthKind): Account {
    const base = slug(label) || 'seat';
    let id = base;
    for (let i = 2; this.get(id); i++) id = `${base}-${i}`;
    const maxPriority = Math.max(-1, ...this.state.accounts.map((a) => a.priority));
    const account: Account = {
      id,
      label: label.trim() || id,
      enabled: true,
      priority: maxPriority + 1,
      auth,
      configDir: join(this.opts.dataDir, 'accounts', id),
      exposeModels: false,
      createdAt: this.now(),
    };
    mkdirSync(account.configDir!, { recursive: true });
    this.state.accounts.push(account);
    this.save();
    return account;
  }

  update(id: string, patch: Partial<Pick<Account, 'label' | 'enabled' | 'exposeModels' | 'auth'>>): Account {
    const a = this.require(id);
    if (typeof patch.label === 'string' && patch.label.trim()) a.label = patch.label.trim();
    if (typeof patch.enabled === 'boolean') a.enabled = patch.enabled;
    if (typeof patch.exposeModels === 'boolean') a.exposeModels = patch.exposeModels;
    if (patch.auth === 'login' || patch.auth === 'token') a.auth = patch.auth;
    this.save();
    return a;
  }

  /**
   * The seat order is the one concept the user sets: `fill` takes the first
   * usable seat in it and moves down the list when a seat is exhausted,
   * disabled or over the threshold. "Preferred" is simply position 1.
   */
  setPreferred(id: string): void {
    this.moveTo(id, 0);
  }

  /** Moves a seat to `index` (0 = first), clamped; the others keep their relative order. */
  moveTo(id: string, index: number): Account[] {
    const target = this.require(id);
    const rest = this.list().filter((a) => a.id !== target.id);
    const at = Math.max(0, Math.min(rest.length, Math.round(Number.isFinite(index) ? index : 0)));
    rest.splice(at, 0, target);
    return this.applyOrder(rest);
  }

  /** Moves a seat `delta` places (negative = up). */
  move(id: string, delta: number): Account[] {
    const i = this.list().findIndex((a) => a.id === id);
    if (i < 0) this.require(id);
    return this.moveTo(id, i + Math.round(delta));
  }

  /** Full order by id. Unknown ids are refused; seats not named keep their place after the named ones. */
  reorder(ids: string[]): Account[] {
    const named = ids.map((id) => this.require(id));
    if (new Set(named.map((a) => a.id)).size !== named.length) throw new Error('Duplicate account in the order.');
    const rest = this.list().filter((a) => !named.includes(a));
    return this.applyOrder([...named, ...rest]);
  }

  private applyOrder(order: Account[]): Account[] {
    order.forEach((a, i) => {
      a.priority = i;
    });
    this.save();
    return order;
  }

  /** Remove a seat. Its private config dir (credentials included) goes with it. */
  remove(id: string): void {
    const a = this.require(id);
    this.state.accounts = this.state.accounts.filter((x) => x.id !== id);
    delete this.state.runtime[id];
    delete this.state.tokens[id];
    if (this.secrets.tokens[id]) {
      delete this.secrets.tokens[id];
      this.writeAtomic(this.secretsPath, this.secrets);
    }
    const accountsRoot = join(this.opts.dataDir, 'accounts');
    if (a.configDir && a.configDir.startsWith(accountsRoot)) {
      // Its projects/ etc. may be junctions to the shared session store.
      unlinkSharedDirs(a.configDir);
      rmSync(a.configDir, { recursive: true, force: true });
    }
    this.save();
  }

  setToken(id: string, token: string): void {
    const a = this.require(id);
    const t = token.trim();
    if (t) this.secrets.tokens[id] = t;
    else delete this.secrets.tokens[id];
    this.writeAtomic(this.secretsPath, this.secrets);
    a.auth = t ? 'token' : 'login';
    delete this.runtime(id).authFailed;
    this.save();
  }

  /** The setup-token for a seat, if it uses one. Never sent anywhere but the CLI child env. */
  tokenFor(a: Account): string {
    if (a.auth !== 'token') return '';
    return this.secrets.tokens[a.id] ?? (a.id === DEFAULT_ACCOUNT_ID ? this.opts.legacyToken ?? '' : '');
  }

  /** `.credentials.json` path of a login seat. */
  credentialsPath(a: Account): string {
    return join(a.configDir ?? join(homedir(), '.claude'), '.credentials.json');
  }

  /** `.claude.json` (holds `oauthAccount`) of a seat. */
  globalConfigPath(a: Account): string {
    return a.configDir ? join(a.configDir, '.claude.json') : join(homedir(), '.claude.json');
  }

  /** Credentials present for this seat (no network, no quota). */
  hasCredentials(a: Account): boolean {
    if (a.auth === 'token') return this.tokenFor(a).length > 0;
    return existsSync(this.credentialsPath(a));
  }

  private require(id: string): Account {
    const a = this.get(id);
    if (!a) throw new Error(`Unknown account "${id}".`);
    return a;
  }

  // ---- runtime state -----------------------------------------------------

  setUsage(id: string, usage: AccountUsage): void {
    this.runtime(id).usage = usage;
    this.touch();
  }

  markUsageStale(id: string, reason: string): void {
    const rt = this.runtime(id);
    if (rt.usage) rt.usage = { ...rt.usage, stale: reason };
    else rt.usage = { windows: [], fetchedAt: this.now(), source: 'api', stale: reason };
    this.touch();
  }

  setIdentity(id: string, info: { email?: string; orgName?: string; subscriptionType?: string }): void {
    const rt = this.runtime(id);
    if (info.email) rt.email = info.email;
    if (info.orgName) rt.orgName = info.orgName;
    if (info.subscriptionType) rt.subscriptionType = info.subscriptionType;
    this.touch();
  }

  /** Live update from the CLI stream. Returns the reset (ms) when the seat is now rejected. */
  applyRateLimit(id: string, info: RateLimitInfo): number | null {
    const rt = this.runtime(id);
    rt.usage = applyRateLimitInfo(rt.usage, info, this.now());
    this.touch();
    if (info.status === 'rejected') {
      const until = typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : this.now() + 30 * 60_000;
      this.markExhausted(id, until, `rate limit rejected (${info.rateLimitType ?? 'unknown window'})`);
      return until;
    }
    return null;
  }

  markExhausted(id: string, until: number, reason: string): void {
    const rt = this.runtime(id);
    rt.exhaustedUntil = Math.max(until, this.now() + 60_000);
    rt.exhaustedReason = reason;
    this.save();
  }

  /**
   * Short time-out after a transient throttle (bare 429 / "too many
   * requests" without a quota rejection): the seat is skipped for `ms`, not
   * benched until a reset that was never announced.
   */
  backoff(id: string, ms: number, reason: string): void {
    const rt = this.runtime(id);
    const until = this.now() + ms;
    if ((rt.exhaustedUntil ?? 0) >= until) return;
    rt.exhaustedUntil = until;
    rt.exhaustedReason = reason;
    this.save();
  }

  clearExhausted(id: string): void {
    const rt = this.runtime(id);
    delete rt.exhaustedUntil;
    delete rt.exhaustedReason;
    this.save();
  }

  markAuthFailed(id: string, reason: string): void {
    this.runtime(id).authFailed = reason;
    this.save();
  }

  clearAuthFailed(id: string): void {
    const rt = this.runtime(id);
    if (rt.authFailed) {
      delete rt.authFailed;
      this.touch();
    }
  }

  begin(id: string): void {
    this.inFlight.set(id, this.inFlightOf(id) + 1);
    const rt = this.runtime(id);
    rt.lastUsedAt = this.now();
    rt.requests = (rt.requests ?? 0) + 1;
  }

  end(id: string, record: Omit<ServedRecord, 'at' | 'accountId'>): void {
    this.inFlight.set(id, Math.max(0, this.inFlightOf(id) - 1));
    const rt = this.runtime(id);
    if (record.outcome === 'ok') {
      delete rt.authFailed;
    } else if (record.detail) {
      rt.lastError = { message: record.detail, at: this.now() };
    }
    if (record.tokens) this.recordTokens(id, record.tokens);
    if (record.outcome === 'ok' && record.servedModel && record.servedModel !== record.model) {
      (this.state.servedModels ??= {})[record.model] = record.servedModel;
    }
    this.state.recent.unshift({ at: this.now(), accountId: id, ...record });
    if (this.state.recent.length > RECENT_MAX) this.state.recent.length = RECENT_MAX;
    this.touch();
  }

  // ---- token ledger ------------------------------------------------------

  private recordTokens(id: string, sample: TokenSample): void {
    const now = this.now();
    let ledger = this.state.tokens[id];
    if (!ledger) {
      ledger = { total: emptyTally(), hours: [] };
      this.state.tokens[id] = ledger;
    }
    addTo(ledger.total, sample);
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const last = ledger.hours[ledger.hours.length - 1];
    if (last && last[0] === hour) addTo(last[1], sample);
    else {
      const t = emptyTally();
      addTo(t, sample);
      ledger.hours.push([hour, t]);
    }
    const cutoff = now - LEDGER_KEEP_MS;
    while (ledger.hours.length && ledger.hours[0][0] + HOUR_MS < cutoff) ledger.hours.shift();
  }

  /**
   * Tokens in the seat's current 5h window, current week, and lifetime.
   * Windows are anchored on the reset times the usage source reported (reset
   * minus window length); without one, rolling 5h / 7d. Hour-granular.
   */
  tokenSummary(id: string): TokenSummary {
    const now = this.now();
    const usage = this.runtime(id).usage;
    const future = (key: (k: string) => boolean): number | null => {
      const w = usage?.windows.find((x) => key(x.key) && x.resetsAt !== null && x.resetsAt > now);
      return w?.resetsAt ?? null;
    };
    const fiveReset = future((k) => k === 'five_hour');
    const weekReset = future((k) => k === 'seven_day') ?? future((k) => k.startsWith('seven_day_') || k.startsWith('weekly:'));
    const window5hStart = fiveReset ? fiveReset - 5 * HOUR_MS : now - 5 * HOUR_MS;
    const weekStart = weekReset ? weekReset - 7 * 24 * HOUR_MS : now - 7 * 24 * HOUR_MS;
    const ledger = this.state.tokens[id];
    const window5h = emptyTally();
    const week = emptyTally();
    for (const [hour, t] of ledger?.hours ?? []) {
      if (hour + HOUR_MS > window5hStart) addTo(window5h, t, t.requests);
      if (hour + HOUR_MS > weekStart) addTo(week, t, t.requests);
    }
    return { window5h, week, total: { ...(ledger?.total ?? emptyTally()) }, window5hStart, weekStart };
  }

  // ---- selection ---------------------------------------------------------

  /** Why an account cannot serve right now, or null if it can. */
  unavailableReason(a: Account, now = this.now()): string | null {
    if (!a.enabled) return 'disabled';
    if (!this.hasCredentials(a)) return 'logged out';
    const rt = this.runtime(a.id);
    if (rt.authFailed) return `auth failed: ${rt.authFailed}`;
    if (rt.exhaustedUntil && rt.exhaustedUntil > now) return 'exhausted';
    return null;
  }

  /**
   * Choose the seat for one request.
   *
   * - `fill`: first seat in the user's order under the threshold on every window that
   *   constrains this model; if none, the one with the most headroom (ties:
   *   earliest reset).
   * - `spread`: least-utilised first (ties: fewer in-flight, then priority).
   *
   * A pinned seat is tried first when usable; otherwise the pool takes over.
   */
  pick(args: { model: string; pinned?: string; exclude?: Set<string> }): PickResult {
    const now = this.now();
    const { threshold, strategy } = this.state.settings;
    const exclude = args.exclude ?? new Set<string>();
    const usable = this.list().filter((a) => !exclude.has(a.id) && this.unavailableReason(a, now) === null);

    if (args.pinned) {
      const pinned = usable.find((a) => a.id === args.pinned);
      if (pinned) return { account: pinned };
    }
    if (usable.length === 0) return { reason: this.exhaustedMessage(args.model, exclude, now) };

    const scored = usable.map((a) => ({
      a,
      pct: relevantPercent(this.runtime(a.id).usage, args.model, now),
      reset: blockingReset(this.runtime(a.id).usage, args.model, threshold, now) ?? Infinity,
      busy: this.inFlightOf(a.id),
    }));
    if (strategy === 'fill') {
      const under = scored.filter((s) => s.pct < threshold);
      if (under.length > 0) {
        // Priority order, but a seat already serving `fillMaxInFlight`
        // requests lets the next one take the overflow; when every seat under
        // the threshold is that busy, the least busy one serves.
        const cap = this.state.settings.fillMaxInFlight;
        const free = cap > 0 ? under.find((s) => s.busy < cap) : under[0];
        if (free) return { account: free.a };
        return { account: [...under].sort((x, y) => x.busy - y.busy)[0].a };
      }
    }
    scored.sort(
      (x, y) => x.pct - y.pct || x.reset - y.reset || x.busy - y.busy || x.a.priority - y.a.priority,
    );
    return { account: scored[0].a };
  }

  private exhaustedMessage(model: string, exclude: Set<string>, now: number): string {
    const all = this.list();
    if (all.length === 0) return 'No Claude account configured. Add one in the Claude accounts page.';
    let earliest: { at: number; label: string } | null = null;
    const states: string[] = [];
    for (const a of all) {
      const why = exclude.has(a.id) ? 'failed this request' : this.unavailableReason(a, now) ?? 'ok';
      states.push(`${a.label}: ${why}`);
      const until = this.runtime(a.id).exhaustedUntil;
      if (a.enabled && until && until > now && (!earliest || until < earliest.at)) {
        earliest = { at: until, label: a.label };
      }
    }
    const head = earliest
      ? `All Claude accounts are exhausted for ${model}. Earliest reset: ${new Date(earliest.at).toLocaleString()} (${earliest.label}).`
      : `No Claude account can serve ${model} right now.`;
    return `${head} [${states.join('; ')}]`;
  }

  /** Model-picker variants: `<model>@<accountId>` for seats that opted in. */
  pinnableAccounts(): Account[] {
    return this.list().filter((a) => a.exposeModels);
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
