import type { AlfredPlugin, PluginContext } from '@alfred/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ClaudeCodeProvider,
  DEFAULT_MODELS,
  type ClaudeCodeConfig,
} from './ClaudeCodeProvider.js';
import { AccountPool, emptyTally, type Account, type Tally } from './accounts/pool.js';
import {
  authStatus,
  cliVersion,
  openLoginTerminal,
  resolveCli,
  type CliInfo,
} from './accounts/cli.js';
import { fetchUsage, readCredentials } from './accounts/usage.js';
import { createDashboardWebview } from './webview/dashboard.js';
import {
  DEFAULT_SESSION_TOOLS,
  SessionRunner,
  isPermissionMode,
  type SessionConfig,
} from './session/runner.js';
import { SessionIndex } from './session/sessions.js';
import { registerSessionTools } from './session/tools.js';
import { ensureSharedSessionDirs } from './accounts/sharedSessions.js';
import {
  ClaudeSessionAdapter,
  DEFAULT_CHAT_SESSION_CONFIG,
  clampPermissionMode,
  isCliPermissionMode,
  sessionCapabilities,
  type ChatSessionConfig,
} from './agentSession/ClaudeSessionAdapter.js';
import { ClaudeCodeSessionProvider } from './agentSession/ClaudeSessionProvider.js';

function resolveConfig(raw: Record<string, unknown>): ClaudeCodeConfig {
  const ctx =
    typeof raw.contextWindow === 'number' && raw.contextWindow > 0
      ? raw.contextWindow
      : 200000;
  return {
    oauthToken: String(raw.oauthToken ?? '').trim(),
    modelsRaw: String(raw.models ?? '').trim() || DEFAULT_MODELS.join(', '),
    contextWindow: ctx,
    pathToClaude: String(raw.pathToClaude ?? '').trim(),
    requestTimeoutMs:
      typeof raw.requestTimeoutMs === 'number' &&
      Number.isFinite(raw.requestTimeoutMs) &&
      raw.requestTimeoutMs > 0
        ? raw.requestTimeoutMs
        : 120_000,
    maxConcurrentRequests: limitOrUnlimited(raw.maxConcurrentRequests),
    maxParallelTasks: limitOrUnlimited(raw.maxParallelTasks),
  };
}

/** `0` / absent / invalid = unlimited (`0`, the host convention). */
function limitOrUnlimited(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.round(v) : 0;
}

function positive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Settings of the delegated Claude Code sessions (`claude_code_run`). */
function resolveSessionConfig(raw: Record<string, unknown>, cfg: ClaudeCodeConfig): SessionConfig {
  const tools = String(raw.sessionAllowedTools ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    permissionMode: isPermissionMode(raw.sessionPermissionMode) ? raw.sessionPermissionMode : 'acceptEdits',
    allowedTools: tools.length > 0 ? tools : DEFAULT_SESSION_TOOLS,
    model: String(raw.sessionModel ?? '').trim() || firstModel(cfg.modelsRaw),
    // `0` = no wall clock / no turn cap: the session ends when Claude is done
    // (or on Cancel).
    timeoutMs: limitOrUnlimited(raw.sessionTimeoutMs),
    maxTurns: limitOrUnlimited(raw.sessionMaxTurns),
    startTimeoutMs: cfg.requestTimeoutMs,
  };
}

/** CLI agent mode settings (plan §5.4, §3.2). */
function resolveChatSessionConfig(raw: Record<string, unknown>, cfg: ClaudeCodeConfig): ChatSessionConfig & { cliMode: boolean; sharedStore: boolean } {
  const max = isCliPermissionMode(raw.chatPermissionModeMax) ? raw.chatPermissionModeMax : DEFAULT_CHAT_SESSION_CONFIG.permissionModeMax;
  return {
    // `cli` (default): a conversation on this provider runs in Claude Code's
    // own agent loop. `completion`: the old text-only completion path.
    cliMode: raw.chatMode !== 'completion',
    permissionMode: clampPermissionMode(raw.chatPermissionMode, DEFAULT_CHAT_SESSION_CONFIG.permissionMode, max),
    permissionModeMax: max,
    autoSwitchMidTurn: raw.autoSwitchMidTurn !== false,
    startTimeoutMs: cfg.requestTimeoutMs,
    sharedStore: raw.sharedSessionStore !== false,
  };
}

/** Polls each seat's usage, one fetch at a time per seat. */
class UsageRefresher {
  private readonly running = new Map<string, Promise<void>>();
  private readonly lastFetch = new Map<string, number>();
  private readonly scheduled = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSweep = 0;

  constructor(private readonly pool: AccountPool) {}

  start(): void {
    this.timer = setInterval(() => {
      const every = this.pool.settings.usagePollMinutes * 60_000;
      if (Date.now() - this.lastSweep >= every) void this.refreshAll();
    }, 60_000);
    this.timer.unref?.();
    void this.refreshAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refreshAll(): Promise<void> {
    this.lastSweep = Date.now();
    const targets = this.pool.list().filter((a) => a.enabled && this.pool.hasCredentials(a));
    return Promise.all(targets.map((a) => this.refresh(a))).then(() => undefined);
  }

  /** After a request: the CLI just refreshed the token, so the API numbers are readable again. */
  soon(id: string): void {
    if (this.scheduled.has(id)) return;
    if (Date.now() - (this.lastFetch.get(id) ?? 0) < 60_000) return;
    this.scheduled.add(id);
    const t = setTimeout(() => {
      this.scheduled.delete(id);
      const a = this.pool.get(id);
      if (a) void this.refresh(a);
    }, 5_000);
    t.unref?.();
  }

  refresh(a: Account): Promise<void> {
    const existing = this.running.get(a.id);
    if (existing) return existing;
    const p = this.doRefresh(a).finally(() => this.running.delete(a.id));
    this.running.set(a.id, p);
    return p;
  }

  private async doRefresh(a: Account): Promise<void> {
    this.lastFetch.set(a.id, Date.now());
    await this.readIdentity(a);
    let token = '';
    let expiresAt: number | undefined;
    if (a.auth === 'token') {
      token = this.pool.tokenFor(a);
    } else {
      const creds = await readCredentials(this.pool.credentialsPath(a));
      if (creds) {
        token = creds.accessToken ?? '';
        expiresAt = creds.expiresAt;
        this.pool.setIdentity(a.id, { subscriptionType: creds.subscriptionType });
      }
    }
    if (!token) {
      this.pool.markUsageStale(a.id, 'not logged in');
      return;
    }
    const res = await fetchUsage(token, expiresAt);
    if (!res.ok) {
      this.pool.markUsageStale(a.id, res.reason);
      return;
    }
    this.pool.setUsage(a.id, res.usage);
    this.pool.clearAuthFailed(a.id);
    // A window at 100% means the seat is out until it resets, whatever the
    // stream has (not yet) said.
    const now = Date.now();
    const full = res.usage.windows.filter(
      (w) => !w.model && (w.percent ?? 0) >= 100 && w.resetsAt !== null && w.resetsAt > now,
    );
    if (full.length > 0) {
      const until = Math.max(...full.map((w) => w.resetsAt as number));
      this.pool.markExhausted(a.id, until, `${full.map((w) => w.label).join(' + ')} at 100%`);
    }
  }

  /** Email / org of a login seat, from the CLI's own `.claude.json`. */
  private async readIdentity(a: Account): Promise<void> {
    if (a.auth !== 'login') return;
    try {
      const raw = JSON.parse(await readFile(this.pool.globalConfigPath(a), 'utf8')) as {
        oauthAccount?: { emailAddress?: string; organizationName?: string };
      };
      this.pool.setIdentity(a.id, {
        email: raw.oauthAccount?.emailAddress,
        orgName: raw.oauthAccount?.organizationName,
      });
    } catch {
      // No config yet: not logged in, or never run.
    }
  }
}

let refresher: UsageRefresher | null = null;
let poolRef: AccountPool | null = null;
let runnerRef: SessionRunner | null = null;
let adapterRef: ClaudeSessionAdapter | null = null;

const plugin: AlfredPlugin = {
  id: 'claude-code',
  name: 'Claude (subscription)',
  version: '0.3.0',

  async activate(ctx: PluginContext) {
    const cfg = resolveConfig(ctx.config);
    const cli = resolveCli(cfg.pathToClaude);
    const pool = new AccountPool({ dataDir: ctx.dataDir, logger: ctx.logger, legacyToken: cfg.oauthToken });
    // A legacy single setup-token keeps working: it becomes the default seat's token.
    const def = pool.get('default');
    if (cfg.oauthToken && def && def.auth === 'login' && !pool.hasCredentials(def)) {
      pool.update('default', { auth: 'token' });
    }
    poolRef = pool;
    const usage = new UsageRefresher(pool);
    refresher = usage;

    // One session store for every seat, so a conversation can continue on
    // whichever seat has quota (accounts/sharedSessions.ts).
    const chatCfg = resolveChatSessionConfig(ctx.config, cfg);
    let crossSeat = false;
    const shareSeats = (): void => {
      if (!chatCfg.sharedStore) return;
      try {
        crossSeat = ensureSharedSessionDirs(pool.list(), undefined, ctx.logger).crossSeat;
      } catch (err) {
        crossSeat = false;
        ctx.logger.warn('could not set up the shared session store', { err: (err as Error).message });
      }
    };
    shareSeats();
    const sessionIndex = new SessionIndex(join(ctx.dataDir, 'sessions.json'));

    const providerOpts = {
      config: cfg,
      pool,
      cli,
      logger: ctx.logger,
      onAccountUsed: (id: string) => usage.soon(id),
    };
    let provider: ClaudeCodeProvider;
    if (chatCfg.cliMode) {
      const adapter = new ClaudeSessionAdapter({
        pool,
        cli,
        sessions: sessionIndex,
        logger: ctx.logger,
        config: chatCfg,
        crossSeat: () => crossSeat,
        onAccountUsed: (id) => usage.soon(id),
      });
      adapterRef = adapter;
      provider = new ClaudeCodeSessionProvider(providerOpts, adapter, sessionCapabilities(chatCfg, crossSeat));
    } else {
      provider = new ClaudeCodeProvider(providerOpts);
    }
    ctx.registerProvider(provider);
    ctx.registerWebview(createDashboardWebview());

    // Full Claude Code agent sessions, delegated by Alfred agents.
    const runner = new SessionRunner({
      pool,
      cli,
      sessions: sessionIndex,
      config: resolveSessionConfig(ctx.config, cfg),
      logger: ctx.logger,
      onAccountUsed: (id) => usage.soon(id),
    });
    runnerRef = runner;
    registerSessionTools(ctx, runner);

    const requireId = (args: unknown): string => {
      const id = String((args as { id?: unknown } | undefined)?.id ?? '');
      if (!pool.get(id)) throw new Error(`Unknown account "${id}".`);
      return id;
    };
    const safe =
      (fn: (args: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>) =>
      async (args: unknown) => {
        try {
          return { ok: true, ...(await fn(args)) };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      };

    // ---- dashboard -------------------------------------------------------

    ctx.registerAction(
      'poolSnapshot',
      safe(() => snapshot(pool, cli)),
    );

    ctx.registerAction(
      'addAccount',
      safe((args) => {
        const a = (args ?? {}) as { label?: string; token?: string; login?: boolean };
        const label = String(a.label ?? '').trim();
        if (!label) throw new Error('Label required.');
        const token = String(a.token ?? '').trim();
        const account = pool.add(label, token ? 'token' : 'login');
        shareSeats();
        if (token) pool.setToken(account.id, token);
        else if (a.login !== false) openLoginTerminal(pool, account, cli);
        return { id: account.id };
      }),
    );

    ctx.registerAction(
      'removeAccount',
      safe((args) => {
        pool.remove(requireId(args));
        return {};
      }),
    );

    ctx.registerAction(
      'updateAccount',
      safe((args) => {
        const id = requireId(args);
        const a = args as { label?: string; enabled?: boolean; exposeModels?: boolean };
        pool.update(id, { label: a.label, enabled: a.enabled, exposeModels: a.exposeModels });
        return {};
      }),
    );

    ctx.registerAction(
      'setPreferred',
      safe((args) => {
        pool.setPreferred(requireId(args));
        return {};
      }),
    );

    // Seat availability by hand: `clearExhausted` puts a seat back in rotation
    // before its recorded reset (the user knows the window rolled over, or
    // the limit was raised); `markExhausted` takes one out for a while — also
    // the seam the end-to-end campaign uses to exercise seat switching.
    ctx.registerAction(
      'markExhausted',
      safe((args) => {
        const id = requireId(args);
        const minutes = Number((args as { minutes?: unknown }).minutes ?? 60);
        const until = Date.now() + (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
        pool.markExhausted(id, until, String((args as { reason?: unknown }).reason ?? 'marked exhausted by hand'));
        return { exhaustedUntil: until };
      }),
    );

    ctx.registerAction(
      'clearExhausted',
      safe((args) => {
        pool.clearExhausted(requireId(args));
        return {};
      }),
    );

    ctx.registerAction(
      'loginAccount',
      safe((args) => {
        const account = pool.get(requireId(args))!;
        pool.clearAuthFailed(account.id);
        return openLoginTerminal(pool, account, cli);
      }),
    );

    ctx.registerAction(
      'setAccountToken',
      safe((args) => {
        const id = requireId(args);
        pool.setToken(id, String((args as { token?: unknown }).token ?? ''));
        return {};
      }),
    );

    ctx.registerAction(
      'refreshUsage',
      safe(async (args) => {
        const id = (args as { id?: string } | undefined)?.id;
        if (id) {
          pool.clearAuthFailed(requireId(args));
          await usage.refresh(pool.get(id)!);
        } else {
          await usage.refreshAll();
        }
        return {};
      }),
    );

    ctx.registerAction(
      'updateSettings',
      safe((args) => ({ settings: pool.updateSettings((args ?? {}) as Record<string, never>) })),
    );

    // ---- existing actions, now per account --------------------------------

    // Validate that a seat's subscription auth works by running a tiny
    // completion. Consumes a negligible amount of that seat's quota — only
    // invoked explicitly. `accountId` pins the seat; without it the pool picks.
    ctx.registerAction('testConnection', async (args) => {
      const accountId = (args as { accountId?: string } | undefined)?.accountId;
      try {
        // The seat is chosen here and the probe runs on it alone: the
        // answer is attributable to that seat, whatever runs in parallel.
        let account = accountId ? pool.get(accountId) : undefined;
        if (accountId) {
          if (!account) return { ok: false, error: `Unknown account "${accountId}".` };
          const why = pool.unavailableReason(account);
          if (why) return { ok: false, error: `${account.label}: ${why}` };
        }
        const model = firstModel(cfg.modelsRaw);
        if (!account) {
          const pick = pool.pick({ model });
          if (!pick.account) return { ok: false, error: pick.reason };
          account = pick.account;
        }
        const res = await provider.probeSeat(account, model);
        const text = res.text.trim();
        if (!text) {
          return { ok: false, error: `No response from Claude Code on "${account.label}" (empty output).` };
        }
        return { ok: true, sample: text.slice(0, 80), account: res.accountId };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    // Quota-free preflight: is the CLI reachable and is each seat logged in?
    ctx.registerAction('authStatus', async (args) => {
      const accountId = (args as { accountId?: string } | undefined)?.accountId;
      const version = await cliVersion(cli);
      const targets = accountId ? pool.list().filter((a) => a.id === accountId) : pool.list();
      const accounts = await Promise.all(
        targets.map(async (a) => {
          const st = await authStatus(pool, a, cli);
          if (st.loggedIn) pool.clearAuthFailed(a.id);
          pool.setIdentity(a.id, st);
          return { id: a.id, label: a.label, enabled: a.enabled, auth: a.auth, ...st };
        }),
      );
      const ready = version.found && accounts.some((a) => a.loggedIn && a.enabled);
      return {
        ok: true,
        ready,
        cli: { ...version, path: cli.path || '(bundled)', source: cli.source },
        accounts,
        nextSteps: buildNextSteps(version.found, accounts),
      };
    });

    ctx.registerAction('listModels', async () => {
      try {
        const models = await provider.listModels();
        return { ok: true, count: models.length, models };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    });

    usage.start();
    ctx.logger.info('Claude (subscription) plugin activated', {
      models: cfg.modelsRaw,
      accounts: pool.list().length,
      cli: cli.source,
      strategy: pool.settings.strategy,
    });
  },

  deactivate() {
    adapterRef?.killAll();
    adapterRef = null;
    runnerRef?.cancelAll();
    runnerRef = null;
    refresher?.stop();
    refresher = null;
    poolRef?.flush();
    poolRef = null;
  },
};

type AccountView = Record<string, unknown>;

function addTally(into: Tally, t: Tally): void {
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheWrite += t.cacheWrite;
  into.costUsd += t.costUsd;
  into.requests += t.requests;
}

/** Everything the dashboard shows. No secrets: tokens and credential paths stay here. */
function snapshot(pool: AccountPool, cli: CliInfo): Record<string, unknown> {
  const now = Date.now();
  const list = pool.list();
  const lastServed = pool.recent.find((r) => r.outcome === 'ok')?.accountId;
  const totals = { window5h: emptyTally(), week: emptyTally(), total: emptyTally() };
  const accounts: AccountView[] = list.map((a, i) => {
    const rt = pool.runtime(a.id);
    const why = pool.unavailableReason(a, now);
    const inFlight = pool.inFlightOf(a.id);
    let status: string;
    if (why === null) status = inFlight > 0 || a.id === lastServed ? 'active' : 'ok';
    else if (why.startsWith('auth failed')) status = 'auth failed';
    else status = why;
    const tokens = pool.tokenSummary(a.id);
    addTally(totals.window5h, tokens.window5h);
    addTally(totals.week, tokens.week);
    addTally(totals.total, tokens.total);
    return {
      id: a.id,
      label: a.label,
      enabled: a.enabled,
      auth: a.auth,
      preferred: i === 0,
      exposeModels: a.exposeModels,
      status,
      statusDetail: why === 'exhausted' ? rt.exhaustedReason : why,
      exhaustedUntil: rt.exhaustedUntil && rt.exhaustedUntil > now ? rt.exhaustedUntil : null,
      usage: rt.usage ?? null,
      lastError: rt.lastError ?? null,
      lastUsedAt: rt.lastUsedAt ?? null,
      requests: rt.requests ?? 0,
      inFlight,
      email: rt.email ?? null,
      orgName: rt.orgName ?? null,
      subscriptionType: rt.subscriptionType ?? null,
      tokens,
    };
  });
  const labels = new Map(list.map((a) => [a.id, a.label]));
  return {
    settings: pool.settings,
    cli: cli.path ? `CLI: ${cli.source}` : 'CLI: bundled (no live usage)',
    accounts,
    totals,
    recent: pool.recent.map((r) => ({ ...r, accountLabel: labels.get(r.accountId) ?? r.accountId })),
  };
}

function buildNextSteps(cliFound: boolean, accounts: Array<{ label: string; enabled: boolean; loggedIn: boolean }>): string[] {
  const steps: string[] = [];
  if (!cliFound) {
    steps.push(
      'Install the Claude Code CLI (native installer or `npm install -g @anthropic-ai/claude-code`), or set "Path to claude executable" in the plugin settings.',
    );
  }
  for (const a of accounts) {
    if (a.enabled && !a.loggedIn) {
      steps.push(`Log in account "${a.label}" from the Claude accounts page (Login button), or paste a \`claude setup-token\` token there.`);
    }
  }
  if (steps.length === 0) steps.push('Ready — run "testConnection" to confirm inference works.');
  return steps;
}

function firstModel(modelsRaw: string): string {
  const first = modelsRaw
    .split(',')
    .map((s) => s.trim().split('|')[0].trim())
    .find((s) => s.length > 0);
  return first || 'sonnet';
}

export default plugin;
