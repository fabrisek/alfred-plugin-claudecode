/**
 * Per-thread spend: requests, tokens and API-equivalent USD per Alfred thread
 * (engine session key `conversationId|agent|…`, or `session:<id>` for a
 * session the plugin recorded without one), hour by hour.
 *
 * Plain data, kept inside the usage history file (usage/history.ts) so it is
 * written atomically with the transcript offsets: nothing is counted twice
 * after a restart. Recorded from the moment this code runs: what was counted
 * before has no thread and stays in the history totals only.
 */

/** requests, tokens, API USD */
export type Triple = [number, number, number];

export type ThreadEntry = {
  agent: string;
  conv: string;
  first: number;
  last: number;
  total: Triple;
  /** hour index (epoch ms / 1h) → triple */
  hours: Record<string, Triple>;
  /** seat id → requests served there */
  seats: Record<string, number>;
};

export type ThreadLedgerData = Record<string, ThreadEntry>;

/** Who a transcript line belongs to, when the plugin knows. */
export type ThreadRef = { key: string; agent: string; conv: string };

export const THREADS_MAX = 4000;
const HOUR_MS = 3_600_000;

/** Thread identity from an engine session key (`conversationId|agent|suffix`). */
export function threadOfKey(key: string): ThreadRef {
  const [conv, agent] = key.split('|');
  return { key, conv: conv || key, agent: agent || '' };
}

export function addToThread(data: ThreadLedgerData, ref: ThreadRef, at: number, account: string, req: number, tok: number, usd: number): void {
  const e = (data[ref.key] ??= { agent: ref.agent, conv: ref.conv, first: at, last: at, total: [0, 0, 0], hours: {}, seats: {} });
  if (!e.agent && ref.agent) e.agent = ref.agent;
  if (at < e.first) e.first = at;
  if (at > e.last) e.last = at;
  e.total[0] += req;
  e.total[1] += tok;
  e.total[2] += usd;
  const h = String(Math.floor(at / HOUR_MS));
  const t = (e.hours[h] ??= [0, 0, 0]);
  t[0] += req;
  t[1] += tok;
  t[2] += usd;
  if (req > 0) e.seats[account] = (e.seats[account] ?? 0) + req;
}

/** Drops hourly detail older than `minHour`, and the least recent threads past `max`. */
export function pruneThreads(data: ThreadLedgerData, minHour: number, max = THREADS_MAX): boolean {
  let changed = false;
  for (const e of Object.values(data)) {
    for (const h of Object.keys(e.hours)) {
      if (Number(h) < minHour) {
        delete e.hours[h];
        changed = true;
      }
    }
  }
  const keys = Object.keys(data);
  if (keys.length > max) {
    keys.sort((a, b) => data[a].last - data[b].last);
    for (const k of keys.slice(0, keys.length - max)) delete data[k];
    changed = true;
  }
  return changed;
}

/** Sum of one thread's hours in [fromHour, toHour] (inclusive), or its lifetime total when `fromHour` is null. */
export function threadSum(e: ThreadEntry, fromHour: number | null, toHour = Infinity): Triple {
  if (fromHour === null) return [e.total[0], e.total[1], e.total[2]];
  const out: Triple = [0, 0, 0];
  for (const [h, t] of Object.entries(e.hours)) {
    const n = Number(h);
    if (n < fromHour || n > toHour) continue;
    out[0] += t[0];
    out[1] += t[1];
    out[2] += t[2];
  }
  return out;
}
