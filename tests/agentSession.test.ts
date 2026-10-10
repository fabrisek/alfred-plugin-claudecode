// Claude session adapter (CLI agent mode) against a fake SDK `query` that
// replays recorded fixtures and reads the adapter's streaming input like the
// real CLI does. No network, no CLI.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEvent, SessionTurnRequest } from '@alfred/sdk';
import { AccountPool } from '../src/accounts/pool.js';
import { __setQueryForTests } from '../src/ClaudeCodeProvider.js';
import { SessionIndex } from '../src/session/sessions.js';
import {
  CONTINUE_DIRECTIVE,
  ClaudeSessionAdapter,
  DEFAULT_CHAT_SESSION_CONFIG,
  buildAppendPrompt,
  clampPermissionMode,
  sessionCapabilities,
} from '../src/agentSession/ClaudeSessionAdapter.js';
import { ClaudeCodeSessionProvider } from '../src/agentSession/ClaudeSessionProvider.js';
import { loadFixture } from './fixtureLoader.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
let dir = '';
const SID = '9c56eaa8-81f6-4c7f-b75f-e91fd16524e2';
const CWD = process.platform === 'win32' ? 'C:\\Work\\Proj' : '/Work/Proj';

before(() => {
  dir = mkdtempSync(join(import.meta.dirname, '.tmp-agent-'));
});
after(() => {
  __setQueryForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function makePool(n: number): AccountPool {
  const pool = new AccountPool({ dataDir: mkdtempSync(join(dir, 'p-')), logger });
  pool.remove('default');
  for (let i = 1; i <= n; i++) pool.setToken(pool.add(`Seat ${i}`, 'token').id, `tok-${i}`);
  return pool;
}

type Msg = Record<string, unknown>;
/** Script steps: an SDK message, or a directive for the fake CLI. */
type Step = Msg | { __waitInputs: number } | { __echo: number } | { __throw: string } | { __sleep: number };

/**
 * A fixture as the fake CLI plays it: each replay echo waits for the input it
 * acknowledges and carries that input's uuid, harness markers are dropped.
 */
function fromFixture(name: string, opts: { stopAt?: string } = {}): Step[] {
  const steps: Step[] = [];
  let echo = 0;
  for (const m of loadFixture(name)) {
    if (m.type === '_fixture') {
      if (opts.stopAt && m.action === opts.stopAt) break;
      continue;
    }
    if (m.type === 'user' && m.isReplay === true) {
      steps.push({ __waitInputs: echo + 1 }, { __echo: echo });
      echo += 1;
    } else steps.push(m);
  }
  return steps;
}

type Call = { token: string; options: Record<string, unknown>; inputs: Msg[]; interrupted: boolean };

function fakeQuery(byToken: Record<string, Step[] | ((call: Call) => Step[])>, calls: Call[]) {
  return ((args: { prompt: AsyncIterable<Msg>; options: Record<string, unknown> & { env?: Record<string, string>; abortController?: AbortController } }) => {
    const token = args.options.env?.CLAUDE_CODE_OAUTH_TOKEN ?? '';
    const call: Call = { token, options: args.options, inputs: [], interrupted: false };
    calls.push(call);
    let wake: (() => void) | null = null;
    let inputDone = false;
    void (async () => {
      for await (const m of args.prompt) {
        call.inputs.push(m);
        wake?.();
      }
      inputDone = true;
      wake?.();
    })();
    const entry = byToken[token] ?? [];
    const script = typeof entry === 'function' ? entry(call) : entry;
    const signal = args.options.abortController?.signal;
    const gen = (async function* () {
      for (const step of script) {
        if (signal?.aborted) throw new Error('aborted');
        if ('__waitInputs' in step) {
          while (call.inputs.length < (step.__waitInputs as number) && !inputDone && !signal?.aborted) {
            await new Promise<void>((r) => {
              wake = r;
              signal?.addEventListener('abort', () => r(), { once: true });
            });
          }
          if (call.inputs.length < (step.__waitInputs as number)) return;
          continue;
        }
        if ('__echo' in step) {
          const inp = call.inputs[step.__echo as number];
          yield { type: 'user', isReplay: true, uuid: inp.uuid, message: inp.message, parent_tool_use_id: null };
          continue;
        }
        if ('__sleep' in step) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, step.__sleep as number);
            signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
          });
          continue;
        }
        if ('__throw' in step) throw new Error(String(step.__throw));
        yield step;
      }
      // The real CLI exits on stdin EOF: wait for it.
      while (!inputDone && !signal?.aborted) {
        await new Promise<void>((r) => {
          wake = r;
          signal?.addEventListener('abort', () => r(), { once: true });
        });
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        call.interrupted = true;
      },
    });
  }) as never;
}

const cli = { path: '', native: true, source: 'setting' as const };

function makeAdapter(pool: AccountPool, crossSeat = true, heartbeatMs?: number) {
  const sessions = new SessionIndex(join(dir, `idx-${Math.random().toString(36).slice(2)}.json`));
  const adapter = new ClaudeSessionAdapter({
    pool,
    cli,
    sessions,
    logger,
    config: { ...DEFAULT_CHAT_SESSION_CONFIG, startTimeoutMs: 5_000 },
    crossSeat: () => crossSeat,
    heartbeatMs,
  });
  return { adapter, sessions };
}

function request(over: Partial<SessionTurnRequest> = {}): SessionTurnRequest {
  return {
    turnId: `turn-${Math.random().toString(36).slice(2)}`,
    conversationId: 'conv-1',
    agentId: 'dev',
    cwd: CWD,
    additionalDirectories: [],
    input: { clientMessageId: 'c1', text: 'Reply with exactly: hi' },
    model: 'haiku',
    permissionMode: 'bypassPermissions',
    persona: 'You are Dev, a careful engineer.',
    mcpServers: [],
    ...over,
  };
}

async function collect(it: AsyncIterable<SessionEvent>, onEvent?: (e: SessionEvent) => void | Promise<void>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of it) {
    out.push(e);
    await onEvent?.(e);
  }
  return out;
}

const of = <T extends SessionEvent['type']>(events: SessionEvent[], type: T) =>
  events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);

describe('claude session adapter', () => {
  it('plain turn: options, ack, events, exactly one turn_end, session recorded with its exact cwd', async () => {
    const pool = makePool(1);
    const calls: Call[] = [];
    __setQueryForTests(fakeQuery({ 'tok-1': fromFixture('plain') }, calls));
    const { adapter, sessions } = makeAdapter(pool);
    const mcp = [{ name: 'alfred', transport: 'http' as const, url: 'http://127.0.0.1:4242/api/mcp', headers: { Authorization: 'Bearer x' }, toolTimeoutMs: 3_600_000 }];
    const events = await collect(adapter.runSessionTurn(request({ mcpServers: mcp, effort: 'high' })));

    const ends = of(events, 'turn_end');
    assert.equal(ends.length, 1);
    assert.equal(events.at(-1)?.type, 'turn_end');
    assert.equal(ends[0].stopReason, 'end_turn');
    assert.equal(ends[0].resultText, 'hi');
    assert.ok(ends[0].usage?.costUsd! > 0);
    assert.deepEqual(of(events, 'input_ack'), [{ type: 'input_ack', clientMessageId: 'c1', delivery: 'now' }]);
    assert.equal(of(events, 'session')[0].ref.cwd, CWD);
    assert.equal(of(events, 'usage').at(-1)?.scope, 'turn');

    const o = calls[0].options;
    assert.equal(o.cwd, CWD);
    assert.equal(o.model, 'haiku');
    assert.equal(o.permissionMode, 'bypassPermissions');
    assert.equal(o.allowDangerouslySkipPermissions, true);
    assert.equal(o.effort, 'high');
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.includePartialMessages, true);
    assert.equal(o.resume, undefined);
    // Not the user level: no synced organization skills or plugins.
    assert.deepEqual(o.settingSources, ['project', 'local']);
    // No auto-memory (shared projects/ dir) and no claude.ai connectors.
    assert.equal((o.env as Record<string, string>).CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal((o.env as Record<string, string>).ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    const sp = o.systemPrompt as { type: string; preset: string; append: string; snapshot: boolean };
    assert.equal(sp.preset, 'claude_code');
    assert.equal(sp.snapshot, false);
    assert.match(sp.append, /^You are Dev/);
    assert.match(sp.append, /mcp__alfred__\*/);
    assert.match(sp.append, /never the user's task board/);
    assert.deepEqual(o.mcpServers, { alfred: { type: 'http', url: mcp[0].url, headers: mcp[0].headers, timeout: 3_600_000 } });
    assert.equal((o.env as Record<string, string>).MCP_TOOL_TIMEOUT, '3600000');
    assert.equal((o.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, 'tok-1');

    assert.deepEqual(sessions.get(SID)?.cwd, CWD);
    assert.equal(sessions.get(SID)?.accountId, 'seat-1');
    assert.ok(sessions.get(SID)?.totals?.costUsd! > 0, 'cumulative totals kept for the next turn');
    assert.equal(pool.recent[0].kind, 'session');
    assert.equal(pool.recent[0].outcome, 'ok');
    assert.equal(adapter.liveTurns, 0);
    assert.deepEqual(await adapter.sendSessionInput('gone', { clientMessageId: 'x', text: 'late' }), {
      accepted: false,
      reason: 'no live turn with this id',
    });
  });

  it('resume: options.resume + the recorded exact cwd; a new session can carry a pre-assigned id', async () => {
    const pool = makePool(1);
    const calls: Call[] = [];
    __setQueryForTests(fakeQuery({ 'tok-1': fromFixture('resume') }, calls));
    const { adapter } = makeAdapter(pool);
    const events = await collect(
      adapter.runSessionTurn(request({ cwd: 'c:\\work\\proj', resume: { sessionId: SID, cwd: CWD, seatId: 'seat-1' } })),
    );
    assert.equal(calls[0].options.resume, SID);
    assert.equal(calls[0].options.cwd, CWD, 'the session cwd wins over the request cwd');
    assert.equal(of(events, 'session')[0].resumed, true);

    const fresh = '11111111-2222-4333-8444-555555555555';
    __setQueryForTests(fakeQuery({ 'tok-1': fromFixture('plain') }, calls));
    await collect(adapter.runSessionTurn(request({ newSessionId: fresh })));
    assert.equal(calls[1].options.sessionId, fresh);
    assert.equal(calls[1].options.resume, undefined);
  });

  it('a message sent mid-turn is folded into the running turn and acknowledged', async () => {
    const pool = makePool(1);
    const calls: Call[] = [];
    __setQueryForTests(fakeQuery({ 'tok-1': fromFixture('midturn') }, calls));
    const { adapter } = makeAdapter(pool);
    const req = request({ input: { clientMessageId: 'c1', text: 'Run sleep' } });
    let sent: unknown;
    const events = await collect(adapter.runSessionTurn(req), async (e) => {
      if (e.type === 'tool_start' && !sent) sent = await adapter.sendSessionInput(req.turnId, { clientMessageId: 'c2', text: 'Also: 2+2?' });
    });
    assert.deepEqual(sent, { accepted: true });
    assert.deepEqual(of(events, 'input_ack').map((a) => a.clientMessageId), ['c1', 'c2']);
    assert.equal(of(events, 'turn_end').length, 1);
    assert.match(of(events, 'turn_end')[0].resultText ?? '', /2\+2 (=|is) 4/);
    assert.equal(calls[0].inputs.length, 2);
    assert.equal((calls[0].inputs[1].message as { content: Array<{ text: string }> }).content.at(-1)?.text, 'Also: 2+2?');
  });

  it('interrupt: graceful CLI interrupt, turn ends as interrupted even though the SDK throws', async () => {
    const pool = makePool(1);
    const calls: Call[] = [];
    const script = (call: Call): Step[] => {
      const steps = fromFixture('interrupt', { stopAt: 'interrupt' });
      const rest = fromFixture('interrupt').slice(steps.length);
      return [
        ...steps,
        // Wait for the adapter to interrupt, then play the CLI's answer.
        { __sleep: 50 },
        ...rest.filter((s) => !('__echo' in s) && !('__waitInputs' in s)),
        { __throw: 'Claude Code returned an error result: [ede_diagnostic] result_type=user' },
      ].map((s) => s) as Step[];
      void call;
    };
    __setQueryForTests(fakeQuery({ 'tok-1': script }, calls));
    const { adapter } = makeAdapter(pool);
    const req = request();
    const events = await collect(adapter.runSessionTurn(req), async (e) => {
      if (e.type === 'tool_start') await adapter.interruptSessionTurn(req.turnId);
    });
    assert.equal(calls[0].interrupted, true);
    const [end] = of(events, 'turn_end');
    assert.equal(end.stopReason, 'interrupted');
    assert.equal(end.error, undefined);
    assert.equal(pool.runtime('seat-1').exhaustedUntil, undefined, 'an interrupt is not a seat failure');
  });

  it('limit mid-turn: bench the seat, switch, resume the same session with the continue directive', async () => {
    const pool = makePool(2);
    const calls: Call[] = [];
    const reset = Math.floor(Date.now() / 1000) + 7200;
    __setQueryForTests(
      fakeQuery(
        {
          'tok-1': [
            ...fromFixture('plain').filter((s) => !('type' in s) || s.type !== 'result'),
            { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour' } },
            { type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] } },
            { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", session_id: SID },
            { __throw: "Claude Code returned an error result: You've hit your limit" },
          ],
          'tok-2': [{ __waitInputs: 1 }, ...fromFixture('resume').filter((s) => !('__waitInputs' in s))],
        },
        calls,
      ),
    );
    const { adapter } = makeAdapter(pool, true);
    const events = await collect(adapter.runSessionTurn(request()));
    assert.deepEqual(calls.map((c) => c.token), ['tok-1', 'tok-2']);
    const [sw] = of(events, 'seat_switch');
    assert.equal(sw.from, 'seat-1');
    assert.equal(sw.to, 'seat-2');
    assert.equal(calls[1].options.resume, SID);
    const directive = (calls[1].inputs[0].message as { content: Array<{ text: string }> }).content.at(-1)?.text;
    assert.equal(directive, CONTINUE_DIRECTIVE, 'the first input was already in the transcript');
    assert.equal(pool.runtime('seat-1').exhaustedUntil, reset * 1000);
    assert.equal(of(events, 'turn_end').length, 1);
    assert.equal(of(events, 'turn_end')[0].stopReason, 'end_turn');
    assert.equal(of(events, 'session').at(-1)?.ref.seatId, 'seat-2');
  });

  it('no seat left: turn_end limit with the earliest reset (the core arms auto-resume on it)', async () => {
    const pool = makePool(1);
    const reset = Math.floor(Date.now() / 1000) + 3600;
    __setQueryForTests(
      fakeQuery(
        {
          'tok-1': [
            { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: reset, rateLimitType: 'five_hour' } },
            { type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] } },
            { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" },
          ],
        },
        [],
      ),
    );
    const { adapter } = makeAdapter(pool);
    const events = await collect(adapter.runSessionTurn(request()));
    const [end] = of(events, 'turn_end');
    assert.equal(end.stopReason, 'limit');
    assert.equal(end.error?.kind, 'limit');
    assert.equal(end.error?.resetsAt, reset * 1000);
  });

  it('without a shared store, a resumed session is not moved to another seat', async () => {
    const pool = makePool(2);
    const calls: Call[] = [];
    __setQueryForTests(
      fakeQuery({ 'tok-1': [{ type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Claude AI usage limit reached|1791484800' }] } }, { type: 'result', subtype: 'success', is_error: true, result: 'limit' }] }, calls),
    );
    const { adapter } = makeAdapter(pool, false);
    const events = await collect(adapter.runSessionTurn(request({ resume: { sessionId: SID, cwd: CWD, seatId: 'seat-1' } })));
    assert.deepEqual(calls.map((c) => c.token), ['tok-1']);
    assert.equal(of(events, 'turn_end')[0].stopReason, 'limit');
  });

  it('heartbeats while the CLI is silent; a hard stop kills it', async () => {
    const pool = makePool(1);
    const calls: Call[] = [];
    __setQueryForTests(fakeQuery({ 'tok-1': [...fromFixture('plain').slice(0, 3), { __sleep: 10_000 }] }, calls));
    const { adapter } = makeAdapter(pool, true, 20);
    const ac = new AbortController();
    const events: SessionEvent[] = [];
    const started = Date.now();
    for await (const e of adapter.runSessionTurn(request({ signal: ac.signal }))) {
      events.push(e);
      if (of(events, 'heartbeat').length >= 3) ac.abort();
    }
    assert.ok(Date.now() - started < 5_000, 'the abort ends the turn at once');
    assert.ok(of(events, 'heartbeat').length >= 3);
    assert.equal((calls[0].options.abortController as AbortController).signal.aborted, true, 'CLI killed');
    assert.equal(adapter.liveTurns, 0);
  });

  it('permission modes: default bypass, clamped to the ceiling, non-bypass refuses what needs approval', async () => {
    assert.equal(clampPermissionMode(undefined, 'bypassPermissions', 'bypassPermissions'), 'bypassPermissions');
    assert.equal(clampPermissionMode('bypassPermissions', 'acceptEdits', 'auto'), 'auto');
    assert.equal(clampPermissionMode('nonsense', 'plan', 'auto'), 'plan');
    const caps = sessionCapabilities({ ...DEFAULT_CHAT_SESSION_CONFIG, permissionModeMax: 'auto' }, true);
    assert.deepEqual(caps.permissionModes, ['plan', 'acceptEdits', 'auto']);
    assert.equal(caps.defaultPermissionMode, 'auto');
    assert.equal(caps.midTurnInput, 'native');
    assert.equal(caps.resumeAcrossSeats, true);

    const pool = makePool(1);
    const calls: Call[] = [];
    __setQueryForTests(fakeQuery({ 'tok-1': fromFixture('plain') }, calls));
    const { adapter } = makeAdapter(pool);
    await collect(adapter.runSessionTurn(request({ permissionMode: 'acceptEdits' })));
    const o = calls[0].options;
    assert.equal(o.permissionMode, 'acceptEdits');
    assert.equal(o.allowDangerouslySkipPermissions, undefined);
    const verdict = await (o.canUseTool as (n: string) => Promise<{ behavior: string; message: string }>)('Bash');
    assert.equal(verdict.behavior, 'deny');
    assert.match(verdict.message, /permission mode \(acceptEdits\)/);
  });

  it('images and attached files reach the CLI as one user message', async () => {
    const pool = makePool(1);
    const calls: Call[] = [];
    __setQueryForTests(fakeQuery({ 'tok-1': fromFixture('image') }, calls));
    const { adapter } = makeAdapter(pool);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=';
    await collect(
      adapter.runSessionTurn(
        request({
          input: {
            clientMessageId: 'c1',
            text: 'What colour?',
            images: [{ mimeType: 'image/png', data: png }],
            files: [{ name: 'spec.pdf', mimeType: 'application/pdf', path: 'C:\\in\\spec.pdf' }],
          },
        }),
      ),
    );
    const content = (calls[0].inputs[0].message as { content: Array<Record<string, unknown>> }).content;
    assert.equal(content[0].type, 'image');
    assert.deepEqual(content[0].source, { type: 'base64', media_type: 'image/png', data: png });
    assert.match(String(content[1].text), /What colour\?[\s\S]*spec\.pdf \(application\/pdf\): C:\\in\\spec\.pdf/);
  });

  it('the provider facet: capabilities, session idle budget, delegation to the adapter', () => {
    const pool = makePool(1);
    const { adapter } = makeAdapter(pool);
    const caps = sessionCapabilities(DEFAULT_CHAT_SESSION_CONFIG, true);
    const p = new ClaudeCodeSessionProvider(
      { config: { oauthToken: '', modelsRaw: 'opus', contextWindow: 200000, pathToClaude: '', requestTimeoutMs: 5000, maxConcurrentRequests: 0, maxParallelTasks: 0 }, pool, cli, logger },
      adapter,
      caps,
    );
    assert.equal(typeof p.runSessionTurn, 'function');
    assert.equal(p.agentSession.defaultPermissionMode, 'bypassPermissions');
    assert.equal(p.getRuntimeConfig().sessionIdleTimeoutMs, 90_000);
    assert.equal(buildAppendPrompt(undefined, []), undefined);
  });
});
