/**
 * Seat choice for a new thread (AccountPool.pick): "most quota left"
 * (headroom, the default) and "use it or lose it" (accounts/drain.ts).
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

function makePool(n: number, dataDir = mkdtempSync(join(root, 'p-')), log = logger): AccountPool {
  const pool = new AccountPool({ dataDir, logger: log, now: () => NOW });
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
    assert.equal(drainReason(drainScore(usage(38, 40 / 60), 'opus', 90, NOW), 90, NOW), '62% left, resets in 40m');
  });
});

describe('headroom strategy (most quota left)', () => {
  it('is the default, and places a new thread on the seat with the most quota left', () => {
    const pool = makePool(3);
    assert.equal(pool.settings.strategy, 'headroom');
    const [a, b, c] = pool.list();
    pool.setUsage(a.id, usage(10, 4.5, 50)); // tightest window: the week, 50 left
    pool.setUsage(b.id, usage(30, 0.5)); // 70 left (resets soon: irrelevant here)
    pool.setUsage(c.id, usage(20, 5)); // 80 left
    assert.equal(pool.pick({ model: 'opus' }).account?.id, c.id);
    const next = pool.nextPick('opus')!;
    assert.equal(next.id, c.id);
    assert.equal(next.why, '80% left, 0 thread(s) on it');
  });

  it('divides a seat\'s quota among the threads already on it', () => {
    const pool = makePool(2);
    const [a, b] = pool.list();
    pool.setUsage(a.id, usage(10, 3)); // 90 left
    pool.setUsage(b.id, usage(50, 3)); // 50 left
    const idle = new Map<string, number>();
    pool.addLoadSource(() => idle);
    // Fan-out of parallel agents: each new thread lands where its share is largest.
    const placed: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = pool.pick({ model: 'opus' }).account!.id;
      placed.push(id === a.id ? 'a' : 'b');
      pool.begin(id); // in flight: counts as a thread on that seat
    }
    // a: 90/1, then 90/2=45 < b 50/1 -> b, then a 45 > b 25 -> a, then a 30 > b 25 -> a.
    assert.deepEqual(placed, ['a', 'b', 'a', 'a']);
    assert.equal(pool.threadsOn(a.id), 3);
    for (const id of [a.id, a.id, a.id, b.id]) pool.end(id, { model: 'opus', outcome: 'ok' });
    // Idle processes kept warm count too.
    idle.set(a.id, 2);
    assert.equal(pool.threadsOn(a.id), 2);
    assert.equal(pool.pick({ model: 'opus' }).account?.id, b.id, '90/3 = 30 < 50/1');
  });

  it('prefers seats under the threshold, keeps affinity, and logs each placement', () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const log = { debug() {}, info: (m: string, f: Record<string, unknown>) => lines.push([m, f]), warn() {}, error() {} } as never;
    const pool = makePool(2, mkdtempSync(join(root, 'l-')), log);
    const [a, b] = pool.list();
    pool.setUsage(a.id, usage(95, 3)); // over 90: 5 left
    pool.setUsage(b.id, usage(89, 3)); // 11 left, under
    for (let i = 0; i < 5; i++) pool.begin(b.id);
    assert.equal(pool.pick({ model: 'opus', place: { thread: 't1', source: 'engine' } }).account?.id, b.id);
    assert.equal(pool.pick({ model: 'opus', prefer: a.id, place: { thread: 't2', source: 'engine' } }).account?.id, a.id);
    const placements = lines.filter(([m]) => m === 'thread placed on a seat');
    assert.equal(placements.length, 1, 'a thread kept on its seat is not a placement');
    assert.equal(placements[0][1].thread, 't1');
    assert.equal(placements[0][1].account, b.id);
    assert.match(String(placements[0][1].why), /^11% left, 5 thread\(s\) on it; next: /);
  });
});

describe('drain strategy', () => {
  it('takes the seat whose quota resets soonest with the most left', () => {
    const pool = makePool(3);
    pool.updateSettings({ strategy: 'drain' });
    const [a, b, c] = pool.list();
    pool.setUsage(a.id, usage(10, 4.5)); // 80 left over 4.5 h
    pool.setUsage(b.id, usage(30, 0.5)); // 60 left over 30 min: lost soon
    pool.setUsage(c.id, usage(0, 5)); // 90 left over 5 h
    assert.equal(pool.pick({ model: 'opus' }).account?.id, b.id);
    const next = pool.nextPick('opus')!;
    assert.equal(next.id, b.id);
    assert.equal(next.why, '70% left, resets in 30m');
  });

  it('breaks ties with the manual seat order', () => {
    const pool = makePool(3);
    pool.updateSettings({ strategy: 'drain' });
    const [a, b, c] = pool.list();
    for (const s of [a, b, c]) pool.setUsage(s.id, usage(20, 2));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, a.id);
    pool.moveTo(c.id, 0);
    assert.equal(pool.pick({ model: 'opus' }).account?.id, c.id);
  });

  it('leaves out exhausted, disabled and over-threshold seats', () => {
    const pool = makePool(4);
    pool.updateSettings({ strategy: 'drain' });
    const [a, b, c, d] = pool.list();
    pool.setUsage(a.id, usage(10, 0.5));
    pool.markExhausted(a.id, NOW + H, '5h at 100%');
    pool.setUsage(b.id, usage(10, 0.5));
    pool.update(b.id, { enabled: false });
    pool.setUsage(c.id, usage(95, 0.5)); // over the 90% threshold
    pool.setUsage(d.id, usage(50, 4));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, d.id);
  });

  it('keeps a running conversation on its seat until that seat is really out', () => {
    const pool = makePool(2);
    pool.updateSettings({ strategy: 'drain' });
    const [a, b] = pool.list();
    pool.setUsage(a.id, usage(10, 4.5));
    pool.setUsage(b.id, usage(10, 0.5)); // the drain choice for a new conversation
    assert.equal(pool.pick({ model: 'opus' }).account?.id, b.id);
    assert.equal(pool.pick({ model: 'opus', prefer: a.id }).account?.id, a.id, 'affinity wins');
    // Over the threshold the seat takes no new conversation, but keeps this
    // one: moving it would re-write it whole on the other seat.
    pool.setUsage(a.id, usage(92, 4.5));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, b.id);
    assert.equal(pool.pick({ model: 'opus', prefer: a.id }).account?.id, a.id, 'over the threshold: it stays');
    pool.backoff(a.id, 20_000, 'throttled');
    assert.equal(pool.throttledFor(a.id) > 0, true, 'a throttle: the caller waits for the seat');
    pool.clearExhausted(a.id);
    pool.markExhausted(a.id, Date.now() + 3_600_000, 'limit');
    assert.equal(pool.pick({ model: 'opus', prefer: a.id }).account?.id, b.id, 'exhausted: it moves');
  });

  it('picks the seat about to lose the most, on the panel data of 2026-10-09 04:00', () => {
    // claude-standard: 1% used, resets in 4h51; fabrisek: 75% used, resets in 11 min;
    // claude-premium1: 61% used, resets in 21 min; claude-premium: 100%.
    const pool = makePool(4);
    pool.updateSettings({ threshold: 100, strategy: 'drain' });
    const [std, fab, prm1, prm] = pool.list();
    pool.setUsage(std.id, usage(1, 4 + 51 / 60));
    pool.setUsage(fab.id, usage(75, 11 / 60));
    pool.setUsage(prm1.id, usage(61, 21 / 60));
    pool.setUsage(prm.id, usage(100, 2));
    const next = pool.nextPick('opus')!;
    assert.equal(next.id, prm1.id, '39% left lost in 21 min beats 25% in 11 min and 99% in almost 5 h');
    assert.equal(next.why, '39% left, resets in 21m');
    pool.updateSettings({ strategy: 'fill' });
    assert.equal(pool.nextPick('opus')!.id, std.id, 'fill: the first seat in order');
  });

  it('moves a saved drain (rev 2) to headroom once (rev 3), then keeps a drain chosen later', () => {
    const dataDir = mkdtempSync(join(root, 'r-'));
    makePool(1, dataDir).updateSettings({ strategy: 'drain' });
    const path = join(dataDir, 'accounts.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.settings.strategyRev = 2; // saved by the previous migration
    raw.settings.drainDefaulted = true;
    writeFileSync(path, JSON.stringify(raw));
    const p2 = new AccountPool({ dataDir, logger, now: () => NOW });
    assert.equal(p2.settings.strategy, 'headroom');
    p2.updateSettings({ strategy: 'drain' });
    assert.equal(new AccountPool({ dataDir, logger, now: () => NOW }).settings.strategy, 'drain');
  });

  it('moves a saved fill (an old default) to headroom, keeps spread', () => {
    const dataDir = mkdtempSync(join(root, 'm-'));
    makePool(1, dataDir).updateSettings({ strategy: 'fill' });
    const path = join(dataDir, 'accounts.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    delete raw.settings.drainDefaulted;
    delete raw.settings.strategyRev;
    writeFileSync(path, JSON.stringify(raw));
    const p2 = new AccountPool({ dataDir, logger, now: () => NOW });
    assert.equal(p2.settings.strategy, 'headroom');
    p2.updateSettings({ strategy: 'fill' });
    assert.equal(new AccountPool({ dataDir, logger, now: () => NOW }).settings.strategy, 'fill');
    const d3 = mkdtempSync(join(root, 's-'));
    makePool(1, d3).updateSettings({ strategy: 'spread' });
    const raw3 = JSON.parse(readFileSync(join(d3, 'accounts.json'), 'utf8'));
    delete raw3.settings.strategyRev;
    writeFileSync(join(d3, 'accounts.json'), JSON.stringify(raw3));
    assert.equal(new AccountPool({ dataDir: d3, logger, now: () => NOW }).settings.strategy, 'spread');
  });
});
