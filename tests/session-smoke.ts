// Manual live check of a full Claude Code session on the DEFAULT login only:
// asks haiku to create one file in a throwaway directory, then removes the
// directory and the transcript the CLI wrote for it.
// Run: node --import <tsx>/dist/esm/index.mjs tests/session-smoke.ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AccountPool } from '../src/accounts/pool.js';
import { resolveCli } from '../src/accounts/cli.js';
import { DEFAULT_SESSION_TOOLS, SessionRunner } from '../src/session/runner.js';
import { SessionIndex } from '../src/session/sessions.js';
import { summarizeRun } from '../src/session/summary.js';

const logger = { debug() {}, info() {}, warn: (...a: unknown[]) => console.log('WARN', ...a), error() {} } as never;
const dataDir = mkdtempSync(join(import.meta.dirname, '.tmp-smoke-state-'));
const work = mkdtempSync(join(import.meta.dirname, '.tmp-smoke-cwd-'));
let sessionId: string | undefined;
try {
  const pool = new AccountPool({ dataDir, logger });
  const cli = resolveCli('');
  console.log('cli', cli.source, cli.native);
  const runner = new SessionRunner({
    pool,
    cli,
    sessions: new SessionIndex(join(dataDir, 'sessions.json')),
    config: { permissionMode: 'acceptEdits', allowedTools: DEFAULT_SESSION_TOOLS, model: 'haiku', timeoutMs: 180_000, maxTurns: 6, startTimeoutMs: 60_000 },
    logger,
  });
  const started = runner.start({
    cwd: work,
    prompt: 'Create a file named hello.txt in the current directory containing exactly the text: hello from claude. Then reply DONE.',
    // (resume below asks about it)
    model: 'haiku',
    effort: 'low',
    permissionMode: 'acceptEdits',
    maxTurns: 6,
    agent: 'smoke',
  });
  if (!started.run) throw new Error(started.error);
  started.run.onProgress = (p) => p.chunk && process.stdout.write(`  | ${p.chunk}`);
  const report = await started.run.done;
  sessionId = report.sessionId;
  console.log('\n' + summarizeRun(report));
  const f = join(work, 'hello.txt');
  console.log('file exists', existsSync(f), existsSync(f) ? JSON.stringify(readFileSync(f, 'utf8')) : '');
  // Resume: must run on the same seat and remember the first turn.
  const again = runner.start({ cwd: work, prompt: 'What is the name of the file you just created? Answer with the file name only.', model: 'haiku', effort: 'low', permissionMode: 'plan', maxTurns: 2, sessionId });
  if (!again.run) throw new Error(again.error);
  const r2 = await again.run.done;
  console.log('resume', JSON.stringify({ status: r2.status, seat: r2.seat.id, sameSession: r2.sessionId === sessionId, answer: r2.resultText }));
  pool.flush();
  console.log('recent', JSON.stringify({ ...pool.recent[0], at: undefined }));
  console.log('usage windows', JSON.stringify(pool.runtime('default').usage?.windows ?? []));
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  // The CLI keeps the transcript under ~/.claude/projects/<encoded cwd>/.
  if (sessionId) {
    const root = join(homedir(), '.claude', 'projects');
    for (const d of readdirSync(root)) {
      if (existsSync(join(root, d, `${sessionId}.jsonl`)) && d.includes('tmp-smoke-cwd')) {
        rmSync(join(root, d), { recursive: true, force: true });
        console.log('removed transcript dir', d);
      }
    }
  }
}
