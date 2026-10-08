/**
 * Live check of the Claude accounts panel against the running gateway:
 * renders the webview through the host route, runs its script in a vm with
 * `invoke` wired to the plugin's real actions, and prints what the page shows.
 *
 *   node --import tsx tests/webview-live.ts           # the page the gateway serves
 *   node --import tsx tests/webview-live.ts --local   # this checkout's page, live actions
 *
 * `--local` checks a page that the running Alfred has not loaded yet (the
 * bundle is rebuilt on restart) against the actions it does have.
 *
 * Read-only: it only lets the page poll, plus `refreshUsage`. Nothing that
 * opens a login window, spends quota or changes a seat is clicked here (the
 * unit test covers every button against a fake bridge).
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderDashboard } from '../src/webview/dashboard.js';
import { runPage } from './webviewVm.js';

const BASE = process.env.ALFRED_URL ?? 'http://127.0.0.1:4242';
const DATA = process.env.ALFRED_DATA_DIR ?? join(homedir(), 'Documents', 'alfred-data');
const token = readFileSync(join(DATA, 'auth', 'token'), 'utf8').trim();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { alfred: { id: string } };
const PLUGIN = pkg.alfred.id;
const headers = { Authorization: `Bearer ${token}`, Origin: BASE, 'content-type': 'application/json' };

async function main(): Promise<void> {
  const list = (await (await fetch(`${BASE}/api/plugins/webviews`, { headers })).json()) as { webviews: Array<{ pluginId: string; webview: { id: string } }> };
  const wv = list.webviews.find((w) => w.pluginId === PLUGIN)?.webview;
  if (!wv) throw new Error(`no webview for ${PLUGIN}: ${JSON.stringify(list).slice(0, 300)}`);
  const render = process.argv.includes('--local')
    ? { html: renderDashboard() }
    : ((await (await fetch(`${BASE}/api/plugins/${PLUGIN}/webviews/${wv.id}/render`, { headers })).json()) as { html: string });
  const timings: Record<string, number[]> = {};
  const page = await runPage(render.html, async (action, args) => {
    const t0 = Date.now();
    const res = (await (await fetch(`${BASE}/api/plugins/${PLUGIN}/actions/${action}`, { method: 'POST', headers, body: JSON.stringify(args) })).json()) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };
    (timings[action] ??= []).push(Date.now() - t0);
    if (!res.ok) throw new Error(res.error ?? 'invoke failed');
    return res.result;
  });
  // Real HTTP needs real time to come back.
  await new Promise((r) => setTimeout(r, 1500));
  await page.settle();
  const writesAfterLoad = page.doc.stats.innerHTMLWrites;
  for (let i = 0; i < 6; i++) {
    await page.advance(5_000);
    await new Promise((r) => setTimeout(r, 400));
    await page.settle();
  }
  const refresh = page.$('refreshAll');
  if (refresh) {
    await page.click(refresh);
    await new Promise((r) => setTimeout(r, 4000));
    await page.settle();
  }
  const out = {
    webview: wv.id,
    errors: page.errors,
    parseIssues: [...new Set(page.parseIssues)],
    timers: page.timers(),
    calls: page.calls.map((c) => c.action).reduce<Record<string, number>>((m, a) => ((m[a] = (m[a] ?? 0) + 1), m), {}),
    timingsMs: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.max(...v)])),
    innerHTMLWrites: { firstLoad: writesAfterLoad, total: page.doc.stats.innerHTMLWrites },
    rows: page.doc.querySelectorAll('tbody tr').map((tr) => `${tr.getAttribute('data-key')}: ${tr.textContent.replace(/\s+/g, ' ').trim()}`),
    stats: page.$('stats')?.textContent,
    flash: page.$('flash')?.textContent,
    text: page.doc.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 3000),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(page.errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
