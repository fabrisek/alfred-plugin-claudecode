/**
 * Reading a subscription seat's usage.
 *
 * Two sources, both verified against a live Team seat (see README "Usage"):
 *
 * 1. `GET https://api.anthropic.com/api/oauth/usage` with the seat's OAuth
 *    access token and `anthropic-beta: oauth-2025-04-20` — what `/usage` in the
 *    CLI shows. Percentages are 0-100, reset times ISO strings. Polled.
 * 2. The `rate_limit_event` the CLI (2.1.x) emits on every turn, carrying
 *    `rate_limit_info.unifiedWindows` with utilization as a 0-1 fraction and
 *    `resetsAt` in unix seconds. Applied live, per request.
 *
 * Both are normalised into {@link UsageWindow}s keyed by window id.
 */

import { readFile } from 'node:fs/promises';

export type UsageWindow = {
  /** `five_hour`, `seven_day`, `seven_day_opus`, `weekly:fable`, ... */
  key: string;
  /** Short display label: `5h`, `Week`, `Opus week`. */
  label: string;
  /** 0-100, or null when the source did not say. */
  percent: number | null;
  /** Epoch ms of the window reset, or null. */
  resetsAt: number | null;
  /** Lowercase model family the window is scoped to (`opus`, `fable`), if any. */
  model?: string;
};

export type AccountUsage = {
  windows: UsageWindow[];
  fetchedAt: number;
  source: 'api' | 'stream';
  /** Set when the last poll could not refresh the numbers; they are older. */
  stale?: string;
};

export type RateLimitInfo = {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
};

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_TIMEOUT_MS = 12_000;

type ApiWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;
type ApiLimit = {
  kind?: string;
  group?: string;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { id?: string | null; display_name?: string | null } | null } | null;
};

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function windowLabel(key: string): { label: string; model?: string } {
  if (key === 'five_hour') return { label: '5h' };
  if (key === 'seven_day') return { label: 'Week' };
  const m = /^seven_day_(.+)$/.exec(key) ?? /^weekly:(.+)$/.exec(key);
  if (m) {
    const model = m[1].toLowerCase();
    return { label: `${model.charAt(0).toUpperCase()}${model.slice(1)} week`, model };
  }
  return { label: key };
}

/** Keys of the legacy per-window fields we understand. Others are product codenames. */
const API_WINDOW_KEYS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/** Normalise the `/api/oauth/usage` JSON body. */
export function parseUsageResponse(body: unknown, now = Date.now()): AccountUsage {
  const b = (body ?? {}) as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  const add = (w: UsageWindow): void => {
    if (!windows.some((x) => x.key === w.key)) windows.push(w);
  };
  for (const key of API_WINDOW_KEYS) {
    const w = b[key] as ApiWindow;
    if (!w || typeof w !== 'object') continue;
    add({
      key,
      ...windowLabel(key),
      percent: typeof w.utilization === 'number' ? w.utilization : null,
      resetsAt: toMs(w.resets_at),
    });
  }
  // The newer generic list. On a Team seat `seven_day` is null and the weekly
  // limit only exists here, scoped to a model.
  const limits = Array.isArray(b.limits) ? (b.limits as ApiLimit[]) : [];
  for (const l of limits) {
    const percent = typeof l.percent === 'number' ? l.percent : null;
    const resetsAt = toMs(l.resets_at);
    if (l.group === 'session') {
      add({ key: 'five_hour', ...windowLabel('five_hour'), percent, resetsAt });
    } else if (l.group === 'weekly') {
      const name = l.scope?.model?.display_name || l.scope?.model?.id || '';
      if (name) {
        const family = modelFamily(name) ?? name.toLowerCase();
        const legacy = `seven_day_${family}`;
        if (windows.some((w) => w.key === legacy)) continue;
        add({ key: `weekly:${family}`, ...windowLabel(`weekly:${family}`), percent, resetsAt });
      } else {
        add({ key: 'seven_day', ...windowLabel('seven_day'), percent, resetsAt });
      }
    }
  }
  return { windows, fetchedAt: now, source: 'api' };
}

/** Merge a live `rate_limit_event` into the known windows. */
export function applyRateLimitInfo(
  prev: AccountUsage | undefined,
  info: RateLimitInfo,
  now = Date.now(),
): AccountUsage {
  const windows = prev ? prev.windows.map((w) => ({ ...w })) : [];
  const upsert = (key: string, utilization: number | undefined, resetsAtSec: number | undefined): void => {
    const percent = typeof utilization === 'number' ? Math.round(utilization * 1000) / 10 : null;
    const resetsAt = typeof resetsAtSec === 'number' ? resetsAtSec * 1000 : null;
    // Stream window ids use the `seven_day_<model>` spelling; the API's scoped
    // list may have stored the same window as `weekly:<model>`.
    const alias = key.startsWith('seven_day_') ? `weekly:${key.slice('seven_day_'.length)}` : '';
    const existing = windows.find((w) => w.key === key || (alias && w.key === alias));
    if (existing) {
      if (percent !== null) existing.percent = percent;
      if (resetsAt !== null) existing.resetsAt = resetsAt;
    } else {
      windows.push({ key, ...windowLabel(key), percent, resetsAt });
    }
  };
  for (const [key, w] of Object.entries(info.unifiedWindows ?? {})) {
    if (w) upsert(key, w.utilization, w.resetsAt);
  }
  if (info.rateLimitType && !info.unifiedWindows?.[info.rateLimitType]) {
    upsert(info.rateLimitType, info.utilization, info.resetsAt);
  }
  return { windows, fetchedAt: now, source: 'stream' };
}

/** `opus` / `sonnet` / `haiku` / `fable` contained in a model id or label. */
export function modelFamily(model: string | undefined): string | undefined {
  const m = (model ?? '').toLowerCase();
  return ['opus', 'sonnet', 'haiku', 'fable'].find((f) => m.includes(f));
}

/**
 * Highest utilisation among the windows that constrain a request for `model`:
 * the unscoped ones plus the ones scoped to that model's family. A window
 * whose reset time has passed counts as empty.
 */
export function relevantPercent(usage: AccountUsage | undefined, model: string, now = Date.now()): number {
  if (!usage) return 0;
  const family = modelFamily(model);
  let max = 0;
  for (const w of usage.windows) {
    if (w.model && w.model !== family) continue;
    if (w.resetsAt !== null && w.resetsAt <= now) continue;
    if (typeof w.percent === 'number' && w.percent > max) max = w.percent;
  }
  return max;
}

/** Earliest future reset among the windows relevant to `model` that are at/over `threshold`. */
export function blockingReset(
  usage: AccountUsage | undefined,
  model: string,
  threshold: number,
  now = Date.now(),
): number | null {
  if (!usage) return null;
  const family = modelFamily(model);
  let best: number | null = null;
  for (const w of usage.windows) {
    if (w.model && w.model !== family) continue;
    if (w.resetsAt === null || w.resetsAt <= now) continue;
    if ((w.percent ?? 0) < threshold) continue;
    if (best === null || w.resetsAt > best) best = w.resetsAt;
  }
  return best;
}

export type OAuthCredentials = {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
};

/** The `claudeAiOauth` block of a config dir's `.credentials.json`, or null. */
export async function readCredentials(path: string): Promise<OAuthCredentials | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { claudeAiOauth?: OAuthCredentials };
    const o = raw.claudeAiOauth;
    return o && typeof o.accessToken === 'string' && o.accessToken ? o : null;
  } catch {
    return null;
  }
}

/** Retry-After as milliseconds: seconds, or an HTTP date. */
export function retryAfterMs(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

export type UsageFetchResult =
  | { ok: true; usage: AccountUsage }
  | { ok: false; reason: string; authFailed?: boolean; status?: number; retryAfterMs?: number };

/**
 * Poll the usage endpoint with a bearer token. Never throws, never logs the
 * token. An expired access token is not refreshed here — the CLI owns the
 * refresh and rewrites `.credentials.json` on the seat's next request — so the
 * caller keeps the previous numbers and marks them stale.
 */
export async function fetchUsage(
  token: string,
  expiresAt: number | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<UsageFetchResult> {
  if (typeof expiresAt === 'number' && expiresAt < Date.now() + 30_000) {
    return { ok: false, reason: 'access token expired; refreshes on next request' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), USAGE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (res.status === 401) return { ok: false, reason: 'token rejected (401)', authFailed: false };
    if (res.status === 403) return { ok: false, reason: 'usage not readable with this token (403)' };
    if (res.status === 429) {
      return { ok: false, reason: 'usage endpoint rate limited (429)', status: 429, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
    }
    if (!res.ok) return { ok: false, reason: `usage endpoint HTTP ${res.status}`, status: res.status, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
    return { ok: true, usage: parseUsageResponse(await res.json()) };
  } catch (err) {
    return {
      ok: false,
      reason: ctrl.signal.aborted ? 'usage endpoint timed out' : `usage fetch failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
