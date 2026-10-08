/**
 * The provider with its agent-session facet (CLI agent mode). A subclass, not
 * extra methods on {@link ClaudeCodeProvider}: the host detects the facet
 * structurally, so in `completion` chat mode the plain class is registered
 * and nothing about the facet exists.
 */

import type {
  AgentSessionCapabilities,
  AgentSessionProvider,
  SendSessionInputResult,
  SessionEvent,
  SessionInput,
  SessionTurnRequest,
} from '@alfred/sdk';
import { ClaudeCodeProvider, type ClaudeCodeProviderOptions } from '../ClaudeCodeProvider.js';
import type { ClaudeSessionAdapter } from './ClaudeSessionAdapter.js';

/** Host budget between two session events; the adapter heartbeats every 15 s. */
export const SESSION_IDLE_TIMEOUT_MS = 90_000;

export class ClaudeCodeSessionProvider extends ClaudeCodeProvider implements AgentSessionProvider {
  readonly agentSession: AgentSessionCapabilities;

  constructor(
    opts: ClaudeCodeProviderOptions,
    private readonly adapter: ClaudeSessionAdapter,
    capabilities: AgentSessionCapabilities,
  ) {
    super(opts);
    this.agentSession = capabilities;
  }

  override getRuntimeConfig(): Record<string, unknown> {
    return { ...super.getRuntimeConfig(), sessionIdleTimeoutMs: SESSION_IDLE_TIMEOUT_MS };
  }

  runSessionTurn(req: SessionTurnRequest): AsyncIterable<SessionEvent> {
    return this.adapter.runSessionTurn(req);
  }

  sendSessionInput(turnId: string, input: SessionInput): Promise<SendSessionInputResult> {
    return this.adapter.sendSessionInput(turnId, input);
  }

  interruptSessionTurn(turnId: string): Promise<void> {
    return this.adapter.interruptSessionTurn(turnId);
  }
}
