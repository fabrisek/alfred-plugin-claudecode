/**
 * Alfred's tools as native tools of the CLI, executed by the host.
 *
 * Engine mode used to carry Alfred's tools as a text protocol: the model wrote
 * `<tool_call>{…}</tool_call>`, the provider ended the reply there by
 * interrupting the CLI turn, and the next request brought the result. Every
 * tool call left the CLI's "[Request interrupted by user]" marker in the
 * session plus a host note explaining it (hostCutNote.ts): about three
 * transcript entries per call instead of two, and a model told it was
 * interrupted hundreds of times per conversation (measured: 2.96 messages per
 * call on a 273-call session).
 *
 * Here the tools are an in-process MCP server of the SDK (`type: 'sdk'`).
 * The model calls `mcp__alfred__<tool>` natively; the CLI calls the server's
 * handler, which does NOT run the tool: it waits. The provider hands the call
 * to the host as an ordinary `toolCalls` answer, the host runs it in its own
 * turn loop (permissions, UI, events, exactly as for any provider), and its
 * next request brings the result, which resolves the waiting handler. The
 * CLI then goes on with the same turn: no interrupt, no marker, no note.
 *
 * The CLI runs a reply's calls one after the other (a handler is called only
 * once the previous one returned), while the host runs them all before its
 * next request. A result that arrives before its handler is called is kept
 * until the CLI asks for it; handlers find their call by the tool_use id the
 * CLI puts in `_meta` (`claudecode/toolUseId`).
 */

import { createHash } from 'node:crypto';
import type { Message, ToolSchema } from '@alfred/sdk';

/** MCP server name: the model sees `mcp__alfred__<tool>`. */
export const HOST_SERVER = 'alfred';
export const HOST_TOOL_PREFIX = `mcp__${HOST_SERVER}__`;
/** Where the CLI puts the tool_use id of a call in `tools/call` (`params._meta`). */
const TOOL_USE_ID_META = 'claudecode/toolUseId';
/** How long a tool-list change waits for the CLI to read the new list. */
const LIST_REFRESH_MS = 5_000;

type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };
export type HostToolResult = { content: Array<TextContent | ImageContent>; isError?: boolean };

type McpServerLike = {
  server: {
    setRequestHandler(schema: unknown, handler: (request: never, extra?: unknown) => unknown): void;
    sendToolListChanged(): Promise<void> | void;
  };
};
type McpModules = {
  McpServer: new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }) => McpServerLike;
  ListToolsRequestSchema: unknown;
  CallToolRequestSchema: unknown;
};

let mcpModules: Promise<McpModules> | null = null;
/** The MCP SDK, loaded on first use (like the Agent SDK itself). */
export function loadMcp(): Promise<McpModules> {
  mcpModules ??= Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]).then(([server, types]) => ({
    McpServer: (server as unknown as McpModules).McpServer,
    ListToolsRequestSchema: (types as unknown as McpModules).ListToolsRequestSchema,
    CallToolRequestSchema: (types as unknown as McpModules).CallToolRequestSchema,
  }));
  return mcpModules;
}

/** Stable key of a tool set: a process serves the set it announced to the CLI. */
export function toolsKey(tools: readonly ToolSchema[]): string {
  const h = createHash('sha1');
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`${t.name}\0${t.description}\0${JSON.stringify(t.parameters ?? {})}\0`);
  }
  return h.digest('hex').slice(0, 16);
}

/** MCP tool names are `[A-Za-z0-9_-]{1,64}`; Alfred's ids almost always are already. */
function mcpNameOf(name: string, taken: Set<string>): string {
  let base = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const n = `${base.slice(0, 60)}_${i}`;
    if (!taken.has(n)) return n;
  }
}

export type HostCall = { id: string; name: string; arguments: Record<string, unknown> };

/** One process's tool server and the calls in flight between the CLI and the host. */
export class HostToolBridge {
  private tools: ToolSchema[] = [];
  private key = '';
  private readonly toAlfred = new Map<string, string>();
  private readonly toMcp = new Map<string, string>();
  /** Handlers the CLI called, waiting for the host's result, by tool_use id. */
  private readonly waiting = new Map<string, (r: HostToolResult) => void>();
  /** Results that arrived before the CLI called their handler. */
  private readonly ready = new Map<string, HostToolResult>();
  /** Calls handed to the host and not answered yet (tool_use ids). */
  readonly awaiting = new Set<string>();
  private listWaiters: Array<() => void> = [];
  private instance: McpServerLike | null = null;

  constructor(tools: readonly ToolSchema[]) {
    this.setTools(tools);
  }

  get toolsKey(): string {
    return this.key;
  }

  /** Replace the tool set; true when it changed. */
  setTools(tools: readonly ToolSchema[]): boolean {
    const key = toolsKey(tools);
    if (key === this.key) return false;
    this.key = key;
    this.tools = [...tools];
    this.toAlfred.clear();
    this.toMcp.clear();
    const taken = new Set<string>();
    for (const t of this.tools) {
      const n = mcpNameOf(t.name, taken);
      taken.add(n);
      this.toAlfred.set(n, t.name);
      this.toMcp.set(t.name, n);
    }
    return true;
  }

  /** Alfred's name of a tool the model called (`mcp__alfred__x`), or null for any other tool. */
  alfredName(qualified: string): string | null {
    if (!qualified.startsWith(HOST_TOOL_PREFIX)) return null;
    const mcp = qualified.slice(HOST_TOOL_PREFIX.length);
    return this.toAlfred.get(mcp) ?? null;
  }

  /** The SDK server config for `options.mcpServers` (one instance per process). */
  async serverConfig(): Promise<{ type: 'sdk'; name: string; instance: unknown }> {
    if (!this.instance) {
      const { McpServer, ListToolsRequestSchema, CallToolRequestSchema } = await loadMcp();
      const mcp = new McpServer({ name: HOST_SERVER, version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
      mcp.server.setRequestHandler(ListToolsRequestSchema, () => this.listTools());
      mcp.server.setRequestHandler(CallToolRequestSchema, (request: never) => {
        const params = (request as { params?: { name?: string; _meta?: Record<string, unknown> } }).params ?? {};
        const id = params._meta?.[TOOL_USE_ID_META];
        return this.handle(typeof id === 'string' ? id : '', String(params.name ?? ''));
      });
      this.instance = mcp;
    }
    return { type: 'sdk', name: HOST_SERVER, instance: this.instance };
  }

  /** `tools/list`: Alfred's schemas, as is. */
  listTools(): { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } {
    const waiters = this.listWaiters;
    this.listWaiters = [];
    for (const w of waiters) w();
    return {
      tools: this.tools.map((t) => ({
        name: this.toMcp.get(t.name) ?? t.name,
        description: t.description,
        inputSchema: { type: 'object', ...(t.parameters ?? {}) },
      })),
    };
  }

  /**
   * Tell the CLI the tool set changed and wait until it has read the new one
   * (seen: a call resolved before the re-read is answered with the old set).
   */
  async announceChange(timeoutMs = LIST_REFRESH_MS): Promise<boolean> {
    if (!this.instance) return false;
    const read = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      this.listWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    try {
      await this.instance.server.sendToolListChanged();
    } catch {
      return false;
    }
    return read;
  }

  /** `tools/call` from the CLI: wait for the host's result of that call. */
  handle(id: string, mcpName: string): Promise<HostToolResult> {
    const early = this.ready.get(id);
    if (early) {
      this.ready.delete(id);
      return Promise.resolve(early);
    }
    if (!id) {
      return Promise.resolve(errorResult(`Call of "${mcpName}" carried no tool_use id; the host cannot match its result.`));
    }
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
    });
  }

  /** Calls handed to the host: their results are expected next. */
  expect(calls: readonly HostCall[]): void {
    for (const c of calls) this.awaiting.add(c.id);
  }

  /** The host's result of one call: to the waiting handler, or kept for it. */
  deliver(id: string, result: HostToolResult): void {
    this.awaiting.delete(id);
    const w = this.waiting.get(id);
    if (w) {
      this.waiting.delete(id);
      w(result);
    } else {
      this.ready.set(id, result);
    }
  }

  /** Answer every call still open with an error (the host moved on without them). */
  cancel(reason: string): void {
    for (const id of [...this.awaiting]) this.deliver(id, errorResult(reason));
    for (const [id, w] of [...this.waiting]) {
      this.waiting.delete(id);
      w(errorResult(reason));
    }
  }

  /** Something is still open between the CLI and the host. */
  get pending(): boolean {
    return this.awaiting.size > 0 || this.waiting.size > 0;
  }
}

export function errorResult(text: string): HostToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * A host `tool` message as an MCP result: its text, its images, and the
 * failure flag the host set. `extra` (content that arrived with the results:
 * a user message, a context update) is appended as text so the model reads
 * it in the same step.
 */
export function toolResultOf(
  msg: Message,
  images: Array<{ data: string; mimeType: string }>,
  extra: string[] = [],
): HostToolResult {
  const content: Array<TextContent | ImageContent> = [{ type: 'text', text: msg.content || '(no output)' }];
  for (const img of images) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
  for (const text of extra) content.push({ type: 'text', text });
  return msg.toolOk === false ? { content, isError: true } : { content };
}
