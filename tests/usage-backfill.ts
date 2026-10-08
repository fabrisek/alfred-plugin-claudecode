/**
 * Dry run of the usage backfill against the real transcripts, into a scratch
 * store (the plugin's own state is not touched). Prints the period covered,
 * the totals per day and per seat, and how long the pass took.
 *
 *   node --import tsx tests/usage-backfill.ts            # scratch store in the OS temp dir
 *   node --import tsx tests/usage-backfill.ts --state    # read the plugin's real usage-history.json instead
 */

import { readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageStore } from '../src/usage/history.js';
import { TranscriptScanner } from '../src/usage/transcripts.js';
import { USAGE_ATTRIBUTION_REV, engineSessionSeats } from '../src/usage/register.js';

const STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));
const statePath = join(STATE_DIR, 'usage-history.json');
const useState = process.argv.includes('--state');
const path = useState ? statePath : join(tmpdir(), `alfred-usage-dryrun-${process.pid}.json`);

const sessions = (() => {
  try {
    const raw = JSON.parse(readFileSync(join(STATE_DIR, 'sessions.json'), 'utf8')) as { sessions?: Record<string, { accountId?: string }> };
    return raw.sessions ?? {};
  } catch {
    return {};
  }
})();

const engine = engineSessionSeats(join(STATE_DIR, 'engine-sessions'));

// Seat logins, as the pool recorded them.
const emails = (() => {
  const m = new Map<string, string[]>();
  try {
    const raw = JSON.parse(readFileSync(join(STATE_DIR, 'accounts.json'), 'utf8')) as {
      accounts: Array<{ id: string }>;
      runtime: Record<string, { email?: string }>;
    };
    for (const a of raw.accounts) {
      const e = raw.runtime[a.id]?.email?.toLowerCase();
      if (e) m.set(e, [...(m.get(e) ?? []), a.id]);
    }
  } catch {
    // No pool state: emails stay unknown.
  }
  return m;
})();

async function main(): Promise<void> {
  const store = new UsageStore(path, Date.now, USAGE_ATTRIBUTION_REV);
  if (!useState) {
    const scanner = new TranscriptScanner({
      store,
      roots: () => [join(homedir(), '.claude', 'projects')],
      accountOf: (sid) => sessions[sid]?.accountId ?? engine(sid),
      accountsOfEmail: (email) => emails.get(email) ?? [],
    });
    const t0 = Date.now();
    await scanner.scan();
    const t1 = Date.now();
    await scanner.scan();
    console.log(`first pass ${t1 - t0} ms, ${scanner.status.filesTotal} files; second pass ${Date.now() - t1} ms`);
  }
  const days = store.dailyByAccount();
  const fmt = (n: number): string => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
  for (const day of Object.keys(days).sort()) {
    const parts = Object.entries(days[day]).map(([a, v]) => `${a}: ${v[0]} req in ${fmt(v[1])} cw ${fmt(v[2] + v[3])} cr ${fmt(v[4])} out ${fmt(v[5])}`);
    console.log(day, '|', parts.join(' | '));
  }
  const v = store.view({ scan: { running: false, backfilled: true, filesDone: 0, filesTotal: 0, lastScanAt: null }, seats: [] });
  console.log('models', JSON.stringify(v.models));
  console.log('accounts', JSON.stringify(store.totalsByAccount()));
  console.log('bytes on disk', JSON.stringify(v).length, 'view bytes');
  store.save();
  console.log('store file bytes', readFileSync(path).length);
  if (!useState) rmSync(path, { force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
