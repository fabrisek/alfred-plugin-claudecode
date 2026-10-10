/**
 * Interrupt-marker notes: what the model is told about the CLI's
 * "[Request interrupted by user]" entries and about lost processes.
 *
 * The provider ends every reply right after its tool call by interrupting the
 * CLI turn (see ClaudeCodeProvider.interruptTurn). The CLI records that, and
 * every other interrupt (a Stop, the host ending a turn), as a user entry,
 * "[Request interrupted by user]", in the persistent session. Read bare, it
 * tells the model that the user stopped it, and agents then abandon their
 * task. Every path that leaves such a marker in what the model reads next gets
 * a note here:
 *
 * - `continue` (same live process): the marker sits right before the new
 *   content. A host cut and a Stop each get their own note.
 * - `resume` (new process, `--resume`): the transcript is truncated at the
 *   last kept reply (`resumeSessionAt`), which drops the marker. Without a
 *   known reply uuid it is not truncated, so the note is sent as on a
 *   `continue`.
 * - Sessions that predate these notes hold bare markers: the first request
 *   that continues or resumes one explains them all, once.
 * - A process that died (crash, kill, reload cap) loses its session; the next
 *   one starts fresh and is told the previous process ended unexpectedly.
 *
 * Chosen over a respawn + `resumeSessionAt` after every tool call: that would
 * launch a new CLI process (startup + transcript load) for every tool step of
 * every agent, for a marker a one-line note neutralises.
 */

import type { EngineSessionRecord } from './engineSessions.js';

/** Prepended to the next delta after a host cut. */
export const HOST_CUT_NOTE =
  '[Host note: the "[Request interrupted by user]" entry above was written by the host, ' +
  'which ends each reply right after its tool call. The user did not interrupt you. ' +
  'The tool result follows: continue the task.]';

/** Prepended to the next delta after a reply stopped before it finished. */
export const STOP_NOTE =
  '[Host note: the "[Request interrupted by user]" entry above marks a reply stopped before it finished ' +
  '(a Stop, or the host ending that turn). It does not cancel your task: follow the latest message below.]';

/** Sent once to a session that may hold markers from before these notes existed. */
export const LEGACY_MARKERS_NOTE =
  '[Host note: earlier "[Request interrupted by user]" entries in this conversation were written by the host, ' +
  'which ends each reply right after its tool call. They never meant that the user stopped you or cancelled ' +
  'your task; only a user message can do that.]';

/** First content of the session that replaces one whose process died. */
export function lostProcessNote(reason: string): string {
  const why = reason.replace(/\s+/g, ' ').trim().slice(0, 160);
  return (
    `[Host note: the previous Claude Code process ended unexpectedly${why ? ` (${why})` : ''} ` +
    'before it finished its reply. The user did not stop you. The conversation so far follows: continue the task.]'
  );
}

/** Session modes as the provider names them. */
export type SessionMode = 'one-shot' | 'fresh' | 'continue' | 'resume';

export type MarkerNoteRecord = Pick<
  EngineSessionRecord,
  'sessionId' | 'hostCutTail' | 'interruptedTail' | 'lastUuid' | 'markersExplained' | 'lostReason'
>;

/**
 * The notes to put ahead of this request's content, in order.
 * `record` is the session being continued or resumed; `previous` is what was
 * on disk for this conversation before the request (a lost-process tombstone
 * when the last process died).
 */
export function markerNotes(
  mode: SessionMode,
  record: MarkerNoteRecord | undefined,
  previous?: MarkerNoteRecord,
): string[] {
  const notes: string[] = [];
  if (mode === 'fresh' || mode === 'one-shot') {
    if (previous?.lostReason) notes.push(lostProcessNote(previous.lostReason));
    return notes;
  }
  if (!record) return notes;
  if (!record.markersExplained) notes.push(LEGACY_MARKERS_NOTE);
  // A resume truncated at the last kept reply no longer holds the marker.
  const markerKept = mode === 'continue' || !record.lastUuid;
  if (markerKept) {
    if (record.hostCutTail) notes.push(HOST_CUT_NOTE);
    else if (record.interruptedTail) notes.push(STOP_NOTE);
  }
  return notes;
}

/** Backwards-compatible single note (host cut on a live process only). */
export function hostCutNote(
  mode: SessionMode,
  record: Pick<EngineSessionRecord, 'hostCutTail'> | undefined,
): string | null {
  return mode === 'continue' && record?.hostCutTail ? HOST_CUT_NOTE : null;
}
