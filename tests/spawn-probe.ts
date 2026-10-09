// Probe: the tracker's spawn under the real Agent SDK and CLI, in CLI-session
// options shape. Stops at the CLI's `init` (no model call).
//   node --import tsx tests/spawn-probe.ts [cwd]
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveCli } from '../src/accounts/cli.js';
import { CliProcessTracker } from '../src/agentSession/processTracker.js';

const logger = { debug() {}, info() {}, warn: console.warn, error: console.error } as never;
const cli = resolveCli('');
const tracker = new CliProcessTracker(join(mkdtempSync(join(tmpdir(), 'spawn-probe-')), 'pids.json'), logger);
const controller = new AbortController();
let stderr = '';
const q = query({
  prompt: 'say hi',
  options: {
    cwd: process.argv[2] ?? process.cwd(),
    pathToClaudeCodeExecutable: cli.path || undefined,
    abortController: controller,
    settingSources: [],
    spawnClaudeCodeProcess: tracker.spawner((d) => (stderr += d), (a) => console.log('argv', a.length, 'args')),
  } as never,
});
try {
  for await (const m of q as AsyncIterable<{ type: string; subtype?: string; session_id?: string }>) {
    if (m.type === 'system' && m.subtype === 'init') {
      console.log('init OK, session', m.session_id, 'tracked', tracker.tracked.map((t) => t.pid));
      controller.abort();
      break;
    }
  }
} catch (err) {
  console.log('error:', (err as Error).message.slice(0, 200), 'stderr:', stderr.slice(-300));
}
