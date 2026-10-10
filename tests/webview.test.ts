/**
 * The Claude panel: the activity board, and the page script run in a vm over
 * a small DOM with a fake bridge (every button, the poll loop, the keyed
 * rendering). `tests/webview-live.ts` runs the same page against the gateway.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatChunk, ChatRequest, SessionEvent, SessionTurnRequest } from '@alfred/sdk';
import { ActivityBoard, instrumentProvider, parseTurn, runItem } from '../src/webview/activity.js';
import { renderDashboard } from '../src/webview/dashboard.js';
import type { RunState } from '../src/session/runner.js';
import { runPage } from './webviewVm.js';

const T0 = 1_791_480_000_000;

function turnReq(over: Partial<SessionTurnRequest> = {}): SessionTurnRequest {
  return {
    turnId: 'exec-1',
    conversationId: 'conv-1',
    agentId: 'alfred',
    cwd: 'C:/x',
    additionalDirectories: [],
    input: { clientMessageId: 'm1', text: 'Fix   the\nlogin bug' },
    model: 'opus',
    effort: 'high',
    permissionMode: 'bypassPermissions',
    mcpServers: [],
    ...over,
  };
}

async function* feed<T>(items: T[], gate?: Promise<void>): AsyncIterable<T> {
  for (const i of items) yield i;
  if (gate) await gate;
}

async function drain<T>(it: AsyncIterable<T>, stopAfter = Infinity): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
    if (out.length >= stopAfter) break;
  }
  return out;
}

const EVENTS: SessionEvent[] = [
  { type: 'session', ref: { sessionId: 's1', cwd: 'C:/x' }, resumed: false, model: 'claude-opus-5-5', seat: { id: 'seat-a', label: 'Seat A' } },
  { type: 'tool_start', toolUseId: 'tu-task', name: 'Task', kind: 'subagent', parentToolUseId: null },
  { type: 'subagent_start', subagentId: 'sa-1', parentToolUseId: 'tu-task', agentType: 'Explore', description: 'Find the login code' },
  { type: 'tool_start', toolUseId: 'tu-grep', name: 'Grep', kind: 'search', parentToolUseId: 'tu-task' },
  { type: 'usage', scope: 'step', usage: { outputTokens: 120, contextUsed: 40_000, contextWindow: 200_000 } },
  { type: 'subagent_progress', subagentId: 'sa-1', summary: 'Reading auth.ts', lastTool: 'Read' },
];

describe('ActivityBoard', () => {
  it('follows a turn, its seat, model, tools and sub-agents, then closes it', async () => {
    let now = T0;
    const board = new ActivityBoard({ now: () => now });
    const seen = await drain(
      board.observeTurn(
        turnReq(),
        feed<SessionEvent>([
          ...EVENTS,
          { type: 'subagent_end', subagentId: 'sa-1', status: 'completed' },
          { type: 'turn_end', stopReason: 'end_turn', usage: { inputTokens: 10, cacheReadTokens: 30_000, outputTokens: 900 } },
        ]),
      ),
    );
    assert.equal(seen.length, EVENTS.length + 2, 'events pass through untouched');
    now += 5000;
    const [item] = board.view();
    assert.equal(item.kind, 'chat');
    assert.equal(item.status, 'done');
    assert.equal(item.title, 'Fix the login bug');
    assert.equal(item.seat, 'Seat A');
    assert.equal(item.servedModel, 'claude-opus-5-5');
    assert.equal(item.effort, 'high');
    assert.equal(item.tokensOut, 900);
    assert.equal(item.tokensIn, 30_010);
    assert.equal(item.contextUsed, 40_000);
    assert.equal(item.subagents.length, 1);
    assert.equal(item.subagents[0].status, 'completed');
    assert.equal(item.subagents[0].lastTool, 'Read');
    assert.equal(item.canStop, false);
  });

  it('shows a live turn as running with its current tool and running sub-agent', async () => {
    const board = new ActivityBoard();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done = drain(board.observeTurn(turnReq(), feed<SessionEvent>(EVENTS, gate), async () => {}));
    await new Promise((r) => setImmediate(r));
    const [item] = board.view();
    assert.equal(item.status, 'running');
    assert.equal(item.detail, 'Task');
    assert.equal(item.canStop, true);
    assert.equal(item.subagents[0].status, 'running');
    assert.equal(item.subagents[0].summary, 'Reading auth.ts');
    release();
    await done;
    const [after] = board.view();
    assert.equal(after.status, 'stopped', 'a stream that ends without turn_end is not "done"');
    assert.equal(after.subagents[0].status, 'stopped', 'a sub-agent cannot outlive its CLI');
  });

  it('closes a turn whose consumer goes away, and marks a failed one', async () => {
    const board = new ActivityBoard();
    await drain(board.observeTurn(turnReq({ turnId: 'a' }), feed<SessionEvent>(EVENTS)), 2);
    async function* boom(): AsyncIterable<SessionEvent> {
      yield EVENTS[0];
      throw new Error('CLI crashed');
    }
    await assert.rejects(drain(board.observeTurn(turnReq({ turnId: 'b' }), boom())), /CLI crashed/);
    const byId = Object.fromEntries(board.view().map((i) => [i.id, i]));
    assert.equal(byId['turn:a'].status, 'stopped');
    assert.equal(byId['turn:b'].status, 'failed');
    assert.equal(byId['turn:b'].detail, 'CLI crashed');
  });

  it('maps turn_end reasons', async () => {
    const board = new ActivityBoard();
    const end = (id: string, e: SessionEvent) => drain(board.observeTurn(turnReq({ turnId: id }), feed<SessionEvent>([EVENTS[0], e])));
    await end('lim', { type: 'turn_end', stopReason: 'limit', error: { kind: 'limit', message: 'hit your limit' } });
    await end('int', { type: 'turn_end', stopReason: 'interrupted' });
    await end('err', { type: 'turn_end', stopReason: 'error', error: { kind: 'cli', message: 'bad' } });
    const s = Object.fromEntries(board.view().map((i) => [i.id, i.status]));
    assert.deepEqual(s, { 'turn:lim': 'limit', 'turn:int': 'interrupted', 'turn:err': 'failed' });
  });

  it('stop() interrupts the live turn through the provider', async () => {
    const board = new ActivityBoard();
    let interrupted = '';
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = {
      stream: (_r: ChatRequest): AsyncIterable<ChatChunk> => feed<ChatChunk>([]),
      runSessionTurn: (_r: SessionTurnRequest): AsyncIterable<SessionEvent> => feed<SessionEvent>([EVENTS[0]], gate),
      interruptSessionTurn: async (id: string) => {
        interrupted = id;
        release();
      },
    };
    instrumentProvider(provider, board);
    const done = drain(provider.runSessionTurn(turnReq({ turnId: 'live' })));
    await new Promise((r) => setImmediate(r));
    assert.equal(await board.stop('turn:live'), true);
    assert.equal(interrupted, 'live');
    await done;
    assert.equal(board.view()[0].status, 'interrupted');
    assert.equal(await board.stop('turn:live'), false, 'nothing to stop any more');
  });

  it('groups the requests of one engine turn into one row', async () => {
    let now = T0;
    const board = new ActivityBoard({ now: () => now });
    const sys = { role: 'system', content: 'You are Developer, the user\'s assistant. Rules...' };
    const ask = { role: 'user', content: 'You have been delegated by agent `pm` to complete task **t-84410d5e**: Fix the crash\nDetails...' };
    const call = (name: string, args: Record<string, unknown>) => ({ role: 'assistant', content: '', toolCalls: [{ id: name, name, arguments: args }] });
    const res = (name: string) => ({ role: 'tool', content: 'ok', toolCallId: name });
    const answer = (tools: string[], out: number): ChatChunk[] => [
      { type: 'text', delta: 'x' },
      ...tools.map((n) => ({ type: 'tool_call', call: { id: n, name: n, arguments: {} } }) as ChatChunk),
      { type: 'done', response: { content: 'x', toolCalls: tools.map((n) => ({ id: n, name: n, arguments: {} })), usage: { outputTokens: out, servedModel: 'claude-opus-5-5' } as never } },
    ];
    const req = (messages: unknown[]) => ({ model: 'opus', messages } as unknown as ChatRequest);
    let next: ChatChunk[] = [];
    const provider = { stream: (_r: ChatRequest): AsyncIterable<ChatChunk> => feed<ChatChunk>(next) };
    instrumentProvider(provider, board);

    next = answer(['task_get'], 100);
    await drain(provider.stream(req([sys, ask])));
    let [row] = board.view();
    assert.equal(row.status, 'tool', 'between iterations the host runs the tools');
    assert.equal(row.detail, 'task_get');
    now += 2000;
    next = answer(['read_file'], 50);
    await drain(provider.stream(req([sys, ask, call('task_get', {}), res('task_get')])));
    now += 2000;
    next = answer([], 30);
    await drain(provider.stream(req([sys, ask, call('task_get', {}), res('task_get'), call('read_file', { p: 'a' }), res('read_file')])));
    const rows = board.view();
    assert.equal(rows.length, 1, 'one row per turn, not per request');
    row = rows[0];
    assert.equal(row.status, 'done');
    assert.equal(row.iterations, 3);
    assert.equal(row.iterationList!.length, 3);
    assert.deepEqual(row.iterationList!.map((i) => i.tools.join()), ['task_get', 'read_file', '']);
    assert.equal(row.tokensOut, 180);
    assert.equal(row.agent, 'Developer');
    assert.equal(row.from, 'pm');
    assert.equal(row.taskId, 't-84410d5e');
    assert.equal(row.title, 'Fix the crash');
    assert.equal(row.lastTool, 'read_file');
    assert.equal(row.endedAt! - row.startedAt, 4000);
    assert.equal(row.loop, undefined);

    next = answer([], 5);
    await drain(provider.stream(req([sys, ask, call('task_get', {}), res('task_get'), { role: 'assistant', content: 'done' }, { role: 'user', content: 'Now run it' }])));
    assert.equal(board.view().length, 2, 'a new user message is a new turn');
    next = answer([], 5);
    await drain(provider.stream(req([sys, ask])));
    assert.equal(board.view().length, 3, 'the same prompt again after its turn ended is a new turn');
  });

  it('flags a real loop: the host loop check, or five identical tool rounds', () => {
    const sys = { role: 'system', content: 'You are Developer, x' };
    const ask = { role: 'user', content: 'Wait for the build' };
    const poll = { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: 'run_shell', arguments: { cmd: 'status' } }] };
    const out = { role: 'tool', content: 'pending' };
    const four = [poll, out, poll, out, poll, out, poll, out];
    assert.equal(parseTurn({ model: 'opus', messages: [sys, ask, ...four] } as unknown as ChatRequest).loop, undefined);
    const five = parseTurn({ model: 'opus', messages: [sys, ask, ...four, poll, out] } as unknown as ChatRequest);
    assert.deepEqual(five.loop, { streak: 5, tools: ['run_shell'] });
    const nudge = { role: 'user', content: '[Alfred loop check] You have made the exact same tool call (run_shell, glob) with identical arguments 10 iterations in a row. ...' };
    const host = parseTurn({ model: 'opus', messages: [sys, ask, poll, out, nudge] } as unknown as ChatRequest);
    assert.deepEqual(host.loop, { streak: 10, tools: ['run_shell', 'glob'] });
    assert.equal(host.key, parseTurn({ model: 'opus', messages: [sys, ask] } as unknown as ChatRequest).key, 'the loop note does not start a new turn');
    const varied = [poll, out, { ...poll, toolCalls: [{ id: 'y', name: 'read_file', arguments: { p: 1 } }] }, out, poll, out, poll, out, poll, out];
    assert.equal(parseTurn({ model: 'opus', messages: [sys, ask, ...varied] } as unknown as ChatRequest).loop, undefined, 'progress resets the streak');
  });

  it('shows the seat as soon as the request takes one, and what it waits for', async () => {
    const board = new ActivityBoard({ seatLabel: (id) => id.toUpperCase() });
    const pool = { begin: (_id: string) => {} };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = {
      stream: (_r: ChatRequest): AsyncIterable<ChatChunk> =>
        (async function* () {
          await new Promise((r) => setImmediate(r));
          pool.begin('seat-b');
          await gate;
          yield { type: 'thinking', delta: 'hm' } as ChatChunk;
          yield { type: 'done', response: { content: 'ok' } } as ChatChunk;
        })(),
    };
    instrumentProvider(provider, board, pool);
    const done = drain(provider.stream({ model: 'opus', messages: [{ role: 'user', content: 'hi' }] } as ChatRequest));
    await new Promise((r) => setTimeout(r, 10));
    let [row] = board.view();
    assert.equal(row.status, 'running');
    assert.equal(row.seat, 'SEAT-B');
    assert.equal(row.phase, 'waiting for first output');
    assert.equal(row.iterationList![0].seat, 'SEAT-B');
    release();
    await done;
    [row] = board.view();
    assert.equal(row.status, 'done');
    assert.equal(row.phase, undefined);
    pool.begin('seat-c');
    assert.equal(board.view()[0].seat, 'SEAT-B', 'a seat taken outside a request is not attributed');
  });

  it('maps a claude_code_run session', () => {
    const run = {
      id: 'r1',
      request: { cwd: 'C:/x', prompt: 'Refactor', model: 'opus', effort: 'max', permissionMode: 'acceptEdits', maxTurns: 0, agent: 'coder' },
      status: 'running',
      startedAt: T0,
      account: { id: 'seat-a', label: 'Seat A' },
      turns: 3,
    } as unknown as RunState;
    const item = runItem(run, T0 + 1000)!;
    assert.equal(item.kind, 'run');
    assert.equal(item.status, 'running');
    assert.equal(item.canStop, true);
    assert.equal(item.detail, 'turn 3');
    assert.equal(runItem({ ...run, status: 'done', endedAt: T0 } as RunState, T0 + 3_600_000), undefined, 'old runs drop off');
  });
});

// ---- the page ---------------------------------------------------------------

const tally = (out: number, inp = 0) => ({ input: inp, output: out, cacheRead: 0, cacheWrite: 0, costUsd: 1.5, requests: 2 });
function account(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: id.toUpperCase(),
    enabled: true,
    auth: 'login',
    preferred: false,
    exposeModels: false,
    status: 'ok',
    statusDetail: null,
    exhaustedUntil: null,
    usage: {
      windows: [
        { key: 'five_hour', label: '5h', percent: 40, resetsAt: T0 + 3_600_000 },
        { key: 'seven_day', label: 'Week', percent: 85, resetsAt: T0 + 3 * 86_400_000 },
        { key: 'weekly:fable', label: 'Fable week', model: 'fable', percent: 0, resetsAt: T0 + 4 * 86_400_000 },
      ],
      fetchedAt: T0,
      source: 'api',
    },
    lastError: null,
    lastUsedAt: null,
    requests: 0,
    inFlight: 0,
    email: `${id}@example.com`,
    orgName: 'org',
    subscriptionType: 'max',
    tokens: { window5h: tally(1000, 5), week: tally(2000, 5), total: tally(3000, 5), window5hStart: T0, weekStart: T0 },
    ...over,
  };
}

function snapshot(activity: unknown[] = []) {
  return {
    ok: true,
    settings: { strategy: 'fill', threshold: 90, usagePollMinutes: 5, fillMaxInFlight: 4 },
    cli: 'CLI: native',
    accounts: [
      account('a', { preferred: true, status: 'active', inFlight: 1 }),
      account('b', { status: 'exhausted', exhaustedUntil: T0 + 1_800_000, statusDetail: '5h at 100%', email: 'a@example.com' }),
      account('c', { status: 'logged out', email: null, usage: null, lastError: { message: 'not logged in', at: T0 } }),
    ],
    totals: { window5h: tally(1000), week: tally(2000), total: tally(3000) },
    recent: [{ at: T0, accountId: 'a', accountLabel: 'A', model: 'opus', servedModel: 'claude-opus-5-5', outcome: 'ok', agent: 'alfred', tokens: tally(10, 100) }],
    activity,
  };
}

function liveTurn(over: Record<string, unknown> = {}) {
  return {
    id: 'turn:x',
    kind: 'chat',
    title: 'Fix the login bug',
    agent: 'alfred',
    model: 'opus',
    servedModel: 'claude-opus-5-5',
    effort: 'high',
    seat: 'A',
    status: 'running',
    detail: 'Bash',
    startedAt: T0 - 65_000,
    lastEventAt: T0,
    tokensOut: 1200,
    contextUsed: 50_000,
    contextWindow: 200_000,
    canStop: true,
    subagents: [
      { id: 'sa1', type: 'Explore', description: 'Find callers', status: 'running', startedAt: T0 - 30_000, lastTool: 'Grep' },
      { id: 'sa2', type: 'Plan', description: 'Plan fix', status: 'failed', startedAt: T0 - 60_000, endedAt: T0 - 40_000 },
    ],
    ...over,
  };
}

type Bridge = { snap: ReturnType<typeof snapshot>; hang: boolean; fail: string | null; inflight: number; maxInflight: number };

function bridge(snap = snapshot([liveTurn()])): { b: Bridge; invoke: (a: string, args: Record<string, unknown>) => Promise<unknown> } {
  const b: Bridge = { snap, hang: false, fail: null, inflight: 0, maxInflight: 0 };
  const invoke = async (action: string, _args: Record<string, unknown>) => {
    b.inflight++;
    b.maxInflight = Math.max(b.maxInflight, b.inflight);
    try {
      if (b.hang) await new Promise(() => {});
      await Promise.resolve();
      if (b.fail && action !== 'poolSnapshot') return { ok: false, error: b.fail };
      if (action === 'poolSnapshot') return structuredClone(b.snap);
      if (action === 'testConnection') return { ok: true, sample: 'OK' };
      return { ok: true };
    } finally {
      b.inflight--;
    }
  };
  return { b, invoke };
}

// The usage-history poll runs on its own slow timer; these tests watch the snapshot poll.
const snapCalls = (page: Awaited<ReturnType<typeof runPage>>) => page.calls.filter((c) => c.action === 'poolSnapshot').length;
const actionCalls = (page: Awaited<ReturnType<typeof runPage>>) => page.calls.filter((c) => c.action !== 'poolSnapshot' && c.action !== 'usageHistory');

const btn = (page: Awaited<ReturnType<typeof runPage>>, act: string, id?: string) =>
  page.doc.querySelector(id ? `button[data-act=${act}][data-id=${id}]` : `button[data-act=${act}]`);

describe('Claude panel page', () => {
  it('renders seats, activity and sub-agents without errors', async () => {
    const { invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.parseIssues, []);
    // The live turns sit behind the "N running" toggle in the Seats header.
    assert.match(page.$('runsBtn')!.textContent, /1 running · 1 sub-agent/);
    assert.equal(page.$('actPanel')!.hidden, true, 'closed until asked');
    assert.equal(page.doc.querySelectorAll('#act tr').length, 0, 'and not built while closed');
    await page.click(page.$('runsBtn'));
    assert.equal(page.$('actPanel')!.hidden, false);
    const body = page.doc.body.textContent.replace(/\s+/g, ' ');
    assert.match(body, /Fix the login bug/);
    assert.match(body, /Explore/);
    assert.match(body, /1\/2 sub-agents running/);
    assert.match(body, /opus-5-5/);
    assert.match(body, /high/);
    assert.match(body, /1m 5s/, 'running duration ticks from startedAt');
    assert.match(body, /same login as A/, 'two seats on one Claude login are flagged');
    assert.match(body, /exhausted · back \S+ \(in 30m\)/, 'one status: exhausted, and when it is back');
    assert.doesNotMatch(body, /ok/, 'no "ok" next to a full window');
    assert.ok(btn(page, 'login', 'c'), 'a logged-out seat offers Log in');
    assert.equal(btn(page, 'login', 'a'), null, 'a working seat does not');
    assert.equal(page.$('conn')!.hidden, true);
    assert.equal(page.$('actWrap')!.hidden, false);
  });

  it('keeps one poll in flight, never stacks timers, slows down when idle', async () => {
    const { b, invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    await page.advance(60_000);
    // The snapshot poll and the (slow) usage-history poll: one timeout each.
    assert.deepEqual(page.timers(), { intervals: 1, timeouts: 2 });
    const polls = page.calls.filter((c) => c.action === 'poolSnapshot').length;
    assert.ok(polls >= 20 && polls <= 26, `live: ~every 2.5 s (${polls})`);
    b.snap = snapshot([]);
    await page.advance(5_000);
    const before = snapCalls(page);
    await page.advance(60_000);
    const idle = snapCalls(page) - before;
    assert.ok(idle >= 6 && idle <= 8, `idle: ~every 8 s (${idle})`);
    assert.equal(page.$('actEmpty')!.hidden, false);
    const sent = snapCalls(page);
    b.hang = true;
    await page.advance(120_000);
    // One poll at a time; the bridge gives up on a silent call after 35 s.
    assert.ok(snapCalls(page) - sent <= 3, `stalled worker: ${snapCalls(page) - sent} polls in 120 s`);
    assert.ok(page.timers().timeouts <= 2);
    assert.deepEqual(page.errors, []);
  });

  it('shows the bridge failing, then recovers', async () => {
    const { invoke } = bridge();
    let down = false;
    const page = await runPage(renderDashboard(), (a, args) => (down ? Promise.reject(new Error('worker gone')) : invoke(a, args)), { startAt: T0 });
    down = true;
    await page.advance(3_000);
    assert.equal(page.$('conn')!.hidden, false);
    assert.equal(page.$('conn')!.title, 'worker gone');
    down = false;
    await page.advance(9_000);
    assert.equal(page.$('conn')!.hidden, true);
  });

  it('leaves unchanged rows alone: typed token, open details and hover survive polls', async () => {
    const { b, invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    const rowA = page.doc.querySelector('[data-key=acc:a]');
    await page.click(btn(page, 'more', 'b'));
    const input = page.$('tokv-b')!;
    input.value = 'half-typed';
    const writes = page.doc.stats.innerHTMLWrites;
    await page.advance(10_000);
    assert.equal(page.doc.querySelector('[data-key=acc:a]'), rowA, 'same node');
    assert.equal(page.$('tokv-b'), input);
    assert.equal(input.value, 'half-typed');
    assert.ok(page.doc.stats.innerHTMLWrites - writes <= 1, 'identical polls write (almost) nothing');
    b.snap.accounts[0].usage!.windows[0].percent = 70;
    await page.advance(3_000);
    assert.notEqual(page.doc.querySelector('[data-key=acc:a]'), rowA, 'a changed row is rebuilt');
    assert.equal(page.$('tokv-b'), input, 'its neighbours are not');
    assert.match(page.doc.querySelector('[data-key=acc:a]')!.textContent, /30%/);
  });

  it('wires every seat button to its action', async () => {
    const { invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    const last = () => actionCalls(page).pop();
    const expect = async (el: ReturnType<typeof btn>, action: string, args: Record<string, unknown>) => {
      await page.click(el);
      assert.deepEqual(last(), { action, args }, action);
    };
    await expect(btn(page, 'login', 'c'), 'loginAccount', { id: 'c' });
    assert.match(page.$('flash')!.textContent, /Login window opened for C/);
    // Everything but Log in and the order arrows lives in the seat's menu.
    assert.equal(btn(page, 'refresh', 'a'), null, 'menu closed');
    await page.click(btn(page, 'more', 'a'));
    await expect(btn(page, 'refresh', 'a'), 'refreshUsage', { id: 'a' });
    await expect(btn(page, 'test', 'a'), 'testConnection', { accountId: 'a' });
    assert.match(page.$('flash')!.textContent, /A answered: OK/);
    await page.click(btn(page, 'more', 'a'));
    assert.equal(btn(page, 'refresh', 'a'), null, 'menu closed again');
    await page.click(btn(page, 'flash-close'));
    assert.equal(page.$('flash')!.textContent, '');

    await page.click(btn(page, 'more', 'b'));
    assert.ok(page.$('tokv-b'));
    page.$('tokv-b')!.value = ' sk-ant-oat ';
    await expect(btn(page, 'savetoken', 'b'), 'setAccountToken', { id: 'b', token: 'sk-ant-oat' });
    assert.equal(page.$('tokv-b')!.value, '');
    await expect(btn(page, 'login', 'b'), 'loginAccount', { id: 'b' });
    await expect(btn(page, 'toggle', 'b'), 'updateAccount', { id: 'b', enabled: false });
    await expect(btn(page, 'top', 'b'), 'moveAccount', { id: 'b', index: 0 });
    await expect(btn(page, 'up', 'b'), 'moveAccount', { id: 'b', delta: -1 });
    await expect(btn(page, 'down', 'b'), 'moveAccount', { id: 'b', delta: 1 });
    assert.ok(btn(page, 'up', 'a')!.disabled, 'the first seat cannot go up');
    assert.ok(btn(page, 'down', 'c')!.disabled, 'the last seat cannot go down');
    assert.equal(btn(page, 'top', 'a'), null);
    await expect(btn(page, 'pin', 'b'), 'updateAccount', { id: 'b', exposeModels: true });
    await expect(btn(page, 'clear', 'b'), 'clearExhausted', { id: 'b' });

    const n = page.calls.length;
    await page.click(btn(page, 'remove', 'b'));
    assert.equal(btn(page, 'remove', 'b')!.textContent, 'Confirm remove');
    await page.advance(2_600); // a poll rebuilds rows meanwhile: still armed
    assert.equal(btn(page, 'remove', 'b')!.textContent, 'Confirm remove');
    await page.advance(1_000);
    assert.equal(btn(page, 'remove', 'b')!.textContent, 'Remove', 'disarms by itself');
    assert.equal(page.calls.slice(n).filter((c) => c.action === 'removeAccount').length, 0);
    await page.click(btn(page, 'remove', 'b'));
    await expect(btn(page, 'remove', 'b'), 'removeAccount', { id: 'b' });
    assert.ok(page.$('tokv-b') === null, 'removing closes the details');

    await page.click(btn(page, 'more', 'a'));
    assert.ok(page.$('tokv-a') !== null);
    await page.click(btn(page, 'more', 'a'));
    assert.ok(page.$('tokv-a') === null, 'Less closes the details');
    assert.deepEqual(page.errors, []);
  });

  it('wires the toolbar, the stop button and the history', async () => {
    const { b, invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    const last = () => actionCalls(page).pop();

    await page.click(page.$('runsBtn'));
    await page.click(btn(page, 'stop', 'turn:x'));
    assert.equal(last(), undefined, 'first click only arms');
    await page.click(btn(page, 'stop', 'turn:x'));
    assert.deepEqual(last(), { action: 'stopActivity', args: { id: 'turn:x' } });

    await page.click(page.$('refreshAll'));
    assert.deepEqual(last(), { action: 'refreshUsage', args: {} });

    await page.click(page.$('addToggle'));
    assert.equal(page.$('addRow')!.hidden, false);
    await page.click(page.$('add'));
    assert.equal(last()!.action, 'refreshUsage', 'no label, no call');
    page.$('newLabel')!.value = 'Seat 4';
    await page.click(page.$('add'));
    assert.deepEqual(last(), { action: 'addAccount', args: { label: 'Seat 4', token: '', login: true } });
    assert.equal(page.$('addRow')!.hidden, true);
    await page.click(page.$('addToggle'));
    page.$('newLabel')!.value = 'Seat 5';
    page.$('newToken')!.value = 'tok';
    await page.click(page.$('add'));
    assert.deepEqual(last(), { action: 'addAccount', args: { label: 'Seat 5', token: 'tok', login: false } });

    await page.type(page.$('strategy'), 'spread');
    assert.deepEqual(last(), { action: 'updateSettings', args: { strategy: 'spread' } });
    await page.type(page.$('threshold'), '150');
    assert.match(page.$('flash')!.textContent, /1 to 100/);
    await page.type(page.$('threshold'), '75');
    assert.deepEqual(last(), { action: 'updateSettings', args: { threshold: 75 } });

    assert.equal(page.doc.querySelectorAll('#hist tr').length, 0, 'history is only built when open');
    page.$('histBox')!.open = true;
    page.$('histBox')!.dispatchEvent(new (await import('./miniDom.js')).DomEvent('toggle', false));
    await page.settle();
    assert.equal(page.doc.querySelectorAll('#hist tr').length, 1);

    b.fail = 'seat is busy';
    await page.click(btn(page, 'more', 'a'));
    await page.click(btn(page, 'refresh', 'a'));
    assert.match(page.$('flash')!.textContent, /seat is busy/);
    assert.equal(btn(page, 'refresh', 'a')!.disabled, false, 'a failed action re-enables its button');
    assert.deepEqual(page.errors, []);
  });

  it('shows an engine turn as one row, with its iterations on demand and a loop badge', async () => {
    const turn = {
      id: 'eturn:1', kind: 'request', title: 'Fix the crash', agent: 'Developer', from: 'pm', taskId: 't-84410d5e',
      model: 'opus', servedModel: 'claude-opus-5-5', seat: 'A', status: 'tool', detail: 'run_shell', startedAt: T0 - 20_000,
      lastEventAt: T0 - 200_000, tokensOut: 900, iterations: 2, lastTool: 'run_shell', canStop: false, subagents: [],
      loop: { streak: 6, tools: ['run_shell'] },
      iterationList: [
        { n: 1, startedAt: T0 - 20_000, endedAt: T0 - 15_000, status: 'done', tools: ['task_get'], seat: 'A', tokensOut: 400 },
        { n: 2, startedAt: T0 - 10_000, endedAt: T0 - 5_000, status: 'done', tools: ['run_shell'], seat: 'A', tokensOut: 500 },
      ],
    };
    const { invoke } = bridge(snapshot([turn]));
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    await page.click(page.$('runsBtn'));
    const row = () => page.doc.querySelector('tr[data-key=a:eturn:1]')!.textContent.replace(/\s+/g, ' ');
    assert.match(row(), /Developer ← pm · t-84410d5e Fix the crash/);
    assert.match(row(), /tools/, 'waiting on its tools');
    assert.doesNotMatch(row(), /stalled/, 'a turn running its tools is not stalled');
    assert.match(row(), /loop ×6/);
    assert.match(row(), /2 iterations/);
    assert.match(row(), /running run_shell/);
    assert.equal(page.doc.querySelectorAll('#act tr').length, 1, 'iterations hidden until asked');
    await page.click(btn(page, 'iters', 'eturn:1'));
    const iters = page.doc.querySelectorAll('#act tr.sub').map((tr) => tr.textContent.replace(/\s+/g, ' '));
    assert.equal(iters.length, 2);
    assert.match(iters[0], /#2 called run_shell/);
    assert.match(iters[1], /#1 called task_get/);
    await page.click(btn(page, 'iters', 'eturn:1'));
    assert.equal(page.doc.querySelectorAll('#act tr.sub').length, 0);
    assert.deepEqual(page.errors, []);
  });

  it('says which seat a new conversation gets next, and why', async () => {
    const { b, invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    assert.match(page.$('seatFacts')!.textContent, /Next: none ready/);
    assert.match(page.$('seatFacts')!.textContent, /switch at 90%/);
    (b.snap as Record<string, unknown>).next = { id: 'a', label: 'A', why: '62% left, resets in 40m' };
    b.snap.settings.strategy = 'drain';
    await page.advance(10_000);
    assert.match(page.$('seatFacts')!.textContent, /Next: A — 62% left, resets in 40m \(use it or lose it\)/);
    assert.equal(page.$('strategy')!.value, 'drain');
    assert.deepEqual(page.errors, []);
  });

  it('flags a running turn that stopped sending events', async () => {
    const { invoke } = bridge(snapshot([liveTurn({ lastEventAt: T0 - 120_000 })]));
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    await page.click(page.$('runsBtn'));
    assert.match(page.doc.querySelector('tr[data-key=a:turn:x]')!.textContent, /stalled/);
  });
});

// ---- the Usage zone ----------------------------------------------------------

describe('Claude panel usage zone', () => {
  async function usagePage() {
    const { UsageStore } = await import('../src/usage/history.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const store = new UsageStore(join(mkdtempSync(join(tmpdir(), 'alfred-usage-wv-')), 'u.json'), () => T0);
    store.add(T0 - 3_600_000, 'a', 'claude-opus-5-5', 'alfred', [3, 10, 0, 60_000, 200_000, 900]);
    store.add(T0 - 26 * 3_600_000, 'b', 'claude-haiku-4-5-20251001', '', [1, 5, 1000, 0, 0, 50]);
    store.add(T0 - 2 * 3_600_000, 'unknown', 'claude-opus-5-5', 'engine', [1, 2, 50_000, 0, 0, 30]);
    const scan = { running: false, backfilled: true, filesDone: 3, filesTotal: 3, lastScanAt: T0 };
    const day = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const capacity = {
      since: T0 - 2 * 86_400_000,
      rows: [{ day: day(T0), account: 'a', window: 'five_hour', n: 2, pct: 90, usedTok: 1000, usedUsd: 2, estN: 2, fullTok: 2500, fullUsd: 5, estUsedTok: 1000, estUsedUsd: 2 }],
    };
    const view = { ok: true, ...store.view({ scan, seats: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], plans: { a: { label: 'Max 20x', monthlyUsd: 200 } } }), version: 'v1', capacity };
    let usageCalls = 0;
    const { invoke } = bridge(snapshot([liveTurn({ tokens: [10, 2000, 30_000, 1200], cost: [0.00004, 0.016, 0.006, 0.024] })]));
    const page = await runPage(
      renderDashboard(),
      async (action, args) => {
        if (action !== 'usageHistory') return invoke(action, args);
        usageCalls++;
        return args.since === 'v1' ? { ok: true, unchanged: true, version: 'v1', scan } : structuredClone(view);
      },
      { startAt: T0 },
    );
    return { page, calls: () => usageCalls };
  }
  const hits = (page: Awaited<ReturnType<typeof runPage>>) => page.doc.querySelectorAll('#useChart rect.hit').length;

  it('shows one chart at a time: overview, by seat, hourly, daily, cost', async () => {
    const { page } = await usagePage();
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.parseIssues, []);
    assert.equal(page.$('useBody')!.hidden, false);
    // Overview, stacked by seat, since the first record: per hour while the
    // history is under three days old (26 h here), per day otherwise.
    assert.equal(btn(page, 'uview', 'overview')!.className, 'on');
    assert.equal(hits(page), 27);
    assert.match(page.$('useChart')!.innerHTML, /(1h)/);
    await page.type(page.$('usePeriod'), '30');
    assert.equal(hits(page), 30);
    await page.type(page.$('usePeriod'), '0');
    assert.equal(hits(page), 27);
    assert.equal(page.doc.querySelectorAll('#useChart svg').length, 1, 'one chart');
    assert.match(page.$('useLegend')!.textContent, /A.*B.*unattributed \(before tracking\)/);
    const strip = page.$('useStrip')!.textContent.replace(/\s+/g, ' ');
    assert.match(strip, /Input/);
    assert.match(strip, /Cache write/);
    assert.match(strip, /Cache read/);
    assert.match(strip, /Output/);
    assert.match(strip, /cache r\/w/);
    assert.match(strip, /saved|cache costs/);
    assert.match(strip, /month/);
    await page.click(btn(page, 'uview', 'byseat'));
    assert.equal(page.doc.querySelectorAll('#useChart button.mult').length, 3, 'A, B and unknown');
    const multA = btn(page, 'usel', 'a')!;
    assert.match(multA.getAttribute('title')!, /Max 20x/);
    assert.match(multA.getAttribute('title')!, /Cache read: 200\.0k tok/);
    await page.click(btn(page, 'uview', 'hourly'));
    assert.equal(hits(page), 24);
    assert.match(page.$('useLegend')!.textContent, /Input.*Cache write.*Cache read.*Output/);
    await page.click(btn(page, 'uview', 'daily'));
    assert.equal(hits(page), 2, 'since the first day with data: yesterday and today');
    await page.click(btn(page, 'uview', 'cost'));
    const cost = page.$('useChart')!.textContent.replace(/\s+/g, ' ');
    assert.match(cost, /Cache write \(5m [^)]+ · 1h 60\.0k\)/);
    assert.match(cost, /Cache reads saved/);
    assert.match(cost, /Cache write premium/);
    assert.match(cost, /Saved by the cache|The cache costs more than it saves/);
    assert.equal(page.$('useLegend')!.hidden, true);
    // The live turn's API $ with its four-line breakdown, in the running drop-down.
    await page.click(page.$('runsBtn'));
    const cell = page.doc.querySelector('tr[data-key=a:turn:x] td.r span[title]')!;
    assert.match(cell.textContent, /\$0\.05/);
    assert.match(cell.getAttribute('title')!, /Cache write: 2\.0k tok/);
    assert.match(page.$('stats')!.textContent, /today/);
    assert.deepEqual(page.errors, []);
  });

  it('selects a seat from its small chart, switches tokens / $ and the period', async () => {
    const { page } = await usagePage();
    await page.click(btn(page, 'uview', 'byseat'));
    await page.click(btn(page, 'usel', 'b'));
    assert.equal(btn(page, 'uview', 'daily')!.className, 'on', 'a seat opens in Daily');
    assert.equal(page.$('useAcc')!.value, 'b');
    assert.match(page.$('useScope')!.textContent, /^B/);
    await page.click(btn(page, 'umetric', 'cost'));
    assert.equal(btn(page, 'umetric', 'cost')!.className, 'on');
    assert.match(page.$('useChart')!.innerHTML, /\$/, 'the axis is in dollars');
    await page.type(page.$('usePeriod'), '7');
    assert.equal(hits(page), 7);
    await page.click(btn(page, 'uview', 'hourly'));
    await page.type(page.$('usePeriod'), '48');
    assert.equal(hits(page), 48);
    await page.click(btn(page, 'uview', 'daily'));
    assert.equal(hits(page), 7, 'each view keeps its own period');
    assert.deepEqual(page.errors, []);
  });

  it('shows the capacity left unused at each reset, as an estimate', async () => {
    const { page } = await usagePage();
    await page.click(btn(page, 'tab', 'usage'));
    assert.equal(page.$('pane-usage')!.hidden, false);
    assert.equal(page.$('pane-seats')!.hidden, true);
    await page.click(btn(page, 'uview', 'capacity'));
    assert.equal(page.$('ucapSeg')!.hidden, false);
    const legend = page.$('useLegend')!.textContent;
    assert.match(legend, /2 resets · 45% used on average · lost ≈ \$3\.0 \/ 1\.5k tok/);
    assert.match(legend, /estimate/);
    assert.match(page.$('useScope')!.textContent, /5h windows · estimate/);
    assert.equal(hits(page), 1, 'from the first day with a reset');
    await page.click(btn(page, 'ucap', 'seven_day'));
    assert.match(page.$('useChart')!.textContent, /No weekly reset seen in this period yet/);
    await page.click(btn(page, 'tab', 'seats'));
    assert.equal(page.$('pane-seats')!.hidden, false);
    assert.deepEqual(page.errors, []);
  });

  it('polls slowly and leaves the zone alone while the data is the same', async () => {
    const { page, calls } = await usagePage();
    assert.equal(calls(), 1);
    const svg = page.$('useChart')!.firstElementChild;
    await page.advance(29_000);
    assert.equal(calls(), 1, 'nothing before 30 s');
    await page.advance(2_000);
    assert.equal(calls(), 2);
    assert.equal(page.$('useChart')!.firstElementChild, svg, 'unchanged version: same nodes');
    assert.deepEqual(page.errors, []);
  });

  it('draws the chart at the size of its box', async () => {
    const { page } = await usagePage();
    const box = page.$('useChart')! as unknown as { clientWidth: number; clientHeight: number };
    box.clientWidth = 480;
    box.clientHeight = 260;
    // The window resize listener sits on the document in this vm.
    page.doc.body.dispatchEvent(new (await import('./miniDom.js')).DomEvent('resize'));
    await page.advance(200);
    const svg = page.$('useChart')!.firstElementChild!;
    assert.equal(svg.getAttribute('width'), '480');
    assert.equal(svg.getAttribute('height'), '260');
    assert.deepEqual(page.errors, []);
  });

  it('fills its box and scales to the tallest bar, at every panel size', async () => {
    const { page } = await usagePage();
    const box = page.$('useChart')! as unknown as { clientWidth: number; clientHeight: number };
    const { DomEvent } = await import('./miniDom.js');
    // The chart box at a 900x700, 1200x800 and 1700x930 panel (tab minus top bar, strip, legend).
    for (const [w, h] of [[870, 560], [1170, 660], [1670, 790]]) {
      box.clientWidth = w;
      box.clientHeight = h;
      page.doc.body.dispatchEvent(new DomEvent('resize'));
      await page.advance(200);
      for (const metric of ['cost', 'tokens']) {
        await page.click(btn(page, 'umetric', metric));
        for (const v of ['overview', 'hourly', 'daily']) {
          await page.click(btn(page, 'uview', v));
          const svg = page.doc.querySelector('#useChart svg')!;
          assert.equal(Number(svg.getAttribute('height')), h, `${w}x${h} ${v}: the chart takes the box height`);
          assert.equal(Number(svg.getAttribute('width')), w);
          const plotH = h - 5 - 15;
          let tallest = 0;
          for (const g of page.doc.querySelectorAll('#useChart g.col')) {
            const rects = g.querySelectorAll('rect').filter((r) => r.getAttribute('class') !== 'hit');
            if (!rects.length) continue;
            const top = Math.min(...rects.map((r) => Number(r.getAttribute('y'))));
            tallest = Math.max(tallest, h - 15 - top);
          }
          assert.ok(tallest >= 0.85 * plotH, `${w}x${h} ${metric}/${v}: tallest bar ${tallest} of ${plotH}`);
          assert.ok(tallest <= plotH + 0.5);
        }
      }
    }
    // Hours read with their day at midnight and on the first column.
    await page.click(btn(page, 'uview', 'hourly'));
    const labels = page.doc.querySelectorAll('#useChart text.ax').map((t) => t.textContent).filter((t) => /h$/.test(t));
    assert.match(labels[0], /\d+ \S+ \d\dh|\S+ \d+ \d\dh/, 'the first hour label carries its day');
    assert.deepEqual(page.errors, []);
  });
});

// ---- Seats: states, sums, quota over time --------------------------------------

describe('Claude panel seats', () => {
  const H = 3_600_000;
  const win = (pct: number, resetH: number, key = 'five_hour') => ({ key, label: key, percent: pct, resetsAt: T0 + resetH * H });
  async function seatsPage() {
    const snap = snapshot([]);
    snap.accounts = [
      account('a', { status: 'ok', usage: { windows: [win(100, 0.5), win(30, 50, 'seven_day')], fetchedAt: T0, source: 'api' } }),
      account('b', { status: 'ok', email: 'b@example.com', usage: { windows: [win(61, 21 / 60)], fetchedAt: T0, source: 'api' } }),
      account('c', { status: 'ok', email: 'c@example.com', usage: { windows: [win(75, 11 / 60)], fetchedAt: T0, source: 'api' } }),
      account('d', { status: 'ok', email: 'd@example.com', usage: { windows: [win(1, 4.85)], fetchedAt: T0, source: 'api' } }),
      // A transient throttle on a seat with quota left: its own short state.
      account('e', { status: 'throttled', throttledUntil: T0 + 2 * 60_000, statusDetail: 'throttled: API Error: 429', usage: { windows: [win(8, 4)], fetchedAt: T0, source: 'api' } }),
    ] as never;
    const d0 = new Date(T0);
    const today = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
    const cell = (usd: number) => [0, 0, 0, 0, usd, 0, 0, 0, 1, 0, 0, 0, 0];
    const view = {
      ok: true, version: 'v1', scan: { running: false, backfilled: true, filesDone: 0, filesTotal: 0, lastScanAt: T0 },
      firstAt: T0 - H, lastAt: T0, accounts: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'gone', label: 'gone (removed seat)' }],
      days: [today], daily: { a: [cell(2)], b: [cell(3)], gone: [cell(0.5)] },
      hours: [T0 - H], hourly: {}, models: [], plans: { a: { label: 'Team premium', monthlyUsd: 125 } }, monthStart: today.slice(0, 8) + '01', pricesVerified: 'x',
      seatSpend: { a: { fiveFrom: T0 - 4.5 * H, fiveTok: 10, fiveUsd: 1.5, weekFrom: null, weekTok: 0, weekUsd: 0 }, b: { fiveFrom: T0 - 4 * H, fiveTok: 5, fiveUsd: 2.25, weekFrom: null, weekTok: 0, weekUsd: 0 } },
      quota: {
        series: {
          a: { five: [[T0 - 6 * H, 40], [T0 - 5 * H, 80], [T0 - 4.5 * H, 2], [T0 - H, 100]], week: [], fiveReset: T0 + 0.5 * H, weekReset: null },
          b: { five: [[T0 - 3 * H, 60], [T0 - H, 61]], week: [], fiveReset: T0 + 0.35 * H, weekReset: null },
          c: { five: [[T0 - 2 * H, 74], [T0 - H, 75]], week: [], fiveReset: T0 + 0.2 * H, weekReset: null },
          d: { five: [[T0 - H, 1]], week: [], fiveReset: T0 + 4.85 * H, weekReset: null },
        },
      },
      capacity: { since: T0, rows: [] },
    };
    return runPage(renderDashboard(), async (action) => (action === 'usageHistory' ? structuredClone(view) : structuredClone(snap)), { startAt: T0 });
  }

  it('one state per seat, consistent with its numbers, and the quota left with its reset', async () => {
    const page = await seatsPage();
    const row = (id: string) => page.doc.querySelector(`tr[data-key=acc:${id}]`)!.textContent.replace(/\s+/g, ' ');
    assert.match(row('a'), /exhausted · back \S+ \(in 30m\)/, 'a 5h window at 100% is exhausted, whatever the pool says');
    assert.match(row('b'), /ready/);
    assert.match(row('b'), /39%\S+ \(in 21m\)/, '"39% left", the reset time and how long until it');
    assert.match(row('c'), /use before/, 'a lot left and lost soon is flagged');
    assert.doesNotMatch(row('d'), /use before/);
    assert.match(row('e'), /throttled · back \S+ \(in 2m\)/, 'a throttle is not "exhausted"');
    assert.doesNotMatch(row('e'), /exhausted/);
    assert.match(row('a'), /PRM/, 'the plan as a short pill');
    assert.doesNotMatch(row('b'), /@example\.com/, 'no email column: it is in the name tooltip');
    assert.deepEqual(page.errors, []);
  });

  it('the header is exactly the sum of the rows, unattributed history included', async () => {
    const page = await seatsPage();
    const stats = page.$('stats')!.textContent.replace(/\s+/g, ' ');
    assert.match(stats, /5h windows \$3\.8/, '1.5 + 2.25');
    assert.match(stats, /today \$5\.5/, '2 + 3 + 0.5 unattributed');
    assert.match(page.doc.querySelector('tr[data-key=acc:~unattributed]')!.textContent, /\$0\.50 today/);
    assert.match(page.doc.querySelector('tr[data-key=acc:a]')!.textContent, /\$1\.5\s*\$2\.0 today/);
  });

  it('Usage > Quota: one row per seat by reset, nothing cut or stacked at 480 and 1200 px', async () => {
    const page = await seatsPage();
    assert.equal(page.$('quotaChart'), null, 'not in Seats any more');
    await page.click(btn(page, 'tab', 'usage'));
    await page.click(btn(page, 'uview', 'quota'));
    assert.equal(page.$('qwinSeg')!.hidden, false);
    const box = page.$('useChart')! as unknown as { clientWidth: number; clientHeight: number };
    const { DomEvent } = await import('./miniDom.js');
    for (const w of [480, 1200]) {
      box.clientWidth = w;
      box.clientHeight = 400;
      page.doc.body.dispatchEvent(new DomEvent('resize'));
      await page.advance(200);
      await page.click(btn(page, 'uchart', 'bars'));
      const names = page.doc.querySelectorAll('#useChart .qrow .qname').map((n) => n.textContent);
      assert.deepEqual(names, ['C', 'B', 'A', 'D'], `${w}px: sorted by the soonest reset`);
      for (const svg of page.doc.querySelectorAll('#useChart svg.qtrack')) {
        assert.ok(Number(svg.getAttribute('width')) + 118 + 92 + 16 <= w, `${w}px: the track leaves the reserved columns their room`);
        assert.equal(svg.querySelectorAll('text').length, 0, 'no label inside the track to overflow');
        // The only vertical is the common "now" line.
        const verticals = svg.querySelectorAll('line').filter((l) => l.getAttribute('x1') === l.getAttribute('x2'));
        assert.equal(verticals.length, 1);
        assert.equal(verticals[0].getAttribute('class'), 'now');
      }
      const nows = page.doc.querySelectorAll('#useChart svg.qtrack line.now').map((l) => l.getAttribute('x1'));
      assert.equal(new Set(nows).size, 1, 'one time axis for every row');
      assert.equal(page.doc.querySelectorAll('#useChart rect.qlose').length, 2, 'B and C lose a lot soon');
      assert.equal(page.doc.querySelectorAll('#useChart polyline.proj').length, 0);
    }
    // Full width and 6 h of readings: the overlaid lines, without any projection.
    await page.click(btn(page, 'uchart', 'lines'));
    assert.ok(page.doc.querySelector('#useChart svg.lines'));
    assert.equal(page.doc.querySelectorAll('#useChart polyline.proj').length, 0);
    const ys = page.doc.querySelectorAll('#useChart text.endl').map((t) => Number(t.getAttribute('y'))).sort((x, y) => x - y);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 11.9, `labels apart: ${ys}`);
    // Narrow: never the overlaid chart.
    box.clientWidth = 480;
    page.doc.body.dispatchEvent(new DomEvent('resize'));
    await page.advance(200);
    assert.equal(page.doc.querySelector('#useChart svg.lines'), null);
    assert.ok(page.doc.querySelector('#useChart .qrow'));
    assert.deepEqual(page.errors, []);
  });

  it('shows each seat advisor state, with the reason in its tooltip', async () => {
    const snap = snapshot([]);
    snap.accounts[0] = { ...snap.accounts[0], advisor: { state: 'active', model: 'claude-fable-5-1', reason: null, at: T0 } } as never;
    snap.accounts[1] = { ...snap.accounts[1], advisor: { state: 'unavailable', model: 'claude-fable-5-1', reason: 'Fable 5.1 as the advisor bills to usage credits', at: T0 } } as never;
    const page = await runPage(renderDashboard(), async (action) => (action === 'usageHistory' ? { ok: false, error: 'x' } : structuredClone(snap)), { startAt: T0 });
    const tag = (id: string) => page.doc.querySelectorAll(`tr[data-key=acc:${id}] .tag`).filter((t) => /advisor/.test(t.textContent))[0];
    assert.equal(tag('a').textContent, 'advisor');
    assert.equal(tag('b').textContent, 'no advisor');
    assert.match(tag('b').getAttribute('title')!, /bills to usage credits/);
    assert.equal(tag('c'), undefined, 'not seen yet: no pill');
    assert.deepEqual(page.errors, []);
  });

  it('sorts by the soonest reset when asked', async () => {
    const page = await seatsPage();
    const order = () => page.doc.querySelectorAll('#acc tr').map((t) => t.getAttribute('data-key'));
    assert.deepEqual(order().slice(0, 4), ['acc:a', 'acc:b', 'acc:c', 'acc:d'], 'manual order by default');
    await page.type(page.$('seatSort'), 'reset');
    assert.deepEqual(page.calls.filter((c) => c.action === 'updateSettings').pop(), { action: 'updateSettings', args: { seatSort: 'reset' } });
  });
});

describe('Claude panel usage as lines', () => {
  it('draws one cumulative line per seat, named at its end', async () => {
    const { UsageStore } = await import('../src/usage/history.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const store = new UsageStore(join(mkdtempSync(join(tmpdir(), 'alfred-lines-')), 'u.json'), () => T0);
    store.add(T0 - 5 * 3_600_000, 'a', 'claude-opus-5-5', '', [1, 0, 0, 100_000, 0, 1000]);
    store.add(T0 - 2 * 3_600_000, 'a', 'claude-opus-5-5', '', [1, 0, 0, 100_000, 0, 1000]);
    store.add(T0 - 3 * 3_600_000, 'b', 'claude-opus-5-5', '', [1, 0, 0, 190_000, 0, 1000]);
    const scan = { running: false, backfilled: true, filesDone: 0, filesTotal: 0, lastScanAt: T0 };
    const view = { ok: true, ...store.view({ scan, seats: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], hourSpan: 72 }), version: 'v', capacity: { since: T0, rows: [] } };
    const page = await runPage(renderDashboard(), async (action) => (action === 'usageHistory' ? structuredClone(view) : structuredClone(snapshot([]))), { startAt: T0 });
    await page.click(btn(page, 'uchart', 'lines'));
    const labels = page.doc.querySelectorAll('#useChart text.endl');
    assert.deepEqual(labels.map((l) => l.getAttribute('data-sid')).sort(), ['a', 'b']);
    const ys = labels.map((l) => Number(l.getAttribute('y')));
    assert.ok(Math.abs(ys[0] - ys[1]) >= 11.9, 'close values: labels pushed apart');
    assert.equal(page.$('useLegend')!.hidden, true, 'no separate legend');
    const pts = page.doc.querySelector('#useChart polyline.ln')!.getAttribute('points')!.split(' ').map((p) => Number(p.split(',')[1]));
    assert.ok(pts[pts.length - 1] < pts[0], 'the line rises with the usage');
    assert.deepEqual(page.errors, []);
  });
});
