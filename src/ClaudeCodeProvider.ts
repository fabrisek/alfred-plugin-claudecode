import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  Logger,
  Message,
  ModelDetails,
  ModelInfo,
} from '@alfred/sdk';
// Not an OpenAI-compatible backend — the transport here is a child process, not
// HTTP — but the request-lifetime and no-op-logger halves of the package are
// transport-agnostic, so there is no reason to keep a second copy of them.
import { Deadline, isAbortLike, noopLogger } from '@alfred/provider-openai-compat';
import { THROTTLE_BACKOFF_MS, type Account, type AccountPool, type TokenSample } from './accounts/pool.js';
import { buildChildEnv, type CliInfo } from './accounts/cli.js';
import type { RateLimitInfo } from './accounts/usage.js';
import type { CliProcessTracker } from './agentSession/processTracker.js';
import { engineThread, isAdvisorRefusal, type AdvisorPolicy } from './accounts/advisor.js';
import { ToolCallCutter } from './toolCallCutter.js';
import { markerNotes } from './hostCutNote.js';
import { coerceNativeArgs } from './nativeArgs.js';
import { contextWindowOf, modelDetailsOf } from './modelContext.js';
import {
  ASSISTANT_SLOT,
  CACHE_TTL_1H,
  cacheTtlOf,
  EngineSessions,
  LiveSession,
  messageFingerprint,
  planSession,
  PushQueue,
  splitVolatileContext,
  type EngineSessionRecord,
  type LiveQuery,
} from './engineSessions.js';

/** Backend label prefixed to every error this provider surfaces. */
const LABEL = 'Claude Code';

/** A seat whose CLI said nothing within the request timeout sits out this long. */
const SILENT_SEAT_BACKOFF_MS = 5 * 60_000;

/**
 * Waits before retrying a conversation's request on its own seat after a
 * transient failure (bare 429, overload), before moving it: a move re-writes
 * the whole conversation into the other account's prompt cache.
 */
export const IN_PLACE_RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
/** A silent CLI (nothing within the request timeout) is retried this many times on its seat. */
const SILENT_IN_PLACE_RETRIES = 1;
/** Longest a conversation waits for its own seat to come back from a throttle instead of moving. */
const MAX_STICKY_WAIT_MS = 90_000;
/**
 * Seats on which a request may stay silent (nothing within its budget) before
 * it fails: a conversation that is silent on two seats is not a seat problem,
 * and rotating it further re-writes it on every seat it lands on (seen: 9
 * seats in a row, one every two minutes).
 */
const MAX_SILENT_SEATS = 2;
/** Above this prompt size a newly started process gets no advisor (it re-reads the whole context uncached). */
export const DEFAULT_ADVISOR_MAX_CONTEXT_TOKENS = 150_000;
/** Characters per token for the prompt size estimate when no measured size is known. */
const CHARS_PER_TOKEN = 3.5;

/** Effort sent when the conversation has no thinking mode of its own. */
export const DEFAULT_EFFORT = 'high';

/** Separator between a model id and a pinned account id: `opus@seat-3`. */
export const ACCOUNT_SEPARATOR = '@';

export type ClaudeCodeConfig = {
  /** Legacy single setup-token; now only used by the imported default account. */
  oauthToken: string;
  /** Raw `models` config string (comma-separated, optional `id|Display Name`). */
  modelsRaw: string;
  /** Context window reported for every exposed model. */
  contextWindow: number;
  /**
   * Prompt size at which the host should compact a conversation (see
   * modelContext.ts). Undefined = the default; 0 = no budget, only the window.
   */
  compactAtTokens?: number;
  /** Optional absolute path to the `claude` binary. Empty = auto-detect. */
  pathToClaude: string;
  /**
   * Time-to-first-chunk budget for one attempt, in ms.
   *
   * The SDK's `query()` has no timeout of its own: a CLI that blocks — a
   * missing binary, an interactive login prompt it cannot show, a wedged child
   * process — never yields and never rejects, and the generator hangs forever
   * on the single worker that serves every plugin. Disarmed on the first chunk
   * that carries real output, so a long answer is never cut short.
   */
  requestTimeoutMs: number;
  /** Requests the host may run on this provider at once (sub-agent fan-out). */
  maxConcurrentRequests: number;
  /** Sub-agents one `delegate_parallel` call may fan out to. */
  maxParallelTasks: number;
  /**
   * A process started for a prompt above this many tokens runs without the
   * advisor (it re-reads the whole context, uncached, on every consult).
   * Default {@link DEFAULT_ADVISOR_MAX_CONTEXT_TOKENS}; 0 = no limit.
   */
  advisorMaxContextTokens?: number;
};

export type ClaudeCodeProviderOptions = {
  config: ClaudeCodeConfig;
  pool: AccountPool;
  cli: CliInfo;
  logger?: Logger;
  /** Called after each attempt on a seat, so the host side can refresh its usage. */
  onAccountUsed?: (accountId: string) => void;
  /**
   * Where persistent engine sessions keep their records (one Claude Code
   * session per conversation, see engineSessions.ts). Unset = every request
   * runs in its own one-shot process.
   */
  sessionsDir?: string;
  /** Records every CLI process, so a crashed gateway's orphans are killed on the next start. */
  tracker?: CliProcessTracker;
  /**
   * Every seat shares one session store (accounts/sharedSessions.ts): a
   * conversation whose seat is out continues the same session on the next
   * one (`--resume`), sending only what is new.
   */
  crossSeat?: () => boolean;
  /** Server-side advisor on every CLI started (accounts/advisor.ts). */
  advisor?: AdvisorPolicy;
};

// ---------------------------------------------------------------------------
// Minimal structural typing for @anthropic-ai/claude-agent-sdk. We import it
// lazily (and keep it bundler-external) so the package's own cli.js resolution
// via __dirname keeps working — esbuild must NOT inline it. These shapes cover
// only the fields we read; the SDK surface is much larger.
// ---------------------------------------------------------------------------

type SdkTextDelta = { type: 'text_delta'; text: string };
type SdkThinkingDelta = { type: 'thinking_delta'; thinking: string };
type SdkContentDelta = SdkTextDelta | SdkThinkingDelta | { type: string };

type SdkStreamEvent =
  | { type: 'content_block_delta'; delta: SdkContentDelta }
  | { type: 'message_delta'; delta?: { stop_reason?: string | null }; usage?: SdkUsage }
  | { type: string };

type SdkUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type SdkContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: string };

type SdkMessage =
  | { type: 'stream_event'; event: SdkStreamEvent }
  | {
      type: 'assistant';
      /** Set by the CLI on synthetic error turns (`rate_limit`, `authentication_failed`, ...). */
      error?: string;
      message: { content: SdkContentBlock[]; stop_reason?: string | null; model?: string };
    }
  | {
      type: 'result';
      subtype?: string;
      result?: string;
      errors?: string[];
      is_error?: boolean;
      usage?: SdkUsage;
      total_cost_usd?: number;
    }
  | { type: 'rate_limit_event'; rate_limit_info: RateLimitInfo }
  | { type: string };

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: unknown,
) => Promise<{ behavior: 'deny'; message: string }>;

type SdkImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};
type SdkInputBlock = { type: 'text'; text: string } | SdkImageBlock;

type SdkUserMessage = {
  type: 'user';
  session_id: string;
  parent_tool_use_id: null;
  message: { role: 'user'; content: SdkInputBlock[] };
};

type QueryOptions = {
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  includePartialMessages?: boolean;
  permissionMode?: string;
  settingSources?: string[];
  cwd?: string;
  env?: Record<string, string>;
  abortController?: AbortController;
  pathToClaudeCodeExecutable?: string;
  canUseTool?: CanUseTool;
  extraArgs?: Record<string, string | null>;
  /** Flag settings (`--settings`): the advisor model. */
  settings?: { advisorModel?: string };
  /** Continue this Claude Code session (`--resume`). */
  resume?: string;
  /** With `resume`: drop the transcript entries after this one. */
  resumeSessionAt?: string;
  /** Our own spawn (pid file for orphan reaping), see agentSession/processTracker.ts. */
  spawnClaudeCodeProcess?: ReturnType<CliProcessTracker['spawner']>;
};

// Every built-in Claude Code tool, listed so `disallowedTools` strips them from
// the model's context entirely. We do NOT want this provider to touch the
// filesystem or run commands — Claude must only emit text. The empty-allowlist
// path is unreliable (claude-agent-sdk issue #115), so we deny by name AND back
// it with a `canUseTool` deny-all callback below.
const BUILTIN_TOOLS = [
  'Bash',
  'BashOutput',
  'KillBash',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'ExitPlanMode',
  'EnterPlanMode',
  'AskUserQuestion',
  'TaskOutput',
  'LSP',
  'PowerShell',
  'Skill',
  'ToolSearch',
  'Monitor',
  'Workflow',
  'SendMessage',
  'ListAgents',
  'ScheduleWakeup',
  'PushNotification',
  'RemoteTrigger',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterWorktree',
  'ExitWorktree',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
];

const denyAllTools: CanUseTool = async (toolName) => ({
  behavior: 'deny',
  message: `Tool "${toolName}" is disabled — this provider runs in text-only completion mode.`,
});

export type QueryFn = (args: {
  prompt: string | AsyncIterable<SdkUserMessage>;
  options?: QueryOptions;
}) => AsyncIterable<SdkMessage>;

let cachedQuery: QueryFn | null = null;

export async function loadQuery(): Promise<QueryFn> {
  if (cachedQuery) return cachedQuery;
  const mod = (await import('@anthropic-ai/claude-agent-sdk')) as { query: QueryFn };
  cachedQuery = mod.query;
  return cachedQuery;
}

/** Test seam: replace the SDK's `query`. */
export function __setQueryForTests(fn: QueryFn | null): void {
  cachedQuery = fn;
}

// ---------------------------------------------------------------------------
// Account failures
// ---------------------------------------------------------------------------

/**
 * `limit` = the seat's quota is spent (a rejected rate-limit window, a reset
 * time, or the CLI's "usage limit" wording): bench it until the reset.
 * `throttle` = a bare 429 / "too many requests" with none of that: a few
 * seconds' backoff, then any seat (this one included) may serve again.
 */
export type FailureKind = 'limit' | 'throttle' | 'auth' | 'other';

/** A failed attempt on one seat, classified so the pool knows whether to move on. */
export class AccountFailure extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly account: Account,
    readonly resetsAt: number | null,
    /** The CLI said nothing within the request timeout (a `throttle` of its own kind). */
    readonly silent = false,
  ) {
    super(message);
    this.name = 'AccountFailure';
  }
  get switchable(): boolean {
    return this.kind === 'limit' || this.kind === 'throttle' || this.kind === 'auth';
  }
}

/** Quota wording: the seat itself is out until a reset. */
const QUOTA_RE = /usage limit|hit your (?:\w+ )?limit|limit reached|out of (?:usage|credits)/i;
/** Transient throttling: retry shortly, possibly elsewhere. */
const THROTTLE_RE = /rate[_ -]?limit|too many requests|\b429\b|overloaded|\b529\b/i;
const AUTH_RE =
  /not logged in|please run \/login|invalid (?:api key|bearer token|x-api-key)|oauth token (?:has )?(?:expired|been revoked|revoked)|authentication[_ ](?:failed|error)|\b401\b|unauthori[sz]ed/i;

/** Pull a reset time out of a CLI limit message (`...|1791484800` or a bare epoch). */
function parseResetFromText(text: string): number | null {
  const m = /\|(\d{10})\b/.exec(text) ?? /\bresets?(?: at)?\D{0,4}(\d{10})\b/i.exec(text);
  return m ? Number(m[1]) * 1000 : null;
}

export function classifyFailure(
  detail: string,
  sdkError: string | undefined,
  rejectedUntil: number | null,
): { kind: FailureKind; resetsAt: number | null } {
  const textReset = parseResetFromText(detail);
  if (rejectedUntil !== null || sdkError === 'billing_error' || QUOTA_RE.test(detail) || (sdkError === 'rate_limit' && textReset !== null)) {
    return { kind: 'limit', resetsAt: rejectedUntil ?? textReset };
  }
  if (sdkError === 'authentication_failed') return { kind: 'auth', resetsAt: null };
  if (sdkError === 'rate_limit' || sdkError === 'overloaded' || THROTTLE_RE.test(detail)) {
    return { kind: 'throttle', resetsAt: null };
  }
  if (sdkError === 'authentication_failed' || AUTH_RE.test(detail)) return { kind: 'auth', resetsAt: null };
  return { kind: 'other', resetsAt: null };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ClaudeCodeProvider implements LLMProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude (subscription)';
  readonly kind = 'remote' as const;
  // tools:false on purpose — Claude Code in headless completion mode does not
  // round-trip Alfred's custom tools as native function calls. Declaring
  // tools:false makes Alfred fall back to its prompt-encoded toolset, so the
  // full Alfred tool ecosystem still works through this provider.
  // vision:true — images travel as base64 image blocks in the user message.
  readonly capabilities = {
    tools: false,
    thinking: true,
    vision: true,
    streaming: true,
    modelManagement: false,
  };

  private readonly log: Logger;
  private readonly sessions: EngineSessions | null;

  constructor(private readonly opts: ClaudeCodeProviderOptions) {
    this.log = opts.logger ?? noopLogger;
    this.sessions = opts.sessionsDir ? new EngineSessions(opts.sessionsDir, this.log) : null;
  }

  /**
   * Runtime facts about this backend, plus the behavioural traits the core
   * reads instead of hard-coding provider names (see
   * `packages/core/src/llm/providerTraits.ts`). Never expose a token here.
   * Snapshotted by the host at registration.
   */
  getRuntimeConfig(): Record<string, unknown> {
    const timeout = this.opts.config.requestTimeoutMs;
    return {
      models: this.opts.config.modelsRaw,
      contextWindow: this.opts.config.contextWindow,
      auth: 'account-pool',
      accounts: this.opts.pool.list().length,
      cli: `${this.opts.cli.source}${this.opts.cli.path ? ` (${this.opts.cli.path})` : ''}`,
      requestTimeoutMs: timeout,
      // A request may wait for its seat, retry there, then try another seat,
      // and a large conversation takes minutes to its first token (the
      // plugin's own budget scales with the prompt): the host's ceiling.
      streamFirstChunkTimeoutMs: Math.max(15 * 60_000, timeout),

      // ---- declared traits -------------------------------------------------
      // The whole toolset is rendered into the prompt on every turn (this
      // provider declares `tools: false`, so Alfred encodes its tool protocol
      // as text), which is exactly the case compact descriptions exist for.
      inlinesToolSchemas: true,
      // A thinking model can pause between deltas; only a really long total
      // silence means the CLI is gone. Host ceiling is 10 min.
      streamIdleTimeoutMs: 10 * 60_000,

      // ---- run limits (packages/core/src/llm/runLimits.ts) -----------------
      // A subscription seat is not a local GPU serving two requests: Alfred
      // must not throttle Claude. `0` = unlimited for every key below. What
      // stays: the user's Stop, the host's repeated-tool-call warning, and the
      // dead-CLI detectors above (first output, stream silence).
      maxIterations: 0,
      maxAutoContinue: 0,
      maxDelegationDepth: 0,
      // Sub-agents call chat() (non-streaming); the CLI's own exit/error is
      // the dead-backend signal, so no host wall clock on a generation.
      chatTimeoutMs: 0,
      // A silent sub-agent is reported, not killed.
      stallPolicy: 'warn',
      // Every request is its own CLI process on a seat. Plugin settings;
      // `0` (the default) = unlimited.
      maxConcurrentRequests: this.opts.config.maxConcurrentRequests,
      maxParallelTasks: this.opts.config.maxParallelTasks,
      // Thinking mode maps onto the CLI's `--effort` (native CLI only), one
      // mode per effort level; the UI offers exactly these. There is no "off"
      // for adaptive thinking, so it is not declared: a conversation still
      // storing `off` runs at the nearest declared mode (`low`) on the host.
      thinkingModeOptions: {
        low: { claudeEffort: 'low' },
        medium: { claudeEffort: 'medium' },
        high: { claudeEffort: 'high' },
        xhigh: { claudeEffort: 'xhigh' },
        max: { claudeEffort: 'max' },
      },
      // What a conversation left on `default` ("Auto") runs at: the UI shows
      // this budget instead of Auto. Display only: the effort itself is
      // applied in attemptOnce() (`DEFAULT_EFFORT`) and by the session adapter.
      defaultThinkingMode: DEFAULT_EFFORT,
      // Alfred's own prompt-encoded protocol is Qwen-style `<tool_call>` JSON,
      // and that is the only textual protocol this provider's replies can
      // contain — Claude never emits Hermes XML unprompted.
      // Claude also falls back on its own `<invoke name=…>` syntax now and
      // then; declaring it lets the host execute those calls instead of
      // leaving raw markup in the reply.
      textToolCallFormats: ['qwen_json', 'claude_xml'],
    };
  }

  /**
   * Real context window per model and the compaction budget, for the host's
   * compaction trigger (modelContext.ts).
   */
  async getModelInfo(name: string): Promise<ModelDetails> {
    return modelDetailsOf(name, this.opts.config.compactAtTokens);
  }

  async listModels(): Promise<ModelInfo[]> {
    const base = parseModels(this.opts.config.modelsRaw, this.opts.config.contextWindow, this.id).map(
      (m) => withServedModel(m, this.opts.pool.servedModelOf(m.id)),
    );
    const pinned: ModelInfo[] = [];
    for (const account of this.opts.pool.pinnableAccounts()) {
      for (const m of base) {
        pinned.push({
          ...m,
          id: `${m.id}${ACCOUNT_SEPARATOR}${account.id}`,
          displayName: `${m.displayName} · ${account.label}`,
        });
      }
    }
    return [...base, ...pinned];
  }

  /**
   * Drains {@link stream}. Errors propagate: an aborted or failed turn used to
   * come back as `{ content: '', finishReason: 'stop' }`, which is
   * indistinguishable from a model that legitimately said nothing.
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    let response: ChatResponse | undefined;
    for await (const chunk of this.stream(req)) {
      if (chunk.type === 'done') response = chunk.response;
    }
    if (req.signal?.aborted) throw abortError();
    if (!response) {
      throw new Error(`${LABEL} stream ended without producing a response.`);
    }
    return response;
  }

  /**
   * One request, possibly several seats. The conversation lives in Alfred and
   * is re-sent whole on every call, so moving to another seat is simply
   * running the same request there — as long as nothing reached the caller
   * yet. Once a chunk is out, a failure is surfaced instead of replayed.
   */
  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const { model, pinned } = splitModel(req.model);
    const built = buildPrompt(req.messages);
    if (built.dropped.attachments > 0 || built.dropped.images > 0) {
      this.log.warn('dropping message parts this provider cannot carry', { ...built.dropped });
    }
    const tried = new Set<string>();
    const agent = req.metadata?.agentId;
    // One Claude Code session per conversation: its prompt cache lives on the
    // seat that served it, so the conversation stays there for its whole life
    // and moves only when that seat is really out (accounts/pool.ts `pick`).
    const sessionKey = this.sessions ? EngineSessions.keyOf(req) : null;
    const rec = sessionKey ? this.sessions?.record(sessionKey) : undefined;
    const prefer = rec?.accountId;
    // What moving this conversation would re-write on the other seat.
    const contextTokens = rec?.contextTokens ?? estimatePromptTokens(built);
    const pool = this.opts.pool;
    // Seats this request was silent on (see MAX_SILENT_SEATS).
    let silentSeats = 0;

    for (;;) {
      if (req.signal?.aborted) throw abortError();
      if (sessionKey && prefer && !tried.has(prefer)) {
        // Its seat only sits out a throttle: wait for it rather than move.
        const wait = pool.throttledFor(prefer);
        if (wait > 0 && wait <= MAX_STICKY_WAIT_MS) {
          this.log.info('waiting for the conversation seat to come back from a throttle', {
            thread: sessionKey,
            account: prefer,
            waitMs: wait,
          });
          await sleepAbortable(wait, req.signal);
          if (req.signal?.aborted) throw abortError();
        }
      }
      const pick = pool.pick({ model, pinned, exclude: tried, prefer });
      if (!pick.account) throw new Error(`${LABEL}: ${pick.reason}`);
      const account = pick.account;
      if (sessionKey && prefer && account.id !== prefer) {
        const owner = pool.get(prefer);
        this.log.warn('moving the conversation to another seat', {
          thread: sessionKey,
          from: prefer,
          to: account.id,
          why: tried.has(prefer) ? 'failed this request' : owner ? pool.unavailableReason(owner) ?? 'unknown' : 'seat removed',
          contextTokens,
          // Every token of it is written again into the new seat's cache.
          estimatedCacheWriteTokens: contextTokens,
        });
      }
      tried.add(account.id);

      let retries = 0;
      for (;;) {
        let emitted = false;
        try {
          for await (const chunk of this.attempt(req, model, built, account, agent, sessionKey)) {
            // Prefill progress is a heartbeat, not part of the answer: the
            // request can still be retried or moved after it.
            if (chunk.type !== 'done' && chunk.type !== 'prompt_processing') emitted = true;
            yield chunk;
          }
          return;
        } catch (err) {
          if (err instanceof AccountFailure) {
            if (err.switchable && !emitted) {
              // A transient failure (429, overload, a silent CLI) on a
              // conversation's seat is retried there first: the seat still
              // has its quota and the conversation's cache.
              const budget = err.silent ? SILENT_IN_PLACE_RETRIES : IN_PLACE_RETRY_DELAYS_MS.length;
              if (sessionKey && err.kind === 'throttle' && retries < budget && !req.signal?.aborted) {
                const delay = IN_PLACE_RETRY_DELAYS_MS[Math.min(retries, IN_PLACE_RETRY_DELAYS_MS.length - 1)];
                retries++;
                this.log.warn('transient failure: retrying on the same seat', {
                  thread: sessionKey,
                  account: account.id,
                  attempt: retries,
                  delayMs: delay,
                  silent: err.silent,
                  detail: err.message.slice(0, 160),
                });
                await sleepAbortable(delay, req.signal);
                if (req.signal?.aborted) throw abortError();
                continue;
              }
              if (err.silent && ++silentSeats >= MAX_SILENT_SEATS) {
                throw new Error(
                  `${LABEL}: no output on ${silentSeats} seats in a row (last: "${account.label}", ${err.message}). ` +
                    'Not moved further: each move re-writes the whole conversation on another seat.',
                );
              }
              this.log.warn('switching Claude account', {
                from: account.id,
                kind: err.kind,
                silent: err.silent || undefined,
                resetsAt: err.resetsAt ? new Date(err.resetsAt).toISOString() : undefined,
                thread: sessionKey ?? undefined,
                retriesOnSeat: retries,
                contextTokens: sessionKey ? contextTokens : undefined,
              });
              break;
            }
            // ISO: the host's auto-resume reads the reset time from the message.
            const reset = err.resetsAt ? ` (resets ${new Date(err.resetsAt).toISOString()})` : '';
            throw new Error(
              emitted
                ? `${LABEL} account "${account.label}" failed mid-answer${reset}: ${err.message}. The partial answer is incomplete; send again to continue on another account.`
                : `${LABEL} account "${account.label}"${reset}: ${err.message}`,
            );
          }
          throw err;
        }
      }
    }
  }

  /**
   * One tiny completion on exactly `account` — no fallback to another seat —
   * so a connection test reports the seat that really answered.
   */
  async probeSeat(account: Account, model: string, prompt = 'Reply with exactly: OK'): Promise<{ text: string; accountId: string }> {
    const req: ChatRequest = { model, messages: [{ role: 'user', content: prompt }] };
    let text = '';
    for await (const chunk of this.attempt(req, model, buildPrompt(req.messages), account, 'testConnection')) {
      if (chunk.type === 'done') text = chunk.response.content;
    }
    return { text, accountId: account.id };
  }

  /**
   * One attempt of `req` on one seat. Throws {@link AccountFailure} on seat-level errors.
   *
   * Engine-mode turns with a session key run in the conversation's persistent
   * CLI session (see engineSessions.ts) and send only what is new; a session
   * lost before any output is retried once as a one-shot request.
   */
  private async *attempt(
    req: ChatRequest,
    model: string,
    built: BuiltPrompt,
    account: Account,
    agent: string | undefined,
    sessionKey: string | null = null,
  ): AsyncIterable<ChatChunk> {
    try {
      yield* this.attemptOnce(req, model, built, account, agent, sessionKey);
    } catch (err) {
      if (err instanceof AdvisorRefused && this.opts.advisor) {
        // Same seat, without the advisor (settingsFor now omits it): an
        // advisor refusal is not a reason to move the conversation. Cannot
        // loop: without the advisor there is nothing left to refuse.
        this.opts.advisor.markIncompatible(account.id, err.message);
        yield* this.attempt(req, model, built, account, agent, sessionKey);
        return;
      }
      if (!(err instanceof SessionLost)) throw err;
      // The process died before any answer text. Its session is kept and
      // resumed first (same seat, same cache); a resume that dies too gives
      // up on it, leaves a tombstone, and the last try starts a fresh session
      // that is told why (hostCutNote.ts).
      this.log.warn('Claude engine session lost before any answer text; resuming it', {
        account: account.id,
        detail: err.message.slice(0, 200),
      });
      try {
        yield* this.attemptOnce(req, model, built, account, agent, sessionKey);
      } catch (again) {
        if (!(again instanceof SessionLost)) throw again;
        this.log.warn('resume failed too; retrying once on a fresh session', {
          account: account.id,
          detail: again.message.slice(0, 200),
        });
        yield* this.attemptOnce(req, model, built, account, agent, sessionKey);
      }
    }
  }

  private async *attemptOnce(
    req: ChatRequest,
    model: string,
    built: BuiltPrompt,
    account: Account,
    agent: string | undefined,
    sessionKey: string | null,
  ): AsyncIterable<ChatChunk> {
    const query = await loadQuery();
    const pool = this.opts.pool;
    const sessions = this.sessions;

    // The SDK owns the child process, so cancellation has to reach it through
    // its own controller. `Deadline` composes the caller's signal with our
    // time-to-first-chunk budget and detaches from `req.signal` on dispose.
    const controller = new AbortController();
    // Prompt size of this request: measured on the session's last request,
    // else estimated. Scales the time-to-first-output budget and gates the
    // advisor.
    const knownRecord = sessionKey && sessions ? sessions.record(sessionKey) : undefined;
    const contextTokens = knownRecord?.contextTokens ?? estimatePromptTokens(built);
    // A 700k-token conversation takes minutes to its first token: the budget
    // grows with the prompt (Deadline.prefillBudgetMs), and every sign of life
    // before the first token (CLI init, API message start, rate-limit
    // headers) restarts it.
    const timeoutMs = Deadline.prefillBudgetMs(this.opts.config.requestTimeoutMs, contextTokens);
    const deadline = new Deadline(req.signal, timeoutMs, LABEL);

    const options: QueryOptions = {
      model,
      maxTurns: 1,
      // Text-only: no native tools. Alfred sends its tool protocol as text in
      // the system message (capabilities.tools === false) and parses the
      // model's `<tool_call>...</tool_call>` text itself. We must NOT let Claude
      // Code run its own agentic tools (Bash/Read/Write/...) on the machine.
      allowedTools: [],
      disallowedTools: BUILTIN_TOOLS,
      // 'dontAsk' hard-denies anything not pre-approved instead of prompting
      // (which would hang headless) or auto-approving (bypassPermissions).
      permissionMode: 'dontAsk',
      canUseTool: denyAllTools,
      includePartialMessages: true,
      // Don't load the user's CLAUDE.md / project settings / skills — we want a
      // clean completion driven entirely by Alfred's prompt.
      settingSources: [],
      env: buildChildEnv(pool, account),
      abortController: controller,
    };
    // The system prompt heads the cached prefix and is shared by every session
    // of the same agent; its volatile tail (boot notes, open tasks, runtime
    // line) travels in the first user message instead, as the CLI does with
    // its own context (system reminders), so it cannot invalidate the head.
    const system = splitVolatileContext(built.systemPrompt);
    if (system.stable) options.systemPrompt = system.stable;
    const fullContent = (): SdkInputBlock[] =>
      system.volatile ? [{ type: 'text', text: contextReminder(system.volatile) }, ...built.content] : built.content;
    if (this.opts.cli.path) options.pathToClaudeCodeExecutable = this.opts.cli.path;
    if (this.opts.tracker) options.spawnClaudeCodeProcess = this.opts.tracker.spawner();
    let effort: string | null = null;
    if (this.opts.cli.native) {
      // The deny list above can't keep up with new CLI tools (PowerShell,
      // Skill, ToolSearch, Monitor...): Opus would call one, the CLI denies it
      // and the single allowed turn ends in error_max_turns with no text.
      // `--tools ""` removes every built-in tool, `--strict-mcp-config` drops
      // user MCP servers, `--disable-slash-commands` drops skills.
      options.extraArgs = { tools: '', 'strict-mcp-config': null, 'disable-slash-commands': null };
      // No thinking mode chosen = `high`, explicitly: without `--effort` the
      // CLI picks its own per-model default, which is not ours to depend on.
      const e = req.providerOptions?.claudeEffort ?? DEFAULT_EFFORT;
      if (typeof e === 'string' && /^(low|medium|high|xhigh|max)$/.test(e)) {
        options.extraArgs.effort = e;
        effort = e;
      }
    }
    // The server-side advisor: conversations the user talks to (advisorScope),
    // unless refused by the API on this seat.
    const advisorLimit = this.opts.config.advisorMaxContextTokens ?? DEFAULT_ADVISOR_MAX_CONTEXT_TOKENS;
    // A large conversation gets no advisor on a new process: each consult
    // re-reads the whole context, uncached. A live process keeps the one it
    // was launched with (relaunching it would re-write the cached prefix).
    const advisorTooLarge = advisorLimit > 0 && contextTokens > advisorLimit;
    const advisorSettings = advisorTooLarge ? undefined : this.opts.advisor?.settingsFor(account.id, engineThread(req));
    if (advisorSettings) options.settings = advisorSettings;
    let advisorModel = advisorSettings?.advisorModel;

    // ---- persistent session: which process, and what to send it ----------
    // Only with the native CLI: `--tools ""` guarantees a user message gets a
    // single model call, so a long-lived process never runs an agent loop.
    const nonSystem = req.messages.filter((m) => m.role !== 'system');
    let live: LiveSession | undefined;
    let record: EngineSessionRecord | undefined;
    let content = fullContent();
    let sessionMode: 'one-shot' | 'fresh' | 'continue' | 'resume' = 'one-shot';
    let planReason = '';
    // What was on disk for this conversation before this request (a tombstone
    // when its last process died).
    const previous = sessionKey && sessions ? sessions.record(sessionKey) : undefined;
    // When this thread last ran a request (its cache is warm within the TTL).
    const previousTurnAt = previous?.sessionId ? previous.updatedAt : undefined;
    const previousSeat = previous?.accountId;
    // An unloading plugin starts no process: it only drains the busy ones.
    if (sessionKey && sessions && this.opts.cli.native && !sessions.disposing) {
      const existing = sessions.getLive(sessionKey);
      if (existing?.busy) {
        // Two requests at once on one thread cannot share its process.
        this.log.warn('thread already has a request running: this one is served outside its session', {
          thread: sessionKey,
          account: account.id,
          contextTokens,
        });
      } else {
        const plan = planSession(sessions.record(sessionKey), {
          accountId: account.id,
          system: built.systemPrompt,
          messages: nonSystem,
          crossSeat: this.opts.crossSeat?.() ?? false,
        });
        if (plan.kind === 'continue') {
          record = sessions.record(sessionKey) as EngineSessionRecord;
          const delta = buildPrompt(plan.delta).content;
          const lead: SdkInputBlock[] = [];
          if (plan.systemNote) lead.push({ type: 'text', text: plan.systemNote });
          if (plan.foreign > 0) lead.push({ type: 'text', text: foreignRepliesNote(plan.foreign) });
          content = [...lead, ...delta];
          if (plan.foreign > 0) this.log.info('replies written outside the session sent as context', { thread: sessionKey, count: plan.foreign });
          // Same seat and model: the live process serves it. A new effort is
          // applied to it in place; the advisor it was launched with stays.
          let reusable = !!existing && existing.accountId === account.id && existing.model === model;
          if (reusable && existing && existing.effort !== effort) {
            // Held while the CLI applies it: no other request may take it.
            existing.busy = true;
            reusable = await applyEffort(existing, effort);
            existing.busy = false;
            this.log.info(reusable ? 'effort changed on the live session' : 'effort change needs a new process', {
              thread: sessionKey,
              from: existing.effort,
              to: effort,
            });
          }
          if (reusable && existing) {
            live = existing;
            sessionMode = 'continue';
            advisorModel = existing.advisor;
          } else {
            if (existing) {
              const why =
                existing.accountId !== account.id ? 'seat changed' : existing.model !== model ? 'model changed' : 'effort changed';
              // Same session, resumed by a new process (`--resume`).
              sessions.closeSession(existing, `${why}; the session is resumed`);
            }
            sessionMode = 'resume';
          }
        } else {
          if (existing) sessions.close(sessionKey, `new session: ${plan.reason}`);
          planReason = plan.reason;
          record = {
            key: sessionKey,
            sessionId: null,
            accountId: account.id,
            launchSystem: system.stable,
            currentSystem: built.systemPrompt,
            history: [],
            // A new transcript holds no marker from before the notes.
            markersExplained: true,
            updatedAt: Date.now(),
          };
          sessionMode = 'fresh';
        }
      }
    }
    // Interrupt markers and lost processes the model would otherwise read as
    // the user stopping it (hostCutNote.ts).
    const notes = markerNotes(sessionMode, record, previous);
    if (notes.length > 0) content = [...notes.map((text): SdkInputBlock => ({ type: 'text', text })), ...content];
    const persistent = sessionMode !== 'one-shot';
    if (persistent && !live && sessions && record && sessionKey) {
      const sessionController = new AbortController();
      const input = new PushQueue<SdkUserMessage>();
      const sessionOptions: QueryOptions = { ...options, abortController: sessionController };
      // A user message gets exactly one model call (no tools), so no turn cap:
      // `maxTurns` would count across the whole life of the process.
      delete sessionOptions.maxTurns;
      // The launch system prompt, not this request's: it heads the cached prefix.
      if (record.launchSystem) sessionOptions.systemPrompt = record.launchSystem;
      else delete sessionOptions.systemPrompt;
      if (sessionMode === 'resume' && record.sessionId) {
        sessionOptions.resume = record.sessionId;
        // Back to the last reply Alfred kept: a failed or killed request may
        // have left its delta (or an API error) in the transcript.
        if (record.lastUuid) sessionOptions.resumeSessionAt = record.lastUuid;
        if (record.accountId !== account.id) {
          this.log.warn('continuing the Claude session on another seat', {
            thread: sessionKey,
            from: record.accountId,
            to: account.id,
            sessionId: record.sessionId,
            // Written again in full into the new seat's prompt cache.
            contextTokens,
          });
        }
      }
      const q = query({ prompt: input, options: sessionOptions }) as unknown as LiveQuery;
      this.opts.advisor?.observe(account.id, q, advisorSettings);
      live = new LiveSession(sessionKey, account.id, model, effort, q, input as PushQueue<unknown>, sessionController);
      live.advisor = advisorModel;
      sessions.add(live);
    }
    if (live) live.busy = true;
    // Why this request may re-write the conversation into the prompt cache
    // (null = it should read it). Checked against the measured usage below.
    const ttl = sessions?.ttlFor(account.id) ?? CACHE_TTL_1H;
    const expectedCold = coldReason({
      mode: sessionMode,
      planReason,
      seatChanged: !!previousSeat && previousSeat !== account.id && sessionMode !== 'fresh',
      idleMs: previousTurnAt !== undefined ? Date.now() - previousTurnAt : undefined,
      ttlMs: ttl,
      keyed: !!sessionKey,
    });

    // Stop / time-to-first-chunk. A one-shot process is killed; a persistent
    // one is interrupted on Stop (the session lives on) and closed on a
    // silent timeout (it is wedged).
    let requestAborted = false;
    let stopFallback: ReturnType<typeof setTimeout> | undefined;
    const onDeadline = (): void => {
      requestAborted = true;
      if (!live) {
        controller.abort(deadline.signal.reason);
        return;
      }
      if (deadline.userAborted) {
        const stopped = live;
        void Promise.resolve(stopped.query.interrupt?.()).catch(() => undefined);
        // A CLI that never answers the interrupt would hold the turn (and its
        // parent's Stop) forever: close its process; the record stays.
        stopFallback = setTimeout(() => {
          if (!stopped.dead) sessions?.closeSession(stopped, 'stop: no result after the interrupt');
        }, INTERRUPT_SETTLE_MS);
        stopFallback.unref?.();
      } else if (sessions) {
        sessions.closeSession(live, 'no output within the request timeout');
      }
    };
    if (deadline.signal.aborted) onDeadline();
    else deadline.signal.addEventListener('abort', onDeadline, { once: true });

    this.log.info('stream request', {
      model,
      account: account.id,
      messages: req.messages.length,
      images: built.images,
      // What actually reaches the CLI as `--effort` (absent = CLI default).
      effort,
      // Advisor setting the CLI got (it may still refuse it: see the seat's advisor state).
      advisor: advisorModel ?? null,
      session: sessionMode,
      ...(planReason ? { sessionReason: planReason } : {}),
      thread: sessionKey,
      task: req.session?.task ?? false,
      sentBlocks: content.length,
      contextTokens,
      timeoutMs,
      ...(expectedCold ? { expectedCold } : {}),
    });

    let assembledContent = '';
    let assembledThinking = '';
    let finishReason: ChatResponse['finishReason'] = 'stop';
    let usage: ChatResponse['usage'];
    let sawStreamedText = false;
    let tokens: TokenSample | undefined;
    let rejectedUntil: number | null = null;
    let sdkError: string | undefined;
    // `api_error` of a synthetic error turn (`advisor_incompatible`, ...).
    let apiError: unknown;
    let advisorRefused = false;
    let syntheticText = '';
    let initTools: string[] = [];
    let sessionId: string | null = null;
    let gotResult = false;
    let resultCost: number | undefined;
    // Real model id behind the requested alias (`opus` -> `claude-opus-5-5`),
    // from the init message first, then from each assistant message.
    let servedModel: string | undefined;
    const toolUses: string[] = [];
    // Native tool calls of the current API message. Parallel calls arrive as
    // one SDK `assistant` message per block (same message id), so they are
    // collected until the message ends (`message_stop`), then re-emitted.
    const nativeCalls: Array<{ name: string; input?: unknown }> = [];
    // Usage of the latest API message (`message_start`, completed by
    // `message_delta`): the record of a request stopped before its `result`
    // (re-emitted tool calls, cut replies), and of every persistent-session
    // request, whose `result` totals are per process.
    let stepUsage: SdkUsage | undefined;
    // Ends the reply right after its tool call(s) — see toolCallCutter.ts.
    const cutter = new ToolCallCutter();
    let rawText = '';
    let cutAfterToolCall = false;
    // This request interrupted its own CLI turn after a tool call (host cut).
    let hostInterrupted = false;
    // What the pool records for this attempt; unset = served.
    let failed: { outcome: 'error' | 'switched'; detail: string } | null = null;
    // The seat failed (limit, throttle, auth), not the session.
    let seatFailed = false;
    // ...and only for a moment (429, overload): it is retried on this seat.
    let throttled = false;
    // Transcript uuid of this reply's last assistant entry.
    let replyUuid: string | undefined;
    // Nothing came back within the time-to-first-output budget: the session
    // is not at fault, it is resumed as is.
    let silent = false;

    // Session and prompt-cache facts of this request, for the host UI.
    let servedInfo: ProviderSessionInfo | undefined;
    const buildResponse = (): ChatResponse => {
      const base = servedModel ? { ...usage, servedModel } : usage;
      return {
        content: assembledContent.trim(),
        thinking: assembledThinking.trim() || undefined,
        finishReason,
        // Session and cache facts, under the `MessageUsage` names the UI reads
        // (context meter, cold-cache warning).
        usage: servedInfo ? { ...base, ...usageFields(servedInfo) } : base,
      };
    };
    // The API refused the advisor before anything was produced: the caller
    // replays the request on this same seat without it.
    const advisorRefusal = (detail: string): AdvisorRefused | null => {
      if (!advisorModel || assembledContent || assembledThinking || !isAdvisorRefusal(detail, apiError)) return null;
      advisorRefused = true;
      failed = { outcome: 'switched', detail };
      return new AdvisorRefused(detail);
    };
    const fail = (detail: string): AccountFailure => {
      const c = classifyFailure(detail, sdkError, rejectedUntil);
      seatFailed = c.kind === 'limit' || c.kind === 'throttle' || c.kind === 'auth';
      throttled = c.kind === 'throttle';
      if (c.kind === 'limit') {
        const until =
          c.resetsAt ?? pool.runtime(account.id).exhaustedUntil ?? Date.now() + 30 * 60_000;
        pool.markExhausted(account.id, until, detail.slice(0, 200));
        return new AccountFailure(detail, 'limit', account, until);
      }
      if (c.kind === 'throttle') {
        pool.backoff(account.id, THROTTLE_BACKOFF_MS, `throttled: ${detail.slice(0, 180)}`);
        return new AccountFailure(detail, 'throttle', account, null);
      }
      if (c.kind === 'auth') pool.markAuthFailed(account.id, detail.slice(0, 200));
      return new AccountFailure(detail, c.kind, account, null);
    };

    pool.begin(account.id);
    let iterator: AsyncIterator<unknown> | undefined;
    try {
      if (live) {
        live.input.push(oneUser(content));
        iterator = live.iterator;
      } else {
        const q = query({ prompt: oneUserMessage(content), options });
        this.opts.advisor?.observe(account.id, q, advisorSettings);
        iterator = q[Symbol.asyncIterator]();
      }
      for (;;) {
        const step = await iterator.next();
        if (step.done) {
          if (persistent && !gotResult) {
            // Our own timeout closed it: fail like a silent seat (catch below),
            // never end the turn on an empty reply.
            if (requestAborted && !deadline.userAborted) {
              throw new Error(`no output within ${timeoutMs}ms`);
            }
            if (!requestAborted) {
              throw new Error(
                `Claude Code session process ended before its reply${sessions?.disposing ? ' (plugin unloading)' : ''}`,
              );
            }
          }
          break;
        }
        const message = step.value as SdkMessage;
        const sid = (message as { session_id?: unknown }).session_id;
        if (typeof sid === 'string' && sid) sessionId = sid;
        if (requestAborted && persistent) {
          // Stop: the interrupt is on its way; nothing more reaches the caller.
          if (message.type === 'result') {
            gotResult = true;
            break;
          }
          continue;
        }
        // Diagnostics for error_max_turns: what the CLI exposed and what the
        // model tried to call.
        const probe = message as { type: string; subtype?: string; tools?: string[]; model?: string; message?: { content?: { type: string; name?: string }[] } };
        if (probe.type === 'system') {
          // The CLI is alive and working on it: the silence budget starts over.
          deadline.rearmTimeout();
          if (probe.subtype === 'init') {
            initTools = probe.tools ?? [];
            if (typeof probe.model === 'string' && probe.model) servedModel = probe.model;
            if (!sawStreamedText && !assembledThinking) {
              // Heartbeat for the host's own first-chunk timer, not an answer.
              yield { type: 'prompt_processing', nTokens: contextTokens, progress: 0 };
            }
          }
        }
        if (probe.type === 'assistant') {
          for (const b of probe.message?.content ?? []) if (b.type === 'tool_use' && b.name) toolUses.push(b.name);
        }
        if (message.type === 'stream_event') {
          // The SDK's message union ends in a catch-all `{ type: string }`, so
          // a discriminant check does not narrow on its own.
          const { event } = message as Extract<SdkMessage, { type: 'stream_event' }>;
          if (event.type === 'message_start') {
            // The API accepted the request: alive, the budget starts over.
            deadline.rearmTimeout();
            // Input side of the request, known before any output: a reply cut
            // after its tool call never reaches `result`, and was missing from
            // the seat's token accounting.
            const startUsage = (event as { message?: { usage?: SdkUsage } }).message?.usage;
            if (startUsage) {
              usage = mergeUsage(usage, startUsage);
              stepUsage = { ...startUsage };
              sessions?.noteTtl(account.id, cacheTtlOf(startUsage));
              if (!sawStreamedText && !assembledThinking) {
                yield { type: 'prompt_processing', nTokens: promptTokensOf(startUsage), progress: 0 };
              }
            }
          } else if (event.type === 'content_block_delta' && 'delta' in event && event.delta) {
            const delta = event.delta as SdkContentDelta;
            if (delta.type === 'text_delta') {
              const text = (delta as SdkTextDelta).text ?? '';
              if (text) {
                // First real output: the CLI is alive, so stop policing the
                // clock. A long answer is not a stalled request.
                deadline.disarmTimeout();
                sawStreamedText = true;
                rawText += text;
                const cut = cutter.push(text);
                if (cut.text) {
                  assembledContent += cut.text;
                  yield { type: 'text', delta: cut.text };
                }
                if (cut.stop) {
                  cutAfterToolCall = true;
                  finishReason = 'stop';
                  break;
                }
              }
            } else if (delta.type === 'thinking_delta') {
              const thinking = (delta as SdkThinkingDelta).thinking ?? '';
              if (thinking) {
                deadline.disarmTimeout();
                assembledThinking += thinking;
                yield { type: 'thinking', delta: thinking };
              }
            }
          } else if (event.type === 'message_delta') {
            const md = event as Extract<SdkStreamEvent, { type: 'message_delta' }>;
            if (md.delta?.stop_reason) finishReason = mapStopReason(md.delta.stop_reason);
            if (md.usage) {
              usage = mergeUsage(usage, md.usage);
              stepUsage = { ...stepUsage, ...md.usage };
            }
          } else if (event.type === 'message_stop' && nativeCalls.length > 0) {
            const markup = renderNativeCalls(nativeCalls);
            assembledContent += markup;
            yield { type: 'text', delta: markup };
            finishReason = 'stop';
            cutAfterToolCall = true;
            break;
          }
        } else if (message.type === 'rate_limit_event') {
          deadline.rearmTimeout();
          const info = (message as Extract<SdkMessage, { type: 'rate_limit_event' }>).rate_limit_info;
          if (info) {
            const until = pool.applyRateLimit(account.id, info);
            if (until !== null) rejectedUntil = until;
          }
        } else if (message.type === 'assistant') {
          const am = message as Extract<SdkMessage, { type: 'assistant' }>;
          // The CLI reports seat-level failures (limit hit, login expired) as a
          // synthetic assistant turn. That text is an error, never an answer.
          if (am.error || am.message.model === '<synthetic>') {
            sdkError = am.error ?? sdkError;
            apiError = (am as { api_error?: unknown }).api_error ?? apiError;
            syntheticText += textOf(am.message.content);
            continue;
          }
          if (typeof am.message.model === 'string' && am.message.model) servedModel = am.message.model;
          const uuid = (am as { uuid?: unknown }).uuid;
          if (typeof uuid === 'string' && uuid) replyUuid = uuid;
          // Fallback: if partial streaming yielded nothing, reconstruct from the
          // complete assistant message.
          if (!sawStreamedText) {
            for (const block of am.message.content ?? []) {
              if (block.type === 'text') {
                const text = (block as { text: string }).text ?? '';
                if (text && !cutAfterToolCall) {
                  deadline.disarmTimeout();
                  const cut = cutter.push(text);
                  if (cut.text) {
                    assembledContent += cut.text;
                    yield { type: 'text', delta: cut.text };
                  }
                  if (cut.stop) cutAfterToolCall = true;
                }
              } else if (block.type === 'thinking') {
                assembledThinking += (block as { thinking: string }).thinking ?? '';
              }
            }
            if (am.message.stop_reason) finishReason = mapStopReason(am.message.stop_reason);
          }
          // Opus sometimes calls an Alfred tool natively instead of writing the
          // prompt-encoded markup. The CLI doesn't know that tool, so letting
          // it continue ends in error_max_turns: re-emit the call as the
          // markup Alfred parses and stop the CLI here.
          const calls = (am.message.content ?? []).filter(
            (b): b is { type: 'tool_use'; name: string; input?: unknown } => b.type === 'tool_use',
          );
          if (cutAfterToolCall) {
            finishReason = 'stop';
            break;
          }
          if (calls.length > 0) {
            deadline.disarmTimeout();
            nativeCalls.push(...calls.map((c) => ({ name: c.name, input: c.input })));
          }
        } else if (message.type === 'result') {
          gotResult = true;
          const rm = message as Extract<SdkMessage, { type: 'result' }>;
          if (persistent) {
            // Per-process totals: this request's share is the difference.
            if (typeof rm.total_cost_usd === 'number' && live) {
              resultCost = Math.max(0, rm.total_cost_usd - live.costSoFar);
              live.costSoFar = rm.total_cost_usd;
            }
          } else if (rm.usage) {
            usage = mergeUsage(usage, rm.usage);
            tokens = {
              input: rm.usage.input_tokens ?? 0,
              output: rm.usage.output_tokens ?? 0,
              cacheRead: rm.usage.cache_read_input_tokens ?? 0,
              cacheWrite: rm.usage.cache_creation_input_tokens ?? 0,
              costUsd: typeof rm.total_cost_usd === 'number' ? rm.total_cost_usd : 0,
            };
          }
          const errored =
            rm.is_error || rm.subtype === 'error_max_turns' || rm.subtype === 'error_during_execution';
          if (errored || sdkError) {
            this.log.warn('request failed', {
              account: account.id,
              model,
              servedModel,
              subtype: rm.subtype,
              numTurns: (rm as { num_turns?: number }).num_turns,
              initTools: initTools.slice(0, 40),
              toolUses,
              contentChars: assembledContent.length,
              session: sessionMode,
            });
            const detail =
              syntheticText.trim() || rm.result || rm.errors?.join('; ') || rm.subtype || 'unknown error';
            const refused = advisorRefusal(detail);
            if (refused) throw refused;
            const failure = fail(detail);
            // Seat-level failures always surface (the caller decides whether to
            // switch). Other errors after streamed content keep the old
            // behaviour: the answer stands.
            if (failure.switchable || !assembledContent) {
              failed = { outcome: failure.switchable && !assembledContent ? 'switched' : 'error', detail };
              throw failure;
            }
          }
          // A persistent process stays up after its reply.
          if (persistent) break;
        }
      }
      if (/<\/?(?:[a-z]+:)?(?:invoke|function_calls|parameter)\b/.test(rawText)) {
        // Claude's own call syntax leaked into text: keep the raw shape for
        // diagnosis (the host only ever sees the cleaned version).
        this.log.info('claude-native call markup in reply', {
          account: account.id,
          raw: rawText.slice(0, 4_000),
        });
      }
      if (nativeCalls.length > 0 && !cutAfterToolCall) {
        // No `message_stop` seen (partial messages off): emit them now.
        const markup = renderNativeCalls(nativeCalls);
        assembledContent += markup;
        yield { type: 'text', delta: markup };
        finishReason = 'stop';
        cutAfterToolCall = true;
      }
      if (cutAfterToolCall) {
        // The rest of this generation is the model talking to itself; stop
        // the CLI rather than paying for it.
        this.log.info('reply ended after its tool call', { account: account.id, model });
        if (live && !gotResult) {
          hostInterrupted = true;
          // Interrupt the turn but keep the process: the session keeps what
          // was generated up to here, and receives the tool results next.
          gotResult = await this.interruptTurn(
            live,
            iterator,
            (u) => {
              stepUsage = { ...stepUsage, ...u };
            },
            (uuid) => {
              replyUuid = uuid;
            },
          );
        } else if (!live) {
          try {
            controller.abort();
          } catch {
            // already gone
          }
        }
      } else {
        const rest = cutter.flush();
        if (rest) {
          assembledContent += rest;
          yield { type: 'text', delta: rest };
        }
      }
    } catch (err) {
      if (err instanceof AccountFailure || err instanceof AdvisorRefused) throw err;
      if (isAbortLike(err) || controller.signal.aborted || (persistent && requestAborted)) {
        // User pressed Stop, or our own time-to-first-chunk budget fired. The
        // host contract requires exactly one `done`. A timeout that produced
        // nothing at all is still a failure, so it is reported as one.
        if (!deadline.userAborted && assembledContent.length === 0) {
          // Nothing reached the caller, so the request can still move on: a
          // silent seat (seen right after a window reset) is benched for a
          // few minutes and the next seat gets the request, instead of the
          // whole turn failing after the wait.
          const detail = `no output within ${timeoutMs}ms`;
          failed = { outcome: 'switched', detail };
          silent = true;
          // A one-off request moves on at once; a conversation is retried on
          // its seat first (stream()), so the seat is benched only for others.
          pool.backoff(account.id, sessionKey ? THROTTLE_BACKOFF_MS : SILENT_SEAT_BACKOFF_MS, `silent: ${detail}`);
          throw new AccountFailure(
            `${LABEL} produced nothing within ${timeoutMs}ms on account "${account.label}". ` +
              `Check that the \`claude\` CLI is installed and that account is logged in (Claude accounts page).`,
            'throttle',
            account,
            null,
            true,
          );
        }
        yield { type: 'done', response: buildResponse() };
        return;
      }
      // The SDK throws on a non-zero CLI exit; its message carries the reason.
      const detail = (err instanceof Error ? err.message : String(err)) + (syntheticText ? ` ${syntheticText}` : '');
      const refused = advisorRefusal(detail);
      if (refused) throw refused;
      const failure = fail(detail);
      if (persistent && !failure.switchable && assembledContent.length === 0) {
        // The session's process went away (crash, killed, bad resume) before
        // any answer text: the caller retries once on a fresh session. Thinking
        // already streamed is only re-thought, never shown twice as an answer.
        failed = { outcome: 'switched', detail };
        throw new SessionLost(detail);
      }
      failed = { outcome: failure.switchable && !assembledContent ? 'switched' : 'error', detail };
      if (failure.switchable) throw failure;
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      // Also runs when the consumer breaks out of the loop early, which is what
      // detaches our listener from the host's long-lived abort signal.
      deadline.signal.removeEventListener('abort', onDeadline);
      deadline.dispose();
      if (stopFallback) clearTimeout(stopFallback);
      if (!live && iterator && !gotResult) {
        // One-shot process left mid-stream: make sure it is gone.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      }
      if (live && sessions && record) {
        const userStopped = requestAborted && deadline.userAborted;
        if (advisorRefused) {
          // The process goes (it was launched with the advisor), the session
          // stays: the replay without the advisor resumes it at the last reply.
          sessions.closeSession(live, 'advisor refused by the API');
        } else if (failed && seatFailed && persistent && record.sessionId && (throttled || (this.opts.crossSeat?.() ?? false))) {
          // The seat is out, not the session: the retry on this seat (a
          // throttle) or the next seat resumes it at the last reply Alfred
          // kept and sends this request's delta again.
          sessions.closeSession(live, `seat failed: ${failed.detail.slice(0, 120)}`);
        } else if (!failed && userStopped && (!gotResult || !replyUuid)) {
          // Stopped before the CLI settled: the process goes, the session
          // stays. The record still describes what the session held before
          // this request, so the next one resumes it (`--resume`) and sends
          // what is new since then, or starts afresh if Alfred's history
          // moved on differently.
          // (Or it settled with nothing of the reply in the transcript.)
          sessions.closeSession(live, 'stopped before the reply settled');
        } else if (silent && record.sessionId && sessionMode !== 'fresh') {
          // Silent, not broken: the next try resumes the same session at the
          // last reply Alfred kept.
          sessions.closeSession(live, `request failed: ${failed?.detail.slice(0, 120) ?? 'silent'}`);
        } else if ((failed && !seatFailed) || !gotResult) {
          sessions.closeSession(live, failed ? `request failed: ${failed.detail.slice(0, 120)}` : 'reply never completed');
          if (record.sessionId && sessionMode !== 'fresh' && (record.failures ?? 0) < 1) {
            // The process went away (crash, kill): its session is resumed once
            // (`--resume` at the last reply kept, same seat, cache still warm)
            // before the conversation gives up on it.
            record.failures = (record.failures ?? 0) + 1;
            sessions.save(record);
            this.log.info('engine session kept for a resume after a failed request', { thread: live.key, sessionId: record.sessionId });
          } else if (failed) {
            // A resume that failed too: the next request starts a fresh
            // session, told why by the tombstone.
            sessions.markLost(live.key, account.id, failed.detail);
          } else {
            sessions.forget(live.key);
          }
        } else if (failed) {
          // The seat failed and the session cannot follow to another one.
          sessions.closeSession(live, `request failed: ${failed.detail.slice(0, 120)}`);
          sessions.forget(live.key);
        } else {
          record.sessionId = sessionId ?? record.sessionId;
          record.accountId = account.id;
          record.currentSystem = built.systemPrompt;
          record.history = [
            ...nonSystem.map((m) => (m.role === 'assistant' ? ASSISTANT_SLOT : messageFingerprint(m))),
            ASSISTANT_SLOT,
          ];
          record.interruptedTail = userStopped;
          record.hostCutTail = hostInterrupted && !userStopped;
          record.lastUuid = replyUuid;
          // The notes went out with this request (hostCutNote.ts).
          record.markersExplained = true;
          delete record.lostReason;
          delete record.failures;
          const measured = promptTokensOf(stepUsage);
          if (measured > 0) record.contextTokens = measured;
          sessions.save(record);
          const calledTool = cutAfterToolCall || nativeCalls.length > 0 || cutter.callCount > 0;
          if (req.session?.task && (requestAborted || !calledTool || TASK_END_CALL.test(rawText))) {
            // A sub-agent that answered (or was stopped) has finished its
            // task: nothing will feed this process again. Its record stays,
            // so a later message to that thread resumes the same session.
            sessions.closeSession(live, requestAborted ? 'sub-agent stopped' : 'sub-agent finished');
          } else {
            sessions.release(live, { task: req.session?.task });
          }
        }
      }
      if (!tokens && stepUsage) {
        // Stopped before the `result` (which carries the totals), or a
        // persistent session: the API message's own usage is the record.
        tokens = {
          input: stepUsage.input_tokens ?? 0,
          output: stepUsage.output_tokens ?? 0,
          cacheRead: stepUsage.cache_read_input_tokens ?? 0,
          cacheWrite: stepUsage.cache_creation_input_tokens ?? 0,
          costUsd: resultCost ?? 0,
        };
      }
      if (!failed) {
        servedInfo = sessionInfo({
          account,
          mode: sessionMode,
          usage: stepUsage,
          expectedCold,
          previousTurnAt,
          ttlMs: cacheTtlOf(stepUsage) ?? ttl,
          thread: sessionKey,
        });
        this.log.info('stream served', {
          model,
          servedModel,
          account: account.id,
          session: sessionMode,
          sessionId,
          thread: sessionKey,
          input: servedInfo.input,
          output: servedInfo.output,
          cacheRead: servedInfo.cacheRead,
          cacheWrite: servedInfo.cacheWrite,
          contextTokens: servedInfo.contextTokens,
          cold: servedInfo.cold,
          previousTurnAt: previousTurnAt ? new Date(previousTurnAt).toISOString() : undefined,
        });
      }
      pool.end(account.id, {
        model,
        servedModel,
        outcome: failed?.outcome ?? 'ok',
        agent,
        tokens,
        detail: failed?.detail.slice(0, 300),
      });
      this.opts.onAccountUsed?.(account.id);
    }

    yield { type: 'done', response: buildResponse() };
  }

  /**
   * Interrupt the running turn of a persistent session and wait for its
   * `result`, so the next request starts on an idle process. Returns false
   * (the caller then drops the session) when the process does not settle.
   */
  private async interruptTurn(
    live: LiveSession,
    iterator: AsyncIterator<unknown>,
    onUsage: (u: SdkUsage) => void,
    onAssistant: (uuid: string) => void = () => {},
  ): Promise<boolean> {
    try {
      await live.query.interrupt?.();
    } catch {
      return false;
    }
    const settle = (async (): Promise<boolean> => {
      for (;;) {
        const step = await iterator.next();
        if (step.done) return false;
        const m = step.value as SdkMessage;
        if (m.type === 'result') return true;
        if (m.type === 'assistant') {
          const uuid = (m as { uuid?: unknown; error?: unknown }).uuid;
          if (typeof uuid === 'string' && uuid && !(m as { error?: unknown }).error) onAssistant(uuid);
        }
        if (m.type === 'stream_event') {
          const ev = (m as Extract<SdkMessage, { type: 'stream_event' }>).event;
          if (ev.type === 'message_delta') {
            const u = (ev as Extract<SdkStreamEvent, { type: 'message_delta' }>).usage;
            if (u) onUsage(u);
          }
        }
      }
    })().catch(() => false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), INTERRUPT_SETTLE_MS);
    });
    try {
      return await Promise.race([settle, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The host stopped this thread's turn: nothing will feed it for now. A
   * sub-agent's idle process is closed at once instead of after its idle
   * timeout; its record (and the CLI transcript) stay, so the next message to
   * that thread resumes the same session. A top-level conversation keeps its
   * process warm for the user's next message. A request still in flight ends
   * through its own abort.
   */
  async endSession(session: { key?: unknown; task?: unknown }, reason: string): Promise<void> {
    const key = typeof session?.key === 'string' ? session.key : '';
    if (!key || !this.sessions) return;
    const live = this.sessions.getLive(key);
    if (!live || live.busy || session.task !== true) return;
    this.sessions.close(key, reason === 'stopped' ? 'sub-agent stopped' : `thread ended: ${reason}`);
  }

  /** Close every live engine session (plugin deactivation). */
  dispose(): void {
    this.sessions?.dispose();
  }
}

/** The API refused the advisor (`advisor_incompatible`) before anything was produced. */
class AdvisorRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdvisorRefused';
  }
}

/** The persistent session's process went away before producing anything. */
class SessionLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLost';
  }
}

/**
 * A delegated sub-agent ends its task with `task_complete` / `task_blocked`,
 * in any of the call spellings the cutter accepts.
 */
const TASK_END_CALL = /(?:"name"\s*:\s*"|invoke name="|invoke_)task_(?:complete|blocked)\b/;

/** How long an interrupted turn may take to report its `result`. */
const INTERRUPT_SETTLE_MS = 15_000;

/** Native tool calls re-emitted as the `<tool_call>` markup Alfred parses. */
function renderNativeCalls(calls: Array<{ name: string; input?: unknown }>): string {
  return calls
    .map((c) => `\n<tool_call>\n${JSON.stringify({ name: c.name, arguments: coerceNativeArgs(c.input) })}\n</tool_call>`)
    .join('');
}

/**
 * Session and prompt-cache facts of one served request: logged with `stream
 * served`, and sent to the host in `usage` under the `MessageUsage` names
 * (see {@link usageFields}).
 */
export type ProviderSessionInfo = {
  provider: 'claude-code';
  /** Seat that served the request. */
  account: string;
  accountLabel: string;
  /** fresh = new CLI session; resume = new process on the existing session; continue = live process; one-shot = no session. */
  mode: 'fresh' | 'resume' | 'continue' | 'one-shot';
  /** Uncached prompt tokens (after the last cache breakpoint). */
  input: number;
  /** Prompt tokens read from the cache. */
  cacheRead: number;
  /** Prompt tokens written into the cache by this request. */
  cacheWrite: number;
  output: number;
  /** input + cacheRead + cacheWrite: the conversation's size as the model saw it. */
  contextTokens: number;
  /**
   * Set when this request re-wrote most of the conversation into the cache:
   * why (`new conversation`, `prompt cache expired`, `seat switch a -> b`,
   * `new session: <reason>`, `one-shot request`), with the tokens written.
   */
  cold: { reason: string; tokens: number } | null;
  /** When the thread's previous request ran (epoch ms), if known. */
  previousTurnAt: number | null;
  /** When this request finished (epoch ms). */
  at: number;
  /** Prompt-cache lifetime of the seat: the cache is warm until at + cacheTtlMs. */
  cacheTtlMs: number;
};

/** The `MessageUsage` fields the host UI reads for the session and cache state. */
function usageFields(info: ProviderSessionInfo): {
  cacheWriteTokens: number;
  cacheTtlMs: number;
  accountId: string;
  sessionMode: string;
  coldCacheReason?: string;
  servedAt: number;
} {
  return {
    cacheWriteTokens: info.cacheWrite,
    cacheTtlMs: info.cacheTtlMs,
    accountId: info.account,
    sessionMode: info.mode,
    ...(info.cold ? { coldCacheReason: info.cold.reason } : {}),
    servedAt: info.at,
  };
}

/** Prompt size of one API message's usage: input + cache read + cache write. */
function promptTokensOf(u: SdkUsage | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Rough prompt size when nothing was measured: characters of the built prompt. */
export function estimatePromptTokens(built: BuiltPrompt): number {
  let chars = built.systemPrompt.length;
  for (const b of built.content) if (b.type === 'text') chars += b.text.length;
  return Math.round(chars / CHARS_PER_TOKEN) + built.images * 1_500;
}

/** Waits `ms`, or less when `signal` aborts first. Never throws. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Note ahead of a delta that carries assistant messages the session did not write. */
function foreignRepliesNote(count: number): string {
  return (
    `[Host note: ${count === 1 ? 'the Assistant message' : `the ${count} Assistant messages`} below ` +
    'were written outside this session (another agent of the conversation, or a reply served separately). ' +
    'They are part of the conversation: take them into account.]'
  );
}

/**
 * Apply a new effort to a live process (`applyFlagSettings`), so a changed
 * thinking mode does not cost a new process. False when the CLI refused it.
 */
async function applyEffort(live: LiveSession, effort: string | null): Promise<boolean> {
  const apply = (live.query as { applyFlagSettings?: (s: Record<string, unknown>) => Promise<void> }).applyFlagSettings;
  if (typeof apply !== 'function') return false;
  try {
    await apply.call(live.query, { effortLevel: effort });
    live.effort = effort;
    return true;
  } catch {
    return false;
  }
}

/** Why a request is expected to re-write the conversation into the cache, or null. */
function coldReason(o: {
  mode: 'fresh' | 'resume' | 'continue' | 'one-shot';
  planReason: string;
  seatChanged: boolean;
  idleMs: number | undefined;
  ttlMs: number;
  keyed: boolean;
}): string | null {
  if (o.mode === 'one-shot') return o.keyed ? 'one-shot request (whole history re-sent)' : null;
  if (o.mode === 'fresh') return o.planReason === 'new' ? 'new conversation' : `new session: ${o.planReason}`;
  if (o.seatChanged) return 'seat switch';
  if (o.idleMs !== undefined && o.idleMs > o.ttlMs) return 'prompt cache expired';
  return null;
}

/** The facts the host UI shows for a served request (see {@link ProviderSessionInfo}). */
function sessionInfo(o: {
  account: Account;
  mode: ProviderSessionInfo['mode'];
  usage: SdkUsage | undefined;
  expectedCold: string | null;
  previousTurnAt: number | undefined;
  ttlMs: number;
  thread: string | null;
}): ProviderSessionInfo {
  const input = o.usage?.input_tokens ?? 0;
  const cacheRead = o.usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = o.usage?.cache_creation_input_tokens ?? 0;
  const contextTokens = input + cacheRead + cacheWrite;
  // Measured, not guessed: most of the prompt was written, not read. A short
  // prompt (a new conversation's first message) is not worth a warning.
  const rewrote = cacheWrite >= 20_000 && cacheWrite > cacheRead;
  const reason = rewrote ? o.expectedCold ?? 'cache miss' : null;
  return {
    provider: 'claude-code',
    account: o.account.id,
    accountLabel: o.account.label,
    mode: o.mode,
    input,
    cacheRead,
    cacheWrite,
    output: o.usage?.output_tokens ?? 0,
    contextTokens,
    cold: reason ? { reason, tokens: cacheWrite } : null,
    previousTurnAt: o.previousTurnAt ?? null,
    at: Date.now(),
    cacheTtlMs: o.ttlMs,
  };
}

/** An abort the host recognises and closes the turn quietly on. */
function abortError(): Error {
  const err = new Error(`${LABEL} request aborted`);
  err.name = 'AbortError';
  return err;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `opus@seat-3` -> model `opus`, pinned seat `seat-3`. */
export function splitModel(id: string): { model: string; pinned?: string } {
  const at = id.lastIndexOf(ACCOUNT_SEPARATOR);
  if (at <= 0) return { model: id };
  return { model: id.slice(0, at), pinned: id.slice(at + 1) || undefined };
}

function textOf(content: SdkContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text ?? '')
    .join('');
}

/** The volatile tail of Alfred's system prompt, as the CLI frames its own injected context. */
function contextReminder(volatile: string): string {
  return `<system-reminder>\nCurrent context from Alfred (it may change between turns):\n\n${volatile}\n</system-reminder>`;
}

function oneUser(content: SdkInputBlock[]): SdkUserMessage {
  return { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } };
}

async function* oneUserMessage(content: SdkInputBlock[]): AsyncIterable<SdkUserMessage> {
  yield oneUser(content);
}

/**
 * The CLI's moving aliases. Pinning a dated id is possible (the config accepts
 * any string) but an alias is what most users want: it follows the family
 * without a settings edit at every release.
 */
const ALIAS_DISPLAY: Record<string, string> = {
  opus: 'Claude Opus (latest)',
  sonnet: 'Claude Sonnet (latest)',
  haiku: 'Claude Haiku (latest)',
  fable: 'Claude Fable (latest)',
};

/**
 * Shows which real model an alias currently runs: `Claude Opus (latest)` ->
 * `Claude Opus (claude-opus-5-5)`. Learned from served requests, so unknown
 * until an alias has answered once.
 */
export function withServedModel(model: ModelInfo, served: string | undefined): ModelInfo {
  if (!served || served === model.id) return model;
  const base = (model.displayName ?? model.id).replace(/\s*\(latest\)$/, '');
  return { ...model, displayName: `${base} (${served})` };
}

/** Fallback catalog when the config string is empty. Keep in step with the
 *  manifest's `models` default and with {@link ALIAS_DISPLAY}. */
export const DEFAULT_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];

function parseModels(raw: string, contextWindow: number, providerId: string): ModelInfo[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) entries.push(...DEFAULT_MODELS);
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const entry of entries) {
    const [idRaw, displayRaw] = entry.split('|').map((s) => s.trim());
    const id = idRaw;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const displayName = displayRaw || ALIAS_DISPLAY[id.toLowerCase()] || id;
    models.push({
      id,
      providerId,
      displayName,
      // The model's real window (what the CLI reports); the setting only
      // covers an id modelContext.ts does not know. A flat 200k here made the
      // host believe Opus, Sonnet and Fable had a fifth of their 1M window.
      contextWindow: contextWindowOf(id) ?? (contextWindow > 0 ? contextWindow : 200000),
      capabilities: { tools: false, thinking: true, vision: true },
    });
  }
  return models;
}

/** Message parts this provider could not carry, for the caller to report. */
export type DroppedParts = { images: number; attachments: number };

export type BuiltPrompt = {
  systemPrompt: string;
  /** One user message: the labelled transcript, with each turn's images right after its text. */
  content: SdkInputBlock[];
  images: number;
  dropped: DroppedParts;
};

const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Format from the base64 magic bytes; `Message.images` carries no mime type. */
export function sniffImageMime(b64: string): string | null {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR') && Buffer.from(b64.slice(0, 16), 'base64').subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function stripDataUrl(b64: string): string {
  const comma = b64.startsWith('data:') ? b64.indexOf(',') : -1;
  return comma >= 0 ? b64.slice(comma + 1) : b64;
}

/** Image blocks of one message: typed attachments first, else the bare `images` array. */
function imageBlocks(msg: Message, dropped: DroppedParts): SdkImageBlock[] {
  const blocks: SdkImageBlock[] = [];
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const imageAttachments = attachments.filter((a) => a.mimeType?.startsWith('image/'));
  dropped.attachments += attachments.length - imageAttachments.length;
  if (imageAttachments.length > 0) {
    for (const a of imageAttachments) {
      const data = stripDataUrl(a.data ?? '');
      const mime = IMAGE_MIME.has(a.mimeType) ? a.mimeType : sniffImageMime(data);
      if (data && mime) blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
      else dropped.images += 1;
    }
    return blocks;
  }
  for (const raw of msg.images ?? []) {
    const data = stripDataUrl(raw ?? '');
    const mime = sniffImageMime(data);
    if (data && mime) blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
    else dropped.images += 1;
  }
  return blocks;
}

/**
 * Flatten Alfred's message array into one Claude Code user message. System
 * messages become the SDK `systemPrompt`; the rest of the conversation is
 * rendered as a labelled transcript so every prior turn is preserved, with
 * each turn's images inserted as image blocks right after its text.
 *
 * Each message is its own text block. The API caches a prompt prefix up to a
 * block boundary: with the whole transcript in one growing block, the next
 * request never shared a boundary with the previous one and every request
 * re-wrote the entire history into the cache.
 *
 * An assistant turn's `toolCalls` are re-rendered as the same
 * `<tool_call>{…}</tool_call>` markup Alfred's prompt-encoded protocol uses on
 * the way out, so the model sees what it asked for and the tool result that
 * follows refers to something.
 */
export function buildPrompt(messages: Message[]): BuiltPrompt {
  const systemParts: string[] = [];
  const content: SdkInputBlock[] = [];
  const dropped: DroppedParts = { images: 0, attachments: 0 };
  let images = 0;
  for (const msg of messages) {
    const text = msg.content ?? '';
    if (msg.role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    const body = [text, renderToolCalls(msg)].filter((p) => p.length > 0).join('\n');
    content.push({ type: 'text', text: `${roleLabel(msg)}:\n${body}` });
    const blocks = imageBlocks(msg, dropped);
    if (blocks.length > 0) {
      content.push(...blocks);
      images += blocks.length;
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: 'User:\n' });
  return {
    systemPrompt: systemParts.join('\n\n').trim(),
    content,
    images,
    dropped,
  };
}

function renderToolCalls(msg: Message): string {
  if (!msg.toolCalls || msg.toolCalls.length === 0) return '';
  return msg.toolCalls
    .map((tc) =>
      [
        '<tool_call>',
        JSON.stringify({ name: tc.name, arguments: tc.arguments ?? {} }),
        '</tool_call>',
      ].join('\n'),
    )
    .join('\n');
}

function roleLabel(msg: Message): string {
  switch (msg.role) {
    case 'user':
      return 'User';
    case 'assistant':
      return 'Assistant';
    case 'tool':
      return `Tool result${msg.name ? ` (${msg.name})` : ''}`;
    case 'handoff':
    case 'handoff_return':
      return 'Handoff';
    default:
      return 'User';
  }
}

function mapStopReason(reason: string | null | undefined): ChatResponse['finishReason'] {
  if (!reason) return 'stop';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_calls';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
  return 'stop';
}

/**
 * Folds an API usage block into the response usage.
 *
 * With prompt caching, `input_tokens` is only the uncached tail of the prompt
 * (often 2 or 3 tokens); the bulk sits in `cache_read_input_tokens` and
 * `cache_creation_input_tokens`. Reporting `input_tokens` alone made every
 * Claude turn read "2 tokens sent" and left the context meter near zero, so
 * the prompt size is their sum, with the cache split kept alongside.
 */
export function mergeUsage(
  existing: ChatResponse['usage'],
  incoming: SdkUsage,
): ChatResponse['usage'] {
  const base = existing ?? {};
  const read = incoming.cache_read_input_tokens;
  const written = incoming.cache_creation_input_tokens;
  const hasCache = typeof read === 'number' || typeof written === 'number';
  const prompt =
    typeof incoming.input_tokens === 'number' || hasCache
      ? (incoming.input_tokens ?? 0) + (read ?? 0) + (written ?? 0)
      : undefined;
  return {
    ...base,
    inputTokens: prompt ?? base.inputTokens,
    outputTokens: incoming.output_tokens ?? base.outputTokens,
    ...(hasCache && prompt !== undefined
      ? {
          cachedInputTokens: read ?? 0,
          uncachedInputTokens: prompt - (read ?? 0),
          cacheSource: 'request' as const,
        }
      : {}),
  };
}
