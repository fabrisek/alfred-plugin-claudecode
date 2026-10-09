/**
 * Rationing of the usage endpoint: whatever asks, how often, the reads stay
 * under the ceilings; failures back off; exhausted seats wait for their reset.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BACKOFF_429_MS,
  HOURLY_CAP_PER_SEAT,
  HOURLY_CAP_TOTAL,
  MANUAL_MIN_MS,
  POLL_MIN_MS,
  SPACING_MS,
  UsageFetchPolicy,
} from '../src/accounts/usagePolicy.js';
import { retryAfterMs } from '../src/accounts/usage.js';

const T0 = Date.UTC(2026, 9, 9, 4, 0);

describe('usage read rationing', () => {
  it('a seat is read every 5 minutes at most, seats are spaced, manual refresh has a cooldown', () => {
    let now = T0;
    const p = new UsageFetchPolicy(() => now);
    assert.equal(p.waitFor('a'), 0);
    p.begin('a');
    p.end('a', { ok: true });
    assert.equal(p.waitFor('b'), SPACING_MS, 'the next seat waits for the spacing');
    now += SPACING_MS;
    assert.equal(p.waitFor('b'), 0);
    assert.equal(p.waitFor('a'), POLL_MIN_MS - SPACING_MS);
    assert.equal(p.waitFor('a', { manual: true }), MANUAL_MIN_MS - SPACING_MS, 'a manual refresh: shorter, never immediate');
  });

  it('never exceeds the hourly ceilings, however hard it is asked (the panel, the pool, every request)', () => {
    let now = T0;
    const p = new UsageFetchPolicy(() => now);
    const seats = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'];
    const reads: number[] = [];
    const perSeat: Record<string, number[]> = {};
    // Three hours: every second, every seat asks to be read, half of them "manually".
    for (let t = 0; t < 3 * 3600; t++) {
      now = T0 + t * 1000;
      for (const [i, id] of seats.entries()) {
        if (p.waitFor(id, { manual: (t + i) % 2 === 0 }) === 0) {
          p.begin(id);
          p.end(id, { ok: true });
          reads.push(now);
          (perSeat[id] ??= []).push(now);
        }
      }
    }
    const maxInHour = (list: number[]) => {
      let max = 0;
      for (let i = 0, j = 0; i < list.length; i++) {
        while (list[i] - list[j] >= 3_600_000) j++;
        max = Math.max(max, i - j + 1);
      }
      return max;
    };
    assert.ok(maxInHour(reads) <= HOURLY_CAP_TOTAL, `total ${maxInHour(reads)} in an hour`);
    for (const id of seats) assert.ok(maxInHour(perSeat[id] ?? []) <= HOURLY_CAP_PER_SEAT, `${id}: ${maxInHour(perSeat[id] ?? [])} in an hour`);
    assert.equal(p.stats().total, maxInHour(reads.filter((r) => r > now - 3_600_000)));
  });

  it('backs off after a 429, at least by its retry-after, doubling', () => {
    let now = T0;
    const p = new UsageFetchPolicy(() => now);
    p.begin('a');
    p.end('a', { ok: false, status: 429, retryAfterMs: 10 * 60_000 });
    assert.equal(p.waitFor('a'), 10 * 60_000, 'retry-after wins over the base backoff');
    now += 10 * 60_000;
    p.begin('a');
    p.end('a', { ok: false, status: 429 });
    p.end('a', { ok: false, status: 429 });
    assert.equal(p.waitFor('a'), 4 * BACKOFF_429_MS, 'doubles at each failure (2, 4, 8 min...)');
    now += 4 * BACKOFF_429_MS;
    p.begin('a');
    p.end('a', { ok: true });
    now += POLL_MIN_MS;
    assert.equal(p.waitFor('a'), 0, 'a success resets the backoff');
    assert.equal(retryAfterMs('120'), 120_000);
    assert.equal(retryAfterMs(new Date(T0 + 30_000).toUTCString(), T0), 30_000);
  });

  it('an exhausted seat is not read until shortly before it is back', () => {
    const now = T0;
    const p = new UsageFetchPolicy(() => now);
    assert.equal(p.waitFor('a', { exhaustedUntil: T0 + 3 * 3_600_000 }), 3 * 3_600_000 - 2 * 60_000);
    assert.equal(p.waitFor('a', { exhaustedUntil: T0 + 60_000 }), 0, 'near its reset: read');
  });
});
