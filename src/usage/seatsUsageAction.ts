/**
 * The `seatsUsage` action the Seats / Usage tabs poll: gathers the live pool
 * state, the usage history, the cache journal and the served-request stats,
 * and hands them to the pure aggregation (usage/seatsUsage.ts).
 *
 * `since`: the version the page already drew. Same content = a tiny
 * `{ unchanged: true }` reply, so an idle panel moves a few bytes and never
 * redraws (no flicker).
 */

import type { PluginContext } from '@alfred/sdk';
import type { AccountPool } from '../accounts/pool.js';
import type { AdvisorPolicy } from '../accounts/advisor.js';
import type { ActivityBoard, ActivityItem } from '../webview/activity.js';
import { isLive } from '../webview/activity.js';
import type { UsageJournal } from './journal.js';
import type { PlanWeights } from './planWeights.js';
import type { UsageHistoryHandles } from './register.js';
import { buildSeatsUsage, type LiveThread, type SeatSource } from './seatsUsage.js';
import type { ServedStats } from './served.js';
import { threadOfKey } from './threadLedger.js';

/** A thread whose session ran within this is warm on its seat (prompt-cache lifetime). */
export const LIVE_THREAD_MS = 60 * 60_000;
/** Cold / compaction events sent: the chart's 72 hours and today's lists. */
const EVENTS_SPAN_MS = 3 * 24 * 3_600_000;

export type SeatsUsageDeps = {
  pool: AccountPool;
  history: UsageHistoryHandles;
  journal: UsageJournal;
  stats: ServedStats;
  activity: ActivityBoard;
  advisor?: AdvisorPolicy;
  weights: PlanWeights;
  nextModel: string;
};

export function seatSources(pool: AccountPool, plans: Record<string, import('./pricing.js').Plan>, advisor: AdvisorPolicy | undefined, now: number): SeatSource[] {
  return pool.list().map((a) => {
    const rt = pool.runtime(a.id);
    const why = pool.unavailableReason(a, now);
    const inFlight = pool.inFlightOf(a.id);
    let status: string;
    if (why === null) status = inFlight > 0 ? 'active' : 'ok';
    else if (why.startsWith('auth failed')) status = 'auth failed';
    else status = why;
    const adv = advisor?.enabled ? advisor.view(a.id) : null;
    return {
      id: a.id,
      label: a.label,
      enabled: a.enabled,
      auth: a.auth,
      lastResort: pool.tierOf(a) > 0,
      plan: plans[a.id] ?? null,
      advisor: adv ? adv.state !== 'unavailable' : null,
      windows: (rt.usage?.windows ?? []).map((w) => ({ key: w.key, model: w.model, percent: w.percent ?? null, resetsAt: w.resetsAt ?? null })),
      usageStale: !!rt.usage?.stale,
      requests: rt.requests ?? 0,
      inFlight,
      lastUsedAt: rt.lastUsedAt ?? null,
      exhaustedUntil: why === 'exhausted' ? (rt.exhaustedUntil ?? null) : null,
      throttledUntil: why === 'throttled' ? (rt.throttledUntil ?? null) : null,
      status,
      statusDetail: why === 'exhausted' ? (rt.exhaustedReason ?? null) : why === 'throttled' ? (rt.throttleReason ?? null) : why,
      lastError: rt.lastError?.message ?? null,
      email: rt.email ?? null,
      exposeModels: a.exposeModels,
    };
  });
}

/** Threads warm on each seat: engine sessions used within {@link LIVE_THREAD_MS}; busy = a turn of that agent runs there now. */
export function liveThreads(records: Array<{ key: string; accountId: string; updatedAt: number; contextTokens?: number }>, running: ActivityItem[], stats: ServedStats, now: number): LiveThread[] {
  const busy = new Set(running.filter((r) => isLive(r.status) && r.seatId).map((r) => `${r.seatId}|${(r.agent ?? '').toLowerCase()}`));
  const out: LiveThread[] = [];
  for (const r of records) {
    if (!r.key || now - r.updatedAt > LIVE_THREAD_MS) continue;
    const id = threadOfKey(r.key);
    const info = stats.thread(r.key);
    out.push({
      key: r.key,
      seat: r.accountId,
      agent: id.agent,
      title: info?.title,
      ctx: r.contextTokens ?? info?.ctx,
      at: r.updatedAt,
      busy: busy.has(`${r.accountId}|${id.agent.toLowerCase()}`),
    });
  }
  return out;
}

export function registerSeatsUsage(ctx: PluginContext, deps: SeatsUsageDeps): void {
  const { pool, history, journal, stats, activity, advisor, weights } = deps;
  const build = () => {
    const now = Date.now();
    const day0 = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
    const plans = history.plans();
    return buildSeatsUsage({
      now,
      store: history.store,
      seats: seatSources(pool, plans, advisor, now),
      cold: journal.since(now - EVENTS_SPAN_MS, 'cold').slice(0, 600),
      compactions: journal.since(now - EVENTS_SPAN_MS, 'compaction').slice(0, 300),
      coldTotal: journal.since(day0, 'cold').length,
      modesToday: stats.modesOf(new Date(now).toLocaleDateString('sv-SE')),
      threadInfo: (k) => stats.thread(k),
      liveThreads: liveThreads(history.engine.records(), activity.view(), stats, now),
      samples: (seat, window, from) => history.capacity.samples(seat, window, from),
      resets: history.capacity.events,
      weights,
      nextId: pool.nextPick(deps.nextModel)?.id ?? null,
      hourSpan: 72,
    });
  };
  ctx.registerAction('seatsUsage', async (args) => {
    try {
      const since = (args as { since?: unknown } | undefined)?.since;
      const view = build();
      const { now: _now, ...stable } = view;
      void _now;
      const version = hash(JSON.stringify(stable));
      if (since === version) return { ok: true, unchanged: true, version, now: view.now };
      return { ok: true, version, scan: history.scanner.status, settings: pool.settings, ...view };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}

/** FNV-1a of a string, base 36: a cheap content version. */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}
