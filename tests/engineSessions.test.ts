// Run: npm test. No network, no CLI: a fake `query()` stands in for the CLI
// process and records every spawn and every user message it receives.
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '@alfred/sdk';
import { AccountPool } from '../src/accounts/pool.js';
import { ClaudeCodeProvider, __setQueryForTests } from '../src/ClaudeCodeProvider.js';
import {
  ASSISTANT_SLOT,
  CACHE_TTL_1H,
  cacheTtlOf,
  EngineSessions,
  messageFingerprint,
  planSession,
  splitVolatileContext,
  systemUpdateNote,
  type EngineSessionRecord,
} from '../src/engineSessions.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
let dir = '';
before(() => {
  dir = mkdtempSync(join(import.meta.dirname, '.tmp-engine-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => __setQueryForTests(null));

const STABLE = `You are Alfred.\n# Tools\n${'list_dir: lists a directory.\n'.repeat(20)}`.trimEnd();
const SYSTEM = `${STABLE}\n# Dynamic Project Context\n#### Open tasks: 9 task(s)`;

type Spawn = { options: Record<string, unknown>; inputs: string[][]; interrupts: number; closed: boolean };

/**
 * A fake CLI. Each `query()` call is one process; it answers each user
 * message it is fed with `reply(n)`, streamed in small chunks, then a result.
 */
function fakeCli(reply: (n: number, spawn: Spawn) => string) {
  const spawns: Spawn[] = [];
  const state = { cacheBreakdown: true };
  const fn = (args: { prompt: string | AsyncIterable<{ message: { content: Array<{ type: string; text?: string }> } }>; options?: Record<string, unknown> }) => {
    const spawn: Spawn = { options: args.options ?? {}, inputs: [], interrupts: 0, closed: false };
    spawns.push(spawn);
    const sid = (args.options?.resume as string | undefined) ?? `session-${spawns.length}`;
    let interrupted = false;
    async function* run() {
      if (typeof args.prompt === 'string') return;
      let n = 0;
      for await (const m of args.prompt) {
        n++;
        spawn.inputs.push(m.message.content.map((b) => (b.type === 'text' ? b.text ?? '' : `[${b.type}]`)));
        yield { type: 'system', subtype: 'init', session_id: sid, tools: [], model: 'claude-opus-5-5' };
        yield {
          type: 'stream_event',
          session_id: sid,
          event: {
            type: 'message_start',
            message: { usage: { input_tokens: 3, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 50, ...(state.cacheBreakdown ? { cache_creation: { ephemeral_1h_input_tokens: 50 } } : {}) } },
          },
        };
        const out = reply(n, spawn);
        for (let i = 0; i < out.length; i += 7) {
          if (interrupted) break;
          yield { type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: out.slice(i, i + 7) } } };
        }
        yield { type: 'stream_event', session_id: sid, event: { type: 'message_delta', usage: { output_tokens: 20 } } };
        yield { type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', is_error: interrupted, session_id: sid, total_cost_usd: 0.01 * n };
        interrupted = false;
      }
    }
    const it = run();
    return {
      [Symbol.asyncIterator]: () => it,
      interrupt: async () => {
        spawn.interrupts++;
        interrupted = true;
      },
      close: () => {
        spawn.closed = true;
        void it.return(undefined);
      },
    };
  };
  return { spawns, fn: fn as never, state };
}

function makePool(): AccountPool {
  const pool = new AccountPool({ dataDir: mkdtempSync(join(dir, 'p-')), logger });
  pool.remove('default');
  for (let i = 1; i <= 2; i++) pool.setToken(pool.add(`Seat ${i}`, 'token').id, `tok-${i}`);
  return pool;
}

const cfg = { oauthToken: '', modelsRaw: 'opus', contextWindow: 200000, pathToClaude: '', requestTimeoutMs: 5000, maxConcurrentRequests: 16, maxParallelTasks: 32 };
const cli = { path: '', native: true, source: 'setting' as const };

function provider(pool: AccountPool, sessionsDir: string) {
  return new ClaudeCodeProvider({ config: cfg, pool, cli, logger, sessionsDir });
}

async function send(p: ClaudeCodeProvider, messages: Message[], key = 'conv-1|dev|') {
  const res = await p.chat({ model: 'opus', messages, session: { key } });
  return res.content;
}

const call = (n: number) => `Listing.\n<tool_call>\n{"name":"list_dir","arguments":{"path":"${n}"}}\n</tool_call>`;

describe('engine sessions: one CLI session per conversation', () => {
  it('runs every iteration and the next turn in the same process, sending only the delta', async () => {
    // Replies 1-3 call a tool (and keep talking, which must be cut), 4 answers.
    const cliFake = fakeCli((n) => (n < 3 ? `${call(n)}\nTool result (list_dir): invented` : n === 3 ? 'DONE' : 'SECOND'));
    __setQueryForTests(cliFake.fn);
    const p = provider(makePool(), mkdtempSync(join(dir, 's-')));
    const msgs: Message[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'list three times' },
    ];
    const r1 = await send(p, msgs);
    assert.match(r1, /<\/tool_call>$/, 'reply cut after its tool call');
    msgs.push({ role: 'assistant', content: 'Listing.', toolCalls: [{ id: 'a', name: 'list_dir', arguments: { path: '1' } }] });
    msgs.push({ role: 'tool', name: 'list_dir', toolCallId: 'a', content: 'a.txt b.txt' });
    await send(p, msgs);
    msgs.push({ role: 'assistant', content: 'Listing.', toolCalls: [{ id: 'b', name: 'list_dir', arguments: { path: '2' } }] });
    msgs.push({ role: 'tool', name: 'list_dir', toolCallId: 'b', content: 'c.txt' });
    assert.equal(await send(p, msgs), 'DONE');
    // Second turn, same conversation.
    msgs.push({ role: 'assistant', content: 'DONE' });
    msgs.push({ role: 'user', content: 'again?' });
    assert.equal(await send(p, msgs), 'SECOND');

    assert.equal(cliFake.spawns.length, 1, 'an iteration must never start a new CLI session');
    const [spawn] = cliFake.spawns;
    assert.equal(spawn.options.maxTurns, undefined);
    assert.equal(spawn.options.systemPrompt, STABLE, 'volatile tail kept out of the system prompt');
    assert.equal(spawn.interrupts, 2, 'cut replies are interrupted, not killed');
    assert.match(spawn.inputs[0][0], /^<system-reminder>[\s\S]*# Dynamic Project Context[\s\S]*9 task\(s\)/);
    assert.equal(spawn.inputs[0][1], 'User:\nlist three times');
    assert.deepEqual(spawn.inputs[1], ['Tool result (list_dir):\na.txt b.txt']);
    assert.deepEqual(spawn.inputs[2], ['Tool result (list_dir):\nc.txt']);
    assert.deepEqual(spawn.inputs[3], ['User:\nagain?']);
    p.dispose();
  });

  it('sends an image a tool returned with the tool result, in the same session', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=';
    const cliFake = fakeCli((n) => (n === 1 ? call(1) : 'red'));
    __setQueryForTests(cliFake.fn);
    const p = provider(makePool(), mkdtempSync(join(dir, 's-')));
    const msgs: Message[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'screenshot it' }];
    await send(p, msgs);
    msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'adb_screenshot', arguments: {} }] });
    msgs.push({ role: 'tool', name: 'adb_screenshot', content: 'captured' });
    // What the host's expandToolImagesForLlm adds after an image-bearing tool result.
    msgs.push({ role: 'user', content: '[image returned by adb_screenshot]', images: [png] });
    assert.equal(await send(p, msgs), 'red');
    assert.equal(cliFake.spawns.length, 1);
    assert.deepEqual(cliFake.spawns[0].inputs[1], [
      'Tool result (adb_screenshot):\ncaptured',
      'User:\n[image returned by adb_screenshot]',
      '[image]',
    ]);
    p.dispose();
  });

  it('resumes the same session on the same seat after the process went away (restart)', async () => {
    const sessionsDir = mkdtempSync(join(dir, 's-'));
    const pool = makePool();
    const cliFake = fakeCli(() => 'ok');
    __setQueryForTests(cliFake.fn);
    const msgs: Message[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }];
    const first = provider(pool, sessionsDir);
    await send(first, msgs);
    first.dispose(); // gateway stops: every process is closed
    msgs.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'still there?' });
    const second = provider(pool, sessionsDir); // gateway is back
    await send(second, msgs);
    assert.equal(cliFake.spawns.length, 2);
    assert.equal(cliFake.spawns[1].options.resume, 'session-1');
    assert.equal(cliFake.spawns[1].options.systemPrompt, STABLE, 'launch prompt reused: it heads the cached prefix');
    assert.deepEqual(cliFake.spawns[1].inputs[0], ['User:\nstill there?']);
    assert.equal(pool.recent[0].accountId, pool.recent[1].accountId, 'same seat');
    second.dispose();
  });

  it('tells a changed system context as a message instead of re-writing the prefix', async () => {
    const cliFake = fakeCli(() => 'ok');
    __setQueryForTests(cliFake.fn);
    const p = provider(makePool(), mkdtempSync(join(dir, 's-')));
    const msgs: Message[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }];
    await send(p, msgs);
    msgs[0] = { role: 'system', content: SYSTEM.replace('9 task(s)', '8 task(s)') };
    msgs.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' });
    await send(p, msgs);
    assert.equal(cliFake.spawns.length, 1);
    const [note, user] = cliFake.spawns[0].inputs[1];
    assert.match(note, /<system-update>[\s\S]*Dynamic Project Context[\s\S]*8 task\(s\)/);
    assert.equal(user, 'User:\nnext');
    p.dispose();
  });

  it('starts a fresh session when the history no longer matches, and keeps agents apart', async () => {
    const cliFake = fakeCli(() => 'ok');
    __setQueryForTests(cliFake.fn);
    const p = provider(makePool(), mkdtempSync(join(dir, 's-')));
    const msgs: Message[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }];
    await send(p, msgs);
    // A sub-agent of the same conversation: its own session.
    await send(p, [{ role: 'system', content: 'child' }, { role: 'user', content: 'task' }], 'conv-1|tester|t1');
    assert.equal(cliFake.spawns.length, 2);
    // Edited first message: the session cannot continue.
    await send(p, [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi (edited)' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'x' }]);
    assert.equal(cliFake.spawns.length, 3);
    assert.equal(cliFake.spawns[0].closed, true);
    assert.equal(cliFake.spawns[2].options.resume, undefined);
    assert.equal(cliFake.spawns[2].inputs[0].length, 4, 'fresh session gets the context and the full history');
    p.dispose();
  });

  it('leaves one-off calls (no thread key) on one-shot processes', async () => {
    const cliFake = fakeCli(() => 'ok');
    __setQueryForTests(cliFake.fn);
    const p = provider(makePool(), mkdtempSync(join(dir, 's-')));
    await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'title?' }] });
    assert.equal(cliFake.spawns[0].options.maxTurns, 1);
    p.dispose();
  });
});

describe('engine sessions: process lifetime', () => {
  it('closes a sub-agent process once it answered, keeps it while it calls tools', async () => {
    const cliFake = fakeCli((n) => (n === 1 ? call(1) : 'result'));
    __setQueryForTests(cliFake.fn);
    const p = provider(makePool(), mkdtempSync(join(dir, 's-')));
    const sessions = (p as unknown as { sessions: EngineSessions }).sessions;
    const msgs: Message[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'task brief' }];
    const ask = () => p.chat({ model: 'opus', messages: msgs, session: { key: 'conv-1|lecteur|t-9', task: true } });
    await ask();
    assert.equal(sessions.liveCount(), 1, 'still working: kept');
    msgs.push({ role: 'assistant', content: 'Listing.', toolCalls: [{ id: 'a', name: 'list_dir', arguments: {} }] });
    msgs.push({ role: 'tool', name: 'list_dir', content: 'x' });
    assert.equal((await ask()).content, 'result');
    assert.equal(sessions.liveCount(), 0, 'answered: closed');
    assert.equal(cliFake.spawns.length, 1);
    p.dispose();
  });

  it('closes a stopped sub-agent process once it stays idle (nothing else would tell it)', async () => {
    const cliFake = fakeCli(() => call(1));
    __setQueryForTests(cliFake.fn);
    const pool = makePool();
    const p = provider(pool, mkdtempSync(join(dir, 's-')));
    const sessions = (p as unknown as { sessions: EngineSessions }).sessions;
    cliFake.state.cacheBreakdown = false;
    sessions.noteTtl(pool.list()[0].id, 20);
    // Its last reply called a tool; then the user pressed Stop: no next request.
    await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'task brief' }], session: { key: 'conv-1|dev|t-2', task: true } });
    assert.equal(sessions.liveCount(), 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sessions.liveCount(), 0);
    assert.equal(cliFake.spawns[0].closed, true);
    p.dispose();
  });

  it('closes a sub-agent process when it reports its task done', async () => {
    const cliFake = fakeCli(() => '<tool_call>\n{"name":"task_complete","arguments":{"summary":"x"}}\n</tool_call>');
    __setQueryForTests(cliFake.fn);
    const p = provider(makePool(), mkdtempSync(join(dir, 's-')));
    const sessions = (p as unknown as { sessions: EngineSessions }).sessions;
    await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'task brief' }], session: { key: 'conv-1|lecteur|t-1', task: true } });
    assert.equal(sessions.liveCount(), 0);
    p.dispose();
  });

  it('closes an idle process when its seat prompt cache expires, and the conversation resumes', async () => {
    const sessionsDir = mkdtempSync(join(dir, 's-'));
    const cliFake = fakeCli(() => 'ok');
    __setQueryForTests(cliFake.fn);
    const pool = makePool();
    const p = provider(pool, sessionsDir);
    const sessions = (p as unknown as { sessions: EngineSessions }).sessions;
    const msgs: Message[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }];
    await send(p, msgs);
    // The fake reported a 1 h cache; shrink it to observe the expiry (and
    // stop reporting it, so the next reply does not set it back to 1 h).
    sessions.noteTtl(pool.recent[0].accountId, 20);
    cliFake.state.cacheBreakdown = false;
    msgs.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'two' });
    await send(p, msgs);
    assert.equal(sessions.liveCount(), 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sessions.liveCount(), 0, 'closed once the cache would have expired');
    assert.equal(cliFake.spawns[0].closed, true);
    msgs.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'days later' });
    assert.equal(await send(p, msgs), 'ok');
    assert.equal(cliFake.spawns.length, 2);
    assert.equal(cliFake.spawns[1].options.resume, 'session-1', 'same session, resumed');
    assert.deepEqual(cliFake.spawns[1].inputs[0], ['User:\ndays later']);
    p.dispose();
  });
});

describe('engine sessions: planning', () => {
  it('keeps the volatile tail of the system prompt apart', () => {
    assert.deepEqual(splitVolatileContext(SYSTEM), { stable: STABLE, volatile: '# Dynamic Project Context\n#### Open tasks: 9 task(s)' });
    assert.deepEqual(splitVolatileContext('persona\n\n## Runtime\nRuntime: agent=dev'), { stable: 'persona', volatile: '## Runtime\nRuntime: agent=dev' });
    assert.deepEqual(splitVolatileContext('plain'), { stable: 'plain', volatile: '' });
  });

  const user = (c: string): Message => ({ role: 'user', content: c });
  const rec = (history: string[]): EngineSessionRecord => ({
    key: 'k',
    sessionId: 's',
    accountId: 'a',
    launchSystem: SYSTEM,
    currentSystem: SYSTEM,
    history,
    updatedAt: 0,
  });

  it('continues with the new user and tool messages only', () => {
    const plan = planSession(rec([messageFingerprint(user('hi')), ASSISTANT_SLOT]), {
      accountId: 'a',
      system: SYSTEM,
      messages: [user('hi'), { role: 'assistant', content: 'whatever Alfred kept' }, { role: 'tool', content: 'r' }],
    });
    assert.equal(plan.kind, 'continue');
    assert.deepEqual(plan.kind === 'continue' && plan.delta.map((m) => m.role), ['tool']);
  });

  it('refuses another seat, a replay, or an assistant message it did not write', () => {
    const r = rec([messageFingerprint(user('hi')), ASSISTANT_SLOT]);
    assert.equal(planSession(r, { accountId: 'b', system: SYSTEM, messages: [user('hi'), user('x'), user('y')] }).kind, 'fresh');
    assert.equal(planSession(r, { accountId: 'a', system: SYSTEM, messages: [user('hi'), { role: 'assistant', content: 'x' }] }).kind, 'fresh');
    assert.equal(
      planSession(r, { accountId: 'a', system: SYSTEM, messages: [user('hi'), { role: 'assistant', content: 'x' }, { role: 'assistant', content: 'y' }] }).kind,
      'fresh',
    );
  });

  it('summarises a small system change and rejects a rewrite', () => {
    assert.equal(systemUpdateNote(SYSTEM, SYSTEM), null);
    assert.match(String(systemUpdateNote(SYSTEM, SYSTEM.replace('9', '8'))), /Now reads:\n#### Open tasks: 8/);
    assert.equal(systemUpdateNote(SYSTEM, 'something else entirely'), 'too-large');
  });

  it('reads the cache TTL from the response usage', () => {
    assert.equal(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 } }), CACHE_TTL_1H);
    assert.equal(cacheTtlOf({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }), null);
  });
});
