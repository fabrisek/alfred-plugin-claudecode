/**
 * Claude Code's server-side advisor (`advisorModel` setting) on every CLI this
 * plugin starts: engine turns, CLI-mode turns, sub-agents, claude_code_run.
 *
 * Passed as a flag setting (`--settings {"advisorModel": …}`), not as the
 * `--advisor` flag: the flag makes a headless CLI exit when the seat may not
 * use that advisor, the setting only makes it send its requests without one.
 * So a seat that refuses it (Fable as advisor bills to usage credits, which
 * the seat must have and have consented to) keeps serving, advisor-less.
 *
 * What a seat really does is read from the CLI itself (`get_settings` →
 * `applied.advisor`, no model call) at each launch, logged when it changes
 * and shown in the panel. An API refusal of the pair (`advisor_incompatible`)
 * takes the advisor off that seat for a while; the request is replayed there
 * without it, never moved to another seat for that.
 *
 * Scope (`advisorScope`): an advisor call re-reads the whole context with no
 * cache, so by default (`main`) only the conversations the user talks to get
 * it: not delegated sub-agents (`par-*` conversations, delegation threads),
 * not one-off calls without a thread, not claude_code_run. `all` = every CLI,
 * `off` = none. The class of a thread derives from its conversation id and
 * thread key only, so a session keeps the same advisor setting all its life.
 *
 * A seat that refuses the advisor gets the setting anyway: each new CLI
 * process asks the API again, so a seat whose usage credits were enabled and
 * accepted since starts using it without a reload.
 *
 * Cache: the advisor adds a tool and a system-prompt section, so turning it on
 * or off in an existing session (resume, seat switch between a seat that has
 * it and one that does not, a seat that just got it) rewrites that session's
 * cached prefix once. Steady state caches as before.
 */

import type { Logger } from '@alfred/sdk';

export const ADVISOR_SCOPES = ['main', 'all', 'off'] as const;
export type AdvisorScope = (typeof ADVISOR_SCOPES)[number];

/**
 * Kind of CLI being started: `main` = a conversation the user talks to,
 * `sub` = a delegated sub-agent or a one-off call, `run` = claude_code_run.
 */
export type AdvisorThread = 'main' | 'sub' | 'run';

export function isAdvisorScope(v: unknown): v is AdvisorScope {
  return typeof v === 'string' && (ADVISOR_SCOPES as readonly string[]).includes(v);
}

/** Sub-conversations of a delegation (`par-<task>-<ts>`, core ParallelDelegation). */
const DELEGATION_CONVERSATION = /^par-/;

/** A CLI-mode turn: its conversation is the user's, or a delegation's. */
export function cliThread(conversationId: string | undefined): AdvisorThread {
  return conversationId && !DELEGATION_CONVERSATION.test(conversationId) ? 'main' : 'sub';
}

/**
 * An engine request: its thread key is `<conversation>|<agent>|<task>`
 * (core TurnLoop); no key = a one-off call, `task` or a task part = a
 * delegated sub-agent.
 */
export function engineThread(req: { session?: { key?: unknown; task?: unknown } }): AdvisorThread {
  const key = req.session?.key;
  if (typeof key !== 'string' || !key || req.session?.task === true) return 'sub';
  const [conversation, , task] = key.split('|');
  if (task) return 'sub';
  return cliThread(conversation);
}

export type AdvisorSeatView = {
  /** active = the CLI sends the advisor; unavailable = the seat refuses it; incompatible = the API refused it. */
  state: 'active' | 'unavailable' | 'incompatible';
  /** Model id the CLI sends as the advisor (`claude-fable-5-1`). */
  model?: string;
  reason?: string;
  at: number;
};

/** After an `advisor_incompatible` refusal, the seat runs without the advisor this long. */
export const INCOMPATIBLE_PAUSE_MS = 60 * 60_000;
/** A `get_settings` answer slower than this is ignored (the state stays as it was). */
const OBSERVE_TIMEOUT_MS = 20_000;

/** The CLI's answer when the API refuses the advisor for the request's model. */
const REFUSAL_RE = /advisor model is not compatible|advisor_incompatible|cannot be used as an advisor|does not support the advisor/i;

export function isAdvisorRefusal(detail: string | undefined, apiError?: unknown): boolean {
  return apiError === 'advisor_incompatible' || REFUSAL_RE.test(detail ?? '');
}

/** Why a seat may not use `model` as its advisor, in the user's terms. */
function refusalReason(model: string): string {
  return /fable/i.test(model)
    ? 'Fable as the advisor bills to usage credits: they must be enabled for this seat\'s organization, then accepted once on the seat (`claude` with this seat\'s config dir, `/model fable`)'
    : `the CLI does not enable "${model}" as the advisor on this seat`;
}

type SettingsReader = { getSettings?: () => Promise<unknown> };

export class AdvisorPolicy {
  private readonly seats = new Map<string, AdvisorSeatView>();
  private readonly pausedUntil = new Map<string, number>();

  constructor(
    /** Advisor model (alias or id); empty = off. */
    readonly model: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    /** Which CLIs get it (see the file header). */
    readonly scope: AdvisorScope = 'main',
  ) {}

  get enabled(): boolean {
    return this.model !== '' && this.scope !== 'off';
  }

  /** Whether this kind of CLI gets the advisor at all, whatever the seat. */
  covers(thread: AdvisorThread): boolean {
    return this.enabled && (this.scope === 'all' || thread === 'main');
  }

  /**
   * Flag settings for a CLI of this kind on this seat, or none (advisor off,
   * out of scope, or paused on the seat after an API refusal).
   */
  settingsFor(accountId: string, thread: AdvisorThread): { advisorModel: string } | undefined {
    if (!this.covers(thread)) return undefined;
    const until = this.pausedUntil.get(accountId);
    if (until !== undefined) {
      if (until > this.now()) return undefined;
      this.pausedUntil.delete(accountId);
    }
    return { advisorModel: this.model };
  }

  /**
   * Reads the advisor the CLI applied (`get_settings`) and records it for the
   * seat. Fire and forget: never throws, never delays the turn.
   */
  observe(accountId: string, query: unknown, launched: { advisorModel: string } | undefined): void {
    if (!launched) return;
    const reader = query as SettingsReader;
    if (typeof reader?.getSettings !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), OBSERVE_TIMEOUT_MS);
      timer.unref?.();
    });
    void Promise.race([reader.getSettings(), timeout])
      .then((s) => {
        const applied = (s as { applied?: { advisor?: unknown } } | undefined)?.applied;
        if (!applied || !('advisor' in applied)) return;
        const model = typeof applied.advisor === 'string' && applied.advisor ? applied.advisor : undefined;
        this.record(accountId, model ? { state: 'active', model } : { state: 'unavailable', reason: refusalReason(launched.advisorModel) });
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }

  /** The API refused the advisor on this seat: its next launches go without it for a while. */
  markIncompatible(accountId: string, detail: string): void {
    this.pausedUntil.set(accountId, this.now() + INCOMPATIBLE_PAUSE_MS);
    this.record(accountId, { state: 'incompatible', reason: detail.slice(0, 300) });
  }

  view(accountId: string): AdvisorSeatView | null {
    return this.seats.get(accountId) ?? null;
  }

  private record(accountId: string, next: Omit<AdvisorSeatView, 'at'>): void {
    const prev = this.seats.get(accountId);
    this.seats.set(accountId, { ...next, at: this.now() });
    if (prev && prev.state === next.state && prev.model === next.model) return;
    if (next.state === 'active') {
      this.log.info('advisor active on seat', { account: accountId, advisor: next.model });
    } else if (next.state === 'unavailable') {
      this.log.warn('advisor not available on seat; its conversations continue without it', {
        account: accountId,
        advisor: this.model,
        reason: next.reason,
      });
    } else {
      this.log.warn('advisor refused by the API on seat; retrying without it there', {
        account: accountId,
        advisor: this.model,
        pausedForMin: Math.round(INCOMPATIBLE_PAUSE_MS / 60_000),
        detail: next.reason,
      });
    }
  }
}
