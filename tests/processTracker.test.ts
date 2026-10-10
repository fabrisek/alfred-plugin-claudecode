// Orphan CLI reaping from the pid file. No real process is killed.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliProcessTracker } from '../src/agentSession/processTracker.js';
import { argvForLog } from '../src/agentSession/ClaudeSessionAdapter.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
let dir = '';
before(() => {
  dir = mkdtempSync(join(import.meta.dirname, '.tmp-pids-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('CLI process tracker', () => {
  it('kills only recorded processes whose image and start time still match', async () => {
    const file = join(dir, 'pids.json');
    const t0 = 1_000_000;
    writeFileSync(
      file,
      JSON.stringify([
        { pid: 11, image: 'claude.exe', startedAt: t0 }, // still our orphan
        { pid: 12, image: 'claude.exe', startedAt: t0 }, // pid reused by another program
        { pid: 13, image: 'claude.exe', startedAt: t0 }, // pid reused later by another claude
        { pid: 14, image: 'claude.exe', startedAt: t0 }, // already gone
      ]),
    );
    const live: Record<number, { image: string; startedAt: number }> = {
      11: { image: 'claude.exe', startedAt: t0 + 800 },
      12: { image: 'chrome.exe', startedAt: t0 + 100 },
      13: { image: 'claude.exe', startedAt: t0 + 3_600_000 },
    };
    const killed: number[] = [];
    const tracker = new CliProcessTracker(
      file,
      logger,
      async (pid) => live[pid] ?? null,
      async (pid) => {
        killed.push(pid);
      },
    );
    assert.equal(await tracker.reapOrphans(), 1);
    assert.deepEqual(killed, [11]);
    // The file now only lists this run's live children (none).
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  });

  it('leaves the children of another live host alone, and keeps them in the file', async () => {
    const file = join(dir, 'owners.json');
    const t0 = 2_000_000;
    writeFileSync(
      file,
      JSON.stringify([
        { pid: 21, image: 'claude.exe', startedAt: t0, owner: 900 }, // other gateway, alive
        { pid: 22, image: 'claude.exe', startedAt: t0, owner: 901 }, // dead gateway: orphan
        // This process, previous activation (before a plugin reload): it may
        // still be draining a reply, and closes its own children. Never killed;
        // dropped from the file once its process is gone.
        { pid: 23, image: 'claude.exe', startedAt: t0, owner: 1 },
      ]),
    );
    const killed: number[] = [];
    const tracker = new CliProcessTracker(
      file,
      logger,
      async () => ({ image: 'claude.exe', startedAt: t0 }),
      async (pid) => {
        killed.push(pid);
      },
      () => t0,
      1,
      (pid) => pid === 900,
    );
    assert.equal(await tracker.reapOrphans(), 1);
    assert.deepEqual(killed, [22]);
    assert.deepEqual(
      JSON.parse(readFileSync(file, 'utf8')).map((p: { pid: number }) => p.pid),
      [21],
    );
  });

  it('survives a missing or corrupt pid file', async () => {
    const t = new CliProcessTracker(join(dir, 'nope.json'), logger, async () => null, async () => {});
    assert.equal(await t.reapOrphans(), 0);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    const t2 = new CliProcessTracker(bad, logger, async () => null, async () => {});
    assert.equal(await t2.reapOrphans(), 0);
  });

  it('records a spawned child and forgets it on exit', async () => {
    const file = join(dir, 'spawn.json');
    const t = new CliProcessTracker(file, logger, async () => null, async () => {});
    let argv: string[] = [];
    const child = t.spawner(undefined, (a) => (argv = a))({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 200)'],
      env: process.env,
      signal: new AbortController().signal,
    });
    assert.deepEqual(argv, ['-e', 'setTimeout(() => {}, 200)']);
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].pid, child.pid);
    await new Promise((r) => child.once('exit', r));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
  });

  it('shortens long argv values for the log', () => {
    assert.equal(argvForLog(['--model', 'sonnet', 'x'.repeat(100)]), `--model sonnet ${'x'.repeat(40)}…(100)`);
  });
});
