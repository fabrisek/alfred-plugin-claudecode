/**
 * Claude Agent-SDK message -> Alfred `SessionEvent` (CLI agent mode).
 *
 * Pure apart from its own per-turn state: no pool, no I/O. The adapter feeds
 * every SDK message through {@link ClaudeEventMapper.map} and forwards what
 * comes out; replay tests feed recorded fixtures
 * (`tests/fixtures/claude-stream/*.jsonl`, CLI 2.1.280 / SDK 0.3.294).
 *
 * Shapes observed in the fixtures that drive the rules below:
 * - every content block of an API message arrives as its OWN `assistant`
 *   message (same `message.id`), and a parallel tool call's result can arrive
 *   before the next tool_use block of the same API message;
 * - a message sent mid-turn is folded into the running turn: its replay echo
 *   (`user`, `isReplay: true`) precedes the single `result`;
 * - sub-agents: `Agent` tool_use + `system/task_started` (task_type
 *   `local_agent`) + messages carrying `parent_tool_use_id` +
 *   `system/task_notification`; a plain Bash also gets task_started/
 *   task_notification (task_type `local_bash`), which is NOT a sub-agent;
 * - planning: CLI 2.1.x has no TodoWrite; it ships TaskCreate / TaskUpdate /
 *   TaskList / TaskGet (deferred, loaded through ToolSearch). Their
 *   `tool_use_result` carries ids and statuses.
 */

import type {
  NativeToolKind,
  RateLimitWindow,
  SessionEvent,
  SessionTodoItem,
  SessionUsage,
} from '@alfred/sdk';

/** Per-event cap on tool payloads crossing the worker boundary (contract: 256 KB). */
export const MAX_EVENT_TEXT = 256 * 1024;

/**
 * One entry of the CLI's own checklist. `id` is the CLI's task id (TaskCreate)
 * or the position (TodoWrite). Extra fields over `SessionTodoItem` are
 * additive: consumers that only know the frozen shape ignore them.
 */
export type ChecklistItem = SessionTodoItem & { id: string; description?: string };

type Msg = Record<string, unknown> & { type?: string; subtype?: string };
type Block = Record<string, unknown> & { type?: string };

export function capText(s: string, max = MAX_EVENT_TEXT): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

/** Structured payloads are dropped rather than cut when they are too big to cross. */
function capStructured(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    const json = JSON.stringify(v);
    return json.length <= MAX_EVENT_TEXT ? v : { truncated: true, bytes: json.length };
  } catch {
    return undefined;
  }
}

const PLANNING_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

export function isPlanningTool(name: string): boolean {
  return PLANNING_TOOLS.has(name);
}

export function toolKind(name: string): NativeToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Bash':
    case 'PowerShell':
    case 'BashOutput':
    case 'KillBash':
    case 'KillShell':
    case 'Monitor':
      return 'shell';
    case 'Read':
      return 'read';
    case 'Write':
      return 'write';
    case 'Edit':
    case 'MultiEdit':
      return 'edit';
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'ToolSearch':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Task':
    case 'Agent':
      return 'subagent';
    case 'NotebookEdit':
    case 'NotebookRead':
      return 'notebook';
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return 'plan';
    default:
      return isPlanningTool(name) ? 'todo' : 'other';
  }
}

/** Text of a `tool_result` content (string, or text/image blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  return content
    .map((b: Block) => {
      if (b?.type === 'text') return String(b.text ?? '');
      if (b?.type === 'image') return '[image]';
      if (b?.type === 'tool_reference') return `[tool ${String(b.tool_name ?? '')}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'week-opus',
  seven_day_sonnet: 'week-sonnet',
  seven_day_overage_included: 'week-overage',
  overage: 'overage',
};

export function rateLimitWindows(info: Record<string, unknown>): RateLimitWindow[] {
  const out: RateLimitWindow[] = [];
  const seen = new Set<string>();
  const unified = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: number } | undefined>;
  for (const [key, w] of Object.entries(unified)) {
    if (!w) continue;
    const name = WINDOW_NAMES[key] ?? key;
    seen.add(name);
    out.push({
      name,
      usedPercent: typeof w.utilization === 'number' ? Math.round(w.utilization * 1000) / 10 : undefined,
      resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined,
    });
  }
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined;
  if (type && !seen.has(WINDOW_NAMES[type] ?? type)) {
    out.push({
      name: WINDOW_NAMES[type] ?? type,
      usedPercent: typeof info.utilization === 'number' ? Math.round(info.utilization * 1000) / 10 : undefined,
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : undefined,
    });
  }
  return out;
}

function rateStatus(s: unknown): 'ok' | 'warning' | 'rejected' {
  if (s === 'rejected') return 'rejected';
  if (s === 'allowed_warning') return 'warning';
  return 'ok';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** API `usage` block -> SessionUsage. */
export function apiUsage(u: Record<string, unknown> | undefined): SessionUsage | undefined {
  if (!u) return undefined;
  const details = (u.output_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    reasoningTokens: num(details.thinking_tokens),
  };
}

type ModelTotals = Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;

/** Cumulative totals a `result` carries (they run across turns and resumes). */
export type SessionTotals = { costUsd: number; byModel: ModelTotals };

export function totalsOf(result: Msg): SessionTotals {
  const byModel: ModelTotals = {};
  const mu = (result.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
  for (const [model, m] of Object.entries(mu)) {
    byModel[model] = {
      inputTokens: (num(m.inputTokens) ?? 0) + (num(m.cacheReadInputTokens) ?? 0) + (num(m.cacheCreationInputTokens) ?? 0),
      outputTokens: num(m.outputTokens) ?? 0,
      costUsd: num(m.costUSD) ?? 0,
    };
  }
  return { costUsd: num(result.total_cost_usd) ?? 0, byModel };
}

/**
 * Usage of ONE Alfred turn from its `result`. Tokens come from `usage`
 * (main loop, per turn); cost and the per-model split are cumulative in the
 * CLI, so they are differenced against the totals seen before this turn.
 */
export function turnUsage(result: Msg, before: SessionTotals | undefined, contextUsed?: number): SessionUsage {
  const u = apiUsage(result.usage as Record<string, unknown> | undefined) ?? {};
  const now = totalsOf(result);
  const byModel: NonNullable<SessionUsage['byModel']> = {};
  for (const [model, t] of Object.entries(now.byModel)) {
    const b = before?.byModel[model];
    byModel[model] = {
      inputTokens: Math.max(0, t.inputTokens - (b?.inputTokens ?? 0)),
      outputTokens: Math.max(0, t.outputTokens - (b?.outputTokens ?? 0)),
      costUsd: Math.max(0, t.costUsd - (b?.costUsd ?? 0)),
    };
  }
  const mu = (result.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
  const windows = Object.values(mu).map((m) => num(m.contextWindow)).filter((n): n is number => n !== undefined);
  return {
    ...u,
    costUsd: Math.max(0, now.costUsd - (before?.costUsd ?? 0)),
    contextUsed,
    contextWindow: windows.length ? Math.max(...windows) : undefined,
    byModel: Object.keys(byModel).length ? byModel : undefined,
  };
}

export type MapperOptions = {
  requestedModel: string;
  /** Exact cwd the session runs in (goes into `SessionRef`, never the CLI's echo). */
  cwd: string;
  resumed: boolean;
  seat?: { id: string; label: string };
  now?: () => number;
};

export class ClaudeEventMapper {
  sessionId?: string;
  servedModel?: string;
  cliVersion?: string;
  /** Main-thread context size after the latest API call (input side + output). */
  contextUsed?: number;
  /** The CLI's own checklist (TaskCreate…/TodoWrite), in creation order. */
  readonly checklist = new Map<string, ChecklistItem>();

  private readonly now: () => number;
  private readonly tools = new Map<string, { name: string; startedAt: number; input?: unknown; parent: string | null }>();
  /** content-block index -> tool_use id, per API message (partial stream). */
  private blockTools = new Map<string, string>();
  private readonly thinking = new Map<string, string>();
  /** Sub-agents by task id, and the Agent tool_use that spawned each. */
  private readonly subagents = new Map<string, { toolUseId?: string }>();
  private readonly subagentByToolUse = new Map<string, string>();
  private modelAnnounced = false;

  constructor(private readonly opts: MapperOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Re-target after a seat switch (same session, new seat). */
  setSeat(seat: { id: string; label: string }, resumed: boolean): void {
    this.opts.seat = seat;
    this.opts.resumed = resumed;
  }

  map(raw: unknown): SessionEvent[] {
    const m = raw as Msg;
    switch (m.type) {
      case 'system':
        return this.system(m);
      case 'stream_event':
        return this.stream(m);
      case 'assistant':
        return this.assistant(m);
      case 'user':
        return this.user(m);
      case 'tool_progress':
        return [
          {
            type: 'tool_progress',
            toolUseId: String(m.tool_use_id ?? ''),
            elapsedMs: typeof m.elapsed_time_seconds === 'number' ? Math.round(m.elapsed_time_seconds * 1000) : undefined,
          },
        ];
      case 'rate_limit_event': {
        const info = (m.rate_limit_info ?? {}) as Record<string, unknown>;
        return [
          {
            type: 'rate_limit',
            seatId: this.opts.seat?.id,
            status: rateStatus(info.status),
            windows: rateLimitWindows(info),
          },
        ];
      }
      default:
        // result is turned into usage/turn_end by the adapter (it knows how
        // many inputs are still pending); everything else is ignored.
        return [];
    }
  }

  private system(m: Msg): SessionEvent[] {
    switch (m.subtype) {
      case 'init': {
        this.sessionId = String(m.session_id ?? '');
        this.servedModel = typeof m.model === 'string' ? m.model : undefined;
        this.cliVersion = typeof m.claude_code_version === 'string' ? m.claude_code_version : undefined;
        const out: SessionEvent[] = [
          {
            type: 'session',
            ref: { sessionId: this.sessionId, cwd: this.opts.cwd, seatId: this.opts.seat?.id },
            resumed: this.opts.resumed,
            model: this.servedModel,
            cliVersion: this.cliVersion,
            permissionMode: typeof m.permissionMode === 'string' ? m.permissionMode : undefined,
            seat: this.opts.seat,
            tools: Array.isArray(m.tools) ? (m.tools as string[]) : undefined,
            mcpServers: Array.isArray(m.mcp_servers)
              ? (m.mcp_servers as Array<{ name?: string; status?: string }>).map((s) => ({
                  name: String(s.name ?? ''),
                  status: String(s.status ?? ''),
                }))
              : undefined,
          },
        ];
        out.push(...this.announceModel(this.servedModel));
        return out;
      }
      case 'status':
        if (m.status === 'compacting') return [{ type: 'status', status: 'compacting' }];
        return [];
      case 'compact_boundary': {
        const meta = (m.compact_metadata ?? {}) as Record<string, unknown>;
        return [
          {
            type: 'compaction',
            trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
            preTokens: num(meta.pre_tokens),
            postTokens: num(meta.post_tokens),
          },
        ];
      }
      case 'api_retry':
        return [
          {
            type: 'status',
            status: 'retrying',
            attempt: num(m.attempt),
            retryInMs: num(m.retry_delay_ms),
            detail: [m.error, m.error_status].filter((x) => x !== undefined && x !== null).join(' '),
          },
        ];
      case 'task_started': {
        if (m.task_type !== 'local_agent' && !m.subagent_type) return [];
        const id = String(m.task_id ?? '');
        const toolUseId = typeof m.tool_use_id === 'string' ? m.tool_use_id : undefined;
        this.subagents.set(id, { toolUseId });
        if (toolUseId) this.subagentByToolUse.set(toolUseId, id);
        return [
          {
            type: 'subagent_start',
            subagentId: id,
            parentToolUseId: toolUseId ?? null,
            agentType: typeof m.subagent_type === 'string' ? m.subagent_type : undefined,
            description: typeof m.description === 'string' ? m.description : undefined,
            prompt: typeof m.prompt === 'string' ? capText(m.prompt, 16_000) : undefined,
            background: m.is_backgrounded === true,
          },
        ];
      }
      case 'task_progress': {
        const id = String(m.task_id ?? '');
        if (!this.subagents.has(id)) return [];
        // The CLI reports a sub-agent's tokens as one total (no input/output
        // split), which SessionUsage cannot carry faithfully: left out.
        return [
          {
            type: 'subagent_progress',
            subagentId: id,
            summary: typeof m.summary === 'string' ? m.summary : typeof m.description === 'string' ? m.description : undefined,
            lastTool: typeof m.last_tool_name === 'string' ? m.last_tool_name : undefined,
          },
        ];
      }
      case 'task_notification': {
        const id = String(m.task_id ?? '');
        if (!this.subagents.has(id)) return [];
        this.subagents.delete(id);
        return [
          {
            type: 'subagent_end',
            subagentId: id,
            status: m.status === 'completed' ? 'completed' : m.status === 'stopped' ? 'cancelled' : 'failed',
            result: typeof m.summary === 'string' ? capText(m.summary, 64_000) : undefined,
          },
        ];
      }
      default:
        return [];
    }
  }

  private announceModel(served: string | undefined): SessionEvent[] {
    if (!served || this.modelAnnounced) return [];
    this.modelAnnounced = true;
    return served !== this.opts.requestedModel
      ? [{ type: 'model', requested: this.opts.requestedModel, served }]
      : [];
  }

  private stream(m: Msg): SessionEvent[] {
    const e = (m.event ?? {}) as Record<string, unknown>;
    const parent = (m.parent_tool_use_id as string | null | undefined) ?? null;
    const scope = parent ?? '';
    switch (e.type) {
      case 'message_start': {
        for (const k of [...this.blockTools.keys()]) if (k.startsWith(`${scope}#`)) this.blockTools.delete(k);
        return [];
      }
      case 'content_block_start': {
        const b = (e.content_block ?? {}) as Block;
        if (b.type !== 'tool_use') return [];
        const id = String(b.id ?? '');
        const name = String(b.name ?? '');
        this.blockTools.set(`${scope}#${String(e.index)}`, id);
        if (this.tools.has(id)) return [];
        this.tools.set(id, { name, startedAt: this.now(), parent });
        return [{ type: 'tool_start', toolUseId: id, name, kind: toolKind(name), parentToolUseId: parent }];
      }
      case 'content_block_delta': {
        const d = (e.delta ?? {}) as Record<string, unknown>;
        if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          return [{ type: 'text_delta', delta: d.text, parentToolUseId: parent }];
        }
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
          return [{ type: 'thinking_delta', delta: d.thinking, parentToolUseId: parent }];
        }
        if (d.type === 'input_json_delta' && typeof d.partial_json === 'string' && d.partial_json) {
          const id = this.blockTools.get(`${scope}#${String(e.index)}`);
          if (id) return [{ type: 'tool_input_delta', toolUseId: id, delta: d.partial_json }];
        }
        return [];
      }
      case 'message_delta': {
        const usage = apiUsage(e.usage as Record<string, unknown> | undefined);
        if (!usage || parent) return [];
        this.contextUsed =
          (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0);
        return [{ type: 'usage', scope: 'step', usage: { ...usage, contextUsed: this.contextUsed } }];
      }
      default:
        return [];
    }
  }

  private assistant(m: Msg): SessionEvent[] {
    const msg = (m.message ?? {}) as { id?: string; model?: string; content?: Block[] };
    // Synthetic turns (limit hit, login expired, unknown model) are errors,
    // never answers: the adapter reads them, nothing is shown as text.
    if (m.error || msg.model === '<synthetic>') return [];
    const parent = (m.parent_tool_use_id as string | null | undefined) ?? null;
    const out: SessionEvent[] = [];
    if (!parent && msg.model) {
      this.servedModel = msg.model;
      out.push(...this.announceModel(msg.model));
    }
    const key = `${parent ?? ''}|${msg.id ?? ''}`;
    for (const b of msg.content ?? []) {
      if (b.type === 'thinking') {
        const t = String(b.thinking ?? '');
        if (t) this.thinking.set(key, (this.thinking.get(key) ?? '') + t);
      } else if (b.type === 'text') {
        const text = String(b.text ?? '');
        const thinking = this.thinking.get(key);
        this.thinking.delete(key);
        if (!text && !thinking) continue;
        out.push({
          type: 'assistant',
          id: String(m.uuid ?? msg.id ?? ''),
          text,
          thinking: thinking || undefined,
          model: msg.model,
          parentToolUseId: parent,
        });
      } else if (b.type === 'tool_use') {
        const thinking = this.thinking.get(key);
        if (thinking) {
          this.thinking.delete(key);
          out.push({ type: 'assistant', id: `${String(m.uuid ?? msg.id ?? '')}:thinking`, text: '', thinking, model: msg.model, parentToolUseId: parent });
        }
        const id = String(b.id ?? '');
        const name = String(b.name ?? '');
        const known = this.tools.get(id);
        if (!known) {
          this.tools.set(id, { name, startedAt: this.now(), input: b.input, parent });
          out.push({ type: 'tool_start', toolUseId: id, name, kind: toolKind(name), input: b.input, parentToolUseId: parent });
        } else {
          known.input = b.input;
        }
        out.push({ type: 'tool_input', toolUseId: id, input: b.input });
        if (name === 'TodoWrite') out.push(...this.todoWrite(b.input));
      }
    }
    return out;
  }

  private user(m: Msg): SessionEvent[] {
    // Replay echoes are acknowledged by the adapter (it owns the input ids).
    if (m.isReplay === true) return [];
    const msg = (m.message ?? {}) as { content?: unknown };
    if (!Array.isArray(msg.content)) return [];
    const parent = (m.parent_tool_use_id as string | null | undefined) ?? null;
    const out: SessionEvent[] = [];
    for (const b of msg.content as Block[]) {
      if (b.type !== 'tool_result') continue;
      const id = String(b.tool_use_id ?? '');
      const tool = this.tools.get(id);
      const ok = b.is_error !== true;
      const structured = m.tool_use_result;
      out.push({
        type: 'tool_result',
        toolUseId: id,
        ok,
        output: capText(resultText(b.content)),
        structured: capStructured(structured),
        durationMs: tool ? this.now() - tool.startedAt : undefined,
        parentToolUseId: parent ?? tool?.parent ?? null,
      });
      if (tool && ok && isPlanningTool(tool.name)) out.push(...this.planning(tool.name, tool.input, structured));
      // The sub-agent's own end usually comes from task_notification; this
      // covers CLIs that do not send one.
      const sub = this.subagentByToolUse.get(id);
      if (sub) {
        this.subagentByToolUse.delete(id);
        if (this.subagents.delete(sub)) {
          out.push({ type: 'subagent_end', subagentId: sub, status: ok ? 'completed' : 'failed', result: capText(resultText(b.content), 64_000) });
        }
      }
    }
    return out;
  }

  // ---- the CLI's checklist ----------------------------------------------

  private snapshot(source: string): SessionEvent {
    return { type: 'todos', items: [...this.checklist.values()].map((i) => ({ ...i })), source };
  }

  private todoWrite(input: unknown): SessionEvent[] {
    const todos = (input as { todos?: unknown })?.todos;
    if (!Array.isArray(todos)) return [];
    this.checklist.clear();
    todos.forEach((t: Record<string, unknown>, i) => {
      const id = typeof t.id === 'string' && t.id ? t.id : String(i + 1);
      this.checklist.set(id, {
        id,
        content: String(t.content ?? ''),
        status: normStatus(t.status),
        activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
      });
    });
    return [this.snapshot('TodoWrite')];
  }

  private planning(name: string, input: unknown, result: unknown): SessionEvent[] {
    const inp = (input ?? {}) as Record<string, unknown>;
    const res = (result ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'TaskCreate': {
        const task = (res.task ?? {}) as Record<string, unknown>;
        const id = String(task.id ?? '');
        if (!id) return [];
        this.checklist.set(id, {
          id,
          content: String(task.subject ?? inp.subject ?? ''),
          status: 'pending',
          activeForm: typeof inp.activeForm === 'string' ? inp.activeForm : undefined,
          description: typeof inp.description === 'string' ? inp.description : undefined,
        });
        return [this.snapshot(name)];
      }
      case 'TaskUpdate': {
        if (res.success === false) return [];
        const id = String(inp.taskId ?? res.taskId ?? '');
        if (!id) return [];
        if (inp.status === 'deleted') {
          this.checklist.delete(id);
          return [this.snapshot(name)];
        }
        const cur = this.checklist.get(id) ?? { id, content: '', status: 'pending' as const };
        const change = (res.statusChange ?? {}) as Record<string, unknown>;
        const next: ChecklistItem = {
          ...cur,
          status: inp.status !== undefined ? normStatus(inp.status) : change.to !== undefined ? normStatus(change.to) : cur.status,
          content: typeof inp.subject === 'string' ? inp.subject : cur.content,
          activeForm: typeof inp.activeForm === 'string' ? inp.activeForm : cur.activeForm,
          description: typeof inp.description === 'string' ? inp.description : cur.description,
        };
        this.checklist.set(id, next);
        return [this.snapshot(name)];
      }
      case 'TaskList': {
        const tasks = res.tasks;
        if (!Array.isArray(tasks)) return [];
        // Authoritative: the list replaces what was inferred (e.g. after a resume).
        const prev = new Map(this.checklist);
        this.checklist.clear();
        for (const t of tasks as Array<Record<string, unknown>>) {
          const id = String(t.id ?? '');
          if (!id) continue;
          const old = prev.get(id);
          this.checklist.set(id, { ...old, id, content: String(t.subject ?? old?.content ?? ''), status: normStatus(t.status) });
        }
        return [this.snapshot(name)];
      }
      case 'TaskGet': {
        const t = (res.task ?? {}) as Record<string, unknown>;
        const id = String(t.id ?? '');
        if (!id) return [];
        const old = this.checklist.get(id);
        this.checklist.set(id, {
          ...old,
          id,
          content: String(t.subject ?? old?.content ?? ''),
          status: normStatus(t.status ?? old?.status),
          description: typeof t.description === 'string' ? t.description : old?.description,
        });
        return [this.snapshot(name)];
      }
      default:
        return [];
    }
  }
}

function normStatus(s: unknown): SessionTodoItem['status'] {
  if (s === 'in_progress' || s === 'completed') return s;
  return 'pending';
}
