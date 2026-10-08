import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  Logger,
  Message,
  ModelInfo,
} from '@alfred/sdk';
// Not an OpenAI-compatible backend — the transport here is a child process, not
// HTTP — but the request-lifetime and no-op-logger halves of the package are
// transport-agnostic, so there is no reason to keep a second copy of them.
import { Deadline, isAbortLike, noopLogger } from '@alfred/provider-openai-compat';
import { THROTTLE_BACKOFF_MS, type Account, type AccountPool, type TokenSample } from './accounts/pool.js';
import { buildChildEnv, type CliInfo } from './accounts/cli.js';
import type { RateLimitInfo } from './accounts/usage.js';
import { ToolCallCutter } from './toolCallCutter.js';

/** Backend label prefixed to every error this provider surfaces. */
const LABEL = 'Claude Code';

/** Separator between a model id and a pinned account id: `opus@seat-3`. */
export const ACCOUNT_SEPARATOR = '@';

export type ClaudeCodeConfig = {
  /** Legacy single setup-token; now only used by the imported default account. */
  oauthToken: string;
  /** Raw `models` config string (comma-separated, optional `id|Display Name`). */
  modelsRaw: string;
  /** Context window reported for every exposed model. */
  contextWindow: number;
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
};

export type ClaudeCodeProviderOptions = {
  config: ClaudeCodeConfig;
  pool: AccountPool;
  cli: CliInfo;
  logger?: Logger;
  /** Called after each attempt on a seat, so the host side can refresh its usage. */
  onAccountUsed?: (accountId: string) => void;
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

  constructor(private readonly opts: ClaudeCodeProviderOptions) {
    this.log = opts.logger ?? noopLogger;
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
      // A request may try several seats before one answers (each refused
      // quickly in practice); give the host room for a couple of full attempts.
      streamFirstChunkTimeoutMs: Math.min(15 * 60_000, timeout * 3),

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
      // Alfred's own prompt-encoded protocol is Qwen-style `<tool_call>` JSON,
      // and that is the only textual protocol this provider's replies can
      // contain — Claude never emits Hermes XML unprompted.
      // Claude also falls back on its own `<invoke name=…>` syntax now and
      // then; declaring it lets the host execute those calls instead of
      // leaving raw markup in the reply.
      textToolCallFormats: ['qwen_json', 'claude_xml'],
    };
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
    const agent = (req as { metadata?: { agentId?: string } }).metadata?.agentId;

    for (;;) {
      if (req.signal?.aborted) throw abortError();
      const pick = this.opts.pool.pick({ model, pinned, exclude: tried });
      if (!pick.account) throw new Error(`${LABEL}: ${pick.reason}`);
      const account = pick.account;
      tried.add(account.id);

      let emitted = false;
      try {
        for await (const chunk of this.attempt(req, model, built, account, agent)) {
          if (chunk.type !== 'done') emitted = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (err instanceof AccountFailure) {
          if (err.switchable && !emitted) {
            this.log.warn('switching Claude account', {
              from: account.id,
              kind: err.kind,
              resetsAt: err.resetsAt ? new Date(err.resetsAt).toISOString() : undefined,
            });
            continue;
          }
          const reset = err.resetsAt ? ` (resets ${new Date(err.resetsAt).toLocaleString()})` : '';
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

  /** One attempt of `req` on one seat. Throws {@link AccountFailure} on seat-level errors. */
  private async *attempt(
    req: ChatRequest,
    model: string,
    built: BuiltPrompt,
    account: Account,
    agent: string | undefined,
  ): AsyncIterable<ChatChunk> {
    const query = await loadQuery();
    const pool = this.opts.pool;

    // The SDK owns the child process, so cancellation has to reach it through
    // its own controller. `Deadline` composes the caller's signal with our
    // time-to-first-chunk budget and detaches from `req.signal` on dispose.
    const controller = new AbortController();
    const deadline = new Deadline(req.signal, this.opts.config.requestTimeoutMs, LABEL);
    const onDeadline = (): void => controller.abort(deadline.signal.reason);
    if (deadline.signal.aborted) controller.abort(deadline.signal.reason);
    else deadline.signal.addEventListener('abort', onDeadline, { once: true });

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
    if (built.systemPrompt) options.systemPrompt = built.systemPrompt;
    if (this.opts.cli.path) options.pathToClaudeCodeExecutable = this.opts.cli.path;
    if (this.opts.cli.native) {
      // The deny list above can't keep up with new CLI tools (PowerShell,
      // Skill, ToolSearch, Monitor...): Opus would call one, the CLI denies it
      // and the single allowed turn ends in error_max_turns with no text.
      // `--tools ""` removes every built-in tool, `--strict-mcp-config` drops
      // user MCP servers, `--disable-slash-commands` drops skills.
      options.extraArgs = { tools: '', 'strict-mcp-config': null, 'disable-slash-commands': null };
      const effort = req.providerOptions?.claudeEffort;
      if (typeof effort === 'string' && /^(low|medium|high|xhigh|max)$/.test(effort)) {
        options.extraArgs.effort = effort;
      }
    }

    this.log.info('stream request', {
      model,
      account: account.id,
      messages: req.messages.length,
      images: built.images,
      // What actually reaches the CLI as `--effort` (absent = CLI default).
      effort: (options.extraArgs as Record<string, unknown> | undefined)?.effort ?? null,
    });

    let assembledContent = '';
    let assembledThinking = '';
    let finishReason: ChatResponse['finishReason'] = 'stop';
    let usage: ChatResponse['usage'];
    let sawStreamedText = false;
    let tokens: TokenSample | undefined;
    let rejectedUntil: number | null = null;
    let sdkError: string | undefined;
    let syntheticText = '';
    let initTools: string[] = [];
    // Real model id behind the requested alias (`opus` -> `claude-opus-5-5`),
    // from the init message first, then from each assistant message.
    let servedModel: string | undefined;
    const toolUses: string[] = [];
    // Native tool calls of the current API message. Parallel calls arrive as
    // one SDK `assistant` message per block (same message id), so they are
    // collected until the message ends (`message_stop`), then re-emitted.
    const nativeCalls: Array<{ name: string; input?: unknown }> = [];
    // Usage of the latest API message, for when the CLI is stopped before
    // its `result` (re-emitted tool calls, cut replies).
    let stepUsage: SdkUsage | undefined;
    // Ends the reply right after its tool call(s) — see toolCallCutter.ts.
    const cutter = new ToolCallCutter();
    let rawText = '';
    let cutAfterToolCall = false;
    // What the pool records for this attempt; unset = served.
    let failed: { outcome: 'error' | 'switched'; detail: string } | null = null;

    const buildResponse = (): ChatResponse => ({
      content: assembledContent.trim(),
      thinking: assembledThinking.trim() || undefined,
      finishReason,
      usage: servedModel ? { ...usage, servedModel } : usage,
    });
    const fail = (detail: string): AccountFailure => {
      const c = classifyFailure(detail, sdkError, rejectedUntil);
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
    try {
      for await (const message of query({ prompt: oneUserMessage(built.content), options })) {
        // Diagnostics for error_max_turns: what the CLI exposed and what the
        // model tried to call.
        const probe = message as { type: string; subtype?: string; tools?: string[]; model?: string; message?: { content?: { type: string; name?: string }[] } };
        if (probe.type === 'system' && probe.subtype === 'init') {
          initTools = probe.tools ?? [];
          if (typeof probe.model === 'string' && probe.model) servedModel = probe.model;
        }
        if (probe.type === 'assistant') {
          for (const b of probe.message?.content ?? []) if (b.type === 'tool_use' && b.name) toolUses.push(b.name);
        }
        if (message.type === 'stream_event') {
          // The SDK's message union ends in a catch-all `{ type: string }`, so
          // a discriminant check does not narrow on its own.
          const { event } = message as Extract<SdkMessage, { type: 'stream_event' }>;
          if (event.type === 'content_block_delta' && 'delta' in event && event.delta) {
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
              stepUsage = md.usage;
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
            syntheticText += textOf(am.message.content);
            continue;
          }
          if (typeof am.message.model === 'string' && am.message.model) servedModel = am.message.model;
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
          const rm = message as Extract<SdkMessage, { type: 'result' }>;
          if (rm.usage) {
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
            });
            const detail =
              syntheticText.trim() || rm.result || rm.errors?.join('; ') || rm.subtype || 'unknown error';
            const failure = fail(detail);
            // Seat-level failures always surface (the caller decides whether to
            // switch). Other errors after streamed content keep the old
            // behaviour: the answer stands.
            if (failure.switchable || !assembledContent) {
              failed = { outcome: failure.switchable && !assembledContent ? 'switched' : 'error', detail };
              throw failure;
            }
          }
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
        try {
          controller.abort();
        } catch {
          // already gone
        }
      } else {
        const rest = cutter.flush();
        if (rest) {
          assembledContent += rest;
          yield { type: 'text', delta: rest };
        }
      }
    } catch (err) {
      if (err instanceof AccountFailure) throw err;
      if (isAbortLike(err) || controller.signal.aborted) {
        // User pressed Stop, or our own time-to-first-chunk budget fired. The
        // host contract requires exactly one `done`. A timeout that produced
        // nothing at all is still a failure, so it is reported as one.
        if (!deadline.userAborted && assembledContent.length === 0) {
          failed = { outcome: 'error', detail: `no output within ${this.opts.config.requestTimeoutMs}ms` };
          throw new Error(
            `${LABEL} produced nothing within ${this.opts.config.requestTimeoutMs}ms on account "${account.label}". ` +
              `Check that the \`claude\` CLI is installed and that account is logged in (Claude accounts page).`,
          );
        }
        yield { type: 'done', response: buildResponse() };
        return;
      }
      // The SDK throws on a non-zero CLI exit; its message carries the reason.
      const detail = (err instanceof Error ? err.message : String(err)) + (syntheticText ? ` ${syntheticText}` : '');
      const failure = fail(detail);
      failed = { outcome: failure.switchable && !assembledContent ? 'switched' : 'error', detail };
      if (failure.switchable) throw failure;
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      // Also runs when the consumer breaks out of the loop early, which is what
      // detaches our listener from the host's long-lived abort signal.
      deadline.dispose();
      if (!tokens && stepUsage) {
        // Stopped before the `result` (which carries the totals): the last
        // API message's usage is the best record of what this cost.
        tokens = {
          input: stepUsage.input_tokens ?? 0,
          output: stepUsage.output_tokens ?? 0,
          cacheRead: stepUsage.cache_read_input_tokens ?? 0,
          cacheWrite: stepUsage.cache_creation_input_tokens ?? 0,
          costUsd: 0,
        };
      }
      if (!failed) this.log.info('stream served', { model, servedModel, account: account.id });
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
}

/** Native tool calls re-emitted as the `<tool_call>` markup Alfred parses. */
function renderNativeCalls(calls: Array<{ name: string; input?: unknown }>): string {
  return calls
    .map((c) => `\n<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.input ?? {} })}\n</tool_call>`)
    .join('');
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

async function* oneUserMessage(content: SdkInputBlock[]): AsyncIterable<SdkUserMessage> {
  yield {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  };
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
      contextWindow: contextWindow > 0 ? contextWindow : 200000,
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
 * An assistant turn's `toolCalls` are re-rendered as the same
 * `<tool_call>{…}</tool_call>` markup Alfred's prompt-encoded protocol uses on
 * the way out, so the model sees what it asked for and the tool result that
 * follows refers to something.
 */
export function buildPrompt(messages: Message[]): BuiltPrompt {
  const systemParts: string[] = [];
  const content: SdkInputBlock[] = [];
  const dropped: DroppedParts = { images: 0, attachments: 0 };
  let pendingText: string[] = [];
  let images = 0;
  const flush = (): void => {
    if (pendingText.length === 0) return;
    content.push({ type: 'text', text: pendingText.join('\n\n') });
    pendingText = [];
  };
  for (const msg of messages) {
    const text = msg.content ?? '';
    if (msg.role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    const body = [text, renderToolCalls(msg)].filter((p) => p.length > 0).join('\n');
    pendingText.push(`${roleLabel(msg)}:\n${body}`);
    const blocks = imageBlocks(msg, dropped);
    if (blocks.length > 0) {
      flush();
      content.push(...blocks);
      images += blocks.length;
    }
  }
  flush();
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
