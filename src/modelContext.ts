import type { ModelDetails } from '@alfred/sdk';

/**
 * Context facts this provider declares to the host per model
 * (`LLMProvider.getModelInfo`), which the host's compaction trigger reads.
 *
 * Windows as the CLI itself reports them in a result's
 * `modelUsage[model].contextWindow` (checked 2026-10-10 on the aliases:
 * claude-opus-5-5, claude-sonnet-5 and claude-fable-5-1 = 1,000,000;
 * claude-haiku-4-5 = 200,000). The plugin's `contextWindow` setting is a
 * single number for every model, so it cannot be the source of these.
 */
export const ONE_MILLION = 1_000_000;
export const TWO_HUNDRED_K = 200_000;

/**
 * Prompt size at which the host compacts a Claude conversation by default.
 *
 * Not a ceiling — the window is 1M — but an economy: every engine call re-reads
 * the whole prompt from the cache and counts it against the seat, and every
 * cache miss re-writes it in full (one miss at 760k measured at 8 % of a
 * seat's quota). Compacting rewrites only the summary and the recent tail.
 * 200k keeps that miss under a quarter of the 760k one, leaves the tail of
 * work the model is doing verbatim, and fits Haiku's own window.
 */
export const DEFAULT_COMPACT_AT_TOKENS = 200_000;

/** Families whose current models run a 1M window by default. */
const MILLION_FAMILIES = ['opus', 'sonnet', 'fable', 'mythos'];

/**
 * Dated ids that predate the 1M default (their 1M window, where it existed,
 * sat behind a beta the CLI only enables with the `[1m]` suffix).
 */
const LEGACY_200K = /^claude-(?:3[\w-]*|(?:opus|sonnet)-4(?:-[015])?(?:-\d{8})?)$/;

/**
 * Context window of a model id as Alfred names it: an alias (`opus`), a dated
 * id (`claude-opus-5-5`), either with `[1m]`, and optionally pinned to a seat
 * (`opus@seat`). Undefined for an id it does not recognise: the host then
 * falls back on what `listModels` reports, rather than on a guess.
 */
export function contextWindowOf(modelId: string): number | undefined {
  const id = modelId.split('@')[0].trim().toLowerCase();
  if (!id) return undefined;
  if (id.includes('[1m]')) return ONE_MILLION;
  if (id.includes('haiku')) return TWO_HUNDRED_K;
  if (LEGACY_200K.test(id)) return TWO_HUNDRED_K;
  if (MILLION_FAMILIES.some((f) => id.includes(f))) return ONE_MILLION;
  return undefined;
}

/** `getModelInfo` answer for `modelId`; `compactAtTokens` <= 0 turns the budget off. */
export function modelDetailsOf(modelId: string, compactAtTokens?: number): ModelDetails {
  const contextLength = contextWindowOf(modelId);
  const budget =
    compactAtTokens === undefined || !Number.isFinite(compactAtTokens)
      ? DEFAULT_COMPACT_AT_TOKENS
      : compactAtTokens;
  return {
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(budget > 0 ? { compactAtTokens: Math.floor(budget) } : {}),
  };
}
