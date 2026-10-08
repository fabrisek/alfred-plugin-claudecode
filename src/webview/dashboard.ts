/**
 * The Claude panel: every seat with its usage and resets, and everything that
 * runs on them right now (conversation turns, their sub-agents, delegated
 * Claude Code sessions, completion requests).
 *
 * One document in a null-origin sandboxed iframe: no stylesheet fetch, no
 * storage, no dialogs, every interaction through `window.alfred.invoke`.
 *
 * Rendering is incremental on purpose. The page polls `poolSnapshot` (local
 * state only, a few ms) with ONE self-rescheduling timeout — a slow or stalled
 * worker can never stack requests — faster while something runs, paused while
 * the panel is hidden. Rows are keyed: a row whose markup did not change is not
 * touched, so a token being typed, an armed Remove/Stop button or a hover
 * survives every poll (two-step buttons keep their armed state in the script
 * for the same reason). Durations and countdowns tick from one 1 s interval
 * that only rewrites the text that changed.
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

// Class vocabulary copied from the AutoPilot shell (the design-system
// reference), tightened for a dense one-screen panel, plus the usage bars.
const STYLES = `${DESIGN_TOKENS}${PILL_CSS}
* { box-sizing: border-box; }
body { margin: 0; padding: 12px 16px; background: var(--bg); color: var(--text);
  font: 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif; }
h1 { font-size: 16px; margin: 0; }
h2 { font-size: 11px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: .07em;
  color: var(--muted); display: flex; gap: 8px; align-items: baseline; }
.toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
.spacer { flex: 1; }
.banner { border: 1px solid var(--border); border-left: 3px solid var(--warn); background: var(--panel);
  padding: 6px 10px; border-radius: 6px; margin-bottom: 8px; font-size: 12px;
  display: flex; gap: 8px; align-items: center; }
.banner.ok { border-left-color: var(--ok); }
.banner.err { border-left-color: var(--err); }
.banner .bt { flex: 1; word-break: break-word; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.stat { border: 1px solid var(--border); background: var(--panel); border-radius: 6px;
  padding: 5px 10px; min-width: 104px; }
.stat .k { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
.stat .v { font-size: 15px; font-variant-numeric: tabular-nums; }
.stat .v .muted { font-size: 11px; }
.wrap { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--panel); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--muted); font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
  white-space: nowrap; }
tr:last-child td { border-bottom: none; }
tr.cur td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
tr.sub td { padding-top: 3px; padding-bottom: 3px; background: rgba(127,127,127,.04); }
tr.sub .what { padding-left: 18px; }
tr.det td { background: rgba(127,127,127,.06); }
tr.off td { opacity: .55; }
.empty { padding: 10px; text-align: center; color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.mono { font-family: var(--mono); font-size: 11px; }
.nowrap { white-space: nowrap; }
.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ell { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ell.s { max-width: 220px; }
.tag { display: inline-block; padding: 0 5px; border-radius: 4px; border: 1px solid var(--border);
  font-size: 10px; color: var(--muted); vertical-align: 1px; }
.tag.warn { color: var(--warn); border-color: currentColor; }
.tag.info { color: var(--accent); border-color: currentColor; }
button { font: inherit; font-size: 11px; padding: 3px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; white-space: nowrap; }
button:hover { border-color: var(--accent); color: var(--accent); }
button:disabled { opacity: .45; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { opacity: .9; color: #fff; }
button.danger:hover, button.armed { border-color: var(--err); color: var(--err); }
button.x { border: none; background: none; padding: 0 4px; color: var(--muted); }
.acts { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.field { font: inherit; font-size: 12px; padding: 3px 7px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--field); color: var(--text); }
input.field.n { width: 52px; }
label.in { display: flex; gap: 4px; align-items: center; font-size: 11px; color: var(--muted); }
.bar { position: relative; height: 6px; border-radius: 999px; background: var(--border);
  overflow: hidden; width: 72px; flex: none; }
.bar > i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ok); }
.bar.warn > i { background: var(--warn); }
.bar.err > i { background: var(--err); }
.meter { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.meter + .meter { margin-top: 2px; }
.meter .p { min-width: 30px; text-align: right; font-variant-numeric: tabular-nums; }
.meter .w { min-width: 34px; }
td.ord { width: 1%; padding-right: 0; }
.pos { display: inline-block; min-width: 14px; font-variant-numeric: tabular-nums; color: var(--muted); }
button.mv { padding: 0 4px; font-size: 9px; line-height: 14px; margin-left: 2px; }
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
// Two-step buttons (no confirm() in the sandbox). Kept here, not on the
// button, so the armed state survives a row being rebuilt by a poll.
var ARM_MS = 3000;
var armed = {};
var armTimer = 0;

// ---- formatting -----------------------------------------------------------

function fmtTokens(n) {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
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
    + ', API-equiv $' + Number(t.costUsd || 0).toFixed(2);
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

// ---- activity -------------------------------------------------------------

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
      + '<td class="nowrap">' + pill + '</td>'
      + '<td><div class="ell" title="' + esc((tt.who ? tt.who + ' \\u00b7 ' : '') + tt.what) + '">'
      + (canOpen ? '<button class="x" data-act="iters" data-id="' + esc(a.id) + '" title="Show the requests of this turn">' + (open ? '\\u25be' : '\\u25b8') + '</button>' : '')
      + '<span class="tag">' + KIND_TAG[a.kind] + '</span> ' + head + '</div>'
      + (meta.length ? '<div class="muted small ell" title="' + esc(a.detail || a.phase || '') + '">' + meta.join(' \\u00b7 ') + '</div>' : '') + '</td>'
      + '<td class="nowrap"><span class="mono" title="' + esc(a.model || '') + (a.servedModel ? ' \\u2192 ' + esc(a.servedModel) : '') + '">' + esc(model) + '</span>'
      + (a.effort ? ' <span class="tag">' + esc(a.effort) + '</span>' : '') + '</td>'
      + '<td class="nowrap">' + (a.seat ? esc(a.seat) : running ? '<span class="muted">no seat yet</span>' : '') + '</td>'
      + '<td class="num small">' + tok + (ctx ? '<div class="muted" title="Context used">ctx ' + ctx + '</div>' : '') + '</td>'
      + '<td class="nowrap">' + timeCell(a.startedAt, a.endedAt) + '</td>'
      + '<td><div class="acts">' + (a.canStop ? armBtn('stop', a.id, 'Stop', 'Confirm stop') : '') + '</div></td>'
      + '</tr>';
    rows.push({ key: 'a:' + a.id, html: html });
    if (open) {
      iters.slice().reverse().forEach(function (i) {
        var what = i.tools.length ? 'called ' + i.tools.join(', ') : i.status === 'running' ? (i.phase || 'running') : 'answered';
        rows.push({ key: 'i:' + a.id + ':' + i.n, html: '<tr class="sub">'
          + '<td><span class="pill ' + (IT_PILL[i.status] || 'idle') + '">' + esc(i.status) + '</span></td>'
          + '<td class="what"><div class="ell">\\u21b3 #' + i.n + ' ' + esc(what) + '</div></td>'
          + '<td></td><td class="nowrap">' + esc(i.seat || '') + '</td>'
          + '<td class="num small">' + (i.tokensOut ? fmtTokens(i.tokensOut) + ' out' : '') + '</td>'
          + '<td class="nowrap">' + timeCell(i.startedAt, i.endedAt) + '</td><td></td></tr>' });
      });
    }
    a.subagents.forEach(function (s) {
      var line = s.summary || s.lastTool || '';
      rows.push({ key: 's:' + a.id + ':' + s.id, html: '<tr class="sub">'
        + '<td><span class="pill ' + (SUB_PILL[s.status] || 'idle') + '">' + esc(s.status) + '</span></td>'
        + '<td class="what"><div class="ell" title="' + esc(s.description || '') + '">\\u21b3 <b>' + esc(s.type || 'sub-agent') + '</b>'
        + (s.background ? ' <span class="tag">bg</span>' : '') + ' ' + esc(s.description || '') + '</div>'
        + (line ? '<div class="muted small ell" title="' + esc(line) + '">' + esc(line) + '</div>' : '') + '</td>'
        + '<td></td><td></td><td></td>'
        + '<td class="nowrap">' + timeCell(s.startedAt, s.endedAt) + '</td><td></td></tr>' });
    });
  });
  return rows;
}

// ---- accounts -------------------------------------------------------------

var STATUS_PILL = { active: 'info', ok: 'ok', exhausted: 'warn', 'logged out': 'err', 'auth failed': 'err', disabled: 'idle' };

function meter(w, label, threshold, mode) {
  if (!w) return '';
  var pct = w.percent == null ? null : Math.max(0, Math.min(100, w.percent));
  var cls = pct == null ? '' : pct >= 100 ? 'err' : pct >= threshold ? 'warn' : '';
  var when = w.resetsAt ? (mode === 'date' ? '<span title="Resets ' + esc(fmtWhen(w.resetsAt)) + '">' + esc(fmtWhen(w.resetsAt)) + '</span>'
    : '<span title="Resets ' + esc(fmtClock(w.resetsAt)) + '">' + live('left', w.resetsAt) + '</span>') : '';
  return '<div class="meter">' + (label ? '<span class="w muted small">' + esc(label) + '</span>' : '')
    + '<div class="bar ' + cls + '"><i style="width:' + (pct || 0) + '%"></i></div>'
    + '<span class="p">' + (pct == null ? '?' : Math.round(pct) + '%') + '</span>'
    + '<span class="muted small">' + when + '</span></div>';
}

function accountRows(s) {
  var byEmail = {};
  s.accounts.forEach(function (a) { if (a.email) (byEmail[a.email] = byEmail[a.email] || []).push(a.label); });
  var rows = [];
  var last = s.accounts.length - 1;
  var orderTitle = s.settings.strategy === 'fill'
    ? 'Order of use: the first usable seat serves, the next one takes over when it is exhausted or disabled'
    : 'Order of use (spread balances by usage; order only breaks ties)';
  s.accounts.forEach(function (a, i) {
    var u = a.usage || { windows: [] };
    var five = u.windows.filter(function (w) { return w.key === 'five_hour'; })[0];
    var week = u.windows.filter(function (w) { return w.key === 'seven_day'; })[0];
    var scoped = u.windows.filter(function (w) { return w.model; });
    var weekCell = meter(week, scoped.length ? 'all' : '', s.settings.threshold, 'date')
      + scoped.map(function (w) { return meter(w, w.model, s.settings.threshold, 'date'); }).join('');
    var twins = (byEmail[a.email] || []).filter(function (l) { return l !== a.label; });
    var tags = (a.subscriptionType ? ' <span class="tag">' + esc(a.subscriptionType) + '</span>' : '')
      + (a.auth === 'token' ? ' <span class="tag">token</span>' : '')
      + (a.exposeModels ? ' <span class="tag" title="model@seat variants are listed in the model picker">pinned</span>' : '')
      + (twins.length ? ' <span class="tag warn" title="Same Claude login as ' + esc(twins.join(', ')) + '">same login as ' + esc(twins.join(', ')) + '</span>' : '');
    var t = a.tokens;
    var bz = function (act) { return busy[act + ':' + a.id] ? ' disabled' : ''; };
    var needsLogin = a.status === 'logged out' || a.status === 'auth failed';
    var html = '<tr class="' + (a.status === 'active' ? 'cur' : '') + (a.enabled ? '' : ' off') + '">'
      + '<td class="ord"><div class="nowrap" title="' + orderTitle + '"><span class="pos">' + (i + 1) + '</span>'
      + '<button class="mv" data-act="up" data-id="' + esc(a.id) + '"' + (i === 0 || bz('order') ? ' disabled' : '') + ' title="Move up">▲</button>'
      + '<button class="mv" data-act="down" data-id="' + esc(a.id) + '"' + (i === last || bz('order') ? ' disabled' : '') + ' title="Move down">▼</button></div></td>'
      + '<td><div class="nowrap"><b>' + esc(a.label) + '</b>' + tags + '</div>'
      + '<div class="muted small ell s" title="' + esc((a.email || a.id) + (a.orgName ? ' \\u00b7 ' + a.orgName : '')) + '">' + esc(a.email || a.id) + '</div></td>'
      + '<td class="nowrap"><span class="pill ' + (STATUS_PILL[a.status] || 'idle') + '" title="' + esc(a.statusDetail || '') + '">' + esc(a.status) + '</span>'
      + (a.inFlight ? ' <span class="tag info">' + a.inFlight + ' running</span>' : '')
      + (a.exhaustedUntil ? '<div class="muted small" title="Back ' + esc(fmtWhen(a.exhaustedUntil)) + '">back in ' + live('left', a.exhaustedUntil) + '</div>' : '')
      + (u.stale ? '<div class="muted small ell s" title="Usage not refreshed: ' + esc(u.stale) + '">usage stale</div>' : '') + '</td>'
      + '<td>' + (meter(five, '', s.settings.threshold, 'count') || '<span class="muted">\\u2014</span>') + '</td>'
      + '<td>' + (weekCell || '<span class="muted">\\u2014</span>') + '</td>'
      + '<td class="num small"><span title="' + esc(tallyTitle('5h window', t.window5h)) + '">' + fmtTokens(t.window5h.output) + ' out \\u00b7 ' + fmtTokens(sumIn(t.window5h)) + ' in</span>'
      + '<div class="muted" title="' + esc(tallyTitle('Week', t.week) + '\\n' + tallyTitle('Total', t.total)) + '">week ' + fmtTokens(t.week.output) + ' out</div></td>'
      + '<td><div class="acts">'
      + (needsLogin ? '<button class="primary" data-act="login" data-id="' + esc(a.id) + '"' + bz('login') + '>Log in</button>' : '')
      + '<button data-act="refresh" data-id="' + esc(a.id) + '"' + bz('refresh') + ' title="Refresh usage">Refresh</button>'
      + '<button data-act="test" data-id="' + esc(a.id) + '"' + bz('test') + ' title="Tiny completion on this seat">Test</button>'
      + '<button data-act="more" data-id="' + esc(a.id) + '" title="More actions">' + (openDetails[a.id] ? 'Less' : 'More') + '</button>'
      + '</div></td></tr>';
    rows.push({ key: 'acc:' + a.id, html: html });
    if (openDetails[a.id]) {
      var err = a.lastError ? '<span class="muted small" title="' + esc(a.lastError.message) + '">' + esc(fmtClock(a.lastError.at) + ' ' + a.lastError.message) + '</span>' : '';
      rows.push({ key: 'det:' + a.id, html: '<tr class="det"><td colspan="7"><div class="toolbar" style="margin:0">'
        + '<input type="password" class="field" style="flex:1;min-width:180px" placeholder="claude setup-token (empty = use login)" id="tokv-' + esc(a.id) + '">'
        + '<button data-act="savetoken" data-id="' + esc(a.id) + '"' + bz('savetoken') + '>Save token</button>'
        + (needsLogin ? '' : '<button data-act="login" data-id="' + esc(a.id) + '"' + bz('login') + '>Log in again</button>')
        + '<button data-act="toggle" data-id="' + esc(a.id) + '"' + bz('toggle') + '>' + (a.enabled ? 'Disable' : 'Enable') + '</button>'
        + (i === 0 ? '' : '<button data-act="top" data-id="' + esc(a.id) + '"' + bz('order') + '>Move to top</button>')
        + '<button data-act="pin" data-id="' + esc(a.id) + '"' + bz('pin') + '>' + (a.exposeModels ? 'Unpin models' : 'Pin models') + '</button>'
        + (a.exhaustedUntil ? '<button data-act="clear" data-id="' + esc(a.id) + '"' + bz('clear') + ' title="Put the seat back in rotation now">Clear limit</button>' : '')
        + armBtn('remove', a.id, 'Remove', 'Confirm remove')
        + '</div>' + (err ? '<div style="margin-top:4px">Last error: ' + err + '</div>' : '') + '</td></tr>' });
    }
  });
  return rows;
}

// ---- history (persisted served records) --------------------------------------

var OUTCOME_PILL = { ok: 'ok', switched: 'warn', error: 'err' };
function historyRows(recent) {
  return recent.slice(0, 8).map(function (r, i) {
    var model = shortModel(r.servedModel || r.model);
    return { key: 'h:' + r.at + ':' + r.accountId + ':' + i, html: '<tr>'
      + '<td class="mono">' + esc(fmtClock(r.at)) + '</td>'
      + '<td><span class="pill ' + (OUTCOME_PILL[r.outcome] || 'idle') + '">' + esc(r.outcome) + '</span></td>'
      + '<td class="nowrap">' + esc(r.accountLabel) + '</td>'
      + '<td class="mono nowrap">' + esc(model) + (r.kind === 'session' ? ' <span class="tag">session</span>' : '') + '</td>'
      + '<td class="nowrap">' + esc(r.agent || '') + '</td>'
      + '<td class="num small">' + (r.tokens ? fmtTokens(r.tokens.output) + ' out \\u00b7 ' + fmtTokens(sumIn(r.tokens)) + ' in' : '') + '</td>'
      + '<td class="small"><div class="ell s" title="' + esc(r.detail || '') + '">' + esc(r.detail || '') + '</div></td></tr>' };
  });
}

// ---- render ---------------------------------------------------------------

function stat(k, v, title) {
  return '<div class="stat" title="' + esc(title || '') + '"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
}

function render() {
  if (!snap) return;
  var s = snap;
  var acts = s.activity || [];
  var running = acts.filter(function (a) { return isLive(a.status); });
  var subs = 0;
  acts.forEach(function (a) { a.subagents.forEach(function (x) { if (x.status === 'running') subs++; }); });
  var usable = s.accounts.filter(function (a) { return a.status === 'ok' || a.status === 'active'; }).length;
  var nextBack = s.accounts.map(function (a) { return a.exhaustedUntil; }).filter(Boolean).sort()[0];
  var t = s.totals;
  setHtml('stats',
    stat('Seats', usable + '<span class="muted"> / ' + s.accounts.length + ' usable</span>', nextBack ? 'Next seat back ' + fmtWhen(nextBack) : '')
    + stat('Running', running.length + '<span class="muted"> ' + (running.length === 1 ? 'turn' : 'turns') + '</span>')
    + stat('Sub-agents', subs + '<span class="muted"> running</span>')
    + stat('Tokens 5h', fmtTokens(t.window5h.output) + '<span class="muted"> out \\u00b7 ' + fmtTokens(sumIn(t.window5h)) + ' in</span>', tallyTitle('5h windows', t.window5h))
    + stat('Week', fmtTokens(t.week.output) + '<span class="muted"> out \\u00b7 $' + Number(t.week.costUsd || 0).toFixed(0) + ' API-equiv</span>', tallyTitle('Week', t.week)));

  var strat = $('strategy');
  if (document.activeElement !== strat && strat.value !== s.settings.strategy) strat.value = s.settings.strategy;
  var th = $('threshold');
  if (document.activeElement !== th && th.value !== String(s.settings.threshold)) th.value = String(s.settings.threshold);
  setText('cli', s.cli);

  // Everything live, then the last few finished: history is not the point here.
  var shown = running.concat(acts.filter(function (a) { return !isLive(a.status); }).slice(0, FINISHED_SHOWN));
  setText('actCount', running.length ? running.length + ' running' : acts.length ? 'idle' : '');
  sync($('act'), activityRows(shown));
  $('actWrap').hidden = acts.length === 0;
  $('actEmpty').hidden = acts.length !== 0;

  sync($('acc'), accountRows(s));

  var recent = s.recent || [];
  setText('histCount', recent.length ? String(Math.min(recent.length, 8)) : '');
  sync($('hist'), $('histBox').open ? historyRows(recent) : []);
  tick();
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
$('histBox').addEventListener('toggle', function () { render(); });
document.addEventListener('visibilitychange', function () {
  if (document.hidden) { clearTimeout(pollTimer); pollTimer = 0; } else poll();
});

setInterval(tick, 1000);
poll();
`;

export function renderDashboard(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Claude</title>
  <style>${STYLES}</style>
</head>
<body>
<div class="toolbar">
  <h1>Claude</h1>
  <span class="muted small mono" id="cli"></span>
  <span class="pill err" id="conn" hidden>offline</span>
  <span class="spacer"></span>
  <label class="in" title="fill: use the preferred seat until the threshold; spread: balance across seats">Strategy
    <select class="field" id="strategy"><option value="fill">fill</option><option value="spread">spread</option></select></label>
  <label class="in" title="Usage % at which fill moves to the next seat">Switch at
    <input type="number" class="field n" id="threshold" min="1" max="100">%</label>
  <button id="refreshAll" title="Refresh the usage of every seat">Refresh all</button>
  <button class="primary" id="addToggle">Add seat</button>
</div>
<div class="toolbar" id="addRow" hidden>
  <input type="text" class="field" id="newLabel" placeholder="Label" style="width:160px">
  <input type="password" class="field" id="newToken" placeholder="setup-token (optional, else a login window opens)" style="flex:1;min-width:200px">
  <button class="primary" id="add">Add</button>
</div>
<div id="flash"></div>
<div class="stats" id="stats"></div>

<h2>Activity <span id="actCount"></span></h2>
<div class="empty wrap" id="actEmpty">Nothing ran since the plugin started.</div>
<div class="wrap scroll" id="actWrap" hidden>
  <table>
    <thead><tr><th>Status</th><th>What</th><th>Model</th><th>Seat</th><th>Tokens</th><th>Time</th><th></th></tr></thead>
    <tbody id="act"></tbody>
  </table>
</div>

<h2>Seats</h2>
<div class="wrap scroll">
  <table>
    <thead><tr><th title="Order of use">#</th><th>Seat</th><th>Status</th><th>5h</th><th>Week</th><th>Tokens 5h</th><th></th></tr></thead>
    <tbody id="acc"></tbody>
  </table>
</div>

<details id="histBox">
  <summary><h2 style="display:inline-flex">History <span id="histCount"></span></h2></summary>
  <div class="wrap scroll">
    <table><tbody id="hist"></tbody></table>
  </div>
</details>
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
