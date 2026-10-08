/**
 * Reads Claude Code's own transcripts to count tokens: every API response the
 * CLI got is a line there, with its model and `message.usage` — the main loop,
 * Task sub-agents (`<session>/subagents/agent-*.jsonl`) and sidechains alike,
 * which the per-turn `result.usage` the provider sees does not cover (main
 * loop only). It also needs no hook in the session code.
 *
 * Incremental: per file, the byte offset already read is stored with the
 * buckets (usage/history.ts), so the first pass is the backfill and every
 * later pass only reads what was appended. Same code, nothing counted twice.
 *
 * Seat: the CLI writes the login it runs as into the transcript (a
 * `session_context` attachment, "The user's email address is …") at each
 * turn, so every response is billed to the seat that served it, seat switches
 * included. Where that is missing, the seat the plugin recorded for the
 * session; else "unknown".
 *
 * Only Alfred's sessions are counted: project dirs of the gateway and of the
 * agent workspaces, plus any session the plugin recorded (claude_code_run in
 * an arbitrary cwd). The user's own Claude Code sessions are left out.
 */

import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pricedModel, type Vec } from './pricing.js';
import type { FileState, ScanStatus, UsageStore } from './history.js';

/** Project dir names (encoded cwd) that are Alfred's. */
export const ALFRED_DIR_PATTERNS: RegExp[] = [
  /alfred.*-agents-.+-workspace$/i, // agent workspaces (alfred-data/agents/<id>/workspace, live-test temp copies)
  /alfred-agent-apps-gateway$/i, // the gateway's cwd: completion (engine) mode
  /alfred-agent-scripts-/i, // end-to-end scripts of the host
];

export function isAlfredDir(name: string): boolean {
  return ALFRED_DIR_PATTERNS.some((re) => re.test(name));
}

/** Agent id from a transcript line's cwd. */
export function agentOfCwd(cwd: string | undefined): string {
  if (!cwd) return '';
  const m = /[\\/]agents[\\/]([^\\/]+)[\\/]workspace(?:[\\/]|$)/i.exec(cwd);
  if (m) return m[1];
  if (/[\\/]apps[\\/]gateway[\\/]?$/i.test(cwd)) return 'engine';
  return '';
}

/** The usage vector of one transcript line, or null when it carries none. */
export function parseLine(line: string): { id: string; at: number; model: string; cwd?: string; v: Vec } | null {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let j: {
    type?: string;
    timestamp?: string;
    requestId?: string;
    cwd?: string;
    message?: {
      id?: string;
      model?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
      };
    };
  };
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  const u = j.message?.usage;
  const model = j.message?.model ?? '';
  if (j.type !== 'assistant' || !u || !model || model === '<synthetic>') return null;
  const at = Date.parse(j.timestamp ?? '');
  if (!Number.isFinite(at)) return null;
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  // Split the cache write by TTL (priced 1.25x / 2x input); without detail it is a 5m write.
  const write = n(u.cache_creation_input_tokens);
  let w5 = write;
  let w1 = 0;
  if (u.cache_creation) {
    const h1 = n(u.cache_creation.ephemeral_1h_input_tokens);
    w1 = write > 0 ? Math.min(write, h1) : h1;
    w5 = write > 0 ? write - w1 : n(u.cache_creation.ephemeral_5m_input_tokens);
  }
  const v: Vec = [1, n(u.input_tokens), w5, w1, n(u.cache_read_input_tokens), n(u.output_tokens)];
  if (v[1] + v[2] + v[3] + v[4] + v[5] === 0) return null;
  return { id: j.message?.id || j.requestId || `${at}`, at, model, cwd: j.cwd, v };
}

/** Message ids remembered per file: a response is written once per content block. */
const IDS_KEPT = 16;
/** Bytes read per step, so one big file never holds the worker. */
const CHUNK = 4 * 1024 * 1024;

export type ScannerOptions = {
  store: UsageStore;
  /** `projects/` dirs to read; links to the same dir are read once. */
  roots: () => string[];
  /** Seat that ran a session, when the plugin knows it. */
  accountOf: (sessionId: string) => string | undefined;
  /** Seats logged in as this email (several seats can share one login). */
  accountsOfEmail?: (email: string) => string[];
  logger?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
  now?: () => number;
};

type Target = { key: string; path: string; sessionId: string; parentKey?: string };

export class TranscriptScanner {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  readonly status: ScanStatus;

  constructor(private readonly opts: ScannerOptions) {
    this.status = { running: false, backfilled: !!opts.store.backfilledAt, filesDone: 0, filesTotal: 0, lastScanAt: null };
  }

  /** First pass soon (the backfill on a fresh state), then one every `everyMs`. */
  start(everyMs = 60_000, firstDelayMs = 3_000): void {
    this.stopped = false;
    const loop = (delay: number): void => {
      this.timer = setTimeout(() => {
        void this.scan().finally(() => {
          if (!this.stopped) loop(everyMs);
        });
      }, delay);
      this.timer.unref?.();
    };
    loop(firstDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.opts.store.save();
    } catch {
      // Best effort on shutdown.
    }
  }

  /** One pass; a pass already running is joined, not doubled. */
  scan(): Promise<void> {
    if (!this.running) {
      this.running = this.doScan().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async targets(): Promise<{ list: Target[]; complete: boolean; roots: string[] }> {
    const list: Target[] = [];
    // Sub-agent transcripts after every main one: they inherit its login.
    const subList: Target[] = [];
    const seenRoots = new Set<string>();
    const realRoots: string[] = [];
    let complete = true;
    for (const root of this.opts.roots()) {
      let real: string;
      try {
        real = await realpath(root);
      } catch {
        continue;
      }
      if (seenRoots.has(real.toLowerCase())) continue;
      seenRoots.add(real.toLowerCase());
      realRoots.push(real);
      let dirs: string[];
      try {
        dirs = (await readdir(real, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        complete = false;
        continue;
      }
      for (const dir of dirs) {
        const alfred = isAlfredDir(dir);
        let entries;
        try {
          entries = await readdir(join(real, dir), { withFileTypes: true });
        } catch {
          complete = false;
          continue;
        }
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.jsonl')) {
            const sid = e.name.slice(0, -6);
            if (alfred || this.opts.accountOf(sid)) list.push({ key: `${dir}/${e.name}`, path: join(real, dir, e.name), sessionId: sid });
          } else if (e.isDirectory() && (alfred || this.opts.accountOf(e.name))) {
            let subs: string[] = [];
            try {
              subs = (await readdir(join(real, dir, e.name, 'subagents'))).filter((n) => n.endsWith('.jsonl'));
            } catch {
              // No sub-agents in this session.
            }
            for (const s of subs) {
              subList.push({ key: `${dir}/${e.name}/subagents/${s}`, path: join(real, dir, e.name, 'subagents', s), sessionId: e.name, parentKey: `${dir}/${e.name}.jsonl` });
            }
          }
        }
      }
    }
    return { list: [...list, ...subList], complete, roots: [...realRoots] };
  }

  private async doScan(): Promise<void> {
    const { store, logger } = this.opts;
    const t0 = Date.now();
    const backfill = !store.backfilledAt;
    this.status.running = true;
    delete this.status.error;
    let bytes = 0;
    let lastSave = Date.now();
    try {
      const { list, complete, roots } = await this.targets();
      this.status.filesTotal = list.length;
      this.status.filesDone = 0;
      for (const t of list) {
        if (this.stopped) return;
        bytes += await this.readFile(t);
        this.status.filesDone++;
        // Checkpoint a long backfill: every write is a consistent state.
        if (Date.now() - lastSave > 20_000) {
          store.save();
          lastSave = Date.now();
        }
      }
      if (complete) {
        const live = new Set(list.map((t) => t.key));
        // Forget only files that are gone: one merely out of scope keeps its
        // offset, so it is never counted twice if it comes back in scope.
        for (const k of store.fileKeys()) {
          if (live.has(k)) continue;
          let exists = false;
          for (const r of roots) {
            try {
              await stat(join(r, k));
              exists = true;
              break;
            } catch {
              // Not under this root.
            }
          }
          if (!exists) store.dropFile(k);
        }
        store.markBackfilled();
        this.status.backfilled = true;
      }
      store.save();
      this.status.lastScanAt = this.opts.now?.() ?? Date.now();
      if (backfill || bytes > 0) {
        logger?.info(backfill ? 'usage history backfilled from transcripts' : 'usage history updated', {
          files: list.length,
          bytes,
          ms: Date.now() - t0,
        });
      }
    } catch (err) {
      this.status.error = (err as Error).message;
      logger?.warn('usage history scan failed', { err: (err as Error).message });
    } finally {
      this.status.running = false;
    }
  }

  /** Reads what was appended to one file since the last pass. Returns bytes read. */
  private async readFile(t: Target): Promise<number> {
    const { store } = this.opts;
    let st;
    try {
      st = await stat(t.path);
    } catch {
      return 0;
    }
    const prev: FileState = store.fileState(t.key) ?? { off: 0, mtime: 0 };
    if (st.size === prev.off) {
      // Untouched for a day: the id memory is no longer needed.
      if (prev.ids && Date.now() - st.mtimeMs > 24 * 3_600_000) {
        store.setFileState(t.key, { off: prev.off, mtime: prev.mtime, ...(prev.email ? { email: prev.email } : {}) });
      }
      return 0;
    }
    if (st.size < prev.off) {
      // Rewritten shorter (never happens to an append-only transcript): skip
      // to the end rather than count anything twice.
      store.setFileState(t.key, { off: st.size, mtime: st.mtimeMs });
      return 0;
    }
    let fh;
    try {
      fh = await open(t.path, 'r');
    } catch {
      return 0;
    }
    let off = prev.off;
    let read = 0;
    const ids: Record<string, [number, number, number, number, number]> = { ...(prev.ids ?? {}) };
    const ctx = { email: prev.email ?? (t.parentKey ? store.fileState(t.parentKey)?.email : undefined) };
    try {
      while (off < st.size && !this.stopped) {
        const len = Math.min(CHUNK, st.size - off);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, off);
        if (bytesRead <= 0) break;
        let end = buf.lastIndexOf(10, bytesRead - 1);
        if (end < 0) {
          // A single line longer than a chunk: read it whole.
          if (len < CHUNK || off + len >= st.size) break; // incomplete last line: wait for the rest
          const big = await this.readLine(fh, off, st.size);
          if (!big) break;
          this.countLines(big.text, t, ids, ctx);
          off += big.bytes;
          read += big.bytes;
          continue;
        }
        const text = buf.subarray(0, end + 1).toString('utf8');
        // Count, then move the offset, with no await between: consistent on save.
        this.countLines(text, t, ids, ctx);
        off += end + 1;
        read += end + 1;
        store.setFileState(t.key, { off, mtime: st.mtimeMs, ids: trimIds(ids), ...(ctx.email ? { email: ctx.email } : {}) });
        await new Promise((r) => setImmediate(r));
      }
      store.setFileState(t.key, { off, mtime: st.mtimeMs, ids: trimIds(ids), ...(ctx.email ? { email: ctx.email } : {}) });
    } finally {
      await fh.close();
    }
    return read;
  }

  private async readLine(fh: import('node:fs/promises').FileHandle, from: number, size: number): Promise<{ text: string; bytes: number } | null> {
    const parts: Buffer[] = [];
    let off = from;
    while (off < size) {
      const len = Math.min(CHUNK, size - off);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, off);
      if (bytesRead <= 0) return null;
      const nl = buf.indexOf(10);
      if (nl >= 0 && nl < bytesRead) {
        parts.push(buf.subarray(0, nl + 1));
        const all = Buffer.concat(parts);
        return { text: all.toString('utf8'), bytes: all.length };
      }
      parts.push(buf.subarray(0, bytesRead));
      off += bytesRead;
    }
    return null;
  }

  /** Seat of the lines that follow: the login the transcript reports, else the recorded one. */
  private seatOf(sessionId: string, email: string | undefined): string {
    const recorded = this.opts.accountOf(sessionId);
    const byEmail = email ? (this.opts.accountsOfEmail?.(email) ?? []) : [];
    if (byEmail.length === 1) return byEmail[0];
    if (byEmail.length > 1) return recorded && byEmail.includes(recorded) ? recorded : byEmail[0];
    return recorded ?? 'unknown';
  }

  private countLines(text: string, t: Target, ids: Record<string, [number, number, number, number, number]>, ctx: { email?: string }): void {
    let account = this.seatOf(t.sessionId, ctx.email);
    let start = 0;
    while (start < text.length) {
      let nl = text.indexOf('\n', start);
      if (nl < 0) nl = text.length;
      const line = text.slice(start, nl);
      start = nl + 1;
      const email = sessionEmail(line);
      if (email) {
        ctx.email = email;
        account = this.seatOf(t.sessionId, email);
        continue;
      }
      const p = parseLine(line);
      if (!p) continue;
      const prev = ids[p.id];
      let v: Vec = p.v;
      if (prev) {
        // Same response again (one line per content block): count only growth.
        v = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < 5; i++) v[i + 1] = Math.max(0, p.v[i + 1] - prev[i]);
        if (v[1] + v[2] + v[3] + v[4] + v[5] === 0) continue;
        for (let i = 0; i < 5; i++) prev[i] = Math.max(prev[i], p.v[i + 1]);
        delete ids[p.id];
        ids[p.id] = prev;
      } else {
        ids[p.id] = [p.v[1], p.v[2], p.v[3], p.v[4], p.v[5]];
      }
      // A length-priced model is stored per price band (usage/pricing.ts).
      const model = pricedModel(p.model, p.v[1] + p.v[2] + p.v[3] + p.v[4]);
      this.opts.store.add(p.at, account, model, agentOfCwd(p.cwd), v);
    }
  }
}

/** The login a `session_context` line reports ("The user's email address is x@y."), if it is one. */
export function sessionEmail(line: string): string | undefined {
  if (!line.includes('"session_context"') && !line.includes('# userEmail')) return undefined;
  const m = /email address is ([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*[A-Za-z0-9])/.exec(line);
  return m ? m[1].toLowerCase() : undefined;
}

function trimIds(ids: Record<string, [number, number, number, number, number]>): Record<string, [number, number, number, number, number]> {
  const keys = Object.keys(ids);
  if (keys.length <= IDS_KEPT) return ids;
  for (const k of keys.slice(0, keys.length - IDS_KEPT)) delete ids[k];
  return ids;
}
