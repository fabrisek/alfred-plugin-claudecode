/**
 * API-equivalent cost, worked out by hand from the list prices
 * (platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-10):
 * ids and aliases, cache write by TTL, cache read per model, fast mode, the
 * advisor at its own price, the cache saving, the periods of `apiCost`, and
 * the tokens without a seat kept in the totals but drawn as no series.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { canonicalModel, costOf, priceOf, pricedModel } from '../src/usage/pricing.js';
import { parseLine } from '../src/usage/transcripts.js';
import { HOUR_MS, UsageStore, addCell, addCost, CELL_LEN } from '../src/usage/history.js';

const near = (got: number, want: number, what: string): void => assert.ok(Math.abs(got - want) < 1e-9, `${what}: ${got} vs ${want}`);
const row = (m: string): number[] => {
  const q = priceOf(m).price;
  return [q.input, q.output, q.cacheRead, q.write5m, q.write1h];
};

describe('list prices', () => {
  it('match the official table, $/MTok: input, output, cache read, write 5m, write 1h', () => {
    assert.deepEqual(row('claude-opus-5-5'), [4, 20, 0.2, 5, 8]);
    assert.deepEqual(row('claude-fable-5-1'), [10, 50, 0.25, 12.5, 20]);
    assert.deepEqual(row('claude-fable-5'), [10, 50, 1, 12.5, 20]);
    assert.deepEqual(row('claude-opus-5'), [5, 25, 0.5, 6.25, 10]);
    assert.deepEqual(row('claude-sonnet-5'), [2, 10, 0.2, 2.5, 4]);
    assert.deepEqual(row('claude-haiku-4-5'), [1, 5, 0.1, 1.25, 2]);
  });

  it('cache read at each model own multiplier, not a generic 0.1x', () => {
    near(priceOf('claude-opus-5-5').price.cacheRead / 4, 0.05, 'Opus 5.5');
    near(priceOf('claude-fable-5-1').price.cacheRead / 10, 0.025, 'Fable 5.1');
    near(priceOf('claude-opus-5').price.cacheRead / 5, 0.1, 'Opus 5');
  });

  it('resolves aliases, dated ids, context suffixes and case', () => {
    assert.equal(canonicalModel('opus'), 'claude-opus-5-5');
    assert.equal(canonicalModel('fable'), 'claude-fable-5-1');
    assert.equal(canonicalModel('Claude-Opus-5-5[1m]'), 'claude-opus-5-5');
    assert.equal(canonicalModel('claude-fable-5-1@advisor'), 'claude-fable-5-1@advisor');
    assert.deepEqual(row('opus[1m]'), [4, 20, 0.2, 5, 8]);
    assert.deepEqual(row('claude-haiku-4-5-20251001'), [1, 5, 0.1, 1.25, 2]);
    assert.deepEqual(row('claude-fable-5-1@advisor'), [10, 50, 0.25, 12.5, 20], 'the advisor at the Fable price');
    assert.equal(priceOf('claude-nova-9').known, false);
  });

  it('no long-context surcharge on 1M models; Haiku 5.5 by prompt band', () => {
    assert.equal(pricedModel('claude-opus-5-5', 900_000), 'claude-opus-5-5');
    assert.equal(pricedModel('claude-haiku-5-5', 150_000), 'claude-haiku-5-5@long');
    assert.deepEqual(row('claude-haiku-5-5@long'), [0.5, 2.5, 0.05, 0.625, 1]);
    assert.deepEqual(row('claude-haiku-5-5'), [0.1, 0.5, 0.01, 0.125, 0.2]);
  });

  it('fast mode: Opus 5.5 at $8 / $40, cache multipliers on top', () => {
    assert.equal(pricedModel('claude-opus-5-5', 1000, true), 'claude-opus-5-5@fast');
    const [i, o, r, w5, w1] = row('claude-opus-5-5@fast');
    assert.deepEqual([i, o], [8, 40]);
    near(r, 0.4, 'read 0.05x');
    near(w5, 10, 'write 5m 1.25x');
    near(w1, 16, 'write 1h 2x');
    assert.deepEqual(row('claude-opus-5@fast').slice(0, 2), [10, 50]);
    const p = parseLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-10T10:00:00Z', message: { id: 'f', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5, speed: 'fast' } } }))!;
    assert.equal(p.fast, true);
  });
});

describe('one hour of real traffic (2026-10-10 00:00 UTC, all seats)', () => {
  // Opus 5.5 with Fable 5.1 advising: the hour the panel showed as "Input: 8.2M tok · $81.9".
  const opus: [number, number, number, number, number, number] = [2030, 4118, 41063, 9748387, 272740783, 1170610];
  const fable: [number, number, number, number, number, number] = [0, 8188017, 0, 0, 0, 89731];

  it('prices each model at its own rates', () => {
    near(costOf('claude-opus-5-5', opus), (4118 * 4 + 41063 * 5 + 9748387 * 8 + 272740783 * 0.2 + 1170610 * 20) / 1e6, 'Opus 5.5');
    near(costOf('claude-fable-5-1@advisor', fable), (8188017 * 10 + 89731 * 50) / 1e6, 'Fable advisor');
  });

  it('the cell keeps the advisor share apart: Opus input is 4.1k tok at $4/M, not 8.2M at $10/M', () => {
    const c = new Array(CELL_LEN).fill(0);
    addCell('claude-opus-5-5', opus, c);
    addCell('claude-fable-5-1@advisor', fable, c);
    near(c[4], (4118 * 4 + 8188017 * 10) / 1e6, 'input $ (all models)');
    assert.equal(c[0] - c[15], 4118, 'served model input tokens');
    near(c[4] - c[19], (4118 * 4) / 1e6, 'served model input $');
    near(c[19], 81.88017, 'advisor input $');
    near(c[14], 81.88017 + (89731 * 50) / 1e6, 'advisor total $');
  });

  it('cache saving = reads x (input - read) - writes x (write - input)', () => {
    const b = { from: null, to: 0, requests: 0, tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, advisor: 0, total: 0 }, usd: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, cacheRead: 0, output: 0, advisor: 0, total: 0, noCache: 0, cacheSaved: 0 }, unpricedTokens: 0 };
    addCost('claude-opus-5-5', opus, b);
    const saved = (272740783 * (4 - 0.2) - 41063 * (5 - 4) - 9748387 * (8 - 4)) / 1e6;
    near(b.usd.noCache - b.usd.total, saved, 'noCache - total');
    // The panel's formula, on a cell: (reads at input - reads) - (writes - writes at input).
    const c = new Array(CELL_LEN).fill(0);
    addCell('claude-opus-5-5', opus, c);
    near(c[9] - c[6] - (c[5] - c[10]), saved, 'panel cacheNet');
  });
});

describe('apiCost periods', () => {
  const NOW = Date.UTC(2026, 9, 10, 12, 30);
  const store = (): UsageStore => new UsageStore(join(mkdtempSync(join(tmpdir(), 'apicost-')), 'h.json'), () => NOW);

  it('5h, today, 7d, 30d, total, with the breakdown and the cost without cache', () => {
    const s = store();
    // 1M of each kind on Opus 5.5, now; the same 3 days ago; 10 days ago; 40 days ago.
    const v: [number, number, number, number, number, number] = [1, 1e6, 1e6, 1e6, 1e6, 1e6];
    s.add(NOW, 'a', 'claude-opus-5-5', '', v);
    s.add(NOW, 'a', 'claude-fable-5-1@advisor', '', [0, 1e6, 0, 0, 0, 0]);
    s.add(NOW - 3 * 24 * HOUR_MS, 'b', 'claude-opus-5-5', '', v);
    s.add(NOW - 10 * 24 * HOUR_MS, 'unknown', 'claude-opus-5-5', '', v);
    s.add(NOW - 40 * 24 * HOUR_MS, 'a', 'claude-opus-5-5', '', v);
    const { periods: p, byAccount } = s.apiCost();
    const one = 4 + 5 + 8 + 0.2 + 20; // $37.2 per 1M of each kind
    near(p['5h'].usd.total, one + 10, '5h');
    near(p['5h'].usd.input, 4, '5h input: Opus only');
    near(p['5h'].usd.advisor, 10, '5h advisor: Fable input');
    near(p['5h'].usd.cacheWrite, 13, '5h write 5m + 1h');
    near(p['5h'].usd.cacheRead, 0.2, '5h read');
    near(p['5h'].usd.output, 20, '5h output');
    near(p['5h'].usd.noCache, 4 * 4 + 20 + 10, '5h without cache');
    near(p['5h'].usd.cacheSaved, 4 * 4 + 20 + 10 - (one + 10), '5h cache saving (negative: writes cost more than one read saves)');
    near(p.today.usd.total, one + 10, 'today');
    near(p['7d'].usd.total, 2 * one + 10, '7d');
    near(p['30d'].usd.total, 3 * one + 10, '30d (seatless tokens included)');
    near(p.total.usd.total, 4 * one + 10, 'total');
    assert.equal(p['5h'].tokens.advisor, 1e6);
    assert.equal(p.total.requests, 4);
    near(byAccount.unknown['30d'].usd.total, one, 'seatless tokens kept per id');
  });

  it('the seatless series is gone from the view, its tokens are not', () => {
    const s = store();
    s.add(NOW, 'a', 'claude-opus-5-5', '', [1, 1e6, 0, 0, 0, 0]);
    s.add(NOW, 'unknown', 'claude-opus-5-5', '', [1, 1e6, 0, 0, 0, 0]);
    const v = s.view({ scan: { running: false, backfilled: true, filesDone: 0, filesTotal: 0, lastScanAt: null }, seats: [{ id: 'a', label: 'A' }] });
    assert.deepEqual(v.accounts, [{ id: 'a', label: 'A' }]);
    assert.ok(v.daily.unknown, 'rows kept');
    near(v.apiCost.periods.today.usd.total, 8, 'both in the totals');
    assert.equal(s.totalsByAccount().unknown[1], 1e6, 'nothing deleted');
  });
});
