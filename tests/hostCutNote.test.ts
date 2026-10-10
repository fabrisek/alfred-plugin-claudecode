// Run: npm test. Which note the model gets ahead of a request, per session
// mode and record state (src/hostCutNote.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_CUT_NOTE,
  LEGACY_MARKERS_NOTE,
  STOP_NOTE,
  lostProcessNote,
  markerNotes,
  type MarkerNoteRecord,
} from '../src/hostCutNote.js';

const rec = (over: Partial<MarkerNoteRecord> = {}): MarkerNoteRecord => ({
  sessionId: 's',
  lastUuid: 'u',
  markersExplained: true,
  ...over,
});

describe('interrupt-marker notes', () => {
  it('explains a host cut and a stop on a live process', () => {
    assert.deepEqual(markerNotes('continue', rec({ hostCutTail: true })), [HOST_CUT_NOTE]);
    assert.deepEqual(markerNotes('continue', rec({ interruptedTail: true })), [STOP_NOTE]);
    assert.deepEqual(markerNotes('continue', rec()), []);
  });

  it('says nothing on a resume truncated at the last reply, explains one that is not', () => {
    assert.deepEqual(markerNotes('resume', rec({ hostCutTail: true })), []);
    assert.deepEqual(markerNotes('resume', rec({ hostCutTail: true, lastUuid: undefined })), [HOST_CUT_NOTE]);
  });

  it('explains the markers of a session that predates the notes, once', () => {
    assert.deepEqual(markerNotes('continue', rec({ markersExplained: undefined, hostCutTail: true })), [
      LEGACY_MARKERS_NOTE,
      HOST_CUT_NOTE,
    ]);
    assert.deepEqual(markerNotes('resume', rec({ markersExplained: undefined })), [LEGACY_MARKERS_NOTE]);
  });

  it('tells a fresh session that the previous process died, never that the user stopped it', () => {
    const [note] = markerNotes('fresh', rec(), rec({ sessionId: null, lostReason: 'process ended before its reply' }));
    assert.equal(note, lostProcessNote('process ended before its reply'));
    assert.match(note, /ended unexpectedly \(process ended before its reply\)/);
    assert.match(note, /did not stop you/);
    assert.deepEqual(markerNotes('fresh', rec(), undefined), []);
    assert.deepEqual(markerNotes('one-shot', undefined, rec({ lostReason: 'x' })).length, 1);
  });
});
