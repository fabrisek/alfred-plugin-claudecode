// Manual live check of the CLI agent-mode adapter on the DEFAULT login only
// (tiny haiku turns): new session, mid-turn message, resume, interrupt.
// Run: node --import "file:///C:/Users/fabri/Documents/alfred-agent/node_modules/tsx/dist/esm/index.mjs" tests/session-live-smoke.ts
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent, SessionTurnRequest } from '@alfred/sdk';
import { AccountPool } from '../src/accounts/pool.js';
import { resolveCli } from '../src/accounts/cli.js';
import { SessionIndex } from '../src/session/sessions.js';
import { ClaudeSessionAdapter, DEFAULT_CHAT_SESSION_CONFIG } from '../src/agentSession/ClaudeSessionAdapter.js';

const logger = { debug() {}, info() {}, warn: (...a: unknown[]) => console.log('WARN', ...a), error: (...a: unknown[]) => console.log('ERROR', ...a) } as never;
const tmp = mkdtempSync(join(import.meta.dirname, '.tmp-live-session-'));
const cwd = join(import.meta.dirname, 'fixtures-work', 'live-session');
mkdirSync(cwd, { recursive: true });
let sessionId: string | undefined;
try {
  const pool = new AccountPool({ dataDir: tmp, logger });
  const adapter = new ClaudeSessionAdapter({
    pool,
    cli: resolveCli(''),
    sessions: new SessionIndex(join(tmp, 'sessions.json')),
    logger,
    config: DEFAULT_CHAT_SESSION_CONFIG,
    crossSeat: () => false,
  });
  const base = (over: Partial<SessionTurnRequest>): SessionTurnRequest => ({
    turnId: `t-${Date.now()}`,
    conversationId: 'smoke',
    cwd,
    additionalDirectories: [],
    input: { clientMessageId: 'm1', text: 'hi' },
    model: 'haiku',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    persona: 'You are Smoke, a terse test agent. Always answer in lowercase.',
    mcpServers: [],
    pinnedSeatId: 'default',
    ...over,
  });
  const summary = (events: SessionEvent[]): string =>
    events
      .filter((e) => !['text_delta', 'thinking_delta', 'heartbeat', 'tool_input_delta', 'rate_limit', 'usage'].includes(e.type))
      .map((e) => {
        if (e.type === 'tool_start') return `tool_start:${e.name}`;
        if (e.type === 'assistant') return `assistant:${JSON.stringify(e.text.slice(0, 60))}`;
        if (e.type === 'turn_end') return `turn_end:${e.stopReason}:${JSON.stringify(e.resultText?.slice(0, 80) ?? '')}${e.error ? `:${e.error.kind}:${e.error.message.slice(0, 120)}` : ''}`;
        if (e.type === 'input_ack') return `ack:${e.clientMessageId}`;
        if (e.type === 'session') return `session:${e.ref.sessionId.slice(0, 8)}:resumed=${e.resumed}`;
        return e.type;
      })
      .join(' | ');

  // 1. New session + a message sent mid-turn.
  const r1 = base({ input: { clientMessageId: 'm1', text: 'Run the Bash command `sleep 4 && echo first` and report its output.' } });
  const ev1: SessionEvent[] = [];
  for await (const e of adapter.runSessionTurn(r1)) {
    ev1.push(e);
    if (e.type === 'session') sessionId = e.ref.sessionId;
    if (e.type === 'tool_start' && !ev1.some((x) => x.type === 'notice')) {
      ev1.push({ type: 'notice', level: 'info', text: 'sent' });
      console.log('mid-turn send', JSON.stringify(await adapter.sendSessionInput(r1.turnId, { clientMessageId: 'm2', text: 'Also tell me what 2+2 is.' })));
    }
  }
  console.log('turn 1:', summary(ev1));

  // 2. Resume: the session remembers.
  const ev2: SessionEvent[] = [];
  for await (const e of adapter.runSessionTurn(base({ resume: { sessionId: sessionId!, cwd }, input: { clientMessageId: 'm3', text: 'What did the command print? One word.' } }))) ev2.push(e);
  console.log('turn 2:', summary(ev2));

  // 3. Interrupt a long command.
  const r3 = base({ resume: { sessionId: sessionId!, cwd }, input: { clientMessageId: 'm4', text: 'Run exactly this Bash command (40 s, expected): node -e "setTimeout(() => console.log(1), 40000)"' } });
  const ev3: SessionEvent[] = [];
  const t0 = Date.now();
  for await (const e of adapter.runSessionTurn(r3)) {
    ev3.push(e);
    if (e.type === 'tool_start') setTimeout(() => void adapter.interruptSessionTurn(r3.turnId), 1500);
  }
  console.log(`turn 3 (${Math.round((Date.now() - t0) / 1000)}s):`, summary(ev3));
  console.log('live turns left', adapter.liveTurns);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  // Throwaway session: drop its transcript from the default store.
  const projects = join(homedir(), '.claude', 'projects');
  for (const d of readdirSync(projects)) if (d.toLowerCase().endsWith('fixtures-work-live-session')) rmSync(join(projects, d), { recursive: true, force: true });
  if (sessionId) {
    for (const sub of ['file-history', 'session-env', 'tasks']) rmSync(join(homedir(), '.claude', sub, sessionId), { recursive: true, force: true });
  }
}
