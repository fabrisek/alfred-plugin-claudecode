// Alfred's tools as native tools the host runs (src/hostTools.ts), and the
// engine-mode turn that waits for their results instead of being cut.
// No network, no CLI: a fake `query()` plays the CLI and calls the provider's
// real in-process MCP server through an in-memory MCP client, as the CLI does.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, ToolSchema } from '@alfred/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AccountPool } from '../src/accounts/pool.js';
import { ClaudeCodeProvider, LOST_CALLS_NOTE, __setQueryForTests, hostResults } from '../src/ClaudeCodeProvider.js';
import { HostToolBridge, toolsKey } from '../src/hostTools.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
let dir = '';
before(() => {
  dir = mkdtempSync(join(import.meta.dirname, '.tmp-hosttools-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => __setQueryForTests(null));

const TOOLS: ToolSchema[] = [
  { name: 'list_dir', description: 'Lists a directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'read.file', description: 'Reads a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
];

describe('host tool bridge', () => {
  it('names tools for MCP and maps the calls back to Alfred names', () => {
    const b = new HostToolBridge(TOOLS);
    const listed = b.listTools().tools;
    assert.deepEqual(listed.map((t) => t.name), ['list_dir', 'read_file']);
    assert.deepEqual(listed[0].inputSchema, TOOLS[0].parameters);
    assert.equal(b.alfredName('mcp__alfred__read_file'), 'read.file');
    assert.equal(b.alfredName('mcp__other__read_file'), null);
    assert.equal(b.alfredName('Bash'), null);
    assert.equal(toolsKey([...TOOLS].reverse()), toolsKey(TOOLS), 'order does not matter');
    assert.equal(b.setTools(TOOLS), false);
    assert.equal(b.setTools(TOOLS.slice(0, 1)), true);
  });

  it('matches results to calls by tool_use id, whichever comes first', async () => {
    const b = new HostToolBridge(TOOLS);
    b.expect([
      { id: 'u1', name: 'list_dir', arguments: {} },
      { id: 'u2', name: 'list_dir', arguments: {} },
    ]);
    const first = b.handle('u1', 'list_dir'); // the CLI asks before the host answered
    b.deliver('u1', { content: [{ type: 'text', text: 'one' }] });
    b.deliver('u2', { content: [{ type: 'text', text: 'two' }] }); // answered before the CLI asks
    assert.deepEqual((await first).content, [{ type: 'text', text: 'one' }]);
    assert.deepEqual((await b.handle('u2', 'list_dir')).content, [{ type: 'text', text: 'two' }]);
    assert.equal(b.pending, false);
    b.expect([{ id: 'u3', name: 'list_dir', arguments: {} }]);
    const third = b.handle('u3', 'list_dir');
    b.cancel('stopped');
    assert.deepEqual(await third, { content: [{ type: 'text', text: 'stopped' }], isError: true });
  });

  it('turns the host messages into results: missing ones fail, extras ride on the last', () => {
    const awaiting = new Set(['u1', 'u2']);
    const delta: Message[] = [
      { role: 'tool', name: 'list_dir', toolCallId: 'u1', content: 'a.txt', toolOk: false },
      { role: 'user', content: 'stop after this one' },
    ];
    const r = hostResults(delta, { awaiting }, [{ type: 'text', text: '<system-update>x</system-update>' }]);
    assert.deepEqual(r[0], { id: 'u1', result: { content: [{ type: 'text', text: 'a.txt' }], isError: true } });
    assert.equal(r[1].id, 'u2');
    assert.equal(r[1].result.isError, true);
    assert.match((r[1].result.content[0] as { text: string }).text, /returned no result/);
    assert.deepEqual(
      r[1].result.content.slice(1).map((c) => (c as { text: string }).text),
      ['<system-update>x</system-update>', 'User:\nstop after this one'],
    );
  });
});

type Spawn = { options: Record<string, unknown>; inputs: string[][]; interrupts: number; closed: boolean; toolResults: string[] };
type Step = { text?: string; calls?: Array<{ id: string; name: string; input: Record<string, unknown> }> };

/**
 * A fake CLI with Alfred's tools: each model step streams its text, then its
 * tool_use blocks; the CLI then calls each tool through the provider's MCP
 * server (one at a time, as the real CLI does) and goes on with the next step
 * once every call returned. `steps(n, results)` scripts step n of the
 * process, given the tool results it got so far.
 */
function fakeCli(steps: (n: number, results: string[], spawn: Spawn) => Step) {
  const spawns: Spawn[] = [];
  const fn = (args: { prompt: AsyncIterable<{ message: { content: Array<{ type: string; text?: string }> } }>; options?: Record<string, unknown> }) => {
    const spawn: Spawn = { options: args.options ?? {}, inputs: [], interrupts: 0, closed: false, toolResults: [] };
    spawns.push(spawn);
    const sid = (args.options?.resume as string | undefined) ?? `session-${spawns.length}`;
    let client: Client | null = null;
    const callTool = async (id: string, name: string, input: Record<string, unknown>): Promise<string> => {
      if (!client) {
        const server = (args.options?.mcpServers as Record<string, { instance: { connect(t: unknown): Promise<void> } }>).alfred.instance;
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        client = new Client({ name: 'fake-cli', version: '1' });
        await client.connect(a);
        const listed = await client.listTools();
        assert.ok(listed.tools.length > 0);
      }
      const r = (await client.callTool({ name: name.replace('mcp__alfred__', ''), arguments: input, _meta: { 'claudecode/toolUseId': id } })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      return `${r.isError ? 'ERROR ' : ''}${r.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' | ')}`;
    };
    async function* run() {
      let n = 0;
      for await (const m of args.prompt) {
        spawn.inputs.push(m.message.content.map((b) => (b.type === 'text' ? b.text ?? '' : `[${b.type}]`)));
        yield { type: 'system', subtype: 'init', session_id: sid, tools: [], model: 'claude-opus-5-5' };
        // One user message = one CLI turn: model steps until one has no tool call.
        for (;;) {
          n++;
          yield { type: 'stream_event', session_id: sid, event: { type: 'message_start', message: { usage: { input_tokens: 3, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 50 } } } };
          const step = steps(n, spawn.toolResults, spawn);
          if (step.text) yield { type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: step.text } } };
          for (const c of step.calls ?? []) {
            yield { type: 'assistant', session_id: sid, uuid: `uuid-${c.id}`, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: c.id, name: c.name, input: c.input }] } };
          }
          yield { type: 'stream_event', session_id: sid, event: { type: 'message_delta', delta: { stop_reason: step.calls?.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } } };
          yield { type: 'stream_event', session_id: sid, event: { type: 'message_stop' } };
          if (!step.calls?.length) {
            yield { type: 'assistant', session_id: sid, uuid: `uuid-text-${n}`, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: step.text ?? '' }] } };
            break;
          }
          for (const c of step.calls) {
            const out = await callTool(c.id, c.name, c.input);
            spawn.toolResults.push(out);
            yield { type: 'user', session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id }] } };
          }
        }
        yield { type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.01 };
      }
    }
    const it = run();
    return {
      [Symbol.asyncIterator]: () => it,
      interrupt: async () => {
        spawn.interrupts++;
      },
      close: () => {
        spawn.closed = true;
        void it.return(undefined);
      },
    };
  };
  return { spawns, fn: fn as never };
}

function makePool(): AccountPool {
  const pool = new AccountPool({ dataDir: mkdtempSync(join(dir, 'p-')), logger });
  pool.remove('default');
  pool.setToken(pool.add('Seat 1', 'token').id, 'tok-1');
  return pool;
}

const cfg = { oauthToken: '', modelsRaw: 'opus', contextWindow: 200000, pathToClaude: '', requestTimeoutMs: 5000, maxConcurrentRequests: 16, maxParallelTasks: 32 };
const cli = { path: '', native: true, source: 'setting' as const };

function provider(pool: AccountPool, sessionsDir = mkdtempSync(join(dir, 's-')), nativeTools?: boolean) {
  return new ClaudeCodeProvider({ config: { ...cfg, nativeTools }, pool, cli, logger, sessionsDir });
}

const send = (p: ClaudeCodeProvider, messages: Message[], key = 'conv-1|dev|') =>
  p.chat({ model: 'opus', messages, tools: TOOLS, session: { key } });

const toolMsg = (id: string, content: string): Message => ({ role: 'tool', name: 'list_dir', toolCallId: id, content });

describe('engine mode with native host tools', () => {
  it('declares native tools (text protocol only when turned off)', () => {
    const pool = makePool();
    assert.equal(provider(pool).capabilities.tools, true);
    assert.equal(provider(pool, undefined, false).capabilities.tools, false);
  });

  it('hands a call to the host and continues the same CLI turn with its result: no interrupt, no extra message', async () => {
    const fake = fakeCli((n, results) =>
      n === 1
        ? { text: 'Let me look.', calls: [{ id: 'toolu_1', name: 'mcp__alfred__list_dir', input: { path: '.' } }] }
        : n === 2
          ? { text: 'Now the file.', calls: [{ id: 'toolu_2', name: 'mcp__alfred__read_file', input: { path: 'a.txt' } }] }
          : { text: `Done after: ${results.join(' / ')}` },
    );
    __setQueryForTests(fake.fn);
    const p = provider(makePool());
    const msgs: Message[] = [
      { role: 'system', content: 'You are Alfred.' },
      { role: 'user', content: 'what is in a.txt?' },
    ];
    const r1 = await send(p, msgs);
    assert.equal(r1.finishReason, 'tool_calls');
    assert.equal(r1.content, 'Let me look.');
    assert.deepEqual(r1.toolCalls, [{ id: 'toolu_1', name: 'list_dir', arguments: { path: '.' } }]);

    msgs.push({ role: 'assistant', content: r1.content, toolCalls: r1.toolCalls });
    msgs.push(toolMsg('toolu_1', 'a.txt b.txt'));
    const r2 = await send(p, msgs);
    assert.deepEqual(r2.toolCalls, [{ id: 'toolu_2', name: 'read.file', arguments: { path: 'a.txt' } }], 'Alfred name, not the MCP one');

    msgs.push({ role: 'assistant', content: r2.content, toolCalls: r2.toolCalls });
    msgs.push({ role: 'tool', name: 'read.file', toolCallId: 'toolu_2', content: 'hello' });
    const r3 = await send(p, msgs);
    assert.equal(r3.finishReason, 'stop');
    assert.equal(r3.content, 'Done after: a.txt b.txt / hello');
    assert.equal(r3.toolCalls, undefined);

    assert.equal(fake.spawns.length, 1, 'one process for the whole turn');
    const [spawn] = fake.spawns;
    assert.equal(spawn.inputs.length, 1, 'tool results are not user messages');
    assert.equal(spawn.interrupts, 0, 'no reply is cut');
    assert.deepEqual(spawn.options.allowedTools, ['mcp__alfred']);
    assert.equal((spawn.options.env as Record<string, string>).ENABLE_TOOL_SEARCH, 'false');
    assert.equal((spawn.options.mcpServers as Record<string, { type: string }>).alfred.type, 'sdk');

    // The next user turn is a user message again, in the same process.
    msgs.push({ role: 'assistant', content: r3.content });
    msgs.push({ role: 'user', content: 'thanks' });
    await send(p, msgs);
    assert.equal(fake.spawns.length, 1);
    assert.deepEqual(spawn.inputs[1], ['User:\nthanks']);
    p.dispose();
  });

  it('runs parallel calls one after the other on the CLI side, with all results from one host request', async () => {
    const fake = fakeCli((n, results) =>
      n === 1
        ? {
            calls: [
              { id: 'p1', name: 'mcp__alfred__list_dir', input: { path: 'a' } },
              { id: 'p2', name: 'mcp__alfred__list_dir', input: { path: 'b' } },
            ],
          }
        : { text: results.join(' + ') },
    );
    __setQueryForTests(fake.fn);
    const p = provider(makePool());
    const msgs: Message[] = [{ role: 'user', content: 'both' }];
    const r1 = await send(p, msgs);
    assert.deepEqual(r1.toolCalls?.map((c) => c.id), ['p1', 'p2']);
    msgs.push({ role: 'assistant', content: '', toolCalls: r1.toolCalls }, toolMsg('p1', 'A'), toolMsg('p2', 'B'));
    assert.equal((await send(p, msgs)).content, 'A + B');
    p.dispose();
  });

  it('carries a user message sent while the tool ran with the result, in the same step', async () => {
    const fake = fakeCli((n, results) => (n === 1 ? { calls: [{ id: 'u1', name: 'mcp__alfred__list_dir', input: { path: '.' } }] } : { text: results.join('') }));
    __setQueryForTests(fake.fn);
    const p = provider(makePool());
    const msgs: Message[] = [{ role: 'user', content: 'go' }];
    const r1 = await send(p, msgs);
    msgs.push({ role: 'assistant', content: '', toolCalls: r1.toolCalls }, toolMsg('u1', 'x.txt'), { role: 'user', content: 'and hurry' });
    assert.equal((await send(p, msgs)).content, 'x.txt | User:\nand hurry');
    p.dispose();
  });

  it('answers a call the host never ran with an error, and the turn goes on', async () => {
    const fake = fakeCli((n, results) => (n === 1 ? { calls: [{ id: 'u1', name: 'mcp__alfred__list_dir', input: { path: '.' } }] } : { text: results.join('') }));
    __setQueryForTests(fake.fn);
    const p = provider(makePool());
    const msgs: Message[] = [{ role: 'user', content: 'go' }];
    const r1 = await send(p, msgs);
    // Stopped before the tool ran: the host's next request is a new user message.
    msgs.push({ role: 'assistant', content: '', toolCalls: r1.toolCalls }, { role: 'user', content: 'never mind' });
    const r2 = await send(p, msgs);
    assert.match(r2.content, /^ERROR The host returned no result for this call.* \| User:\nnever mind$/s);
    p.dispose();
  });

  it('resumes a session whose process ended while its calls ran, with the results as text after a note', async () => {
    const fake = fakeCli((n, _r, spawn) =>
      spawn === fake.spawns[0] && n === 1 ? { calls: [{ id: 'u1', name: 'mcp__alfred__list_dir', input: { path: '.' } }] } : { text: 'resumed' },
    );
    __setQueryForTests(fake.fn);
    const sessionsDir = mkdtempSync(join(dir, 's-'));
    const pool = makePool();
    const p1 = provider(pool, sessionsDir);
    const msgs: Message[] = [{ role: 'user', content: 'go' }];
    const r1 = await send(p1, msgs);
    p1.dispose(); // plugin reload: the waiting process is closed
    assert.equal(fake.spawns[0].closed, true);

    const p2 = provider(pool, sessionsDir);
    msgs.push({ role: 'assistant', content: '', toolCalls: r1.toolCalls }, toolMsg('u1', 'a.txt'));
    assert.equal((await send(p2, msgs)).content, 'resumed');
    const resumed = fake.spawns[1];
    assert.equal(resumed.options.resume, 'session-1');
    assert.equal(resumed.options.resumeSessionAt, 'uuid-u1');
    assert.deepEqual(resumed.inputs[0], [LOST_CALLS_NOTE, 'Tool result (list_dir):\na.txt']);
    p2.dispose();
  });

  it('closes a sub-agent process once it called task_complete', async () => {
    const tools: ToolSchema[] = [...TOOLS, { name: 'task_complete', description: 'Done.', parameters: { type: 'object', properties: {} } }];
    const fake = fakeCli(() => ({ calls: [{ id: 'd1', name: 'mcp__alfred__task_complete', input: {} }] }));
    __setQueryForTests(fake.fn);
    const p = provider(makePool());
    const r = await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'do it' }], tools, session: { key: 'sub|w|t1', task: true } });
    assert.equal(r.toolCalls?.[0].name, 'task_complete');
    assert.equal(fake.spawns[0].closed, true);
    p.dispose();
  });
});
