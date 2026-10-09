/**
 * Full Claude Code agent sessions on a pool seat.
 *
 * Unlike the provider (pure completion, every tool denied), a session runs the
 * CLI as a real coding agent in a project directory, with its own Read / Edit
 * / Bash / ... tools, and reports back what it did.
 *
 * Every run owns its CLI process, its AbortController and its {@link RunState};
 * the only things shared between runs are the pool (whose per-request API is
 * already concurrency-safe) and the session index.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '@alfred/sdk';
import { THROTTLE_BACKOFF_MS, type Account, type AccountPool, type TokenSample } from '../accounts/pool.js';
import { buildChildEnv, type CliInfo } from '../accounts/cli.js';
import { isAdvisorRefusal, type AdvisorPolicy } from '../accounts/advisor.js';
import type { RateLimitInfo } from '../accounts/usage.js';
import { classifyFailure, loadQuery } from '../ClaudeCodeProvider.js';
import type { CliProcessTracker } from '../agentSession/processTracker.js';
import { ChangeTracker, describeCall, type RunReport, type RunStatus } from './summary.js';
import { seatForResume, sessionCwd, type SessionIndex } from './sessions.js';

export type SessionPermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions';

/** Least to most permissive. A call may ask for less than the configured mode, never more. */
export const PERMISSION_RANK: Record<SessionPermissionMode, number> = {
  plan: 0,
  acceptEdits: 1,
  bypassPermissions: 2,
};

export function isPermissionMode(v: unknown): v is SessionPermissionMode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PERMISSION_RANK, v);
}

/** Built-in tools a session may use without asking, for normal development work. */
export const DEFAULT_SESSION_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'Bash',
  'BashOutput',
  'KillBash',
  'KillShell',
  'TodoWrite',
  'Task',
  'WebFetch',
  'WebSearch',
];

export type SessionConfig = {
  permissionMode: SessionPermissionMode;
  allowedTools: string[];
  /** Model when the call names none. */
  model: string;
  /** Wall-clock budget of one run. */
  timeoutMs: number;
  maxTurns: number;
  /** The CLI must start (emit its `init`) within this, or the attempt is abandoned. */
  startTimeoutMs: number;
};

export type RunRequest = {
  cwd: string;
  prompt: string;
  model: string;
  effort?: string;
  permissionMode: SessionPermissionMode;
  sessionId?: string;
  maxTurns: number;
  /** Alfred agent that delegated the run, for the dashboard. */
  agent?: string;
};

export type Progress = { chunk?: string; phase?: string; data?: Record<string, unknown> };

export type RunState = {
  id: string;
  request: RunRequest;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  account?: Account;
  sessionId?: string;
  turns: number;
  tracker: ChangeTracker;
  lastText: string;
  report?: RunReport;
  done: Promise<RunReport>;
  /** Set by a blocking caller; background runs are read through {@link SessionRunner.get}. */
  onProgress?: (p: Progress) => void;
};

type Internal = RunState & {
  cancelled: boolean;
  timedOut: boolean;
  abortAttempt?: () => void;
  switchedFrom: string[];
};

export type StartResult =
  | { run: RunState; error?: undefined }
  | { run?: undefined; code: string; error: string; resetsAt?: number };

type AttemptOutcome = {
  status: RunStatus;
  resultText: string;
  error?: string;
  resetsAt?: number | null;
  tokens?: TokenSample;
  denials: string[];
  /** Seat-level failure (limit / auth) before the session produced anything: try another seat. */
  switchable: boolean;
  /** The API refused the advisor before any output: run again on the same seat without it. */
  advisorRefused?: boolean;
};

const KEEP_FINISHED_MS = 2 * 3_600_000;
const KEEP_FINISHED_MAX = 30;
const STDERR_TAIL = 2_000;

type Msg = Record<string, unknown> & { type?: string; subtype?: string };

async function* oneUserMessage(text: string): AsyncIterable<unknown> {
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function textBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && (b as { type?: string }).type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join('');
}

export type SessionRunnerOptions = {
  pool: AccountPool;
  cli: CliInfo;
  sessions: SessionIndex;
  config: SessionConfig;
  logger: Logger;
  onAccountUsed?: (accountId: string) => void;
  now?: () => number;
  /** Records every CLI process, so a crashed gateway's orphans are killed on the next start. */
  tracker?: CliProcessTracker;
  /** Server-side advisor on every CLI started (accounts/advisor.ts). */
  advisor?: AdvisorPolicy;
};

export class SessionRunner {
  private readonly runs = new Map<string, Internal>();
  private readonly now: () => number;

  constructor(private readonly opts: SessionRunnerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get config(): SessionConfig {
    return this.opts.config;
  }

  /**
   * Validate, pick the first seat, and start the run in the background.
   * Pre-flight failures (unknown session, owner seat exhausted, no seat at
   * all) come back synchronously so the tool can answer at once.
   */
  start(request: RunRequest): StartResult {
    const pool = this.opts.pool;
    let first: Account;
    if (request.sessionId) {
      const seat = seatForResume(pool, this.opts.sessions, request.sessionId, this.now());
      if (!seat.account) return { code: seat.code, error: seat.error, resetsAt: seat.resetsAt };
      first = seat.account;
      // The CLI finds a session only under the exact cwd it was created in
      // (drive-letter case included): a resume runs there, whatever the
      // caller resolved its cwd/project to.
      const recorded = sessionCwd(pool, this.opts.sessions, request.sessionId);
      if (recorded && recorded !== request.cwd) {
        this.opts.logger.info('session resume uses its recorded cwd', { sessionId: request.sessionId, requested: request.cwd, recorded });
        request = { ...request, cwd: recorded };
      }
    } else {
      const pick = pool.pick({ model: request.model });
      if (!pick.account) return { code: 'unavailable', error: pick.reason };
      first = pick.account;
    }
    this.prune();
    const run = {
      id: randomUUID().slice(0, 8),
      request,
      status: 'running',
      startedAt: this.now(),
      turns: 0,
      tracker: new ChangeTracker(request.cwd),
      lastText: '',
      cancelled: false,
      timedOut: false,
      switchedFrom: [],
    } as unknown as Internal;
    run.done = this.execute(run, first);
    this.runs.set(run.id, run);
    return { run };
  }

  /** Exact cwd an existing session was created in (index, then transcript). */
  recordedCwd(sessionId: string): string | undefined {
    return sessionCwd(this.opts.pool, this.opts.sessions, sessionId);
  }

  get(id: string): RunState | undefined {
    return this.runs.get(id);
  }

  list(): RunState[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.status !== 'running') return false;
    run.cancelled = true;
    run.abortAttempt?.();
    return true;
  }

  cancelAll(): void {
    for (const id of this.runs.keys()) this.cancel(id);
  }

  /** Report of a run, finished or not. */
  reportOf(run: RunState): RunReport {
    if (run.report) return run.report;
    return {
      status: run.status,
      seat: { id: run.account?.id ?? '', label: run.account?.label ?? '(picking)' },
      model: run.request.model,
      cwd: run.request.cwd,
      sessionId: run.sessionId,
      resumed: !!run.request.sessionId,
      turns: run.turns,
      durationMs: this.now() - run.startedAt,
      resultText: run.lastText,
      files: run.tracker.filesChanged,
      commands: run.tracker.commandsRun,
      denials: [],
      switchedFrom: (run as Internal).switchedFrom,
    };
  }

  private prune(): void {
    const now = this.now();
    const finished = [...this.runs.values()]
      .filter((r) => r.status !== 'running')
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    finished.forEach((r, i) => {
      if (i >= KEEP_FINISHED_MAX || now - (r.endedAt ?? now) > KEEP_FINISHED_MS) this.runs.delete(r.id);
    });
  }

  private emit(run: Internal, p: Progress): void {
    try {
      run.onProgress?.(p);
    } catch {
      // A torn-down progress stub must never break the run.
    }
  }

  private async execute(run: Internal, first: Account): Promise<RunReport> {
    const { pool, logger } = this.opts;
    // `timeoutMs: 0` = no wall clock.
    const wall =
      this.opts.config.timeoutMs > 0
        ? setTimeout(() => {
            run.timedOut = true;
            run.abortAttempt?.();
          }, this.opts.config.timeoutMs)
        : undefined;
    wall?.unref?.();

    const tried = new Set<string>();
    let account: Account | undefined = first;
    let outcome: AttemptOutcome | undefined;
    try {
      while (account) {
        tried.add(account.id);
        run.account = account;
        outcome = await this.attempt(run, account);
        if (outcome.advisorRefused && !run.cancelled && !run.timedOut) {
          // Same seat, without the advisor (settingsFor omits it from now on).
          this.opts.advisor?.markIncompatible(account.id, outcome.error ?? 'advisor refused');
          outcome = await this.attempt(run, account);
        }
        if (!outcome.switchable || run.request.sessionId || run.cancelled || run.timedOut) break;
        run.switchedFrom.push(`${account.label}: ${outcome.error ?? 'failed'}`);
        logger.warn('session switching Claude account', { run: run.id, from: account.id });
        const next = pool.pick({ model: run.request.model, exclude: tried });
        if (!next.account) {
          outcome = { ...outcome, error: `${outcome.error ?? 'failed'}. ${next.reason}` };
          break;
        }
        this.emit(run, { chunk: `[seat "${account.label}" unavailable, switching to "${next.account.label}"]\n` });
        account = next.account;
      }
    } catch (err) {
      outcome = {
        status: 'error',
        resultText: run.lastText,
        error: err instanceof Error ? err.message : String(err),
        denials: [],
        switchable: false,
      };
    } finally {
      clearTimeout(wall);
    }

    const o = outcome!;
    run.status = o.status;
    run.endedAt = this.now();
    run.report = {
      status: o.status,
      seat: { id: run.account?.id ?? '', label: run.account?.label ?? '' },
      model: run.request.model,
      cwd: run.request.cwd,
      sessionId: run.sessionId,
      resumed: !!run.request.sessionId,
      turns: run.turns,
      durationMs: run.endedAt - run.startedAt,
      resultText: o.resultText,
      error: o.error,
      resetsAt: o.resetsAt,
      tokens: o.tokens,
      files: run.tracker.filesChanged,
      commands: run.tracker.commandsRun,
      denials: o.denials,
      switchedFrom: run.switchedFrom.length ? run.switchedFrom : undefined,
    };
    logger.info('session finished', {
      run: run.id,
      status: o.status,
      account: run.account?.id,
      turns: run.turns,
      files: run.report.files.length,
    });
    return run.report;
  }

  /** One CLI process for `run` on `account`. Never throws for seat or session failures. */
  private async attempt(run: Internal, account: Account): Promise<AttemptOutcome> {
    const { pool, cli, config, sessions } = this.opts;
    const req = run.request;
    const query = await loadQuery();
    const controller = new AbortController();
    let stalled = false;
    run.abortAttempt = () => controller.abort();
    if (run.cancelled || run.timedOut) controller.abort();
    const startTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, config.startTimeoutMs);
    startTimer.unref?.();

    let stderrTail = '';
    const options: Record<string, unknown> = {
      model: req.model,
      cwd: req.cwd,
      // `0` = no turn cap: omit the option entirely.
      ...(req.maxTurns > 0 ? { maxTurns: req.maxTurns } : {}),
      permissionMode: req.permissionMode,
      allowedTools: config.allowedTools,
      // Anything not pre-approved is refused instead of prompting: a prompt
      // would hang a headless CLI forever.
      canUseTool: async (toolName: string) => ({
        behavior: 'deny',
        message: `Tool "${toolName}" is not enabled for Alfred-delegated sessions.`,
      }),
      // The real Claude Code agent: its own system prompt, and the project's
      // CLAUDE.md / settings, like a session started by hand in that directory.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      env: buildChildEnv(pool, account),
      abortController: controller,
      stderr: (data: string) => {
        stderrTail = (stderrTail + data).slice(-STDERR_TAIL);
      },
    };
    if (req.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
    if (req.sessionId) options.resume = req.sessionId;
    if (cli.path) options.pathToClaudeCodeExecutable = cli.path;
    if (cli.native && req.effort) options.extraArgs = { effort: req.effort };
    // The server-side advisor, unless off or refused by the API on this seat.
    const advisorSettings = this.opts.advisor?.settingsFor(account.id);
    if (advisorSettings) options.settings = advisorSettings;
    if (this.opts.tracker) {
      // Own spawn: the SDK then forwards no stderr, so the tracker does.
      options.spawnClaudeCodeProcess = this.opts.tracker.spawner((data) => {
        stderrTail = (stderrTail + data).slice(-STDERR_TAIL);
      });
    }

    let tokens: TokenSample | undefined;
    let rejectedUntil: number | null = null;
    let sdkError: string | undefined;
    let apiError: unknown;
    let syntheticText = '';
    let sawOutput = false;
    let result: Msg | undefined;
    let thrown: string | undefined;

    pool.begin(account.id);
    this.emit(run, { phase: `starting on ${account.label}`, data: this.progressData(run) });
    try {
      const q = query({ prompt: oneUserMessage(req.prompt) as never, options: options as never });
      this.opts.advisor?.observe(account.id, q, advisorSettings);
      for await (const raw of q as AsyncIterable<unknown>) {
        const m = raw as Msg;
        if (m.type === 'system' && m.subtype === 'init') {
          clearTimeout(startTimer);
          if (typeof m.session_id === 'string' && m.session_id) {
            run.sessionId = m.session_id;
            sessions.record(m.session_id, { accountId: account.id, cwd: req.cwd, model: req.model }, this.now());
          }
        } else if (m.type === 'rate_limit_event') {
          const info = m.rate_limit_info as RateLimitInfo | undefined;
          if (info) {
            const until = pool.applyRateLimit(account.id, info);
            if (until !== null) rejectedUntil = until;
          }
        } else if (m.type === 'assistant') {
          const msg = (m.message ?? {}) as { content?: unknown; model?: string };
          if (m.error || msg.model === '<synthetic>') {
            sdkError = (m.error as string | undefined) ?? sdkError;
            apiError = m.api_error ?? apiError;
            syntheticText += textBlocks(msg.content);
            continue;
          }
          sawOutput = true;
          run.tracker.observe(m);
          if (m.parent_tool_use_id == null) run.turns += 1;
          const text = textBlocks(msg.content).trim();
          if (text && m.parent_tool_use_id == null) {
            run.lastText = text;
            this.emit(run, { chunk: `${text}\n` });
          }
          for (const b of Array.isArray(msg.content) ? (msg.content as Msg[]) : []) {
            if (b.type === 'tool_use') {
              const line = describeCall(String(b.name ?? ''), (b.input ?? {}) as Record<string, unknown>, req.cwd);
              this.emit(run, { chunk: `> ${line}\n` });
            }
          }
          this.emit(run, { phase: `turn ${run.turns}${run.tracker.lastTool ? ` · ${run.tracker.lastTool}` : ''}`, data: this.progressData(run) });
        } else if (m.type === 'user') {
          run.tracker.observe(m);
        } else if (m.type === 'result') {
          result = m;
          const u = m.usage as Record<string, number> | undefined;
          if (u) {
            tokens = {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0,
              costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : 0,
            };
          }
          if (typeof m.num_turns === 'number') run.turns = m.num_turns;
          if (typeof m.session_id === 'string' && m.session_id) run.sessionId = m.session_id;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) thrown = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(startTimer);
      run.abortAttempt = undefined;
    }

    const denials = Array.isArray(result?.permission_denials)
      ? (result!.permission_denials as Array<{ tool_name?: string; tool_input?: Record<string, unknown> }>).map((d) =>
          describeCall(String(d.tool_name ?? '?'), d.tool_input ?? {}, req.cwd),
        )
      : [];
    const finalText = typeof result?.result === 'string' && result.result.trim() ? result.result : run.lastText;

    let outcome: AttemptOutcome;
    if (controller.signal.aborted) {
      const status: RunStatus = run.cancelled ? 'cancelled' : run.timedOut ? 'timeout' : 'error';
      const error = run.cancelled
        ? 'cancelled'
        : run.timedOut
          ? `stopped after ${Math.round(config.timeoutMs / 60_000)} min (session timeout setting)`
          : `the CLI did not start within ${Math.round(config.startTimeoutMs / 1000)}s on seat "${account.label}" — check the claude CLI and that seat's login${stderrTail ? `. stderr: ${stderrTail.trim().slice(-400)}` : ''}`;
      outcome = { status, resultText: run.lastText, error, tokens, denials, switchable: false };
    } else {
      const subtype = result?.subtype;
      const errored = !result || result.is_error === true || (subtype !== undefined && subtype !== 'success');
      if (!errored && !sdkError && !thrown) {
        outcome = { status: 'done', resultText: finalText, tokens, denials, switchable: false };
      } else {
        let detail =
          syntheticText.trim() ||
          thrown ||
          (Array.isArray(result?.errors) && (result!.errors as string[]).join('; ')) ||
          (typeof result?.result === 'string' && result.is_error ? result.result : '') ||
          (subtype === 'error_max_turns' ? `reached maxTurns (${req.maxTurns})` : subtype) ||
          'the CLI exited without a result';
        if (!result && stderrTail && !syntheticText) detail += `. stderr: ${stderrTail.trim().slice(-400)}`;
        const c = classifyFailure(detail, sdkError, rejectedUntil);
        let resetsAt: number | null = null;
        if (c.kind === 'limit') {
          resetsAt = c.resetsAt ?? pool.runtime(account.id).exhaustedUntil ?? this.now() + 30 * 60_000;
          pool.markExhausted(account.id, resetsAt, detail.slice(0, 200));
        } else if (c.kind === 'throttle') {
          pool.backoff(account.id, THROTTLE_BACKOFF_MS, `throttled: ${detail.slice(0, 180)}`);
        } else if (c.kind === 'auth') {
          pool.markAuthFailed(account.id, detail.slice(0, 200));
        }
        const seatLevel = c.kind === 'limit' || c.kind === 'throttle' || c.kind === 'auth';
        outcome = {
          status: 'error',
          resultText: finalText,
          error: detail,
          resetsAt,
          tokens,
          denials,
          switchable: seatLevel && !sawOutput,
          advisorRefused: !!advisorSettings && !sawOutput && isAdvisorRefusal(detail, apiError),
        };
      }
    }

    const files = run.tracker.filesChanged.length;
    pool.end(account.id, {
      model: req.model,
      kind: 'session',
      agent: req.agent,
      tokens,
      outcome: outcome.status === 'done' ? 'ok' : outcome.switchable ? 'switched' : 'error',
      detail:
        outcome.status === 'done'
          ? `${run.turns} turn${run.turns === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} changed`
          : `${outcome.status}: ${outcome.error ?? ''}`.slice(0, 300),
    });
    this.opts.onAccountUsed?.(account.id);
    return outcome;
  }

  private progressData(run: RunState): Record<string, unknown> {
    return {
      runId: run.id,
      seat: run.account?.label,
      sessionId: run.sessionId,
      turns: run.turns,
      filesChanged: run.tracker.filesChanged.map((f) => f.path),
      lastTool: run.tracker.lastTool,
    };
  }
}
