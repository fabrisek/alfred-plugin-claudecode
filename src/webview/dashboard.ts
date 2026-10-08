/**
 * The "Claude accounts" page: one screen, every seat, no help text.
 *
 * A single document in a null-origin sandboxed iframe: no stylesheet fetch, no
 * localStorage, every interaction through `window.alfred.invoke`. The page
 * polls `poolSnapshot` (local state only, no network) and ticks the reset
 * countdowns client-side.
 *
 * The client script lives inside a TS template literal: it uses no backticks,
 * no `${`, and no regex escapes, so nothing is rewritten on the way out.
 */

import {
  DESIGN_TOKENS,
  ESC_FN_JS,
  PILL_CSS,
  armConfirmFnJs,
  invokeFnJs,
} from '@alfred/plugin-kit/webview';
import type { Webview } from '@alfred/sdk';

// Class vocabulary from the AutoPilot shell (the design-system reference),
// trimmed to what this page uses, plus the usage bars.
const STYLES = `${DESIGN_TOKENS}${PILL_CSS}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 20px; background: var(--bg); color: var(--text);
  font: 13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
h1 { font-size: 17px; margin: 0; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.spacer { flex: 1; }
.wrap { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
tr:last-child td { border-bottom: none; }
tr.total td { font-weight: 600; background: rgba(127,127,127,.05); }
tr.active td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.mono { font-family: var(--mono); font-size: 11px; }
.nowrap { white-space: nowrap; }
.ellipsis { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { font: inherit; font-size: 11px; padding: 3px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { opacity: .9; color: #fff; }
button.danger:hover, button.armed { border-color: var(--err); color: var(--err); }
.acts { display: flex; gap: 4px; flex-wrap: wrap; }
input[type=text], input[type=number], input[type=password], select {
  font: inherit; font-size: 12px; padding: 4px 7px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--field); color: var(--text); }
input.num { width: 58px; }
.bar { position: relative; height: 6px; border-radius: 999px; background: var(--border);
  overflow: hidden; width: 110px; }
.bar > i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ok); }
.bar.warn > i { background: var(--warn); }
.bar.err > i { background: var(--err); }
.meter { display: flex; flex-direction: column; gap: 2px; }
.meter .line { display: flex; gap: 6px; align-items: center; }
.banner { border: 1px solid var(--border); border-left: 3px solid var(--err); background: var(--panel);
  padding: 6px 10px; border-radius: 6px; margin-bottom: 10px; font-size: 12px; }
.banner.ok { border-left-color: var(--ok); }
.recent { margin-top: 12px; }
.recent td { padding: 3px 8px; }
.tokenrow { display: none; }
.tokenrow.on { display: table-row; }
`;

const SCRIPT = `
const invoke = ${invokeFnJs()};
const esc = ${ESC_FN_JS};
const armConfirm = ${armConfirmFnJs(3000)};
let snap = null;
let flash = null;
const $ = (id) => document.getElementById(id);

async function call(action, args) {
  try {
    const r = await invoke(action, args || {});
    if (r && r.ok === false) { flash = { kind: 'err', text: r.error || 'failed' }; }
    return r;
  } catch (err) {
    flash = { kind: 'err', text: String(err && err.message || err) };
    return null;
  }
}

function fmtTokens(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function sumTally(t) { return t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0; }
function tallyTitle(name, t) {
  if (!t) return '';
  return name + ': in ' + t.input + ', out ' + t.output + ', cache read ' + t.cacheRead
    + ', cache write ' + t.cacheWrite + ', ' + t.requests + ' req, API-equiv $' + t.costUsd.toFixed(2);
}
function countdown(ms) {
  if (!ms) return '';
  const d = ms - Date.now();
  if (d <= 0) return 'reset';
  const m = Math.floor(d / 60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
function resetDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function clock(ms) { return ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''; }

function bar(w, threshold, mode) {
  if (!w) return '<span class="muted small">\\u2014</span>';
  const pct = w.percent == null ? null : Math.max(0, Math.min(100, w.percent));
  const cls = pct == null ? '' : pct >= 100 ? 'err' : pct >= threshold ? 'warn' : '';
  const when = mode === 'date' ? resetDate(w.resetsAt) : countdown(w.resetsAt);
  return '<div class="line"><div class="bar ' + cls + '"><i style="width:' + (pct || 0) + '%"></i></div>'
    + '<span class="nowrap">' + (pct == null ? '?' : Math.round(pct) + '%') + '</span>'
    + '<span class="muted small nowrap" data-reset="' + (w.resetsAt || '') + '" data-mode="' + mode + '">' + esc(when) + '</span></div>';
}

const STATUS_PILL = { active: 'info', ok: 'ok', exhausted: 'warn', 'logged out': 'err', 'auth failed': 'err', disabled: 'idle' };

function row(a, s) {
  const u = a.usage || { windows: [] };
  const five = u.windows.find((w) => w.key === 'five_hour');
  const week = u.windows.find((w) => w.key === 'seven_day');
  const scoped = u.windows.filter((w) => w.model);
  const weekCell = (week ? bar(week, s.threshold, 'date') : '')
    + scoped.map((w) => '<div class="line"><span class="muted small" style="min-width:64px">' + esc(w.label) + '</span></div>' + bar(w, s.threshold, 'date')).join('')
    + (!week && !scoped.length ? bar(null) : '');
  const t = a.tokens;
  const statusTitle = a.statusDetail ? ' title="' + esc(a.statusDetail) + '"' : '';
  const stale = u.stale ? '<div class="muted small ellipsis" title="' + esc(u.stale) + '">stale: ' + esc(u.stale) + '</div>' : '';
  const err = a.lastError ? '<span title="' + esc(a.lastError.message) + '">' + esc(clock(a.lastError.at) + ' ' + a.lastError.message) + '</span>' : '';
  return '<tr class="' + (a.status === 'active' ? 'active' : '') + '">'
    + '<td><div><b>' + esc(a.label) + '</b>' + (a.preferred ? ' <span class="pill info">preferred</span>' : '')
    + (a.exposeModels ? ' <span class="pill idle">pinnable</span>' : '') + '</div>'
    + '<div class="muted small">' + esc(a.email || a.id) + (a.auth === 'token' ? ' \\u00b7 token' : '') + (a.inFlight ? ' \\u00b7 ' + a.inFlight + ' running' : '') + '</div></td>'
    + '<td><span class="pill ' + (STATUS_PILL[a.status] || 'idle') + '"' + statusTitle + '>' + esc(a.status) + '</span>'
    + (a.exhaustedUntil ? '<div class="muted small" data-reset="' + a.exhaustedUntil + '" data-mode="count">' + countdown(a.exhaustedUntil) + '</div>' : '') + '</td>'
    + '<td><div class="meter">' + bar(five, s.threshold, 'count') + '</div>' + stale + '</td>'
    + '<td><div class="meter">' + weekCell + '</div></td>'
    + '<td class="nowrap small"><span title="' + esc(tallyTitle('5h window', t.window5h)) + '">' + fmtTokens(sumTally(t.window5h)) + '</span> \\u00b7 '
    + '<span title="' + esc(tallyTitle('Week', t.week)) + '">' + fmtTokens(sumTally(t.week)) + '</span> \\u00b7 '
    + '<span title="' + esc(tallyTitle('Total', t.total)) + '">' + fmtTokens(sumTally(t.total)) + '</span></td>'
    + '<td class="small"><div class="ellipsis">' + err + '</div></td>'
    + '<td><div class="acts">'
    + '<button data-act="login" data-id="' + esc(a.id) + '">Login</button>'
    + '<button data-act="token" data-id="' + esc(a.id) + '">Token</button>'
    + '<button data-act="refresh" data-id="' + esc(a.id) + '">Refresh</button>'
    + '<button data-act="test" data-id="' + esc(a.id) + '">Test</button>'
    + '<button data-act="toggle" data-id="' + esc(a.id) + '">' + (a.enabled ? 'Disable' : 'Enable') + '</button>'
    + (a.preferred ? '' : '<button data-act="prefer" data-id="' + esc(a.id) + '">Prefer</button>')
    + '<button data-act="pin" data-id="' + esc(a.id) + '">' + (a.exposeModels ? 'Unpin' : 'Pin') + '</button>'
    + '<button class="danger" data-act="remove" data-id="' + esc(a.id) + '">Remove</button>'
    + '</div></td></tr>'
    + '<tr class="tokenrow" id="tok-' + esc(a.id) + '"><td colspan="7"><div class="acts">'
    + '<input type="password" placeholder="claude setup-token value (empty = use login)" style="flex:1" id="tokv-' + esc(a.id) + '">'
    + '<button class="primary" data-act="savetoken" data-id="' + esc(a.id) + '">Save</button></div></td></tr>';
}

function render() {
  if (!snap) return;
  const s = snap.settings;
  $('strategy').value = s.strategy;
  if (document.activeElement !== $('threshold')) $('threshold').value = s.threshold;
  $('cli').textContent = snap.cli;
  const open = Array.from(document.querySelectorAll('.tokenrow.on')).map((r) => r.id);
  const t = snap.totals;
  $('rows').innerHTML = snap.accounts.map((a) => row(a, s)).join('')
    + '<tr class="total"><td>Total</td><td>' + snap.accounts.filter((a) => a.status === 'ok' || a.status === 'active').length + ' / ' + snap.accounts.length + ' usable</td><td></td><td></td>'
    + '<td class="nowrap small"><span title="' + esc(tallyTitle('5h windows', t.window5h)) + '">' + fmtTokens(sumTally(t.window5h)) + '</span> \\u00b7 '
    + '<span title="' + esc(tallyTitle('Week', t.week)) + '">' + fmtTokens(sumTally(t.week)) + '</span> \\u00b7 '
    + '<span title="' + esc(tallyTitle('Total', t.total)) + '">' + fmtTokens(sumTally(t.total)) + '</span></td><td></td><td></td></tr>';
  open.forEach((id) => { const r = $(id); if (r) r.classList.add('on'); });
  $('recent').innerHTML = snap.recent.slice(0, 6).map((r) =>
    '<tr><td class="mono">' + esc(clock(r.at)) + '</td><td>' + esc(r.accountLabel) + '</td><td class="mono">' + esc(r.model) + (r.servedModel && r.servedModel !== r.model ? ' &rarr; ' + esc(r.servedModel) : '') + (r.kind === 'session' ? ' <span class="pill info" title="Claude Code agent session (claude_code_run)">session</span>' : '') + '</td>'
    + '<td>' + (r.agent ? esc(r.agent) : '') + '</td>'
    + '<td class="small">' + (r.tokens ? fmtTokens(r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite) + ' in \\u00b7 ' + fmtTokens(r.tokens.output) + ' out' : '') + '</td>'
    + '<td><span class="pill ' + (r.outcome === 'ok' ? 'ok' : r.outcome === 'switched' ? 'warn' : 'err') + '">' + esc(r.outcome) + '</span></td>'
    + '<td class="small"><div class="ellipsis" title="' + esc(r.detail || '') + '">' + esc(r.detail || '') + '</div></td></tr>'
  ).join('') || '<tr><td class="muted">No requests yet</td></tr>';
  $('flash').innerHTML = flash ? '<div class="banner ' + (flash.kind === 'ok' ? 'ok' : '') + '">' + esc(flash.text) + '</div>' : '';
}

async function load() {
  const r = await call('poolSnapshot');
  if (r && r.ok) snap = r;
  render();
}

function tick() {
  document.querySelectorAll('[data-reset]').forEach((el) => {
    const ms = Number(el.getAttribute('data-reset'));
    if (!ms) return;
    el.textContent = el.getAttribute('data-mode') === 'date' ? resetDate(ms) : countdown(ms);
  });
}

document.addEventListener('click', async (e) => {
  const b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!b) return;
  const id = b.getAttribute('data-id');
  const act = b.getAttribute('data-act');
  const a = snap && snap.accounts.find((x) => x.id === id);
  flash = null;
  if (act === 'remove') {
    if (armConfirm(b, 'Confirm remove', async () => { await call('removeAccount', { id }); await load(); })) return;
    return;
  }
  if (act === 'token') { const r = $('tok-' + id); if (r) r.classList.toggle('on'); return; }
  b.disabled = true;
  let r = null;
  if (act === 'login') {
    r = await call('loginAccount', { id });
    if (r && r.ok) flash = { kind: 'ok', text: 'Login window opened for ' + (a ? a.label : id) + '.' };
  } else if (act === 'refresh') r = await call('refreshUsage', { id });
  else if (act === 'test') {
    r = await call('testConnection', { accountId: id });
    if (r && r.ok) flash = { kind: 'ok', text: (a ? a.label : id) + ': ' + r.sample };
  }
  else if (act === 'toggle') r = await call('updateAccount', { id, enabled: !(a && a.enabled) });
  else if (act === 'prefer') r = await call('setPreferred', { id });
  else if (act === 'pin') r = await call('updateAccount', { id, exposeModels: !(a && a.exposeModels) });
  else if (act === 'savetoken') {
    const v = $('tokv-' + id);
    r = await call('setAccountToken', { id, token: v ? v.value : '' });
    if (v) v.value = '';
    const row = $('tok-' + id); if (row) row.classList.remove('on');
  }
  b.disabled = false;
  await load();
});

$('add').addEventListener('click', async () => {
  const label = $('newLabel').value.trim();
  if (!label) { $('newLabel').focus(); return; }
  flash = null;
  const r = await call('addAccount', { label, login: true });
  if (r && r.ok) { $('newLabel').value = ''; flash = { kind: 'ok', text: 'Added ' + label + '; complete the login in the opened window.' }; }
  await load();
});
$('refreshAll').addEventListener('click', async () => { flash = null; await call('refreshUsage', {}); await load(); });
$('strategy').addEventListener('change', async () => { await call('updateSettings', { strategy: $('strategy').value }); await load(); });
$('threshold').addEventListener('change', async () => { await call('updateSettings', { threshold: Number($('threshold').value) }); await load(); });

load();
setInterval(load, 5000);
setInterval(tick, 1000);
`;

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Claude accounts</title>
  <style>${STYLES}</style>
</head>
<body>
<div class="toolbar">
  <h1>Claude accounts</h1>
  <span class="muted small mono" id="cli"></span>
  <span class="spacer"></span>
  <label class="small muted" for="strategy">Strategy</label>
  <select id="strategy"><option value="fill">Fill</option><option value="spread">Spread</option></select>
  <label class="small muted" for="threshold">Switch at %</label>
  <input type="number" class="num" id="threshold" min="1" max="100">
  <button id="refreshAll">Refresh usage</button>
  <input type="text" id="newLabel" placeholder="New account label" style="width:150px">
  <button class="primary" id="add">Add account</button>
</div>
<div id="flash"></div>
<div class="wrap">
  <table>
    <thead><tr><th>Account</th><th>Status</th><th>5h</th><th>Week</th><th title="5h window / week / total">Tokens</th><th>Last error</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<div class="wrap recent">
  <table><tbody id="recent"></tbody></table>
</div>
<script>
${SCRIPT}
</script>
</body>
</html>`;
}

export function createDashboardWebview(): Webview {
  return {
    id: 'claude-accounts',
    title: 'Claude accounts',
    icon: 'sparkles',
    render: () => ({ html: renderDashboard() }),
  };
}
