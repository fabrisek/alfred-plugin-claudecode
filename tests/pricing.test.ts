/**
 * Prices, checked by hand: real responses from Alfred's transcripts (first
 * one of each model served, 2026-10-08), priced from the reference rates in
 * $/MTok; and, on the real imported history, the sum by model equal to the
 * sum by seat equal to the total.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { costOf, priceOf, priceTokens, pricedModel } from '../src/usage/pricing.js';
import { parseLine } from '../src/usage/transcripts.js';
import { UsageStore } from '../src/usage/history.js';
import { USAGE_ATTRIBUTION_REV } from '../src/usage/register.js';

/** model, input, cache write total, { 1h, 5m }, cache read, output — as the transcripts have them. */
const REAL: Array<[string, number, number, { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number }, number, number]> = [
  ['claude-opus-5-5', 2, 91464, { ephemeral_1h_input_tokens: 91464, ephemeral_5m_input_tokens: 0 }, 11859, 357],
  ['claude-sonnet-5', 2, 27126, { ephemeral_1h_input_tokens: 27126, ephemeral_5m_input_tokens: 0 }, 0, 4],
  ['claude-haiku-4-5-20251001', 10, 2974, { ephemeral_1h_input_tokens: 2974, ephemeral_5m_input_tokens: 0 }, 17359, 1193],
  ['claude-opus-4-5-20251101', 3, 23040, { ephemeral_5m_input_tokens: 23040, ephemeral_1h_input_tokens: 0 }, 0, 36],
  ['claude-fable-5-1', 2, 27113, { ephemeral_1h_input_tokens: 27113, ephemeral_5m_input_tokens: 0 }, 0, 4],
];

/** Reference rates, $/MTok: input, output, cache read. Writes: 1.25x (5m) and 2x (1h) input. */
const RATES: Record<string, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-haiku-4-5-20251001': [1, 5, 0.1],
  'claude-opus-4-5-20251101': [5, 25, 0.5],
  'claude-fable-5-1': [10, 50, 0.25],
};

const line = (r: (typeof REAL)[number]): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-08T18:00:00.000Z',
    message: { id: 'm', model: r[0], usage: { input_tokens: r[1], cache_creation_input_tokens: r[2], cache_creation: r[3], cache_read_input_tokens: r[4], output_tokens: r[5] } },
  });

describe('pricing, by hand', () => {
  it('prices real responses of every served model at its list rates', () => {
    for (const r of REAL) {
      const [inp, out, read] = RATES[r[0]];
      const want = (r[1] * inp + r[3].ephemeral_5m_input_tokens * inp * 1.25 + r[3].ephemeral_1h_input_tokens * inp * 2 + r[4] * read + r[5] * out) / 1e6;
      const p = parseLine(line(r))!;
      assert.equal(p.ttlKnown, true);
      const got = costOf(pricedModel(p.model, p.v[1] + p.v[2] + p.v[3] + p.v[4]), p.v);
      assert.ok(Math.abs(got - want) < 1e-9, `${r[0]}: ${got} vs ${want}`);
    }
    // Opus 5.5, worked out: 2x$4 + 91,464x$8 + 11,859x$0.20 + 357x$20 per MTok.
    assert.equal(Math.round(costOf('claude-opus-5-5', [1, 2, 0, 91464, 11859, 357]) * 1e6), 8 + 731712 + 2372 + 7140);
  });

  it('follows the reference table and its exceptions', () => {
    const row = (m: string) => {
      const q = priceOf(m).price;
      return [q.input, q.output, q.cacheRead, q.write5m, q.write1h];
    };
    assert.deepEqual(row('claude-opus-5-5'), [4, 20, 0.2, 5, 8]);
    for (const m of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-5-20251101']) {
      assert.deepEqual(row(m), [5, 25, 0.5, 6.25, 10], m);
    }
    assert.deepEqual(row('claude-sonnet-5'), [2, 10, 0.2, 2.5, 4]);
    assert.deepEqual(row('claude-sonnet-4-6'), [3, 15, 0.3, 3.75, 6]);
    assert.deepEqual(row('claude-haiku-4-5-20251001'), [1, 5, 0.1, 1.25, 2]);
    assert.deepEqual(row('claude-fable-5-1'), [10, 50, 0.25, 12.5, 20], 'Fable 5.1 reads at $0.25, not 10% of input');
    assert.deepEqual(row('claude-fable-5'), [10, 50, 1, 12.5, 20]);
    assert.equal(priceOf('claude-haiku-4-5-20251001').family, 'claude-haiku-4-5');
  });

  it('never prices an unknown model as something else', () => {
    assert.equal(priceOf('claude-nova-9').known, false);
    assert.equal(costOf('claude-nova-9', [1, 1e6, 1e6, 1e6, 1e6, 1e6]), 0);
    assert.deepEqual(priceTokens('opus', [1e6, 1e6, 1e6, 1e6]), [4, 8, 0.2, 20], 'an alias is priced as the model it serves');
    assert.equal(parseLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T18:00:00Z', message: { model: '<synthetic>', usage: { output_tokens: 5 } } })), null, '<synthetic> is not counted');
  });

  it('a total without its TTL split is flagged, for the seat TTL to decide', () => {
    const p = parseLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T18:00:00Z', message: { id: 'x', model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_creation_input_tokens: 100, output_tokens: 1 } } }))!;
    assert.equal(p.ttlKnown, false);
  });
});

const STATE = join(fileURLToPath(new URL('../state/', import.meta.url)), 'usage-history.json');

describe('pricing on the real history', { skip: !existsSync(STATE) && 'no state/usage-history.json' }, () => {
  it('sum by model = sum by seat = total', () => {
    const store = new UsageStore(STATE, Date.now, USAGE_ATTRIBUTION_REV);
    const byModel = Object.entries(store.totalsByModel()).reduce((s, [m, v]) => s + costOf(m, v), 0);
    const view = store.view({ scan: { running: false, backfilled: true, filesDone: 0, filesTotal: 0, lastScanAt: null }, seats: [] });
    let bySeat = 0;
    for (const rows of Object.values(view.daily)) for (const c of rows) bySeat += c[4] + c[5] + c[6] + c[7];
    const cells = Object.values(view.daily).reduce((n, r) => n + r.length, 0);
    // Cells are rounded to 1e-5 $: allow that much per cell.
    assert.ok(Math.abs(byModel - bySeat) <= cells * 1e-5 + 1e-6, `${byModel} vs ${bySeat}`);
    const listed = view.models.reduce((s, m) => s + m.cost, 0);
    assert.ok(Math.abs(listed - byModel) <= view.models.length * 0.005 + 1e-6, `models list ${listed} vs ${byModel}`);
  });
});

describe('advisor iterations (Fable advising the model)', () => {
  // A real response with the advisor on (2026-10-09): the top-level usage is the
  // sum of the two "message" iterations; the advisor iteration comes on top.
  const usage = {
    input_tokens: 4, cache_creation_input_tokens: 13589, cache_read_input_tokens: 19630, output_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 255, ephemeral_1h_input_tokens: 13334 },
    iterations: [
      { input_tokens: 2, output_tokens: 26, cache_read_input_tokens: 3148, cache_creation_input_tokens: 13334, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 13334 }, type: 'message' },
      { input_tokens: 18062, output_tokens: 310, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, type: 'advisor_message', model: 'claude-fable-5-1' },
      { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 16482, cache_creation_input_tokens: 255, cache_creation: { ephemeral_5m_input_tokens: 255, ephemeral_1h_input_tokens: 0 }, type: 'message' },
    ],
  };
  const raw = JSON.stringify({ type: 'assistant', timestamp: '2026-10-09T02:51:20Z', message: { id: 'adv', model: 'claude-opus-5-5', usage } });

  it('counts the advisor once, at the Fable 5.1 price, on top of the top-level usage', () => {
    const p = parseLine(raw)!;
    assert.deepEqual(p.v, [1, 4, 255, 13334, 19630, 30], 'top level = the message iterations');
    assert.deepEqual(p.advisor, [{ model: 'claude-fable-5-1', v: [0, 18062, 0, 0, 0, 310] }]);
    const fable = costOf(p.advisor[0].model + '@advisor', p.advisor[0].v);
    assert.ok(Math.abs(fable - (18062 * 10 + 310 * 50) / 1e6) < 1e-12, 'Fable 5.1: $10 in, $50 out');
    const opus = costOf('claude-opus-5-5', p.v);
    assert.ok(Math.abs(opus - (4 * 4 + 255 * 5 + 13334 * 8 + 19630 * 0.2 + 30 * 20) / 1e6) < 1e-12);
  });

  it('a response without iterations has no advisor part', () => {
    assert.deepEqual(parseLine(line(REAL[0]))!.advisor, []);
  });
});
