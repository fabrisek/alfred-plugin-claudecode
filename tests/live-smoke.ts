// Manual live check against the DEFAULT login only (tiny haiku request).
// Run: node --import <tsx>/dist/esm/index.mjs tests/live-smoke.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AccountPool } from '../src/accounts/pool.js';
import { authStatus, resolveCli } from '../src/accounts/cli.js';
import { fetchUsage, readCredentials } from '../src/accounts/usage.js';
import { ClaudeCodeProvider } from '../src/ClaudeCodeProvider.js';

const logger = { debug() {}, info() {}, warn: (...a: unknown[]) => console.log('WARN', ...a), error() {} } as never;
const dir = mkdtempSync(join(import.meta.dirname, '.tmp-live-'));
try {
  const pool = new AccountPool({ dataDir: dir, logger });
  const cli = resolveCli('');
  console.log('cli', cli.source, cli.native);
  const def = pool.list()[0];
  console.log('auth status', JSON.stringify({ ...(await authStatus(pool, def, cli)), email: '<redacted>' }));
  const creds = await readCredentials(pool.credentialsPath(def));
  const u = await fetchUsage(creds!.accessToken!, creds!.expiresAt);
  console.log('usage api', JSON.stringify(u));
  const p = new ClaudeCodeProvider({ config: { oauthToken: '', modelsRaw: 'haiku', contextWindow: 200000, pathToClaude: '', requestTimeoutMs: 60000, maxConcurrentRequests: 16, maxParallelTasks: 32 }, pool, cli, logger });
  const red = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=';
  let text = '';
  for await (const c of p.stream({ model: 'haiku', providerOptions: { claudeEffort: 'low' }, messages: [
    { role: 'system', content: 'Answer with one lowercase word.' },
    { role: 'user', content: 'Remember the word: banana.' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'What colour is this image, and what word did I ask you to remember? Two words.', images: [red] },
  ] })) {
    if (c.type === 'text') text += c.delta;
  }
  pool.flush();
  console.log('answer', JSON.stringify(text));
  console.log('recent', JSON.stringify(pool.recent[0]));
  console.log('usage after stream', JSON.stringify(pool.runtime(def.id).usage));
  console.log('tokens', JSON.stringify(pool.tokenSummary(def.id).total));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
