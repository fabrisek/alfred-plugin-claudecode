/**
 * The Claude panel (Seats / Usage) run in a vm over a small DOM, fed the
 * fixture pool through a fake bridge: it draws every zone with no NaN or
 * undefined, keeps one bubble per seat (next seat haloed, last resort apart),
 * survives every tab / period / unit / split / leaderboard switch, redraws
 * nothing on an unchanged poll, and keeps a single poll timer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderDashboard } from '../src/webview/dashboard.js';
import { NOW, view } from './seatsUsageFixture.js';
import { runPage, type PageRun } from './webviewVm.js';

const snapshot = {
  ok: true,
  settings: { strategy: 'drain', threshold: 90, usagePollMinutes: 5, fillMaxInFlight: 4 },
  cli: 'CLI',
  accounts: [],
  activity: [],
  recent: [],
};

async function open(): Promise<{ page: PageRun; polls: () => number }> {
  const u = view();
  let n = 0;
  const page = await runPage(
    renderDashboard(),
    async (action, args) => {
      if (action === 'seatsUsage') {
        n++;
        return args.since === 'v1' ? { ok: true, unchanged: true, version: 'v1', now: NOW } : { ok: true, version: 'v1', settings: snapshot.settings, ...structuredClone(u) };
      }
      if (action === 'poolSnapshot') return structuredClone(snapshot);
      throw new Error(`unexpected action ${action}`);
    },
    { startAt: NOW },
  );
  return { page, polls: () => n };
}

const clean = (page: PageRun, where: string): void => {
  const html = page.$('app')!.innerHTML;
  assert.doesNotMatch(html, /NaN|undefined|Infinity|\[object /, where);
};

describe('Claude panel', () => {
  it('draws the Seats tab: KPI band, one bubble per seat, next halo, last resort apart', async () => {
    const { page } = await open();
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.parseIssues, []);
    const bubs = page.doc.querySelectorAll('#seatRows .bub');
    assert.deepEqual(bubs.map((b) => b.getAttribute('data-seat')), ['s1', 's2', 'fab'], 'team first, the personal seat last');
    assert.ok(bubs[0].getAttribute('class')!.includes('next'), 'halo on the next seat');
    assert.ok(bubs[2].getAttribute('class')!.includes('perso'));
    assert.match(bubs[0].textContent, /2 threads · dev, testeur/);
    assert.match(bubs[1].textContent, /not reported/, 'no weekly quota: said so');
    assert.ok(page.$('kSeat')!.innerHTML.length > 0, 'KPI band');
    clean(page, 'seats');
  });

  it('switches to Usage and through every period, unit, split and leaderboard without an error', async () => {
    const { page } = await open();
    await page.click(page.doc.querySelector('.tab[data-tab=usage]'));
    const seen: string[] = [];
    for (const per of ['5h', 'today', '7d', 'all']) {
      await page.click(page.doc.querySelector(`#period button[data-v="${per}"]`));
      for (const unit of ['tok', 'usd']) {
        await page.click(page.doc.querySelector(`#unit button[data-v=${unit}]`));
        for (const split of ['type', 'seat']) {
          await page.click(page.doc.querySelector(`#split button[data-v=${split}]`));
          for (const by of ['seat', 'agent', 'conv']) {
            await page.click(page.doc.querySelector(`#dpsBy button[data-v=${by}]`));
            const where = `${per}/${unit}/${split}/${by}`;
            seen.push(where);
            clean(page, where);
            assert.ok(page.$('kUse')!.innerHTML.length > 0, `${where}: KPIs`);
            assert.ok(page.$('dps')!.children.length > 0, `${where}: leaderboard rows`);
          }
        }
      }
    }
    await page.click(page.doc.querySelector('#evSeg button[data-v=on]'));
    clean(page, 'cache events');
    await page.click(page.doc.querySelector('#density button[data-v=compact]'));
    clean(page, 'compact');
    assert.equal(seen.length, 48);
    assert.ok(page.$('quotaSvg')!.innerHTML.length > 0, 'pool 5h curve');
    assert.match(page.$('events')!.textContent, /Cache/i, 'cache health line');
    assert.deepEqual(page.errors, []);
  });

  it('an unchanged poll redraws nothing, and only one poll timer lives', async () => {
    const { page, polls } = await open();
    const first = page.doc.querySelectorAll('#seatRows .bub')[0];
    const before = polls();
    await page.advance(15_000 * 4 + 100);
    assert.ok(polls() >= before + 3, 'keeps polling');
    assert.equal(page.doc.querySelectorAll('#seatRows .bub')[0], first, 'same node: no flicker');
    const sinceArgs = page.calls.filter((c) => c.action === 'seatsUsage').slice(1).map((c) => c.args.since);
    assert.ok(sinceArgs.every((s) => s === 'v1'), 'passes the drawn version');
    assert.ok(page.timers().timeouts <= 4, `timers do not pile up (${page.timers().timeouts})`);
    assert.deepEqual(page.errors, []);
  });
});
