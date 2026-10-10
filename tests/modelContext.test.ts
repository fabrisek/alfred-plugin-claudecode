// Run: npm test. Context window and compaction budget the provider declares
// to the host per model (src/modelContext.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMPACT_AT_TOKENS,
  contextWindowOf,
  modelDetailsOf,
} from '../src/modelContext.ts';

describe('contextWindowOf', () => {
  it('matches what the CLI reports for the aliases', () => {
    assert.equal(contextWindowOf('opus'), 1_000_000);
    assert.equal(contextWindowOf('sonnet'), 1_000_000);
    assert.equal(contextWindowOf('fable'), 1_000_000);
    assert.equal(contextWindowOf('haiku'), 200_000);
  });

  it('reads dated ids, [1m] and seat-pinned ids', () => {
    assert.equal(contextWindowOf('claude-opus-5-5'), 1_000_000);
    assert.equal(contextWindowOf('claude-haiku-4-5-20251001'), 200_000);
    assert.equal(contextWindowOf('opus@seat-2'), 1_000_000);
    assert.equal(contextWindowOf('claude-opus-4-5'), 200_000);
    assert.equal(contextWindowOf('claude-sonnet-4-20250514'), 200_000);
    assert.equal(contextWindowOf('claude-sonnet-4-5[1m]'), 1_000_000);
    assert.equal(contextWindowOf('claude-opus-4-8'), 1_000_000);
  });

  it('does not guess an unknown id', () => {
    assert.equal(contextWindowOf('some-other-model'), undefined);
  });
});

describe('modelDetailsOf', () => {
  it('declares the default budget', () => {
    assert.deepEqual(modelDetailsOf('opus'), {
      contextLength: 1_000_000,
      compactAtTokens: DEFAULT_COMPACT_AT_TOKENS,
    });
  });

  it('honours the setting, and 0 turns the budget off', () => {
    assert.equal(modelDetailsOf('opus', 300_000).compactAtTokens, 300_000);
    assert.deepEqual(modelDetailsOf('haiku', 0), { contextLength: 200_000 });
  });
});
