/**
 * Wires the token history into the plugin: the store under `state/`, the
 * transcript scanner (first pass = backfill, then one pass a minute) and the
 * `usageHistory` action the panel polls.
 */

import type { PluginContext } from '@alfred/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountPool } from '../accounts/pool.js';
import type { SessionIndex } from '../session/sessions.js';
import { UsageStore } from './history.js';
import { TranscriptScanner } from './transcripts.js';
import { CapacityTracker, capacityRows } from './capacity.js';
import { dayOf } from './history.js';
import { planOf } from './pricing.js';
import { readdirSync, statSync } from 'node:fs';

export const USAGE_SCAN_EVERY_MS = 60_000;
/**
 * Attribution revision of the stored history. Bumped when seats can be told
 * apart better: the next start rebuilds the history from the transcripts.
 * 2: engine-mode sessions attributed through state/engine-sessions.
 * 3: every response attributed to the login its transcript reports.
 * 4: cache writes without a TTL split priced at the TTL the seat writes with (1h);
 *    models without a list price no longer priced as Opus.
 */
export const USAGE_ATTRIBUTION_REV = 4;

export function registerUsageHistory(ctx: PluginContext, pool: AccountPool, sessions: SessionIndex): { stop(): void } {
  const store = new UsageStore(join(ctx.dataDir, 'usage-history.json'), Date.now, USAGE_ATTRIBUTION_REV);
  const engineSeats = engineSessionSeats(join(ctx.dataDir, 'engine-sessions'));
  // Login of each seat: what the pool read from it, else its own .claude.json. Re-read every minute.
  let byEmail = new Map<string, string[]>();
  let byEmailAt = 0;
  const seatsByEmail = (): Map<string, string[]> => {
    if (Date.now() - byEmailAt < 60_000) return byEmail;
    byEmailAt = Date.now();
    const m = new Map<string, string[]>();
    for (const a of pool.list()) {
      let email = pool.runtime(a.id).email;
      if (!email) {
        try {
          email = (JSON.parse(readFileSync(pool.globalConfigPath(a), 'utf8')) as { oauthAccount?: { emailAddress?: string } }).oauthAccount?.emailAddress;
        } catch {
          // Not logged in yet.
        }
      }
      if (email) m.set(email.toLowerCase(), [...(m.get(email.toLowerCase()) ?? []), a.id]);
    }
    byEmail = m;
    return m;
  };
  const scanner = new TranscriptScanner({
    store,
    // Every seat's projects/ dir; with the shared store they are all one.
    roots: () => [
      join(homedir(), '.claude', 'projects'),
      ...pool.list().map((a) => join(a.configDir ?? join(homedir(), '.claude'), 'projects')),
    ],
    accountOf: (sid) => sessions.get(sid)?.accountId ?? engineSeats(sid),
    accountsOfEmail: (email) => seatsByEmail().get(email) ?? [],
    logger: ctx.logger,
  });
  scanner.start(USAGE_SCAN_EVERY_MS, 5_000);

  // Lost capacity: each seat's windows, read once a minute from what the usage poll last saw.
  const capacity = new CapacityTracker(join(ctx.dataDir, 'capacity.json'));
  const observe = (): void => {
    for (const a of pool.list()) capacity.observe(a.id, pool.runtime(a.id).usage);
    try {
      capacity.save();
    } catch (err) {
      ctx.logger.warn('could not save the capacity history', { err: (err as Error).message });
    }
  };
  observe();
  const capTimer = setInterval(observe, 60_000);
  capTimer.unref?.();

  // Plan of each seat, from its own login files (re-read every 10 min).
  let plans: Record<string, { label: string; monthlyUsd: number }> = {};
  let plansAt = 0;
  const readJson = (path: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const seatPlans = (): typeof plans => {
    if (Date.now() - plansAt < 600_000) return plans;
    plansAt = Date.now();
    const out: typeof plans = {};
    for (const a of pool.list()) {
      const creds = (readJson(pool.credentialsPath(a)).claudeAiOauth ?? {}) as { subscriptionType?: string; rateLimitTier?: string };
      const acct = (readJson(pool.globalConfigPath(a)).oauthAccount ?? {}) as { seatTier?: string };
      const plan = planOf({ subscriptionType: creds.subscriptionType ?? pool.runtime(a.id).subscriptionType, rateLimitTier: creds.rateLimitTier, seatTier: acct.seatTier });
      if (plan) out[a.id] = { label: plan.label, monthlyUsd: plan.monthlyUsd };
    }
    plans = out;
    return plans;
  };

  // `since`: the version the page already drew. Same version = only the scan
  // status comes back, so an idle panel moves a few bytes.
  ctx.registerAction('usageHistory', async (args) => {
    try {
      const a = (args ?? {}) as { since?: unknown; hours?: unknown };
      // The hour is part of the version: the hourly window moves even when nothing new came in.
      const version = `${store.version}@${Math.floor(Date.now() / 3_600_000)}#${capacity.events.length}`;
      if (a.since === version) return { ok: true, unchanged: true, version, scan: scanner.status };
      const hours = Number(a.hours);
      const view = store.view({
        scan: scanner.status,
        seats: pool.list().map((x) => ({ id: x.id, label: x.label })),
        plans: seatPlans(),
        hourSpan: Number.isFinite(hours) && hours >= 24 && hours <= 24 * 30 ? Math.round(hours) : 48,
      });
      return { ok: true, ...view, version, capacity: capacityView(capacity, store) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  return {
    stop: () => {
      clearInterval(capTimer);
      scanner.stop();
      try {
        capacity.save();
      } catch {
        // Best effort on shutdown.
      }
    },
  };
}

/**
 * Seat of an engine-mode session, from the records the engine keeps under
 * `state/engine-sessions/` (`{ sessionId, accountId }` per file). Read-only
 * and defensive: a missing or changed format just means "unknown". Re-read
 * at most every 30 s, and only the files that changed.
 */
export function engineSessionSeats(dir: string): (sessionId: string) => string | undefined {
  const bySession = new Map<string, string>();
  const seen = new Map<string, number>();
  let at = 0;
  const refresh = (): void => {
    if (Date.now() - at < 30_000) return;
    at = Date.now();
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const n of names) {
      try {
        const path = join(dir, n);
        const m = statSync(path).mtimeMs;
        if (seen.get(n) === m) continue;
        seen.set(n, m);
        const rec = JSON.parse(readFileSync(path, 'utf8')) as { sessionId?: unknown; accountId?: unknown };
        if (typeof rec.sessionId === 'string' && typeof rec.accountId === 'string') bySession.set(rec.sessionId, rec.accountId);
      } catch {
        // Being written, or not a record.
      }
    }
  };
  return (sessionId) => {
    refresh();
    return bySession.get(sessionId);
  };
}

/**
 * Lost capacity for the panel, per local day of the reset, seat and window:
 * resets seen, summed utilisation, what was used, and the estimated value of
 * the whole windows (where it can be estimated).
 */
function capacityView(capacity: CapacityTracker, store: { spend(a: string, f: number, t: number): { tokens: number; usd: number } }): {
  since: number;
  rows: Array<{ day: string; account: string; window: string; n: number; pct: number; usedTok: number; usedUsd: number; estN: number; fullTok: number; fullUsd: number; estUsedTok: number; estUsedUsd: number }>;
} {
  const out = new Map<string, { day: string; account: string; window: string; n: number; pct: number; usedTok: number; usedUsd: number; estN: number; fullTok: number; fullUsd: number; estUsedTok: number; estUsedUsd: number }>();
  for (const r of capacityRows(capacity.events, (a, f, t) => store.spend(a, f, t))) {
    const day = dayOf(r.resetAt);
    const k = `${day}|${r.account}|${r.window}`;
    const g = out.get(k) ?? { day, account: r.account, window: r.window, n: 0, pct: 0, usedTok: 0, usedUsd: 0, estN: 0, fullTok: 0, fullUsd: 0, estUsedTok: 0, estUsedUsd: 0 };
    g.n++;
    g.pct += r.percent ?? 0;
    g.usedTok += r.usedTokens;
    g.usedUsd += r.usedUsd;
    if (r.fullTokens !== null && r.fullUsd !== null) {
      g.estN++;
      g.fullTok += r.fullTokens;
      g.fullUsd += r.fullUsd;
      g.estUsedTok += r.usedTokens;
      g.estUsedUsd += r.usedUsd;
    }
    out.set(k, g);
  }
  const round = (x: number): number => Math.round(x * 100) / 100;
  return {
    since: capacity.since,
    rows: [...out.values()].map((g) => ({ ...g, usedUsd: round(g.usedUsd), fullUsd: round(g.fullUsd), estUsedUsd: round(g.estUsedUsd) })),
  };
}
