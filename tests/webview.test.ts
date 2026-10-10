/**
 * The activity board behind the Claude panel's Running drawer: turns, seats,
 * tools, sub-agents. The page itself is covered by tests/panel.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatChunk, ChatRequest, SessionEvent, SessionTurnRequest } from '@alfred/sdk';
import { ActivityBoard, instrumentProvider, parseTurn, runItem } from '../src/webview/activity.js';
import type { RunState } from '../src/session/runner.js';

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
