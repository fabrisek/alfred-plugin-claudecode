/**
 * Everything the Seats and Usage tabs draw, in one payload: the seats with
 * their quota, burn and live threads, the hourly / daily token history split
 * by type, seat and model, the per-thread and per-agent spend per period, the
 * cache journal, throughput and the pooled 5h curve's readings.
 *
 * Pure: every input is passed in, so the aggregation is unit-tested without
 * a pool, a CLI or a clock. Totals always include what no seat or thread is
 * known for ("unknown" seat, unattributed spend): such series are hidden by
 * the panel, never dropped from a sum.
 */

import type { ResetEvent, Sample } from './capacity.js';
import { dayOf, HOUR_MS } from './history.js';
import type { ColdEvent, CompactionEvent } from './journal.js';
import { modelKey } from './modelKeys.js';
import { planTag, subscriptionOf, weightOf, type PlanTag, type PlanWeights, type Subscription } from './planWeights.js';
import { priceOf, type Plan, type Vec } from './pricing.js';
import { FIVE_H_MS, hitsSince, seatBurn } from './seatBurn.js';
import type { ThreadInfo } from './served.js';
import { threadSum, type ThreadLedgerData, type Triple } from './threadLedger.js';
import { perMinute, throughputSince, type MinuteData, type ThroughputStats } from './throughput.js';

/**
 * Panel cell: 0 input, 1 cache write, 2 cache read, 3 output (tokens, the
 * served model's own, advisor excluded); 4..7 their API USD; 8 requests;
 * 9 USD of every token at plain input/output price (no cache, advisor
 * included); 10 advisor tokens; 11 advisor USD.
 */
export const CELL12 = 12;
export type Cell = number[];

export function blankCell(): Cell {
  return new Array(CELL12).fill(0);
}

export function addToCell(model: string, v: Vec, c: Cell): void {
  const { price: q } = priceOf(model);
  const write = v[2] * q.write5m + v[3] * q.write1h;
  c[8] += v[0];
  c[9] += ((v[1] + v[2] + v[3] + v[4]) * q.input + v[5] * q.output) / 1e6;
  if (model.endsWith('@advisor')) {
    c[10] += v[1] + v[2] + v[3] + v[4] + v[5];
    c[11] += (v[1] * q.input + write + v[4] * q.cacheRead + v[5] * q.output) / 1e6;
    return;
  }
  c[0] += v[1];
  c[1] += v[2] + v[3];
  c[2] += v[4];
  c[3] += v[5];
  c[4] += (v[1] * q.input) / 1e6;
  c[5] += write / 1e6;
  c[6] += (v[4] * q.cacheRead) / 1e6;
  c[7] += (v[5] * q.output) / 1e6;
}

export const cellTokens = (c: Cell): number => c[0] + c[1] + c[2] + c[3] + c[10];
export const cellUsd = (c: Cell): number => c[4] + c[5] + c[6] + c[7] + c[11];

function roundCell(c: Cell): Cell {
  return c.map((x, i) => (i >= 4 && i !== 8 && i !== 10 ? Math.round(x * 1e4) / 1e4 : x));
}

export type Window = { key: string; model?: string; percent: number | null; resetsAt: number | null };

export type SeatSource = {
  id: string;
  label: string;
  enabled: boolean;
  auth: string;
  /** Placement tier: 1 = last resort (pool.tierOf). */
  lastResort: boolean;
  plan: Plan | null;
  advisor: boolean | null;
  windows: Window[];
  usageStale?: boolean;
  requests: number;
  inFlight: number;
  lastUsedAt: number | null;
  exhaustedUntil: number | null;
  throttledUntil: number | null;
  /** Pool status: ok, active, exhausted, throttled, auth failed, disabled… */
  status: string;
  statusDetail: string | null;
  lastError: string | null;
  email: string | null;
  exposeModels?: boolean;
};

export type LiveThread = { key: string; seat: string; agent: string; title?: string; ctx?: number; at: number; busy: boolean };

export type StoreLike = {
  forEachBucket(kind: 'hours' | 'days', fn: (bucket: string, account: string, model: string, agent: string, v: Vec) => void): void;
  readonly threads: Readonly<ThreadLedgerData>;
  readonly minutes: Readonly<MinuteData>;
  readonly firstAt: number | undefined;
  readonly threadsSince: number;
};

export type BuildInput = {
  now: number;
  store: StoreLike;
  seats: SeatSource[];
  cold: ColdEvent[];
  compactions: CompactionEvent[];
  coldTotal: number;
  modesToday: Record<string, number>;
  threadInfo: (key: string) => ThreadInfo | undefined;
  liveThreads: LiveThread[];
  samples: (seat: string, window: string, from: number) => Sample[];
  resets: readonly ResetEvent[];
  weights: PlanWeights;
  nextId: string | null;
  /** Hours of hourly history sent (the Today / 5h views and the 24h sparklines). */
  hourSpan?: number;
};

export const PERIODS = ['5h', 'today', '7d', 'all'] as const;
export type Period = (typeof PERIODS)[number];

type Row = { tot: Cell; seat: Record<string, Cell>; model: Record<string, Cell> };

function rowAdd(r: Row, account: string, model: string, v: Vec, models: Record<string, string>): void {
  const mk = modelKey(model);
  models[mk.key] = mk.label;
  addToCell(model, v, r.tot);
  addToCell(model, v, (r.seat[account] ??= blankCell()));
  addToCell(model, v, (r.model[mk.key] ??= blankCell()));
}

function roundRow<T extends Row>(r: T): T {
  r.tot = roundCell(r.tot);
  for (const k of Object.keys(r.seat)) r.seat[k] = roundCell(r.seat[k]);
  for (const k of Object.keys(r.model)) r.model[k] = roundCell(r.model[k]);
  return r;
}

function localMidnight(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** First hour index of each period (null = everything tracked). */
export function periodFromHour(p: Period, now: number): number | null {
  const last = Math.floor(now / HOUR_MS);
  if (p === '5h') return last - 4;
  if (p === 'today') return Math.floor(localMidnight(now) / HOUR_MS);
  if (p === '7d') return last - 7 * 24 + 1;
  return null;
}

export type ConvView = { key: string; conv: string; agent: string; title: string; seats: Record<string, number>; ctx: number | null; last: number; p: Record<Period, Triple>; cold: number; coldTok: number };

export function buildSeatsUsage(inp: BuildInput) {
  const { now, store } = inp;
  const day0 = localMidnight(now);
  const today = dayOf(now);
  const lastHour = Math.floor(now / HOUR_MS);
  const span = inp.hourSpan ?? 72;
  const firstHour = lastHour - span + 1;
  const models: Record<string, string> = {};

  // ---- hourly / daily rows, and per-seat today / 24h spark ----
  const hourRows = new Map<number, Row>();
  const spark: Record<string, number[]> = {};
  store.forEachBucket('hours', (b, account, model, _agent, v) => {
    const h = Number(b);
    if (h < firstHour || h > lastHour) return;
    let r = hourRows.get(h);
    if (!r) hourRows.set(h, (r = { tot: blankCell(), seat: {}, model: {} }));
    rowAdd(r, account, model, v, models);
    if (h > lastHour - 24) {
      const c = blankCell();
      addToCell(model, v, c);
      (spark[account] ??= new Array(24).fill(0))[h - (lastHour - 23)] += cellUsd(c);
    }
  });
  const hourly = [...hourRows.entries()].sort((a, b) => a[0] - b[0]).map(([h, r]) => roundRow({ t: h * HOUR_MS, ...r }));

  const dayRows = new Map<string, Row>();
  store.forEachBucket('days', (d, account, model, _agent, v) => {
    let r = dayRows.get(d);
    if (!r) dayRows.set(d, (r = { tot: blankCell(), seat: {}, model: {} }));
    rowAdd(r, account, model, v, models);
  });
  const daily = [...dayRows.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, r]) => roundRow({ d, ...r }));
  const todayRow = dayRows.get(today);

  // ---- threads and agents per period ----
  const from: Record<Period, number | null> = { '5h': periodFromHour('5h', now), today: periodFromHour('today', now), '7d': periodFromHour('7d', now), all: null };
  const coldBy = new Map<string, { n: number; tok: number }>();
  for (const e of inp.cold) {
    if (e.at < day0 || !e.thread) continue;
    const g = coldBy.get(e.thread) ?? { n: 0, tok: 0 };
    g.n++;
    g.tok += e.tok;
    coldBy.set(e.thread, g);
  }
  const agents = new Map<string, { name: string; p: Record<Period, Triple> }>();
  const attributed: Record<Period, number> = { '5h': 0, today: 0, '7d': 0, all: 0 };
  const convs: ConvView[] = [];
  for (const [key, e] of Object.entries(store.threads)) {
    const p = {} as Record<Period, Triple>;
    for (const k of PERIODS) {
      p[k] = threadSum(e, from[k]);
      attributed[k] += p[k][2];
    }
    const info = inp.threadInfo(key);
    const agent = e.agent || info?.agent || 'unknown';
    const a = agents.get(agent) ?? { name: agent, p: { '5h': [0, 0, 0], today: [0, 0, 0], '7d': [0, 0, 0], all: [0, 0, 0] } };
    for (const k of PERIODS) {
      if (p[k][2] <= 0 && p[k][1] <= 0) continue;
      // per agent: USD, tokens, threads
      a.p[k][0] += p[k][2];
      a.p[k][1] += p[k][1];
      a.p[k][2] += 1;
    }
    agents.set(agent, a);
    const cb = coldBy.get(key);
    convs.push({ key, conv: e.conv, agent, title: info?.title || shortConv(e.conv), seats: e.seats, ctx: info?.ctx ?? null, last: e.last, p, cold: cb?.n ?? 0, coldTok: cb?.tok ?? 0 });
  }
  // Keep the payload small: the threads that rank in any period.
  const keep = new Set<string>();
  for (const k of PERIODS) {
    convs
      .filter((c) => c.p[k][2] > 0)
      .sort((x, y) => y.p[k][2] - x.p[k][2])
      .slice(0, 60)
      .forEach((c) => keep.add(c.key));
  }
  const round4 = (t: Triple): Triple => [t[0], t[1], Math.round(t[2] * 1e4) / 1e4];
  const convList = convs
    .filter((c) => keep.has(c.key))
    .map((c) => ({ ...c, p: { '5h': round4(c.p['5h']), today: round4(c.p.today), '7d': round4(c.p['7d']), all: round4(c.p.all) } }))
    .sort((x, y) => y.p.today[2] - x.p.today[2] || y.p['7d'][2] - x.p['7d'][2]);

  // ---- seats ----
  const liveBySeat = new Map<string, LiveThread[]>();
  for (const t of inp.liveThreads) (liveBySeat.get(t.seat) ?? liveBySeat.set(t.seat, []).get(t.seat)!).push(t);
  const seats = inp.seats.map((s, order) => {
    const win = (key: string) => s.windows.find((w) => w.key === key && !w.model && w.percent !== null && w.resetsAt !== null && w.resetsAt > now) ?? null;
    const f = win('five_hour');
    const w = win('seven_day');
    const five = f ? { pct: clampPct(f.percent as number), resetsAt: f.resetsAt as number } : null;
    const week = w ? { pct: clampPct(w.percent as number), resetsAt: w.resetsAt as number } : null;
    const scoped = s.windows
      .filter((x) => x.model && x.percent !== null && x.key !== 'five_hour')
      .map((x) => ({ label: cap(x.model as string), pct: clampPct(x.percent as number), resetsAt: x.resetsAt }));
    const samples = inp.samples(s.id, 'five_hour', now - FIVE_H_MS);
    const burn = seatBurn(five, samples, now);
    const tag: PlanTag | null = planTag(s.plan?.id);
    const tc = todayRow?.seat[s.id];
    const threads = (liveBySeat.get(s.id) ?? [])
      .sort((a, b) => Number(b.busy) - Number(a.busy) || b.at - a.at)
      .map((t) => ({ key: t.key, agent: t.agent || 'unknown', title: t.title || shortConv(t.key.split('|')[0]), ctx: t.ctx ?? 0, busy: t.busy }));
    return {
      id: s.id,
      label: s.label,
      org: s.lastResort ? 'perso' : 'team',
      plan: tag ?? (s.plan ? s.plan.label : '?'),
      planLabel: s.plan?.label ?? 'unknown plan',
      monthlyUsd: s.plan?.monthlyUsd ?? null,
      weight: weightOf(tag, inp.weights),
      priority: order,
      lastResort: s.lastResort,
      enabled: s.enabled,
      auth: s.auth,
      advisor: s.advisor,
      exposeModels: !!s.exposeModels,
      five,
      week,
      scoped,
      usageStale: !!s.usageStale,
      requests: s.requests,
      inFlight: s.inFlight,
      exhaustedUntil: s.exhaustedUntil,
      throttledUntil: s.throttledUntil,
      poolStatus: s.status,
      statusDetail: s.statusDetail,
      lastError: s.lastError,
      email: s.email,
      lastUsedAt: s.lastUsedAt,
      hitsToday: hitsSince(inp.resets, s.id, day0, !!five && five.pct >= 100),
      todayTok: tc ? cellTokens(tc) : 0,
      todayUsd: tc ? Math.round(cellUsd(tc) * 100) / 100 : 0,
      threads,
      spark: (spark[s.id] ?? new Array(24).fill(0)).map((x) => Math.round(x * 100) / 100),
      burn: burn.perHour !== null ? Math.round(burn.perHour * 10) / 10 : null,
      eta: burn.etaMs,
      burnBasis: burn.basis,
    };
  });

  // ---- pooled 5h curve: every seat's readings of the last 12h (+ the one before) ----
  const pool: Record<string, Sample[]> = {};
  for (const s of inp.seats) {
    const all = inp.samples(s.id, 'five_hour', now - 18 * 3_600_000);
    const cut = now - 12 * 3_600_000;
    let i = all.findIndex((x) => x[0] >= cut);
    if (i < 0) i = all.length;
    pool[s.id] = all.slice(Math.max(0, i - 1));
  }

  const sub: Subscription = subscriptionOf(inp.seats.filter((s) => s.enabled).map((s) => s.plan));
  const tp = (fromMs: number): ThroughputStats => {
    const t = throughputSince(store.minutes as MinuteData, fromMs, now);
    return { avgPerSec: Math.round(t.avgPerSec), peakPerSec: Math.round(t.peakPerSec), peakAt: t.peakAt, tokens: t.tokens };
  };

  return {
    now,
    day0,
    firstAt: store.firstAt ?? now,
    threadsSince: store.threadsSince,
    seats,
    hourly,
    daily,
    models,
    convs: convList,
    convCount: convs.length,
    agents: [...agents.values()].map((a) => ({ name: a.name, p: { '5h': round4(a.p['5h']), today: round4(a.p.today), '7d': round4(a.p['7d']), all: round4(a.p.all) } })),
    attributed: { '5h': r2(attributed['5h']), today: r2(attributed.today), '7d': r2(attributed['7d']), all: r2(attributed.all) },
    cold: inp.cold,
    compactions: inp.compactions,
    coldTotal: inp.coldTotal,
    modesToday: inp.modesToday,
    perMin: perMinute(store.minutes as MinuteData, now, 60),
    throughput: { '5h': tp(now - FIVE_H_MS), today: tp(day0), '24h': tp(now - 24 * HOUR_MS) },
    next: inp.nextId ? { id: inp.nextId } : null,
    weights: inp.weights,
    subscription: sub,
    pool,
  };
}

export type SeatsUsageView = ReturnType<typeof buildSeatsUsage>;

function clampPct(p: number): number {
  return Math.max(0, Math.min(100, Math.round(p * 10) / 10));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** A readable stand-in for a thread with no recorded title. */
export function shortConv(conv: string): string {
  return conv.length > 14 ? `${conv.slice(0, 8)}…` : conv || 'thread';
}
