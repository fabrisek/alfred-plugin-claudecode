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
 * 13 advisor tokens (Fable advising, already in 0..3), 14 their USD (already in 4..7).
 */
export const CELL_LEN = 15;

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
        for (const c of list) for (const j of [4, 5, 6, 7, 9, 10, 12, 14]) c[j] = Math.round(c[j] * 1e5) / 1e5;
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
    const accounts = [...order, ...rest, ...(daily.unknown ? ['unknown'] : [])].map((id) => ({ id, label: nameOf(id) }));
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
      monthStart: dayOf(now).slice(0, 8) + '01',
      pricesVerified: PRICES_VERIFIED,
    };
  }
}
