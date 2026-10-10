/**
 * Watches every request the provider serves (its `stream` and, in CLI chat
 * mode, its `runSessionTurn`) and keeps what the transcripts cannot tell:
 *  - cold-cache incidents, with the provider's own reason (usage/journal.ts);
 *  - compactions: the host's (a thread's prompt shrinks by a summary) and the
 *    CLI's own (`compaction` session events);
 *  - how each request reached its session (fresh / resume / continue) per day;
 *  - each thread's title, agent and last prompt size, for the panel.
 *
 * Read-only on the stream: chunks and events pass through unchanged. Also
 * pokes the transcript scanner after each served request, so throughput and
 * per-thread spend follow traffic within seconds.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChatChunk, ChatRequest, SessionEvent, SessionTurnRequest } from '@alfred/sdk';
import { parseTurn } from '../webview/activity.js';
import { dayOf } from './history.js';
import { coldCost, type UsageJournal } from './journal.js';
import { threadOfKey } from './threadLedger.js';

/** A thread's prompt that shrinks below this share of its last size, from at least {@link COMPACT_MIN_BEFORE}, was compacted. */
export const COMPACT_RATIO = 0.6;
export const COMPACT_MIN_BEFORE = 30_000;
const THREADS_KEPT = 3000;
const DAYS_KEPT = 35;

export type ThreadInfo = { title?: string; agent: string; conv: string; ctx?: number; at: number; seat?: string };

type StatsFile = {
  version: 1;
  /** local day → session mode → requests */
  modes: Record<string, Record<string, number>>;
  threads: Record<string, ThreadInfo>;
};

/** What the wrapper extracts from one served request. */
export type ServedFacts = {
  at: number;
  thread: string | null;
  agent?: string;
  title?: string;
  seat?: string;
  model?: string;
  mode?: string;
  coldReason?: string;
  cacheWrite: number;
  cacheTtlMs?: number;
  /** Prompt tokens of the request (cached + uncached input). */
  prompt: number;
};

export class ServedStats {
  private data: StatsFile;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  version = 0;

  constructor(
    private readonly path: string,
    private readonly journal: UsageJournal,
    private readonly now: () => number = Date.now,
  ) {
    this.data = this.load();
  }

  private load(): StatsFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StatsFile>;
      if (raw.version === 1) return { version: 1, modes: raw.modes ?? {}, threads: raw.threads ?? {} };
    } catch {
      // First run.
    }
    return { version: 1, modes: {}, threads: {} };
  }

  thread(key: string): ThreadInfo | undefined {
    return this.data.threads[key];
  }

  modesOf(day: string): Record<string, number> {
    return { ...(this.data.modes[day] ?? {}) };
  }

  /** Records one served request: mode count, thread info, cold and compaction incidents. */
  record(f: ServedFacts): void {
    const day = dayOf(f.at);
    if (f.mode) {
      const m = (this.data.modes[day] ??= {});
      m[f.mode] = (m[f.mode] ?? 0) + 1;
    }
    const id = f.thread ? threadOfKey(f.thread) : null;
    const prev = f.thread ? this.data.threads[f.thread] : undefined;
    const agent = id?.agent || f.agent || prev?.agent || '';
    const title = prev?.title || f.title;
    if (f.thread && id) {
      this.data.threads[f.thread] = { title, agent, conv: id.conv, ctx: f.prompt > 0 ? f.prompt : prev?.ctx, at: f.at, seat: f.seat ?? prev?.seat };
    }
    if (f.coldReason && f.cacheWrite > 0) {
      const cost = coldCost(f.model ?? '', f.cacheWrite, f.cacheTtlMs);
      this.journal.append({
        kind: 'cold',
        at: f.at,
        seat: f.seat ?? 'unknown',
        thread: f.thread ?? '',
        conv: id?.conv ?? '',
        agent,
        ...(title ? { title } : {}),
        ...(f.model ? { model: f.model } : {}),
        tok: f.cacheWrite,
        usd: cost.usd,
        wasted: cost.wasted,
        reason: f.coldReason,
      });
    }
    // The host compacted the thread: same thread, a fresh session (its history
    // no longer matches the old one) and a much smaller prompt.
    if (f.thread && id && f.mode === 'fresh' && prev?.ctx && prev.ctx >= COMPACT_MIN_BEFORE && f.prompt > 0 && f.prompt < prev.ctx * COMPACT_RATIO) {
      this.journal.append({ kind: 'compaction', at: f.at, seat: f.seat, thread: f.thread, conv: id.conv, agent, ...(title ? { title } : {}), before: prev.ctx, after: f.prompt, trigger: 'host' });
    }
    this.touch();
  }

  /** A CLI compaction reported by the session itself. */
  recordCompaction(e: { at: number; thread: string; conv: string; agent: string; seat?: string; before: number; after: number; trigger: 'auto' | 'manual' }): void {
    const title = this.data.threads[e.thread]?.title;
    this.journal.append({ kind: 'compaction', ...e, ...(title ? { title } : {}) });
    this.touch();
  }

  /** Remembers a thread's title the first time it is seen. */
  noteThread(key: string, info: { agent: string; conv: string; title?: string; seat?: string }): void {
    const prev = this.data.threads[key];
    if (prev && (prev.title || !info.title)) return;
    this.data.threads[key] = { ...(prev ?? { at: this.now() }), agent: info.agent || prev?.agent || '', conv: info.conv, title: info.title, seat: info.seat ?? prev?.seat };
    this.touch();
  }

  private touch(): void {
    this.version++;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 5_000);
    this.timer.unref?.();
  }

  save(): void {
    if (!this.dirty) return;
    const minDay = dayOf(this.now() - DAYS_KEPT * 86_400_000);
    for (const d of Object.keys(this.data.modes)) if (d < minDay) delete this.data.modes[d];
    const keys = Object.keys(this.data.threads);
    if (keys.length > THREADS_KEPT) {
      keys.sort((a, b) => this.data.threads[a].at - this.data.threads[b].at);
      for (const k of keys.slice(0, keys.length - THREADS_KEPT)) delete this.data.threads[k];
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch {
      // Retried on the next change.
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }
}

type UsageLike = {
  accountId?: string;
  sessionMode?: string;
  coldCacheReason?: string;
  cacheWriteTokens?: number;
  cacheTtlMs?: number;
  servedAt?: number;
  servedModel?: string;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
};

/** The facts of one served request, from its request and the usage of its `done` chunk. */
export function factsOf(req: ChatRequest, usage: UsageLike | undefined, now: number): ServedFacts {
  const key = (req as { session?: { key?: unknown } }).session?.key;
  const thread = typeof key === 'string' && key ? key : null;
  const u = usage ?? {};
  return {
    at: typeof u.servedAt === 'number' ? u.servedAt : now,
    thread,
    seat: u.accountId,
    model: u.servedModel ?? req.model,
    mode: u.sessionMode,
    coldReason: u.coldCacheReason,
    cacheWrite: u.cacheWriteTokens ?? 0,
    cacheTtlMs: u.cacheTtlMs,
    prompt: (u.cachedInputTokens ?? 0) + (u.uncachedInputTokens ?? 0),
  };
}

type Instrumentable = {
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
  runSessionTurn?: (req: SessionTurnRequest) => AsyncIterable<SessionEvent>;
};

/** Wraps the provider so every served request reaches `stats` (and pokes `onServed`). */
export function instrumentServed(provider: Instrumentable, stats: ServedStats, onServed: () => void, now: () => number = Date.now): void {
  const stream = provider.stream.bind(provider);
  provider.stream = (req: ChatRequest) => observeStream(req, stream(req), stats, onServed, now);
  const run = provider.runSessionTurn?.bind(provider);
  if (run) provider.runSessionTurn = (req: SessionTurnRequest) => observeTurn(req, run(req), stats, onServed, now);
}

async function* observeStream(req: ChatRequest, chunks: AsyncIterable<ChatChunk>, stats: ServedStats, onServed: () => void, now: () => number): AsyncIterable<ChatChunk> {
  for await (const c of chunks) {
    if (c.type === 'done') {
      try {
        const f = factsOf(req, c.response.usage as UsageLike | undefined, now());
        if (f.thread && !stats.thread(f.thread)?.title) {
          const turn = parseTurn(req);
          f.title = turn.title || undefined;
          f.agent = turn.agent;
        }
        stats.record(f);
        onServed();
      } catch {
        // Bookkeeping never breaks a reply.
      }
    }
    yield c;
  }
}

async function* observeTurn(req: SessionTurnRequest, events: AsyncIterable<SessionEvent>, stats: ServedStats, onServed: () => void, now: () => number): AsyncIterable<SessionEvent> {
  const thread = `${req.conversationId}|${req.agentId ?? ''}|cli`;
  let seen = false;
  for await (const e of events) {
    try {
      if (!seen) {
        seen = true;
        stats.noteThread(thread, { agent: req.agentId ?? '', conv: req.conversationId, title: firstLine(req.input) });
      }
      if (e.type === 'compaction' && (e.preTokens ?? 0) > 0) {
        stats.recordCompaction({ at: now(), thread, conv: req.conversationId, agent: req.agentId ?? '', before: e.preTokens ?? 0, after: e.postTokens ?? 0, trigger: e.trigger });
      }
      if (e.type === 'usage' && e.scope === 'turn') onServed();
    } catch {
      // Bookkeeping never breaks a turn.
    }
    yield e;
  }
}

function firstLine(input: unknown): string | undefined {
  const text = typeof input === 'string' ? input : (input as { text?: unknown } | undefined)?.text;
  if (typeof text !== 'string') return undefined;
  const line = text.trim().split('\n')[0] ?? '';
  return line ? line.slice(0, 120) : undefined;
}
