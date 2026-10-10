/**
 * The Seats / Usage payload (usage/seatsUsage.ts) on a fully known pool:
 * aggregates that add up (unknown seat and advisor included), plan weights,
 * per-thread and per-agent cost, burn / ETA from the sampled quota, the
 * subscription multiple, throughput, and the cold-cache / compaction journal.
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { dayOf } from '../src/usage/history.js';
import { coldCost, UsageJournal } from '../src/usage/journal.js';
import { DEFAULT_PLAN_WEIGHTS, resolvePlanWeights, subscriptionOf, valueMultiple, weightedPct } from '../src/usage/planWeights.js';
import { costOf, PLANS, priceOf } from '../src/usage/pricing.js';
import { seatBurn } from '../src/usage/seatBurn.js';
import { cellTokens, cellUsd } from '../src/usage/seatsUsage.js';
import { ServedStats } from '../src/usage/served.js';
import { throughputSince } from '../src/usage/throughput.js';
import { fixture, H, NOW, OPUS, SONNET, THREAD_A, THREAD_B, v, view } from './seatsUsageFixture.js';

const close = (a: number, b: number, what: string, eps = 1e-3): void => {
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);
};
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// What the fixture spent today, priced the way the store prices it.
const A1 = costOf(OPUS, v(1, 100, 40_000, 0, 2000));
const A2 = costOf(OPUS, v(1, 50, 1000, 39_000, 1500));
const ADV = costOf(`${OPUS}@advisor`, v(1, 2000, 0, 0, 300));
const B1 = costOf(SONNET, v(3, 300, 5000, 20_000, 3000));
const UNKNOWN = costOf(OPUS, v(2, 1000, 0, 0, 500));

describe('seats usage: aggregates', () => {
  it('today adds up over seats, unknown seat included', () => {
    const u = view();
    const today = u.daily.find((r) => r.d === dayOf(NOW))!;
    assert.ok(today, 'a row for today');
    assert.ok(today.seat.unknown, 'the before-tracking spend keeps its own (hidden) series');
    close(cellUsd(today.tot), sum(Object.values(today.seat).map(cellUsd)), 'seat $ add up');
    close(cellTokens(today.tot), sum(Object.values(today.seat).map(cellTokens)), 'seat tokens add up', 0);
    close(cellUsd(today.tot), sum(Object.values(today.model).map(cellUsd)), 'model $ add up');
    close(cellUsd(today.tot), A1 + A2 + ADV + B1 + UNKNOWN, 'total = every priced response of today');
    assert.equal(u.daily.length, 2, 'yesterday on the last resort is its own day');
  });

  it('advisor tokens stay apart from the served model split', () => {
    const today = view().daily.find((r) => r.d === dayOf(NOW))!;
    assert.equal(today.tot[10], 2300);
    assert.equal(today.tot[0], 1000 + 100 + 50 + 300, 'input excludes the advisor');
    close(today.tot[11], ADV, 'advisor $');
  });

  it('hourly rows of today sum to the daily row', () => {
    const u = view();
    const today = u.daily.find((r) => r.d === dayOf(NOW))!;
    const hours = u.hourly.filter((r) => r.t >= u.day0);
    close(sum(hours.map((r) => cellUsd(r.tot))), cellUsd(today.tot), 'hours $ = day $');
    assert.ok(u.hourly.every((r) => r.t <= NOW));
  });

  it('seats: plan weight, last resort, live threads, today spend and sparkline', () => {
    const u = view();
    const [s1, s2, fab] = u.seats;
    assert.deepEqual([s1.weight, s2.weight, fab.weight], [1, 5, 20]);
    assert.deepEqual([s1.plan, s2.plan, fab.plan], ['STD', 'PRM', 'MAX']);
    assert.equal(fab.org, 'perso');
    assert.equal(s1.org, 'team');
    assert.deepEqual(s1.five, { pct: 50, resetsAt: NOW + 2 * H });
    assert.deepEqual(s1.week, { pct: 30, resetsAt: NOW + 3 * 24 * H });
    assert.equal(s2.week, null, 'no weekly quota reported: null, never 0');
    assert.deepEqual(s1.threads.map((t) => [t.agent, t.busy]), [['dev', true], ['testeur', false]]);
    close(s1.todayUsd, A1 + A2 + ADV, 's1 today $', 0.01);
    assert.equal(s1.spark.length, 24);
    close(sum(s1.spark), A1 + A2 + ADV, 's1 sparkline', 0.02);
    assert.equal(u.next?.id, 's1');
  });

  it('burn and ETA come from the sampled quota, average as fallback', () => {
    const [s1, s2, fab] = view().seats;
    // 30% an hour ago → 50% now (the last reading is older than a minute: "now" is added).
    const slope = 20;
    close(s1.burn!, slope, 's1 burn', 0.05);
    assert.equal(s1.burnBasis, 'samples');
    close(s1.eta!, ((100 - 50) / slope) * H, 's1 eta', 60_000);
    assert.equal(s2.burn, 0, 'flat readings: not burning');
    assert.equal(s2.eta, null);
    assert.equal(fab.burnBasis, 'average');
    close(fab.burn!, 5 / 4, 'fab average over the 4 elapsed hours (rounded to 0.1)', 0.051);
  });
});

describe('seats usage: per-thread cost', () => {
  it('a thread costs what its responses cost, advisor included', () => {
    const u = view();
    const a = u.convs.find((c) => c.key === THREAD_A)!;
    const b = u.convs.find((c) => c.key === THREAD_B)!;
    close(a.p.today[2], A1 + A2 + ADV, 'thread A $');
    assert.equal(a.p.today[0], 3, 'thread A requests');
    assert.equal(a.title, 'Seats redesign');
    assert.deepEqual(a.seats, { s1: 3 });
    assert.equal(a.cold, 1);
    assert.equal(a.coldTok, 40_000);
    close(b.p.today[2], B1, 'thread B $');
    assert.equal(b.agent, 'testeur');
    assert.equal(b.title, 'conv-bbbb-2222', 'no title: the conversation id');
  });

  it('agents and the attributed share; spend before tracking stays in the totals', () => {
    const u = view();
    const dev = u.agents.find((x) => x.name === 'dev')!;
    close(dev.p.today[0], A1 + A2 + ADV, 'dev $');
    assert.equal(dev.p.today[2], 1, 'dev threads');
    close(u.attributed.today, A1 + A2 + ADV + B1, 'attributed', 0.01);
    const today = u.daily.find((r) => r.d === dayOf(NOW))!;
    assert.ok(cellUsd(today.tot) - u.attributed.today >= UNKNOWN - 0.01, 'unattributed spend kept in the total');
  });

  it('periods: the 5h window excludes the older spend', () => {
    const u = view();
    const a = u.convs.find((c) => c.key === THREAD_A)!;
    close(a.p['5h'][2], A1 + A2 + ADV, '5h covers the last 2h');
    close(a.p.all[2], a.p.today[2], 'lifetime = today here');
  });
});

describe('plan weights and the subscription multiple', () => {
  it('defaults STD 1, PRM 5, MAX 20; config overrides; bad values keep the default', () => {
    assert.deepEqual(resolvePlanWeights(undefined), { ...DEFAULT_PLAN_WEIGHTS, MAX5: 5 });
    const w = resolvePlanWeights({ planWeightStandard: '2', planWeightPremium: 8, planWeightMax: 40 });
    assert.deepEqual([w.STD, w.PRM, w.MAX, w.MAX5, w.PRO], [2, 8, 40, 10, 2]);
    const bad = resolvePlanWeights({ planWeightStandard: -1, planWeightPremium: 'x', planWeightMax: 0 });
    assert.deepEqual([bad.STD, bad.PRM, bad.MAX], [1, 5, 20]);
  });

  it('weighted utilisation over the reporting seats only', () => {
    const r = weightedPct([
      { pct: 50, weight: 1 },
      { pct: 20, weight: 5 },
      { pct: null, weight: 20 },
    ]);
    assert.equal(r.pct, 25);
    assert.equal(r.reporting, 2);
    close(r.share, 6 / 26, 'share');
    assert.equal(weightedPct([{ pct: null, weight: 1 }]).pct, null);
  });

  it('the multiple divides by the plan prices over the same period', () => {
    const u = view();
    assert.equal(u.subscription.monthlyUsd, PLANS.teamStandard.monthlyUsd + PLANS.teamPremium.monthlyUsd + PLANS.max20x.monthlyUsd);
    const sub = subscriptionOf([PLANS.teamStandard, PLANS.teamStandard]);
    close(valueMultiple(50, sub, 1)!, 50 / ((2 * 25) / 30.4), 'one day');
    close(valueMultiple(50, sub, 7)!, 50 / ((7 * 2 * 25) / 30.4), 'seven days');
    assert.equal(valueMultiple(50, subscriptionOf([null]), 1), null);
  });
});

describe('throughput', () => {
  it('counts every response by minute: average and peak', () => {
    const { store } = fixture();
    const t = throughputSince(store.minutes, NOW - 5 * H, NOW);
    const tok = 1000 + 500 + (100 + 40_000 + 2000) + (50 + 1000 + 39_000 + 1500) + (300 + 5000 + 20_000 + 3000) + 2300;
    assert.equal(t.tokens, tok);
    close(t.avgPerSec, tok / (5 * 3600), 'avg');
    close(t.peakPerSec, (2300 + 41_550) / 60, 'peak minute (the advisor shares it)');
    assert.equal(t.peakAt, Math.floor((NOW - H) / 60_000) * 60_000);
    assert.equal(view().perMin.length, 60);
  });
});

describe('cold-cache and compaction journal', () => {
  const tmp = (): string => join(mkdtempSync(join(tmpdir(), 'usage-journal-')), 'usage-journal.jsonl');

  it('coldCost: the write at its TTL rate, and its premium over a warm read', () => {
    const { price } = priceOf(OPUS);
    const c = coldCost(OPUS, 1_000_000, 3_600_000);
    close(c.usd, price.write1h, '1h write');
    close(c.wasted, price.write1h - price.cacheRead, 'premium');
    close(coldCost(OPUS, 1_000_000, 300_000).usd, price.write5m, '5m write');
  });

  it('a cold served request is journaled with its seat, thread and cost, and survives a reload', () => {
    const path = tmp();
    const journal = new UsageJournal(path);
    const stats = new ServedStats(join(path, '..', 'served.json'), journal, () => NOW);
    stats.record({ at: NOW - 60_000, thread: THREAD_A, seat: 's1', model: OPUS, mode: 'resume', coldReason: 'ttl expired', cacheWrite: 50_000, cacheTtlMs: 3_600_000, prompt: 52_000 });
    stats.record({ at: NOW - 30_000, thread: THREAD_A, seat: 's1', model: OPUS, mode: 'resume', cacheWrite: 800, prompt: 53_000 });
    stats.stop();
    const cold = journal.since(0, 'cold');
    assert.equal(cold.length, 1, 'a warm request is no incident');
    const e = cold[0];
    assert.deepEqual([e.seat, e.thread, e.conv, e.agent, e.tok, e.reason], ['s1', THREAD_A, 'conv-aaaa-1111', 'dev', 50_000, 'ttl expired']);
    assert.deepEqual({ usd: e.usd, wasted: e.wasted }, coldCost(OPUS, 50_000, 3_600_000));

    appendFileSync(path, '{"kind":"cold","at":'); // a torn last line
    const again = new UsageJournal(path);
    assert.deepEqual(again.since(0, 'cold'), cold);
    assert.equal(again.size, 1);
    assert.equal(again.since(NOW, 'cold').length, 0, 'since() filters by time');
  });

  it('a host compaction: same thread, fresh session, a much smaller prompt', () => {
    const path = tmp();
    const journal = new UsageJournal(path);
    const stats = new ServedStats(join(path, '..', 'served.json'), journal, () => NOW);
    stats.record({ at: NOW - 120_000, thread: THREAD_B, seat: 's2', model: SONNET, mode: 'resume', cacheWrite: 0, prompt: 150_000 });
    stats.record({ at: NOW - 60_000, thread: THREAD_B, seat: 's2', model: SONNET, mode: 'fresh', cacheWrite: 30_000, prompt: 30_000 });
    // A small thread starting over is no compaction.
    stats.record({ at: NOW - 50_000, thread: THREAD_A, seat: 's1', model: OPUS, mode: 'resume', cacheWrite: 0, prompt: 10_000 });
    stats.record({ at: NOW - 40_000, thread: THREAD_A, seat: 's1', model: OPUS, mode: 'fresh', cacheWrite: 2_000, prompt: 2_000 });
    stats.recordCompaction({ at: NOW - 10_000, thread: THREAD_A, conv: 'conv-aaaa-1111', agent: 'dev', seat: 's1', before: 160_000, after: 30_000, trigger: 'auto' });
    stats.stop();
    const comp = journal.since(0, 'compaction');
    assert.deepEqual(
      comp.map((c) => [c.thread, c.trigger, c.before, c.after]),
      [
        [THREAD_A, 'auto', 160_000, 30_000],
        [THREAD_B, 'host', 150_000, 30_000],
      ],
    );
    assert.deepEqual(new UsageJournal(path).since(0, 'compaction'), comp, 'full history kept on disk');
  });

  it('the burn of a seat with no reading at all is the window average', () => {
    const b = seatBurn({ pct: 40, resetsAt: NOW + 3 * H }, [], NOW);
    assert.equal(b.basis, 'average');
    close(b.perHour!, 20, '40% over 2h');
    close(b.etaMs!, 3 * H, '60% left at 20%/h');
    assert.deepEqual(seatBurn(null, [], NOW), { perHour: null, etaMs: null, basis: null });
  });
});
