/**
 * The Claude panel: every seat with its usage and resets, the token history,
 * and (on demand) what runs on the seats right now.
 *
 * One document in a null-origin sandboxed iframe: no stylesheet fetch, no
 * storage, no dialogs, every interaction through `window.alfred.invoke`. The
 * look follows the Alfred app: the host copies its theme tokens into the
 * document under the UI's own names (`--color-*`, `--font-*`, `--radius-*`);
 * plugin-kit DESIGN_TOKENS map onto them, with their own palette as fallback.
 *
 * Layout: the page never scrolls. A one-line top bar (title, CLI, controls),
 * then two zones that share the height — stacked when the panel is narrow,
 * side by side when it is wide:
 *  - Seats: one compact row per seat (order ▲▼, name, status, 5h and week
 *    bars with their reset, tokens, today's API $, a "⋯" menu for everything
 *    else). Its header carries the key figures and a "N running" toggle that
 *    drops down the live turns with their Stop button.
 *  - Usage: a one-line totals strip, then ONE chart at a time, switched by a
 *    segmented control (Overview by seat / By seat / Hourly / Daily / Cost),
 *    with a tokens / $ switch, a seat selector and a period selector. The
 *    chart is drawn at the size of the space left.
 *
 * Rendering is incremental on purpose. The page polls `poolSnapshot` (local
 * state only, a few ms) with ONE self-rescheduling timeout — a slow or stalled
 * worker can never stack requests — faster while something runs, paused while
 * the panel is hidden. Rows are keyed: a row whose markup did not change is
 * not touched, so a token being typed, an armed Remove/Stop button or a hover
 * survives every poll (two-step buttons keep their armed state in the script
 * for the same reason). Durations and countdowns tick from one 1 s interval
 * that only rewrites the text that changed. The Usage zone has its own slow
 * poll and redraws only when its data changed (or a control moved).
 *
 * The client script lives inside a TS template literal: it uses no backticks,
 * no dollar-brace and no regex, so nothing is rewritten on the way out.
 */

import {
  DESIGN_TOKENS,
  ESC_FN_JS,
  PILL_CSS,
  invokeFnJs,
} from '@alfred/plugin-kit/webview';
import type { Webview } from '@alfred/sdk';

// Spacing on a 4 px grid; colours only from the design tokens (and the chart
// palette below); numbers in tabular figures, right-aligned.
const STYLES = `${DESIGN_TOKENS}${PILL_CSS}
:root { --r: var(--radius, 6px); --r-lg: var(--radius-lg, 8px); }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; padding: 12px; background: var(--bg); color: var(--text); overflow: hidden;
  font: 13px/1.4 var(--font, system-ui, sans-serif); font-feature-settings: 'cv11', 'ss01', 'ss03';
  display: flex; flex-direction: column; gap: 8px; }
h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
h2 { font-size: 13px; font-weight: 600; margin: 0; }
.top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; flex: none; }
.spacer { flex: 1; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.banner { border: 1px solid var(--border); border-left: 3px solid var(--warn); background: var(--panel);
  padding: 6px 12px; border-radius: var(--r); font-size: 12px; display: flex; gap: 8px; align-items: center; }
.banner.ok { border-left-color: var(--ok); }
.banner.err { border-left-color: var(--err); }
.banner .bt { flex: 1; word-break: break-word; }

/* two tabs, each the full width and the height left */
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); flex: none; min-width: 0; }
button.tab { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none;
  padding: 6px 12px; font-size: 13px; color: var(--muted); margin-bottom: -1px; }
button.tab:hover { color: var(--text); }
button.tab.on { color: var(--text); border-bottom-color: var(--accent-strong); font-weight: 600; }
.pane { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.zone { position: relative; min-height: 0; min-width: 0; display: flex; flex-direction: column; border: 1px solid var(--border);
  border-radius: var(--r-lg); background: var(--panel); }
.zone.grow { flex: 1; }
.zh { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 6px 12px; border-bottom: 1px solid var(--border);
  flex: none; min-width: 0; }
.zh .fig { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.zh .fig b { color: var(--text); font-weight: 500; }
.zb { min-height: 0; min-width: 0; overflow-y: auto; overflow-x: hidden; }
.facts { display: flex; gap: 16px; flex-wrap: wrap; padding: 6px 12px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--border); }
.facts b { color: var(--text); font-weight: 500; }

/* running toggle and its drop-down */
button.runs { display: inline-flex; gap: 6px; align-items: center; border-radius: 999px; padding: 1px 10px; font-size: 12px; }
button.runs .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
button.runs.on .dot { background: var(--accent); }
.drop { position: absolute; left: 8px; right: 8px; top: 38px; z-index: 5; max-height: 60vh; overflow: auto;
  border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--panel); box-shadow: 0 8px 24px var(--color-shadow, rgba(0,0,0,.25)); }

/* tables */
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; }
th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; white-space: nowrap; }
th { position: sticky; top: 0; z-index: 1; background: var(--panel); color: var(--muted); font-weight: 500; font-size: 11px; height: 24px; }
td { height: 26px; }
th.r, td.r { text-align: right; }
tbody tr:hover td { background: var(--panel-2); }
tbody tr:last-child td { border-bottom: none; }
tr.cur td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
tr.next td:first-child { box-shadow: inset 2px 0 0 var(--accent-strong); }
.tag.next { color: var(--accent-strong); border-color: currentColor; }
.pill { white-space: nowrap; }
tr.off td { opacity: .55; }
tr.sub td { background: var(--panel-2); }
tr.sub .what { padding-left: 24px; }
tr.menu td { background: var(--panel-2); white-space: normal; padding: 6px 8px; }
.empty { padding: 12px; text-align: center; color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.mono { font-family: var(--mono); font-size: 11px; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ell { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ell.s { max-width: 180px; }
td.name { width: 30%; max-width: 0; }
td.name > div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { display: inline-block; padding: 0 5px; border-radius: 4px; border: 1px solid var(--border);
  font-size: 10px; line-height: 15px; color: var(--muted); vertical-align: 1px; }
.tag.warn { color: var(--warn); border-color: currentColor; }
.tag.info { color: var(--accent); border-color: currentColor; }
.pos-v { color: var(--ok); }
.neg-v { color: var(--err); }

/* controls */
button { font: inherit; font-size: 12px; padding: 2px 10px; border-radius: var(--r);
  border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; white-space: nowrap; }
button:hover { border-color: var(--muted); }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--accent-strong); border-color: var(--accent-strong); color: var(--on-accent-strong); }
button.primary:hover { opacity: .9; }
button.danger:hover, button.armed { border-color: var(--err); color: var(--err); }
button.x { border: none; background: none; padding: 0 4px; color: var(--muted); }
button.dots { padding: 0 8px; font-size: 14px; line-height: 18px; }
.acts { display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
.field { font: inherit; font-size: 12px; padding: 2px 6px; border: 1px solid var(--border);
  border-radius: var(--r); background: var(--field); color: var(--text); }
input.field.n { width: 52px; }
label.in { display: flex; gap: 4px; align-items: center; font-size: 12px; color: var(--muted); }
.seg { display: inline-flex; }
.seg button { border-radius: 0; margin-left: -1px; padding: 2px 8px; }
.seg button:first-child { border-radius: var(--r) 0 0 var(--r); margin-left: 0; }
.seg button:last-child { border-radius: 0 var(--r) var(--r) 0; }
.seg button.on { background: var(--accent-strong); border-color: var(--accent-strong); color: var(--on-accent-strong); }

/* seat rows */
td.ord { width: 1%; padding-right: 0; }
.pos { display: inline-block; min-width: 12px; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 11px; }
button.mv { padding: 0 2px; font-size: 8px; line-height: 14px; border: none; background: none; color: var(--muted); }
button.mv:hover { color: var(--text); }
.meter { display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; }
.meter .p { min-width: 30px; text-align: right; font-variant-numeric: tabular-nums; }
.meter .w { color: var(--muted); font-size: 11px; }
.meter .when { color: var(--muted); font-size: 11px; }
.bar { position: relative; height: 6px; width: 56px; flex: none; border-radius: 999px; background: var(--panel-2); overflow: hidden; }
.bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--ok); }
.bar.warn > i { background: var(--warn); }
.bar.err > i { background: var(--err); }

/* usage */
.uviz { --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300;
  --s7: #4a3aa7; --s8: #e34948; --sunk: #a3a8b1; }
.uviz { --s9: #8c6d2c; --s10: #0e8a96; }
@media (prefers-color-scheme: dark) {
  .uviz { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300;
    --s7: #9085e9; --s8: #e66767; --sunk: #5d6573; --s9: #b8954a; --s10: #22a9b5; }
}
:root[data-theme="light"] .uviz { --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300;
  --s7: #4a3aa7; --s8: #e34948; --sunk: #a3a8b1; }
.uviz { --s9: #8c6d2c; --s10: #0e8a96; }
:root[data-theme="dark"] .uviz { --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300;
  --s7: #9085e9; --s8: #e66767; --sunk: #5d6573; --s9: #b8954a; --s10: #22a9b5; }
.t0, .a0 { fill: var(--s1); background: var(--s1); }
.t1, .a1 { fill: var(--s2); background: var(--s2); }
.t2, .a2 { fill: var(--s3); background: var(--s3); }
.t3, .a3 { fill: var(--s4); background: var(--s4); }
.a4 { fill: var(--s5); background: var(--s5); }
.a5 { fill: var(--s6); background: var(--s6); }
.a6 { fill: var(--s7); background: var(--s7); }
.a7 { fill: var(--s8); background: var(--s8); }
.a8 { fill: var(--s9); background: var(--s9); }
.a9 { fill: var(--s10); background: var(--s10); }
.aoth { fill: var(--muted); background: var(--muted); }
.aunk { fill: var(--sunk); background: var(--sunk); }
svg.chart { display: block; }
.chart .grid { stroke: var(--border); stroke-width: 1; }
.chart .ax { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.chart .hit { fill: transparent; }
.chart .col:hover rect:not(.hit) { opacity: .75; }
.strip { display: flex; gap: 12px; align-items: baseline; padding: 4px 12px; border-bottom: 1px solid var(--border);
  font-size: 12px; white-space: nowrap; overflow: hidden; flex: none; }
.strip .it { font-variant-numeric: tabular-nums; }
.strip .k { color: var(--muted); font-size: 11px; margin-right: 4px; }
.strip .big { font-size: 14px; font-weight: 600; }
.strip .parts { color: var(--muted); display: inline-flex; gap: 8px; }
.strip .parts b { color: var(--text); font-weight: 500; }
.ub { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; padding: 8px 12px; gap: 6px; }
/* Bounded: the strip, the chart and its legend fit the panel without a scroll. */
.uchart { flex: 1; min-height: 160px; min-width: 0; overflow: hidden; }
.chart .now { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 2 3; }
.chart .ln { fill: none; stroke-width: 1.5; stroke-linejoin: round; }
.chart .ln.proj { stroke-dasharray: 3 3; opacity: .7; }
.chart .lead { stroke-width: 1; opacity: .5; }
.chart .endl { font-size: 11px; }
.money { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.15; }
.stale { color: var(--warn); font-size: 11px; cursor: help; }
.tag.use { color: var(--warn); border-color: currentColor; }
td.c-week:empty::after { content: ''; }
.qbox { flex: 1; min-height: 140px; min-width: 0; overflow: hidden; padding: 4px 8px; }
.qrows { display: flex; flex-direction: column; gap: 4px; }
.qrow { display: flex; align-items: center; gap: 8px; min-width: 0; }
.qname { flex: none; width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.qreset { flex: none; width: 92px; text-align: right; white-space: nowrap; font-size: 12px; }
.qtrack { flex: none; display: block; }
.qleft { fill: var(--muted); opacity: .45; }
.qlose { fill: var(--warn); opacity: .8; }
.warn-t { color: var(--warn); }
.capnote { color: var(--muted); font-size: 12px; padding: 24px 0; text-align: center; }
.cu { fill: var(--s1); background: var(--s1); }
.cl { fill: var(--sunk); background: var(--sunk); }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--muted); flex: none; }
.sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: 0; }
.mults { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; height: 100%; overflow: auto; align-content: start; }
button.mult { display: flex; flex-direction: column; gap: 2px; width: 100%; min-width: 0; text-align: left; white-space: normal;
  padding: 6px 8px; background: var(--bg); border-radius: var(--r-lg); font-size: 11px; color: var(--text); }
button.mult.sel { border-color: var(--accent-strong); box-shadow: inset 0 0 0 1px var(--accent-strong); }
.mh { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.mh b { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mf { display: flex; justify-content: space-between; gap: 6px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.costs { display: grid; grid-template-columns: max-content minmax(60px, 1fr) max-content max-content max-content; gap: 6px 12px;
  align-items: center; font-size: 12px; font-variant-numeric: tabular-nums; }
.costs .cb { height: 10px; border-radius: 3px; }
.costs .r { text-align: right; }
.costs .sep { grid-column: 1 / -1; border-top: 1px solid var(--border); }

/* narrower panel: secondary columns and labels go, nothing scrolls sideways */
@media (max-width: 1300px) { .c-wide { display: none; } }
@media (max-width: 1000px) { .c-opt { display: none; } .bar { width: 40px; } }
@media (max-width: 600px) { .c-week { display: none; } }
@media (max-width: 720px) {
  .c-narrow { display: none; }
  .ell { max-width: 160px; }
  body { padding: 8px; }
  label.in span.lbl { display: none; }
}
[hidden] { display: none !important; }
`;

const SCRIPT = `
var invoke = ${invokeFnJs()};
var esc = ${ESC_FN_JS};
var $ = function (id) { return document.getElementById(id); };

var POLL_LIVE_MS = 2500;
var POLL_IDLE_MS = 8000;
var STALL_MS = { chat: 90000, request: 150000, run: 600000 };
var FINISHED_SHOWN = 6;

var snap = null;
var pollTimer = 0;
var polling = false;
var pollAgain = false;
var busy = {};
var openDetails = {};
var flashTimer = 0;
var rowHtml = {};
var actOpen = false;
// Two-step buttons (no confirm() in the sandbox). Kept here, not on the
// button, so the armed state survives a row being rebuilt by a poll.
var ARM_MS = 3000;
var armed = {};
var armTimer = 0;
var TYPE_NAMES = ['Input', 'Cache write', 'Cache read', 'Output'];

// ---- formatting -----------------------------------------------------------

function fmtTokens(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtUsd(v) {
  v = Number(v || 0);
  var neg = v < 0;
  v = Math.abs(v);
  var s = v >= 100 ? '$' + Math.round(v) : v >= 1 ? '$' + v.toFixed(1) : v >= 0.005 ? '$' + v.toFixed(2) : v > 0 ? '<$0.01' : '$0';
  return neg ? '\\u2212' + s : s;
}
function pct(part, whole) { return whole > 0 ? Math.round(100 * part / whole) + '%' : '\\u2014'; }
function fmtDur(ms) {
  if (!(ms >= 0)) return '';
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  var h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
function fmtLeft(at) {
  if (!at) return '';
  var d = at - Date.now();
  if (d <= 0) return 'now';
  var m = Math.ceil(d / 60000);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}
function fmtWhen(at) {
  if (!at) return '';
  var d = new Date(at);
  var day = d.toLocaleDateString(undefined, { weekday: 'short' });
  return day + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function fmtClock(at) {
  return at ? new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}
function shortModel(m) {
  m = String(m || '');
  return m.indexOf('claude-') === 0 ? m.slice(7) : m;
}
function sumIn(t) { return t ? t.input + t.cacheRead + t.cacheWrite : 0; }
function tallyTitle(name, t) {
  if (!t) return '';
  return name + ': ' + t.requests + ' req, out ' + fmtTokens(t.output) + ', in ' + fmtTokens(t.input)
    + ', cache read ' + fmtTokens(t.cacheRead) + ', cache write ' + fmtTokens(t.cacheWrite)
    + ', API-equiv ' + fmtUsd(t.costUsd);
}
// [tokens x4] + [usd x4] -> the four lines of a breakdown, with shares.
function breakdownLines(tok, usd) {
  var tt = tok[0] + tok[1] + tok[2] + tok[3];
  var tu = usd[0] + usd[1] + usd[2] + usd[3];
  var out = [];
  for (var i = 0; i < 4; i++) {
    out.push(TYPE_NAMES[i] + ': ' + fmtTokens(tok[i]) + ' tok (' + pct(tok[i], tt) + ') \\u00b7 ' + fmtUsd(usd[i]) + ' (' + pct(usd[i], tu) + ')');
  }
  out.push('Total: ' + fmtTokens(tt) + ' tok \\u00b7 ' + fmtUsd(tu) + ' API-equiv');
  return out;
}
// Ticking text: rewritten by tick(), never part of a row's markup.
function live(kind, a, b) {
  return '<span data-t="' + kind + '" data-a="' + (a || '') + '" data-b="' + (b || '') + '"></span>';
}

// ---- data -----------------------------------------------------------------

function call(action, args) {
  return invoke(action, args || {}).then(function (r) {
    if (r && r.ok === false) throw new Error(r.error || 'failed');
    return r || {};
  });
}

function schedule(ms) {
  clearTimeout(pollTimer);
  pollTimer = 0;
  if (document.hidden) return;
  pollTimer = setTimeout(poll, ms);
}

function liveCount() {
  if (!snap || !snap.activity) return 0;
  return snap.activity.filter(function (a) { return isLive(a.status); }).length;
}

function poll() {
  clearTimeout(pollTimer);
  pollTimer = 0;
  if (polling) { pollAgain = true; return Promise.resolve(); }
  polling = true;
  return call('poolSnapshot').then(function (r) {
    snap = r;
    setConn('');
    render();
  }, function (err) {
    setConn(String(err && err.message || err));
  }).then(function () {
    polling = false;
    if (pollAgain) { pollAgain = false; return poll(); }
    schedule(liveCount() ? POLL_LIVE_MS : POLL_IDLE_MS);
  });
}

function setConn(text) {
  var el = $('conn');
  el.hidden = !text;
  el.title = text;
}

function isArmed(key) { return armed[key] > Date.now(); }
// True on the first click (now armed), false on the confirming one.
function arm(key) {
  if (isArmed(key)) { delete armed[key]; render(); return false; }
  armed[key] = Date.now() + ARM_MS;
  clearTimeout(armTimer);
  armTimer = setTimeout(function () { armed = {}; render(); }, ARM_MS + 50);
  render();
  return true;
}
function armBtn(act, id, label, armedLabel, extra) {
  var key = act + ':' + id;
  var on = isArmed(key);
  return '<button class="danger' + (on ? ' armed' : '') + '" data-act="' + act + '" data-id="' + esc(id) + '"'
    + (busy[key] ? ' disabled' : '') + (extra || '') + '>' + (on ? armedLabel : label) + '</button>';
}

function flash(kind, text) {
  clearTimeout(flashTimer);
  $('flash').innerHTML = text
    ? '<div class="banner ' + kind + '"><span class="bt">' + esc(text) + '</span><button class="x" data-act="flash-close" title="Dismiss">\\u00d7</button></div>'
    : '';
  if (text && kind === 'ok') flashTimer = setTimeout(function () { flash('', ''); }, 6000);
}

// ---- keyed rows -----------------------------------------------------------

var scratch = document.createElement('tbody');

// rows: [{ key, html }]. A row is rebuilt only when its markup changed.
function sync(tbody, rows) {
  var have = {};
  Array.prototype.slice.call(tbody.children).forEach(function (tr) { have[tr.getAttribute('data-key')] = tr; });
  var prev = null;
  rows.forEach(function (r) {
    var tr = have[r.key];
    if (tr && rowHtml[r.key] !== r.html) { tr.remove(); tr = null; }
    if (!tr) {
      scratch.innerHTML = r.html;
      tr = scratch.firstElementChild;
      tr.setAttribute('data-key', r.key);
      rowHtml[r.key] = r.html;
    }
    delete have[r.key];
    var want = prev ? prev.nextSibling : tbody.firstChild;
    if (want !== tr) tbody.insertBefore(tr, want);
    prev = tr;
  });
  Object.keys(have).forEach(function (k) { have[k].remove(); delete rowHtml[k]; });
}

function setText(id, text) {
  var el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
}
function setHtml(id, html) {
  var el = $(id);
  if (el && rowHtml['#' + id] !== html) { el.innerHTML = html; rowHtml['#' + id] = html; }
}
function setClass(el, cls) { if (el && el.className !== cls) el.className = cls; }

// ---- activity (the "N running" drop-down) -----------------------------------

var LIVE = { starting: 1, running: 1, tool: 1, compacting: 1, retrying: 1 };
function isLive(s) { return LIVE[s] === 1; }
var ACT_PILL = { starting: 'info', running: 'info', tool: 'info', compacting: 'warn', retrying: 'warn', done: 'ok', failed: 'err',
  limit: 'err', timeout: 'err', interrupted: 'idle', cancelled: 'idle', stopped: 'warn' };
var SUB_PILL = { running: 'info', completed: 'ok', failed: 'err', cancelled: 'idle', stopped: 'warn' };
var KIND_TAG = { chat: 'cli', run: 'session', request: 'turn' };
var STATUS_LABEL = { tool: 'tools' };
var IT_PILL = { running: 'info', done: 'ok', failed: 'err', cancelled: 'idle', stopped: 'warn' };
var openIters = {};

function timeCell(startedAt, endedAt) {
  return endedAt
    ? '<span class="num">' + fmtDur(endedAt - startedAt) + '</span> <span class="muted small">' + live('ago', endedAt) + '</span>'
    : '<span class="num">' + live('since', startedAt) + '</span>';
}

function turnTitle(a) {
  // Engine turns: who works, for whom, on what. The raw prompt is the title's last part only.
  var who = a.agent || '';
  if (a.from) who += (who ? ' \\u2190 ' : '\\u2190 ') + a.from;
  var what = (a.taskId ? a.taskId + ' ' : '') + (a.title || '');
  return { who: who, what: what };
}

function costCell(a) {
  if (!a.tokens) return '';
  if (!a.cost) return '<span class="muted" title="' + esc('No list price for ' + (a.servedModel || a.model || 'this model')) + '">unpriced</span>';
  var usd = a.cost[0] + a.cost[1] + a.cost[2] + a.cost[3];
  var lines = [shortModel(a.servedModel || a.model) + ' at API list price'].concat(breakdownLines(a.tokens, a.cost));
  if (a.costApprox) lines.push('Uncached prompt counted as cache write.');
  return '<span class="num" title="' + esc(lines.join('\\n')) + '">' + fmtUsd(usd) + '</span>';
}

function activityRows(list) {
  var now = Date.now();
  var rows = [];
  list.forEach(function (a) {
    var running = isLive(a.status);
    // A turn waiting on its tools is not stalled: the host is working.
    var stalled = running && a.status !== 'tool' && now - a.lastEventAt > (STALL_MS[a.kind] || 120000);
    var status = stalled ? 'stalled' : (STATUS_LABEL[a.status] || a.status);
    var pill = '<span class="pill ' + (stalled ? 'warn' : ACT_PILL[a.status] || 'idle') + '"'
      + (stalled ? ' title="No event for ' + esc(fmtDur(now - a.lastEventAt)) + '"' : '') + '>' + esc(status) + '</span>'
      + (a.loop ? ' <span class="pill err" title="Same tool calls with identical arguments ' + a.loop.streak + ' times in a row: '
        + esc(a.loop.tools.join(', ')) + '">loop \\u00d7' + a.loop.streak + '</span>' : '');
    var subRun = a.subagents.filter(function (s) { return s.status === 'running'; }).length;
    var tt = turnTitle(a);
    var meta = [];
    if (a.kind === 'request') {
      if (a.iterations) meta.push(a.iterations + (a.iterations === 1 ? ' iteration' : ' iterations'));
      if (running && a.phase) meta.push('<span>' + esc(a.phase) + '</span>');
      else if (a.status === 'tool' && a.detail) meta.push('<span>running ' + esc(a.detail) + '</span>');
      else if (a.lastTool) meta.push('last tool ' + esc(a.lastTool));
      if (!running && a.detail) meta.push('<span class="muted">' + esc(a.detail) + '</span>');
    } else {
      if (a.agent) meta.push(esc(a.agent));
      if (a.subagents.length) meta.push(subRun + '/' + a.subagents.length + ' sub-agents running');
      if (a.detail) meta.push('<span class="' + (running ? '' : 'muted') + '">' + esc(a.detail) + '</span>');
    }
    var model = shortModel(a.servedModel || a.model);
    var ctx = a.contextUsed ? fmtTokens(a.contextUsed) + (a.contextWindow ? ' / ' + fmtTokens(a.contextWindow) : '') : '';
    var tok = (a.tokensOut != null ? fmtTokens(a.tokensOut) + ' out' : '') + (a.tokensIn ? ' \\u00b7 ' + fmtTokens(a.tokensIn) + ' in' : '');
    var iters = a.iterationList || [];
    var canOpen = a.kind === 'request' && iters.length > 0;
    var open = canOpen && openIters[a.id];
    var head = a.kind === 'request' && tt.who
      ? '<b>' + esc(tt.who) + '</b> \\u00b7 ' + esc(tt.what)
      : esc(a.title);
    var html = '<tr class="' + (running ? 'cur' : '') + '">'
      + '<td>' + pill + '</td>'
      + '<td><div class="ell" title="' + esc((tt.who ? tt.who + ' \\u00b7 ' : '') + tt.what) + '">'
      + (canOpen ? '<button class="x" data-act="iters" data-id="' + esc(a.id) + '" title="Show the requests of this turn">' + (open ? '\\u25be' : '\\u25b8') + '</button>' : '')
      + '<span class="tag">' + KIND_TAG[a.kind] + '</span> ' + head + '</div>'
      + (meta.length ? '<div class="muted small ell" title="' + esc(a.detail || a.phase || '') + '">' + meta.join(' \\u00b7 ') + '</div>' : '') + '</td>'
      + '<td class="c-opt"><span class="mono" title="' + esc(a.model || '') + (a.servedModel ? ' \\u2192 ' + esc(a.servedModel) : '') + '">' + esc(model) + '</span>'
      + (a.effort ? ' <span class="tag">' + esc(a.effort) + '</span>' : '') + '</td>'
      + '<td class="c-opt">' + (a.seat ? esc(a.seat) : running ? '<span class="muted">no seat yet</span>' : '') + '</td>'
      + '<td class="r num small">' + tok + (ctx ? '<div class="muted" title="Context used">ctx ' + ctx + '</div>' : '') + '</td>'
      + '<td class="r">' + costCell(a) + '</td>'
      + '<td class="r">' + timeCell(a.startedAt, a.endedAt) + '</td>'
      + '<td><div class="acts">' + (a.canStop ? armBtn('stop', a.id, 'Stop', 'Confirm stop') : '') + '</div></td>'
      + '</tr>';
    rows.push({ key: 'a:' + a.id, html: html });
    if (open) {
      iters.slice().reverse().forEach(function (i) {
        var what = i.tools.length ? 'called ' + i.tools.join(', ') : i.status === 'running' ? (i.phase || 'running') : 'answered';
        rows.push({ key: 'i:' + a.id + ':' + i.n, html: '<tr class="sub">'
          + '<td><span class="pill ' + (IT_PILL[i.status] || 'idle') + '">' + esc(i.status) + '</span></td>'
          + '<td class="what"><div class="ell">\\u21b3 #' + i.n + ' ' + esc(what) + '</div></td>'
          + '<td class="c-opt"></td><td class="c-opt">' + esc(i.seat || '') + '</td>'
          + '<td class="r num small">' + (i.tokensOut ? fmtTokens(i.tokensOut) + ' out' : '') + '</td><td></td>'
          + '<td class="r">' + timeCell(i.startedAt, i.endedAt) + '</td><td></td></tr>' });
      });
    }
    a.subagents.forEach(function (s) {
      var line = s.summary || s.lastTool || '';
      rows.push({ key: 's:' + a.id + ':' + s.id, html: '<tr class="sub">'
        + '<td><span class="pill ' + (SUB_PILL[s.status] || 'idle') + '">' + esc(s.status) + '</span></td>'
        + '<td class="what"><div class="ell" title="' + esc(s.description || '') + '">\\u21b3 <b>' + esc(s.type || 'sub-agent') + '</b>'
        + (s.background ? ' <span class="tag">bg</span>' : '') + ' ' + esc(s.description || '') + '</div>'
        + (line ? '<div class="muted small ell" title="' + esc(line) + '">' + esc(line) + '</div>' : '') + '</td>'
        + '<td class="c-opt"></td><td class="c-opt"></td><td></td><td></td>'
        + '<td class="r">' + timeCell(s.startedAt, s.endedAt) + '</td><td></td></tr>' });
    });
  });
  return rows;
}

// ---- seats ----------------------------------------------------------------

var STATE_PILL = { ready: 'ok', 'in use': 'info', throttled: 'info', exhausted: 'warn', disabled: 'idle', 'logged out': 'err', 'auth failed': 'err' };
var PLAN_SHORT = { 'Team standard': 'STD', 'Team premium': 'PRM', 'Max 20x': 'MAX', 'Max 5x': 'MAX5', Pro: 'PRO' };

function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
function inMin(at) { return fmtLeft(at); }
function windowOf(a, key) {
  var u = a.usage || { windows: [] };
  return u.windows.filter(function (w) { return w.key === key && !w.model; })[0] || null;
}
function leftOf(w) { return w && w.percent != null ? Math.max(0, 100 - Math.min(100, w.percent)) : null; }

// One state per seat, consistent with its numbers: a window at 100% is exhausted
// whatever the pool has not noticed yet.
function seatState(a) {
  var now = Date.now();
  var five = windowOf(a, 'five_hour');
  var week = windowOf(a, 'seven_day');
  if (!a.enabled) return { state: 'disabled' };
  if (a.status === 'logged out' || a.status === 'auth failed') return { state: a.status };
  var full = [five, week].filter(function (w) { return w && w.percent != null && w.percent >= 100 && w.resetsAt && w.resetsAt > now; });
  var back = a.exhaustedUntil && a.exhaustedUntil > now ? a.exhaustedUntil : 0;
  full.forEach(function (w) { if (w.resetsAt > back) back = w.resetsAt; });
  if (back) return { state: 'exhausted', back: back };
  // A short sit-out after a transient failure: the seat keeps its quota.
  if (a.throttledUntil && a.throttledUntil > now) return { state: 'throttled', back: a.throttledUntil };
  if (a.inFlight > 0 || a.status === 'active') return { state: 'in use' };
  return { state: 'ready' };
}

// "39% left, 03:58 (in 21m)" with a bar that empties.
function leftMeter(w, threshold, dated) {
  if (!w) return '';
  var left = leftOf(w);
  var spare = 100 - threshold;
  var cls = left == null ? '' : left <= spare ? 'err' : left <= spare + 15 ? 'warn' : '';
  var when = w.resetsAt
    ? (dated ? esc(fmtWhen(w.resetsAt)) : esc(fmtClock(w.resetsAt))) + '<span class="c-wide"> (in ' + live('left', w.resetsAt) + ')</span>'
    : '';
  return '<span class="meter" title="' + esc((left == null ? '?' : left + '% left') + (w.resetsAt ? ', resets ' + fmtWhen(w.resetsAt) : '')) + '">'
    + '<span class="bar ' + cls + '"><i style="width:' + (left || 0) + '%"></i></span>'
    + '<span class="p">' + (left == null ? '?' : Math.round(left) + '%') + '</span>'
    + '<span class="when">' + when + '</span></span>';
}

// This month's API-equivalent value of one seat.
function monthOf(id) {
  var t = 0;
  if (!usage || !usage.daily || !usage.daily[id]) return 0;
  usage.days.forEach(function (d, i) { if (d >= usage.monthStart) t += usdOf(usage.daily[id][i]); });
  return t;
}

function todayOf(id) {
  if (!usage || !usage.daily || !usage.daily[id] || !usage.days || !usage.days.length) return null;
  var i = usage.days.length - 1;
  return usage.days[i] === dayKey(new Date()) ? usage.daily[id][i] : null;
}
var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch (e) { return 'local time'; } })();

// The advisor on this seat, as the CLI reported it (null: not seen yet, or off).
var ADVISOR_TAG = { active: 'info', unavailable: 'warn', incompatible: 'warn' };
function advisorPill(ad) {
  if (!ad || !ad.state) return '';
  var name = shortModel(ad.model || '');
  var title = 'Advisor ' + (name || '') + ': ' + ad.state + (ad.reason ? '\\n' + ad.reason : '') + (ad.at ? '\\nseen ' + fmtWhen(ad.at) : '');
  var text = ad.state === 'active' ? 'advisor' : ad.state === 'unavailable' ? 'no advisor' : 'advisor \\u2715';
  return ' <span class="tag ' + (ADVISOR_TAG[ad.state] || '') + '" title="' + esc(title) + '">' + text + '</span>';
}

// Seats in the order the panel shows them: the manual order, or the soonest 5h reset first.
function seatOrder(s) {
  var list = s.accounts.slice();
  if (s.settings.seatSort !== 'reset') return list;
  var key = function (a) { var w = windowOf(a, 'five_hour'); return w && w.resetsAt && w.resetsAt > Date.now() ? w.resetsAt : Infinity; };
  return list.sort(function (x, y) { return key(x) - key(y); });
}

function seatRows(s) {
  var rows = [];
  var byEmail = {};
  s.accounts.forEach(function (a) { if (a.email) (byEmail[a.email] = byEmail[a.email] || []).push(a.label); });
  var manual = s.settings.seatSort !== 'reset';
  var list = seatOrder(s);
  var last = s.accounts.length - 1;
  var now = Date.now();
  list.forEach(function (a) {
    var i = s.accounts.indexOf(a);
    var u = a.usage || { windows: [] };
    var five = windowOf(a, 'five_hour');
    var week = windowOf(a, 'seven_day');
    var scoped = u.windows.filter(function (w) { return w.model; });
    var plan = usage && usage.plans ? usage.plans[a.id] : null;
    var st = seatState(a);
    var isNext = s.next && s.next.id === a.id;
    var bz = function (act) { return busy[act + ':' + a.id] ? ' disabled' : ''; };
    var needsLogin = st.state === 'logged out' || st.state === 'auth failed';
    // A lot left and lost soon: say so.
    var fl = leftOf(five);
    var urgent = st.state !== 'exhausted' && five && five.resetsAt && fl != null && fl >= 20 && five.resetsAt - now < 90 * 60000;
    var nameTitle = [a.label, a.email || a.id, a.orgName || '', plan ? plan.label + ' ($' + plan.monthlyUsd + '/month)' : (a.subscriptionType || '')]
      .concat(scoped.map(function (w) { return 'Weekly ' + cap(w.model) + ' limit: ' + (leftOf(w) == null ? '?' : leftOf(w) + '% left') + (w.resetsAt ? ', resets ' + fmtWhen(w.resetsAt) : ''); }))
      .filter(Boolean).join('\\n');
    var stale = u.stale
      ? ' <span class="stale" title="' + esc('Usage not refreshed for ' + fmtDur(now - (u.fetchedAt || now)) + ' (' + u.stale + '): the bars may be behind') + '">\\u25f7</span>'
      : '';
    var status = '<span class="pill ' + (STATE_PILL[st.state] || 'idle') + '" title="' + esc(a.statusDetail || '') + '">' + esc(st.state)
      + (st.back ? ' \\u00b7 back ' + esc(fmtClock(st.back)) + '<span class="c-wide"> (in ' + live('left', st.back) + ')</span>' : '') + '</span>'
      + (a.inFlight ? ' <span class="tag info" title="Requests running">' + a.inFlight + '</span>' : '') + stale;
    var sp = usage && usage.seatSpend ? usage.seatSpend[a.id] : null;
    var today = todayOf(a.id);
    var money = '<div class="money"><span class="num" title="' + esc(sp && sp.fiveFrom ? 'API-equivalent value of this seat\\x27s current 5h window, from ' + fmtClock(sp.fiveFrom) + ' (reset minus 5h) to now' : 'No 5h window known') + '">'
      + (sp && sp.fiveFrom ? fmtUsd(sp.fiveUsd) : '\\u2014') + '</span>'
      + '<span class="num muted small" title="' + esc('Today, ' + TZ + ', since 00:00' + (today ? '\\n' + cellBreakdown(today).join('\\n') : '')) + '">'
      + (today ? fmtUsd(usdOf(today)) : '$0') + ' today</span></div>';
    var html = '<tr class="' + (st.state === 'in use' ? 'cur' : '') + (isNext ? ' next' : '') + (a.enabled ? '' : ' off') + '">'
      + '<td class="ord c-narrow" title="' + (manual ? 'Seat order: breaks ties, and the order of use for fill' : 'Sorted by reset: switch to the manual order to move seats') + '"><span class="pos">' + (i + 1) + '</span>'
      + (manual ? '<button class="mv" data-act="up" data-id="' + esc(a.id) + '"' + (i === 0 || bz('order') ? ' disabled' : '') + ' title="Move up">\\u25b2</button>'
        + '<button class="mv" data-act="down" data-id="' + esc(a.id) + '"' + (i === last || bz('order') ? ' disabled' : '') + ' title="Move down">\\u25bc</button>' : '') + '</td>'
      + '<td class="name"><div title="' + esc(nameTitle) + '"><i class="sw ' + accClass(a.id) + '"></i><b>' + esc(a.label) + '</b>'
      + (plan ? ' <span class="tag">' + esc(PLAN_SHORT[plan.label] || plan.label) + '</span>' : '')
      + (isNext ? ' <span class="tag next">next</span>' : '')
      + advisorPill(a.advisor)
      + ((byEmail[a.email] || []).length > 1 ? ' <span class="tag warn" title="Two seats on one Claude login share one quota">same login as ' + esc(byEmail[a.email].filter(function (l) { return l !== a.label; }).join(', ')) + '</span>' : '')
      + (urgent ? ' <span class="tag use" title="' + esc(fl + '% of the 5h window is lost at ' + fmtClock(five.resetsAt) + ' if not used') + '">use before ' + esc(fmtClock(five.resetsAt)) + '</span>' : '')
      + '</div></td>'
      + '<td>' + status + '</td>'
      + '<td>' + (leftMeter(five, s.settings.threshold, false) || '<span class="muted">\\u2014</span>') + '</td>'
      + '<td class="c-week">' + (week ? leftMeter(week, s.settings.threshold, true) : '') + '</td>'
      + '<td class="r">' + money + '</td>'
      + '<td><div class="acts">'
      + (needsLogin ? '<button class="primary" data-act="login" data-id="' + esc(a.id) + '"' + bz('login') + '>Log in</button>' : '')
      + '<button class="dots" data-act="more" data-id="' + esc(a.id) + '" title="' + (openDetails[a.id] ? 'Close' : 'Actions') + '">\\u22ef</button>'
      + '</div></td></tr>';
    rows.push({ key: 'acc:' + a.id, html: html });
    if (openDetails[a.id]) {
      var err = a.lastError ? '<span class="muted small" title="' + esc(a.lastError.message) + '">' + esc(fmtClock(a.lastError.at) + ' ' + a.lastError.message) + '</span>' : '';
      rows.push({ key: 'det:' + a.id, html: '<tr class="menu"><td colspan="7"><div class="row">'
        + '<button data-act="refresh" data-id="' + esc(a.id) + '"' + bz('refresh') + ' title="Refresh usage">Refresh</button>'
        + '<button data-act="test" data-id="' + esc(a.id) + '"' + bz('test') + ' title="Tiny completion on this seat">Test</button>'
        + (needsLogin ? '' : '<button data-act="login" data-id="' + esc(a.id) + '"' + bz('login') + '>Log in again</button>')
        + '<button data-act="toggle" data-id="' + esc(a.id) + '"' + bz('toggle') + '>' + (a.enabled ? 'Disable' : 'Enable') + '</button>'
        + (i === 0 ? '' : '<button data-act="top" data-id="' + esc(a.id) + '"' + bz('order') + '>Move to top</button>')
        + '<button data-act="pin" data-id="' + esc(a.id) + '"' + bz('pin') + '>' + (a.exposeModels ? 'Unpin models' : 'Pin models') + '</button>'
        + (a.exhaustedUntil || a.throttledUntil ? '<button data-act="clear" data-id="' + esc(a.id) + '"' + bz('clear') + ' title="Put the seat back in rotation now">Clear limit</button>' : '')
        + '<input type="password" class="field" style="flex:1;min-width:140px" placeholder="claude setup-token (empty = use login)" id="tokv-' + esc(a.id) + '">'
        + '<button data-act="savetoken" data-id="' + esc(a.id) + '"' + bz('savetoken') + '>Save token</button>'
        + armBtn('remove', a.id, 'Remove', 'Confirm remove')
        + '</div>' + (err ? '<div style="margin-top:4px" class="small">Last error: ' + err + '</div>' : '') + '</td></tr>' });
    }
  });
  // History the pool no longer has a seat for: so that the rows add up to the header.
  var extra = unattributedToday(s);
  if (extra > 0) {
    rows.push({ key: 'acc:~unattributed', html: '<tr class="off"><td class="ord c-narrow"></td><td class="name"><div title="Removed seats, and usage no transcript ties to a seat"><i class="sw aunk"></i>unattributed</div></td>'
      + '<td></td><td></td><td class="c-week"></td><td class="r"><div class="money"><span class="num">\\u2014</span><span class="num muted small">' + fmtUsd(extra) + ' today</span></div></td><td></td></tr>' });
  }
  return rows;
}

// Today's value of the history rows that are not a seat of the pool.
function unattributedToday(s) {
  if (!usage || !usage.daily) return 0;
  var ids = {};
  s.accounts.forEach(function (a) { ids[a.id] = 1; });
  var t = 0;
  Object.keys(usage.daily).forEach(function (k) {
    if (ids[k]) return;
    var c = todayOf(k);
    if (c) t += usdOf(c);
  });
  return t;
}

// The header: exactly the sums of the rows.
function seatTotals(s) {
  var five = 0;
  var today = unattributedToday(s);
  s.accounts.forEach(function (a) {
    var sp = usage && usage.seatSpend ? usage.seatSpend[a.id] : null;
    if (sp && sp.fiveFrom) five += sp.fiveUsd;
    var c = todayOf(a.id);
    if (c) today += usdOf(c);
  });
  return { five: five, today: today };
}

// ---- line charts (quota over time, cumulative usage) ------------------------

// End-of-line labels: wanted y positions, spread so that no two are closer
// than gap, kept inside [top, bottom]. Returns the y of each label, same order.
function spreadLabels(ys, gap, top, bottom) {
  var idx = ys.map(function (y, i) { return i; }).sort(function (a, b) { return ys[a] - ys[b]; });
  var out = ys.slice();
  var prev = -Infinity;
  idx.forEach(function (i) { out[i] = Math.max(ys[i], prev + gap, top); prev = out[i]; });
  // Pushed past the bottom: walk back up.
  var next = Infinity;
  for (var k = idx.length - 1; k >= 0; k--) {
    var i = idx[k];
    out[i] = Math.min(out[i], next - gap, bottom);
    next = out[i];
  }
  return out;
}

// series: [{ id, label, color, pts: [[x, y]...] (solid), proj: [[x, y]...] (dashed), endText }]
// o: { w, h, x0, x1, yMax, yFmt, xLabel(x), now, slices, sliceTitle(x) }
// Text cut to a width in px (11px font, ~6.2px per character), with an ellipsis.
function fitText(t, px) {
  var n = Math.max(3, Math.floor(px / 6.2));
  return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
}

function lineChart(series, o) {
  var W = Math.max(120, Math.round(o.w || 720));
  var H = Math.max(80, Math.round(o.h || 200));
  var labelW = Math.min(170, Math.max(90, Math.round(W * 0.18)));
  var padL = 40;
  var padR = labelW + 6;
  var padT = 8;
  var padB = 16;
  var plotW = W - padL - padR;
  var plotH = H - padT - padB;
  var x0 = o.x0;
  var x1 = o.x1 > o.x0 ? o.x1 : o.x0 + 1;
  var yMax = o.yMax > 0 ? o.yMax : 1;
  var X = function (x) { return padL + plotW * (x - x0) / (x1 - x0); };
  var Y = function (y) { return padT + plotH - plotH * Math.max(0, Math.min(yMax, y)) / yMax; };
  var out = '<svg class="chart lines" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || '') + '">';
  // Few gridlines.
  var gstep = niceStep(yMax, Math.max(2, Math.min(4, Math.floor(plotH / 60))));
  for (var g = 0; gstep > 0 && g * gstep <= yMax + 1e-9; g++) {
    var gy = Y(g * gstep).toFixed(1);
    out += '<line class="grid" x1="' + padL + '" x2="' + (padL + plotW) + '" y1="' + gy + '" y2="' + gy + '"/>'
      + '<text class="ax" x="' + (padL - 5) + '" y="' + (Number(gy) + 3) + '" text-anchor="end">' + esc(o.yFmt(g * gstep)) + '</text>';
  }
  // X labels.
  var ticks = Math.max(2, Math.floor(plotW / 90));
  for (var t = 0; t <= ticks; t++) {
    var xv = x0 + (x1 - x0) * t / ticks;
    out += '<text class="ax" x="' + X(xv).toFixed(1) + '" y="' + (H - 3) + '" text-anchor="' + (t === 0 ? 'start' : t === ticks ? 'end' : 'middle') + '">' + esc(o.xLabel(xv)) + '</text>';
  }
  if (o.now && o.now > x0 && o.now < x1) {
    var nx = X(o.now).toFixed(1);
    out += '<line class="now" x1="' + nx + '" x2="' + nx + '" y1="' + padT + '" y2="' + (padT + plotH) + '"/>'
      + '<text class="ax" x="' + nx + '" y="' + (padT + 8) + '" text-anchor="middle">now</text>';
  }
  var ends = [];
  series.forEach(function (sr) {
    var pts = sr.pts.filter(function (p) { return p[0] >= x0 && p[0] <= x1; });
    if (pts.length) {
      out += '<polyline class="ln" style="stroke:' + sr.color + '" points="' + pts.map(function (p) { return X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' ') + '"/>';
    }
    if (sr.proj && sr.proj.length) {
      out += '<polyline class="ln proj" style="stroke:' + sr.color + '" points="' + sr.proj.map(function (p) { return X(Math.min(x1, p[0])).toFixed(1) + ',' + Y(p[1]).toFixed(1); }).join(' ') + '"/>';
    }
    var last = pts.length ? pts[pts.length - 1] : null;
    if (last) ends.push({ sr: sr, y: Y(last[1]), x: X(last[0]) });
  });
  var ly = spreadLabels(ends.map(function (e) { return e.y; }), 12, padT + 4, padT + plotH);
  ends.forEach(function (e, i) {
    var lx = padL + plotW + 6;
    out += '<line class="lead" style="stroke:' + e.sr.color + '" x1="' + (padL + plotW).toFixed(1) + '" x2="' + (lx - 2) + '" y1="' + e.y.toFixed(1) + '" y2="' + ly[i].toFixed(1) + '"/>'
      + '<text class="endl" data-sid="' + esc(e.sr.id) + '" x="' + lx + '" y="' + (ly[i] + 3).toFixed(1) + '" style="fill:' + e.sr.color + '">' + esc(fitText(e.sr.label + (e.sr.endText ? ' ' + e.sr.endText : ''), labelW - 8)) + '</text>';
  });
  // Hover: one slice per step, its title lists every series at that instant.
  var n = Math.max(1, o.slices || 48);
  for (var k = 0; k < n; k++) {
    var xa = x0 + (x1 - x0) * k / n;
    var xb = x0 + (x1 - x0) * (k + 1) / n;
    out += '<g class="col"><title>' + esc(o.sliceTitle((xa + xb) / 2)) + '</title><rect class="hit" x="' + X(xa).toFixed(1) + '" y="' + padT + '" width="' + (X(xb) - X(xa)).toFixed(1) + '" height="' + plotH + '"/></g>';
  }
  return out + '</svg>';
}

// The value of a step series (readings [[t, v]...]) at time t: the last reading at or before it.
function stepAt(list, t) {
  var v = null;
  for (var i = 0; i < list.length && list[i][0] <= t; i++) v = list[i][1];
  return v;
}

// Readings as a step line: flat until the next reading, then straight to it,
// so a reset is a sharp drop.
function stepPoints(list, until) {
  var pts = [];
  list.forEach(function (p, i) {
    if (i > 0) pts.push([p[0], list[i - 1][1]]);
    pts.push([p[0], p[1]]);
  });
  if (list.length && until > list[list.length - 1][0]) pts.push([until, list[list.length - 1][1]]);
  return pts;
}

var qWin = 'five';
// Columns reserved around the time track, in px: the name, the reset time.
var Q_NAME_W = 118;
var Q_RESET_W = 92;

// One row per seat, sorted by reset: name, the % used over what was recorded,
// then a bar from now to the reset whose thickness is the quota left (warning
// colour when a lot is lost soon), the reset time. One time axis for all rows.
function quotaView(size) {
  if (!snap || !usage || !usage.quota) return { html: '<div class="capnote">No quota reading yet.</div>', note: '' };
  var now = Date.now();
  var key = qWin === 'five' ? 'five' : 'week';
  var span = qWin === 'five' ? 24 * 3600000 : 8 * 24 * 3600000;
  var rows = [];
  var first = now;
  var furthest = now;
  snap.accounts.forEach(function (a) {
    var q = usage.quota.series[a.id];
    if (!q) return;
    var list = (q[key] || []).filter(function (p) { return p[0] >= now - span; });
    var reset = qWin === 'five' ? q.fiveReset : q.weekReset;
    if (!list.length && !reset) return;
    if (list.length && list[0][0] < first) first = list[0][0];
    if (reset && reset > furthest) furthest = reset;
    var cur = list.length ? list[list.length - 1][1] : null;
    rows.push({ a: a, list: list, reset: reset && reset > now ? reset : null, cur: cur });
  });
  if (!rows.length) return { html: '<div class="capnote">No quota reading yet: they are recorded at each usage refresh.</div>', note: '' };
  rows.sort(function (x, y) { return (x.reset || Infinity) - (y.reset || Infinity); });
  var hist = now - first;
  var note = hist < 3600000 ? 'collecting since ' + fmtClock(first) : '';
  var x0 = first;
  var x1 = Math.max(furthest, now + 60000);
  var big = size.w >= 900 && hist >= 6 * 3600000 && uChart === 'lines';
  if (big) return { html: quotaLines(rows, size, x0, x1, now), note: note };
  var trackW = Math.max(60, Math.floor(size.w - Q_NAME_W - Q_RESET_W - 16));
  var rowH = 24;
  var X = function (t) { return Math.max(0, Math.min(trackW, trackW * (t - x0) / Math.max(1, x1 - x0))); };
  var nowX = X(now).toFixed(1);
  var html = '<div class="qrows">' + rows.map(function (r) {
    var color = accColor(r.a.id);
    var left = r.cur == null ? null : Math.max(0, 100 - r.cur);
    var soon = r.reset && r.reset - now < 90 * 60000 && left != null && left >= 20;
    var svg = '<svg class="qtrack" width="' + trackW + '" height="' + rowH + '" viewBox="0 0 ' + trackW + ' ' + rowH + '">';
    // History: % used, 0 at the bottom, 100 at the top.
    var pts = stepPoints(r.list, now).map(function (p) { return X(p[0]).toFixed(1) + ',' + (rowH - 2 - (rowH - 4) * Math.min(100, p[1]) / 100).toFixed(1); });
    if (pts.length > 1) svg += '<polyline class="ln" style="stroke:' + color + '" points="' + pts.join(' ') + '"/>';
    // Until the reset: the quota left, as the bar's thickness.
    if (r.reset && left != null) {
      var th = Math.max(2, (rowH - 6) * left / 100);
      svg += '<rect class="' + (soon ? 'qlose' : 'qleft') + '" x="' + nowX + '" y="' + ((rowH - th) / 2).toFixed(1) + '" width="' + Math.max(1, X(r.reset) - X(now)).toFixed(1) + '" height="' + th.toFixed(1) + '"/>';
    }
    svg += '<line class="now" x1="' + nowX + '" x2="' + nowX + '" y1="0" y2="' + rowH + '"/></svg>';
    var title = r.a.label + '\\n' + (r.cur == null ? 'no reading' : Math.round(r.cur) + '% used, ' + Math.round(left) + '% left')
      + (r.reset ? '\\nresets ' + fmtWhen(r.reset) + (soon ? ': ' + Math.round(left) + '% lost if not used' : '') : '');
    return '<div class="qrow" title="' + esc(title) + '">'
      + '<span class="qname"><i class="sw ' + accClass(r.a.id) + '"></i>' + esc(r.a.label) + '</span>'
      + svg
      + '<span class="qreset num' + (soon ? ' warn-t' : '') + '">' + (r.reset ? esc(qWin === 'five' ? fmtClock(r.reset) : fmtWhen(r.reset)) : '\\u2014')
      + (left != null ? ' \\u00b7 ' + Math.round(left) + '%' : '') + '</span></div>';
  }).join('') + '</div>';
  return { html: html, note: note };
}

// Full width and enough history: every seat on one chart, names at the line ends, no projection.
function quotaLines(rows, size, x0, x1, now) {
  var series = rows.filter(function (r) { return r.list.length; }).map(function (r) {
    return { id: r.a.id, label: r.a.label, color: accColor(r.a.id), pts: stepPoints(r.list, now), endText: Math.round(r.cur) + '%' };
  });
  return lineChart(series, {
    w: size.w, h: size.h, x0: x0, x1: now, yMax: 100, slices: 60, label: 'Quota used over time',
    yFmt: function (v) { return Math.round(v) + '%'; },
    xLabel: function (x) { return qWin === 'five' ? hourLabel(Math.round(x / 3600000) * 3600000, false) : fmtWhen(x); },
    sliceTitle: function (x) {
      return fmtWhen(x) + '\\n' + series.map(function (sr) {
        var v = stepAt(usage.quota.series[sr.id][qWin === 'five' ? 'five' : 'week'], x);
        return sr.label + ': ' + (v == null ? '\\u2014' : Math.round(v) + '% used');
      }).join('\\n');
    },
  });
}

function boxSize(el) {
  var w = el && el.clientWidth;
  var h = el && el.clientHeight;
  return { w: w > 100 ? w : 720, h: h > 60 ? h : 220 };
}

// ---- history (persisted served records) --------------------------------------

var OUTCOME_PILL = { ok: 'ok', switched: 'warn', error: 'err' };
function historyRows(recent) {
  return recent.slice(0, 8).map(function (r, i) {
    var model = shortModel(r.servedModel || r.model);
    return { key: 'h:' + r.at + ':' + r.accountId + ':' + i, html: '<tr>'
      + '<td class="mono">' + esc(fmtClock(r.at)) + '</td>'
      + '<td><span class="pill ' + (OUTCOME_PILL[r.outcome] || 'idle') + '">' + esc(r.outcome) + '</span></td>'
      + '<td>' + esc(r.accountLabel) + '</td>'
      + '<td class="mono c-opt">' + esc(model) + (r.kind === 'session' ? ' <span class="tag">session</span>' : '') + '</td>'
      + '<td class="c-opt">' + esc(r.agent || '') + '</td>'
      + '<td class="r num small">' + (r.tokens ? fmtTokens(r.tokens.output) + ' out \\u00b7 ' + fmtTokens(sumIn(r.tokens)) + ' in' : '') + '</td>'
      + '<td class="small"><div class="ell s" title="' + esc(r.detail || '') + '">' + esc(r.detail || '') + '</div></td></tr>' };
  });
}

// ---- render ---------------------------------------------------------------

function render() {
  if (!snap) return;
  var s = snap;
  var acts = s.activity || [];
  var running = acts.filter(function (a) { return isLive(a.status); });
  var subs = 0;
  acts.forEach(function (a) { a.subagents.forEach(function (x) { if (x.status === 'running') subs++; }); });
  var usable = s.accounts.filter(function (a) { var x = seatState(a).state; return x === 'ready' || x === 'in use'; }).length;
  var nextBack = s.accounts.map(function (a) { return a.exhaustedUntil; }).filter(Boolean).sort()[0];
  var t = s.totals;
  var today = usageToday();
  var tt = seatTotals(s);
  setHtml('stats',
    '<span class="fig" title="' + esc(nextBack ? 'Next seat back ' + fmtWhen(nextBack) : '') + '"><b>' + usable + '</b> / ' + s.accounts.length + ' ready</span>'
    + '<span class="fig" title="Sum of the current 5h windows of the seats, API-equivalent">5h windows <b>' + fmtUsd(tt.five) + '</b></span>'
    + '<span class="fig" title="' + esc('Today, ' + TZ + ', since 00:00: the sum of the rows') + '">today <b>' + fmtUsd(tt.today) + '</b></span>');

  var strat = $('strategy');
  if (document.activeElement !== strat && strat.value !== s.settings.strategy) strat.value = s.settings.strategy;
  var th = $('threshold');
  if (document.activeElement !== th && th.value !== String(s.settings.threshold)) th.value = String(s.settings.threshold);
  setText('cli', s.cli);

  // The "N running" toggle; its drop-down holds everything live, then the last few finished.
  setText('actCount', running.length + ' running' + (subs ? ' \\u00b7 ' + subs + ' sub-agent' + (subs === 1 ? '' : 's') : ''));
  setClass($('runsBtn'), 'runs' + (running.length ? ' on' : ''));
  $('actPanel').hidden = !actOpen;
  var shown = running.concat(acts.filter(function (a) { return !isLive(a.status); }).slice(0, FINISHED_SHOWN));
  sync($('act'), actOpen ? activityRows(shown) : []);
  $('actWrap').hidden = acts.length === 0;
  $('actEmpty').hidden = acts.length !== 0;

  sync($('acc'), seatRows(s));
  var sname = STRATEGY_NAMES[s.settings.strategy] || s.settings.strategy;
  setHtml('seatFacts',
    (s.next ? '<span title="Seat a new conversation gets now; a running conversation keeps its seat">Next: <b>' + esc(s.next.label) + '</b> \\u2014 ' + esc(s.next.why) + ' (' + esc(sname) + ')</span>'
      : '<span>Next: <b>none ready</b></span>')
    + '<span class="c-opt">switch at ' + s.settings.threshold + '%</span>'
    + (nextBack ? '<span>next back <b>' + esc(fmtClock(nextBack)) + '</b></span>' : ''));
  var so = $('seatSort');
  var want = s.settings.seatSort === 'reset' ? 'reset' : 'manual';
  if (document.activeElement !== so && so.value !== want) so.value = want;

  var recent = s.recent || [];
  setText('histCount', recent.length ? String(Math.min(recent.length, 8)) : '');
  sync($('hist'), actOpen && $('histBox').open ? historyRows(recent) : []);
  tick();
}

var STRATEGY_NAMES = { headroom: 'most quota left', drain: 'use it or lose it', fill: 'fill in order', spread: 'spread' };
var tab = 'seats';
function showTab(name) {
  tab = name === 'usage' ? 'usage' : 'seats';
  ['seats', 'usage'].forEach(function (n) {
    $('pane-' + n).hidden = n !== tab;
    setClass(document.querySelector('button[data-act=tab][data-id=' + n + ']'), 'tab' + (n === tab ? ' on' : ''));
  });
  if (tab === 'usage') renderUsage();
}

function tick() {
  var now = Date.now();
  var els = document.querySelectorAll('[data-t]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var kind = el.getAttribute('data-t');
    var a = Number(el.getAttribute('data-a'));
    var text = kind === 'since' ? fmtDur(now - a) : kind === 'ago' ? fmtDur(now - a) + ' ago' : kind === 'left' ? fmtLeft(a) : '';
    if (el.textContent !== text) el.textContent = text;
  }
}

// ---- usage history (persisted, from the transcripts) -----------------------
// Its own slow poll: the data changes once a minute at most, and the zone is
// redrawn only when the server reports a new version (or a control moved).
// The chosen view, seat, metric and period live here for as long as the
// panel is open.

var USAGE_POLL_MS = 30000;
var usage = null;
var usageTimer = 0;
var usagePolling = false;
var uSel = 'all';
var uMetric = 'cost';
var uView = 'overview';
// Overview drawn as stacked bars, or as one cumulative line per seat.
var uChart = 'bars';
var uHours = 24;
// 0 = since the first day with data (at least 7 days).
var uDays = 0;
var uCap = 'five_hour';

function pollUsage() {
  clearTimeout(usageTimer);
  usageTimer = 0;
  if (usagePolling) return Promise.resolve();
  usagePolling = true;
  return call('usageHistory', { since: usage ? usage.version : null, hours: 72 }).then(function (r) {
    if (r.unchanged) {
      if (usage) usage.scan = r.scan;
      renderUsageStatus();
    } else {
      usage = r;
      renderUsage();
      render();
    }
  }, function (err) {
    setText('useStatus', 'usage unavailable: ' + String(err && err.message || err));
  }).then(function () {
    usagePolling = false;
    if (!document.hidden) usageTimer = setTimeout(pollUsage, USAGE_POLL_MS);
  });
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function dayDate(d) {
  var p = String(d).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function dayKey(dt) { return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()); }
function fmtDay(d) { return dayDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function weekOf(d) {
  var dt = dayDate(d);
  dt.setDate(dt.getDate() - (dt.getDay() + 6) % 7);
  return dayKey(dt);
}
var CELL = 23;
function blankCell() { var c = []; for (var i = 0; i < CELL; i++) c.push(0); return c; }
function addCell(a, b) { for (var i = 0; i < CELL; i++) a[i] += (b && b[i]) || 0; return a; }
// Cell: 0-3 tokens (input, cache write, cache read, output), 4-7 their API-equiv USD, 8 requests,
// 9 reads at the plain input price, 10 writes at the plain input price, 11 1h-write tokens, 12 their USD,
// 13-14 advisor tokens and USD (already in 0-7), 15-18 / 19-22 the advisor's share of 0-3 / 4-7.
function val(c, i) { return uMetric === 'cost' ? c[4 + i] : c[i]; }
function total(c) { return val(c, 0) + val(c, 1) + val(c, 2) + val(c, 3); }
function fmtVal(v) { return uMetric === 'cost' ? fmtUsd(v) : fmtTokens(v); }
function sumRows(rows) { var t = blankCell(); (rows || []).forEach(function (c) { addCell(t, c); }); return t; }
function tokOf(c) { return c[0] + c[1] + c[2] + c[3]; }
function usdOf(c) { return c[4] + c[5] + c[6] + c[7]; }
// A kind of token of the served models only: the advisor (another model, another price) apart.
function mainTok(c, i) { return c[i] - (c[15 + i] || 0); }
function mainUsd(c, i) { return c[4 + i] - (c[19 + i] || 0); }
// Breakdown of a cell: the served models' four kinds, then the advisor at its own price, then the total.
function cellBreakdown(c) {
  var tt = tokOf(c);
  var tu = usdOf(c);
  var out = [];
  for (var i = 0; i < 4; i++) {
    var tk = mainTok(c, i);
    var us = mainUsd(c, i);
    out.push(TYPE_NAMES[i] + ': ' + fmtTokens(tk) + ' tok (' + pct(tk, tt) + ') \\u00b7 ' + fmtUsd(us) + ' (' + pct(us, tu) + ')');
  }
  if (c[13] > 0) out.push('Advisor (Fable): ' + fmtTokens(c[13]) + ' tok (' + pct(c[13], tt) + ') \\u00b7 ' + fmtUsd(c[14]) + ' (' + pct(c[14], tu) + '), in ' + fmtTokens(c[15]) + ' \\u00b7 out ' + fmtTokens(c[18]));
  out.push('Total: ' + fmtTokens(tt) + ' tok \\u00b7 ' + fmtUsd(tu) + ' API-equiv');
  return out;
}
function cacheRatio(c) { return c[1] > 0 ? c[2] / c[1] : null; }
function fmtRatio(r) { return r == null ? '\\u2014' : (r >= 10 ? Math.round(r) : r.toFixed(1)) + '\\u00d7'; }
function hitRate(c) { return pct(c[2], c[0] + c[1] + c[2]); }
// What the cache did: reads saved (vs plain input) minus the write premium (vs plain input).
function cacheNet(c) { var saved = c[9] - c[6]; var premium = c[5] - c[10]; return { saved: saved, premium: premium, net: saved - premium }; }
function cellLines(head, c) {
  var lines = [head].concat(cellBreakdown(c));
  var n = cacheNet(c);
  lines.push('Cache: ' + (n.net >= 0 ? 'saved ' : 'cost ') + fmtUsd(Math.abs(n.net)) + ' net (reads saved ' + fmtUsd(n.saved) + ', write premium ' + fmtUsd(n.premium) + ')');
  lines.push(c[8] + ' requests');
  return lines.join('\\n');
}

function usageToday() {
  if (!usage || !usage.days || !usage.days.length) return null;
  var i = usage.days.length - 1;
  if (usage.days[i] !== dayKey(new Date())) return null;
  var t = blankCell();
  Object.keys(usage.daily).forEach(function (k) { addCell(t, usage.daily[k][i]); });
  return t;
}

// Rows of the selection: one account, or every account summed.
function rowsOf(map, acc, len) {
  if (acc !== 'all') return map[acc] || null;
  var out = null;
  Object.keys(map).forEach(function (k) {
    if (!out) out = map[k].map(function () { return blankCell(); });
    map[k].forEach(function (c, i) { addCell(out[i], c); });
  });
  if (out) return out;
  var empty = [];
  for (var i = 0; i < (len || 0); i++) empty.push(blankCell());
  return empty;
}

// Colour follows the seat (its rank in seat order), never its volume.
function accIndex(id) {
  var ids = [];
  if (snap && snap.accounts) snap.accounts.forEach(function (a) { ids.push(a.id); });
  if (usage && usage.accounts) usage.accounts.forEach(function (a) { if (a.id !== 'unknown' && ids.indexOf(a.id) < 0) ids.push(a.id); });
  return ids.indexOf(id);
}
function accClass(id) {
  if (id === 'unknown') return 'aunk';
  var idx = accIndex(id);
  return idx >= 0 && idx < 10 ? 'a' + idx : 'aoth';
}
function accColor(id) {
  if (id === 'unknown') return 'var(--sunk)';
  var idx = accIndex(id);
  return idx >= 0 && idx < 10 ? 'var(--s' + (idx + 1) + ')' : 'var(--muted)';
}
function accLabel(id) {
  if (!usage) return id;
  var a = usage.accounts.filter(function (x) { return x.id === id; })[0];
  return a ? a.label : id;
}

// The days of the chosen period (at least 7 slots), and the rows cut to them.
function periodDays(u) {
  var n = uDays > 0 ? uDays : Math.max(u.days.length, 7);
  var days = u.days.slice(-n);
  var pad = 0;
  while (uDays > 0 && days.length < n) {
    var first = dayDate(days[0] || dayKey(new Date()));
    first.setDate(first.getDate() - 1);
    days.unshift(dayKey(first));
    pad++;
  }
  var cut = function (rows) {
    var r = (rows || []).slice(-(days.length - pad));
    for (var i = 0; i < pad; i++) r.unshift(blankCell());
    while (r.length < days.length) r.unshift(blankCell());
    return r;
  };
  return { days: days, cut: cut };
}

// More than ~60 days: one bar per week (Monday), so the bars stay readable.
function grouped(days, rows) {
  if (days.length <= 60) return { labels: days, rows: rows, weekly: false };
  var labels = [];
  var at = {};
  days.forEach(function (d) { var w = weekOf(d); if (!(w in at)) { at[w] = labels.length; labels.push(w); } });
  var out = {};
  Object.keys(rows).forEach(function (k) {
    var r = labels.map(function () { return blankCell(); });
    rows[k].forEach(function (c, i) { addCell(r[at[weekOf(days[i])]], c); });
    out[k] = r;
  });
  return { labels: labels, rows: out, weekly: true };
}

// Gridline step: the smallest 1, 2, 2.5 or 5 x 10^n giving at most "lines" lines up to v.
function niceStep(v, lines) {
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  var raw = v / Math.max(1, lines);
  var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  var m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}
// Leading empty columns (before the first data) are dropped, keeping one.
function trimLeading(cols) {
  var i = 0;
  while (i < cols.length - 1 && !cols[i].segs.some(function (g) { return g.v > 0; })) i++;
  return i ? cols.slice(i) : cols;
}

// Stacked bars at a given pixel size. cols: [{ label, title, segs: [{ v, cls }] }].
function barChart(cols, o) {
  var W = Math.max(60, Math.round(o.w || 720));
  var H = Math.max(30, Math.round(o.h || 150));
  var axis = o.axis !== false;
  var padL = axis ? 46 : 1;
  var padB = axis ? 15 : 1;
  var padT = 5;
  if (o.trim) cols = trimLeading(cols);
  var plotW = W - padL - 1;
  var plotH = H - padT - padB;
  var max = o.max || 0;
  if (!max) {
    cols.forEach(function (c) { var s = 0; c.segs.forEach(function (g) { s += g.v; }); if (s > max) max = s; });
    // A little headroom over the tallest bar, not a round number far above it.
    max = max * 1.08;
  }
  var gstep = niceStep(max, Math.max(2, Math.min(6, Math.floor(plotH / 40))));
  var n = Math.max(1, cols.length);
  var step = plotW / n;
  var bw = Math.max(1, Math.min(step > 5 ? step - 2 : step * 0.8, 26));
  var every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / (o.labelW || 64)))));
  var out = '<svg class="chart" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || '') + '">';
  if (axis) {
    var lines = max > 0 && gstep > 0 ? Math.floor(max / gstep + 1e-9) : 0;
    for (var g = 0; g <= lines; g++) {
      var gy = (padT + plotH - (max > 0 ? plotH * g * gstep / max : 0)).toFixed(1);
      out += '<line class="grid" x1="' + padL + '" x2="' + W + '" y1="' + gy + '" y2="' + gy + '"/>'
        + '<text class="ax" x="' + (padL - 5) + '" y="' + (Number(gy) + 3) + '" text-anchor="end">' + esc(g ? fmtVal(g * gstep) : '0') + '</text>';
    }
  }
  cols.forEach(function (c, i) {
    var x = padL + i * step + (step - bw) / 2;
    var y = padT + plotH;
    var parts = '';
    if (max > 0) c.segs.forEach(function (sg) {
      if (!(sg.v > 0)) return;
      var h = Math.max(0.6, plotH * sg.v / max);
      y -= h;
      // 1 px of surface between stacked segments.
      parts += '<rect class="' + sg.cls + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1)
        + '" height="' + Math.max(0.6, h > 3 ? h - 1 : h).toFixed(1) + '"/>';
    });
    out += '<g class="col"' + (c.raw ? ' data-tok="' + c.raw[0] + '" data-usd="' + c.raw[1] + '"' : '') + '><title>' + esc(c.title) + '</title>' + parts
      + '<rect class="hit" x="' + (padL + i * step).toFixed(1) + '" y="' + padT + '" width="' + step.toFixed(1) + '" height="' + plotH + '"/></g>';
    if (axis && c.label && i % every === 0) {
      out += '<text class="ax" x="' + (x + bw / 2).toFixed(1) + '" y="' + (H - 3) + '" text-anchor="middle">' + esc(c.label) + '</text>';
    }
  });
  return out + '</svg>';
}

// "14h", and "9 oct. 00h" on the first column and at each midnight.
function hourLabel(at, first) {
  var d = new Date(at);
  var h = pad2(d.getHours()) + 'h';
  return first || d.getHours() === 0 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + h : h;
}

function typeSegs(c) {
  return [0, 1, 2, 3].map(function (i) { return { v: val(c, i), cls: 't' + i }; });
}

// One line: total $ and tokens, the four posts with their share, the cache, the month.
function stripHtml(c, month, plans) {
  var tu = usdOf(c);
  var tt = tokOf(c);
  var n = cacheNet(c);
  var w1 = c[11];
  var parts = [0, 1, 2, 3].map(function (i) {
    var title = TYPE_NAMES[i] + ': ' + fmtTokens(mainTok(c, i)) + ' tok (' + pct(mainTok(c, i), tt) + ') \\u00b7 ' + fmtUsd(mainUsd(c, i)) + ' (' + pct(mainUsd(c, i), tu) + ')'
      + (i === 1 && w1 > 0 ? '\\n5m ' + fmtTokens(c[1] - w1) + ' \\u00b7 1h ' + fmtTokens(w1) + ' (' + fmtUsd(c[12]) + ')' : '');
    return '<span class="it" title="' + esc(title) + '"><i class="sw t' + i + '"></i>' + TYPE_NAMES[i] + ' <b>' + fmtUsd(mainUsd(c, i)) + '</b></span>';
  }).join('') + (c[13] > 0 ? '<span class="it" title="' + esc('Fable advising the model, at the Fable price: ' + fmtTokens(c[13]) + ' tok (in ' + fmtTokens(c[15]) + ', out ' + fmtTokens(c[18]) + ')') + '">Advisor <b>' + fmtUsd(c[14]) + '</b></span>' : '');
  return '<span class="it" data-tok="' + tt + '" data-usd="' + tu + '" title="' + esc(cellBreakdown(c).join('\\n')) + '"><span class="k">API</span><span class="big">' + fmtUsd(tu) + '</span></span>'
    + '<span class="parts">' + parts + '</span>'
    + '<span class="it"><span class="k">tok</span>' + fmtTokens(tt) + '</span>'
    + '<span class="it" title="Cache read tokens per cache write token; hit = share of the prompt read from cache"><span class="k">cache r/w</span>' + fmtRatio(cacheRatio(c)) + ' <span class="muted">' + hitRate(c) + '</span></span>'
    + '<span class="it" title="' + esc('Cache reads cost ' + fmtUsd(n.saved) + ' less than the same tokens as plain input; cache writes cost ' + fmtUsd(n.premium) + ' more than plain input. Net: ' + (n.net >= 0 ? 'the cache saves ' + fmtUsd(n.net) : 'the cache costs ' + fmtUsd(-n.net) + ' more than it saves') + '.') + '">'
    + '<span class="k">cache</span><span class="' + (n.net >= 0 ? 'pos-v' : 'neg-v') + '">' + (n.net >= 0 ? 'saved ' + fmtUsd(n.net) : fmtUsd(n.net) + ' net') + '</span></span>'
    + (month ? '<span class="it" title="API-equivalent value used this month' + (plans ? ', against the monthly price of the plans' : '') + '"><span class="k">month</span>' + fmtUsd(usdOf(month))
      + (plans ? ' <span class="muted">/ $' + plans + ' \\u00b7 ' + (usdOf(month) / plans).toFixed(1) + '\\u00d7</span>' : '') + '</span>' : '')
    + unpricedHtml();
}

// Models with no list price: their tokens are counted, never priced as something else.
function unpricedHtml() {
  var list = ((usage && usage.models) || []).filter(function (m) { return !m.known; });
  if (!list.length) return '';
  var tok = 0;
  list.forEach(function (m) { tok += m.tokens; });
  return '<span class="it neg-v" title="' + esc('No list price, counted at $0: ' + list.map(function (m) { return m.model + ' ' + fmtTokens(m.tokens) + ' tok'; }).join(', ')) + '"><span class="k">unpriced</span>' + fmtTokens(tok) + ' tok</span>';
}

function renderUsageStatus() {
  if (!usage) return;
  var s = usage.scan || {};
  var text = s.running && !s.backfilled
    ? 'importing ' + s.filesDone + ' / ' + s.filesTotal
    : s.error ? 'scan failed: ' + s.error
    : s.lastScanAt ? 'updated ' + fmtClock(s.lastScanAt) : s.backfilled ? '' : 'import pending';
  setText('useStatus', text);
}

function setSeg(act, cur) {
  var bs = document.querySelectorAll('button[data-act=' + act + ']');
  for (var i = 0; i < bs.length; i++) setClass(bs[i], bs[i].getAttribute('data-id') === cur ? 'on' : '');
}

function chartSize() {
  var el = $('useChart');
  var w = el && el.clientWidth;
  var h = el && el.clientHeight;
  return { w: w > 100 ? w : 720, h: h > 60 ? h : 200 };
}

function costView(c) {
  var tu = usdOf(c);
  var tt = tokOf(c);
  var max = Math.max(mainUsd(c, 0), mainUsd(c, 1), mainUsd(c, 2), mainUsd(c, 3), c[14]) || 1;
  var n = cacheNet(c);
  var w1 = c[11];
  var rows = [0, 1, 2, 3].map(function (i) {
    var label = TYPE_NAMES[i] + (i === 1 && w1 > 0 ? ' (5m ' + fmtTokens(c[1] - w1) + ' \\u00b7 1h ' + fmtTokens(w1) + ')' : '');
    return '<span><i class="sw t' + i + '"></i>' + esc(label) + '</span>'
      + '<span><span class="cb t' + i + '" style="display:block;width:' + Math.max(1, Math.round(100 * mainUsd(c, i) / max)) + '%"></span></span>'
      + '<span class="r">' + fmtTokens(mainTok(c, i)) + ' <span class="muted">' + pct(mainTok(c, i), tt) + '</span></span>'
      + '<span class="r"><b>' + fmtUsd(mainUsd(c, i)) + '</b></span><span class="r muted">' + pct(mainUsd(c, i), tu) + '</span>';
  }).join('');
  return '<div class="costs">' + rows
    + (c[13] > 0 ? '<span title="Fable advising the model: its own calls (in ' + fmtTokens(c[15]) + ', out ' + fmtTokens(c[18]) + '), at the Fable price">Advisor (Fable)</span><span></span><span class="r">' + fmtTokens(c[13]) + ' <span class="muted">' + pct(c[13], tt) + '</span></span><span class="r"><b>' + fmtUsd(c[14]) + '</b></span><span class="r muted">' + pct(c[14], tu) + '</span>' : '')
    + '<span class="sep"></span>'
    + '<span><b>Total</b></span><span></span><span class="r">' + fmtTokens(tt) + '</span><span class="r"><b>' + fmtUsd(tu) + '</b></span><span></span>'
    + '<span title="What the cache reads would have cost as plain input, minus what they cost">Cache reads saved</span><span></span><span class="r muted">r/w ' + fmtRatio(cacheRatio(c)) + '</span><span class="r pos-v">+' + fmtUsd(n.saved) + '</span><span></span>'
    + '<span title="What writing the cache cost above plain input">Cache write premium</span><span></span><span class="r muted">hit ' + hitRate(c) + '</span><span class="r neg-v">' + fmtUsd(-n.premium) + '</span><span></span>'
    + '<span><b>' + (n.net >= 0 ? 'Saved by the cache' : 'The cache costs more than it saves') + '</b></span><span></span><span></span>'
    + '<span class="r ' + (n.net >= 0 ? 'pos-v' : 'neg-v') + '"><b>' + (n.net >= 0 ? '+' : '') + fmtUsd(n.net) + '</b></span><span></span>'
    + '</div>';
}

// Lost capacity, per day of the reset: what the windows that reset that day
// used, and the estimate of what they had left. Estimates only.
function capacityChart(u, pd, sel, size) {
  var cap = u.capacity || { since: 0, rows: [] };
  var idx = {};
  pd.days.forEach(function (d, i) { idx[d] = i; });
  var per = pd.days.map(function () { return { n: 0, pct: 0, used: 0, lost: 0, usedT: 0, lostT: 0, fullN: 0 }; });
  var any = 0;
  cap.rows.forEach(function (r) {
    if (r.window !== uCap || (sel !== 'all' && r.account !== sel) || !(r.day in idx)) return;
    var g = per[idx[r.day]];
    any++;
    g.n += r.n;
    g.pct += r.pct;
    g.used += r.estUsedUsd;
    g.lost += Math.max(0, r.fullUsd - r.estUsedUsd);
    g.usedT += r.estUsedTok;
    g.lostT += Math.max(0, r.fullTok - r.estUsedTok);
    g.fullN += r.estN;
  });
  var sum = blankCell();
  if (!any) {
    return { html: '<div class="capnote">No ' + (uCap === 'five_hour' ? '5h' : 'weekly') + ' reset seen in this period yet. Recording since ' + esc(fmtWhen(cap.since)) + '.</div>', legend: '', sum: sum };
  }
  var tot = { n: 0, pct: 0, used: 0, lost: 0, usedT: 0, lostT: 0 };
  var cols = per.map(function (g, i) {
    tot.n += g.n; tot.pct += g.pct; tot.used += g.used; tot.lost += g.lost; tot.usedT += g.usedT; tot.lostT += g.lostT;
    var u1 = uMetric === 'cost' ? g.used : g.usedT;
    var l1 = uMetric === 'cost' ? g.lost : g.lostT;
    var title = fmtDay(pd.days[i]) + ': ' + g.n + ' reset' + (g.n === 1 ? '' : 's')
      + (g.n ? ', ' + Math.round(g.pct / g.n) + '% used on average' : '')
      + (g.fullN ? '\\nUsed ' + fmtTokens(g.usedT) + ' tok (' + fmtUsd(g.used) + ')\\nLeft unused (estimate) ' + fmtTokens(g.lostT) + ' tok (' + fmtUsd(g.lost) + ')'
        : g.n ? '\\nToo little use to estimate the window' : '');
    return { label: fmtDay(pd.days[i]), title: title, segs: [{ v: u1, cls: 'cu' }, { v: l1, cls: 'cl' }] };
  });
  var avg = tot.n ? Math.round(tot.pct / tot.n) : 0;
  return {
    html: barChart(cols, { w: size.w, h: size.h, label: 'Used and lost capacity', trim: uDays === 0 }),
    legend: '<span><i class="sw cu"></i>Used</span><span><i class="sw cl"></i>Left unused at reset (estimate)</span>'
      + '<span>' + tot.n + ' resets \\u00b7 ' + avg + '% used on average \\u00b7 lost \\u2248 ' + fmtUsd(tot.lost) + ' / ' + fmtTokens(tot.lostT) + ' tok</span>',
    sum: sum,
  };
}

// The overview series: per hour while the history is under three days old
// (a few days of bars would say nothing), per day, per week past 60 days.
function overviewSeries(u, accs, pd, daily) {
  var hours = u.hours || [];
  if (uDays === 0 && u.firstAt && hours.length && u.firstAt >= hours[0]) {
    var start = 0;
    var h0 = Math.floor(u.firstAt / 3600000) * 3600000;
    for (var i = 0; i < hours.length; i++) if (hours[i] <= h0) start = i;
    var rows = {};
    accs.forEach(function (a) { rows[a.id] = (u.hourly[a.id] || hours.map(blankCell)).slice(start); });
    return { labels: hours.slice(start), rows: rows, unit: 'hour',
      label: function (at, i) { return hourLabel(at, i === 0); }, labelW: 80,
      head: function (at) { return fmtWhen(at) + ' (1h)'; } };
  }
  var gr = grouped(pd.days, daily);
  gr.unit = gr.weekly ? 'week' : 'day';
  gr.label = function (d) { return fmtDay(d); };
  gr.labelW = 64;
  gr.head = function (d) { return (gr.weekly ? 'Week of ' : '') + fmtDay(d); };
  return gr;
}

// Overview as lines: each seat's consumption summed over the period, its name at the end of its line.
function cumulativeLines(gr, accs, ocols, size) {
  var first = 0;
  if (uDays === 0) {
    while (first < gr.labels.length - 1 && !accs.some(function (a) { return total(gr.rows[a.id][first]) > 0; })) first++;
  }
  var n = gr.labels.length;
  var max = 0;
  var cum = {};
  var series = accs.map(function (a) {
    var run = 0;
    var pts = [];
    cum[a.id] = [];
    for (var i = first; i < n; i++) {
      run += total(gr.rows[a.id][i]);
      pts.push([i, run]);
      cum[a.id].push(run);
    }
    if (run > max) max = run;
    return { id: a.id, label: a.label, color: accColor(a.id), pts: pts, endText: fmtVal(run) };
  }).filter(function (sr) { return sr.pts.length && sr.pts[sr.pts.length - 1][1] > 0; });
  return lineChart(series, {
    w: size.w, h: size.h, x0: first, x1: Math.max(first + 1, n - 1), yMax: max * 1.08, slices: Math.max(1, n - first), label: 'Cumulative usage by seat',
    yFmt: fmtVal,
    xLabel: function (x) { var i = Math.round(x); return i >= 0 && i < n ? gr.label(gr.labels[i], i - first) : ''; },
    sliceTitle: function (x) {
      var i = Math.max(first, Math.min(n - 1, Math.floor(x)));
      return gr.head(gr.labels[i]) + ' (cumulated)\\n' + series.map(function (sr) { return sr.label + ': ' + fmtVal(cum[sr.id][i - first]); }).join('\\n');
    },
  });
}

// History rows that are no seat of the list (tokens before tracking): counted, never drawn.
function unseatedIds(u, accs) {
  return Object.keys(u.daily || {}).filter(function (id) { return !accs.some(function (a) { return a.id === id; }); });
}

function renderUsage() {
  var u = usage;
  if (!u) return;
  renderUsageStatus();
  var accs = u.accounts || [];
  $('useEmpty').hidden = accs.length > 0;
  $('useBody').hidden = accs.length === 0;
  setSeg('umetric', uMetric);
  setSeg('uview', uView);
  setSeg('uchart', uChart);
  $('uchartSeg').hidden = uView !== 'overview' && uView !== 'quota';
  $('qwinSeg').hidden = uView !== 'quota';
  setSeg('qwin', qWin);
  var hourly = uView === 'hourly';
  var pv = hourly ? String(uHours) : String(uDays);
  var popts = hourly ? [['24', '24h'], ['48', '48h']] : [['0', 'Since ' + fmtDay(u.days && u.days[0] ? u.days[0] : dayKey(new Date()))], ['7', '7d'], ['30', '30d'], ['90', '90d']];
  setHtml('usePeriod', popts.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join(''));
  if ($('usePeriod').value !== pv) $('usePeriod').value = pv;
  $('useAcc').hidden = uView === 'overview' || uView === 'byseat';
  $('ucapSeg').hidden = uView !== 'capacity';
  setSeg('ucap', uCap);
  if (!accs.length) return;
  if (uSel !== 'all' && !accs.some(function (a) { return a.id === uSel; })) uSel = 'all';
  var opts = '<option value="all">All seats</option>' + accs.map(function (a) {
    return '<option value="' + esc(a.id) + '">' + esc(a.label) + '</option>';
  }).join('');
  setHtml('useAcc', opts);
  if ($('useAcc').value !== uSel) $('useAcc').value = uSel;
  var scopeAll = uView === 'overview' || uView === 'byseat';
  var sel = scopeAll ? 'all' : uSel;
  var name = sel === 'all' ? 'All seats' : accLabel(sel);

  // The period, every view but hourly.
  var pd = periodDays(u);
  var daily = {};
  accs.forEach(function (a) { daily[a.id] = pd.cut(u.daily[a.id]); });
  var month = blankCell();
  var plans = 0;
  accs.forEach(function (a) {
    if (sel !== 'all' && a.id !== sel) return;
    (u.daily[a.id] || []).forEach(function (c, i) { if (u.days[i] >= u.monthStart) addCell(month, c); });
    if (u.plans && u.plans[a.id]) plans += u.plans[a.id].monthlyUsd;
  });
  // Tokens no transcript ties to a seat: not drawn as a series, still in the totals of all seats.
  var unseated = unseatedIds(u, accs);
  if (sel === 'all') unseated.forEach(function (id) { (u.daily[id] || []).forEach(function (c, i) { if (u.days[i] >= u.monthStart) addCell(month, c); }); });

  var size = chartSize();
  var sum = blankCell();
  var html = '';
  var legend = '';
  if (uView === 'overview' || uView === 'byseat') {
    unseated.forEach(function (id) { daily[id] = pd.cut(u.daily[id]); });
    var gr = overviewSeries(u, accs.concat(unseated.map(function (id) { return { id: id }; })), pd, daily);
    accs.forEach(function (a) { gr.rows[a.id].forEach(function (c) { addCell(sum, c); }); });
    unseated.forEach(function (id) { gr.rows[id].forEach(function (c) { addCell(sum, c); }); });
    if (uView === 'overview') {
      var ocols = gr.labels.map(function (d, i) {
        var segs = [];
        var lines = [gr.head(d)];
        var tot = blankCell();
        accs.forEach(function (a) {
          var c = gr.rows[a.id][i];
          addCell(tot, c);
          segs.push({ v: total(c), cls: accClass(a.id) });
          if (tokOf(c) > 0) {
            lines.push(a.label + ': ' + fmtUsd(usdOf(c)) + ' \\u00b7 ' + fmtTokens(tokOf(c)) + ' tok (in ' + fmtUsd(mainUsd(c, 0)) + ', cache write ' + fmtUsd(mainUsd(c, 1))
              + ', cache read ' + fmtUsd(mainUsd(c, 2)) + ', out ' + fmtUsd(mainUsd(c, 3)) + (c[14] > 0 ? ', advisor ' + fmtUsd(c[14]) : '') + ')');
          }
        });
        unseated.forEach(function (id) { addCell(tot, gr.rows[id][i]); });
        return { label: gr.label(d, i), title: cellLines(lines.join('\\n'), tot), segs: segs, raw: [tokOf(tot), usdOf(tot)] };
      });
      if (uChart === 'lines') {
        html = cumulativeLines(gr, accs, ocols, size);
        legend = '';
      } else {
        html = barChart(ocols, { w: size.w, h: size.h, label: 'Usage per ' + gr.unit + ' by seat', trim: uDays === 0, labelW: gr.labelW });
        legend = accs.map(function (a) { return '<span><i class="sw ' + accClass(a.id) + '"></i>' + esc(a.label) + '</span>'; }).join('');
      }
    } else {
      // One small chart per seat, all on the same scale. A click opens that seat in Daily.
      var shared = 0;
      accs.forEach(function (a) { gr.rows[a.id].forEach(function (c) { if (total(c) > shared) shared = total(c); }); });
      var allTotal = total(sum);
      var mh = Math.max(28, Math.min(64, Math.floor(size.h / Math.max(1, Math.ceil(accs.length / Math.max(1, Math.floor(size.w / 158))))) - 48));
      html = '<div class="mults" id="useMults">' + accs.map(function (a) {
        var t = sumRows(gr.rows[a.id]);
        var cls = accClass(a.id);
        var cols = gr.labels.map(function (d, i) {
          var c = gr.rows[a.id][i];
          return { label: '', title: cellLines(a.label + ' \\u00b7 ' + gr.head(d), c), segs: [{ v: total(c), cls: cls }] };
        });
        var plan = u.plans ? u.plans[a.id] : null;
        return '<button class="mult" data-act="usel" data-id="' + esc(a.id) + '" data-tok="' + tokOf(t) + '" data-usd="' + usdOf(t) + '" title="' + esc(cellLines(a.label + (plan ? ' (' + plan.label + ', $' + plan.monthlyUsd + '/month)' : ''), t)) + '">'
          + '<div class="mh"><i class="sw ' + cls + '"></i><b>' + esc(a.label) + '</b><span class="num muted">' + pct(total(t), allTotal) + '</span></div>'
          + barChart(cols, { w: 150, h: mh, max: shared, axis: false, label: a.label })
          + '<div class="mf"><span>' + fmtUsd(usdOf(t)) + '</span><span>' + fmtTokens(tokOf(t)) + '</span><span>r/w ' + fmtRatio(cacheRatio(t)) + '</span></div>'
          + (plan ? '<div class="mf" title="API-equivalent value used this month against the plan price"><span>' + esc(plan.label) + '</span><span>month ' + fmtUsd(monthOf(a.id)) + ' / $' + plan.monthlyUsd + '</span></div>' : '')
          + '</button>';
      }).join('') + '</div>';
    }
  } else if (uView === 'quota') {
    var qv = quotaView(size);
    html = qv.html;
    legend = qv.note ? '<span>' + esc(qv.note) + '</span>' : '';
  } else if (uView === 'capacity') {
    var cv = capacityChart(u, pd, sel, size);
    html = cv.html;
    legend = cv.legend;
    addCell(sum, cv.sum);
  } else if (hourly) {
    var hrows = rowsOf(u.hourly, sel, u.hours.length) || u.hours.map(blankCell);
    var from = Math.max(0, hrows.length - uHours);
    var hcols = hrows.slice(from).map(function (c, j) {
      var at = u.hours[from + j];
      addCell(sum, c);
      return { label: hourLabel(at, j === 0), title: cellLines(fmtWhen(at) + ' (1h) \\u00b7 ' + name, c), segs: typeSegs(c), raw: [tokOf(c), usdOf(c)] };
    });
    html = barChart(hcols, { w: size.w, h: size.h, label: 'Usage per hour', labelW: 80 });
  } else {
    var drows = pd.cut(rowsOf(u.daily, sel, u.days.length) || []);
    var dcols = drows.map(function (c, i) {
      addCell(sum, c);
      return { label: fmtDay(pd.days[i]), title: cellLines(fmtDay(pd.days[i]) + ' \\u00b7 ' + name, c), segs: typeSegs(c), raw: [tokOf(c), usdOf(c)] };
    });
    if (uView === 'daily') html = barChart(dcols, { w: size.w, h: size.h, label: 'Usage per day', trim: uDays === 0 });
    else html = costView(sum);
  }
  if (uView === 'hourly' || uView === 'daily') {
    legend = '<span><i class="sw t0"></i>Input</span><span><i class="sw t1"></i>Cache write</span><span><i class="sw t2"></i>Cache read</span><span><i class="sw t3"></i>Output</span>';
  }
  setHtml('useChart', html);
  setHtml('useLegend', legend);
  $('useLegend').hidden = !legend;
  setHtml('useStrip', stripHtml(sum, month, plans));
  setText('useScope', name + ' \\u00b7 ' + (hourly ? 'last ' + uHours + 'h' : uDays > 0 ? 'last ' + uDays + 'd' : 'since ' + fmtDay(u.days[0]))
    + (uView === 'capacity' ? ' \\u00b7 ' + (uCap === 'five_hour' ? '5h windows' : 'weekly windows') + ' \\u00b7 estimate' : ''));
}

// ---- actions --------------------------------------------------------------

function labelOf(id) {
  var a = snap && snap.accounts.filter(function (x) { return x.id === id; })[0];
  return a ? a.label : id;
}
function accountOf(id) {
  return snap && snap.accounts.filter(function (x) { return x.id === id; })[0];
}

function run(key, action, args, okText) {
  busy[key] = true;
  render();
  return call(action, args).then(function (r) {
    if (okText) flash('ok', typeof okText === 'function' ? okText(r) : okText);
    return r;
  }, function (err) {
    flash('err', String(err && err.message || err));
    return null;
  }).then(function (r) {
    delete busy[key];
    return poll().then(function () { return r; });
  });
}

function onAct(b) {
  var act = b.getAttribute('data-act');
  var id = b.getAttribute('data-id');
  var a = accountOf(id);
  if (act === 'flash-close') { flash('', ''); return; }
  if (act === 'runs') { actOpen = !actOpen; render(); return; }
  if (act === 'qwin') { qWin = id === 'week' ? 'week' : 'five'; renderUsage(); return; }
  if (act === 'uchart') { uChart = id === 'lines' ? 'lines' : 'bars'; renderUsage(); return; }
  if (act === 'usel') { uSel = id; uView = 'daily'; renderUsage(); return; }
  if (act === 'umetric') { uMetric = id === 'cost' ? 'cost' : 'tokens'; renderUsage(); return; }
  if (act === 'uview') { uView = id; renderUsage(); return; }
  if (act === 'ucap') { uCap = id === 'seven_day' ? 'seven_day' : 'five_hour'; renderUsage(); return; }
  if (act === 'tab') { showTab(id); return; }
  if (act === 'more') { openDetails[id] = !openDetails[id]; render(); return; }
  if (act === 'iters') { openIters[id] = !openIters[id]; render(); return; }
  if (act === 'remove') {
    if (arm('remove:' + id)) return;
    var name = labelOf(id);
    return run('remove:' + id, 'removeAccount', { id: id }, 'Removed ' + name + '.').then(function () { delete openDetails[id]; render(); });
  }
  if (act === 'stop') {
    if (arm('stop:' + id)) return;
    return run('stop:' + id, 'stopActivity', { id: id }, 'Stop requested.');
  }
  if (act === 'login') return run('login:' + id, 'loginAccount', { id: id }, 'Login window opened for ' + labelOf(id) + '.');
  if (act === 'refresh') return run('refresh:' + id, 'refreshUsage', { id: id });
  if (act === 'test') return run('test:' + id, 'testConnection', { accountId: id }, function (r) { return labelOf(id) + ' answered: ' + r.sample; });
  if (act === 'toggle') return run('toggle:' + id, 'updateAccount', { id: id, enabled: !(a && a.enabled) });
  if (act === 'up' || act === 'down' || act === 'top') {
    var args = act === 'top' ? { id: id, index: 0 } : { id: id, delta: act === 'up' ? -1 : 1 };
    return run('order:' + id, 'moveAccount', args);
  }
  if (act === 'pin') return run('pin:' + id, 'updateAccount', { id: id, exposeModels: !(a && a.exposeModels) });
  if (act === 'clear') return run('clear:' + id, 'clearExhausted', { id: id });
  if (act === 'savetoken') {
    var v = $('tokv-' + id);
    var token = v ? v.value.trim() : '';
    return run('savetoken:' + id, 'setAccountToken', { id: id, token: token }, token ? 'Token saved for ' + labelOf(id) + '.' : labelOf(id) + ' uses its login again.')
      .then(function (r) { if (r && v) v.value = ''; });
  }
}

document.addEventListener('click', function (e) {
  var b = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
  if (!b || b.disabled) return;
  return onAct(b);
});

$('refreshAll').addEventListener('click', function () {
  return run('refresh:*', 'refreshUsage', {}, 'Usage refreshed.');
});
$('addToggle').addEventListener('click', function () {
  var row = $('addRow');
  row.hidden = !row.hidden;
  if (!row.hidden) $('newLabel').focus();
});
$('add').addEventListener('click', function () {
  var label = $('newLabel').value.trim();
  var token = $('newToken').value.trim();
  if (!label) { $('newLabel').focus(); return; }
  return run('add', 'addAccount', { label: label, token: token, login: !token },
    token ? 'Added ' + label + '.' : 'Added ' + label + ': finish the login in the window that opened.')
    .then(function (r) {
      if (!r) return;
      $('newLabel').value = '';
      $('newToken').value = '';
      $('addRow').hidden = true;
    });
});
$('strategy').addEventListener('change', function () {
  return run('settings', 'updateSettings', { strategy: $('strategy').value });
});
$('threshold').addEventListener('change', function () {
  var n = Math.round(Number($('threshold').value));
  if (!(n >= 1 && n <= 100)) { flash('err', 'Switch threshold must be 1 to 100.'); return; }
  return run('settings', 'updateSettings', { threshold: n });
});
$('seatSort').addEventListener('change', function () {
  return run('settings', 'updateSettings', { seatSort: $('seatSort').value });
});
$('useAcc').addEventListener('change', function () { uSel = $('useAcc').value || 'all'; renderUsage(); });
$('usePeriod').addEventListener('change', function () {
  var v = Number($('usePeriod').value);
  if (uView === 'hourly') uHours = v === 48 ? 48 : 24; else uDays = v >= 0 ? v : 30;
  renderUsage();
});
$('histBox').addEventListener('toggle', function () { render(); });
// The chart is drawn at the size of its box: redraw it when the panel is resized.
var resizeTimer = 0;
var lastSize = '';
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function () {
    resizeTimer = 0;
    var z = chartSize();
    var key = z.w + 'x' + z.h;
    if (key === lastSize) return;
    lastSize = key;
    renderUsage();
  }, 120);
}
window.addEventListener('resize', onResize);
if (typeof ResizeObserver === 'function') {
  try { var ro = new ResizeObserver(onResize); ro.observe($('useChart')); } catch (e) { /* the window listener is enough */ }
}
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    clearTimeout(pollTimer); pollTimer = 0;
    clearTimeout(usageTimer); usageTimer = 0;
  } else { poll(); pollUsage(); }
});

setInterval(tick, 1000);
poll();
pollUsage();
`;

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Claude</title>
  <style>${STYLES}</style>
</head>
<body class="uviz">
<div class="top">
  <h1>Claude</h1>
  <span class="tag mono c-narrow" id="cli"></span>
  <span class="pill err" id="conn" hidden>offline</span>
  <span class="spacer"></span>
  <label class="in" title="use it or lose it: the seat whose quota resets soonest with the most left; fill: the first seat in order until the threshold; spread: balance across seats"><span class="lbl">Strategy</span>
    <select class="field" id="strategy"><option value="headroom">most quota left</option><option value="drain">use it or lose it</option><option value="fill">fill in order</option><option value="spread">spread</option></select></label>
  <label class="in" title="Usage % at which a seat stops taking new work"><span class="lbl">Switch at</span>
    <input type="number" class="field n" id="threshold" min="1" max="100">%</label>
  <button id="refreshAll" title="Refresh the usage of every seat">Refresh all</button>
  <button class="primary" id="addToggle">Add seat</button>
</div>
<div class="row" id="addRow" hidden>
  <input type="text" class="field" id="newLabel" placeholder="Label" style="width:160px">
  <input type="password" class="field" id="newToken" placeholder="setup-token (optional, else a login window opens)" style="flex:1;min-width:200px">
  <button class="primary" id="add">Add</button>
</div>
<div id="flash"></div>

<div class="tabs">
  <button class="tab on" data-act="tab" data-id="seats">Seats</button>
  <button class="tab" data-act="tab" data-id="usage">Usage</button>
</div>

<div class="pane" id="pane-seats">
  <section class="zone">
    <div class="zh">
      <span class="row" id="stats"></span>
      <span class="spacer"></span>
      <select class="field" id="seatSort" title="Row order"><option value="manual">manual order</option><option value="reset">by reset</option></select>
      <button class="runs" id="runsBtn" data-act="runs" title="Turns running on the seats"><span class="dot"></span><span id="actCount">0 running</span></button>
    </div>
    <div class="drop" id="actPanel" hidden>
      <div class="empty" id="actEmpty">Nothing ran since the plugin started.</div>
      <div id="actWrap" hidden>
        <table>
          <thead><tr><th>Status</th><th>What</th><th class="c-opt">Model</th><th class="c-opt">Seat</th><th class="r">Tokens</th><th class="r">API $</th><th class="r">Time</th><th></th></tr></thead>
          <tbody id="act"></tbody>
        </table>
      </div>
      <details id="histBox">
        <summary class="zh"><b>Recent requests</b> <span class="muted" id="histCount"></span></summary>
        <table><tbody id="hist"></tbody></table>
      </details>
    </div>
    <div class="zb">
      <table>
        <thead><tr><th class="c-narrow" title="Seat order">#</th><th>Seat</th><th>Status</th><th title="5h window left, and its reset">5h left</th><th class="c-week" title="Weekly window left, and its reset">Week left</th><th class="r" title="API-equivalent value: current 5h window, and today">$</th><th></th></tr></thead>
        <tbody id="acc"></tbody>
      </table>
    </div>
    <div class="facts" id="seatFacts"></div>
  </section>
</div>

<div class="pane" id="pane-usage" hidden>
  <section class="zone grow">
    <div class="zh">
      <span class="seg"><button data-act="uview" data-id="overview">Overview</button><button data-act="uview" data-id="byseat">By seat</button><button data-act="uview" data-id="hourly">Hourly</button><button data-act="uview" data-id="daily">Daily</button><button data-act="uview" data-id="cost">Cost</button><button data-act="uview" data-id="capacity">Capacity</button><button data-act="uview" data-id="quota">Quota</button></span>
      <span class="seg" id="qwinSeg" hidden><button data-act="qwin" data-id="five">5h</button><button data-act="qwin" data-id="week">Week</button></span>
      <span class="seg" id="ucapSeg" hidden><button data-act="ucap" data-id="five_hour">5h</button><button data-act="ucap" data-id="seven_day">Week</button></span>
      <span class="spacer"></span>
      <select class="field" id="useAcc" title="Seat"></select>
      <select class="field" id="usePeriod" title="Period"></select>
      <span class="seg" id="uchartSeg"><button data-act="uchart" data-id="bars">Bars</button><button data-act="uchart" data-id="lines">Lines</button></span>
      <span class="seg"><button data-act="umetric" data-id="tokens">Tokens</button><button data-act="umetric" data-id="cost">$</button></span>
    </div>
    <div class="empty" id="useEmpty">No usage recorded yet.</div>
    <div class="ub" id="useBody" hidden>
      <div class="strip" id="useStrip" style="margin:-8px -12px 0"></div>
      <div class="row small muted"><span id="useScope"></span><span class="spacer"></span><span id="useStatus"></span></div>
      <div class="uchart" id="useChart"></div>
      <div class="legend" id="useLegend"></div>
    </div>
  </section>
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
