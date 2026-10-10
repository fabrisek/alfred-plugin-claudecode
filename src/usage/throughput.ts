/**
 * Live throughput: tokens per minute of every API response the CLIs got
 * (main loops, sub-agents, advisor calls), keyed by the response's own
 * timestamp. Fed by the transcript scanner, so it covers the full served-call
 * stream, not one session file. Plain data kept in the usage history file.
 */

export const MINUTE_MS = 60_000;
/** Minutes kept: two days, enough for "today" and its peak. */
export const KEEP_MINUTES = 48 * 60;

/** minute index (epoch ms / 1 min) → tokens */
export type MinuteData = Record<string, number>;

export function addMinute(data: MinuteData, at: number, tokens: number): void {
  if (!(tokens > 0) || !Number.isFinite(at)) return;
  const m = String(Math.floor(at / MINUTE_MS));
  data[m] = (data[m] ?? 0) + tokens;
}

export function pruneMinutes(data: MinuteData, now: number): boolean {
  const min = Math.floor(now / MINUTE_MS) - KEEP_MINUTES;
  let changed = false;
  for (const k of Object.keys(data)) {
    if (Number(k) < min) {
      delete data[k];
      changed = true;
    }
  }
  return changed;
}

/** Tokens per minute for the `n` minutes ending with the current one, oldest first. */
export function perMinute(data: MinuteData, now: number, n = 60): number[] {
  const last = Math.floor(now / MINUTE_MS);
  const out: number[] = [];
  for (let m = last - n + 1; m <= last; m++) out.push(data[String(m)] ?? 0);
  return out;
}

export type ThroughputStats = {
  /** Tokens/s averaged over [from, now]. */
  avgPerSec: number;
  /** Busiest minute since `from`, in tokens/s. */
  peakPerSec: number;
  peakAt: number | null;
  tokens: number;
};

export function throughputSince(data: MinuteData, from: number, now: number): ThroughputStats {
  const m0 = Math.floor(from / MINUTE_MS);
  const m1 = Math.floor(now / MINUTE_MS);
  let tokens = 0;
  let peak = 0;
  let peakAt: number | null = null;
  for (const [k, v] of Object.entries(data)) {
    const m = Number(k);
    if (m < m0 || m > m1) continue;
    tokens += v;
    if (v > peak) {
      peak = v;
      peakAt = m * MINUTE_MS;
    }
  }
  const secs = Math.max(60, (now - from) / 1000);
  return { avgPerSec: tokens / secs, peakPerSec: peak / 60, peakAt, tokens };
}
