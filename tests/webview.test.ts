/**
 * The Claude panel: the activity board, and the page script run in a vm over
 * a small DOM with a fake bridge (every button, the poll loop, the keyed
 * rendering). `tests/webview-live.ts` runs the same page against the gateway.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatChunk, ChatRequest, SessionEvent, SessionTurnRequest } from '@alfred/sdk';
import { ActivityBoard, instrumentProvider, runItem } from '../src/webview/activity.js';
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

  it('tracks completion requests through the wrapped stream', async () => {
    const board = new ActivityBoard();
    const provider = {
      stream: (_r: ChatRequest): AsyncIterable<ChatChunk> =>
        feed<ChatChunk>([
          { type: 'text', delta: 'hi' },
          { type: 'done', response: { content: 'hi', usage: { inputTokens: 50, outputTokens: 7, servedModel: 'claude-sonnet-5' } as never } },
        ]),
    };
    instrumentProvider(provider, board);
    await drain(
      provider.stream({
        model: 'sonnet',
        messages: [{ role: 'user', content: 'Summarise this' }],
        metadata: { agentId: 'coder', source: 'title' },
        providerOptions: { claudeEffort: 'low' },
      } as ChatRequest),
    );
    const [r] = board.view();
    assert.equal(r.kind, 'request');
    assert.equal(r.status, 'done');
    assert.equal(r.agent, 'coder');
    assert.equal(r.effort, 'low');
    assert.equal(r.servedModel, 'claude-sonnet-5');
    assert.equal(r.tokensOut, 7);
    assert.equal(r.title, '[title] Summarise this');
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

const btn = (page: Awaited<ReturnType<typeof runPage>>, act: string, id?: string) =>
  page.doc.querySelector(id ? `button[data-act=${act}][data-id=${id}]` : `button[data-act=${act}]`);

describe('Claude panel page', () => {
  it('renders seats, activity and sub-agents without errors', async () => {
    const { invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.parseIssues, []);
    const body = page.doc.body.textContent.replace(/\s+/g, ' ');
    assert.match(body, /Fix the login bug/);
    assert.match(body, /Explore/);
    assert.match(body, /1\/2 sub-agents running/);
    assert.match(body, /opus-5-5/);
    assert.match(body, /high/);
    assert.match(body, /1m 5s/, 'running duration ticks from startedAt');
    assert.match(body, /same login as A/, 'two seats on one Claude login are flagged');
    assert.match(body, /back in 30m/);
    assert.ok(btn(page, 'login', 'c'), 'a logged-out seat offers Log in');
    assert.equal(btn(page, 'login', 'a'), null, 'a working seat does not');
    assert.equal(page.$('conn')!.hidden, true);
    assert.equal(page.$('actWrap')!.hidden, false);
  });

  it('keeps one poll in flight, never stacks timers, slows down when idle', async () => {
    const { b, invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    await page.advance(60_000);
    assert.deepEqual(page.timers(), { intervals: 1, timeouts: 1 });
    const polls = page.calls.filter((c) => c.action === 'poolSnapshot').length;
    assert.ok(polls >= 20 && polls <= 26, `live: ~every 2.5 s (${polls})`);
    b.snap = snapshot([]);
    await page.advance(5_000);
    const before = page.calls.length;
    await page.advance(60_000);
    const idle = page.calls.length - before;
    assert.ok(idle >= 6 && idle <= 8, `idle: ~every 8 s (${idle})`);
    assert.equal(page.$('actEmpty')!.hidden, false);
    const sent = page.calls.length;
    b.hang = true;
    await page.advance(120_000);
    // One poll at a time; the bridge gives up on a silent call after 35 s.
    assert.ok(page.calls.length - sent <= 3, `stalled worker: ${page.calls.length - sent} polls in 120 s`);
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
    const rowA = page.doc.querySelector('tr[data-key=acc:a]');
    await page.click(btn(page, 'more', 'b'));
    const input = page.$('tokv-b')!;
    input.value = 'half-typed';
    const writes = page.doc.stats.innerHTMLWrites;
    await page.advance(10_000);
    assert.equal(page.doc.querySelector('tr[data-key=acc:a]'), rowA, 'same node');
    assert.equal(page.$('tokv-b'), input);
    assert.equal(input.value, 'half-typed');
    assert.ok(page.doc.stats.innerHTMLWrites - writes <= 1, 'identical polls write (almost) nothing');
    b.snap.accounts[0].tokens.window5h.output = 99_000;
    await page.advance(3_000);
    assert.notEqual(page.doc.querySelector('tr[data-key=acc:a]'), rowA, 'a changed row is rebuilt');
    assert.equal(page.$('tokv-b'), input, 'its neighbours are not');
    assert.match(page.doc.querySelector('tr[data-key=acc:a]')!.textContent, /99\.0k out/);
  });

  it('wires every seat button to its action', async () => {
    const { invoke } = bridge();
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    const last = () => page.calls.filter((c) => c.action !== 'poolSnapshot').pop();
    const expect = async (el: ReturnType<typeof btn>, action: string, args: Record<string, unknown>) => {
      await page.click(el);
      assert.deepEqual(last(), { action, args }, action);
    };
    await expect(btn(page, 'login', 'c'), 'loginAccount', { id: 'c' });
    assert.match(page.$('flash')!.textContent, /Login window opened for C/);
    await expect(btn(page, 'refresh', 'a'), 'refreshUsage', { id: 'a' });
    await expect(btn(page, 'test', 'a'), 'testConnection', { accountId: 'a' });
    assert.match(page.$('flash')!.textContent, /A answered: OK/);
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
    const last = () => page.calls.filter((c) => c.action !== 'poolSnapshot').pop();

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
    await page.click(btn(page, 'refresh', 'a'));
    assert.match(page.$('flash')!.textContent, /seat is busy/);
    assert.equal(btn(page, 'refresh', 'a')!.disabled, false, 'a failed action re-enables its button');
    assert.deepEqual(page.errors, []);
  });

  it('flags a running turn that stopped sending events', async () => {
    const { invoke } = bridge(snapshot([liveTurn({ lastEventAt: T0 - 120_000 })]));
    const page = await runPage(renderDashboard(), invoke, { startAt: T0 });
    assert.match(page.doc.querySelector('tr[data-key=a:turn:x]')!.textContent, /stalled/);
  });
});
