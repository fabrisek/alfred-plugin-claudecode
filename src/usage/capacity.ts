/**
 * Lost capacity: what each seat's quota windows (5h, week) still had when
 * they reset. Unused quota at a reset is gone.
 *
 * The plugin already reads every seat's utilisation and reset times (the
 * usage poll, every few minutes). This keeps the last reading of each window
 * and, when the window rolls over (a later reset time shows up, or the reset
 * time passes), records one event: the utilisation last seen before the
 * reset. The reading can be a few minutes old, so a window still spent in its
 * last minutes is slightly under-counted.
 *
 * Tokens and $ "that could have been used" are an estimate: the tokens the
 * seat consumed in that window (usage history), extrapolated to 100% from
 * the share of the window they took. Only windows used enough to measure
 * (≥ MIN_PCT) give an estimate; for the others the seat's median full-window
 * value is used, when there is one.
 *
 * There is no history of past readings to rebuild from: recording starts
 * with the first poll after this code runs.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AccountUsage } from '../accounts/usage.js';

export const CAPACITY_WINDOWS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 24 * 3_600_000 };
/** Below this share of a window used, extrapolating to 100% is noise. */
export const MIN_PCT = 10;
const KEEP_MS = 400 * 24 * 3_600_000;
const MAX_EVENTS = 30_000;

type Reading = { percent: number | null; resetsAt: number; at: number };

export type ResetEvent = {
  account: string;
  window: string;
  /** When the window reset. */
  resetAt: number;
  /** Utilisation last seen before the reset (0-100), null when the source gave none. */
  percent: number | null;
  /** When that reading was taken. */
  seenAt: number;
};

/** One utilisation reading: [epoch ms, percent]. */
export type Sample = [number, number];

type CapacityFile = {
  version: 1;
  since: number;
  last: Record<string, Reading>;
  events: ResetEvent[];
  /** "<account>|<window>" → readings over time (quota over time), bounded below. */
  samples?: Record<string, Sample[]>;
};

/** Readings kept per account and window, and for how long. */
export const SAMPLES_MAX = 2500;
export const SAMPLES_KEEP_MS = 8 * 24 * 3_600_000;

export class CapacityTracker {
  private data: CapacityFile;
  private dirty = false;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.data = this.load();
  }

  private load(): CapacityFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CapacityFile>;
      if (raw.version === 1) {
        return { version: 1, since: raw.since ?? this.now(), last: raw.last ?? {}, events: Array.isArray(raw.events) ? raw.events : [], samples: raw.samples ?? {} };
      }
    } catch {
      // First run.
    }
    this.dirty = true;
    return { version: 1, since: this.now(), last: {}, events: [], samples: {} };
  }

  get since(): number {
    return this.data.since;
  }

/** Readings of one account's window since `from`, oldest first. */
  samples(account: string, window: string, from = 0): Sample[] {
    return (this.data.samples?.[`${account}|${window}`] ?? []).filter((x) => x[0] >= from);
  }

  /** Count of readings, for change detection. */
  get sampleCount(): number {
    return Object.values(this.data.samples ?? {}).reduce((n, l) => n + l.length, 0);
  }

  private sample(id: string, at: number, pct: number): void {
    const all = (this.data.samples ??= {});
    const list = (all[id] ??= []);
    const last = list[list.length - 1];
    if (last && last[0] >= at) return; // the same reading again
    list.push([at, Math.round(pct * 10) / 10]);
    const cutoff = this.now() - SAMPLES_KEEP_MS;
    let drop = 0;
    while (drop < list.length && list[drop][0] < cutoff) drop++;
    if (list.length - drop > SAMPLES_MAX) drop = list.length - SAMPLES_MAX;
    if (drop) list.splice(0, drop);
    this.dirty = true;
  }

  get events(): readonly ResetEvent[] {
    return this.data.events;
  }

  /** One seat's current usage reading. */
  observe(account: string, usage: AccountUsage | undefined): void {
    const now = this.now();
    for (const key of Object.keys(CAPACITY_WINDOWS)) {
      const id = `${account}|${key}`;
      const prev = this.data.last[id];
      const w = usage?.windows.find((x) => x.key === key && !x.model);
      // A window that passed its reset with no fresher reading is over too.
      if (prev && prev.resetsAt <= now && (!w || w.resetsAt === null || w.resetsAt > prev.resetsAt + 60_000)) {
        this.record(account, key, prev);
        delete this.data.last[id];
        this.dirty = true;
      } else if (prev && w && w.resetsAt !== null && w.resetsAt > prev.resetsAt + 60_000) {
        // A new window already: the previous one reset (early, or between two polls).
        this.record(account, key, prev);
        delete this.data.last[id];
        this.dirty = true;
      }
      if (!w || w.resetsAt === null || w.resetsAt <= now) continue;
      const at = usage?.fetchedAt ?? now;
      if (typeof w.percent === 'number') this.sample(id, at, w.percent);
      const cur = this.data.last[id];
      if (!cur || cur.at !== at || cur.percent !== w.percent || cur.resetsAt !== w.resetsAt) {
        this.data.last[id] = { percent: typeof w.percent === 'number' ? w.percent : null, resetsAt: w.resetsAt, at };
        this.dirty = true;
      }
    }
  }

  private record(account: string, window: string, r: Reading): void {
    this.data.events.push({ account, window, resetAt: r.resetsAt, percent: r.percent, seenAt: r.at });
    const cutoff = this.now() - KEEP_MS;
    if (this.data.events.length > MAX_EVENTS || (this.data.events[0] && this.data.events[0].resetAt < cutoff)) {
      this.data.events = this.data.events.filter((e) => e.resetAt >= cutoff).slice(-MAX_EVENTS);
    }
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
    this.dirty = false;
  }
}

/** What a window's usage was, from the history: tokens and API $ between its start and its reset. */
export type WindowSpend = (account: string, from: number, to: number) => { tokens: number; usd: number };

export type CapacityRow = {
  account: string;
  window: string;
  resetAt: number;
  percent: number | null;
  usedTokens: number;
  usedUsd: number;
  /** Estimated value of the whole window; null when it cannot be estimated. */
  fullTokens: number | null;
  fullUsd: number | null;
};

/** Reset events with what was used and the estimate of what was left. */
export function capacityRows(events: readonly ResetEvent[], spend: WindowSpend): CapacityRow[] {
  const rows: CapacityRow[] = events.map((e) => {
    const len = CAPACITY_WINDOWS[e.window] ?? 0;
    const s = spend(e.account, e.resetAt - len, e.resetAt);
    const p = e.percent ?? 0;
    const est = p >= MIN_PCT ? { t: s.tokens / (p / 100), u: s.usd / (p / 100) } : null;
    return {
      account: e.account,
      window: e.window,
      resetAt: e.resetAt,
      percent: e.percent,
      usedTokens: s.tokens,
      usedUsd: s.usd,
      fullTokens: est ? Math.round(est.t) : null,
      fullUsd: est ? Math.round(est.u * 100) / 100 : null,
    };
  });
  // Lightly used windows: the seat's median full-window value for that window kind.
  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const groups = new Map<string, CapacityRow[]>();
  for (const r of rows) groups.set(`${r.account}|${r.window}`, [...(groups.get(`${r.account}|${r.window}`) ?? []), r]);
  for (const list of groups.values()) {
    const mt = median(list.filter((r) => r.fullTokens !== null).map((r) => r.fullTokens as number));
    const mu = median(list.filter((r) => r.fullUsd !== null).map((r) => r.fullUsd as number));
    for (const r of list) {
      if (r.fullTokens === null && mt !== null) r.fullTokens = Math.max(mt, r.usedTokens);
      if (r.fullUsd === null && mu !== null) r.fullUsd = Math.max(mu, r.usedUsd);
    }
  }
  return rows;
}
