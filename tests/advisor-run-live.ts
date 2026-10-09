// Manual live check: a claude_code_run session (SessionRunner) with the
// advisor on, on one real seat. Reads the session's transcript for the
// advisor's traces. Uses a copy of the pool file, never the live one.
// Run: node --import "file:///C:/Users/fabri/Documents/alfred-agent/node_modules/tsx/dist/esm/index.mjs" tests/advisor-run-live.ts [seatId]
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AccountPool } from '../src/accounts/pool.js';
import { AdvisorPolicy } from '../src/accounts/advisor.js';
import { resolveCli } from '../src/accounts/cli.js';
import { SessionIndex } from '../src/session/sessions.js';
import { DEFAULT_SESSION_TOOLS, SessionRunner } from '../src/session/runner.js';

const seat = process.argv[2] ?? 'claude-premium1';
const logger = { debug() {}, info: (...a: unknown[]) => console.log('INFO', ...a), warn: (...a: unknown[]) => console.log('WARN', ...a), error: (...a: unknown[]) => console.log('ERROR', ...a) } as never;
const tmp = mkdtempSync(join(import.meta.dirname, '.tmp-advisor-run-'));
const cwd = join(import.meta.dirname, 'fixtures-work', 'advisor-run');
mkdirSync(cwd, { recursive: true });
try {
  // Only the seat under test is enabled in the copy, so the run lands there.
  const file = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'state', 'accounts.json'), 'utf8')) as { accounts: Array<{ id: string; enabled: boolean }> };
  for (const a of file.accounts) a.enabled = a.id === seat;
  writeFileSync(join(tmp, 'accounts.json'), JSON.stringify(file));
  const pool = new AccountPool({ dataDir: tmp, logger });
  const account = pool.get(seat);
  if (!account) throw new Error(`no seat ${seat}`);
  const advisor = new AdvisorPolicy('fable', logger);
  const runner = new SessionRunner({
    pool,
    cli: resolveCli(''),
    sessions: new SessionIndex(join(tmp, 'sessions.json')),
    config: { permissionMode: 'acceptEdits', allowedTools: DEFAULT_SESSION_TOOLS, model: 'opus', timeoutMs: 0, maxTurns: 0, startTimeoutMs: 120_000 },
    logger,
    advisor,
  });
  const started = runner.start({
    cwd,
    prompt: 'Write a file answer.txt containing the number 42 with your Write tool. Then call your advisor tool once (server-side tool named "advisor") and reply DONE.',
    model: `opus`,
    effort: 'high',
    permissionMode: 'acceptEdits',
    maxTurns: 0,
  });
  if (!started.run) throw new Error(started.error);
  // The pool picks; pin by benching every other seat for this run is overkill: report where it ran.
  const report = await started.run.done;
  console.log('run:', report.status, 'seat', report.seat.id, 'files', report.files.map((f) => f.path), 'result', report.resultText.slice(0, 80));
  console.log('advisor state:', JSON.stringify(advisor.view(report.seat.id)));
  const dir = join(homedir(), '.claude', 'projects');
  for (const p of readdirSync(dir)) {
    const f = join(dir, p, `${report.sessionId}.jsonl`);
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const blocks = lines.flatMap((j) => (j.type === 'assistant' ? (j.message?.content ?? []).map((b: { type: string; name?: string }) => b.type + (b.name ? `:${b.name}` : '')) : []));
    const its = new Map<string, unknown[]>();
    for (const j of lines) if (j.type === 'assistant' && j.message?.usage?.iterations) its.set(j.message.id, j.message.usage.iterations.filter((i: { type: string }) => i.type !== 'message'));
    console.log('blocks:', blocks.join(','));
    console.log('advisor iterations:', JSON.stringify([...its.values()].flat()));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}
