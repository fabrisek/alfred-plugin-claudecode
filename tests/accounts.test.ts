// Run: npm test (node --test with the tsx loader). No network, no CLI.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AccountPool } from '../src/accounts/pool.js';
import { applyRateLimitInfo, parseUsageResponse, relevantPercent } from '../src/accounts/usage.js';
import {
  ClaudeCodeProvider,
  __setQueryForTests,
  buildPrompt,
  classifyFailure,
  splitModel,
} from '../src/ClaudeCodeProvider.js';
import { renderDashboard } from '../src/webview/dashboard.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const tmpRoot = join(import.meta.dirname, '.tmp');
let dir = '';

before(() => {
  dir = mkdtempSync(join(tmpRoot + '-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Fresh pool with N token seats (no files outside the temp dir). */
function makePool(n: number, now = () => Date.now()): AccountPool {
  const pool = new AccountPool({ dataDir: mkdtempSync(join(dir, 'p-')), logger, now });
  pool.remove('default');
  for (let i = 1; i <= n; i++) {
    const a = pool.add(`Seat ${i}`, 'token');
    pool.setToken(a.id, `tok-${i}`);
  }
  return pool;
}

// Real body from GET /api/oauth/usage on a Team seat (2026-10-08), trimmed.
const REAL_USAGE = {
  five_hour: { utilization: 2, resets_at: '2026-10-08T18:39:59.075950+00:00' },
  seven_day: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', group: 'session', percent: 2, severity: 'normal', resets_at: '2026-10-08T18:39:59.075950+00:00', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: '2026-10-15T08:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: false },
  ],
};
// Real rate_limit_event.rate_limit_info from CLI 2.1.280.
const REAL_EVENT = {
  status: 'allowed',
  resetsAt: 1791484800,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: 1791484800 } },
};

describe('usage parsing', () => {
  it('reads the real /api/oauth/usage shape, including model-scoped weekly limits', () => {
    const u = parseUsageResponse(REAL_USAGE, Date.parse('2026-10-08T15:00:00Z'));
    const five = u.windows.find((w) => w.key === 'five_hour')!;
    assert.equal(five.percent, 2);
    assert.equal(five.resetsAt, Date.parse('2026-10-08T18:39:59.075Z'));
    const fable = u.windows.find((w) => w.key === 'weekly:fable')!;
    assert.equal(fable.model, 'fable');
    assert.equal(fable.label, 'Fable week');
    assert.equal(u.windows.length, 2);
  });

  it('merges the live rate_limit_event (fraction -> percent, seconds -> ms)', () => {
    const u = applyRateLimitInfo(parseUsageResponse(REAL_USAGE), REAL_EVENT);
    const five = u.windows.find((w) => w.key === 'five_hour')!;
    assert.equal(five.percent, 2);
    assert.equal(five.resetsAt, 1791484800 * 1000);
    assert.equal(u.windows.length, 2);
  });

  it('only counts model-scoped windows for that model family', () => {
    const now = Date.parse('2026-10-08T15:00:00Z');
    const u = parseUsageResponse({
      five_hour: { utilization: 10, resets_at: '2026-10-08T18:00:00Z' },
      seven_day_opus: { utilization: 95, resets_at: '2026-10-12T00:00:00Z' },
    }, now);
    assert.equal(relevantPercent(u, 'opus', now), 95);
    assert.equal(relevantPercent(u, 'sonnet', now), 10);
    assert.equal(relevantPercent(u, 'opus', Date.parse('2026-10-13T00:00:00Z')), 0);
  });
});

describe('selection', () => {
  const usageAt = (pct: number) => ({
    windows: [{ key: 'five_hour', label: '5h', percent: pct, resetsAt: Date.now() + 3_600_000 }],
    fetchedAt: Date.now(),
    source: 'api' as const,
  });

  it('fill: sticks to the preferred seat until the threshold, then most headroom', () => {
    const pool = makePool(3);
    const [a, b, c] = pool.list();
    pool.setUsage(a.id, usageAt(50));
    pool.setUsage(b.id, usageAt(70));
    pool.setUsage(c.id, usageAt(20));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, a.id);
    pool.setUsage(a.id, usageAt(91));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, b.id);
    pool.setUsage(b.id, usageAt(95));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, c.id);
    pool.setUsage(c.id, usageAt(99));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, a.id, 'all over: least used');
  });

  it('spread: least utilised first', () => {
    const pool = makePool(3);
    pool.updateSettings({ strategy: 'spread' });
    const [a, b, c] = pool.list();
    pool.setUsage(a.id, usageAt(50));
    pool.setUsage(b.id, usageAt(10));
    pool.setUsage(c.id, usageAt(30));
    assert.equal(pool.pick({ model: 'opus' }).account?.id, b.id);
  });

  it('skips disabled and exhausted seats; pinned wins when usable', () => {
    const pool = makePool(3);
    const [a, b, c] = pool.list();
    pool.update(a.id, { enabled: false });
    pool.markExhausted(b.id, Date.now() + 3_600_000, 'limit');
    assert.equal(pool.pick({ model: 'opus' }).account?.id, c.id);
    assert.equal(pool.pick({ model: 'opus', pinned: b.id }).account?.id, c.id, 'pinned but exhausted falls back');
    pool.update(a.id, { enabled: true });
    assert.equal(pool.pick({ model: 'opus', pinned: c.id }).account?.id, c.id);
  });

  it('all exhausted: names the earliest reset', () => {
    const pool = makePool(2);
    const [a, b] = pool.list();
    const soon = Date.now() + 2 * 3_600_000;
    pool.markExhausted(a.id, soon + 3_600_000, 'limit');
    pool.markExhausted(b.id, soon, 'limit');
    const r = pool.pick({ model: 'opus' });
    assert.equal(r.account, undefined);
    assert.match(r.reason!, /exhausted/);
    assert.match(r.reason!, /Seat 2/);
  });

  it('model ids carry an optional pinned seat', () => {
    assert.deepEqual(splitModel('opus@seat-3'), { model: 'opus', pinned: 'seat-3' });
    assert.deepEqual(splitModel('claude-opus-5'), { model: 'claude-opus-5' });
  });

  it('classifies limit and auth failures', () => {
    assert.equal(classifyFailure("You've hit your limit · resets 6pm", undefined, null).kind, 'limit');
    assert.equal(classifyFailure('x', 'rate_limit', null).kind, 'limit');
    assert.equal(classifyFailure('Claude AI usage limit reached|1791484800', undefined, null).resetsAt, 1791484800000);
    assert.equal(classifyFailure('Invalid API key · Please run /login', undefined, null).kind, 'auth');
    assert.equal(classifyFailure('prompt is too long', undefined, null).kind, 'other');
  });
});

describe('token ledger', () => {
  it('sums 5h window, week and total per seat', () => {
    let now = Date.parse('2026-10-08T10:30:00Z');
    const pool = makePool(1, () => now);
    const [a] = pool.list();
    const sample = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, costUsd: 0.01 };
    pool.begin(a.id);
    pool.end(a.id, { model: 'opus', outcome: 'ok', tokens: sample });
    now += 6 * 3_600_000;
    pool.begin(a.id);
    pool.end(a.id, { model: 'opus', outcome: 'ok', tokens: sample });
    const s = pool.tokenSummary(a.id);
    assert.equal(s.total.requests, 2);
    assert.equal(s.total.cacheRead, 200);
    assert.equal(s.window5h.requests, 1);
    assert.equal(s.week.requests, 2);
    assert.equal(pool.recent.length, 2);
  });
});

describe('prompt building', () => {
  it('keeps every turn, tool calls, tool results and images in order', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    const built = buildPrompt([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'look', images: [png] },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read', arguments: { p: 1 } }] },
      { role: 'tool', name: 'read', content: 'RESULT' },
      { role: 'user', content: 'and this', attachments: [{ name: 'a.jpg', mimeType: 'image/jpeg', size: 3, data: '/9j/AAA' }] },
    ] as never);
    assert.equal(built.systemPrompt, 'SYS');
    assert.equal(built.images, 2);
    const kinds = built.content.map((b) => b.type);
    assert.deepEqual(kinds, ['text', 'image', 'text', 'image']);
    const second = (built.content[2] as { text: string }).text;
    assert.match(second, /<tool_call>\n\{"name":"read","arguments":\{"p":1\}\}\n<\/tool_call>/);
    assert.match(second, /Tool result \(read\):\nRESULT/);
    assert.match(second, /User:\nand this$/);
    assert.equal((built.content[3] as { source: { media_type: string } }).source.media_type, 'image/jpeg');
  });
});

type Msg = Record<string, unknown>;
function fakeRun(byToken: Record<string, Msg[]>, calls: string[]) {
  return ((args: { options?: { env?: Record<string, string> } }) => {
    const tok = args.options?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? '';
    calls.push(tok);
    const script = byToken[tok] ?? [];
    return (async function* () {
      for (const m of script) {
        if (m.__throw) throw new Error(String(m.__throw));
        yield m;
      }
    })();
  }) as never;
}
const textDelta = (t: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const okResult = { type: 'result', subtype: 'success', is_error: false, result: 'hi', usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 }, total_cost_usd: 0.001 };
const limitTurn = [
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 7200, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 7200 } } } },
  { type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] } },
  { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" },
];

describe('provider failover', () => {
  const cfg = { oauthToken: '', modelsRaw: 'opus', contextWindow: 200000, pathToClaude: '', requestTimeoutMs: 5000 };
  const cli = { path: '', native: false, source: 'bundled' as const };

  it('moves to the next seat when the first is out of quota before any chunk', async () => {
    const pool = makePool(2);
    const calls: string[] = [];
    __setQueryForTests(fakeRun({ 'tok-1': limitTurn, 'tok-2': [textDelta('hi'), okResult] }, calls));
    const p = new ClaudeCodeProvider({ config: cfg, pool, cli, logger });
    const res = await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.content, 'hi');
    assert.deepEqual(calls, ['tok-1', 'tok-2']);
    const [a, b] = pool.list();
    assert.ok(pool.runtime(a.id).exhaustedUntil! > Date.now() + 3_600_000);
    assert.equal(pool.recent[0].accountId, b.id);
    assert.equal(pool.recent[0].tokens?.cacheRead, 7);
    assert.equal(pool.recent[1].outcome, 'switched');
    // Next request goes straight to seat 2.
    calls.length = 0;
    await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(calls, ['tok-2']);
  });

  it('switches on auth failure, and errors with the account name mid-stream', async () => {
    const pool = makePool(2);
    const calls: string[] = [];
    __setQueryForTests(fakeRun({
      'tok-1': [{ __throw: 'Claude Code process exited with code 1: Invalid API key · Please run /login' }],
      'tok-2': [textDelta('part'), ...limitTurn],
    }, calls));
    const p = new ClaudeCodeProvider({ config: cfg, pool, cli, logger });
    await assert.rejects(
      p.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] }),
      /account "Seat 2" failed mid-answer \(resets .+\)/,
    );
    assert.deepEqual(calls, ['tok-1', 'tok-2']);
    assert.ok(pool.runtime(pool.list()[0].id).authFailed);
  });

  it('does not treat the synthetic limit text as an answer', async () => {
    const pool = makePool(1);
    __setQueryForTests(fakeRun({ 'tok-1': limitTurn }, []));
    const p = new ClaudeCodeProvider({ config: cfg, pool, cli, logger });
    await assert.rejects(p.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] }), /exhausted/);
    __setQueryForTests(null);
  });

  it('sends system prompt and image blocks to the SDK', async () => {
    const pool = makePool(1);
    let seen: { options?: Record<string, unknown>; content?: unknown[] } = {};
    __setQueryForTests(((args: { prompt: AsyncIterable<{ message: { content: unknown[] } }>; options: Record<string, unknown> }) =>
      (async function* () {
        for await (const m of args.prompt) seen = { options: args.options, content: m.message.content };
        yield textDelta('ok');
        yield okResult;
      })()) as never);
    const p = new ClaudeCodeProvider({ config: cfg, pool, cli: { path: 'claude.exe', native: true, source: 'setting' }, logger });
    await p.chat({
      model: 'opus',
      providerOptions: { claudeEffort: 'high' },
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u', images: ['/9j/AAAA'] }],
    });
    assert.equal(seen.options?.systemPrompt, 'S');
    assert.deepEqual(seen.options?.extraArgs, {
      tools: '',
      'strict-mcp-config': null,
      'disable-slash-commands': null,
      effort: 'high',
    });
    assert.equal((seen.content?.[1] as { type: string }).type, 'image');
    __setQueryForTests(null);
  });

  it('reports the served model behind an alias and remembers it', async () => {
    const pool = makePool(1);
    const served = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }], model: 'claude-opus-5-5' },
    };
    __setQueryForTests(fakeRun({ 'tok-1': [textDelta('hi'), served, okResult] }, []));
    const p = new ClaudeCodeProvider({ config: cfg, pool, cli, logger });
    assert.equal((await p.listModels())[0].displayName, 'Claude Opus (latest)');
    const res = await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.usage?.servedModel, 'claude-opus-5-5');
    assert.equal(pool.recent[0].servedModel, 'claude-opus-5-5');
    assert.equal(pool.servedModelOf('opus'), 'claude-opus-5-5');
    assert.equal((await p.listModels())[0].displayName, 'Claude Opus (claude-opus-5-5)');
    __setQueryForTests(null);
  });
});

describe('dashboard', () => {
  it('renders a document whose inline script parses', () => {
    const html = renderDashboard();
    const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
    assert.doesNotThrow(() => new Function(script));
    assert.ok(!script.includes('${'));
  });
});
