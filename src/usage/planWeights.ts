/**
 * Plan weights: how much quota one seat's plan carries relative to a Team
 * standard seat, for the plan-weighted 5h / week figures and the pooled 5h
 * curve. Anthropic publishes no multiplier, so the weights are declared in
 * the plugin config (defaults STD 1, PRM 5, MAX 20).
 *
 * Also the subscription cost the "API value vs subscription" ratios divide
 * by: the plan prices of usage/pricing.ts, prorated to the same period.
 */

import type { Plan } from './pricing.js';

export type PlanTag = 'STD' | 'PRM' | 'MAX' | 'MAX5' | 'PRO';
export type PlanWeights = Record<PlanTag, number>;

export const DEFAULT_PLAN_WEIGHTS: PlanWeights = { STD: 1, PRM: 5, MAX: 20, MAX5: 5, PRO: 1 };

const TAG_OF_PLAN: Record<string, PlanTag> = {
  teamStandard: 'STD',
  teamPremium: 'PRM',
  max20x: 'MAX',
  max5x: 'MAX5',
  pro: 'PRO',
};

export function planTag(planId: string | null | undefined): PlanTag | null {
  return planId ? (TAG_OF_PLAN[planId] ?? null) : null;
}

/** Weights from the plugin config (`planWeightStandard`, `planWeightPremium`, `planWeightMax`); bad values keep the default. */
export function resolvePlanWeights(config: Record<string, unknown> | undefined): PlanWeights {
  const num = (v: unknown, d: number): number => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : d;
  };
  const c = config ?? {};
  const max = num(c.planWeightMax, DEFAULT_PLAN_WEIGHTS.MAX);
  return {
    STD: num(c.planWeightStandard, DEFAULT_PLAN_WEIGHTS.STD),
    PRM: num(c.planWeightPremium, DEFAULT_PLAN_WEIGHTS.PRM),
    MAX: max,
    // Max 5x carries a quarter of Max 20x; Pro counts as a standard seat.
    MAX5: max / 4,
    PRO: num(c.planWeightStandard, DEFAULT_PLAN_WEIGHTS.STD),
  };
}

export function weightOf(tag: PlanTag | null, w: PlanWeights): number {
  return tag ? w[tag] : 1;
}

/**
 * Plan-weighted utilisation: Σ(pct × weight) / Σ(weight) over the seats that
 * report the window. `share` is the weight of those seats over all seats.
 */
export function weightedPct(rows: Array<{ pct: number | null; weight: number }>): { pct: number | null; reporting: number; share: number } {
  let wRep = 0;
  let wAll = 0;
  let acc = 0;
  let n = 0;
  for (const r of rows) {
    wAll += r.weight;
    if (r.pct === null || !Number.isFinite(r.pct)) continue;
    wRep += r.weight;
    acc += r.pct * r.weight;
    n++;
  }
  return { pct: wRep > 0 ? acc / wRep : null, reporting: n, share: wAll > 0 ? wRep / wAll : 0 };
}

export type Subscription = {
  monthlyUsd: number;
  /** Monthly price / 30.4: what one day of the subscriptions costs. */
  perDayUsd: number;
  plans: Array<{ label: string; count: number; monthlyUsd: number }>;
};

export const DAYS_PER_MONTH = 30.4;

/** What the seats' plans cost (usage/pricing.ts list prices). */
export function subscriptionOf(plans: Array<Plan | null>): Subscription {
  const by = new Map<string, { label: string; count: number; monthlyUsd: number }>();
  let monthly = 0;
  for (const p of plans) {
    if (!p) continue;
    monthly += p.monthlyUsd;
    const g = by.get(p.id) ?? { label: p.label, count: 0, monthlyUsd: 0 };
    g.count++;
    g.monthlyUsd += p.monthlyUsd;
    by.set(p.id, g);
  }
  return { monthlyUsd: monthly, perDayUsd: monthly / DAYS_PER_MONTH, plans: [...by.values()].sort((a, b) => b.monthlyUsd - a.monthlyUsd) };
}

/**
 * API value over a period divided by what the subscriptions cost over the
 * same period (days may be fractional: today so far is a fraction of a day).
 * Null when there is no plan price or no elapsed time.
 */
export function valueMultiple(apiUsd: number, sub: Subscription, periodDays: number): number | null {
  const cost = sub.perDayUsd * periodDays;
  return cost > 0 ? apiUsd / cost : null;
}
