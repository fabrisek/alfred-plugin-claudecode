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

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatChunk, ChatRequest, SessionEvent, SessionTurnRequest, SessionUsage } from '@alfred/sdk';
import type { RunState } from '../session/runner.js';

export type ActivityKind = 'chat' | 'request' | 'run';
export type ActivityStatus =
  | 'starting'
  | 'running'
  /** Engine turn between two iterations: the host is running the tools the model asked for. */
  | 'tool'
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
  /** Delegating agent and task, for a delegated turn. */
  from?: string;
  taskId?: string;
  /** Engine turns: provider requests so far and the last ones. */
  iterations?: number;
  iterationList?: IterationView[];
  lastTool?: string;
  /** Tool calls made earlier in this turn (from the request history). */
  toolsSoFar?: number;
  /** Identical tool calls repeated: the host's loop check fired, or the history shows the streak. */
  loop?: { streak: number; tools: string[] };
  /** What a running engine request is doing: waiting for a seat, for first output, thinking, writing… */
  phase?: string;
};

export type IterationView = {
  n: number;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'stopped';
  tools: string[];
  tokensOut?: number;
  seat?: string;
  phase?: string;
};

type RequestScope = { item: ActivityItem; iteration: IterationView };
const requestScope = new AsyncLocalStorage<RequestScope>();

const LIVE: ReadonlySet<ActivityStatus> = new Set(['starting', 'running', 'tool', 'compacting', 'retrying']);
export const isLive = (s: ActivityStatus): boolean => LIVE.has(s);

/** Finished items kept for the panel. */
const KEEP_FINISHED_MS = 30 * 60_000;
const KEEP_FINISHED_MAX = 12;
/** Sub-agents listed per item (the running ones always are). */
const SUBAGENTS_MAX = 12;
const TITLE_MAX = 90;
const ITERATIONS_MAX = 40;
/** An engine turn waiting on its tools this long without a new iteration is over. */
const TOOL_WAIT_MAX_MS = 30 * 60_000;
/** Same rule as the host's loop check (core/chat/turn/loopDetector.ts). */
const LOOP_STREAK = 5;

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
  /** Engine turn fingerprint -> its row. */
  private readonly groups = new Map<string, { id: string; live: number }>();
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

  /**
   * Wraps one completion request. In Alfred's own (engine) loop a turn is a
   * series of requests, one after every round of tool calls, so requests are
   * grouped into one row per turn. The host strips the caller metadata before
   * a provider sees a request (sdk `ChatRequest.metadata`: providers must not
   * read it), so the turn is recognised from the request itself: same system
   * prompt, same anchoring user message (see {@link parseTurn}).
   */
  async *observeRequest(req: ChatRequest, chunks: AsyncIterable<ChatChunk>): AsyncIterable<ChatChunk> {
    const info = parseTurn(req);
    const now = this.now();
    const known = this.groups.get(info.key);
    let item = known ? this.items.get(known.id) : undefined;
    let group = known;
    // The same prompt sent again after its turn ended is a new turn.
    if (item && !isLive(item.status) && info.rounds === 0) item = undefined;
    if (!item || !group) {
      const effort = req.providerOptions?.claudeEffort;
      item = this.open({
        id: `eturn:${++this.seq}`,
        kind: 'request',
        title: info.title || '(request)',
        agent: info.agent,
        from: info.from,
        taskId: info.taskId,
        model: req.model,
        effort: typeof effort === 'string' ? effort : undefined,
        status: 'running',
        startedAt: now,
      });
      item.iterationList = [];
      item.iterations = 0;
      item.tokensOut = 0;
      group = { id: item.id, live: 0 };
      this.groups.set(info.key, group);
    }
    const t = item;
    const g = group;
    // A finished turn that gets another request carries on (auto-continue, retry).
    t.status = 'running';
    t.endedAt = undefined;
    t.lastEventAt = now;
    t.toolsSoFar = info.toolsSoFar;
    if (info.lastTool) t.lastTool = info.lastTool;
    t.loop = info.loop;
    t.detail = undefined;
    t.iterations = (t.iterations ?? 0) + 1;
    const it: IterationView = { n: t.iterations, startedAt: now, status: 'running', tools: [] };
    t.iterationList = [...(t.iterationList ?? []), it].slice(-ITERATIONS_MAX);
    g.live++;
    let outcome: 'done' | 'tool' | 'failed' | 'cancelled' | 'stopped' = 'stopped';
    let error: string | undefined;
    t.phase = 'waiting for a seat';
    it.phase = t.phase;
    const scope: RequestScope = { item: t, iteration: it };
    const iter = chunks[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        // The provider's own code runs inside next(): the seat it takes there
        // (pool.begin) is attributed to this request through the scope.
        const r = await requestScope.run(scope, () => iter.next());
        if (r.done) {
          finished = true;
          break;
        }
        const c = r.value;
        t.lastEventAt = this.now();
        const phase =
          c.type === 'thinking' ? 'thinking' : c.type === 'text' ? 'writing' : c.type === 'tool_call_delta' || c.type === 'tool_call' ? 'calling tools' : undefined;
        if (phase) {
          t.phase = phase;
          it.phase = phase;
        }
        if (c.type === 'tool_call') {
          if (!it.tools.includes(c.call.name)) it.tools.push(c.call.name);
          t.lastTool = c.call.name;
        }
        if (c.type === 'done') {
          const u = c.response.usage as (SessionUsage & { servedModel?: string }) | undefined;
          if (u?.servedModel) t.servedModel = u.servedModel;
          if (u?.outputTokens) {
            it.tokensOut = u.outputTokens;
            t.tokensOut = (t.tokensOut ?? 0) + u.outputTokens;
          }
          for (const call of c.response.toolCalls ?? []) {
            if (!it.tools.includes(call.name)) it.tools.push(call.name);
            t.lastTool = call.name;
          }
          outcome = it.tools.length > 0 ? 'tool' : 'done';
        }
        yield c;
      }
    } catch (err) {
      finished = true;
      outcome = req.signal?.aborted ? 'cancelled' : 'failed';
      error = oneLine((err as Error)?.message ?? String(err), 300);
      throw err;
    } finally {
      if (!finished) await iter.return?.();
      t.phase = undefined;
      it.phase = undefined;
      if (outcome === 'stopped' && req.signal?.aborted) outcome = 'cancelled';
      const end = this.now();
      it.endedAt = end;
      it.status = outcome === 'tool' ? 'done' : outcome;
      g.live = Math.max(0, g.live - 1);
      t.lastEventAt = end;
      if (g.live === 0) {
        if (outcome === 'tool') {
          // The host runs the tools, then sends the next iteration.
          t.status = 'tool';
          t.detail = it.tools.join(', ');
        } else {
          t.status = outcome;
          t.endedAt = end;
          t.detail = error ?? (outcome === 'stopped' ? 'ended without a response' : undefined);
        }
      }
    }
  }

  /**
   * A seat was taken (pool.begin). Inside an observed completion request it
   * belongs to that request: the row shows the seat from the moment it is
   * assigned, not only once the answer is back.
   */
  seatTaken(seatId: string): void {
    const scope = requestScope.getStore();
    if (!scope) return;
    const label = this.label(seatId);
    scope.item.seatId = seatId;
    scope.item.seat = label;
    scope.iteration.seat = label;
    scope.item.phase = 'waiting for first output';
    scope.iteration.phase = scope.item.phase;
    scope.item.lastEventAt = this.now();
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
    for (const t of this.items.values()) {
      if (t.status === 'tool' && now - t.lastEventAt > TOOL_WAIT_MAX_MS) {
        t.status = 'stopped';
        t.endedAt = t.lastEventAt;
        t.detail = 'no further iteration after its tools';
      }
    }
    const finished = [...this.items.values()].filter((t) => !isLive(t.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    finished.forEach((t, i) => {
      if (i >= KEEP_FINISHED_MAX || now - (t.endedAt ?? now) > KEEP_FINISHED_MS) this.items.delete(t.id);
    });
    for (const [k, g] of this.groups) if (!this.items.has(g.id)) this.groups.delete(k);
  }

  /** Live items first (oldest first), then the recently finished (newest first). */
  view(extra: ActivityItem[] = []): ActivityItem[] {
    this.prune();
    const all: ActivityItem[] = [...this.items.values()].map((t) => {
      const { subByToolUse: _a, toolUseId: _b, stop: _c, stopRequested: _d, ...view } = t;
      return {
        ...view,
        subagents: t.subagents.map((s) => ({ ...s })),
        iterationList: t.iterationList?.map((i) => ({ ...i, tools: [...i.tools] })),
      };
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
export function instrumentProvider(provider: Instrumentable, board: ActivityBoard, pool?: { begin(id: string): void }): void {
  if (pool) {
    const begin = pool.begin.bind(pool);
    pool.begin = (id: string) => {
      begin(id);
      board.seatTaken(id);
    };
  }
  const stream = provider.stream.bind(provider);
  provider.stream = (req: ChatRequest) => board.observeRequest(req, stream(req));
  const run = provider.runSessionTurn?.bind(provider);
  const interrupt = provider.interruptSessionTurn?.bind(provider);
  if (run) {
    provider.runSessionTurn = (req: SessionTurnRequest) =>
      board.observeTurn(req, run(req), interrupt ? () => interrupt(req.turnId) : undefined);
  }
}

// ---- engine turns -----------------------------------------------------------

export type TurnInfo = {
  key: string;
  title: string;
  agent?: string;
  from?: string;
  taskId?: string;
  toolsSoFar: number;
  lastTool?: string;
  loop?: { streak: number; tools: string[] };
  /** Assistant rounds after the anchor: 0 = the first request of a turn. */
  rounds: number;
};

const LOOP_NOTE = '[Alfred loop check]';
const DELEGATION_RE = /^You have been delegated by agent `([^`]+)` to complete task \*\*([^*]+)\*\*:?\s*([\s\S]*)/;
const LOOP_NOTE_RE = /\(([^)]*)\) with identical arguments (\d+) iterations/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text?: unknown }).text ?? '') : '')).join(' ');
  }
  return '';
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * Who and what an engine request belongs to, from the request alone.
 *
 * The anchor is the last user message that is not a host note (`[Alfred …]`,
 * e.g. the loop check): every iteration of one turn re-sends the history up
 * to it, then the tool rounds after it. The fingerprint is the model, the
 * system prompt head and the anchor's text. The agent name is
 * the persona line ("You are <name>, …"); a delegation is read from the
 * prompt the host writes for it.
 */
export function parseTurn(req: ChatRequest): TurnInfo {
  type Msg = { role: string; content: unknown; toolCalls?: Array<{ name: string; arguments?: unknown }> };
  const msgs = (req.messages ?? []) as unknown as Msg[];
  let anchor = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && !textOf(msgs[i].content).startsWith('[Alfred ')) {
      anchor = i;
      break;
    }
  }
  const system = msgs
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n');
  const prompt = anchor >= 0 ? textOf(msgs[anchor].content) : '';
  const persona = /^You are ([^,.\n]{1,60})[,.]/.exec(system.trimStart());
  const agent = persona ? persona[1].trim() : undefined;
  // Not the anchor's index: a windowed history moves it within one turn.
  const key = hash(`${req.model}\u0000${system.slice(0, 4000)}\u0000${prompt.slice(0, 4000)}`);

  let title = oneLine(prompt);
  let from: string | undefined;
  let taskId: string | undefined;
  const d = DELEGATION_RE.exec(prompt.trim());
  if (d) {
    from = d[1];
    taskId = d[2].trim();
    title = oneLine(d[3].split('\n')[0]) || taskId;
  }

  // Tool rounds after the anchor, and the repetition streak at their tail.
  const rounds: string[] = [];
  let toolsSoFar = 0;
  let lastTool: string | undefined;
  let loop: TurnInfo['loop'];
  for (const m of msgs.slice(anchor + 1)) {
    if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      toolsSoFar += calls.length;
      if (calls.length) lastTool = calls[calls.length - 1].name;
      rounds.push(
        calls
          .map((c) => `${c.name}(${stable(c.arguments ?? {})})`)
          .sort()
          .join('|'),
      );
    }
    if (m.role === 'user' && textOf(m.content).startsWith(LOOP_NOTE)) {
      const n = LOOP_NOTE_RE.exec(textOf(m.content));
      loop = {
        streak: n ? Number(n[2]) : LOOP_STREAK,
        tools: n ? n[1].split(',').map((x) => x.trim()).filter(Boolean) : [],
      };
    }
  }
  const tail = rounds[rounds.length - 1];
  let streak = 0;
  for (let i = rounds.length - 1; i >= 0 && tail && rounds[i] === tail; i--) streak++;
  if (tail && streak >= LOOP_STREAK && (!loop || streak > loop.streak)) {
    loop = { streak, tools: [...new Set(tail.split('|').map((c) => c.slice(0, c.indexOf('('))))] };
  }
  return { key, title, agent, from, taskId, toolsSoFar, lastTool, loop, rounds: rounds.length };
}
