/**
 * Persistent journal of the prompt-cache incidents worth investigating:
 *  - cold cache: a served request that re-wrote the conversation's prefix
 *    (time, seat, thread, tokens re-written, reason, what it cost);
 *  - compaction: a conversation's prompt shrunk by a summary (before/after).
 *
 * One JSON line per event, append-only, full history (an incident is rare:
 * a few dozen a day). A cache miss is a bug-detection signal: the panel shows
 * it discreetly, the journal keeps the evidence.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { priceOf } from './pricing.js';

export type ColdEvent = {
  kind: 'cold';
  at: number;
  seat: string;
  thread: string;
  conv: string;
  agent: string;
  title?: string;
  model?: string;
  /** Prompt tokens re-written to the cache by the request. */
  tok: number;
  /** API-equivalent USD of that write. */
  usd: number;
  /** What it cost above the same tokens read from a warm cache. */
  wasted: number;
  reason: string;
};

export type CompactionEvent = {
  kind: 'compaction';
  at: number;
  seat?: string;
  thread: string;
  conv: string;
  agent: string;
  title?: string;
  /** Prompt tokens before and after. */
  before: number;
  after: number;
  /** host = Alfred compacted the history; auto/manual = the CLI's own compaction. */
  trigger: 'host' | 'auto' | 'manual';
};

export type JournalEvent = ColdEvent | CompactionEvent;

/** USD of a cache write and its premium over a warm read, at the model's list price. */
export function coldCost(model: string, tokens: number, ttlMs: number | undefined): { usd: number; wasted: number } {
  const { price } = priceOf(model || 'unknown');
  const write = (ttlMs ?? 3_600_000) >= 3_600_000 ? price.write1h : price.write5m;
  const usd = (tokens * write) / 1e6;
  const warm = (tokens * price.cacheRead) / 1e6;
  const r = (x: number): number => Math.round(x * 1e4) / 1e4;
  return { usd: r(usd), wasted: r(Math.max(0, usd - warm)) };
}

export class UsageJournal {
  private events: JournalEvent[] = [];
  /** Bumped on every append: change detection for the panel. */
  version = 0;

  constructor(
    private readonly path: string,
    private readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void },
  ) {
    this.load();
  }

  private load(): void {
    let text = '';
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return; // first run
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as JournalEvent;
        if ((e.kind === 'cold' || e.kind === 'compaction') && Number.isFinite(e.at)) this.events.push(e);
      } catch {
        // A torn last line (crash mid-write): skipped.
      }
    }
    this.events.sort((a, b) => a.at - b.at);
    this.version = this.events.length;
  }

  append(e: JournalEvent): void {
    this.events.push(e);
    this.version++;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, JSON.stringify(e) + '\n');
    } catch (err) {
      this.logger?.warn('could not write the usage journal', { err: (err as Error).message });
    }
  }

  /** Events since `from` (epoch ms), newest first, optionally of one kind. */
  since<K extends JournalEvent['kind']>(from: number, kind?: K): Array<Extract<JournalEvent, { kind: K }>> {
    const out: JournalEvent[] = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.at < from) break;
      if (!kind || e.kind === kind) out.push(e);
    }
    return out as Array<Extract<JournalEvent, { kind: K }>>;
  }

  get size(): number {
    return this.events.length;
  }
}
