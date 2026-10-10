/**
 * Invariants of the Usage tab on the real imported history
 * (state/usage-history.json; skipped when there is none):
 * - the store: continuous days up to today (local time), finite non-negative
 *   cells, the per-seat totals adding up to the whole;
 * - the Seats / Usage payload: every day and hour adding up over seats and
 *   models (unknown seat included), per-thread spend within the totals;
 * - the page, for every tab, period, unit, split and leaderboard: no NaN,
 *   undefined or Infinity anywhere, no script error.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { UsageStore, dayOf, CELL_LEN } from '../src/usage/history.js';
import { renderDashboard } from '../src/webview/dashboard.js';
import { runPage } from './webviewVm.js';
import { DEFAULT_PLAN_WEIGHTS } from '../src/usage/planWeights.js';
import { buildSeatsUsage, cellTokens, cellUsd } from '../src/usage/seatsUsage.js';
import { seat } from './seatsUsageFixture.js';
import { USAGE_ATTRIBUTION_REV } from '../src/usage/register.js';

const STATE = join(fileURLToPath(new URL('../state/', import.meta.url)), 'usage-history.json');
const HAVE = existsSync(STATE);
const scan = { running: false, backfilled: true, filesDone: 0, filesTotal: 0, lastScanAt: Date.now() };

function realView() {
  // Read-only: the store is only saved when something was added, and nothing is.
  const store = new UsageStore(STATE, Date.now, USAGE_ATTRIBUTION_REV);
  const view = store.view({ scan, seats: [], hourSpan: 72 });
  return { store, view: { ok: true, ...view, version: 'real', capacity: { since: Date.now() - 86_400_000, rows: [] } } };
}

const close = (a: number, b: number, what: string, eps = 1e-6): void => {
  assert.ok(Math.abs(a - b) <= Math.max(eps, Math.abs(b) * 1e-9), `${what}: ${a} vs ${b}`);
};

describe('usage history on the real data', { skip: !HAVE && 'no state/usage-history.json' }, () => {
  it('store: continuous local days up to today, finite cells, seats adding up to the whole', () => {
    const { store, view } = realView();
    assert.ok(view.days.length >= 1);
    assert.equal(view.days[view.days.length - 1], dayOf(Date.now()), 'ends today, in local time');
    for (let i = 1; i < view.days.length; i++) {
      const prev = new Date(view.days[i - 1] + 'T12:00:00');
      prev.setDate(prev.getDate() + 1);
      assert.equal(dayOf(prev.getTime()), view.days[i], `no gap after ${view.days[i - 1]}`);
    }
    for (const [acc, rows] of [...Object.entries(view.daily), ...Object.entries(view.hourly)]) {
      for (const c of rows) {
        assert.equal(c.length, CELL_LEN);
        for (const x of c) assert.ok(Number.isFinite(x) && x >= 0, `${acc}: ${c}`);
      }
    }
    const totals = store.totalsByAccount();
    let all = 0;
    for (const [acc, rows] of Object.entries(view.daily)) {
      const tok = rows.reduce((s, c) => s + c[0] + c[1] + c[2] + c[3], 0);
      const t = totals[acc];
      close(tok, t[1] + t[2] + t[3] + t[4] + t[5], `${acc} tokens`);
      all += tok;
    }
    const sumAll = Object.values(totals).reduce((s, t) => s + t[1] + t[2] + t[3] + t[4] + t[5], 0);
    close(all, sumAll, 'every seat');
    assert.equal(new Set(view.accounts.map((a) => a.label)).size, view.accounts.length, 'one label per seat');
  });

  it('seats usage payload: every day and hour adds up over seats and models, threads within the totals', () => {
    const u = realPanel();
    for (const r of [...u.daily, ...u.hourly]) {
      const where = 'd' in r ? r.d : new Date(r.t).toISOString();
      close(cellTokens(r.tot), Object.values(r.seat).reduce((s, c) => s + cellTokens(c), 0), `${where}: seats tokens`);
      close(cellUsd(r.tot), Object.values(r.seat).reduce((s, c) => s + cellUsd(c), 0), `${where}: seats $`, 1e-2);
      close(cellUsd(r.tot), Object.values(r.model).reduce((s, c) => s + cellUsd(c), 0), `${where}: models $`, 1e-2);
      for (const x of r.tot) assert.ok(Number.isFinite(x) && x >= 0, `${where}: ${r.tot}`);
    }
    const all = u.daily.reduce((s, r) => s + cellUsd(r.tot), 0);
    assert.ok(u.attributed.all <= all * 1.001 + 0.01, `per-thread spend within the total (${u.attributed.all} vs ${all})`);
  });

  it('page: every tab, period, unit, split and leaderboard is clean on the real data', async () => {
    const u = realPanel();
    const page = await runPage(renderDashboard(), async (action) =>
      action === 'seatsUsage' ? { ok: true, version: 'real', ...structuredClone(u) } : { ok: true, settings: { strategy: 'drain', threshold: 90 }, accounts: [], activity: [], recent: [] },
    );
    assert.deepEqual(page.errors, []);
    assert.equal(page.doc.querySelectorAll('#seatRows .bub').length, u.seats.length);
    await page.click(page.doc.querySelector('.tab[data-tab=usage]'));
    let n = 0;
    for (const per of ['5h', 'today', '7d', 'all']) {
      await page.click(page.doc.querySelector(`#period button[data-v="${per}"]`));
      for (const unit of ['tok', 'usd']) {
        await page.click(page.doc.querySelector(`#unit button[data-v=${unit}]`));
        for (const split of ['type', 'seat']) {
          await page.click(page.doc.querySelector(`#split button[data-v=${split}]`));
          for (const by of ['seat', 'agent', 'conv']) {
            await page.click(page.doc.querySelector(`#dpsBy button[data-v=${by}]`));
            assert.doesNotMatch(page.$('app')!.innerHTML, /NaN|undefined|Infinity|\[object /, `${per}/${unit}/${split}/${by}`);
            n++;
          }
        }
      }
    }
    assert.equal(n, 48);
    assert.deepEqual(page.errors, []);
  });
});

/** The panel payload over the real history, one Team seat per account seen in it. */
function realPanel() {
  const { store } = realView();
  const ids = new Set<string>();
  store.forEachBucket('days', (_d, account) => {
    if (account !== 'unknown') ids.add(account);
  });
  return buildSeatsUsage({
    now: Date.now(),
    store,
    seats: [...ids].map((id) => seat({ id, label: id })),
    cold: [],
    compactions: [],
    coldTotal: 0,
    modesToday: {},
    threadInfo: () => undefined,
    liveThreads: [],
    samples: () => [],
    resets: [],
    weights: DEFAULT_PLAN_WEIGHTS,
    nextId: null,
  });
}
