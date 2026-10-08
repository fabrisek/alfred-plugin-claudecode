// Live check of plan §3.1 option A: link two seats' projects/ + file-history/
// to the shared store, start a tiny session on seat A, resume it on seat B.
// Spends two tiny haiku turns. Never prints tokens.
//
// Run: node --import "file:///C:/Users/fabri/Documents/alfred-agent/node_modules/tsx/dist/esm/index.mjs" tests/cross-seat-resume.ts <seatA> <seatB>

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AccountPool } from '../src/accounts/pool.js';
import { buildChildEnv, resolveCli } from '../src/accounts/cli.js';
import { defaultSharedRoot, ensureSharedSessionDirs, seatIsShared } from '../src/accounts/sharedSessions.js';

const [seatA, seatB] = process.argv.slice(2);
if (!seatA || !seatB) throw new Error('usage: cross-seat-resume.ts <seatA> <seatB>');
const logger = { debug() {}, info() {}, warn: (...a: unknown[]) => console.log('WARN', ...a), error() {} } as never;
const dataDir = join(import.meta.dirname, '..', 'state');
const pool = new AccountPool({ dataDir, logger });
const cli = resolveCli('');
const A = pool.get(seatA);
const B = pool.get(seatB);
if (!A || !B) throw new Error('unknown seat');

const store = defaultSharedRoot();
const setup = ensureSharedSessionDirs([A, B], store, logger);
console.log('junctions', JSON.stringify({ crossSeat: setup.crossSeat, A: seatIsShared(A.configDir, store), B: seatIsShared(B.configDir, store), results: setup.results }));

const cwd = join(import.meta.dirname, 'fixtures-work', 'cross-seat');
mkdirSync(cwd, { recursive: true });

async function turn(seat: typeof A, prompt: string, resume?: string): Promise<{ sessionId?: string; text: string; error?: string; model?: string }> {
  const env = buildChildEnv(pool, seat!);
  delete env.CLAUDECODE;
  const options: Record<string, unknown> = {
    model: 'haiku',
    cwd,
    effort: 'low',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    strictMcpConfig: true,
    tools: [],
    env,
  };
  if (cli.path) options.pathToClaudeCodeExecutable = cli.path;
  if (resume) options.resume = resume;
  let sessionId: string | undefined;
  let text = '';
  let model: string | undefined;
  try {
    for await (const m of query({ prompt, options: options as never }) as AsyncIterable<Record<string, unknown>>) {
      if (typeof m.session_id === 'string') sessionId = m.session_id;
      if (m.type === 'system' && m.subtype === 'init') model = String(m.model);
      if (m.type === 'result') text = String(m.result ?? '');
    }
  } catch (err) {
    return { sessionId, text, error: (err as Error).message, model };
  }
  return { sessionId, text, model };
}

const first = await turn(A, 'Remember this code word: zebra-42. Reply only "ok".');
console.log('seat A', seatA, JSON.stringify(first));
const encoded = readdirSync(join(store, 'projects')).find((d) => d.toLowerCase().endsWith('fixtures-work-cross-seat'));
const transcriptViaB = encoded && first.sessionId ? join(B.configDir ?? store, 'projects', encoded, `${first.sessionId}.jsonl`) : '';
console.log('transcript visible from seat B dir', !!transcriptViaB && existsSync(transcriptViaB));
const second = await turn(B, 'What code word did I ask you to remember? Reply with it only.', first.sessionId);
console.log('seat B', seatB, JSON.stringify(second));
const ok = !!first.sessionId && second.sessionId === first.sessionId && /zebra-42/i.test(second.text);
console.log(ok ? 'CROSS-SEAT RESUME: OK' : 'CROSS-SEAT RESUME: FAILED');

// Throwaway session: remove its transcript and the cwd.
if (encoded) rmSync(join(store, 'projects', encoded), { recursive: true, force: true });
if (first.sessionId) rmSync(join(store, 'file-history', first.sessionId), { recursive: true, force: true });
rmSync(cwd, { recursive: true, force: true });

process.exit(ok ? 0 : 1);
