/**
 * A small, fully known pool for the Seats / Usage tests: three seats (Team
 * standard, Team premium, a Max 20x last resort), spend on each, spend with
 * no seat ("unknown", from before tracking), an advisor call, two threads and
 * a cold-cache event. Shared by the aggregation and the page tests.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sample } from '../src/usage/capacity.js';
import { UsageStore } from '../src/usage/history.js';
import type { ColdEvent, CompactionEvent } from '../src/usage/journal.js';
import { DEFAULT_PLAN_WEIGHTS } from '../src/usage/planWeights.js';
import { PLANS, type Vec } from '../src/usage/pricing.js';
import { buildSeatsUsage, type BuildInput, type SeatSource } from '../src/usage/seatsUsage.js';
import { threadOfKey } from '../src/usage/threadLedger.js';

/** 2026-10-10 14:30 local time: mid-afternoon, so "today" spans several hours. */
export const NOW = new Date(2026, 9, 10, 14, 30, 0).getTime();
export const H = 3_600_000;

export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-4-5';

export const THREAD_A = 'conv-aaaa-1111|dev|main';
export const THREAD_B = 'conv-bbbb-2222|testeur|main';

/** [requests, input, write5m, write1h, cacheRead, output] */
export const v = (req: number, input: number, w1h: number, read: number, out: number): Vec => [req, input, 0, w1h, read, out];

export function seat(over: Partial<SeatSource> & Pick<SeatSource, 'id' | 'label'>): SeatSource {
  return {
    enabled: true,
    auth: 'oauth',
    lastResort: false,
    plan: PLANS.teamStandard,
    advisor: null,
    windows: [],
    requests: 0,
    inFlight: 0,
    lastUsedAt: null,
    exhaustedUntil: null,
    throttledUntil: null,
    status: 'ok',
    statusDetail: null,
    lastError: null,
    email: null,
    ...over,
  };
}

export const SEATS: SeatSource[] = [
  seat({
    id: 's1',
    label: 'Team one',
    windows: [
      { key: 'five_hour', percent: 50, resetsAt: NOW + 2 * H },
      { key: 'seven_day', percent: 30, resetsAt: NOW + 3 * 24 * H },
    ],
    requests: 12,
    inFlight: 1,
  }),
  seat({ id: 's2', label: 'Team two', plan: PLANS.teamPremium, windows: [{ key: 'five_hour', percent: 20, resetsAt: NOW + 4 * H }] }),
  seat({ id: 'fab', label: 'fabrisek', plan: PLANS.max20x, lastResort: true, windows: [{ key: 'five_hour', percent: 5, resetsAt: NOW + 1 * H }] }),
];

export type Fixture = { store: UsageStore; input: BuildInput; cold: ColdEvent[]; compactions: CompactionEvent[] };

export function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'seats-usage-'));
  const store = new UsageStore(join(dir, 'usage-history.json'), () => NOW, 5);
  // Before tracking: no seat, no thread. Hidden as a series, kept in totals.
  store.add(NOW - 3 * H, 'unknown', OPUS, 'unknown', v(2, 1000, 0, 0, 500));
  // Thread A on s1 (two calls, one with a cold cache rewrite), thread B on s2.
  store.add(NOW - 2 * H, 's1', OPUS, 'dev', v(1, 100, 40_000, 0, 2000), threadOfKey(THREAD_A));
  store.add(NOW - 1 * H, 's1', OPUS, 'dev', v(1, 50, 1000, 39_000, 1500), threadOfKey(THREAD_A));
  store.add(NOW - 30 * 60_000, 's2', SONNET, 'testeur', v(3, 300, 5000, 20_000, 3000), threadOfKey(THREAD_B));
  // An advisor call served by s1, and yesterday's spend on the last resort.
  store.add(NOW - 1 * H, 's1', `${OPUS}@advisor`, 'dev', v(1, 2000, 0, 0, 300), threadOfKey(THREAD_A));
  store.add(NOW - 26 * H, 'fab', OPUS, 'dev', v(1, 500, 0, 0, 800));

  const cold: ColdEvent[] = [
    { kind: 'cold', at: NOW - 2 * H, seat: 's1', thread: THREAD_A, conv: 'conv-aaaa-1111', agent: 'dev', model: OPUS, tok: 40_000, usd: 0.4, wasted: 0.36, reason: 'ttl expired' },
  ];
  const compactions: CompactionEvent[] = [
    { kind: 'compaction', at: NOW - 90 * 60_000, seat: 's1', thread: THREAD_A, conv: 'conv-aaaa-1111', agent: 'dev', before: 180_000, after: 40_000, trigger: 'auto' },
  ];
  const samples: Record<string, Sample[]> = {
    s1: [
      [NOW - 60 * 60_000, 30],
      [NOW - 30 * 60_000, 40],
      [NOW - 2 * 60_000, 50],
    ],
    s2: [[NOW - 40 * 60_000, 20]],
  };
  const input: BuildInput = {
    now: NOW,
    store,
    seats: SEATS,
    cold,
    compactions,
    coldTotal: cold.length,
    modesToday: { resume: 5, fresh: 1 },
    threadInfo: (k) => (k === THREAD_A ? { title: 'Seats redesign', agent: 'dev', conv: 'conv-aaaa-1111', ctx: 42_000, at: NOW - H } : undefined),
    liveThreads: [
      { key: THREAD_A, seat: 's1', agent: 'dev', title: 'Seats redesign', ctx: 42_000, at: NOW - 60_000, busy: true },
      { key: THREAD_B, seat: 's1', agent: 'testeur', at: NOW - 5 * 60_000, busy: false },
    ],
    samples: (s, _w, from) => (samples[s] ?? []).filter((x) => x[0] >= from),
    resets: [],
    weights: DEFAULT_PLAN_WEIGHTS,
    nextId: 's1',
    hourSpan: 72,
  };
  return { store, input, cold, compactions };
}

export function view(f: Fixture = fixture()) {
  return buildSeatsUsage(f.input);
}
