/**
 * Token history: bucket aggregation, retention, and the transcript import
 * (scope, sub-agents, duplicate lines, idempotence across restarts).
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { HOUR_MS, KEEP_DAYS, KEEP_HOURS, UsageStore, dayOf } from '../src/usage/history.js';
import { costOf, priceOf } from '../src/usage/pricing.js';
import { TranscriptScanner, agentOfCwd, isAlfredDir, parseLine } from '../src/usage/transcripts.js';

const NOW = Date.UTC(2026, 9, 8, 15, 30);
const tmp = mkdtempSync(join(tmpdir(), 'alfred-usage-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshPath = (): string => join(tmp, `store-${++n}.json`);

function line(o: { id: string; at: number; model?: string; cwd?: string; input?: number; w?: number; w1h?: number; read?: number; out?: number; type?: string }): string {
  return (
    JSON.stringify({
      type: o.type ?? 'assistant',
      timestamp: new Date(o.at).toISOString(),
      cwd: o.cwd ?? 'C:\\Users\\u\\Documents\\alfred-data\\agents\\alfred\\workspace',
      requestId: 'req_' + o.id,
      message: {
        id: o.id,
        model: o.model ?? 'claude-opus-5-5',
        usage: {
          input_tokens: o.input ?? 2,
          cache_creation_input_tokens: o.w ?? 0,
          cache_read_input_tokens: o.read ?? 0,
          output_tokens: o.out ?? 10,
          ...(o.w1h !== undefined ? { cache_creation: { ephemeral_1h_input_tokens: o.w1h, ephemeral_5m_input_tokens: (o.w ?? 0) - o.w1h } } : {}),
        },
      },
    }) + '\n'
  );
}

describe('UsageStore', () => {
  it('sums into hourly and daily buckets per seat, and prices by model', () => {
    const s = new UsageStore(freshPath(), () => NOW);
    s.add(NOW - 10 * 60_000, 'a', 'claude-opus-5-5', 'alfred', [1, 10, 100, 0, 1000, 50]);
    s.add(NOW - 5 * 60_000, 'a', 'claude-opus-5-5', 'alfred', [1, 10, 0, 200, 1000, 50]);
    s.add(NOW - 3 * HOUR_MS, 'b', 'claude-sonnet-5', '', [1, 1, 0, 0, 0, 5]);
    const v = s.view({ scan: { running: false, backfilled: true, filesDone: 0, filesTotal: 0, lastScanAt: null }, seats: [{ id: 'b', label: 'Bee' }, { id: 'a', label: 'Ay' }] });
    assert.deepEqual(v.accounts, [{ id: 'b', label: 'Bee' }, { id: 'a', label: 'Ay' }], 'seat order');
    assert.equal(v.days[v.days.length - 1], dayOf(NOW));
    const today = v.daily.a[v.days.length - 1];
    assert.deepEqual(today.slice(0, 4), [20, 300, 2000, 100], 'input, cache write (5m + 1h), cache read, output');
    assert.equal(today[8], 2, 'requests');
    // Opus 5.5: $4 in, 5m write 1.25x, 1h write 2x, read $0.20, out $20 per MTok.
    assert.ok(Math.abs(today[5] - (100 * 4 * 1.25 + 200 * 4 * 2) / 1e6) < 1e-4);
    assert.ok(Math.abs(today[7] - (100 * 20) / 1e6) < 1e-4);
    assert.equal(v.hours.length, 48);
    const last = v.hourly.a[47];
    assert.deepEqual(last.slice(0, 4), [20, 300, 2000, 100], 'both in the current hour');
    assert.deepEqual(v.hourly.b[44].slice(0, 4), [1, 0, 0, 5], 'three hours back');
    assert.equal(v.models[0].model, 'claude-opus-5-5');
  });

  it('keeps hours 35 days and days ~2 years, and ignores what is older', () => {
    let now = NOW;
    const path = freshPath();
    const s = new UsageStore(path, () => now);
    s.add(NOW - 2 * HOUR_MS, 'a', 'm', '', [1, 1, 0, 0, 0, 1]);
    s.add(NOW - (KEEP_HOURS + 5) * HOUR_MS, 'a', 'm', '', [1, 2, 0, 0, 0, 2]);
    s.add(NOW - (KEEP_DAYS + 3) * 24 * HOUR_MS, 'a', 'm', '', [1, 4, 0, 0, 0, 4]);
    assert.equal(s.hourCount(), 1, 'an hour past 35 days goes to the day bucket only');
    assert.equal(s.totalsByAccount().a[0], 2, 'past the day retention: not stored');
    // 40 days later the recent hour is gone, its day stays.
    now = NOW + 40 * 24 * HOUR_MS;
    s.add(now, 'a', 'm', '', [1, 1, 0, 0, 0, 1]);
    s.save();
    const back = new UsageStore(path, () => now);
    assert.equal(back.hourCount(), 1);
    assert.equal(back.totalsByAccount().a[0], 3);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { days: Record<string, unknown> };
    assert.ok(raw.days[dayOf(NOW - 2 * HOUR_MS)], 'the old day is still there');
  });

  it('the panel view is the same after a reload', () => {
    const path = freshPath();
    const s = new UsageStore(path, () => NOW);
    s.add(NOW - HOUR_MS, 'a', 'claude-haiku-4-5', 'x', [1, 1, 2, 3, 4, 5]);
    s.save();
    const scan = { running: false, backfilled: true, filesDone: 0, filesTotal: 0, lastScanAt: null };
    const a = s.view({ scan, seats: [] });
    const b = new UsageStore(path, () => NOW).view({ scan, seats: [] });
    assert.deepEqual({ ...b, version: 0, generatedAt: 0 }, { ...a, version: 0, generatedAt: 0 });
  });
});

describe('pricing', () => {
  it('knows the current models and flags the others', () => {
    // platform.claude.com pricing table: base input, 5m write, 1h write, cache hit, output.
    assert.deepEqual(priceOf('claude-opus-5-5').price, { input: 4, write5m: 5, write1h: 8, cacheRead: 0.2, output: 20 });
    assert.deepEqual(priceOf('claude-opus-4-5-20251101').price, { input: 5, write5m: 6.25, write1h: 10, cacheRead: 0.5, output: 25 });
    assert.equal(priceOf('claude-sonnet-5-5').price.cacheRead, 0.1);
    assert.equal(priceOf('claude-haiku-5-5@long').price.input, 0.5);
    assert.equal(priceOf('claude-haiku-5-5').price.input, 0.1);
    assert.equal(priceOf('claude-opus-5').price.input, 5);
    assert.equal(priceOf('claude-haiku-4-5-20251001').price.input, 1);
    assert.equal(priceOf('claude-fable-5-1').price.cacheRead, 0.25);
    assert.equal(priceOf('claude-fable-5').price.cacheRead, 1);
    assert.equal(priceOf('gpt-x').known, false);
    assert.ok(Math.abs(costOf('claude-sonnet-5', [1, 1e6, 0, 0, 1e6, 1e6]) - (2 + 0.2 + 10)) < 1e-9);
  });
});

describe('transcript lines', () => {
  it('splits the cache write by TTL and skips lines without usage', () => {
    const p = parseLine(line({ id: 'm1', at: NOW, w: 300, w1h: 200, read: 7, out: 9 }).trim())!;
    assert.deepEqual(p.v, [1, 2, 100, 200, 7, 9]);
    assert.equal(parseLine(line({ id: 'm2', at: NOW, model: '<synthetic>' }).trim()), null);
    assert.equal(parseLine(line({ id: 'm3', at: NOW, type: 'user' }).trim()), null);
    assert.equal(parseLine('{"type":"assistant","usage" broken'), null);
  });

  it('tells Alfred dirs and agents apart', () => {
    assert.ok(isAlfredDir('C--Users-fabri-Documents-alfred-agent-apps-gateway'));
    assert.ok(isAlfredDir('C--Users-fabri-Documents-alfred-data-agents-cli-tester-workspace'));
    assert.ok(isAlfredDir('C--Users-fabri-AppData-Local-Temp-alfred-live-cli-CTb7eo-agents-dev-workspace'));
    assert.ok(!isAlfredDir('c--Users-fabri'));
    assert.ok(!isAlfredDir('c--Users-fabri-Documents-SightPrice'));
    assert.ok(!isAlfredDir('C--Users-fabri-Documents-alfred-data-plugins-alfred-plugin-claudecode'));
    assert.equal(agentOfCwd('C:\\Users\\u\\Documents\\alfred-data\\agents\\lecteur\\workspace'), 'lecteur');
    assert.equal(agentOfCwd('C:\\Users\\u\\Documents\\alfred-agent\\apps\\gateway'), 'engine');
    assert.equal(agentOfCwd('C:\\Users\\u\\Documents\\SightPrice'), '');
  });
});

describe('TranscriptScanner', () => {
  const root = join(tmp, 'projects');
  const alfredDir = join(root, 'C--Users-u-Documents-alfred-data-agents-alfred-workspace');
  const gatewayDir = join(root, 'C--Users-u-Documents-alfred-agent-apps-gateway');
  const personalDir = join(root, 'c--Users-u');
  const otherDir = join(root, 'C--Users-u-Documents-Project');
  mkdirSync(join(alfredDir, 's1', 'subagents'), { recursive: true });
  mkdirSync(gatewayDir, { recursive: true });
  mkdirSync(personalDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const sessions: Record<string, string> = { s1: 'seat-a', s9: 'seat-b' };
  const T = NOW - 2 * HOUR_MS;

  // Main session: one response written once per content block (same id, output grows), one more.
  writeFileSync(join(alfredDir, 's1.jsonl'), line({ id: 'r1', at: T, w: 1000, out: 5 }) + line({ id: 'r1', at: T, w: 1000, out: 40 }) + line({ id: 'r2', at: T + 1000, read: 1000, out: 20 }) + '{"type":"user"}\n');
  writeFileSync(join(alfredDir, 's1', 'subagents', 'agent-x.jsonl'), line({ id: 'r3', at: T + 2000, model: 'claude-haiku-4-5-20251001', input: 50, out: 7 }));
  writeFileSync(join(gatewayDir, 'g1.jsonl'), line({ id: 'r4', at: T, cwd: 'C:\\Users\\u\\Documents\\alfred-agent\\apps\\gateway', out: 3 }));
  writeFileSync(join(personalDir, 'p1.jsonl'), line({ id: 'r5', at: T, cwd: 'C:\\Users\\u', out: 999 }));
  // A claude_code_run session in a project dir: counted because the plugin recorded it.
  writeFileSync(join(otherDir, 's9.jsonl'), line({ id: 'r6', at: T, cwd: 'C:\\Users\\u\\Documents\\Project', out: 11 }));
  writeFileSync(join(otherDir, 'own.jsonl'), line({ id: 'r7', at: T, cwd: 'C:\\Users\\u\\Documents\\Project', out: 999 }));

  const make = (path: string) => {
    const store = new UsageStore(path, () => NOW);
    const scanner = new TranscriptScanner({ store, roots: () => [root, root], accountOf: (sid) => sessions[sid], now: () => NOW });
    return { store, scanner };
  };
  const statePath = join(tmp, 'scan-state.json');

  it('imports Alfred sessions and their sub-agents, not the user\u2019s own', async () => {
    const { store, scanner } = make(statePath);
    await scanner.scan();
    const t = store.totalsByAccount();
    // r1's cache write has no TTL split: it is a 1h write, the TTL Claude Code uses.
    assert.deepEqual(t['seat-a'], [3, 2 + 2 + 50, 0, 1000, 1000, 40 + 20 + 7], 'r1 once with its final output, r2, sub-agent r3');
    assert.deepEqual(t.unknown, [1, 2, 0, 0, 0, 3], 'gateway session: no seat recorded');
    assert.deepEqual(t['seat-b'], [1, 2, 0, 0, 0, 11]);
    assert.equal(Object.keys(t).length, 3, 'personal sessions left out');
    assert.equal(scanner.status.backfilled, true);
    assert.equal(scanner.status.filesTotal, 4);
  });

  it('is idempotent: a second pass and a restart count nothing again', async () => {
    const first = make(statePath);
    await first.scanner.scan();
    const before = JSON.stringify(first.store.totalsByAccount());
    const restarted = make(statePath);
    await restarted.scanner.scan();
    assert.equal(JSON.stringify(restarted.store.totalsByAccount()), before);
  });

  it('reads only what was appended, and waits for a line to be complete', async () => {
    const path = join(alfredDir, 's1.jsonl');
    const extra = line({ id: 'r8', at: T + 5000, out: 100 });
    appendFileSync(path, extra.slice(0, 40));
    const a = make(statePath);
    await a.scanner.scan();
    assert.equal(a.store.totalsByAccount()['seat-a'][5], 67, 'half a line: not counted yet');
    appendFileSync(path, extra.slice(40));
    // The same response again (next content block): only its growth counts.
    appendFileSync(path, line({ id: 'r8', at: T + 5000, out: 130 }));
    const b = make(statePath);
    await b.scanner.scan();
    assert.equal(b.store.totalsByAccount()['seat-a'][5], 67 + 130);
    assert.equal(b.store.totalsByAccount()['seat-a'][0], 4);
  });

  it('a file that leaves the scope keeps its offset', async () => {
    delete sessions.s9;
    const a = make(statePath);
    await a.scanner.scan();
    sessions.s9 = 'seat-b';
    const b = make(statePath);
    await b.scanner.scan();
    assert.deepEqual(b.store.totalsByAccount()['seat-b'], [1, 2, 0, 0, 0, 11], 'not counted twice when it comes back');
  });
});

describe('per-turn API $', () => {
  it('prices the four posts of a turn on the served model, cache writes at the 1h rate', async () => {
    const { priceTokens, planOf } = await import('../src/usage/pricing.js');
    assert.deepEqual(priceTokens('claude-opus-5-5', [1e6, 1e6, 1e6, 1e6]), [4, 8, 0.2, 20]);
    assert.deepEqual(priceTokens('claude-opus-5-5', [0, 1e6, 0, 0], '5m'), [0, 5, 0, 0]);
    const { runItem } = await import('../src/webview/activity.js');
    const item = runItem({
      id: 'r', request: { cwd: 'C:/x', prompt: 'p', model: 'claude-sonnet-5' }, status: 'done', startedAt: NOW, endedAt: NOW + 1,
      report: { durationMs: 1, tokens: { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, costUsd: 0 } },
    } as never, NOW + 2)!;
    assert.deepEqual(item.tokens, [1e6, 0, 1e6, 1e6]);
    assert.deepEqual(item.cost, [2, 0, 0.2, 10]);
    assert.equal(planOf({ subscriptionType: 'team', rateLimitTier: 'default_raven', seatTier: 'team_standard' })?.monthlyUsd, 25);
    assert.equal(planOf({ subscriptionType: 'team', rateLimitTier: 'default_claude_max_5x', seatTier: 'team_tier_1' })?.label, 'Team premium');
    assert.equal(planOf({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })?.monthlyUsd, 200);
    assert.equal(planOf({ subscriptionType: 'enterprise' }), null);
  });
});

describe('seat attribution from the transcript login', () => {
  const ctxLine = (email: string) =>
    JSON.stringify({ type: 'attachment', attachment: { type: 'session_context', context: { userEmail: `The user's email address is ${email}. Use it only to identify the user.` } } }) + '\n';

  it('bills each response to the login reported before it, sub-agents included', async () => {
    const { sessionEmail } = await import('../src/usage/transcripts.js');
    assert.equal(sessionEmail(ctxLine('Seat-B@Example.com').trim()), 'seat-b@example.com');
    assert.equal(sessionEmail('{"type":"assistant"}'), undefined);
    const root = join(tmp, 'projects-email');
    const dir = join(root, 'C--Users-u-Documents-alfred-agent-apps-gateway');
    mkdirSync(join(dir, 'g1', 'subagents'), { recursive: true });
    const T = NOW - HOUR_MS;
    writeFileSync(
      join(dir, 'g1.jsonl'),
      ctxLine('a@example.com') + line({ id: 'x1', at: T, out: 10 }) + ctxLine('b@example.com') + line({ id: 'x2', at: T, out: 20 }),
    );
    writeFileSync(join(dir, 'g1', 'subagents', 'agent-1.jsonl'), line({ id: 'x3', at: T, out: 40 }));
    // Two seats on one login: the recorded seat of the session decides between them.
    writeFileSync(join(dir, 'g2.jsonl'), ctxLine('twin@example.com') + line({ id: 'x4', at: T, out: 80 }));
    const emails: Record<string, string[]> = { 'a@example.com': ['seat-a'], 'b@example.com': ['seat-b'], 'twin@example.com': ['t1', 't2'] };
    const path = join(tmp, 'email-state.json');
    const run = async () => {
      const store = new UsageStore(path, () => NOW);
      await new TranscriptScanner({ store, roots: () => [root], accountOf: (sid) => (sid === 'g2' ? 't2' : undefined), accountsOfEmail: (e) => emails[e] ?? [] }).scan();
      return store.totalsByAccount();
    };
    const t = await run();
    assert.equal(t['seat-a'][5], 10);
    assert.equal(t['seat-b'][5], 20 + 40, 'the sub-agent inherits the login its parent had last');
    assert.equal(t.t2[5], 80);
    assert.equal(t.unknown, undefined);
    // The login is remembered with the offset: lines appended later keep their seat.
    appendFileSync(join(dir, 'g1.jsonl'), line({ id: 'x5', at: T, out: 5 }));
    const t2 = await run();
    assert.equal(t2['seat-b'][5], 65);
  });

  it('rebuilds a store saved by another attribution revision', () => {
    const path = freshPath();
    const s1 = new UsageStore(path, () => NOW, 2);
    s1.add(NOW - HOUR_MS, 'unknown', 'm', '', [1, 1, 0, 0, 0, 1]);
    s1.save();
    assert.equal(new UsageStore(path, () => NOW, 2).totalsByAccount().unknown[0], 1);
    const s3 = new UsageStore(path, () => NOW, 3);
    assert.deepEqual(s3.totalsByAccount(), {}, 'a new revision starts over (and the backfill re-imports)');
    assert.equal(s3.backfilledAt, undefined);
  });
});
