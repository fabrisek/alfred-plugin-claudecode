/**
 * Claude Code as an Alfred agent-session provider ("CLI agent mode", plan §1,
 * §3, §4, §9 phase 1).
 *
 * One Alfred turn = one CLI process driven through the Agent SDK in streaming
 * input mode, resuming the conversation's persistent session (exact cwd).
 * Messages sent mid-turn go into the same input stream (the CLI folds them
 * into the running turn); the turn ends at the `result` after which no input
 * is still waiting for its replay echo. A seat that hits its limit is benched
 * and the same session continues on the next seat (shared session store,
 * accounts/sharedSessions.ts).
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentSessionCapabilities,
  Logger,
  McpServerDescriptor,
  SendSessionInputResult,
  SessionEvent,
  SessionInput,
  SessionTurnRequest,
  SessionUsage,
} from '@alfred/sdk';
import { THROTTLE_BACKOFF_MS, type Account, type AccountPool, type TokenSample } from '../accounts/pool.js';
import { buildChildEnv, type CliInfo } from '../accounts/cli.js';
import type { RateLimitInfo } from '../accounts/usage.js';
import { classifyFailure, loadQuery, splitModel } from '../ClaudeCodeProvider.js';
import { seatForResume, SESSION_ID_RE, type SessionIndex } from '../session/sessions.js';
import { ClaudeEventMapper, totalsOf, turnUsage, type SessionTotals } from './claudeEventMap.js';
import { AsyncQueue, TurnRegistry } from './turns.js';

/** Least → most permissive; what the conversation selector offers (plan §5.4). */
export const CLI_PERMISSION_MODES = ['plan', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
export type CliPermissionMode = (typeof CLI_PERMISSION_MODES)[number];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isCliPermissionMode(v: unknown): v is CliPermissionMode {
  return typeof v === 'string' && (CLI_PERMISSION_MODES as readonly string[]).includes(v);
}

/** Requested mode, or the default; never above the configured ceiling. */
export function clampPermissionMode(requested: unknown, def: CliPermissionMode, max: CliPermissionMode): CliPermissionMode {
  const want = isCliPermissionMode(requested) ? requested : def;
  const rank = (m: CliPermissionMode): number => CLI_PERMISSION_MODES.indexOf(m);
  return rank(want) > rank(max) ? max : want;
}

/** Adapter heartbeat while the CLI lives (contract: every ≤ 15 s). */
export const HEARTBEAT_MS = 15_000;
/** After the last `result`, how long the CLI gets to exit on stdin EOF before it is killed. */
const CLOSE_GRACE_MS = 5_000;
/** `interruptSessionTurn` must answer within the host's 10 s RPC budget. */
const INTERRUPT_BUDGET_MS = 7_000;
const STDERR_TAIL = 2_000;

/** Sent on the next seat when a limit cut a turn after it had produced output. */
export const CONTINUE_DIRECTIVE = '(Usage limit reached on the previous account; continue where you stopped.)';

export type ChatSessionConfig = {
  /** Default when the conversation has none (plan §5.4: bypassPermissions). */
  permissionMode: CliPermissionMode;
  /** Ceiling a conversation cannot exceed. */
  permissionModeMax: CliPermissionMode;
  /** On a limit mid-turn, continue the same session on another seat. */
  autoSwitchMidTurn: boolean;
  /** The CLI must emit its `init` within this, or the attempt is abandoned. */
  startTimeoutMs: number;
};

export const DEFAULT_CHAT_SESSION_CONFIG: ChatSessionConfig = {
  permissionMode: 'bypassPermissions',
  permissionModeMax: 'bypassPermissions',
  autoSwitchMidTurn: true,
  startTimeoutMs: 120_000,
};

export function sessionCapabilities(cfg: ChatSessionConfig, crossSeat: boolean): AgentSessionCapabilities {
  const max = CLI_PERMISSION_MODES.indexOf(cfg.permissionModeMax);
  return {
    midTurnInput: 'native',
    interrupt: true,
    images: true,
    subagents: true,
    todos: true,
    permissionModes: CLI_PERMISSION_MODES.slice(0, max + 1),
    defaultPermissionMode: clampPermissionMode(cfg.permissionMode, cfg.permissionMode, cfg.permissionModeMax),
    mcp: { http: true, stdio: true },
    resumeAcrossSeats: crossSeat,
    fork: false,
    effortLevels: EFFORT_LEVELS,
  };
}

/**
 * What Alfred appends to Claude Code's own system prompt: the agent persona,
 * and — when the Alfred MCP server is attached — where the user's real tasks
 * live, so the CLI does not mistake its private checklist for them.
 */
export function buildAppendPrompt(persona: string | undefined, mcpServers: McpServerDescriptor[]): string | undefined {
  const parts: string[] = [];
  if (persona?.trim()) parts.push(persona.trim());
  const alfred = mcpServers.find((s) => s.name === 'alfred');
  if (alfred) {
    parts.push(
      [
        '# Alfred',
        `You are running inside Alfred, the user's assistant. Its MCP server "${alfred.name}" (tools named mcp__${alfred.name}__*) gives you the user's real tasks, projects, memory, artifacts and other Alfred agents.`,
        '- When the user asks to create, update, complete or list tasks, or to file something in a project or in memory, do it with those tools: that is where the user sees and tracks work.',
        '- Your built-in task list (TaskCreate/TaskUpdate/TodoWrite) is only your private plan for the current request. It is never the user\'s task board, and items in it are not tasks the user asked for.',
        '- Delegate to Alfred agents through the Alfred tools when the user asks for another agent.',
      ].join('\n'),
    );
  }
  return parts.length ? parts.join('\n\n') : undefined;
}

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type Pending = { uuid: string; clientMessageId?: string; input: SessionInput };

/** SDK user message for one Alfred input (images first, then text + attached file paths). */
export function userMessage(p: Pending): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  for (const img of p.input.images ?? []) {
    const data = img.data.startsWith('data:') ? img.data.slice(img.data.indexOf(',') + 1) : img.data;
    if (data && IMAGE_MIME.has(img.mimeType)) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data } });
    } else if (img.path) {
      content.push({ type: 'text', text: `[Image attached at ${img.path}]` });
    }
  }
  let text = p.input.text ?? '';
  const files = p.input.files ?? [];
  if (files.length) {
    text += `${text ? '\n\n' : ''}Attached files:\n${files.map((f) => `- ${f.name} (${f.mimeType}): ${f.path}`).join('\n')}`;
  }
  content.push({ type: 'text', text: text || '(no text)' });
  return { type: 'user', session_id: '', parent_tool_use_id: null, uuid: p.uuid, message: { role: 'user', content } };
}

function addUsage(a: SessionUsage | undefined, b: SessionUsage | undefined): SessionUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number): number | undefined => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  const byModel = { ...(a.byModel ?? {}) };
  for (const [k, v] of Object.entries(b.byModel ?? {})) {
    const o = byModel[k];
    byModel[k] = {
      inputTokens: sum(o?.inputTokens, v.inputTokens),
      outputTokens: sum(o?.outputTokens, v.outputTokens),
      costUsd: sum(o?.costUsd, v.costUsd),
    };
  }
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    costUsd: sum(a.costUsd, b.costUsd),
    contextUsed: b.contextUsed ?? a.contextUsed,
    contextWindow: b.contextWindow ?? a.contextWindow,
    byModel: Object.keys(byModel).length ? byModel : undefined,
  };
}

type TurnEnd = Extract<SessionEvent, { type: 'turn_end' }>;

/** One live Alfred turn: the CLI of its current attempt and what is still owed an echo. */
class LiveTurn {
  input?: AsyncQueue<unknown>;
  query?: { interrupt(): Promise<unknown> };
  controller?: AbortController;
  /** Inputs pushed to the current attempt, not yet echoed by the CLI. */
  pending: Pending[] = [];
  /** Inputs accepted between two attempts (seat switch), sent with the next one. */
  carry: Pending[] = [];
  /** No more input is accepted (turn finished or stopping). */
  closed = false;
  interrupted = false;
  hardStopped = false;

  kill(_reason: string): void {
    this.hardStopped = true;
    this.closed = true;
    this.input?.close();
    this.controller?.abort();
  }
}

type AttemptResult =
  | { kind: 'end'; end: TurnEnd; usage?: SessionUsage }
  | {
      kind: 'seat';
      failure: { kind: 'limit' | 'throttle' | 'auth'; message: string; resetsAt: number | null };
      sawOutput: boolean;
      unechoed: Pending[];
      usage?: SessionUsage;
    };

export type ClaudeSessionAdapterOptions = {
  pool: AccountPool;
  cli: CliInfo;
  sessions: SessionIndex;
  logger: Logger;
  config: ChatSessionConfig;
  /** True when every seat shares one session store (resume on any seat). */
  crossSeat: () => boolean;
  onAccountUsed?: (accountId: string) => void;
  now?: () => number;
  /** Test seam; defaults to {@link HEARTBEAT_MS}. */
  heartbeatMs?: number;
};

export class ClaudeSessionAdapter {
  private readonly turns = new TurnRegistry<LiveTurn>();
  private readonly now: () => number;

  constructor(private readonly opts: ClaudeSessionAdapterOptions) {
    this.now = opts.now ?? Date.now;
  }

  get liveTurns(): number {
    return this.turns.size;
  }

  killAll(): void {
    this.turns.killAll('plugin deactivated');
  }

  async sendSessionInput(turnId: string, input: SessionInput): Promise<SendSessionInputResult> {
    const turn = this.turns.get(turnId);
    if (!turn) return { accepted: false, reason: 'no live turn with this id' };
    if (turn.closed || turn.interrupted) return { accepted: false, reason: 'the turn is ending; send it as the next turn' };
    const p: Pending = { uuid: randomUUID(), clientMessageId: input.clientMessageId, input };
    if (turn.input && !turn.input.closed) {
      turn.pending.push(p);
      turn.input.push(userMessage(p));
    } else {
      turn.carry.push(p);
    }
    return { accepted: true };
  }

  async interruptSessionTurn(turnId: string): Promise<void> {
    const turn = this.turns.get(turnId);
    if (!turn || turn.hardStopped) return;
    turn.interrupted = true;
    turn.closed = true;
    const q = turn.query;
    if (!q) {
      turn.kill('interrupted before the CLI started');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        q.interrupt(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('interrupt timed out')), INTERRUPT_BUDGET_MS);
        }),
      ]);
    } catch (err) {
      this.opts.logger.warn('graceful interrupt failed; killing the CLI', { turnId, err: (err as Error).message });
      turn.kill('interrupt failed');
    } finally {
      clearTimeout(timer);
    }
  }

  async *runSessionTurn(req: SessionTurnRequest): AsyncIterable<SessionEvent> {
    const channel = new AsyncQueue<SessionEvent>();
    const turn = new LiveTurn();
    this.turns.add(req.turnId, turn);
    const onAbort = (): void => turn.kill('hard stop');
    if (req.signal?.aborted) turn.kill('hard stop');
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const heartbeat = setInterval(() => channel.push({ type: 'heartbeat', at: this.now() }), this.opts.heartbeatMs ?? HEARTBEAT_MS);
    heartbeat.unref?.();
    let ended = false;
    const emit = (e: SessionEvent): void => {
      if (ended) return;
      if (e.type === 'turn_end') ended = true;
      channel.push(e);
    };
    const pump = this.pump(req, turn, emit)
      .catch((err: unknown) => {
        this.opts.logger.error('claude session turn crashed', { turnId: req.turnId, err: (err as Error)?.message });
        emit({ type: 'turn_end', stopReason: 'error', error: { kind: 'other', message: (err as Error)?.message ?? String(err) } });
      })
      .finally(() => {
        clearInterval(heartbeat);
        if (!ended) emit({ type: 'turn_end', stopReason: turn.interrupted ? 'interrupted' : 'error', error: turn.interrupted ? undefined : { kind: 'other', message: 'the turn ended without a result' } });
        channel.close();
      });
    try {
      for await (const e of channel) yield e;
    } finally {
      turn.closed = true;
      if (!ended) turn.kill('consumer stopped');
      clearInterval(heartbeat);
      req.signal?.removeEventListener('abort', onAbort);
      this.turns.delete(req.turnId, turn);
      await Promise.race([pump, new Promise((r) => setTimeout(r, 3_000))]);
    }
  }

  /** The whole turn, possibly over several seats. Emits exactly one turn_end (or none on a hard stop). */
  private async pump(req: SessionTurnRequest, turn: LiveTurn, emit: (e: SessionEvent) => void): Promise<void> {
    const { pool, sessions } = this.opts;
    const { model, pinned: pinnedFromModel } = splitModel(req.model);
    const pinned = req.pinnedSeatId ?? pinnedFromModel;
    // Exact cwd: the CLI finds a session only under the string it was created with.
    const cwd = req.resume?.cwd || req.cwd;
    let sessionId = req.resume?.sessionId && SESSION_ID_RE.test(req.resume.sessionId) ? req.resume.sessionId : undefined;
    const createdThisTurn = !sessionId;
    const newId = !sessionId && req.newSessionId && SESSION_ID_RE.test(req.newSessionId) ? req.newSessionId : undefined;
    const crossSeat = this.opts.crossSeat();

    let account: Account | undefined;
    if (sessionId) {
      const preferred = req.resume?.seatId ? pool.get(req.resume.seatId) : undefined;
      if (preferred && pool.unavailableReason(preferred, this.now()) === null) account = preferred;
      else {
        const seat = seatForResume(pool, sessions, sessionId, this.now(), { crossSeat, model });
        if (seat.account) account = seat.account;
        else if (seat.code === 'not_found') account = pool.pick({ model, pinned }).account;
        else {
          emit({
            type: 'turn_end',
            stopReason: seat.resetsAt ? 'limit' : 'error',
            error: { kind: seat.resetsAt ? 'limit' : 'other', message: seat.error, resetsAt: seat.resetsAt },
          });
          return;
        }
      }
    } else {
      account = pool.pick({ model, pinned }).account;
    }
    if (!account) {
      const why = pool.pick({ model, pinned });
      const resetsAt = earliestReset(pool, this.now());
      emit({
        type: 'turn_end',
        stopReason: 'limit',
        error: { kind: 'limit', message: why.reason ?? 'No Claude seat is available.', resetsAt },
      });
      return;
    }

    const mapper = new ClaudeEventMapper({
      requestedModel: model,
      cwd,
      resumed: !!sessionId,
      seat: { id: account.id, label: account.label },
      now: this.now,
    });
    let toSend: Pending[] = [{ uuid: randomUUID(), clientMessageId: req.input.clientMessageId, input: req.input }];
    const tried = new Set<string>();
    let usage: SessionUsage | undefined;

    for (;;) {
      tried.add(account.id);
      const r = await this.attempt({ req, turn, account, mapper, emit, model, cwd, sessionId, newId: sessionId ? undefined : newId, toSend });
      usage = addUsage(usage, r.usage);
      if (mapper.sessionId) sessionId = mapper.sessionId;
      if (r.kind === 'end') {
        if (usage) emit({ type: 'usage', scope: 'turn', usage });
        emit({ ...r.end, usage });
        return;
      }
      // Seat-level failure: limit / throttle / auth.
      const f = r.failure;
      const sessionPortable = crossSeat || (createdThisTurn && !r.sawOutput);
      const mayContinue = !turn.interrupted && !turn.hardStopped && (!r.sawOutput || this.opts.config.autoSwitchMidTurn) && sessionPortable;
      const next = mayContinue ? pool.pick({ model, exclude: tried }) : undefined;
      if (!next?.account) {
        const resetsAt = f.resetsAt ?? earliestReset(pool, this.now());
        if (usage) emit({ type: 'usage', scope: 'turn', usage });
        emit({
          type: 'turn_end',
          stopReason: f.kind === 'auth' ? 'error' : 'limit',
          usage,
          error: {
            kind: f.kind === 'auth' ? 'auth' : 'limit',
            message: `${f.message}${next?.reason ? ` — ${next.reason}` : ''}`,
            resetsAt: f.kind === 'auth' ? undefined : resetsAt,
          },
        });
        return;
      }
      emit({ type: 'seat_switch', from: account.id, to: next.account.id, reason: `${f.kind}: ${f.message}`.slice(0, 300) });
      this.opts.logger.warn('claude session switching seat', { turnId: req.turnId, from: account.id, to: next.account.id, kind: f.kind });
      if (!crossSeat && !r.sawOutput && createdThisTurn) {
        // The new session never produced anything and this seat cannot see
        // it: start it afresh on the next seat.
        sessionId = undefined;
      }
      account = next.account;
      mapper.setSeat({ id: account.id, label: account.label }, !!sessionId);
      toSend = [...r.unechoed, ...turn.carry.splice(0)];
      if (toSend.length === 0) {
        toSend = [{ uuid: randomUUID(), input: { clientMessageId: '', text: CONTINUE_DIRECTIVE } }];
      }
    }
  }

  private async attempt(a: {
    req: SessionTurnRequest;
    turn: LiveTurn;
    account: Account;
    mapper: ClaudeEventMapper;
    emit: (e: SessionEvent) => void;
    model: string;
    cwd: string;
    sessionId?: string;
    newId?: string;
    toSend: Pending[];
  }): Promise<AttemptResult> {
    const { req, turn, account, mapper, emit, model, cwd } = a;
    const { pool, cli, sessions, config, logger } = this.opts;
    const query = await loadQuery();
    const controller = new AbortController();
    turn.controller = controller;
    if (turn.hardStopped) controller.abort();
    const input = new AsyncQueue<unknown>();
    turn.input = input;
    turn.pending = [];
    for (const p of [...a.toSend, ...turn.carry.splice(0)]) {
      turn.pending.push(p);
      input.push(userMessage(p));
    }

    const mode = clampPermissionMode(req.permissionMode, config.permissionMode, config.permissionModeMax);
    let stderrTail = '';
    const env = buildChildEnv(pool, account);
    delete env.CLAUDECODE;
    // Alfred's delegation tools block for as long as the delegated work runs:
    // the CLI's MCP call budget follows the longest one the core asks for.
    const mcpBudget = Math.max(0, ...(req.mcpServers ?? []).map((s) => s.toolTimeoutMs ?? 0));
    env.MCP_TOOL_TIMEOUT = String(mcpBudget > 0 ? mcpBudget : 86_400_000);
    const options: Record<string, unknown> = {
      model,
      cwd,
      additionalDirectories: req.additionalDirectories ?? [],
      permissionMode: mode,
      // Claude Code's own prompt, project CLAUDE.md and settings — like a
      // session started by hand there — plus Alfred's persona. Not
      // snapshotted, so persona edits reach resumed sessions.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: buildAppendPrompt(req.persona, req.mcpServers ?? []), snapshot: false },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      forwardSubagentText: true,
      // Only the MCP servers Alfred passes: the user's own servers (from
      // their Claude settings) do not leak into an Alfred conversation.
      strictMcpConfig: true,
      env,
      abortController: controller,
      stderr: (d: string) => {
        stderrTail = (stderrTail + d).slice(-STDERR_TAIL);
      },
      extraArgs: { 'replay-user-messages': null },
    };
    if (mode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    else {
      // Headless: nothing can approve a prompt, so whatever the mode does not
      // allow on its own is refused with a reason the model can relay.
      options.canUseTool = async (toolName: string) => ({
        behavior: 'deny',
        message: `"${toolName}" needs approval, which this conversation's permission mode (${mode}) does not grant. Tell the user; they can raise the mode for this conversation.`,
      });
    }
    if (req.effort && EFFORT_LEVELS.includes(req.effort) && cli.native) options.effort = req.effort;
    const mcp = req.mcpServers ?? [];
    if (mcp.length) {
      options.mcpServers = Object.fromEntries(
        mcp.map((s) => [
          s.name,
          { type: 'http', url: s.url, headers: s.headers, ...(s.toolTimeoutMs ? { timeout: s.toolTimeoutMs } : {}) },
        ]),
      );
    }
    if (a.sessionId) options.resume = a.sessionId;
    else if (a.newId) options.sessionId = a.newId;
    if (cli.path) options.pathToClaudeCodeExecutable = cli.path;

    let stalled = false;
    const startTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, config.startTimeoutMs);
    startTimer.unref?.();
    let grace: ReturnType<typeof setTimeout> | undefined;

    const sessionKey = (): string | undefined => mapper.sessionId || a.sessionId;
    let totalsBefore: SessionTotals | undefined = a.sessionId ? sessions.get(a.sessionId)?.totals : undefined;
    let usage: SessionUsage | undefined;
    let tokens: TokenSample | undefined;
    let result: Record<string, unknown> | undefined;
    let completed = false;
    let sawOutput = false;
    let sdkError: string | undefined;
    let syntheticText = '';
    let rejectedUntil: number | null = null;
    let thrown: string | undefined;

    pool.begin(account.id);
    logger.info('claude session turn', { turnId: req.turnId, account: account.id, model, mode, resume: a.sessionId ?? null, cwd });
    try {
      const q = query({ prompt: input as never, options: options as never }) as AsyncIterable<unknown> & {
        interrupt(): Promise<unknown>;
      };
      turn.query = q;
      for await (const raw of q) {
        const m = raw as Record<string, unknown> & { type?: string; subtype?: string };
        if (m.type === 'system' && m.subtype === 'init') {
          clearTimeout(startTimer);
          const id = String(m.session_id ?? '');
          if (id) {
            sessions.record(id, { accountId: account.id, cwd, model }, this.now());
            if (!totalsBefore && a.sessionId === id) totalsBefore = sessions.get(id)?.totals;
          }
        } else if (m.type === 'rate_limit_event') {
          const info = m.rate_limit_info as RateLimitInfo | undefined;
          if (info) {
            const until = pool.applyRateLimit(account.id, info);
            if (until !== null) rejectedUntil = until;
          }
        } else if (m.type === 'assistant') {
          const msg = (m.message ?? {}) as { model?: string; content?: Array<Record<string, unknown>> };
          if (m.error || msg.model === '<synthetic>') {
            sdkError = (m.error as string | undefined) ?? sdkError;
            syntheticText += (msg.content ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
          } else sawOutput = true;
        } else if (m.type === 'user' && m.isReplay === true) {
          // The CLI took this input: acknowledge it to Alfred.
          const idx = turn.pending.findIndex((p) => p.uuid === m.uuid);
          const p = turn.pending.splice(idx >= 0 ? idx : 0, 1)[0];
          if (p?.clientMessageId) emit({ type: 'input_ack', clientMessageId: p.clientMessageId, delivery: 'now' });
        }
        for (const e of mapper.map(m)) emit(e);
        if (m.type === 'result') {
          result = m;
          const t = turnUsage(m, totalsBefore, mapper.contextUsed);
          usage = addUsage(usage, t);
          totalsBefore = totalsOf(m);
          const key = sessionKey();
          const entry = key ? sessions.get(key) : undefined;
          if (key && entry) sessions.record(key, { ...entry, totals: totalsBefore }, this.now());
          const u = (m.usage ?? {}) as Record<string, number>;
          tokens = {
            input: (tokens?.input ?? 0) + (u.input_tokens ?? 0),
            output: (tokens?.output ?? 0) + (u.output_tokens ?? 0),
            cacheRead: (tokens?.cacheRead ?? 0) + (u.cache_read_input_tokens ?? 0),
            cacheWrite: (tokens?.cacheWrite ?? 0) + (u.cache_creation_input_tokens ?? 0),
            costUsd: (tokens?.costUsd ?? 0) + (t.costUsd ?? 0),
          };
          const isError = m.is_error === true || (typeof m.subtype === 'string' && m.subtype !== 'success');
          if (turn.pending.length === 0 || isError || turn.interrupted) {
            // Nothing left to answer: close stdin so the CLI exits, and make
            // sure it does.
            completed = true;
            if (!isError && !turn.interrupted) turn.closed = true;
            input.close();
            grace = setTimeout(() => controller.abort(), CLOSE_GRACE_MS);
            grace.unref?.();
          }
        }
      }
    } catch (err) {
      // SDK 0.3 throws after an error `result` ("Claude Code returned an
      // error result: …"); the result itself was already seen.
      if (!controller.signal.aborted || !completed) thrown = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(startTimer);
      clearTimeout(grace);
      turn.query = undefined;
      turn.input = undefined;
      turn.controller = undefined;
    }

    const unechoed = turn.pending.splice(0);
    const resultText = typeof result?.result === 'string' ? result.result : undefined;
    let out: AttemptResult;
    let outcome: 'ok' | 'error' | 'switched' = 'ok';
    let detail: string | undefined;

    if (turn.hardStopped) {
      out = { kind: 'end', end: { type: 'turn_end', stopReason: 'interrupted', resultText }, usage };
      outcome = 'error';
      detail = 'stopped';
    } else if (turn.interrupted) {
      out = { kind: 'end', end: { type: 'turn_end', stopReason: 'interrupted', resultText }, usage };
      detail = 'interrupted';
    } else if (stalled) {
      detail = `the CLI did not start within ${Math.round(config.startTimeoutMs / 1000)}s on seat "${account.label}"${stderrTail ? `. stderr: ${stderrTail.trim().slice(-400)}` : ''}`;
      out = { kind: 'end', end: { type: 'turn_end', stopReason: 'error', error: { kind: 'cli', message: detail } }, usage };
      outcome = 'error';
    } else {
      const isError = !result || result.is_error === true || (typeof result.subtype === 'string' && result.subtype !== 'success');
      if (!isError && !sdkError) {
        out = { kind: 'end', end: { type: 'turn_end', stopReason: 'end_turn', resultText }, usage };
      } else if (result?.subtype === 'error_max_turns') {
        out = { kind: 'end', end: { type: 'turn_end', stopReason: 'max_turns', resultText }, usage };
      } else {
        const errors = Array.isArray(result?.errors) ? (result!.errors as string[]).join('; ') : '';
        const why: string =
          syntheticText.trim() ||
          errors ||
          (result?.is_error === true && resultText ? resultText : '') ||
          thrown ||
          (stderrTail ? `CLI exited without a result. stderr: ${stderrTail.trim().slice(-400)}` : 'the CLI exited without a result');
        detail = why;
        const c = classifyFailure(why, sdkError, rejectedUntil);
        if (c.kind === 'limit') {
          const until = c.resetsAt ?? pool.runtime(account.id).exhaustedUntil ?? this.now() + 30 * 60_000;
          pool.markExhausted(account.id, until, why.slice(0, 200));
          out = { kind: 'seat', failure: { kind: 'limit', message: why, resetsAt: until }, sawOutput, unechoed, usage };
          outcome = 'switched';
        } else if (c.kind === 'throttle') {
          pool.backoff(account.id, THROTTLE_BACKOFF_MS, `throttled: ${why.slice(0, 180)}`);
          out = { kind: 'seat', failure: { kind: 'throttle', message: why, resetsAt: null }, sawOutput, unechoed, usage };
          outcome = 'switched';
        } else if (c.kind === 'auth') {
          pool.markAuthFailed(account.id, why.slice(0, 200));
          out = { kind: 'seat', failure: { kind: 'auth', message: why, resetsAt: null }, sawOutput, unechoed, usage };
          outcome = 'switched';
        } else {
          out = { kind: 'end', end: { type: 'turn_end', stopReason: 'error', resultText, error: { kind: 'cli', message: why } }, usage };
          outcome = 'error';
        }
      }
    }

    pool.end(account.id, {
      model,
      servedModel: mapper.servedModel,
      kind: 'session',
      agent: req.agentId,
      tokens,
      outcome,
      detail: (detail ?? `chat turn${mapper.sessionId ? ` · ${mapper.sessionId.slice(0, 8)}` : ''}`).slice(0, 300),
    });
    this.opts.onAccountUsed?.(account.id);
    return out;
  }
}

/** Earliest moment a benched seat comes back, for the core's auto-resume. */
function earliestReset(pool: AccountPool, now: number): number | undefined {
  let best: number | undefined;
  for (const a of pool.list()) {
    if (!a.enabled) continue;
    const until = pool.runtime(a.id).exhaustedUntil;
    if (until && until > now && (best === undefined || until < best)) best = until;
  }
  return best;
}
