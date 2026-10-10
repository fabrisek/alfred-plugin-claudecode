/**
 * The one price table of the plugin: API list prices (to put an
 * "API-equivalent" dollar figure on subscription usage) and subscription
 * prices (to compare that figure with what a seat costs).
 *
 * A seat is not billed per token: these are yardsticks, not invoices.
 */

/** When the tables below were checked against the sources named next to them. */
export const PRICES_VERIFIED = '2026-10-10';

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
  ['claude-sonnet-4-6', p(3, 0.3, 15)],
  ['claude-sonnet-4-5', p(3, 0.3, 15)],
  ['claude-sonnet-4', p(3, 0.3, 15)],
  // Haiku 5.5 is priced by prompt length; the scanner tags long prompts (see LONG_PROMPT).
  ['claude-haiku-5-5' + '@long', p(0.5, 0.05, 2.5)],
  ['claude-haiku-5-5', p(0.1, 0.01, 0.5)],
  ['claude-haiku-4-5', p(1, 0.1, 5)],
  ['claude-3-5-haiku', p(0.8, 0.08, 4)],
];

/** Models priced by prompt length: the long-prompt rate applies above this many prompt tokens. */
export const LONG_PROMPT: Record<string, number> = { 'claude-haiku-5-5': 100_000 };

/**
 * Fast mode (`usage.speed: "fast"`, research preview): its own input and
 * output rates; the prompt caching multipliers of the model apply on top
 * (same source, "Fast mode pricing").
 */
const FAST: Array<[string, number, number]> = [
  ['claude-opus-5-5', 8, 40],
  ['claude-opus-5', 10, 50],
  ['claude-opus-4-8', 10, 50],
];

/**
 * What the CLI's aliases serve (`opus`, `fable`...): the model ids its
 * transcripts report for them. Only a fallback: the served id, when known,
 * always wins.
 */
export const ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
  mythos: 'claude-mythos-5-1',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
};

/** An id with no list price is worth $0 here and reported as unpriced, never guessed. */
const UNPRICED: Price = { input: 0, write5m: 0, write1h: 0, cacheRead: 0, output: 0 };

/**
 * Id of the model as priced: lower case, no context-window suffix
 * (`[1m]`: no long-context surcharge on these models), aliases resolved.
 * Tags (`@long`, `@fast`, `@advisor`) are kept.
 */
export function canonicalModel(model: string): string {
  const [head, ...tags] = model.toLowerCase().trim().split('@');
  let id = head.replace(/\[[^\]]*\]$/, '').trim();
  id = ALIASES[id] ?? id;
  return [id, ...tags].join('@');
}

/**
 * Price of the model actually served. Dated ids (`claude-opus-4-5-20251101`,
 * `claude-haiku-4-5-20251001`) match their family by prefix; the table is
 * ordered so that the most specific prefix wins. `@fast` is the fast-mode
 * rate, `@long` the long-prompt band, `@advisor` changes nothing (an advisor
 * iteration is billed at its own model's rate).
 */
export function priceOf(model: string): { price: Price; known: boolean; family: string | null } {
  const [id, ...tags] = canonicalModel(model).split('@');
  const long = tags.includes('long');
  for (const [prefix, base] of TABLE) {
    const isLong = prefix.endsWith('@long');
    if (isLong !== long && isLong) continue;
    const fam = isLong ? prefix.slice(0, -5) : prefix;
    if (!id.startsWith(fam)) continue;
    if (tags.includes('fast')) {
      const f = FAST.find(([pre]) => id.startsWith(pre));
      if (f) {
        const k = f[1] / base.input;
        return { price: { input: f[1], write5m: base.write5m * k, write1h: base.write1h * k, cacheRead: base.cacheRead * k, output: f[2] }, known: true, family: fam };
      }
    }
    return { price: base, known: true, family: fam };
  }
  return { price: UNPRICED, known: false, family: null };
}

/**
 * Model id as stored: a long-prompt request of a length-priced model gets
 * `@long`, a fast-mode request `@fast`.
 */
export function pricedModel(model: string, promptTokens: number, fast = false): string {
  let out = model;
  for (const [prefix, limit] of Object.entries(LONG_PROMPT)) {
    if (model.startsWith(prefix) && promptTokens > limit) out += '@long';
  }
  return fast ? out + '@fast' : out;
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
export function priceTokens(model: string, t: [number, number, number, number], write: '5m' | '1h' = '1h'): [number, number, number, number] | undefined {
  const { price: q, known } = priceOf(model);
  if (!known) return undefined;
  const r = (x: number): number => Math.round(x * 1e5) / 1e5;
  return [r((t[0] * q.input) / 1e6), r((t[1] * (write === '1h' ? q.write1h : q.write5m)) / 1e6), r((t[2] * q.cacheRead) / 1e6), r((t[3] * q.output) / 1e6)];
}
