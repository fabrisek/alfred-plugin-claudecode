/**
 * Burn rate and time-to-empty of a seat's 5h window, from the sampled quota
 * readings (usage/capacity.ts) rather than an average since the window
 * opened: the slope over the recent readings of the current window.
 */

import type { ResetEvent, Sample } from './capacity.js';

export const FIVE_H_MS = 5 * 3_600_000;
/** Readings this recent set the slope. */
export const BURN_LOOKBACK_MS = 90 * 60_000;
/** Below this span between readings the slope is noise: average instead. */
export const BURN_MIN_SPAN_MS = 10 * 60_000;

export type Burn = {
  /** Percentage points per hour. */
  perHour: number | null;
  /** Milliseconds until 100% at this pace; null when not burning. */
  etaMs: number | null;
  basis: 'samples' | 'average' | null;
};

export function seatBurn(five: { pct: number; resetsAt: number } | null, samples: Sample[], now: number): Burn {
  if (!five) return { perHour: null, etaMs: null, basis: null };
  const start = five.resetsAt - FIVE_H_MS;
  const from = Math.max(start, now - BURN_LOOKBACK_MS);
  const pts: Sample[] = samples.filter((s) => s[0] >= from && s[0] <= now);
  if (!pts.length || pts[pts.length - 1][0] < now - 60_000) pts.push([now, five.pct]);
  let perHour: number | null = null;
  let basis: Burn['basis'] = null;
  if (pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    const span = b[0] - a[0];
    const slope = ((b[1] - a[1]) / span) * 3_600_000;
    if (span >= BURN_MIN_SPAN_MS && slope >= 0) {
      perHour = slope;
      basis = 'samples';
    }
  }
  if (perHour === null) {
    const elapsedH = Math.max(0.1, (now - start) / 3_600_000);
    perHour = five.pct / elapsedH;
    basis = 'average';
  }
  const etaMs = perHour > 0 ? ((100 - five.pct) / perHour) * 3_600_000 : null;
  return { perHour, etaMs: etaMs !== null ? Math.max(0, etaMs) : null, basis };
}

/** How many times the seat's 5h window was full today (resets seen at ≥ 99.5%, plus a window full right now). */
export function hitsSince(events: readonly ResetEvent[], account: string, from: number, fullNow: boolean): number {
  let n = 0;
  for (const e of events) if (e.account === account && e.window === 'five_hour' && e.resetAt >= from && (e.percent ?? 0) >= 99.5) n++;
  return n + (fullNow ? 1 : 0);
}
