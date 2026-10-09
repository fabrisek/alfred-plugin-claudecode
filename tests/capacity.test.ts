/**
 * Lost capacity: reset events from successive usage readings, and the
 * estimate of what a window could have served.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CapacityTracker, capacityRows } from '../src/usage/capacity.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 9, 10, 0);
const tmp = mkdtempSync(join(tmpdir(), 'alfred-capacity-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

const reading = (at: number, five: number, fiveReset: number, week?: number, weekReset?: number) => ({
  windows: [
    { key: 'five_hour', label: '5h', percent: five, resetsAt: fiveReset },
    ...(week !== undefined ? [{ key: 'seven_day', label: 'Week', percent: week, resetsAt: weekReset ?? T0 + 100 * H }] : []),
    { key: 'weekly:fable', label: 'Fable week', model: 'fable', percent: 0, resetsAt: T0 + 50 * H },
  ],
  fetchedAt: at,
  source: 'api' as const,
});

describe('CapacityTracker', () => {
  it('records the last utilisation seen before each reset', () => {
    let now = T0;
    const path = join(tmp, `c${++n}.json`);
    const t = new CapacityTracker(path, () => now);
    t.observe('a', reading(T0, 20, T0 + H, 50));
    now = T0 + 30 * 60_000;
    t.observe('a', reading(now, 40, T0 + H, 52));
    assert.equal(t.events.length, 0, 'same window: nothing yet');
    // Next poll after the reset: a new 5h window.
    now = T0 + H + 5 * 60_000;
    t.observe('a', reading(now, 1, T0 + 6 * H, 53));
    assert.equal(t.events.length, 1);
    assert.deepEqual(
      { ...t.events[0] },
      { account: 'a', window: 'five_hour', resetAt: T0 + H, percent: 40, seenAt: T0 + 30 * 60_000 },
    );
    // A window that passes its reset with no new reading is over too.
    now = T0 + 7 * H;
    t.observe('a', undefined);
    assert.equal(t.events.length, 2);
    assert.equal(t.events[1].percent, 1);
    t.save();
    const back = new CapacityTracker(path, () => now);
    assert.equal(back.events.length, 2, 'persisted');
    assert.equal(back.since, T0);
  });

  it('estimates the full window from the share used, and fills lightly used ones with the median', () => {
    const events = [
      { account: 'a', window: 'five_hour', resetAt: T0, percent: 40, seenAt: T0 },
      { account: 'a', window: 'five_hour', resetAt: T0 + 5 * H, percent: 50, seenAt: T0 },
      { account: 'a', window: 'five_hour', resetAt: T0 + 10 * H, percent: 2, seenAt: T0 },
      { account: 'b', window: 'five_hour', resetAt: T0, percent: 0, seenAt: T0 },
    ];
    const spend = (acc: string, from: number) =>
      acc === 'a' ? (from === T0 - 5 * H ? { tokens: 400, usd: 4 } : from === T0 ? { tokens: 1000, usd: 10 } : { tokens: 30, usd: 0.3 }) : { tokens: 0, usd: 0 };
    const rows = capacityRows(events, spend);
    assert.equal(rows[0].fullTokens, 1000, '400 tokens for 40% -> 1000 for the window');
    assert.equal(rows[0].fullUsd, 10);
    assert.equal(rows[1].fullTokens, 2000);
    assert.equal(rows[2].fullTokens, 2000, '2% is too little to extrapolate: the median full window');
    assert.equal(rows[3].fullTokens, null, 'no estimate for a seat never measured');
  });
});

describe('quota readings over time', () => {
  it('records each new reading, and stays bounded in count and age', async () => {
    const { SAMPLES_MAX, SAMPLES_KEEP_MS } = await import('../src/usage/capacity.js');
    let now = T0;
    const t = new CapacityTracker(join(tmp, `s${++n}.json`), () => now);
    t.observe('a', reading(now, 10, now + H));
    t.observe('a', reading(now, 10, now + H));
    assert.equal(t.samples('a', 'five_hour').length, 1, 'the same reading twice is one sample');
    for (let i = 1; i <= SAMPLES_MAX + 50; i++) {
      now = T0 + i * 60_000;
      t.observe('a', reading(now, i % 100, now + H));
    }
    assert.equal(t.samples('a', 'five_hour').length, SAMPLES_MAX, 'capped');
    now += SAMPLES_KEEP_MS + H;
    t.observe('a', reading(now, 5, now + H));
    assert.equal(t.samples('a', 'five_hour').length, 1, 'older than the retention: dropped');
    t.save();
    assert.equal(new CapacityTracker(t['path' as never] as unknown as string, () => now).samples('a', 'five_hour').length, 1, 'persisted');
  });
});
