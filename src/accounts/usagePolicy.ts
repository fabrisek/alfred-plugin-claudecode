/**
 * How often the plugin may call Anthropic's usage endpoint (GET
 * /api/oauth/usage), per seat and in total. The endpoint is rate limited and
 * shared with the CLI itself, so reads are rationed:
 *
 * - one read per seat every POLL_MIN_MS at most (manual refresh: MANUAL_MIN_MS);
 * - reads spaced by SPACING_MS between seats, never all at once;
 * - a seat that is exhausted is not read again until shortly before its reset;
 * - after a 429 or an error, exponential backoff, at least the retry-after;
 * - hard ceilings per rolling hour, per seat and in total.
 *
 * Everything else (the panel, the pool, the quota curves) reads the cached
 * result; the rate-limit info the CLI streams with real requests updates it
 * for free. The last known value stays shown, with its age.
 */

export const POLL_MIN_MS = 5 * 60_000;
export const MANUAL_MIN_MS = 2 * 60_000;
export const SPACING_MS = 15_000;
export const EXHAUSTED_LEAD_MS = 2 * 60_000;
export const BACKOFF_429_MS = 2 * 60_000;
export const BACKOFF_ERROR_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
/** Rolling-hour ceilings: no code path can read more than this. */
export const HOURLY_CAP_PER_SEAT = 12;
export const HOURLY_CAP_TOTAL = 60;

export type FetchOutcome = { ok: true } | { ok: false; status?: number; retryAfterMs?: number };

type SeatState = { last: number; failures: number; blockedUntil: number; reads: number[] };

export class UsageFetchPolicy {
  private readonly seats = new Map<string, SeatState>();
  private readonly all: number[] = [];
  private lastAny = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private seat(id: string): SeatState {
    let s = this.seats.get(id);
    if (!s) {
      s = { last: 0, failures: 0, blockedUntil: 0, reads: [] };
      this.seats.set(id, s);
    }
    return s;
  }

  private prune(list: number[], now: number): void {
    while (list.length && list[0] <= now - 3_600_000) list.shift();
  }

  /**
   * May this seat be read now? `exhaustedUntil`: when the seat is back, if it
   * is out. `manual`: the user asked (shorter interval, same ceilings).
   * Returns 0 when it may, else how long to wait.
   */
  waitFor(id: string, opts: { exhaustedUntil?: number | null; manual?: boolean } = {}): number {
    const now = this.now();
    const s = this.seat(id);
    this.prune(s.reads, now);
    this.prune(this.all, now);
    const waits = [
      s.last + (opts.manual ? MANUAL_MIN_MS : POLL_MIN_MS) - now,
      s.blockedUntil - now,
      this.lastAny + SPACING_MS - now,
      s.reads.length >= HOURLY_CAP_PER_SEAT ? s.reads[0] + 3_600_000 - now : 0,
      this.all.length >= HOURLY_CAP_TOTAL ? this.all[0] + 3_600_000 - now : 0,
    ];
    // Out until its reset: nothing to learn before then.
    if (opts.exhaustedUntil && opts.exhaustedUntil - EXHAUSTED_LEAD_MS > now) waits.push(opts.exhaustedUntil - EXHAUSTED_LEAD_MS - now);
    return Math.max(0, ...waits);
  }

  /** A read is about to go out. */
  begin(id: string): void {
    const now = this.now();
    const s = this.seat(id);
    s.last = now;
    s.reads.push(now);
    this.all.push(now);
    this.lastAny = now;
  }

  /** How the read went: failures back off, at least by the retry-after. */
  end(id: string, outcome: FetchOutcome): void {
    const s = this.seat(id);
    if (outcome.ok) {
      s.failures = 0;
      s.blockedUntil = 0;
      return;
    }
    s.failures++;
    const base = outcome.status === 429 ? BACKOFF_429_MS : BACKOFF_ERROR_MS;
    const back = Math.min(BACKOFF_MAX_MS, base * 2 ** (s.failures - 1));
    s.blockedUntil = this.now() + Math.max(back, outcome.retryAfterMs ?? 0);
  }

  /** Reads in the last hour, per seat and in total. */
  stats(): { total: number; perSeat: Record<string, number> } {
    const now = this.now();
    this.prune(this.all, now);
    const perSeat: Record<string, number> = {};
    for (const [id, s] of this.seats) {
      this.prune(s.reads, now);
      perSeat[id] = s.reads.length;
    }
    return { total: this.all.length, perSeat };
  }
}
