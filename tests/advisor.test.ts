// Run: npm test (node --test with the tsx loader). No network, no CLI.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AccountPool } from '../src/accounts/pool.js';
import { AdvisorPolicy, INCOMPATIBLE_PAUSE_MS, isAdvisorRefusal } from '../src/accounts/advisor.js';
import { ClaudeCodeProvider, __setQueryForTests } from '../src/ClaudeCodeProvider.js';

const logs: Array<[string, string, Record<string, unknown> | undefined]> = [];
const logger = {
  debug() {},
  info(m: string, meta?: Record<string, unknown>) {
    logs.push(['info', m, meta]);
  },
  warn(m: string, meta?: Record<string, unknown>) {
    logs.push(['warn', m, meta]);
  },
  error() {},
} as never;
const tmpRoot = join(import.meta.dirname, '.tmp');
let dir = '';
before(() => {
  dir = mkdtempSync(join(tmpRoot + '-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  __setQueryForTests(null);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('advisor policy', () => {
  it('sends the configured advisor on every seat; empty = off', () => {
    assert.deepEqual(new AdvisorPolicy('fable', logger).settingsFor('a'), { advisorModel: 'fable' });
    const off = new AdvisorPolicy('', logger);
    assert.equal(off.enabled, false);
    assert.equal(off.settingsFor('a'), undefined);
  });

  it('reads what the CLI applied: active, or unavailable on a seat that refuses it, logged once', async () => {
    logs.length = 0;
    const p = new AdvisorPolicy('fable', logger);
    const cli = (advisor: string | null) => ({ getSettings: async () => ({ applied: { model: 'claude-opus-5-5', advisor } }) });
    p.observe('premium', cli('claude-fable-5-1'), { advisorModel: 'fable' });
    p.observe('standard', cli(null), { advisorModel: 'fable' });
    p.observe('standard', cli(null), { advisorModel: 'fable' });
    await flush();
    assert.equal(p.view('premium')?.state, 'active');
    assert.equal(p.view('premium')?.model, 'claude-fable-5-1');
    assert.equal(p.view('standard')?.state, 'unavailable');
    assert.match(p.view('standard')?.reason ?? '', /usage credits/);
    // A seat that refuses it keeps its advisor setting: nothing changes in its launches.
    assert.deepEqual(p.settingsFor('standard'), { advisorModel: 'fable' });
    assert.equal(logs.filter((l) => l[1].startsWith('advisor not available')).length, 1);
  });

  it('a CLI without get_settings, or one that fails it, leaves the state alone', async () => {
    const p = new AdvisorPolicy('fable', logger);
    p.observe('a', {}, { advisorModel: 'fable' });
    p.observe('a', { getSettings: async () => Promise.reject(new Error('closed')) }, { advisorModel: 'fable' });
    await flush();
    assert.equal(p.view('a'), null);
  });

  it('an API refusal takes the advisor off that seat for a while, then it comes back', () => {
    let now = 1_000;
    const p = new AdvisorPolicy('fable', logger, () => now);
    p.markIncompatible('a', '400 advisor_incompatible');
    assert.equal(p.settingsFor('a'), undefined);
    assert.deepEqual(p.settingsFor('b'), { advisorModel: 'fable' });
    assert.equal(p.view('a')?.state, 'incompatible');
    now += INCOMPATIBLE_PAUSE_MS + 1;
    assert.deepEqual(p.settingsFor('a'), { advisorModel: 'fable' });
  });

  it('recognises the CLI wording of an advisor refusal, nothing else', () => {
    assert.ok(isAdvisorRefusal('API Error: invalid request · The configured advisor model is not compatible with this request model — change or unset the advisorModel setting'));
    assert.ok(isAdvisorRefusal('whatever', 'advisor_incompatible'));
    assert.ok(!isAdvisorRefusal("You've hit your limit"));
    assert.ok(!isAdvisorRefusal(undefined));
  });
});

type Msg = Record<string, unknown>;
const textDelta = (t: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } });
const okResult = { type: 'result', subtype: 'success', is_error: false, result: 'hi', usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0.001 };
// The CLI's synthetic turn for an `advisor_incompatible` 400 (errors.ts, CLI 2.1.280).
const advisorRefusedTurn: Msg[] = [
  {
    type: 'assistant',
    error: 'invalid_request',
    api_error: 'advisor_incompatible',
    message: {
      model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: advisor tool not supported for this model · The configured advisor model is not compatible with this request model — change or unset the advisorModel setting (or the --advisor flag)' }],
    },
  },
  { type: 'result', subtype: 'success', is_error: true, result: 'API Error: advisor tool not supported for this model' },
];

describe('advisor on engine requests', () => {
  const cfg = { oauthToken: '', modelsRaw: 'opus', contextWindow: 200000, pathToClaude: '', requestTimeoutMs: 5000, maxConcurrentRequests: 16, maxParallelTasks: 32 };
  const cli = { path: '', native: false, source: 'bundled' as const };

  function makePool(n: number): AccountPool {
    const pool = new AccountPool({ dataDir: mkdtempSync(join(dir, 'p-')), logger });
    pool.remove('default');
    for (let i = 1; i <= n; i++) pool.setToken(pool.add(`Seat ${i}`, 'token').id, `tok-${i}`);
    return pool;
  }

  it('passes the advisor as a flag setting', async () => {
    const seen: unknown[] = [];
    __setQueryForTests(((args: { options?: { settings?: unknown } }) => {
      seen.push(args.options?.settings);
      return (async function* () {
        yield textDelta('hi');
        yield okResult;
      })();
    }) as never);
    const p = new ClaudeCodeProvider({ config: cfg, pool: makePool(1), cli, logger, advisor: new AdvisorPolicy('fable', logger) });
    await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(seen, [{ advisorModel: 'fable' }]);
    // Off: no settings at all.
    seen.length = 0;
    const off = new ClaudeCodeProvider({ config: cfg, pool: makePool(1), cli, logger, advisor: new AdvisorPolicy('', logger) });
    await off.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(seen, [undefined]);
  });

  it('an API refusal of the advisor replays the request on the same seat without it', async () => {
    const calls: Array<{ tok: string; settings: unknown }> = [];
    __setQueryForTests(((args: { options?: { env?: Record<string, string>; settings?: unknown } }) => {
      calls.push({ tok: args.options?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? '', settings: args.options?.settings });
      const script = args.options?.settings ? advisorRefusedTurn : [textDelta('answer'), okResult];
      return (async function* () {
        for (const m of script) yield m;
      })();
    }) as never);
    const pool = makePool(2);
    const advisor = new AdvisorPolicy('fable', logger);
    const p = new ClaudeCodeProvider({ config: cfg, pool, cli, logger, advisor });
    const res = await p.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.content, 'answer');
    assert.deepEqual(calls, [
      { tok: 'tok-1', settings: { advisorModel: 'fable' } },
      { tok: 'tok-1', settings: undefined },
    ]);
    const seat = pool.list()[0];
    assert.equal(advisor.view(seat.id)?.state, 'incompatible');
    // The seat is not benched for it.
    assert.equal(pool.unavailableReason(seat), null);
  });

  it('other failures do not trigger the replay', async () => {
    const calls: unknown[] = [];
    __setQueryForTests(((args: { options?: { settings?: unknown } }) => {
      calls.push(args.options?.settings);
      return (async function* () {
        yield { type: 'assistant', error: 'unknown', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500 boom' }] } };
        yield { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500 boom' };
      })();
    }) as never);
    const p = new ClaudeCodeProvider({ config: cfg, pool: makePool(1), cli, logger, advisor: new AdvisorPolicy('fable', logger) });
    await assert.rejects(p.chat({ model: 'opus', messages: [{ role: 'user', content: 'x' }] }), /boom/);
    assert.equal(calls.length, 1);
  });
});
