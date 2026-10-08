/**
 * Which seat owns which Claude Code session.
 *
 * A session transcript lives in the CLI config dir of the seat that ran it
 * (`<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<sessionId>.jsonl`), so a
 * resume has to run on that same seat. The plugin records the owner of every
 * session it starts; a session it never saw (one started by hand in a
 * terminal, say) is found by looking for its transcript in each seat's dir.
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Account, AccountPool } from '../accounts/pool.js';

export type SessionEntry = {
  accountId: string;
  cwd: string;
  model: string;
  createdAt: number;
  lastUsedAt: number;
};

const KEEP = 500;

export class SessionIndex {
  private entries: Record<string, SessionEntry>;

  constructor(private readonly path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: Record<string, SessionEntry> };
      this.entries = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
    } catch {
      this.entries = {};
    }
  }

  get(sessionId: string): SessionEntry | undefined {
    return this.entries[sessionId];
  }

  record(sessionId: string, entry: Omit<SessionEntry, 'createdAt' | 'lastUsedAt'>, now = Date.now()): void {
    const prev = this.entries[sessionId];
    this.entries[sessionId] = { ...entry, createdAt: prev?.createdAt ?? now, lastUsedAt: now };
    const ids = Object.keys(this.entries);
    if (ids.length > KEEP) {
      ids
        .sort((a, b) => this.entries[a].lastUsedAt - this.entries[b].lastUsedAt)
        .slice(0, ids.length - KEEP)
        .forEach((id) => delete this.entries[id]);
    }
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions: this.entries }, null, 2));
      renameSync(tmp, this.path);
    } catch {
      // Losing the index only costs the transcript scan on the next resume.
    }
  }
}

/** Session ids are UUIDs; anything else is refused before it reaches a path. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `projects/` of a seat's CLI config dir. */
function projectsDir(a: Account): string {
  return join(a.configDir ?? join(homedir(), '.claude'), 'projects');
}

/** Does this seat's config dir hold the transcript of `sessionId`? */
export function seatHasTranscript(a: Account, sessionId: string): boolean {
  const root = projectsDir(a);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return false;
  }
  return dirs.some((d) => existsSync(join(root, d, `${sessionId}.jsonl`)));
}

/** The seat a session belongs to: the index first, then a transcript scan. */
export function locateSessionSeat(pool: AccountPool, index: SessionIndex, sessionId: string): Account | undefined {
  const known = index.get(sessionId);
  if (known) {
    const a = pool.get(known.accountId);
    if (a) return a;
  }
  return pool.list().find((a) => seatHasTranscript(a, sessionId));
}

export type ResumeSeat =
  | { account: Account; error?: undefined }
  | { account?: undefined; code: 'invalid_args' | 'not_found' | 'unavailable'; error: string; resetsAt?: number };

/**
 * The seat a resume must run on, or why it cannot run now.
 *
 * Deliberately no fallback to another seat: the transcript (and the CLI's
 * file-history snapshots) live in the owner's config dir, so another seat
 * would start a different conversation while claiming to continue this one.
 * When the owner is out of quota the caller gets the reset time and decides —
 * wait, or start a fresh session with its own summary of what happened.
 */
export function seatForResume(
  pool: AccountPool,
  index: SessionIndex,
  sessionId: string,
  now = Date.now(),
): ResumeSeat {
  if (!SESSION_ID_RE.test(sessionId)) {
    return { code: 'invalid_args', error: `"${sessionId}" is not a Claude Code session id (expected a UUID).` };
  }
  const account = locateSessionSeat(pool, index, sessionId);
  if (!account) {
    return {
      code: 'not_found',
      error: `Session ${sessionId} was not found on any Claude seat. Start a new session instead (omit sessionId).`,
    };
  }
  const why = pool.unavailableReason(account, now);
  if (why === null) return { account };
  const rt = pool.runtime(account.id);
  if (why === 'exhausted') {
    const until = rt.exhaustedUntil ?? now;
    return {
      code: 'unavailable',
      resetsAt: until,
      error:
        `Session ${sessionId} belongs to seat "${account.label}", which is out of quota until ${new Date(until).toLocaleString()}. ` +
        'A session can only continue on the seat that holds its transcript. Retry after that time, or start a new session ' +
        '(omit sessionId) with a prompt that summarises the work so far — it will run on another seat.',
    };
  }
  return {
    code: 'unavailable',
    error:
      `Session ${sessionId} belongs to seat "${account.label}", which cannot run right now (${why}). ` +
      'Fix that seat on the Claude accounts page, or start a new session (omit sessionId).',
  };
}
