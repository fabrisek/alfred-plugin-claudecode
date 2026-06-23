import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  Logger,
  Message,
  ModelInfo,
} from '@alfred/sdk';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export type ClaudeCodeConfig = {
  /** Long-lived subscription token from `claude setup-token`. Empty = reuse interactive login. */
  oauthToken: string;
  /** Raw `models` config string (comma-separated, optional `id|Display Name`). */
  modelsRaw: string;
  /** Context window reported for every exposed model. */
  contextWindow: number;
  /** Optional absolute path to the `claude` binary. Empty = SDK default / PATH. */
  pathToClaude: string;
};

export type ClaudeCodeProviderOptions = {
  config: ClaudeCodeConfig;
  logger?: Logger;
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

type SdkUsage = { input_tokens?: number; output_tokens?: number };

type SdkContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: string };

type SdkMessage =
  | { type: 'stream_event'; event: SdkStreamEvent }
  | { type: 'assistant'; message: { content: SdkContentBlock[]; stop_reason?: string | null } }
  | {
      type: 'result';
      subtype?: string;
      result?: string;
      is_error?: boolean;
      usage?: SdkUsage;
      total_cost_usd?: number;
    }
  | { type: string };

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  opts: unknown,
) => Promise<{ behavior: 'deny'; message: string }>;

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
];

const denyAllTools: CanUseTool = async (toolName) => ({
  behavior: 'deny',
  message: `Tool "${toolName}" is disabled — this provider runs in text-only completion mode.`,
});

type QueryFn = (args: {
  prompt: string;
  options?: QueryOptions;
}) => AsyncIterable<SdkMessage>;

let cachedQuery: QueryFn | null = null;

async function loadQuery(): Promise<QueryFn> {
  if (cachedQuery) return cachedQuery;
  const mod = (await import('@anthropic-ai/claude-agent-sdk')) as { query: QueryFn };
  cachedQuery = mod.query;
  return cachedQuery;
}

export class ClaudeCodeProvider implements LLMProvider {
  readonly id = 'claude-code';
  readonly displayName = 'Claude (subscription)';
  readonly kind = 'remote' as const;
  // tools:false on purpose — Claude Code in headless completion mode does not
  // round-trip Alfred's custom tools as native function calls. Declaring
  // tools:false makes Alfred fall back to its prompt-encoded toolset, so the
  // full Alfred tool ecosystem still works through this provider.
  readonly capabilities = {
    tools: false,
    thinking: true,
    vision: false,
    streaming: true,
    modelManagement: false,
  };

  private readonly log: Logger;

  constructor(private readonly opts: ClaudeCodeProviderOptions) {
    this.log = opts.logger ?? noopLogger;
  }

  getRuntimeConfig(): Record<string, unknown> {
    return {
      models: this.opts.config.modelsRaw,
      contextWindow: this.opts.config.contextWindow,
      auth: this.opts.config.oauthToken ? 'setup-token' : 'interactive-login',
      pathToClaude: this.opts.config.pathToClaude || '(default)',
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return parseModels(this.opts.config.modelsRaw, this.opts.config.contextWindow, this.id);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    let response: ChatResponse | undefined;
    for await (const chunk of this.stream(req)) {
      if (chunk.type === 'done') response = chunk.response;
    }
    return (
      response ?? { content: '', finishReason: 'stop' }
    );
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const query = await loadQuery();
    const { systemPrompt, prompt } = buildPrompt(req.messages);

    const controller = new AbortController();
    if (req.signal) {
      if (req.signal.aborted) return;
      req.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const options: QueryOptions = {
      model: req.model,
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
      env: this.buildEnv(),
      abortController: controller,
    };
    if (systemPrompt) options.systemPrompt = systemPrompt;
    if (this.opts.config.pathToClaude) {
      options.pathToClaudeCodeExecutable = this.opts.config.pathToClaude;
    }

    this.log.info('stream request', {
      model: req.model,
      messages: req.messages.length,
      auth: this.opts.config.oauthToken ? 'setup-token' : 'interactive-login',
    });

    let assembledContent = '';
    let assembledThinking = '';
    let finishReason: ChatResponse['finishReason'] = 'stop';
    let usage: ChatResponse['usage'];
    let sawStreamedText = false;

    try {
      for await (const message of query({ prompt, options })) {
        if (message.type === 'stream_event') {
          const event = message.event;
          if (event.type === 'content_block_delta' && 'delta' in event && event.delta) {
            const delta = event.delta as SdkContentDelta;
            if (delta.type === 'text_delta') {
              const text = (delta as SdkTextDelta).text ?? '';
              if (text) {
                assembledContent += text;
                sawStreamedText = true;
                yield { type: 'text', delta: text };
              }
            } else if (delta.type === 'thinking_delta') {
              const thinking = (delta as SdkThinkingDelta).thinking ?? '';
              if (thinking) {
                assembledThinking += thinking;
                yield { type: 'thinking', delta: thinking };
              }
            }
          } else if (event.type === 'message_delta') {
            const md = event as Extract<SdkStreamEvent, { type: 'message_delta' }>;
            if (md.delta?.stop_reason) finishReason = mapStopReason(md.delta.stop_reason);
            if (md.usage) usage = mergeUsage(usage, md.usage);
          }
        } else if (message.type === 'assistant') {
          // Fallback: if partial streaming yielded nothing, reconstruct from the
          // complete assistant message.
          if (!sawStreamedText) {
            const am = message as Extract<SdkMessage, { type: 'assistant' }>;
            for (const block of am.message.content ?? []) {
              if (block.type === 'text') {
                const text = (block as { text: string }).text ?? '';
                if (text) {
                  assembledContent += text;
                  yield { type: 'text', delta: text };
                }
              } else if (block.type === 'thinking') {
                assembledThinking += (block as { thinking: string }).thinking ?? '';
              }
            }
            if (am.message.stop_reason) finishReason = mapStopReason(am.message.stop_reason);
          }
        } else if (message.type === 'result') {
          const rm = message as Extract<SdkMessage, { type: 'result' }>;
          if (rm.usage) usage = mergeUsage(usage, rm.usage);
          if (rm.is_error || rm.subtype === 'error_max_turns' || rm.subtype === 'error_during_execution') {
            const detail = rm.result || rm.subtype || 'unknown error';
            // No content streamed and the run errored — surface it. The most
            // common cause is "not logged in": run `claude` (or `claude
            // setup-token`) once so the subscription credentials exist.
            if (!assembledContent) {
              throw new Error(
                `Claude Code returned an error: ${detail}. ` +
                  `If this is an auth failure, log in with the Claude CLI (interactive ` +
                  `\`claude\` or \`claude setup-token\`) using your subscription account.`,
              );
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || controller.signal.aborted) return;
      throw err instanceof Error ? err : new Error(String(err));
    }

    const response: ChatResponse = {
      content: assembledContent.trim(),
      thinking: assembledThinking.trim() || undefined,
      finishReason,
      usage,
    };
    yield { type: 'done', response };
  }

  /**
   * Build the child-process environment so inference uses the SUBSCRIPTION,
   * never the API. We strip every API-key-style variable that would otherwise
   * take precedence over OAuth/subscription credentials, and inject the
   * setup-token when the user provided one.
   */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      env[key] = value;
    }
    // These override subscription auth — remove them so the CLI falls back to
    // the setup-token / interactive-login subscription credentials.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    if (this.opts.config.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = this.opts.config.oauthToken;
    }
    return env;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALIAS_DISPLAY: Record<string, string> = {
  opus: 'Claude Opus (latest)',
  sonnet: 'Claude Sonnet (latest)',
  haiku: 'Claude Haiku (latest)',
};

function parseModels(raw: string, contextWindow: number, providerId: string): ModelInfo[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) entries.push('opus', 'sonnet', 'haiku');
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
      capabilities: { tools: false, thinking: true, vision: false },
    });
  }
  return models;
}

/**
 * Flatten Alfred's message array into a single Claude Code prompt. System
 * messages are concatenated into the SDK `systemPrompt`; the remaining
 * conversation is rendered as a labeled transcript so prior turns (and the
 * prompt-encoded tool calls/results Alfred injects) are preserved.
 */
function buildPrompt(messages: Message[]): { systemPrompt: string; prompt: string } {
  const systemParts: string[] = [];
  const convoParts: string[] = [];
  for (const msg of messages) {
    const content = msg.content ?? '';
    if (msg.role === 'system') {
      if (content) systemParts.push(content);
      continue;
    }
    convoParts.push(`${roleLabel(msg)}:\n${content}`);
  }
  return {
    systemPrompt: systemParts.join('\n\n').trim(),
    prompt: convoParts.join('\n\n').trim(),
  };
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

function mergeUsage(
  existing: ChatResponse['usage'],
  incoming: SdkUsage,
): ChatResponse['usage'] {
  const base = existing ?? {};
  return {
    ...base,
    inputTokens: incoming.input_tokens ?? base.inputTokens,
    outputTokens: incoming.output_tokens ?? base.outputTokens,
  };
}
