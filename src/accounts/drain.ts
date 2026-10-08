/**
 * "Use it or lose it": which seat should start the next conversation so that
 * quota about to be reset is spent before it is lost.
 *
 * A seat's quota comes in windows (5h, week, per-model weeks) that reset at
 * known times; whatever is unused at a reset is gone. The seat to drain first
 * is the one with the most headroom per hour left before its next reset:
 *
 *   headroom = min over the windows that constrain the model of (threshold − used%)
 *   hours    = time until the earliest future reset among those windows
 *   score    = headroom / max(hours, 15 min)
 *
 * The smallest headroom is the real one (a seat at 85% of its week cannot
 * spend a fresh 5h window), and the earliest reset is when some of it goes
 * away. The 15-minute floor keeps a window about to roll over from winning on
 * a division by almost zero. A seat with no usage reading counts as a fresh
 * 5h window. Ties go to the manual seat order.
 */

import { modelFamily, type AccountUsage } from './usage.js';

const HOUR_MS = 3_600_000;
const MIN_HOURS = 0.25;
/** Assumed for a seat whose usage was never read: a fresh 5h window. */
const UNKNOWN_HOURS = 5;

export type DrainScore = {
  score: number;
  /** Percentage points left before the switch threshold, on the tightest window. */
  headroom: number;
  /** Earliest future reset among the relevant windows, or null when unknown. */
  resetsAt: number | null;
};

export function drainScore(usage: AccountUsage | undefined, model: string, threshold: number, now = Date.now()): DrainScore {
  const fam = modelFamily(model);
  const windows = (usage?.windows ?? []).filter(
    (w) => (!w.model || w.model === fam) && (w.resetsAt === null || w.resetsAt > now),
  );
  let headroom = threshold;
  let resetsAt: number | null = null;
  for (const w of windows) {
    headroom = Math.min(headroom, threshold - (typeof w.percent === 'number' ? w.percent : 0));
    if (w.resetsAt !== null && (resetsAt === null || w.resetsAt < resetsAt)) resetsAt = w.resetsAt;
  }
  headroom = Math.max(0, headroom);
  const hours = resetsAt === null ? UNKNOWN_HOURS : Math.max(MIN_HOURS, (resetsAt - now) / HOUR_MS);
  return { score: headroom / hours, headroom, resetsAt };
}

/** "resets in 40m, 62% left" */
export function drainReason(d: DrainScore, threshold: number, now = Date.now()): string {
  const left = `${Math.round(d.headroom + (100 - threshold))}% left`;
  if (d.resetsAt === null) return `no reset known, ${left}`;
  const m = Math.max(0, Math.round((d.resetsAt - now) / 60_000));
  const when = m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return `resets in ${when}, ${left}`;
}
