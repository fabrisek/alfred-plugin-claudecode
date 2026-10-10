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
  LiveSession,
  messageFingerprint,
  PushQueue,
  planSession,
  splitVolatileContext,
  systemUpdateNote,
  type EngineSessionRecord,
} from '../src/engineSessions.js';
import { HOST_CUT_NOTE } from '../src/hostCutNote.js';

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
    // A host-cut reply left the CLI's interrupt marker: the note explains it.
    assert.deepEqual(spawn.inputs[1], [HOST_CUT_NOTE, 'Tool result (list_dir):\na.txt b.txt']);
    assert.deepEqual(spawn.inputs[2], [HOST_CUT_NOTE, 'Tool result (list_dir):\nc.txt']);
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

  it('closes a stopped sub-agent process at once on endSession, and its next message resumes the same session', async () => {
    let replies = 0;
    const cliFake = fakeCli(() => (++replies === 1 ? call(1) : 'carried on'));
    __setQueryForTests(cliFake.fn);
    const pool = makePool();
    const p = provider(pool, mkdtempSync(join(dir, 's-')));
    const sessions = (p as unknown as { sessions: EngineSessions }).sessions;
    const key = 'par-r-1|dev|';
    const msgs: Message[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'task brief' }];
    // Its reply called a tool; the user pressed Stop while the tool ran.
    await p.chat({ model: 'opus', messages: msgs, session: { key, task: true } });
    assert.equal(sessions.liveCount(), 1);
    // A top-level thread is kept warm…
    await p.endSession({ key, task: false }, 'stopped');
    assert.equal(sessions.liveCount(), 1);
    // …a sub-agent's process goes now, not after the idle timeout.
    await p.endSession({ key, task: true }, 'stopped');
    assert.equal(sessions.liveCount(), 0);
    assert.equal(cliFake.spawns[0].closed, true);
    // Nothing deleted: the record stays, and the user's next message resumes
    // the same CLI session with only what is new.
    const sid = sessions.record(key)?.sessionId;
    assert.equal(sid, 'session-1');
    msgs.push({ role: 'assistant', content: 'Listing.', toolCalls: [{ id: 'a', name: 'list_dir', arguments: {} }] });
    msgs.push({ role: 'tool', name: 'list_dir', content: 'aborted' });
    msgs.push({ role: 'user', content: 'go on please' });
    const res = await p.chat({ model: 'opus', messages: msgs, session: { key, task: true } });
    assert.equal(res.content, 'carried on');
    assert.equal(cliFake.spawns.length, 2);
    assert.equal(cliFake.spawns[1].options.resume, 'session-1');
    assert.ok(!cliFake.spawns[1].inputs[0].join(' ').includes('task brief'), 'delta only: the session holds the brief');
    assert.ok(cliFake.spawns[1].inputs[0].join(' ').includes('go on please'));
    p.dispose();
  });

  it('keeps the session record when a request is stopped before the CLI settles', async () => {
    const pool = makePool();
    const p = provider(pool, mkdtempSync(join(dir, 's-')));
    const sessions = (p as unknown as { sessions: EngineSessions }).sessions;
    const key = 'par-r-2|dev|';
    // First request settles normally: the record knows the session id.
    let hang = false;
    const base = fakeCli(() => call(1));
    const fn = (args: Parameters<typeof base.fn>[0]) => {
      const q = (base.fn as unknown as (a: unknown) => { [Symbol.asyncIterator]: () => AsyncIterator<unknown>; interrupt: () => Promise<void>; close: () => void })(args);
      const inner = q[Symbol.asyncIterator]();
      let closed = false;
      let wake: (() => void) | null = null;
      return {
        ...q,
        // Second request: the CLI ignores the interrupt and never answers.
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (!hang) return inner.next();
            await new Promise<void>((r) => {
              wake = r;
              if (closed) r();
            });
            return { done: true, value: undefined };
          },
        }),
        close: () => {
          closed = true;
          wake?.();
          q.close();
        },
      };
    };
    __setQueryForTests(fn as never);
    const msgs: Message[] = [{ role: 'user', content: 'task brief' }];
    await p.chat({ model: 'opus', messages: msgs, session: { key, task: true } });
    assert.equal(sessions.record(key)?.sessionId, 'session-1');
    msgs.push({ role: 'assistant', content: 'Listing.', toolCalls: [{ id: 'a', name: 'list_dir', arguments: {} }] });
    msgs.push({ role: 'tool', name: 'list_dir', content: 'x' });
    hang = true;
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    const started = Date.now();
    await p.chat({ model: 'opus', messages: msgs, session: { key, task: true }, signal: ctl.signal }).catch(() => undefined);
    assert.ok(Date.now() - started < 20_000, 'the stop fallback ended the request');
    assert.equal(sessions.liveCount(), 0);
    assert.equal(sessions.record(key)?.sessionId, 'session-1', 'the session survives the stop');
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

describe('engine sessions: seat switch', () => {
  /**
   * A fake CLI whose replies carry transcript uuids, and whose seat (from the
   * spawn env) can be made to answer with a usage-limit error.
   */
  function seatCli(limitedSeat: { token: string | null }) {
    const spawns: Array<{ options: Record<string, unknown>; inputs: string[]; seatToken: string }> = [];
    const fn = (args: { prompt: AsyncIterable<{ message: { content: Array<{ type: string; text?: string }> } }>; options: Record<string, unknown> }) => {
      const env = (args.options.env ?? {}) as Record<string, string>;
      const seatToken = env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
      const spawn = { options: args.options, inputs: [] as string[], seatToken };
      spawns.push(spawn);
      const sid = (args.options.resume as string | undefined) ?? `session-${spawns.length}`;
      async function* run() {
        let n = 0;
        for await (const m of args.prompt) {
          n++;
          spawn.inputs.push(m.message.content.map((b) => b.text ?? '').join(' '));
          yield { type: 'system', subtype: 'init', session_id: sid, tools: [], model: 'claude-haiku' };
          if (limitedSeat.token === seatToken) {
            yield { type: 'assistant', error: 'rate_limit', session_id: sid, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your usage limit · resets 5am" }] } };
            yield { type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit · resets 5am", session_id: sid };
            continue;
          }
          const text = `reply ${spawns.length}.${n}`;
          yield { type: 'stream_event', session_id: sid, event: { type: 'message_start', message: { usage: { input_tokens: 3, cache_creation_input_tokens: 4000 } } } };
          yield { type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
          yield { type: 'assistant', uuid: `uuid-${spawns.length}-${n}`, session_id: sid, message: { model: 'claude-haiku', content: [{ type: 'text', text }] } };
          yield { type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: 0.001 };
        }
      }
      const it = run();
      return { [Symbol.asyncIterator]: () => it, interrupt: async () => {}, close: () => void it.return(undefined) };
    };
    return { spawns, fn: fn as never };
  }

  it('continues the same session on the next seat when the seat runs out, sending only the delta', async () => {
    const limited = { token: null as string | null };
    const fake = seatCli(limited);
    __setQueryForTests(fake.fn);
    const pool = makePool();
    const [a, b] = pool.list();
    const p = new ClaudeCodeProvider({ config: cfg, pool, cli, logger, sessionsDir: mkdtempSync(join(dir, 's-')), crossSeat: () => true });
    const sessions = (p as unknown as { sessions: EngineSessions }).sessions;
    const key = 'conv-seat|dev|';
    const msgs: Message[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'remember ORCA-5' }];
    const first = await p.chat({ model: 'opus', messages: msgs, session: { key } });
    assert.equal(first.content, 'reply 1.1');
    assert.equal(sessions.record(key)?.accountId, a.id);
    assert.equal(sessions.record(key)?.lastUuid, 'uuid-1-1');

    // Seat A runs out in the middle of the next request.
    limited.token = pool.tokenFor(a);
    msgs.push({ role: 'assistant', content: first.content }, { role: 'user', content: 'what was the word?' });
    const second = await p.chat({ model: 'opus', messages: msgs, session: { key } });
    assert.equal(second.content, 'reply 2.1');
    // A's process got the delta and failed; B resumed the SAME session at the
    // last kept reply, and got the delta once — not the whole history.
    assert.equal(fake.spawns.length, 2);
    assert.deepEqual(fake.spawns[0].inputs.slice(1), ['User:\nwhat was the word?'], "A's live process: the delta, then the limit");
    const onB = fake.spawns[1];
    assert.equal(onB.seatToken, pool.tokenFor(b));
    assert.equal(onB.options.resume, 'session-1');
    assert.equal(onB.options.resumeSessionAt, 'uuid-1-1');
    assert.deepEqual(onB.inputs, ['User:\nwhat was the word?']);
    assert.equal(sessions.record(key)?.accountId, b.id);
    assert.equal(sessions.record(key)?.sessionId, 'session-1');
    p.dispose();
  });

  it('plans a resume on another seat only when the seats share their sessions', () => {
    const user = (c: string): Message => ({ role: 'user', content: c });
    const r = { key: 'k', sessionId: 's', accountId: 'A', launchSystem: SYSTEM, currentSystem: SYSTEM, history: [messageFingerprint(user('hi')), ASSISTANT_SLOT], updatedAt: 0 };
    const req = { accountId: 'B', system: SYSTEM, messages: [user('hi'), { role: 'assistant', content: 'x' } as Message, user('next')] };
    assert.equal(planSession(r, req).kind, 'fresh');
    const plan = planSession(r, { ...req, crossSeat: true });
    assert.deepEqual(plan.kind === 'continue' && plan.delta.map((m) => m.content), ['next']);
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

  it('continues after a stopped reply, whether or not Alfred kept it', () => {
    const history = [messageFingerprint(user('hi')), ASSISTANT_SLOT, messageFingerprint({ role: 'tool', content: 'r' }), ASSISTANT_SLOT];
    const stopped = { ...rec(history), interruptedTail: true };
    const base: Message[] = [user('hi'), { role: 'assistant', content: 'call' }, { role: 'tool', content: 'r' }];
    // Dropped by Alfred: the next user message follows the session's cut reply.
    const dropped = planSession(stopped, { accountId: 'a', system: SYSTEM, messages: [...base, user('go on')] });
    assert.equal(dropped.kind, 'continue');
    assert.deepEqual(dropped.kind === 'continue' && dropped.delta.map((m) => m.content), ['go on']);
    // Kept (what had streamed): same.
    const kept = planSession(stopped, {
      accountId: 'a',
      system: SYSTEM,
      messages: [...base, { role: 'assistant', content: 'partial' }, user('go on')],
    });
    assert.deepEqual(kept.kind === 'continue' && kept.delta.map((m) => m.content), ['go on']);
    // Without the flag, a missing reply is a replay: fresh.
    assert.equal(planSession(rec(history), { accountId: 'a', system: SYSTEM, messages: [...base, user('go on')] }).kind, 'fresh');
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

describe('engine sessions: plugin unload and lost processes', () => {
  /** A live session over a query that only records whether it was closed. */
  const liveSession = (key: string) => {
    const state = { closed: false };
    const query = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
      close: () => {
        state.closed = true;
      },
    };
    return { session: new LiveSession(key, 'seat', 'opus', null, query, new PushQueue<unknown>(), new AbortController()), state };
  };

  it('lets a busy process finish its reply on dispose, and closes the idle ones at once', () => {
    const sessions = new EngineSessions(mkdtempSync(join(dir, 'u-')), logger);
    const busy = liveSession('busy|dev|');
    const idle = liveSession('idle|dev|');
    sessions.add(busy.session);
    sessions.add(idle.session);
    busy.session.busy = true;
    sessions.dispose();
    assert.equal(idle.state.closed, true, 'idle: closed now');
    assert.equal(busy.state.closed, false, 'mid-reply: not killed');
    assert.equal(sessions.hasRoom(), false, 'an unloading plugin starts no process');
    sessions.release(busy.session);
    assert.equal(busy.state.closed, true, 'closed once its reply is out');
    assert.equal(sessions.liveCount(), 0);
  });

  it('closes a process by identity, never a newer one under the same key', () => {
    const sessions = new EngineSessions(mkdtempSync(join(dir, 'u-')), logger);
    const old = liveSession('k|dev|');
    const newer = liveSession('k|dev|');
    sessions.add(old.session);
    sessions.add(newer.session);
    sessions.closeSession(old.session, 'late finally');
    assert.equal(old.state.closed, true);
    assert.equal(newer.state.closed, false);
    assert.equal(sessions.getLive('k|dev|'), newer.session);
    sessions.dispose();
  });

  it('leaves a tombstone for a lost process, and the next request starts fresh', () => {
    const sessions = new EngineSessions(mkdtempSync(join(dir, 'u-')), logger);
    sessions.markLost('k|dev|', 'seat', 'Claude Code session process ended before its reply');
    const rec = sessions.record('k|dev|');
    assert.equal(rec?.sessionId, null);
    assert.match(String(rec?.lostReason), /ended before its reply/);
    assert.equal(planSession(rec, { accountId: 'seat', system: SYSTEM, messages: [{ role: 'user', content: 'x' }] }).kind, 'fresh');
  });
});
