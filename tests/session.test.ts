// Run: node --import <tsx> --test tests/session.test.ts. No network, no CLI.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountPool } from '../src/accounts/pool.js';
import { __setQueryForTests } from '../src/ClaudeCodeProvider.js';
import { ChangeTracker, summarizeRun, type RunReport } from '../src/session/summary.js';
import { SessionIndex, seatForResume } from '../src/session/sessions.js';
import { DEFAULT_SESSION_TOOLS, SessionRunner, type SessionConfig } from '../src/session/runner.js';
import { registerSessionTools } from '../src/session/tools.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
let dir = '';
const CWD = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';
const SID = '0f8e2d1c-1111-4222-8333-944455556666';

before(() => {
  dir = mkdtempSync(join(import.meta.dirname, '.tmp-session-'));
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

const sessionCfg: SessionConfig = {
  permissionMode: 'acceptEdits',
  allowedTools: DEFAULT_SESSION_TOOLS,
  model: 'sonnet',
  timeoutMs: 60_000,
  maxTurns: 50,
  startTimeoutMs: 5_000,
};

type Msg = Record<string, unknown>;
type Call = { token: string; options: Record<string, unknown> };
function fakeQuery(byToken: Record<string, Msg[]>, calls: Call[]) {
  return ((args: { options: Record<string, unknown> & { env?: Record<string, string> } }) => {
    const token = args.options.env?.CLAUDE_CODE_OAUTH_TOKEN ?? '';
    calls.push({ token, options: args.options });
    const script = byToken[token] ?? [];
    return (async function* () {
      for (const m of script) yield m;
    })();
  }) as never;
}

const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid });
const toolUse = (id: string, name: string, input: Msg) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] },
});
const said = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const success = (sid: string, text: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  result: text,
  session_id: sid,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
  total_cost_usd: 0.05,
  permission_denials: [],
});
const limitHit = () => [
  init('aaaaaaaa-0000-4000-8000-000000000000'),
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } },
  { type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] } },
  { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" },
];

describe('change tracking and summary', () => {
  it('counts only tool calls whose result succeeded, with cwd-relative paths', () => {
    const t = new ChangeTracker(CWD);
    const msgs = [
      toolUse('1', 'Write', { file_path: join(CWD, 'src', 'new.ts'), content: 'x' }),
      toolResult('1'),
      toolUse('2', 'Edit', { file_path: join(CWD, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }),
      toolResult('2'),
      toolUse('3', 'MultiEdit', { file_path: join(CWD, 'src', 'a.ts'), edits: [{}, {}] }),
      toolResult('3'),
      toolUse('4', 'Edit', { file_path: join(CWD, 'src', 'refused.ts') }),
      toolResult('4', true),
      toolUse('5', 'Bash', { command: 'npm   test' }),
      toolResult('5'),
      toolUse('6', 'Read', { file_path: join(CWD, 'README.md') }),
      toolResult('6'),
    ];
    msgs.forEach((m) => t.observe(m));
    assert.deepEqual(t.filesChanged, [
      { path: 'src/a.ts', writes: 0, edits: 3, notebookEdits: 0 },
      { path: 'src/new.ts', writes: 1, edits: 0, notebookEdits: 0 },
    ]);
    assert.deepEqual(t.commandsRun, { count: 1, last: ['npm test'] });
    assert.equal(t.toolCounts.Read, 1);
  });

  it('summarises a finished run for the calling agent', () => {
    const report: RunReport = {
      status: 'done',
      seat: { id: 'seat-2', label: 'Seat 2' },
      model: 'sonnet',
      cwd: CWD,
      sessionId: SID,
      resumed: false,
      turns: 4,
      durationMs: 75_000,
      resultText: 'Added the feature and the tests pass.',
      tokens: { input: 1200, output: 800, cacheRead: 50_000, cacheWrite: 3000, costUsd: 0.42 },
      files: [{ path: 'src/a.ts', writes: 0, edits: 2, notebookEdits: 0 }],
      commands: { count: 1, last: ['npm test'] },
      denials: [],
    };
    const text = summarizeRun(report);
    assert.match(text, /finished on seat "Seat 2" · sonnet · 4 turns · 1m 15s/);
    assert.match(text, new RegExp(`sessionId: ${SID}`));
    assert.match(text, /- src\/a\.ts \(edited x2\)/);
    assert.match(text, /\$ npm test/);
    assert.match(text, /1\.2k in \(\+50\.0k cache read, 3\.0k cache write\) · 800 out · ~\$0\.42/);
    assert.match(text, /Result:\nAdded the feature/);
  });
});

describe('seat pinning on resume', () => {
  it('resumes on the seat that owns the session, not the preferred one', () => {
    const pool = makePool(2);
    const index = new SessionIndex(join(dir, 'idx-1.json'));
    index.record(SID, { accountId: 'seat-2', cwd: CWD, model: 'sonnet' });
    const r = seatForResume(pool, index, SID);
    assert.equal(r.account?.id, 'seat-2');
  });

  it('finds an unindexed session by its transcript in a seat config dir', () => {
    const pool = makePool(2);
    const seat2 = pool.get('seat-2')!;
    mkdirSync(join(seat2.configDir!, 'projects', 'C--work-proj'), { recursive: true });
    writeFileSync(join(seat2.configDir!, 'projects', 'C--work-proj', `${SID}.jsonl`), '{}\n');
    const r = seatForResume(pool, new SessionIndex(join(dir, 'idx-2.json')), SID);
    assert.equal(r.account?.id, 'seat-2');
  });

  it('refuses with the reset time when the owner seat is exhausted, without falling back', () => {
    const pool = makePool(2);
    const index = new SessionIndex(join(dir, 'idx-3.json'));
    index.record(SID, { accountId: 'seat-1', cwd: CWD, model: 'sonnet' });
    const until = Date.now() + 2 * 3_600_000;
    pool.markExhausted('seat-1', until, 'five_hour');
    const r = seatForResume(pool, index, SID);
    assert.equal(r.account, undefined);
    assert.equal(r.account === undefined && r.code, 'unavailable');
    assert.equal(r.account === undefined && r.resetsAt, until);
    assert.match(r.error ?? '', /Seat 1.*out of quota until/);
  });

  it('rejects unknown and malformed session ids', () => {
    const pool = makePool(1);
    const index = new SessionIndex(join(dir, 'idx-4.json'));
    assert.equal((seatForResume(pool, index, SID) as { code: string }).code, 'not_found');
    assert.equal((seatForResume(pool, index, '../../etc') as { code: string }).code, 'invalid_args');
  });
});

describe('session runner', () => {
  it('switches seat on a limit before any output, records the session and its ledger entry', async () => {
    const pool = makePool(2);
    const index = new SessionIndex(join(dir, 'idx-5.json'));
    const calls: Call[] = [];
    __setQueryForTests(
      fakeQuery(
        {
          'tok-1': limitHit(),
          'tok-2': [
            init(SID),
            said('Working on it.'),
            toolUse('e1', 'Edit', { file_path: join(CWD, 'x.ts') }),
            toolResult('e1'),
            success(SID, 'Done.'),
          ],
        },
        calls,
      ),
    );
    const runner = new SessionRunner({ pool, cli: { path: '', native: false, source: 'bundled' }, sessions: index, config: sessionCfg, logger });
    const started = runner.start({ cwd: CWD, prompt: 'do it', model: 'sonnet', permissionMode: 'acceptEdits', maxTurns: 10, agent: 'coder' });
    assert.ok(started.run);
    const report = await started.run.done;

    assert.equal(report.status, 'done');
    assert.equal(report.seat.id, 'seat-2');
    assert.equal(report.sessionId, SID);
    assert.deepEqual(report.files.map((f) => f.path), ['x.ts']);
    assert.equal(report.switchedFrom?.length, 1);
    assert.deepEqual(calls.map((c) => c.token), ['tok-1', 'tok-2']);
    // Real agent options, not the provider's text-only ones.
    const opts = calls[1].options;
    assert.equal(opts.cwd, CWD);
    assert.equal(opts.permissionMode, 'acceptEdits');
    assert.deepEqual(opts.systemPrompt, { type: 'preset', preset: 'claude_code' });
    assert.ok((opts.allowedTools as string[]).includes('Bash'));
    assert.equal(opts.resume, undefined);

    assert.equal(index.get(SID)?.accountId, 'seat-2');
    assert.ok(pool.runtime('seat-1').exhaustedUntil! > Date.now());
    const served = pool.recent[0];
    assert.equal(served.kind, 'session');
    assert.equal(served.accountId, 'seat-2');
    assert.equal(served.outcome, 'ok');
    assert.equal(served.agent, 'coder');
    assert.equal(pool.recent[1].outcome, 'switched');
    assert.equal(pool.tokenSummary('seat-2').total.output, 20);
  });

  it('resumes on the owning seat with options.resume and never tries another seat', async () => {
    const pool = makePool(2);
    const index = new SessionIndex(join(dir, 'idx-6.json'));
    index.record(SID, { accountId: 'seat-2', cwd: CWD, model: 'sonnet' });
    const calls: Call[] = [];
    __setQueryForTests(fakeQuery({ 'tok-2': limitHit() }, calls));
    const runner = new SessionRunner({ pool, cli: { path: '', native: false, source: 'bundled' }, sessions: index, config: sessionCfg, logger });
    const started = runner.start({ cwd: CWD, prompt: 'continue', model: 'sonnet', permissionMode: 'acceptEdits', maxTurns: 10, sessionId: SID });
    const report = await started.run!.done;
    assert.deepEqual(calls.map((c) => c.token), ['tok-2']);
    assert.equal(calls[0].options.resume, SID);
    assert.equal(report.status, 'error');
    assert.ok(report.resetsAt && report.resetsAt > Date.now());

    // The owner is now exhausted: the next resume is refused up front.
    const again = runner.start({ cwd: CWD, prompt: 'continue', model: 'sonnet', permissionMode: 'acceptEdits', maxTurns: 10, sessionId: SID });
    assert.equal(again.run, undefined);
    assert.equal(again.run === undefined && again.code, 'unavailable');
    assert.equal(calls.length, 1);
  });
});

describe('claude_code_run tool', () => {
  it('refuses a permission mode above the configured one', async () => {
    const pool = makePool(1);
    const tools = new Map<string, { run: (i: unknown) => Promise<{ ok: boolean; error?: { code: string } }> }>();
    const ctx = { registerTool: (t: { id: string }) => tools.set(t.id, t as never), projects: undefined } as never;
    const runner = new SessionRunner({ pool, cli: { path: '', native: false, source: 'bundled' }, sessions: new SessionIndex(join(dir, 'idx-7.json')), config: sessionCfg, logger });
    registerSessionTools(ctx, runner);
    const res = await tools.get('claude_code_run')!.run({ args: { prompt: 'x', cwd: dir, permissionMode: 'bypassPermissions' }, agentId: 'a' });
    assert.equal(res.ok, false);
    assert.equal(res.error?.code, 'refused');
    const rel = await tools.get('claude_code_run')!.run({ args: { prompt: 'x', cwd: 'relative/dir' }, agentId: 'a' });
    assert.equal(rel.error?.code, 'invalid_args');
  });
});
