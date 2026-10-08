/**
 * "Use it or lose it" seat choice (accounts/drain.ts + AccountPool.pick).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AccountPool } from '../src/accounts/pool.js';
import { drainReason, drainScore } from '../src/accounts/drain.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const NOW = Date.UTC(2026, 9, 9, 12, 0);
const H = 3_600_000;
const root = mkdtempSync(join(tmpdir(), 'alfred-drain-'));
after(() => rmSync(root, { recursive: true, force: true }));

function makePool(n: number, dataDir = mkdtempSync(join(root, 'p-'))): AccountPool {
  const pool = new AccountPool({ dataDir, logger, now: () => NOW });
  pool.remove('default');
  for (let i = 1; i <= n; i++) {
    const a = pool.add(`Seat ${i}`, 'token');
    pool.setToken(a.id, `tok-${i}`);
  }
  return pool;
}

const usage = (five: number, fiveResetH: number, week?: number, weekResetH?: number) => ({
  windows: [
    { key: 'five_hour', label: '5h', percent: five, resetsAt: NOW + fiveResetH * H },
    ...(week !== undefined ? [{ key: 'seven_day', label: 'Week', percent: week, resetsAt: NOW + (weekResetH ?? 100) * H }] : []),
  ],
  fetchedAt: NOW,
  source: 'api' as const,
});

describe('drain score', () => {
  it('is the tightest headroom per hour left before the earliest reset', () => {
    const d = drainScore(usage(40, 2, 10, 100), 'opus', 90, NOW);
    assert.equal(d.headroom, 50);
    assert.equal(d.resetsAt, NOW + 2 * H);
    assert.equal(d.score, 25);
    // A nearly spent week caps a fresh 5h window.
    assert.equal(drainScore(usage(0, 4, 85, 100), 'opus', 90, NOW).headroom, 5);
    // A window about to roll over does not win on a division by ~0.
    assert.equal(drainScore(usage(10, 0.01), 'opus', 90, NOW).score, 80 / 0.25);
    assert.equal(drainReason(drainScore(usage(38, 40 / 60), 'opus', 90, NOW), 90, NOW), 'resets in 40m, 62% left');
  });
});

describe('drain strategy', () => {
  it('is the default, and takes the seat whose quota resets soonest with the most left', () => {
    const pool = makePool(3);
    assert.equal(pool.settings.strategy, 'drain');
    const [a, b, c] = pool.list();
    pool.setUsage(a.id, usage(10, 4.5)); // 80 left over 4.5 h
    pool.setUsage(b.id, usage(30, 0.5)); // 60 left over 30 min: lost soon
    pool.setUsage(c.id, usage(0, 5)); // 90 left over 5 h
    assert.equal(pool.pick({ model: 'opus' }).account?.id, b.id);
    const next = pool.nextPick('opus')!;
    assert.equal(next.id, b.id);
    assert.equal(next.why, 'resets in 30m, 70% left');
  });

  it('breaks ties with the manual seat order', () => {
    const pool = makePool(3);
    const [a, b, c] = pool.list();
    for (const s of [a, b, c]) pool.setUsage(s.id, usage(20, 2));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, a.id);
    pool.moveTo(c.id, 0);
    assert.equal(pool.pick({ model: 'opus' }).account?.id, c.id);
  });

  it('leaves out exhausted, disabled and over-threshold seats', () => {
    const pool = makePool(4);
    const [a, b, c, d] = pool.list();
    pool.setUsage(a.id, usage(10, 0.5));
    pool.markExhausted(a.id, NOW + H, '5h at 100%');
    pool.setUsage(b.id, usage(10, 0.5));
    pool.update(b.id, { enabled: false });
    pool.setUsage(c.id, usage(95, 0.5)); // over the 90% threshold
    pool.setUsage(d.id, usage(50, 4));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, d.id);
  });

  it('keeps a running conversation on its seat while that seat is under the threshold', () => {
    const pool = makePool(2);
    const [a, b] = pool.list();
    pool.setUsage(a.id, usage(10, 4.5));
    pool.setUsage(b.id, usage(10, 0.5)); // the drain choice for a new conversation
    assert.equal(pool.pick({ model: 'opus' }).account?.id, b.id);
    assert.equal(pool.pick({ model: 'opus', prefer: a.id }).account?.id, a.id, 'affinity wins');
    pool.setUsage(a.id, usage(92, 4.5));
    assert.equal(pool.pick({ model: 'opus', prefer: a.id }).account?.id, b.id, 'over the threshold: it moves');
  });

  it('moves a saved fill (the old default) to drain once, then keeps a fill chosen later', () => {
    const dataDir = mkdtempSync(join(root, 'm-'));
    makePool(1, dataDir).updateSettings({ strategy: 'fill' });
    const path = join(dataDir, 'accounts.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    delete raw.settings.drainDefaulted;
    writeFileSync(path, JSON.stringify(raw));
    const p2 = new AccountPool({ dataDir, logger, now: () => NOW });
    assert.equal(p2.settings.strategy, 'drain');
    p2.updateSettings({ strategy: 'fill' });
    const p3 = new AccountPool({ dataDir, logger, now: () => NOW });
    assert.equal(p3.settings.strategy, 'fill');
  });
});
