/**
 * What is running on Claude right now, for the accounts panel.
 *
 * The panel has to say, reliably, whether a conversation turn and each of its
 * sub-agents is still running. The adapter, the provider and the session
 * runner each know a piece of that and none of them keeps it in a shape a
 * page can poll, so this board watches the event streams themselves: it wraps
 * the provider's `stream` (completion requests) and `runSessionTurn` (CLI
 * conversation turns) and records every event it sees on the way through,
 * without changing them. "Running" therefore means exactly "the host is still
 * iterating this turn": the wrapper's `finally` closes the item however the
 * iteration ends (result, throw, consumer gone).
 *
 * `claude_code_run` sessions are not wrapped: {@link runItem} maps the
 * runner's own state when the panel asks.
 */

import type { ChatChunk, ChatRequest, SessionEvent, SessionTurnRequest, SessionUsage } from '@alfred/sdk';
import type { RunState } from '../session/runner.js';

export type ActivityKind = 'chat' | 'request' | 'run';
export type ActivityStatus =
  | 'starting'
  | 'running'
  | 'compacting'
  | 'retrying'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'limit'
  | 'stopped'
  | 'cancelled'
  | 'timeout';
export type SubagentStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped';

export type SubagentView = {
  id: string;
  type?: string;
  description?: string;
  status: SubagentStatus;
  background?: boolean;
  startedAt: number;
  endedAt?: number;
  lastTool?: string;
  summary?: string;
};

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  agent?: string;
  conversationId?: string;
  model?: string;
  servedModel?: string;
  effort?: string;
  seatId?: string;
  seat?: string;
  status: ActivityStatus;
  /** Current tool / phase while running, the error once failed. */
  detail?: string;
  startedAt: number;
  endedAt?: number;
  /** Last event of any kind, heartbeats included: a running item that goes quiet is stalled. */
  lastEventAt: number;
  tokensIn?: number;
  tokensOut?: number;
  contextUsed?: number;
  contextWindow?: number;
  subagents: SubagentView[];
  canStop: boolean;
};

const LIVE: ReadonlySet<ActivityStatus> = new Set(['starting', 'running', 'compacting', 'retrying']);
export const isLive = (s: ActivityStatus): boolean => LIVE.has(s);

/** Finished items kept for the panel. */
const KEEP_FINISHED_MS = 30 * 60_000;
const KEEP_FINISHED_MAX = 12;
/** Sub-agents listed per item (the running ones always are). */
const SUBAGENTS_MAX = 12;
const TITLE_MAX = 90;

type Tracked = ActivityItem & {
  /** Tool use id of the running top-level tool. */
  toolUseId?: string;
  /** Task tool use id → sub-agent id, for the tools a sub-agent calls. */
  subByToolUse: Map<string, string>;
  stopRequested?: boolean;
  stop?: () => Promise<unknown> | unknown;
};

export type ActivityBoardOptions = {
  seatLabel?: (id: string) => string | undefined;
  now?: () => number;
};

function oneLine(s: string | undefined, max = TITLE_MAX): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function inputOf(u: SessionUsage | undefined): number | undefined {
  if (!u) return undefined;
  const n = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  return n > 0 ? n : undefined;
}

export class ActivityBoard {
  private readonly items = new Map<string, Tracked>();
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly opts: ActivityBoardOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  private label(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return this.opts.seatLabel?.(id) ?? id;
  }

  private open(item: Omit<Tracked, 'lastEventAt' | 'subagents' | 'subByToolUse' | 'canStop'> & { stop?: Tracked['stop'] }): Tracked {
    const t: Tracked = { ...item, lastEventAt: item.startedAt, subagents: [], subByToolUse: new Map(), canStop: !!item.stop };
    this.items.set(t.id, t);
    this.prune();
    return t;
  }

  private close(t: Tracked, status: ActivityStatus, detail?: string): void {
    if (!isLive(t.status)) return;
    const now = this.now();
    t.status = status;
    t.endedAt = now;
    t.lastEventAt = now;
    t.canStop = false;
    t.toolUseId = undefined;
    if (detail !== undefined) t.detail = detail;
    else if (status === 'done') t.detail = undefined;
    // The CLI is gone with the turn: a sub-agent it never closed is not running.
    for (const s of t.subagents) {
      if (s.status === 'running') {
        s.status = 'stopped';
        s.endedAt = now;
      }
    }
  }

  /** Wraps one CLI conversation turn. Events pass through untouched. */
  async *observeTurn(req: SessionTurnRequest, events: AsyncIterable<SessionEvent>, stop?: () => Promise<unknown>): AsyncIterable<SessionEvent> {
    const t = this.open({
      id: `turn:${req.turnId}`,
      kind: 'chat',
      title: oneLine(req.input?.text) || '(no text)',
      agent: req.agentId,
      conversationId: req.conversationId,
      model: req.model,
      effort: req.effort,
      seatId: req.pinnedSeatId,
      seat: this.label(req.pinnedSeatId),
      status: 'starting',
      startedAt: this.now(),
      stop,
    });
    try {
      for await (const e of events) {
        try {
          this.onTurnEvent(t, e);
        } catch {
          // Bookkeeping never breaks the turn.
        }
        yield e;
      }
    } catch (err) {
      this.close(t, 'failed', oneLine((err as Error)?.message ?? String(err), 300));
      throw err;
    } finally {
      this.close(t, t.stopRequested ? 'interrupted' : 'stopped', t.stopRequested ? undefined : 'the turn ended without a result');
    }
  }

  private sub(t: Tracked, id: string): SubagentView | undefined {
    return t.subagents.find((s) => s.id === id);
  }

  private onTurnEvent(t: Tracked, e: SessionEvent): void {
    const now = this.now();
    t.lastEventAt = now;
    switch (e.type) {
      case 'session':
        if (e.seat) {
          t.seatId = e.seat.id;
          t.seat = e.seat.label;
        }
        if (e.model) t.servedModel = e.model;
        if (t.status === 'starting') t.status = 'running';
        return;
      case 'model':
        t.servedModel = e.served;
        return;
      case 'status':
        if (isLive(t.status)) {
          t.status = e.status === 'compacting' ? 'compacting' : e.status === 'retrying' ? 'retrying' : 'running';
          if (e.status === 'retrying') t.detail = oneLine(`retrying${e.attempt ? ` #${e.attempt}` : ''} ${e.detail ?? ''}`);
          else if (t.detail?.startsWith('retrying')) t.detail = undefined;
        }
        return;
      case 'compaction':
        if (t.status === 'compacting') t.status = 'running';
        return;
      case 'text_delta':
      case 'thinking_delta':
      case 'assistant':
        if (t.status === 'starting' || t.status === 'retrying') t.status = 'running';
        if (t.detail?.startsWith('retrying')) t.detail = undefined;
        return;
      case 'tool_start': {
        if (t.status === 'starting' || t.status === 'retrying') t.status = 'running';
        const owner = e.parentToolUseId ? t.subByToolUse.get(e.parentToolUseId) : undefined;
        if (owner) {
          const s = this.sub(t, owner);
          if (s) s.lastTool = e.name;
        } else if (!e.parentToolUseId) {
          t.toolUseId = e.toolUseId;
          t.detail = e.name;
        }
        return;
      }
      case 'tool_result':
        if (e.toolUseId === t.toolUseId) {
          t.toolUseId = undefined;
          t.detail = undefined;
        }
        return;
      case 'subagent_start': {
        const s: SubagentView = {
          id: e.subagentId,
          type: e.agentType,
          description: oneLine(e.description ?? e.prompt),
          status: 'running',
          background: e.background,
          startedAt: now,
        };
        t.subagents = t.subagents.filter((x) => x.id !== s.id);
        t.subagents.push(s);
        if (e.parentToolUseId) t.subByToolUse.set(e.parentToolUseId, s.id);
        this.capSubagents(t);
        return;
      }
      case 'subagent_progress': {
        const s = this.sub(t, e.subagentId);
        if (!s) return;
        if (e.lastTool) s.lastTool = e.lastTool;
        if (e.summary) s.summary = oneLine(e.summary);
        return;
      }
      case 'subagent_end': {
        const s = this.sub(t, e.subagentId);
        if (!s || s.status !== 'running') return;
        s.status = e.status;
        s.endedAt = now;
        return;
      }
      case 'usage':
        if (e.scope === 'step') {
          if (e.usage.contextUsed) t.contextUsed = e.usage.contextUsed;
          if (e.usage.contextWindow) t.contextWindow = e.usage.contextWindow;
          if (e.usage.outputTokens) t.tokensOut = (t.tokensOut ?? 0) + e.usage.outputTokens;
        } else {
          this.turnUsage(t, e.usage);
        }
        return;
      case 'seat_switch':
        t.seatId = e.to;
        t.seat = this.label(e.to);
        return;
      case 'turn_end': {
        if (e.usage) this.turnUsage(t, e.usage);
        const status: ActivityStatus =
          e.stopReason === 'end_turn' || e.stopReason === 'max_turns'
            ? 'done'
            : e.stopReason === 'interrupted'
              ? 'interrupted'
              : e.stopReason === 'limit'
                ? 'limit'
                : 'failed';
        this.close(t, status, e.error ? oneLine(e.error.message, 300) : e.stopReason === 'max_turns' ? 'max turns reached' : undefined);
        return;
      }
      default:
        return;
    }
  }

  private turnUsage(t: Tracked, u: SessionUsage): void {
    const input = inputOf(u);
    if (input !== undefined) t.tokensIn = input;
    if (u.outputTokens !== undefined) t.tokensOut = u.outputTokens;
    if (u.contextWindow) t.contextWindow = u.contextWindow;
  }

  private capSubagents(t: Tracked): void {
    if (t.subagents.length <= SUBAGENTS_MAX) return;
    const running = t.subagents.filter((s) => s.status === 'running');
    const ended = t.subagents.filter((s) => s.status !== 'running');
    t.subagents = [...ended.slice(Math.max(0, ended.length - Math.max(0, SUBAGENTS_MAX - running.length))), ...running].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
  }

  /** Wraps one completion request (the non-CLI path: delegations, tools, titles…). */
  async *observeRequest(req: ChatRequest, chunks: AsyncIterable<ChatChunk>): AsyncIterable<ChatChunk> {
    const meta = req.metadata ?? {};
    const lastUser = [...(req.messages ?? [])].reverse().find((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const effort = req.providerOptions?.claudeEffort;
    const t = this.open({
      id: `req:${++this.seq}`,
      kind: 'request',
      title: oneLine(meta.source ? `[${meta.source}] ${text}` : text) || '(request)',
      agent: meta.agentId,
      conversationId: meta.conversationId,
      model: req.model,
      effort: typeof effort === 'string' ? effort : undefined,
      status: 'running',
      startedAt: this.now(),
    });
    try {
      for await (const c of chunks) {
        t.lastEventAt = this.now();
        if (c.type === 'tool_call') t.detail = c.call.name;
        if (c.type === 'done') {
          const u = c.response.usage as (SessionUsage & { servedModel?: string }) | undefined;
          if (u?.servedModel) t.servedModel = u.servedModel;
          // No `tokensIn`: this usage carries the uncached input only (cache
          // reads are most of a Claude prompt), so it would read as ~0.
          if (u?.outputTokens) t.tokensOut = u.outputTokens;
          if (u?.contextUsed) t.contextUsed = u.contextUsed;
          this.close(t, 'done');
        }
        yield c;
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.close(t, req.signal?.aborted ? 'cancelled' : 'failed', oneLine(msg, 300));
      throw err;
    } finally {
      this.close(t, req.signal?.aborted ? 'cancelled' : 'stopped', req.signal?.aborted ? undefined : 'ended without a response');
    }
  }

  /** Graceful stop of a live conversation turn. */
  async stop(id: string): Promise<boolean> {
    const t = this.items.get(id);
    if (!t || !t.stop || !isLive(t.status)) return false;
    t.stopRequested = true;
    t.detail = 'stopping…';
    await t.stop();
    return true;
  }

  private prune(): void {
    const now = this.now();
    const finished = [...this.items.values()].filter((t) => !isLive(t.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    finished.forEach((t, i) => {
      if (i >= KEEP_FINISHED_MAX || now - (t.endedAt ?? now) > KEEP_FINISHED_MS) this.items.delete(t.id);
    });
  }

  /** Live items first (oldest first), then the recently finished (newest first). */
  view(extra: ActivityItem[] = []): ActivityItem[] {
    this.prune();
    const all: ActivityItem[] = [...this.items.values()].map((t) => {
      const { subByToolUse: _a, toolUseId: _b, stop: _c, stopRequested: _d, ...view } = t;
      return { ...view, subagents: t.subagents.map((s) => ({ ...s })) };
    });
    all.push(...extra);
    const live = all.filter((t) => isLive(t.status)).sort((a, b) => a.startedAt - b.startedAt);
    const done = all
      .filter((t) => !isLive(t.status))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, KEEP_FINISHED_MAX);
    return [...live, ...done];
  }
}

/** A `claude_code_run` session, as an activity row. */
export function runItem(run: RunState, now = Date.now()): ActivityItem | undefined {
  const ended = run.endedAt ?? (run.status === 'running' ? undefined : run.report ? run.startedAt + run.report.durationMs : now);
  if (ended && now - ended > KEEP_FINISHED_MS) return undefined;
  const status: ActivityStatus =
    run.status === 'running' ? 'running' : run.status === 'done' ? 'done' : run.status === 'error' ? 'failed' : run.status;
  const tokens = run.report?.tokens;
  return {
    id: `run:${run.id}`,
    kind: 'run',
    title: oneLine(run.request.prompt) || '(session)',
    agent: run.request.agent,
    model: run.request.model,
    effort: run.request.effort,
    seatId: run.account?.id,
    seat: run.account?.label,
    status,
    detail: run.report?.error ? oneLine(run.report.error, 300) : run.status === 'running' && run.turns ? `turn ${run.turns}` : undefined,
    startedAt: run.startedAt,
    endedAt: ended,
    lastEventAt: ended ?? now,
    tokensIn: tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : undefined,
    tokensOut: tokens?.output,
    subagents: [],
    canStop: run.status === 'running',
  };
}

type Instrumentable = {
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
  runSessionTurn?(req: SessionTurnRequest): AsyncIterable<SessionEvent>;
  interruptSessionTurn?(turnId: string): Promise<void>;
};

/**
 * Routes a provider's requests and turns through the board. Own-property
 * wrappers on the instance, so `chat()` (which drains `this.stream`) is
 * covered too, and the session facet stays structurally visible to the host.
 */
export function instrumentProvider(provider: Instrumentable, board: ActivityBoard): void {
  const stream = provider.stream.bind(provider);
  provider.stream = (req: ChatRequest) => board.observeRequest(req, stream(req));
  const run = provider.runSessionTurn?.bind(provider);
  const interrupt = provider.interruptSessionTurn?.bind(provider);
  if (run) {
    provider.runSessionTurn = (req: SessionTurnRequest) =>
      board.observeTurn(req, run(req), interrupt ? () => interrupt(req.turnId) : undefined);
  }
}
