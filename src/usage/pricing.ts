/**
 * The one price table of the plugin: API list prices (to put an
 * "API-equivalent" dollar figure on subscription usage) and subscription
 * prices (to compare that figure with what a seat costs).
 *
 * A seat is not billed per token: these are yardsticks, not invoices.
 */

/** When the tables below were checked against the sources named next to them. */
export const PRICES_VERIFIED = '2026-10-08';

/**
 * USD per million tokens, Anthropic first-party API, global routing, standard
 * speed. Source: platform.claude.com/docs/en/about-claude/pricing (model
 * pricing table), checked on {@link PRICES_VERIFIED}.
 */
export type Price = { input: number; write5m: number; write1h: number; cacheRead: number; output: number };

const p = (input: number, cacheRead: number, output: number): Price => ({ input, write5m: input * 1.25, write1h: input * 2, cacheRead, output });

/** First match wins: more specific prefixes first. */
const TABLE: Array<[string, Price]> = [
  ['claude-fable-5-1', p(10, 0.25, 50)],
  ['claude-mythos-5-1', p(10, 0.25, 50)],
  ['claude-fable-5', p(10, 1, 50)],
  ['claude-mythos-5', p(10, 1, 50)],
  ['claude-opus-5-5', p(4, 0.2, 20)],
  ['claude-opus-5', p(5, 0.5, 25)],
  ['claude-opus-4-8', p(5, 0.5, 25)],
  ['claude-opus-4-7', p(5, 0.5, 25)],
  ['claude-opus-4-6', p(5, 0.5, 25)],
  ['claude-opus-4-5', p(5, 0.5, 25)],
  ['claude-opus-4', p(15, 1.5, 75)],
  ['claude-sonnet-5-5', p(2, 0.1, 10)],
  ['claude-sonnet-5', p(2, 0.2, 10)],
  ['claude-sonnet-4', p(3, 0.3, 15)],
  // Haiku 5.5 is priced by prompt length; the scanner tags long prompts (see LONG_PROMPT).
  ['claude-haiku-5-5' + '@long', p(0.5, 0.05, 2.5)],
  ['claude-haiku-5-5', p(0.1, 0.01, 0.5)],
  ['claude-haiku-4-5', p(1, 0.1, 5)],
  ['claude-3-5-haiku', p(0.8, 0.08, 4)],
];

/** Models priced by prompt length: the long-prompt rate applies above this many prompt tokens. */
export const LONG_PROMPT: Record<string, number> = { 'claude-haiku-5-5': 100_000 };

/** Unknown ids are priced like the current Opus, and flagged as such. */
const FALLBACK: Price = p(4, 0.2, 20);

export function priceOf(model: string): { price: Price; known: boolean } {
  const m = model.toLowerCase();
  for (const [prefix, price] of TABLE) if (m.startsWith(prefix)) return { price, known: true };
  return { price: FALLBACK, known: false };
}

/** Model id as stored: a long-prompt request of a length-priced model gets `@long`. */
export function pricedModel(model: string, promptTokens: number): string {
  for (const [prefix, limit] of Object.entries(LONG_PROMPT)) {
    if (model.startsWith(prefix) && promptTokens > limit) return model + '@long';
  }
  return model;
}

/** [requests, input, cacheWrite5m, cacheWrite1h, cacheRead, output] */
export type Vec = [number, number, number, number, number, number];

export function costOf(model: string, v: Vec): number {
  const { price: q } = priceOf(model);
  return (v[1] * q.input + v[2] * q.write5m + v[3] * q.write1h + v[4] * q.cacheRead + v[5] * q.output) / 1e6;
}

/**
 * Monthly subscription price of a seat, USD, billed monthly. Source:
 * claude.com/pricing, checked on {@link PRICES_VERIFIED}: Pro $20, Max from
 * $100 (5x), Team standard seat $25, Team premium seat $125 (annual billing:
 * $20 / $100). Max 20x is not priced on that page ("from $100"); $200 is its
 * list price at subscription.
 */
export type Plan = { id: string; label: string; monthlyUsd: number };

export const PLANS: Record<string, Plan> = {
  pro: { id: 'pro', label: 'Pro', monthlyUsd: 20 },
  max5x: { id: 'max5x', label: 'Max 5x', monthlyUsd: 100 },
  max20x: { id: 'max20x', label: 'Max 20x', monthlyUsd: 200 },
  teamStandard: { id: 'teamStandard', label: 'Team standard', monthlyUsd: 25 },
  teamPremium: { id: 'teamPremium', label: 'Team premium', monthlyUsd: 125 },
};

/**
 * The plan of a seat from what its login says: `subscriptionType` and
 * `rateLimitTier` (`.credentials.json`), `seatTier` (`.claude.json`).
 */
export function planOf(info: { subscriptionType?: string | null; rateLimitTier?: string | null; seatTier?: string | null }): Plan | null {
  const sub = String(info.subscriptionType ?? '').toLowerCase();
  const tier = String(info.rateLimitTier ?? '').toLowerCase();
  const seat = String(info.seatTier ?? '').toLowerCase();
  if (sub === 'team' || seat.startsWith('team')) {
    if (seat === 'team_standard') return PLANS.teamStandard;
    if (seat.startsWith('team_tier') || seat.includes('premium') || tier.includes('max')) return PLANS.teamPremium;
    return seat || tier ? PLANS.teamStandard : null;
  }
  if (sub === 'max') {
    if (tier.includes('20x')) return PLANS.max20x;
    if (tier.includes('5x')) return PLANS.max5x;
    return null;
  }
  if (sub === 'pro') return PLANS.pro;
  return null;
}

/**
 * USD of [input, cacheWrite, cacheRead, output] tokens on one model, for a
 * total that does not split the cache write by TTL. Claude Code writes its
 * prompt cache with the 1-hour TTL (what its transcripts report), so the
 * 1h rate is the default.
 */
export function priceTokens(model: string, t: [number, number, number, number], write: '5m' | '1h' = '1h'): [number, number, number, number] {
  const { price: q } = priceOf(model);
  const r = (x: number): number => Math.round(x * 1e5) / 1e5;
  return [r((t[0] * q.input) / 1e6), r((t[1] * (write === '1h' ? q.write1h : q.write5m)) / 1e6), r((t[2] * q.cacheRead) / 1e6), r((t[3] * q.output) / 1e6)];
}
