/**
 * What a Claude Code agent session did, reconstructed from its message stream:
 * which files it changed (from successful tool calls), which commands it ran,
 * what it was refused, and the final report handed back to the Alfred agent.
 *
 * Pure: no I/O, no SDK import, so it is unit-testable on recorded messages.
 */

import { isAbsolute, relative } from 'node:path';
import type { TokenSample } from '../accounts/pool.js';

export type FileOp = 'write' | 'edit' | 'notebook';

export type FileChange = {
  /** Relative to the session cwd when inside it, else absolute. */
  path: string;
  writes: number;
  edits: number;
  notebookEdits: number;
};

type Pending = { name: string; input: Record<string, unknown> };

const COMMANDS_KEPT = 20;
const COMMAND_CHARS = 160;

/**
 * Follows `tool_use` blocks (assistant messages) and their `tool_result`
 * (user messages). A change counts only once its result came back without
 * `is_error`, so a refused or failed edit is not reported as done.
 */
export class ChangeTracker {
  private readonly pending = new Map<string, Pending>();
  private readonly files = new Map<string, FileChange>();
  private readonly tools = new Map<string, number>();
  private readonly commands: string[] = [];
  private commandCount = 0;
  /** Name and short target of the last tool call seen, for progress lines. */
  lastTool = '';

  constructor(private readonly cwd: string) {}

  /** Feed every SDK message; anything that is not a tool call or result is ignored. */
  observe(message: unknown): void {
    const m = message as { type?: string; message?: { content?: unknown } };
    const content = Array.isArray(m.message?.content) ? (m.message!.content as Array<Record<string, unknown>>) : [];
    if (m.type === 'assistant') {
      for (const block of content) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const name = String(block.name ?? '');
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
        this.pending.set(block.id, { name, input });
        this.lastTool = describeCall(name, input, this.cwd);
      }
    } else if (m.type === 'user') {
      for (const block of content) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = this.pending.get(block.tool_use_id);
        if (!call) continue;
        this.pending.delete(block.tool_use_id);
        if (block.is_error === true) continue;
        this.commit(call);
      }
    }
  }

  private commit(call: Pending): void {
    this.tools.set(call.name, (this.tools.get(call.name) ?? 0) + 1);
    const { name, input } = call;
    if (name === 'Write') this.touch(input.file_path, 'write', 1);
    else if (name === 'Edit') this.touch(input.file_path, 'edit', 1);
    else if (name === 'MultiEdit') {
      this.touch(input.file_path, 'edit', Array.isArray(input.edits) ? input.edits.length : 1);
    } else if (name === 'NotebookEdit') this.touch(input.notebook_path, 'notebook', 1);
    else if (name === 'Bash' && typeof input.command === 'string') {
      this.commandCount += 1;
      this.commands.push(oneLine(input.command, COMMAND_CHARS));
      if (this.commands.length > COMMANDS_KEPT) this.commands.shift();
    }
  }

  private touch(raw: unknown, op: FileOp, n: number): void {
    if (typeof raw !== 'string' || !raw) return;
    const path = displayPath(raw, this.cwd);
    let f = this.files.get(path);
    if (!f) {
      f = { path, writes: 0, edits: 0, notebookEdits: 0 };
      this.files.set(path, f);
    }
    if (op === 'write') f.writes += n;
    else if (op === 'edit') f.edits += n;
    else f.notebookEdits += n;
  }

  get filesChanged(): FileChange[] {
    return [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  get toolCounts(): Record<string, number> {
    return Object.fromEntries([...this.tools.entries()].sort((a, b) => b[1] - a[1]));
  }

  get commandsRun(): { count: number; last: string[] } {
    return { count: this.commandCount, last: [...this.commands] };
  }
}

function displayPath(p: string, cwd: string): string {
  if (!isAbsolute(p)) return p.replace(/\\/g, '/');
  const rel = relative(cwd, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.replace(/\\/g, '/') : p;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** `Edit src/a.ts`, `Bash npm test`, `Grep foo` — one short line for progress output. */
export function describeCall(name: string, input: Record<string, unknown>, cwd: string): string {
  const target =
    (typeof input.file_path === 'string' && displayPath(input.file_path, cwd)) ||
    (typeof input.notebook_path === 'string' && displayPath(input.notebook_path, cwd)) ||
    (typeof input.command === 'string' && oneLine(input.command, 80)) ||
    (typeof input.pattern === 'string' && oneLine(input.pattern, 80)) ||
    (typeof input.url === 'string' && input.url) ||
    (typeof input.description === 'string' && oneLine(input.description, 80)) ||
    '';
  return target ? `${name} ${target}` : name;
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'timeout';

/** Everything the final tool result reports about one run. */
export type RunReport = {
  status: RunStatus;
  seat: { id: string; label: string };
  model: string;
  cwd: string;
  sessionId?: string;
  resumed: boolean;
  turns: number;
  durationMs: number;
  /** The session's final answer (`result.result`), or the last assistant text when it ended early. */
  resultText: string;
  error?: string;
  /** Epoch ms the seat frees up again, when the run ended on a usage limit. */
  resetsAt?: number | null;
  tokens?: TokenSample;
  files: FileChange[];
  commands: { count: number; last: string[] };
  denials: string[];
  /** Seats tried before this one, with why they were skipped. */
  switchedFrom?: string[];
};

const RESULT_CHARS = 20_000;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fileLine(f: FileChange): string {
  const parts: string[] = [];
  if (f.writes) parts.push(f.writes > 1 ? `written x${f.writes}` : 'written');
  if (f.edits) parts.push(f.edits > 1 ? `edited x${f.edits}` : 'edited');
  if (f.notebookEdits) parts.push(f.notebookEdits > 1 ? `notebook x${f.notebookEdits}` : 'notebook edited');
  return `- ${f.path} (${parts.join(', ')})`;
}

/** The text the Alfred agent reads back. */
export function summarizeRun(r: RunReport): string {
  const head =
    r.status === 'done'
      ? 'Claude Code session finished'
      : r.status === 'cancelled'
        ? 'Claude Code session cancelled'
        : r.status === 'timeout'
          ? 'Claude Code session timed out'
          : r.status === 'running'
            ? 'Claude Code session still running'
            : 'Claude Code session failed';
  const lines: string[] = [
    `${head} on seat "${r.seat.label}" · ${r.model} · ${r.turns} turn${r.turns === 1 ? '' : 's'} · ${fmtDuration(r.durationMs)}${r.resumed ? ' · resumed' : ''}`,
    `cwd: ${r.cwd}`,
  ];
  if (r.sessionId) lines.push(`sessionId: ${r.sessionId} (pass it back as sessionId to continue this session)`);
  if (r.switchedFrom?.length) lines.push(`Skipped seats: ${r.switchedFrom.join('; ')}`);
  if (r.error) {
    const reset = r.resetsAt ? ` (seat frees up ${new Date(r.resetsAt).toLocaleString()})` : '';
    lines.push(`Error: ${r.error}${reset}`);
  }
  if (r.files.length) {
    lines.push(`Files changed (${r.files.length}):`, ...r.files.map(fileLine));
  } else {
    lines.push('Files changed: none reported by Edit/Write tools.');
  }
  if (r.commands.count) {
    lines.push(`Shell commands run: ${r.commands.count}`);
    for (const c of r.commands.last.slice(-5)) lines.push(`  $ ${c}`);
  }
  if (r.denials.length) lines.push(`Refused tool calls: ${r.denials.join('; ')}`);
  if (r.tokens) {
    const t = r.tokens;
    lines.push(
      `Tokens: ${fmtTokens(t.input)} in (+${fmtTokens(t.cacheRead)} cache read, ${fmtTokens(t.cacheWrite)} cache write) · ${fmtTokens(t.output)} out · ~$${t.costUsd.toFixed(2)} API-equivalent (billed to the subscription seat, not per token)`,
    );
  }
  const text = r.resultText.trim();
  if (text) {
    const clipped = text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}\n[... ${text.length - RESULT_CHARS} more characters truncated]` : text;
    lines.push('', r.status === 'done' ? 'Result:' : 'Last output:', clipped);
  }
  return lines.join('\n');
}
