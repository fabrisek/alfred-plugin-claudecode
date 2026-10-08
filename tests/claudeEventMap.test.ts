// Replays real Claude Code streams (tests/fixtures/claude-stream, recorded with
// tests/capture-claude-fixtures.ts: CLI 2.1.280, Agent SDK 0.3.294) through the
// SDK-message -> SessionEvent mapper. No network, no CLI.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent } from '@alfred/sdk';
import { loadFixture } from './fixtureLoader.js';
import { ClaudeEventMapper, toolKind, totalsOf, turnUsage, type ChecklistItem } from '../src/agentSession/claudeEventMap.js';

function replay(name: string, requestedModel = 'haiku'): { events: SessionEvent[]; mapper: ClaudeEventMapper } {
  let t = 0;
  const mapper = new ClaudeEventMapper({ requestedModel, cwd: 'C:\\exact\\Cwd', resumed: false, seat: { id: 'default', label: 'Default' }, now: () => (t += 10) });
  const events = loadFixture(name).flatMap((m) => mapper.map(m));
  return { events, mapper };
}

const of = <T extends SessionEvent['type']>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe('claudeEventMap: fixtures', () => {
  it('plain reply: session, served model, deltas, the persisted block, rate limit, step usage', () => {
    const { events, mapper } = replay('plain');
    const [session] = of(events, 'session');
    assert.equal(session.ref.sessionId, mapper.sessionId);
    assert.equal(session.ref.cwd, 'C:\\exact\\Cwd', 'the exact cwd Alfred chose, not the CLI echo');
    assert.equal(session.ref.seatId, 'default');
    assert.equal(session.cliVersion, '2.1.280');
    assert.ok(session.tools?.includes('Bash'));
    assert.deepEqual(of(events, 'model'), [{ type: 'model', requested: 'haiku', served: 'claude-haiku-4-5-20251001' }]);
    assert.equal(of(events, 'text_delta').map((e) => e.delta).join(''), 'hi');
    const blocks = of(events, 'assistant');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, 'hi');
    assert.equal(blocks[0].parentToolUseId, null);
    const [rl] = of(events, 'rate_limit');
    assert.equal(rl.status, 'ok');
    assert.equal(rl.seatId, 'default');
    assert.equal(rl.windows[0].name, '5h');
    assert.ok(rl.windows[0].usedPercent! > 0 && rl.windows[0].resetsAt! > 1e12);
    const [step] = of(events, 'usage');
    assert.equal(step.scope, 'step');
    assert.ok(step.usage.contextUsed! > 1000);
    assert.equal(of(events, 'turn_end').length, 0, 'turn_end is the adapter\'s call');
  });

  it('native tools: Read / Bash / Edit round trips with kinds, inputs, results, durations', () => {
    const { events } = replay('tools');
    const starts = of(events, 'tool_start');
    assert.deepEqual(starts.map((s) => [s.name, s.kind]), [['Read', 'read'], ['Bash', 'shell'], ['Edit', 'edit']]);
    const results = of(events, 'tool_result');
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.ok && r.durationMs! > 0 && r.parentToolUseId === null));
    assert.equal(results[1].output, 'fixture');
    assert.deepEqual((results[1].structured as { stdout: string }).stdout, 'fixture');
    const inputs = of(events, 'tool_input');
    assert.equal((inputs[2].input as { new_string: string }).new_string, 'colour=blue');
    // Every result answers a started tool.
    const ids = new Set(starts.map((s) => s.toolUseId));
    assert.ok(results.every((r) => ids.has(r.toolUseId)));
    assert.equal(of(events, 'assistant').at(-1)?.text, 'done');
  });

  it('parallel tool calls in one API message are two tools, each answered', () => {
    const { events } = replay('parallel');
    const starts = of(events, 'tool_start');
    assert.equal(starts.filter((s) => s.name === 'Read').length, 2);
    const results = of(events, 'tool_result');
    assert.deepEqual(results.map((r) => r.output.replace(/\s+/g, '')), ['1x2', '1y2']);
  });

  it('sub-agent: start/end around the Agent tool, its messages nested under the tool', () => {
    const { events } = replay('subagent');
    const agentTool = of(events, 'tool_start').find((s) => s.name === 'Agent')!;
    assert.equal(agentTool.kind, 'subagent');
    const [start] = of(events, 'subagent_start');
    assert.equal(start.parentToolUseId, agentTool.toolUseId);
    assert.equal(start.agentType, 'general-purpose');
    assert.match(start.prompt ?? '', /pong/);
    const nested = of(events, 'assistant').filter((a) => a.parentToolUseId === agentTool.toolUseId);
    assert.equal(nested.map((a) => a.text).join(''), 'pong');
    const [end] = of(events, 'subagent_end');
    assert.equal(end.subagentId, start.subagentId);
    assert.equal(end.status, 'completed');
    assert.equal(end.result, 'pong');
    assert.equal(of(events, 'subagent_end').length, 1, 'not ended twice by the tool result');
  });

  it('a plain Bash task (local_bash) is not a sub-agent', () => {
    const { events } = replay('midturn');
    assert.equal(of(events, 'subagent_start').length, 0);
    assert.equal(of(events, 'tool_start')[0].kind, 'shell');
  });

  it('planning tools (TaskCreate/Update/List/Get) become checklist snapshots with ids, never anything else', () => {
    const { events, mapper } = replay('tasks');
    const snaps = of(events, 'todos');
    assert.deepEqual(snaps.map((s) => s.source), ['TaskCreate', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskUpdate', 'TaskUpdate']);
    const items = (i: number) => snaps[i].items as ChecklistItem[];
    assert.deepEqual(items(1).map((x) => [x.id, x.content, x.status]), [['1', 'alpha', 'pending'], ['2', 'beta', 'pending']]);
    assert.deepEqual(items(3).map((x) => [x.id, x.status]), [['1', 'in_progress'], ['2', 'pending']]);
    assert.equal(items(4).find((x) => x.id === '2')?.description, 'Task beta');
    assert.deepEqual(items(6).map((x) => [x.id, x.content, x.status]), [['1', 'alpha', 'completed'], ['2', 'beta', 'completed']]);
    assert.equal(mapper.checklist.size, 2);
    assert.ok(of(events, 'tool_start').filter((s) => s.name.startsWith('Task')).every((s) => s.kind === 'todo'));
  });

  it('the older TaskCreate run (todos fixture) ends with both items completed', () => {
    const { events } = replay('todos');
    const last = of(events, 'todos').at(-1)!;
    assert.deepEqual(last.items.map((x) => x.status), ['completed', 'completed']);
  });

  it('image input: the reply is an assistant block', () => {
    const { events } = replay('image');
    assert.match(of(events, 'assistant').map((a) => a.text).join(' '), /red/i);
  });

  it('error turns: a synthetic assistant message is never shown as text', () => {
    const { events } = replay('error-model');
    assert.equal(of(events, 'assistant').length, 0);
    assert.equal(of(events, 'text_delta').length, 0);
  });

  it('resume: a turn\'s usage is its own share of the cumulative CLI totals', () => {
    const before = totalsOf(loadFixture('plain').find((m) => m.type === 'result')!);
    const after = loadFixture('resume').find((m) => m.type === 'result')!;
    const u = turnUsage(after, before, 1234);
    assert.ok(Math.abs(u.costUsd! - (0.0131317 - 0.0101131)) < 1e-9);
    assert.equal(u.inputTokens, 10, 'per-turn main-loop tokens as reported');
    assert.equal(u.contextWindow, 200000);
    assert.equal(u.contextUsed, 1234);
    assert.ok(u.byModel?.['claude-haiku-4-5-20251001']);
  });
});

describe('claudeEventMap: synthetic shapes not capturable live', () => {
  it('TodoWrite input is a full checklist snapshot', () => {
    const m = new ClaudeEventMapper({ requestedModel: 'opus', cwd: '/w', resumed: false });
    const ev = m.map({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed', activeForm: 'Doing a' }, { content: 'b', status: 'in_progress' }] } }],
      },
    });
    const todos = of(ev, 'todos');
    assert.equal(todos.length, 1);
    assert.deepEqual(todos[0].items.map((i) => [(i as ChecklistItem).id, i.content, i.status]), [['1', 'a', 'completed'], ['2', 'b', 'in_progress']]);
    assert.equal(toolKind('TodoWrite'), 'todo');
  });

  it('a rejected rate-limit event maps to status rejected with its window', () => {
    const m = new ClaudeEventMapper({ requestedModel: 'opus', cwd: '/w', resumed: false, seat: { id: 's1', label: 'S1' } });
    const [e] = m.map({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791484800, rateLimitType: 'seven_day_opus', utilization: 1 } });
    assert.deepEqual(e, { type: 'rate_limit', seatId: 's1', status: 'rejected', windows: [{ name: 'week-opus', usedPercent: 100, resetsAt: 1791484800000 }] });
  });

  it('compaction, retries and tool progress', () => {
    const m = new ClaudeEventMapper({ requestedModel: 'opus', cwd: '/w', resumed: false });
    assert.deepEqual(m.map({ type: 'system', subtype: 'status', status: 'compacting' }), [{ type: 'status', status: 'compacting' }]);
    assert.deepEqual(m.map({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 20000 } }), [
      { type: 'compaction', trigger: 'auto', preTokens: 150000, postTokens: 20000 },
    ]);
    const [retry] = m.map({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' });
    assert.equal(retry.type === 'status' && retry.status, 'retrying');
    assert.deepEqual(m.map({ type: 'tool_progress', tool_use_id: 't9', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 31 }), [
      { type: 'tool_progress', toolUseId: 't9', elapsedMs: 31000 },
    ]);
  });

  it('caps a huge tool result before it crosses the worker boundary', () => {
    const m = new ClaudeEventMapper({ requestedModel: 'opus', cwd: '/w', resumed: false });
    m.map({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: {} }] } });
    const [res] = m.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'x'.repeat(400_000) }] }, tool_use_result: { file: { content: 'x'.repeat(400_000) } } });
    assert.equal(res.type, 'tool_result');
    assert.ok(res.type === 'tool_result' && res.output.length < 270_000);
    assert.deepEqual(res.type === 'tool_result' && res.structured, { truncated: true, bytes: 400_023 });
  });
});
