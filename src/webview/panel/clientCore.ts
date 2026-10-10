/**
 * Client script, part 1: shared state and helpers of the Claude panel —
 * formatting, the panel cell (see usage/seatsUsage.ts), period totals, seat
 * state, plan weighting, the smoothed curve and sparkline primitives, the
 * tooltip and the drawer.
 *
 * Plain browser script (no modules) concatenated with the other parts into
 * one inline <script>; `invoke` and `esc` are defined before it. Written as a
 * raw template: it must contain no backtick and no dollar-brace.
 */

export const CORE_JS = String.raw`
const RM = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s) => document.querySelector(s);
const now = () => Date.now();
const FIVE_H = 5 * 3600e3;
const HOUR = 3600e3;
/** Latest seatsUsage payload and poolSnapshot. */
let D = null;
let SNAP = null;
/** True while drawing for the first time (or after a tab / density switch): counters and curves animate. */
let ANIM = true;

/* ---------- format ---------- */
function tok(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
}
function usd(n, d) {
  n = Number(n) || 0;
  if (d == null) d = n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function dur(ms) {
  if (!(ms > 0)) return 'now';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + pad2(m) + 'm';
  return m + 'm ' + pad2(s % 60) + 's';
}
/** Like dur, without the seconds. */
function durShort(ms) {
  if (!(ms > 0)) return 'now';
  if (ms >= HOUR) return dur(ms);
  return Math.max(1, Math.floor(ms / 60000)) + 'm';
}
const hhmm = (t) => { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
const hh = (t) => pad2(new Date(t).getHours());
function dayDate(d) { const p = String(d).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12); }
const dayName = (d) => dayDate(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const dayShort = (d) => dayDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const pctOf = (v, tot) => (tot > 0 ? Math.round(v / tot * 100) : 0);

/* ---------- panel cell ---------- */
// cell: 0..3 tokens (input, cache write, cache read, output), 4..7 their $, 8 requests,
// 9 $ without cache, 10 advisor tokens, 11 advisor $
const tokT = (c) => (c[0] || 0) + (c[1] || 0) + (c[2] || 0) + (c[3] || 0) + (c[10] || 0);
const valT = (c) => (c[4] || 0) + (c[5] || 0) + (c[6] || 0) + (c[7] || 0) + (c[11] || 0);
const addc = (a, b) => { for (let i = 0; i < b.length; i++) a[i] = (a[i] || 0) + b[i]; return a; };

function countUp(el, to, fmt, ms) {
  if (!el) return;
  if (RM || !ANIM || typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') { el.textContent = fmt(to); return; }
  const t0 = performance.now(); ms = ms || 900;
  (function step(t) { const k = Math.max(0, Math.min(1, (t - t0) / ms)); el.textContent = fmt(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); })(t0);
}
/** Writes markup only when it changed: hover, focus and running transitions survive a poll. */
function setHtml(el, html) {
  if (!el) return false;
  if (el.__html === html) return false;
  el.__html = html;
  el.innerHTML = html;
  return true;
}
function seg(sel, cb) {
  const el = $(sel);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; e.stopPropagation();
    el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); cb(b.dataset.v);
  });
  return () => { const b = el.querySelector('button.on'); return b ? b.dataset.v : null; };
}

/* ---------- series and names ---------- */
const TYPES = [
  { k: 'read', name: 'Cache read', tok: 2, usd: 6, c: 'var(--s1)' },
  { k: 'write', name: 'Cache write', tok: 1, usd: 5, c: 'var(--s2)' },
  { k: 'input', name: 'Input', tok: 0, usd: 4, c: 'var(--s3)' },
  { k: 'output', name: 'Output', tok: 3, usd: 7, c: 'var(--s4)' },
  { k: 'advisor', name: 'Advisor', tok: 10, usd: 11, c: 'var(--s7)' },
];
const REASON = { 'new session: system prompt rewritten': 'system prompt rewritten', 'new session: history shrank or was replayed': 'history replayed', 'cache miss': 'cache miss', 'new conversation': 'new conversation', 'prompt cache expired': 'cache expired' };
const reasonOf = (r) => REASON[r] || String(r || '').split('new session: ').join('');
let TEAM = [], PERSO = [], SEATS = [];
let SEAT_COLORS = {}, AGENT_COLORS = {};
const seatOf = (id) => SEATS.find((x) => x.id === id);
function short(id) {
  if (id === 'unknown') return 'before seat tracking';
  const s = seatOf(id);
  if (!s) return id;
  const l = String(s.label || id);
  return s.org === 'team' ? l.split('claude-').join('') : l.split('@')[0];
}
function modelMeta(k) {
  const label = (D && D.models && D.models[k]) || k;
  const key = String(k);
  let c = 'var(--s-neutral)';
  if (key.indexOf('advisor') >= 0) c = 'var(--s7)';
  else if (key.indexOf('opus') === 0) c = 'var(--s1)';
  else if (key.indexOf('fable') === 0) c = 'var(--s5)';
  else if (key.indexOf('sonnet') === 0) c = 'var(--s3)';
  else if (key.indexOf('haiku') === 0) c = 'var(--s4)';
  return [label, c];
}
/** Seat order, colours and agent colours: recomputed when new data arrives. */
function indexSeats() {
  SEATS = D.seats.slice();
  TEAM = SEATS.filter((s) => s.org === 'team').sort((a, b) => a.priority - b.priority);
  PERSO = SEATS.filter((s) => s.org !== 'team').sort((a, b) => a.priority - b.priority);
  SEAT_COLORS = {};
  TEAM.forEach((s, i) => { SEAT_COLORS[s.id] = 'var(--s' + ((i % 8) + 1) + ')'; });
  PERSO.forEach((s) => { SEAT_COLORS[s.id] = 'var(--s-neutral)'; });
  const ag = (D.agents || []).slice().sort((a, b) => (b.p.all[0] || 0) - (a.p.all[0] || 0));
  AGENT_COLORS = {};
  ag.forEach((a, i) => { AGENT_COLORS[a.name] = 'var(--s' + ((i % 8) + 1) + ')'; });
}

/* ---------- periods ---------- */
const lastHourT = () => Math.floor(now() / HOUR) * HOUR;
function periodData(p) {
  const t = now(), last = lastHourT();
  let hours = null, days = null, span;
  if (p === '5h') { hours = D.hourly.filter((h) => h.t > last - 5 * HOUR); span = 5 / 24; }
  else if (p === '24h') { hours = D.hourly.filter((h) => h.t > last - 24 * HOUR); span = 1; }
  else if (p === 'today') { hours = D.hourly.filter((h) => h.t >= D.day0); span = Math.max(1 / 1440, (t - D.day0) / 86400e3); }
  else { days = D.daily.slice(p === '7d' ? -7 : 0); span = Math.max(1 / 1440, Math.min(p === '7d' ? 7 : 1e9, (t - D.firstAt) / 86400e3)); }
  const tot = [], seat = {}, model = {};
  (hours || days).forEach((r) => {
    addc(tot, r.tot);
    Object.keys(r.seat).forEach((k) => { seat[k] = addc(seat[k] || [], r.seat[k]); });
    Object.keys(r.model || {}).forEach((k) => { model[k] = addc(model[k] || [], r.model[k]); });
  });
  return { p, hours, days, rows: hours || days, tot, seat, model, span };
}
/** Same span just before (5h, today): the KPI deltas. */
function prevData(p) {
  const last = lastHourT();
  let a, b;
  if (p === 'today') { a = D.day0 - 86400e3; b = last - 86400e3; }
  else if (p === '5h') { a = last - 9 * HOUR; b = last - 4 * HOUR; }
  else return null;
  const rows = D.hourly.filter((h) => h.t > a - 1 && h.t <= b);
  if (!rows.length) return null;
  return rows.reduce((acc, r) => addc(acc, r.tot), []);
}
let P = null;
const periodLabel = () => ({ '5h': 'last 5 hours', today: 'today', '7d': 'last 7 days', all: 'since tracking began' })[P.p];
/** The period's hourly rows with missing hours filled, so every axis is honest. */
function hourRows() {
  if (!P.hours) return P.rows;
  const last = lastHourT(), first = P.p === 'today' ? D.day0 : last - 4 * HOUR;
  const map = new Map(P.hours.map((h) => [h.t, h])), rows = [];
  for (let t = Math.ceil(first / HOUR) * HOUR; t <= last; t += HOUR) rows.push(map.get(t) || { t, tot: [], seat: {}, model: {} });
  return rows;
}
/** API value over the period divided by what the plans cost over the same period (usage/pricing.ts prices). */
function subMultiple(value, spanDays) {
  const c = D.subscription && D.subscription.perDayUsd * spanDays;
  return c > 0 ? value / c : null;
}
const fmtMult = (m) => (m == null ? '—' : m >= 10 ? Math.round(m) : m.toFixed(1));

/* ---------- seats ---------- */
const lvl = (left) => (left > 40 ? 'var(--ok)' : left > 15 ? 'var(--warn)' : 'var(--err)');
const stCls = { ok: 'ok', info: 'info-c', warn: 'warn', err: 'err', off: 'off-c' };
function seatState(s) {
  const fiveLeft = s.five ? Math.max(0, Math.round(100 - s.five.pct)) : null;
  const weekLeft = s.week ? Math.max(0, Math.round(100 - s.week.pct)) : null;
  const left = Math.min(fiveLeft == null ? 100 : fiveLeft, weekLeft == null ? 100 : weekLeft);
  const busy = s.threads.some((t) => t.busy) || s.inFlight > 0;
  let status = 'ready', cls = 'ok';
  const ps = s.poolStatus;
  if (!s.enabled || ps === 'disabled') { status = 'disabled'; cls = 'off'; }
  else if (ps === 'exhausted' || left <= 0) { status = 'exhausted'; cls = 'err'; }
  else if (ps === 'auth failed') { status = 'auth failed'; cls = 'err'; }
  else if (ps === 'throttled') { status = 'throttled'; cls = 'warn'; }
  else if (ps !== 'ok' && ps !== 'active') { status = ps; cls = 'warn'; }
  else if (busy) { status = 'in use'; cls = 'info'; }
  const pastReset = s.eta == null || (s.five && s.eta > s.five.resetsAt - now());
  return { fiveLeft, weekLeft, left, status, cls, burn: s.burn, eta: s.eta, pastReset };
}
/** Plan-weighted utilisation of the 5h or week window over the seats that report it. */
function weighted(key) {
  const rows = SEATS.map((s) => ({ s, w: s.weight || 1, pct: key === 'five' ? (s.five ? s.five.pct : null) : (s.week ? s.week.pct : null) }));
  const rep = rows.filter((r) => r.pct != null), wsum = rep.reduce((a, r) => a + r.w, 0);
  return { rows, pct: wsum ? rep.reduce((a, r) => a + r.pct * r.w, 0) / wsum : null, wRep: wsum, wAll: rows.reduce((a, r) => a + r.w, 0), n: rep.length };
}
const weightsLabel = () => { const w = D.weights || {}; return 'STD ' + w.STD + ' · PRM ' + w.PRM + ' · MAX ' + w.MAX; };

/* ---------- curves ---------- */
let uid = 0;
/** Monotone cubic (Fritsch–Carlson) through points: no overshoot, so a stacked band never crosses its neighbour. */
function mono(p, move) {
  const n = p.length; if (!n) return '';
  let d = (move === false ? 'L' : 'M') + p[0][0].toFixed(1) + ' ' + p[0][1].toFixed(1);
  if (n === 1) return d;
  const m = [], t = [];
  for (let i = 0; i < n - 1; i++) m[i] = (p[i + 1][1] - p[i][1]) / ((p[i + 1][0] - p[i][0]) || 1e-9);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i + 1][0] - p[i][0];
    d += 'C' + (p[i][0] + dx / 3).toFixed(1) + ' ' + (p[i][1] + t[i] * dx / 3).toFixed(1) + ' ' + (p[i + 1][0] - dx / 3).toFixed(1) + ' ' + (p[i + 1][1] - t[i + 1] * dx / 3).toFixed(1) + ' ' + p[i + 1][0].toFixed(1) + ' ' + p[i + 1][1].toFixed(1);
  }
  return d;
}
/** Mini area sparkline, drawn to the box it is given. A stable key keeps its markup identical when the data is. */
function sparkArea(vals, color, w, h, key) {
  const n = vals.length; if (!n) return '';
  const mx = Math.max(1e-9, Math.max.apply(null, vals)), id = 'sa' + (key || uid++);
  const pts = vals.map((v, i) => [n === 1 ? w / 2 : i / (n - 1) * w, h - 1 - v / mx * (h - 3)]);
  const line = mono(pts), last = pts[n - 1];
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><defs><linearGradient id="' + id + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + color + '" stop-opacity=".45"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + line + 'L' + w + ' ' + h + 'L0 ' + h + 'Z" fill="url(#' + id + ')"/><path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/>' +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2" fill="' + color + '"/></svg>';
}
function niceStep(raw) { if (!(raw > 0)) return 1; const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

/* ---------- tooltip ---------- */
function showTip(html, cx, cy) {
  const tip = $('#tip'); tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth || 220, h = tip.offsetHeight || 120;
  const iw = window.innerWidth || 1600, ih = window.innerHeight || 900;
  let x = cx + 16; if (x + w > iw - 8) x = cx - w - 16;
  let y = cy - 12; if (y + h > ih - 8) y = ih - h - 8;
  tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
}
const hideTip = () => { $('#tip').hidden = true; };
const visible = (el) => !!el && el.offsetParent !== null && el.clientWidth > 0;

/* ---------- drawer: every detail lives here ---------- */
/** What the open drawer shows, so a poll can redraw it with fresh numbers. */
let drawerOf = null;
function openDrawer(title, subTitle, body) {
  $('#dTitle').textContent = title; $('#dSub').textContent = subTitle || '';
  setHtml($('#dBody'), body); $('#drawer').hidden = false; hideTip();
}
function closeDrawer() {
  $('#drawer').hidden = true; drawerOf = null;
  document.querySelectorAll('.bub.sel').forEach((x) => x.classList.remove('sel'));
}
const sub = (title, html) => '<div class="sub"><span class="label">' + title + '</span>' + html + '</div>';
const convLi = (c, right) => '<div class="li"><span class="ag">' + esc(c.agent || '?') + '</span><span class="t" title="' + esc(c.title || '') + '">' + esc(c.title || c.conv || '') + '</span><span class="r">' + right + '</span></div>';
function spark(vals, color) {
  const W = 400, H = 40, n = vals.length; if (!n) return '';
  const mx = Math.max(1e-9, Math.max.apply(null, vals)), id = 'spk';
  const pts = vals.map((v, i) => [(i / Math.max(1, n - 1)) * W, H - 2 - (v / mx) * (H - 4)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><defs><linearGradient id="' + id + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + color + '" stop-opacity=".35"/><stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z" fill="url(#' + id + ')"/><path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>';
}
`;
