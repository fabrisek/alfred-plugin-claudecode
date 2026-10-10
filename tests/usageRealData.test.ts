/**
 * Invariants of the Usage tab on the real imported history
 * (state/usage-history.json; skipped when there is none):
 * - the store: continuous days up to today (local time), finite non-negative
 *   cells, the per-seat totals adding up to the whole;
 * - the page, for every view, period and tokens / $ switch: no NaN,
 *   undefined or Infinity anywhere, no duplicate legend entry, no
 *   "unknown" category, the strip total equal to the sum of the bars, and
 *   the per-seat small charts adding up to it.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { UsageStore, dayOf, CELL_LEN } from '../src/usage/history.js';
import { renderDashboard } from '../src/webview/dashboard.js';
import { runPage } from './webviewVm.js';
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

const close = (a: number, b: number, what: string): void => {
  assert.ok(Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9), `${what}: ${a} vs ${b}`);
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

  it('page: every view, period and unit is consistent and clean', async () => {
    const { view } = realView();
    const snap = {
      ok: true,
      settings: { strategy: 'drain', threshold: 90, usagePollMinutes: 5, fillMaxInFlight: 4 },
      cli: 'CLI',
      accounts: [],
      totals: { window5h: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, requests: 0 }, week: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, requests: 0 }, total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, requests: 0 } },
      recent: [],
      activity: [],
    };
    const page = await runPage(renderDashboard(), async (action) => (action === 'usageHistory' ? structuredClone(view) : structuredClone(snap)));
    await page.click(page.doc.querySelector('button[data-act=tab][data-id=usage]'));
    const nums = (sel: string, attr: string) => page.doc.querySelectorAll(sel).map((e) => Number(e.getAttribute(attr)));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const strip = () => page.doc.querySelector('#useStrip [data-tok]')!;
    const checked: string[] = [];
    for (const metric of ['tokens', 'cost']) {
      await page.click(page.doc.querySelector(`button[data-act=umetric][data-id=${metric}]`));
      for (const v of ['overview', 'byseat', 'hourly', 'daily', 'cost', 'capacity', 'quota']) {
        await page.click(page.doc.querySelector(`button[data-act=uview][data-id=${v}]`));
        const periods = page.doc.querySelectorAll('#usePeriod option').map((o) => o.getAttribute('value')!);
        for (const per of periods) {
          await page.type(page.$('usePeriod'), per);
          const where = `${metric}/${v}/${per}`;
          checked.push(where);
          for (const id of ['useChart', 'useStrip', 'useLegend', 'useScope']) {
            const html = page.$(id)!.innerHTML;
            assert.doesNotMatch(html, /NaN|undefined|Infinity/, `${where} #${id}`);
          }
          const legend = page.doc.querySelectorAll('#useLegend > span').map((e) => e.textContent);
          assert.equal(new Set(legend).size, legend.length, `${where}: legend without duplicates`);
          assert.ok(!legend.includes('unknown'), `${where}: no raw "unknown"`);
          if (v === 'overview' || v === 'hourly' || v === 'daily') {
            const bars = page.doc.querySelectorAll('#useChart g.col[data-tok]');
            assert.ok(bars.length > 0, `${where}: bars`);
            close(sum(nums('#useChart g.col[data-tok]', 'data-tok')), Number(strip().getAttribute('data-tok')), `${where}: strip tokens = sum of the bars`);
            close(sum(nums('#useChart g.col[data-tok]', 'data-usd')), Number(strip().getAttribute('data-usd')), `${where}: strip $ = sum of the bars`);
          }
          if (v === 'byseat') {
            // Tokens without a seat are no series but stay in the total.
            const seats = sum(nums('#useChart button.mult', 'data-tok'));
            const all = Number(strip().getAttribute('data-tok'));
            const seatless = Object.entries(view.daily)
              .filter(([id]) => !view.accounts.some((a) => a.id === id))
              .reduce((s, [, rows]) => s + rows.reduce((t, c) => t + c[0] + c[1] + c[2] + c[3], 0), 0);
            assert.ok(seats <= all + 1e-6 && all - seats <= seatless + 1e-6, `${where}: seats + seatless add up to the total (${seats} + <=${seatless} vs ${all})`);
          }
          // Bars stay inside the chart.
          const svg = page.doc.querySelector('#useChart svg');
          if (svg) {
            const h = Number(svg.getAttribute('height'));
            for (const r of page.doc.querySelectorAll('#useChart svg rect')) {
              const y = Number(r.getAttribute('y'));
              const rh = Number(r.getAttribute('height'));
              assert.ok(y >= 0 && y + rh <= h + 0.5, `${where}: a bar overflows (${y} + ${rh} > ${h})`);
            }
          }
        }
      }
    }
    assert.ok(checked.length >= 40, `${checked.length} combinations checked`);
    assert.deepEqual(page.errors, []);
  });
});
