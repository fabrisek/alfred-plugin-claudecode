/**
 * Persistent token history: hourly and daily buckets per (seat, model, agent),
 * in one compact JSON file under the plugin's state dir.
 *
 * The buckets and the transcript read offsets (usage/transcripts.ts) live in
 * the same file and are written together, atomically: after a restart nothing
 * is counted twice and nothing read is lost. Writes are grouped (the scanner
 * saves at most once per pass), hours are kept 35 days, days ~2 years, so the
 * file stays small whatever the traffic.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PRICES_VERIFIED, costOf, priceOf, type Vec } from './pricing.js';

export const HOUR_MS = 3_600_000;
export const KEEP_HOURS = 35 * 24;
export const KEEP_DAYS = 800;
/** Distinct (seat, model, agent) keys; past it, new agents fold into "". */
const MAX_KEYS = 2000;
const SEP = '\u0001';

/** Per transcript file: read offset, mtime at that offset, recently counted message ids. */
export type FileState = {
  off: number;
  mtime: number;
  ids?: Record<string, [number, number, number, number, number]>;
  /** Login the CLI last reported in this session (its session_context): who the next lines are billed to. */
  email?: string;
};

type StoreFile = {
  version: 1;
  keys: string[];
  /** hour index (epoch ms / 1h) → key index → vector */
  hours: Record<string, Record<string, Vec>>;
  /** local day "YYYY-MM-DD" → key index → vector */
  days: Record<string, Record<string, Vec>>;
  files: Record<string, FileState>;
  firstAt?: number;
  lastAt?: number;
  /** Set once the first full pass over the transcripts (the backfill) completed. */
  backfilledAt?: number;
  /** How the history was attributed; a store from another revision is rebuilt from the transcripts. */
  rev?: number;
};

export function emptyVec(): Vec {
  return [0, 0, 0, 0, 0, 0];
}

function addVec(into: Vec, v: Vec): void {
  for (let i = 0; i < 6; i++) into[i] += v[i];
}

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** Local calendar day of an instant. */
export function dayOf(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * One cell of the panel series, flat for a compact payload:
 * 0 input, 1 cache write (5m + 1h), 2 cache read, 3 output (tokens);
 * 4..7 the API-equivalent USD of the same four; 8 requests;
 * 9 USD the cache reads would have cost as plain input; 10 USD the cache
 * writes would have cost as plain input; 11 cache write 1h tokens; 12 its USD;
 * 13 advisor tokens (Fable advising, already in 0..3), 14 their USD (already in 4..7);
 * 15..18 the advisor's share of 0..3 (tokens), 19..22 its share of 4..7 (USD).
 */
export const CELL_LEN = 23;

export function addCell(model: string, v: Vec, into: number[]): void {
  const { price: q } = priceOf(model);
  into[0] += v[1];
  into[1] += v[2] + v[3];
  into[2] += v[4];
  into[3] += v[5];
  into[4] += (v[1] * q.input) / 1e6;
  into[5] += (v[2] * q.write5m + v[3] * q.write1h) / 1e6;
  into[6] += (v[4] * q.cacheRead) / 1e6;
  into[7] += (v[5] * q.output) / 1e6;
  into[8] += v[0];
  into[9] += (v[4] * q.input) / 1e6;
  into[10] += ((v[2] + v[3]) * q.input) / 1e6;
  into[11] += v[3];
  into[12] += (v[3] * q.write1h) / 1e6;
  if (model.endsWith('@advisor')) {
    into[13] += v[1] + v[2] + v[3] + v[4] + v[5];
    into[14] += (v[1] * q.input + v[2] * q.write5m + v[3] * q.write1h + v[4] * q.cacheRead + v[5] * q.output) / 1e6;
    into[15] += v[1];
    into[16] += v[2] + v[3];
    into[17] += v[4];
    into[18] += v[5];
    into[19] += (v[1] * q.input) / 1e6;
    into[20] += (v[2] * q.write5m + v[3] * q.write1h) / 1e6;
    into[21] += (v[4] * q.cacheRead) / 1e6;
    into[22] += (v[5] * q.output) / 1e6;
  }
}

export type UsageView = {
  version: number;
  generatedAt: number;
  scan: ScanStatus;
  firstAt: number | null;
  lastAt: number | null;
  /** Seats with data, in seat order, then the ones the pool no longer has, then "unknown". */
  accounts: Array<{ id: string; label: string }>;
  days: string[];
  /** account id → one cell per entry of `days` (layout: {@link CELL_LEN}) */
  daily: Record<string, number[][]>;
  /** hour start epoch ms, oldest first */
  hours: number[];
  hourly: Record<string, number[][]>;
  /** totals per model over the whole history */
  models: Array<{ model: string; tokens: number; cost: number; known: boolean }>;
  /** Subscription plan of each seat, when its login tells (usage/pricing.ts). */
  plans: Record<string, { label: string; monthlyUsd: number }>;
  /** API-equivalent cost per period, global and per seat (see {@link UsageStore.apiCost}). */
  apiCost: ApiCost;
  /** First day of the current month: the panel sums the month from there. */
  monthStart: string;
  pricesVerified: string;
};

export type ScanStatus = { running: boolean; backfilled: boolean; filesDone: number; filesTotal: number; lastScanAt: number | null; error?: string };

export class UsageStore {
  private data: StoreFile;
  private keyIndex = new Map<string, number>();
  private dirty = false;
  /** Bumped whenever a bucket changes: the panel redraws only on a new version. */
  version = Date.now();

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly rev = 1,
  ) {
    this.data = this.load();
    this.data.keys.forEach((k, i) => this.keyIndex.set(k, i));
  }

  private load(): StoreFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreFile>;
      if (raw.version === 1 && Array.isArray(raw.keys) && (raw.rev ?? 1) === this.rev) {
        return {
          version: 1,
          keys: raw.keys,
          hours: raw.hours ?? {},
          days: raw.days ?? {},
          files: raw.files ?? {},
          firstAt: raw.firstAt,
          lastAt: raw.lastAt,
          backfilledAt: raw.backfilledAt,
          rev: this.rev,
        };
      }
    } catch {
      // First run, or unreadable: start over (the backfill rebuilds it).
    }
    return { version: 1, keys: [], hours: {}, days: {}, files: {}, rev: this.rev };
  }

  get backfilledAt(): number | undefined {
    return this.data.backfilledAt;
  }

  markBackfilled(): void {
    if (this.data.backfilledAt) return;
    this.data.backfilledAt = this.now();
    this.dirty = true;
  }

  fileState(key: string): FileState | undefined {
    return this.data.files[key];
  }

  setFileState(key: string, st: FileState): void {
    this.data.files[key] = st;
    this.dirty = true;
  }

  fileKeys(): string[] {
    return Object.keys(this.data.files);
  }

  dropFile(key: string): void {
    if (key in this.data.files) {
      delete this.data.files[key];
      this.dirty = true;
    }
  }

  private keyOf(account: string, model: string, agent: string): number {
    let k = [account, model, agent].join(SEP);
    let i = this.keyIndex.get(k);
    if (i !== undefined) return i;
    if (this.data.keys.length >= MAX_KEYS) {
      k = [account, model, ''].join(SEP);
      i = this.keyIndex.get(k);
      if (i !== undefined) return i;
    }
    i = this.data.keys.length;
    this.data.keys.push(k);
    this.keyIndex.set(k, i);
    return i;
  }

  /** Counts one response (or the growth of one already counted). */
  add(at: number, account: string, model: string, agent: string, v: Vec): void {
    if (!Number.isFinite(at)) return;
    const now = this.now();
    // Buckets older than retention would be pruned right away.
    if (at < now - KEEP_DAYS * 24 * HOUR_MS) return;
    const k = String(this.keyOf(account || 'unknown', model || 'unknown', agent || ''));
    if (at >= now - KEEP_HOURS * HOUR_MS) {
      const h = String(Math.floor(at / HOUR_MS));
      const hb = (this.data.hours[h] ??= {});
      addVec((hb[k] ??= emptyVec()), v);
    }
    const db = (this.data.days[dayOf(at)] ??= {});
    addVec((db[k] ??= emptyVec()), v);
    if (this.data.firstAt === undefined || at < this.data.firstAt) this.data.firstAt = at;
    if (this.data.lastAt === undefined || at > this.data.lastAt) this.data.lastAt = at;
    this.dirty = true;
    this.version++;
  }

  /** Drops buckets past retention. */
  prune(): void {
    const now = this.now();
    const minHour = Math.floor((now - KEEP_HOURS * HOUR_MS) / HOUR_MS);
    for (const h of Object.keys(this.data.hours)) {
      if (Number(h) < minHour) {
        delete this.data.hours[h];
        this.dirty = true;
      }
    }
    const minDay = dayOf(now - KEEP_DAYS * 24 * HOUR_MS);
    for (const d of Object.keys(this.data.days)) {
      if (d < minDay) {
        delete this.data.days[d];
        this.dirty = true;
      }
    }
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Atomic write, only when something changed. */
  save(): void {
    if (!this.dirty) return;
    this.prune();
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
    this.dirty = false;
  }

  /** Raw totals, for tests and logs: account → vector. */
  totalsByAccount(): Record<string, Vec> {
    const out: Record<string, Vec> = {};
    for (const bucket of Object.values(this.data.days)) {
      for (const [ki, v] of Object.entries(bucket)) {
        const acc = this.data.keys[Number(ki)].split(SEP)[0];
        addVec((out[acc] ??= emptyVec()), v);
      }
    }
    return out;
  }

  /** Raw totals per served model id: model → vector. */
  totalsByModel(): Record<string, Vec> {
    const out: Record<string, Vec> = {};
    for (const bucket of Object.values(this.data.days)) {
      for (const [ki, v] of Object.entries(bucket)) {
        const model = this.data.keys[Number(ki)].split(SEP)[1];
        addVec((out[model] ??= emptyVec()), v);
      }
    }
    return out;
  }

  /** Per-day totals: day → account → vector. */
  dailyByAccount(): Record<string, Record<string, Vec>> {
    const out: Record<string, Record<string, Vec>> = {};
    for (const [day, bucket] of Object.entries(this.data.days)) {
      for (const [ki, v] of Object.entries(bucket)) {
        const acc = this.data.keys[Number(ki)].split(SEP)[0];
        addVec(((out[day] ??= {})[acc] ??= emptyVec()), v);
      }
    }
    return out;
  }

  /** Tokens and API $ of one seat between two instants, from the hourly buckets (hour-granular). */
  spend(account: string, from: number, to: number): { tokens: number; usd: number } {
    let tokens = 0;
    let usd = 0;
    const h0 = Math.floor(from / HOUR_MS);
    const h1 = Math.ceil(to / HOUR_MS);
    for (const [h, bucket] of Object.entries(this.data.hours)) {
      const n = Number(h);
      if (n < h0 || n >= h1) continue;
      for (const [ki, v] of Object.entries(bucket)) {
        const [acc, model] = this.data.keys[Number(ki)].split(SEP);
        if (acc !== account) continue;
        tokens += v[1] + v[2] + v[3] + v[4] + v[5];
        usd += costOf(model, v);
      }
    }
    return { tokens, usd };
  }

  /**
   * What the API would have billed, per period: the last 5h, today (local
   * day), the last 7 and 30 days, everything tracked. Global and per seat
   * (`unknown`: tokens no transcript ties to a seat, counted in the global
   * figures). The rolling periods are hour-granular: the current hour plus
   * the previous ones (5, 168, 720 hourly buckets).
   */
  apiCost(): ApiCost {
    const now = this.now();
    const lastHour = Math.floor(now / HOUR_MS);
    const rolling: Array<[ApiPeriod, number]> = [
      ['5h', 5],
      ['7d', 7 * 24],
      ['30d', 30 * 24],
    ];
    const all = blankPeriods();
    const byAccount: Record<string, Record<ApiPeriod, CostBreakdown>> = {};
    const add = (period: ApiPeriod, account: string, model: string, v: Vec): void => {
      addCost(model, v, all[period]);
      addCost(model, v, (byAccount[account] ??= blankPeriods())[period]);
    };
    for (const [h, bucket] of Object.entries(this.data.hours)) {
      const age = lastHour - Number(h);
      if (age < 0) continue;
      for (const [ki, v] of Object.entries(bucket)) {
        const [account, model] = this.data.keys[Number(ki)].split(SEP);
        for (const [period, n] of rolling) if (age < n) add(period, account, model, v);
      }
    }
    const today = dayOf(now);
    for (const [day, bucket] of Object.entries(this.data.days)) {
      for (const [ki, v] of Object.entries(bucket)) {
        const [account, model] = this.data.keys[Number(ki)].split(SEP);
        add('total', account, model, v);
        if (day === today) add('today', account, model, v);
      }
    }
    const from: Record<ApiPeriod, number | null> = {
      '5h': (lastHour - 4) * HOUR_MS,
      today: dayStart(today),
      '7d': (lastHour - 7 * 24 + 1) * HOUR_MS,
      '30d': (lastHour - 30 * 24 + 1) * HOUR_MS,
      total: this.data.firstAt ?? null,
    };
    const finish = (ps: Record<ApiPeriod, CostBreakdown>): Record<ApiPeriod, CostBreakdown> => {
      for (const k of API_PERIODS) roundCost(ps[k], from[k], now);
      return ps;
    };
    finish(all);
    for (const ps of Object.values(byAccount)) finish(ps);
    return { periods: all, byAccount, pricesVerified: PRICES_VERIFIED };
  }

  hourCount(): number {
    return Object.keys(this.data.hours).length;
  }

  /**
   * What the panel draws: every day from the first record to today, the last
   * `hourSpan` hours, per account, tokens and cost by type.
   */
  view(opts: { scan: ScanStatus; seats: Array<{ id: string; label: string }>; hourSpan?: number; plans?: Record<string, { label: string; monthlyUsd: number }> }): UsageView {
    const now = this.now();
    const keys = this.data.keys.map((k) => {
      const [account, model] = k.split(SEP);
      return { account, model };
    });
    const cellOf = addCell;
    const blank = (): number[] => new Array(CELL_LEN).fill(0);

    const days: string[] = [];
    const firstDay = this.data.firstAt !== undefined ? dayOf(this.data.firstAt) : dayOf(now);
    for (let t = dayStart(firstDay); ; t += 24 * HOUR_MS) {
      // DST-safe stepping: re-anchor on the local midnight of the day reached.
      const d = dayOf(t + 3 * HOUR_MS);
      if (days.length && d === days[days.length - 1]) continue;
      if (d > dayOf(now)) break;
      days.push(d);
      if (days.length > KEEP_DAYS + 2) break;
    }
    const dayIdx = new Map(days.map((d, i) => [d, i]));
    const daily: Record<string, number[][]> = {};
    const models = new Map<string, { tokens: number; cost: number }>();
    for (const [day, bucket] of Object.entries(this.data.days)) {
      const i = dayIdx.get(day);
      if (i === undefined) continue;
      for (const [ki, v] of Object.entries(bucket)) {
        const { account, model } = keys[Number(ki)];
        const row = (daily[account] ??= days.map(blank));
        cellOf(model, v, row[i]);
        const m = models.get(model) ?? { tokens: 0, cost: 0 };
        m.tokens += v[1] + v[2] + v[3] + v[4] + v[5];
        m.cost += costOf(model, v);
        models.set(model, m);
      }
    }
    const span = opts.hourSpan ?? 48;
    const lastHour = Math.floor(now / HOUR_MS);
    const hours: number[] = [];
    for (let h = lastHour - span + 1; h <= lastHour; h++) hours.push(h * HOUR_MS);
    const hourly: Record<string, number[][]> = {};
    for (const [h, bucket] of Object.entries(this.data.hours)) {
      const i = Number(h) - (lastHour - span + 1);
      if (i < 0 || i >= span) continue;
      for (const [ki, v] of Object.entries(bucket)) {
        const { account, model } = keys[Number(ki)];
        const row = (hourly[account] ??= hours.map(blank));
        cellOf(model, v, row[i]);
      }
    }
    for (const a of Object.keys(hourly)) if (!daily[a]) daily[a] = days.map(blank);

    const round = (rows: Record<string, number[][]>): void => {
      for (const list of Object.values(rows)) {
        for (const c of list) for (const j of [4, 5, 6, 7, 9, 10, 12, 14, 19, 20, 21, 22]) c[j] = Math.round(c[j] * 1e5) / 1e5;
      }
    };
    round(daily);
    round(hourly);

    const label = new Map(opts.seats.map((s) => [s.id, s.label]));
    const order = opts.seats.map((s) => s.id).filter((id) => daily[id]);
    const rest = Object.keys(daily)
      .filter((id) => !label.has(id) && id !== 'unknown')
      .sort();
    // A seat no longer in the pool keeps its history under its id, marked removed;
    // what no transcript or record ties to a seat is shown as such.
    const nameOf = (id: string): string =>
      label.get(id) ?? (id === 'unknown' ? 'unattributed (before tracking)' : `${id} (removed seat)`);
    // Tokens no transcript ties to a seat ("unknown") are not a series of their
    // own: their rows stay in `daily` / `hourly`, so every total still counts them.
    const accounts = [...order, ...rest].map((id) => ({ id, label: nameOf(id) }));
    return {
      version: this.version,
      generatedAt: now,
      scan: opts.scan,
      firstAt: this.data.firstAt ?? null,
      lastAt: this.data.lastAt ?? null,
      accounts,
      days,
      daily,
      hours,
      hourly,
      models: [...models.entries()]
        .map(([model, m]) => ({ model, tokens: m.tokens, cost: Math.round(m.cost * 100) / 100, known: priceOf(model).known }))
        .sort((a, b) => b.tokens - a.tokens),
      plans: opts.plans ?? {},
      apiCost: this.apiCost(),
      monthStart: dayOf(now).slice(0, 8) + '01',
      pricesVerified: PRICES_VERIFIED,
    };
  }
}

export const API_PERIODS = ['5h', 'today', '7d', '30d', 'total'] as const;
export type ApiPeriod = (typeof API_PERIODS)[number];

/**
 * API-equivalent cost of a period. The token kinds are the served model's
 * own (advisor excluded); `advisor` is the advisor's calls whole, at its own
 * model's price. `noCache`: the same tokens with every cache read and write
 * billed as plain input; `cacheSaved` = noCache - total (negative when the
 * writes cost more than the reads saved).
 */
export type CostBreakdown = {
  from: number | null;
  to: number;
  requests: number;
  tokens: { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number; advisor: number; total: number };
  usd: {
    input: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
    advisor: number;
    total: number;
    noCache: number;
    cacheSaved: number;
  };
  /** Tokens of models without a list price (counted at $0). */
  unpricedTokens: number;
};

export type ApiCost = {
  periods: Record<ApiPeriod, CostBreakdown>;
  byAccount: Record<string, Record<ApiPeriod, CostBreakdown>>;
  pricesVerified: string;
};

function blankCost(): CostBreakdown {
  return {
    from: null,
    to: 0,
    requests: 0,
    tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, advisor: 0, total: 0 },
    usd: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, cacheRead: 0, output: 0, advisor: 0, total: 0, noCache: 0, cacheSaved: 0 },
    unpricedTokens: 0,
  };
}

function blankPeriods(): Record<ApiPeriod, CostBreakdown> {
  return { '5h': blankCost(), today: blankCost(), '7d': blankCost(), '30d': blankCost(), total: blankCost() };
}

/** Adds one (model, vector) to a breakdown, at that model's list price. */
export function addCost(model: string, v: Vec, b: CostBreakdown): void {
  const { price: q, known } = priceOf(model);
  const tok = v[1] + v[2] + v[3] + v[4] + v[5];
  const cost = (v[1] * q.input + v[2] * q.write5m + v[3] * q.write1h + v[4] * q.cacheRead + v[5] * q.output) / 1e6;
  b.requests += v[0];
  b.tokens.total += tok;
  b.usd.total += cost;
  b.usd.noCache += ((v[1] + v[2] + v[3] + v[4]) * q.input + v[5] * q.output) / 1e6;
  if (!known) b.unpricedTokens += tok;
  if (model.endsWith('@advisor')) {
    b.tokens.advisor += tok;
    b.usd.advisor += cost;
    return;
  }
  b.tokens.input += v[1];
  b.tokens.cacheWrite5m += v[2];
  b.tokens.cacheWrite1h += v[3];
  b.tokens.cacheRead += v[4];
  b.tokens.output += v[5];
  b.usd.input += (v[1] * q.input) / 1e6;
  b.usd.cacheWrite5m += (v[2] * q.write5m) / 1e6;
  b.usd.cacheWrite1h += (v[3] * q.write1h) / 1e6;
  b.usd.cacheRead += (v[4] * q.cacheRead) / 1e6;
  b.usd.output += (v[5] * q.output) / 1e6;
}

function roundCost(b: CostBreakdown, from: number | null, to: number): void {
  const r = (x: number): number => Math.round(x * 1e4) / 1e4;
  b.from = from;
  b.to = to;
  b.usd.cacheWrite = b.usd.cacheWrite5m + b.usd.cacheWrite1h;
  b.usd.cacheSaved = b.usd.noCache - b.usd.total;
  for (const k of Object.keys(b.usd) as Array<keyof CostBreakdown['usd']>) b.usd[k] = r(b.usd[k]);
}
