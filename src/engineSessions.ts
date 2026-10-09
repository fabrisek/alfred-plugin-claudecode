import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, Message } from '@alfred/sdk';

/**
 * Persistent Claude Code sessions for engine-mode turns.
 *
 * One Alfred conversation (per agent and delegation) = one Claude Code
 * session. Its CLI process stays alive between iterations and turns
 * (stream-json input) and only receives what is new since its last reply:
 * the tool results or the user message, never the whole history again.
 *
 * Every API request still carries the full history — the Messages API is
 * stateless — but the CLI sends it as a stable prefix of real messages, so
 * the server-side prompt cache serves it as a cheap read and only the delta
 * is written. The previous design re-flattened the whole conversation into
 * ONE growing text block for every iteration: no cache breakpoint ever
 * matched a block boundary and the entire history was re-written each time.
 *
 * A record per session is kept on disk (session id, seat, the system prompt
 * the process was launched with, fingerprints of the messages it holds), so
 * a process that went away — idle close, gateway restart, crash — is
 * continued with `--resume` on the same seat, and its cache with it.
 */

/** History slot standing for the session's own reply: Alfred re-renders it, so it is matched by role only. */
export const ASSISTANT_SLOT = '@assistant';

/** The CLI's own default when nothing better is known (`sce` in the CLI). */
export const CACHE_TTL_5M = 5 * 60_000;
/** One-hour prompt cache (`EV` in the CLI). */
export const CACHE_TTL_1H = 60 * 60_000;
/** Live CLI processes kept at once; the least recently used idle one is closed beyond. */
export const MAX_LIVE_SESSIONS = 8;
/** A sub-agent's process idle this long is closed (it resumes on its next request). */
export const TASK_IDLE_MS = 2 * 60_000;
/** Records untouched for this long are forgotten (their cache is long gone). */
const RECORD_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/** Stable identity of a message as Alfred stores it. */
export function messageFingerprint(m: Message): string {
  const h = createHash('sha1');
  h.update(`${m.role}\0${m.name ?? ''}\0${m.toolCallId ?? ''}\0`);
  h.update(m.content ?? '');
  h.update('\0');
  h.update(JSON.stringify((m.toolCalls ?? []).map((t) => [t.name, t.arguments ?? {}])));
  for (const img of m.images ?? []) h.update(`\0img:${img.length}:${img.slice(0, 64)}:${img.slice(-64)}`);
  for (const a of m.attachments ?? []) h.update(`\0att:${a.name}:${a.mimeType}:${a.data?.length ?? 0}`);
  return h.digest('hex').slice(0, 24);
}

export type EngineSessionRecord = {
  key: string;
  /** Claude Code session id, known once the CLI reported it. */
  sessionId: string | null;
  accountId: string;
  /** System prompt the session was started with: a `--resume` must reuse it or the cached prefix is lost. */
  launchSystem: string;
  /** System prompt as the model last saw it (launch prompt + updates sent as messages). */
  currentSystem: string;
  /** Fingerprints of the non-system messages the session holds, {@link ASSISTANT_SLOT} for its replies. */
  history: string[];
  /**
   * The session's last reply was cut by a Stop. The host may drop that reply
   * from its history (it usually does) or keep what had streamed: both
   * continue the session.
   */
  interruptedTail?: boolean;
  /**
   * Transcript entry (CLI uuid) of the session's last reply that Alfred kept:
   * a resume truncates there (`resumeSessionAt`), so whatever a failed or
   * killed request appended after it (its delta, an API error) is dropped and
   * the delta is sent again, once.
   */
  lastUuid?: string;
  updatedAt: number;
};

export type SessionPlan =
  | { kind: 'fresh'; reason: string }
  | { kind: 'continue'; delta: Message[]; systemNote: string | null };

/**
 * Can this request continue `rec`, and with which messages?
 *
 * It can when the conversation Alfred sends is the session's history plus new
 * user / tool messages only: Alfred appended the session's last reply and
 * what followed. Anything else — an edited or regenerated message, a
 * compaction, another seat — starts a fresh session from the full history.
 */
export function planSession(
  rec: EngineSessionRecord | undefined,
  req: { accountId: string; system: string; messages: Message[]; crossSeat?: boolean },
): SessionPlan {
  if (!rec) return { kind: 'fresh', reason: 'new' };
  if (!rec.sessionId) return { kind: 'fresh', reason: 'no session id' };
  // Every seat reads the same transcripts (shared store): another seat
  // resumes the same session. Otherwise only its own seat can.
  if (rec.accountId !== req.accountId && !req.crossSeat) return { kind: 'fresh', reason: 'other seat' };
  const msgs = req.messages;
  let history = rec.history;
  if (rec.interruptedTail && history.at(-1) === ASSISTANT_SLOT && msgs[history.length - 1]?.role !== 'assistant') {
    // The stopped reply is not in Alfred's history: the session keeps it, and
    // the next message follows it.
    history = history.slice(0, -1);
  }
  if (msgs.length <= history.length) return { kind: 'fresh', reason: 'history shrank or was replayed' };
  for (let i = 0; i < history.length; i++) {
    const slot = history[i];
    const ok = slot === ASSISTANT_SLOT ? msgs[i].role === 'assistant' : slot === messageFingerprint(msgs[i]);
    if (!ok) return { kind: 'fresh', reason: `history diverged at message ${i}` };
  }
  const delta = msgs.slice(history.length);
  if (delta.some((m) => m.role === 'assistant')) return { kind: 'fresh', reason: 'assistant message not produced by the session' };
  const note = systemUpdateNote(rec.currentSystem, req.system);
  if (note === 'too-large') return { kind: 'fresh', reason: 'system prompt rewritten' };
  return { kind: 'continue', delta, systemNote: note };
}

/**
 * The part of the system prompt that changed, as a note for the model.
 *
 * The system prompt is the head of the cached prefix: changing it re-writes
 * the whole conversation. Alfred's prompt ends with volatile context (open
 * tasks, boot notes), so a change there is told to the session as a message
 * instead. A rewrite of more than half the prompt is not a context update:
 * the caller starts over.
 */
export function systemUpdateNote(prev: string, next: string): string | null | 'too-large' {
  if (prev === next) return null;
  const a = prev.split('\n');
  const b = next.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const removed = a.slice(p, a.length - s).join('\n');
  const added = b.slice(p, b.length - s).join('\n');
  if (removed.length + added.length > next.length / 2) return 'too-large';
  let heading = '';
  for (let i = p - 1; i >= 0; i--) {
    if (/^#{1,6} /.test(b[i])) {
      heading = b[i].replace(/^#+ /, '');
      break;
    }
  }
  const where = heading ? ` in section "${heading}"` : '';
  const parts = [`<system-update>\nYour system context changed${where} since this conversation started.`];
  if (removed.trim()) parts.push(`No longer applies:\n${removed}`);
  if (added.trim()) parts.push(`Now reads:\n${added}`);
  parts.push('</system-update>');
  return parts.join('\n');
}

/** Where the volatile tail of Alfred's system prompt starts (see core ProjectContextRenderer). */
const VOLATILE_MARKERS = ['\n# Dynamic Project Context\n', '\n## Runtime\n'];

/**
 * Split Alfred's system prompt into the part shared by every request of an
 * agent (persona, tools) and its volatile tail (boot notes, heartbeat, open
 * tasks, runtime line). The tail changes from turn to turn and between two
 * delegations of the same agent; in the system prompt it would make the whole
 * cached prefix a miss.
 */
export function splitVolatileContext(system: string): { stable: string; volatile: string } {
  let at = -1;
  for (const marker of VOLATILE_MARKERS) {
    const i = system.indexOf(marker);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return { stable: system, volatile: '' };
  return { stable: system.slice(0, at).trimEnd(), volatile: system.slice(at).trim() };
}

/** Cache TTL the API reported for one response, from its cache-write breakdown. */
export function cacheTtlOf(usage: unknown): number | null {
  const cc = (usage as { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } | undefined)
    ?.cache_creation;
  if (!cc) return null;
  if ((cc.ephemeral_1h_input_tokens ?? 0) > 0) return CACHE_TTL_1H;
  if ((cc.ephemeral_5m_input_tokens ?? 0) > 0) return CACHE_TTL_5M;
  return null;
}

/** Async queue feeding user messages to a live CLI process. */
export class PushQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** The SDK `Query` surface a live session uses. */
export type LiveQuery = AsyncIterable<unknown> & {
  interrupt?: () => Promise<unknown>;
  close?: () => void;
};

/** A CLI process serving one session. */
export class LiveSession {
  busy = false;
  dead = false;
  lastUsed = Date.now();
  /** `total_cost_usd` the CLI reported so far (cumulative per process). */
  costSoFar = 0;
  /** Advisor model the process was launched with (accounts/advisor.ts); undefined = none. */
  advisor: string | undefined;
  readonly iterator: AsyncIterator<unknown>;
  idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly key: string,
    readonly accountId: string,
    readonly model: string,
    readonly effort: string | null,
    readonly query: LiveQuery,
    readonly input: PushQueue<unknown>,
    readonly controller: AbortController,
  ) {
    this.iterator = query[Symbol.asyncIterator]();
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.input.close();
    try {
      this.query.close?.();
    } catch {
      // already gone
    }
    try {
      this.controller.abort();
    } catch {
      // already gone
    }
  }
}

/** Records on disk + live processes, with idle close and a cap on live processes. */
export class EngineSessions {
  private readonly live = new Map<string, LiveSession>();
  private readonly records = new Map<string, EngineSessionRecord>();
  /** Prompt-cache TTL last reported per seat; a live process outliving it buys nothing. */
  private readonly ttlBySeat = new Map<string, number>();

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
    private readonly maxLive = MAX_LIVE_SESSIONS,
  ) {
    mkdirSync(dir, { recursive: true });
    this.prune();
  }

  /**
   * Session key of a request: the host's thread key (one per conversation,
   * agent and delegation). One-off calls carry none and stay one-shot.
   */
  static keyOf(req: { session?: { key?: unknown } }): string | null {
    const key = req.session?.key;
    return typeof key === 'string' && key.length > 0 ? key : null;
  }

  private file(key: string): string {
    return join(this.dir, `${createHash('sha1').update(key).digest('hex').slice(0, 32)}.json`);
  }

  record(key: string): EngineSessionRecord | undefined {
    const cached = this.records.get(key);
    if (cached) return cached;
    try {
      const rec = JSON.parse(readFileSync(this.file(key), 'utf8')) as EngineSessionRecord;
      if (rec.key !== key) return undefined;
      this.records.set(key, rec);
      return rec;
    } catch {
      return undefined;
    }
  }

  save(rec: EngineSessionRecord): void {
    rec.updatedAt = Date.now();
    this.records.set(rec.key, rec);
    try {
      writeFileSync(this.file(rec.key), JSON.stringify(rec));
    } catch (err) {
      this.log.warn('engine session record not saved', { error: (err as Error).message });
    }
  }

  forget(key: string): void {
    this.records.delete(key);
    try {
      rmSync(this.file(key), { force: true });
    } catch {
      // nothing to forget
    }
  }

  getLive(key: string): LiveSession | undefined {
    const s = this.live.get(key);
    if (s && s.dead) {
      this.live.delete(key);
      return undefined;
    }
    return s;
  }

  /** Track a new process, closing the least recently used idle ones beyond the cap. */
  add(session: LiveSession): void {
    this.live.set(session.key, session);
    const idle = [...this.live.values()].filter((s) => !s.busy && s !== session).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.live.size > this.maxLive && idle.length > 0) {
      const victim = idle.shift() as LiveSession;
      this.close(victim.key, 'live-process cap');
    }
  }

  /** May a new process be started without exceeding the cap (busy ones cannot be closed)? */
  hasRoom(): boolean {
    const busy = [...this.live.values()].filter((s) => s.busy && !s.dead).length;
    return busy < this.maxLive;
  }

  noteTtl(accountId: string, ttlMs: number | null): void {
    if (ttlMs) this.ttlBySeat.set(accountId, ttlMs);
  }

  ttlFor(accountId: string): number {
    return this.ttlBySeat.get(accountId) ?? CACHE_TTL_5M;
  }

  /** The request is over: close the process once the seat's prompt cache would have expired. */
  release(session: LiveSession, opts: { task?: boolean } = {}): void {
    session.busy = false;
    session.lastUsed = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.dead) {
      this.live.delete(session.key);
      return;
    }
    // A sub-agent between two tool calls comes back within seconds; one that
    // stays silent was stopped (or its parent gave up), and nothing would ever
    // tell this process. Closing it early is free: the prompt cache lives on
    // the server, and the next request resumes the same session.
    const ttl = opts.task ? Math.min(TASK_IDLE_MS, this.ttlFor(session.accountId)) : this.ttlFor(session.accountId);
    session.idleTimer = setTimeout(() => {
      if (!session.busy) this.close(session.key, opts.task ? 'sub-agent idle' : 'prompt cache expired');
    }, ttl);
    session.idleTimer.unref?.();
  }

  close(key: string, reason: string): void {
    const s = this.live.get(key);
    if (!s) return;
    this.live.delete(key);
    if (!s.dead) this.log.info('closing Claude engine session', { reason, account: s.accountId, thread: key });
    s.close();
  }

  liveCount(): number {
    return [...this.live.values()].filter((s) => !s.dead).length;
  }

  dispose(): void {
    for (const key of [...this.live.keys()]) this.close(key, 'plugin stopping');
  }

  private prune(): void {
    try {
      const cutoff = Date.now() - RECORD_MAX_AGE_MS;
      for (const f of readdirSync(this.dir)) {
        const p = join(this.dir, f);
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      }
    } catch {
      // best effort
    }
  }
}
