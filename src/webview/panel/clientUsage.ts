/**
 * Client script, part 3: the Usage tab's KPI strip (API value with its
 * projection, live tokens / second, tokens split by type / model / seat, 5h
 * and week used plan-weighted), the smoothed stacked-area throughput chart
 * with the cumulative API cost line and the optional cache-event marks, and
 * the pooled 5h capacity curve from the sampled seat quotas.
 */

export const USAGE_JS = String.raw`
const getPeriod = seg('#period', () => { ANIM = true; renderAll(); ANIM = false; });
const getUnit = seg('#unit', () => drawChart(true));
const getSplit = seg('#split', () => drawChart(true));
let tokSplit = 'type';

/* ================= KPI strip ================= */
function weightTip(key, title) {
  const g = weighted(key);
  return '<div class="th">' + title + '<span>' + (g.pct == null ? '—' : Math.round(g.pct) + '% used') + '</span></div>' +
    g.rows.slice().sort((a, b) => (b.pct == null ? -1 : b.pct) - (a.pct == null ? -1 : a.pct)).map((r) => '<div class="trr"><i class="sw" style="background:' + SEAT_COLORS[r.s.id] + '"></i><span>' + esc(short(r.s.id)) + ' <span class="dim">' + esc(r.s.plan) + ' ×' + r.w + '</span></span><span>' + (r.pct == null ? '<span class="dim">not reported</span>' : Math.round(r.pct) + '%') + '</span><span class="p">' + pctOf(r.w, g.wAll) + '%</span></div>').join('') +
    '<div class="tf"><span>weights ' + weightsLabel() + ' (plugin config)</span></div>' + (g.n < g.rows.length ? '<div class="tf"><span>' + g.n + ' of ' + g.rows.length + ' seats report it · ' + pctOf(g.wRep, g.wAll) + '% of capacity</span></div>' : '');
}
function tokRows() {
  const T = P.tot;
  let rows;
  if (tokSplit === 'type') rows = TYPES.map((t) => ({ n: t.name, c: t.c, v: T[t.tok] || 0 }));
  else if (tokSplit === 'model') rows = Object.keys(P.model).map((k) => ({ n: modelMeta(k)[0], c: modelMeta(k)[1], v: tokT(P.model[k]) }));
  else rows = Object.keys(P.seat).map((k) => ({ n: short(k), c: SEAT_COLORS[k] || 'var(--panel-3)', v: tokT(P.seat[k]), hidden: k === 'unknown' }));
  return rows.filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
}
function tokTip() {
  const tot = tokT(P.tot), rows = tokRows();
  return '<div class="th">Tokens by ' + tokSplit + '<span>' + tok(tot) + '</span></div>' + rows.map((r) => '<div class="trr"><i class="sw" style="background:' + r.c + '"></i><span>' + esc(r.n) + '</span><span>' + tok(r.v) + '</span><span class="p">' + (r.v / tot * 100).toFixed(r.v / tot < .01 ? 1 : 0) + '%</span></div>').join('');
}
function renderTokSub() {
  const el = $('#tokSub'); if (!el) return;
  const tot = tokT(P.tot);
  const top = tokRows().filter((r) => !r.hidden);
  el.innerHTML = top.slice(0, 2).map((x) => esc(x.n) + ' <b>' + pctOf(x.v, tot) + '%</b>').join(' · ');
}
$('#kUse').addEventListener('mousemove', (e) => {
  const k = e.target.closest('[data-tip]'); if (!k || e.target.closest('.seg')) return hideTip();
  const t = k.dataset.tip;
  showTip(t === 'tok' ? tokTip() : t === 'tps' ? tpsTip() : t === 'five' ? weightTip('five', '5h usage, plan-weighted') : weightTip('week', 'Week usage, plan-weighted'), e.clientX, e.clientY);
});
$('#kUse').addEventListener('mouseleave', hideTip);
$('#kUse').addEventListener('click', (e) => {
  const b = e.target.closest('.seg button'); if (!b) return;
  e.stopPropagation(); tokSplit = b.dataset.v; b.parentNode.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); renderTokSub();
});
function deltaHtml(cur, prev) {
  if (prev == null || !prev) return '<span class="delta flat">—</span>';
  const d = (cur - prev) / prev, up = d >= 0;
  return '<span class="delta ' + (Math.abs(d) < 0.005 ? 'flat' : up ? 'up' : 'down') + '">' + (up ? '▲' : '▼') + ' ' + Math.abs(d * 100).toFixed(0) + '%</span>';
}
/** Throughput stats of the period (the minute log covers 48h: 7d / All show the last 24h). */
function tpsStats() {
  const key = P.p === '5h' ? '5h' : P.p === 'today' ? 'today' : '24h';
  return { key, s: (D.throughput && D.throughput[key]) || { avgPerSec: 0, peakPerSec: 0, peakAt: null, tokens: 0 } };
}
function tpsNow() {
  const pm = D.perMin || [];
  // the current minute is still filling: show the last complete one
  return pm.length > 1 ? pm[pm.length - 2] / 60 : 0;
}
function tpsTip() {
  const t = tpsStats();
  return '<div class="th">Tokens / second<span>' + (t.key === 'today' ? 'today' : 'last ' + t.key) + '</span></div><div class="kv">' +
    '<span>Last full minute</span><b>' + tok(tpsNow()) + '/s</b><span>Average</span><b>' + tok(t.s.avgPerSec) + '/s</b>' +
    '<span>Peak minute</span><b>' + tok(t.s.peakPerSec) + '/s' + (t.s.peakAt ? ' · ' + hhmm(t.s.peakAt) : '') + '</b><span>Tokens</span><b>' + tok(t.s.tokens) + '</b></div>' +
    '<div class="tf"><span>every served call, from the transcripts, per minute</span></div>';
}
function renderUseKpis() {
  const T = P.tot, value = valT(T), tokens = tokT(T);
  const pv = prevData(P.p), rows = hourRows();
  const ser = (f) => rows.map((r) => (r.tot.length ? f(r.tot) : 0));
  const k = (id, label, open, subl, delta, sp, color) => '<div class="kp" data-open="' + open + '"><span class="l">' + label + '</span><div class="vrow"><span class="v" id="' + id + '"></span><div class="ks">' + sparkArea(sp, color, 120, 26, id) + '</div></div><span class="s">' + delta + ' ' + subl + '</span></div>';
  const mult = subMultiple(value, P.span);
  const proj = P.p === 'today' ? '→ <b>' + usd(value / P.span, 0) + '</b> by midnight' : '<b>' + usd(value / Math.max(1 / 24, P.span), 0) + '</b>/day';
  const g5 = weighted('five'), gw = weighted('week');
  const n = SEATS.length;
  const bars = (key) => '<svg viewBox="0 0 ' + (n * 10) + ' 10" preserveAspectRatio="none" style="height:10px">' + SEATS.map((st, i) => { const w = key === 'five' ? st.five : st.week; const p = w ? w.pct : null; const left = p == null ? 0 : 100 - p;
    return '<rect x="' + (i * 10) + '" y="0" width="8.5" height="10" rx="1.5" fill="var(--panel-3)"' + (p == null ? ' opacity=".4"' : '') + '/>' + (p == null ? '' : '<rect x="' + (i * 10) + '" y="' + (10 - left / 10) + '" width="8.5" height="' + (left / 10) + '" rx="1.5" fill="' + lvl(left) + '"/>'); }).join('') + '</svg>';
  const tp = tpsStats(), live = SEATS.some((s) => s.threads.some((t) => t.busy));
  const pm = (D.perMin || []).slice(0, -1).slice(-30).map((v) => v / 60);
  const html =
    k('ku1', 'API value', 'cost+sub', proj + ' · <b>×' + fmtMult(mult) + '</b> sub', deltaHtml(value, pv && valT(pv)), ser(valT), 'var(--s4)') +
    '<div class="kp" data-open="tokens+records" data-tip="tps"><span class="l"><span class="pulse' + (live ? '' : ' idle') + '" style="vertical-align:middle;margin-right:5px"></span>Tokens / second</span><div class="vrow"><span class="v">' + tok(tpsNow()) + '/s</span><div class="ks">' + sparkArea(pm, 'var(--s1)', 120, 26, 'tps') + '</div></div><span class="s">avg <b>' + tok(tp.s.avgPerSec) + '</b>/s · peak <b>' + tok(tp.s.peakPerSec) + '</b>/s' + (tp.key === '24h' && P.p !== '24h' ? ' (24h)' : '') + '</span></div>' +
    '<div class="kp" data-open="tokens+records" data-tip="tok"><span class="l" style="display:flex;align-items:center;gap:8px">Tokens <span class="seg xs" style="text-transform:none;letter-spacing:0"><button data-v="type"' + (tokSplit === 'type' ? ' class="on"' : '') + '>Type</button><button data-v="model"' + (tokSplit === 'model' ? ' class="on"' : '') + '>Model</button><button data-v="seat"' + (tokSplit === 'seat' ? ' class="on"' : '') + '>Seat</button></span></span><div class="vrow"><span class="v" id="ku4"></span><div class="ks">' + sparkArea(ser(tokT), 'var(--s7)', 120, 26, 'ku4') + '</div></div><span class="s" id="tokSub"></span></div>' +
    '<div class="kp" data-open="seats" data-tip="five"><span class="l">5h used · plan-weighted</span><div class="vrow"><span class="v" id="ku5"></span><div class="ks" style="height:10px;align-self:center">' + bars('five') + '</div></div><span class="s">' + (g5.pct == null ? 'no seat reports it' : '<b>' + Math.round(100 - g5.pct) + '%</b> of weighted capacity left') + '</span></div>' +
    '<div class="kp" data-open="seats" data-tip="week"><span class="l">Week used · plan-weighted</span><div class="vrow"><span class="v" id="ku6"></span><div class="ks" style="height:10px;align-self:center">' + bars('week') + '</div></div><span class="s">' + gw.n + ' of ' + n + ' seats report it</span></div>';
  const key = html + '|' + value + '|' + tokens + '|' + g5.pct + '|' + gw.pct;
  const box = $('#kUse');
  if (box.__key === key) return;
  box.__key = key; box.innerHTML = html;
  countUp($('#ku1'), value, (v) => usd(v, 0));
  countUp($('#ku4'), tokens, tok);
  if (g5.pct == null) $('#ku5').textContent = '—'; else countUp($('#ku5'), g5.pct, (v) => Math.round(v) + '%');
  if (gw.pct == null) $('#ku6').textContent = '—'; else countUp($('#ku6'), gw.pct, (v) => Math.round(v) + '%');
  renderTokSub();
}

/* ================= main time chart with cache events ================= */
let showEvents = false;
$('#evSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; e.stopPropagation(); showEvents = !showEvents; b.classList.toggle('on', showEvents); drawChart(false); });
let chartState = null;
function seriesFor() {
  const unit = getUnit(), split = getSplit();
  if (split === 'seat') {
    // seats only: tokens recorded before seat tracking stay in the totals, not as a series
    return TEAM.concat(PERSO).map((s) => ({ name: short(s.id), c: SEAT_COLORS[s.id], v: (r) => (r.seat[s.id] ? (unit === 'usd' ? valT(r.seat[s.id]) : tokT(r.seat[s.id])) : 0) }));
  }
  return TYPES.map((t) => ({ name: t.name, c: t.c, v: (r) => r.tot[unit === 'usd' ? t.usd : t.tok] || 0 }));
}
function drawChart(anim) {
  const wrap = $('#chartWrap'); if (!visible(wrap)) return;
  const unit = getUnit(), fmt = unit === 'usd' ? (v) => usd(v) : tok, series = seriesFor();
  const svg = $('#chart'), W = wrap.clientWidth, H = wrap.clientHeight;
  const rows = hourRows(), n = rows.length, hourly = !!P.hours;
  $('#mainTitle').textContent = hourly ? 'Throughput · hourly' : 'Throughput · daily';
  $('#mainFig').innerHTML = '<b>' + fmt(unit === 'usd' ? valT(P.tot) : tokT(P.tot)) + '</b>';
  if (!n) { setHtml(svg, ''); chartState = null; setHtml($('#chartLegend'), '<span class="dim">No usage recorded in this period.</span>'); return; }
  const padL = 44, padR = 46, padT = 22, padB = 20;
  const totals = rows.map((r) => series.reduce((a, s) => a + s.v(r), 0));
  const max = Math.max(1e-9, Math.max.apply(null, totals)), step = niceStep(max / 4), top = Math.ceil(max / step) * step;
  const cum = []; rows.reduce((a, r, i) => (cum[i] = a + (r.tot.length ? valT(r.tot) : 0)), 0);
  const cmax = Math.max(1e-9, cum[n - 1]), cstep = niceStep(cmax / 4), ctop = Math.ceil(cmax / cstep) * cstep;
  const x = (i) => padL + (n === 1 ? 0.5 : i / (n - 1)) * (W - padL - padR);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const yc = (v) => padT + (H - padT - padB) * (1 - v / ctop);
  let o = '<defs>' + series.map((s, i) => '<linearGradient id="ag' + i + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + s.c + '" stop-opacity=".75"/><stop offset="1" stop-color="' + s.c + '" stop-opacity=".18"/></linearGradient>').join('') + '</defs>';
  o += '<g class="grid">'; for (let v = 0; v <= top + 1e-9; v += step) o += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '"' + (v ? ' stroke-dasharray="2 4"' : '') + '/>'; o += '</g>';
  o += '<g class="axis">';
  for (let v = 0; v <= top + 1e-9; v += step) o += '<text x="' + (padL - 8) + '" y="' + (y(v) + 3.5) + '" text-anchor="end">' + (v ? fmt(v) : '0') + '</text>';
  for (let v = cstep; v <= ctop + 1e-9; v += cstep) o += '<text class="r" x="' + (W - padR + 8) + '" y="' + (yc(v) + 3.5) + '">' + usd(v, 0) + '</text>';
  const every = Math.ceil(n / Math.max(3, Math.floor((W - padL - padR) / 52)));
  rows.forEach((r, i) => { if (i % every) return; o += '<text x="' + x(i) + '" y="' + (H - 4) + '" text-anchor="middle">' + (hourly ? hh(r.t) + 'h' : dayShort(r.d)) + '</text>'; });
  o += '</g><g class="' + (anim && !RM ? 'reveal' : '') + '">';
  // stacked bands, bottom → top
  const base = rows.map(() => 0);
  series.forEach((s, si) => {
    const lo = base.slice(), hi = rows.map((r, i) => (base[i] += s.v(r)));
    if (hi.every((v, i) => v === lo[i])) return;
    const upper = hi.map((v, i) => [x(i), y(v)]), lower = lo.map((v, i) => [x(i), y(v)]).reverse();
    o += '<path d="' + mono(upper) + mono(lower, false) + 'Z" fill="url(#ag' + si + ')"/>';
    o += '<path d="' + mono(upper) + '" fill="none" stroke="' + s.c + '" stroke-width="1.5"/>';
  });
  // cumulative API cost, right axis
  o += '<path d="' + mono(cum.map((v, i) => [x(i), yc(v)])) + '" fill="none" stroke="var(--s4)" stroke-width="1.6" stroke-dasharray="5 4" opacity=".9"/>';
  o += '<circle cx="' + x(n - 1) + '" cy="' + yc(cum[n - 1]) + '" r="3" fill="var(--s4)"/>';
  o += '</g>';
  const pk = totals.indexOf(Math.max.apply(null, totals));
  if (totals[pk] > 0 && n > 1) {
    const px = x(pk), py = y(totals[pk]), anc = pk > n * 0.8 ? 'end' : pk < n * 0.15 ? 'start' : 'middle';
    o += '<circle cx="' + px + '" cy="' + py + '" r="3.5" fill="var(--text)" stroke="var(--elev)" stroke-width="2"/><text class="peak-l" x="' + px + '" y="' + (py - 9) + '" text-anchor="' + anc + '">' + fmt(totals[pk]) + ' <tspan class="peak-s">peak' + (hourly ? ' · ' + hh(rows[pk].t) + 'h' : '') + '</tspan></text>';
  }
  // events sit on the total curve at their minute
  const events = [];
  if (hourly && showEvents) {
    const tx = (t) => { const f = (t - rows[0].t - 1800e3) / HOUR; return { f, px: padL + f / Math.max(1, n - 1) * (W - padL - padR) }; };
    const yAt = (f) => { const i = Math.max(0, Math.min(n - 1, Math.floor(f))), j = Math.min(n - 1, i + 1), kk = Math.max(0, Math.min(1, f - i)); return y(totals[i] * (1 - kk) + totals[j] * kk); };
    D.cold.filter((e) => e.at >= rows[0].t).forEach((e) => { const p = tx(e.at); events.push({ kind: 'cold', at: e.at, x: Math.min(W - padR, Math.max(padL, p.px)), y: yAt(p.f), e }); });
    D.compactions.filter((e) => e.at >= rows[0].t).forEach((e) => { const p = tx(e.at); events.push({ kind: 'comp', at: e.at, x: Math.min(W - padR, Math.max(padL, p.px)), y: yAt(p.f), e }); });
    events.forEach((ev, i) => {
      const yy = ev.y - 9, sz = ev.kind === 'cold' ? 3 + Math.min(3, Math.sqrt(ev.e.tok / 30000)) : 3.8;
      o += ev.kind === 'cold'
        ? '<path class="mark" data-e="' + i + '" d="M' + ev.x + ' ' + (yy + sz) + 'L' + (ev.x + sz) + ' ' + (yy - sz * .8) + 'L' + (ev.x - sz) + ' ' + (yy - sz * .8) + 'Z" fill="var(--s2)" stroke="var(--elev)" stroke-width="1"/>'
        : '<path class="mark" data-e="' + i + '" d="M' + ev.x + ' ' + (yy - sz) + 'L' + (ev.x + sz) + ' ' + yy + 'L' + ev.x + ' ' + (yy + sz) + 'L' + (ev.x - sz) + ' ' + yy + 'Z" fill="var(--s7)" stroke="var(--elev)" stroke-width="1"/>';
    });
  }
  o += '<g class="xh" id="xh" visibility="hidden"><line y1="' + padT + '" y2="' + (H - padB) + '"/></g>';
  o += '<rect id="chit" x="' + padL + '" y="' + padT + '" width="' + Math.max(0, W - padL - padR) + '" height="' + Math.max(0, H - padT - padB) + '" fill="transparent"/>';
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); setHtml(svg, o);
  const nCold = events.filter((e) => e.kind === 'cold').length;
  setHtml($('#chartLegend'), series.map((s) => '<span><i class="sw" style="background:' + s.c + '"></i>' + esc(s.name) + '</span>').join('') +
    '<span><i class="ln"></i>API cost, cumulative (right)</span>' +
    (getSplit() === 'seat' && P.seat.unknown ? '<span class="dim" title="Recorded before seat tracking: counted in every total, not drawn">+ ' + (unit === 'usd' ? usd(valT(P.seat.unknown)) : tok(tokT(P.seat.unknown))) + ' unattributed</span>' : '') +
    (events.length ? '<span><span style="color:var(--s2);font-size:10px">▼</span>' + nCold + ' cold cache</span><span><span style="color:var(--s7);font-size:10px">◆</span>' + (events.length - nCold) + ' compactions</span>' : ''));
  chartState = { rows, series, totals, cum, fmt, x, y, events, unit, n };
}
$('#chart').addEventListener('mousemove', (e) => {
  const st = chartState; if (!st) return;
  const svg = e.currentTarget, box = svg.getBoundingClientRect(), mx = e.clientX - box.left, my = e.clientY - box.top;
  svg.querySelectorAll('.mark.hot').forEach((m) => m.classList.remove('hot'));
  const near = st.events.filter((ev) => Math.abs(ev.x - mx) < 7 && Math.abs(ev.y - 9 - my) < 12).sort((a, b) => b.at - a.at);
  const xh = $('#xh');
  if (near.length) {
    xh.setAttribute('visibility', 'hidden');
    near.forEach((ev) => { const m = svg.querySelector('.mark[data-e="' + st.events.indexOf(ev) + '"]'); if (m) m.classList.add('hot'); });
    return showTip('<div class="th">' + near.length + ' event' + (near.length > 1 ? 's' : '') + '<span>' + hhmm(near[near.length - 1].at) + '–' + hhmm(near[0].at) + '</span></div>' + near.slice(0, 5).map((ev) => ev.kind === 'cold'
      ? '<div class="ev"><span class="tm">' + hhmm(ev.at) + '</span><span class="tt"><span style="color:var(--s2)">▼</span> ' + esc(ev.e.title || ev.e.agent) + '</span><span>' + tok(ev.e.tok) + '</span><span class="why">' + esc(reasonOf(ev.e.reason)) + ' · ' + esc(short(ev.e.seat)) + ' · +' + usd(ev.e.wasted) + '</span></div>'
      : '<div class="ev"><span class="tm">' + hhmm(ev.at) + '</span><span class="tt"><span style="color:var(--s7)">◆</span> ' + esc(ev.e.title || ev.e.agent) + '</span><span>' + tok(ev.e.before) + ' → ' + tok(ev.e.after) + '</span><span class="why">compaction (' + esc(ev.e.trigger || '') + ') · ' + esc(ev.e.agent) + '</span></div>').join('') + (near.length > 5 ? '<div class="dim">+' + (near.length - 5) + ' more</div>' : ''), e.clientX, e.clientY);
  }
  let i = 0, best = 1e9; for (let j = 0; j < st.n; j++) { const d = Math.abs(st.x(j) - mx); if (d < best) { best = d; i = j; } }
  const r = st.rows[i], px = st.x(i), line = xh.querySelector('line');
  xh.setAttribute('visibility', 'visible'); line.setAttribute('x1', px); line.setAttribute('x2', px);
  xh.querySelectorAll('circle').forEach((c) => c.remove());
  let acc = 0;
  st.series.forEach((s) => { const v = s.v(r); if (!v || !document.createElementNS) return; acc += v; const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('cx', px); c.setAttribute('cy', st.y(acc)); c.setAttribute('r', 3); c.setAttribute('fill', s.c); c.setAttribute('stroke', 'var(--elev)'); c.setAttribute('stroke-width', 1.5); xh.appendChild(c); });
  const items = st.series.map((s) => ({ s, v: s.v(r) })).filter((q) => q.v > 0).sort((a, b) => b.v - a.v), tot = st.totals[i] || 0;
  const val = r.tot.length ? valT(r.tot) : 0, saved = r.tot.length ? r.tot[9] - val : 0;
  const ev = r.t ? st.events.filter((q) => q.at >= r.t && q.at < r.t + HOUR) : [], nc = ev.filter((q) => q.kind === 'cold').length;
  showTip('<div class="th">' + (r.d ? dayName(r.d) : hh(r.t) + ':00–' + hh(r.t + HOUR) + ':00') + '<span>' + st.fmt(tot) + '</span></div>' +
    (items.length ? items.slice(0, 9).map((q) => '<div class="trr"><i class="sw" style="background:' + q.s.c + '"></i><span>' + esc(q.s.name) + '</span><span>' + st.fmt(q.v) + '</span><span class="p">' + pctOf(q.v, tot) + '%</span></div>').join('') : '<div class="dim">No traffic</div>') +
    (val ? '<div class="tf"><span>' + (st.unit === 'usd' ? tok(tokT(r.tot)) + ' tokens' : usd(val) + ' value') + ' · ' + (r.tot[8] || 0) + ' req</span><b>' + usd(saved) + ' saved</b></div>' : '') +
    '<div class="tf"><span>cumulative</span><span style="color:var(--s4);font-weight:600">' + usd(st.cum[i], 0) + '</span></div>' +
    (ev.length ? '<div class="tf"><span>' + nc + ' cold · ' + (ev.length - nc) + ' compaction' + (ev.length - nc === 1 ? '' : 's') + '</span></div>' : ''), e.clientX, e.clientY);
});
$('#chart').addEventListener('mouseleave', () => { hideTip(); const xh = $('#xh'); if (xh) xh.setAttribute('visibility', 'hidden'); });

/* ================= pool 5h capacity, from the sampled seat quotas ================= */
let quotaState = null;
/** A seat's 5h % at time t: its last reading before t, 0 once its window reset since. */
function seatAt(list, s, t) {
  let v = null, at = 0;
  for (let i = 0; i < list.length; i++) { if (list[i][0] <= t) { v = list[i][1]; at = list[i][0]; } else break; }
  if (v == null) return null;
  const start = s.five ? s.five.resetsAt - FIVE_H : null;
  if (start && at < start && t >= start) return 0;
  if (t - at > FIVE_H) return 0;
  return Math.max(0, Math.min(100, v));
}
function drawQuota(anim) {
  const wrap = $('#quotaWrap'); if (!visible(wrap)) return;
  const svg = $('#quotaSvg'), W = wrap.clientWidth, H = wrap.clientHeight;
  const padL = 34, padR = 10, padT = 8, padB = 18;
  const last = now(), first = last - 12 * HOUR;
  const xs = (t) => padL + (t - first) / (last - first) * (W - padL - padR), ys = (v) => padT + (H - padT - padB) * (1 - v / 100);
  const steps = 96, times = [];
  for (let i = 0; i <= steps; i++) times.push(first + i * (last - first) / steps);
  const lines = SEATS.map((s) => { const list = (D.pool && D.pool[s.id]) || []; return { s, pts: times.map((t) => [t, seatAt(list, s, t)]) }; });
  // the last point is the live reading of every seat
  lines.forEach((l) => { l.pts[steps][1] = l.s.five ? l.s.five.pct : l.pts[steps][1]; });
  const pool = times.map((t, j) => {
    let a = 0, w = 0;
    lines.forEach((l) => { const v = l.pts[j][1]; if (v == null) return; a += v * (l.s.weight || 1); w += l.s.weight || 1; });
    return w ? a / w : null;
  });
  const TH = D.settings && D.settings.threshold ? D.settings.threshold : 80;
  let o = '<defs><linearGradient id="qg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--s1)" stop-opacity=".55"/><stop offset="1" stop-color="var(--s1)" stop-opacity=".06"/></linearGradient></defs><g class="grid">';
  [0, 50, 100].forEach((v) => { o += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ys(v) + '" y2="' + ys(v) + '"' + (v ? ' stroke-dasharray="2 4"' : '') + '/>'; });
  o += '</g><line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + ys(TH) + '" y2="' + ys(TH) + '" stroke="var(--warn)" stroke-dasharray="5 4" stroke-opacity=".7"/>';
  o += '<g class="axis">';
  [0, 50, 100].forEach((v) => { o += '<text x="' + (padL - 6) + '" y="' + (ys(v) + 3.5) + '" text-anchor="end">' + v + '%</text>'; });
  o += '<text x="' + (W - padR) + '" y="' + (ys(TH) - 4) + '" text-anchor="end" style="fill:var(--warn)">' + TH + '%</text>';
  for (let t = Math.ceil(first / 7200e3) * 7200e3; t < last; t += 7200e3) o += '<text x="' + xs(t) + '" y="' + (H - 4) + '" text-anchor="middle">' + hh(t) + 'h</text>';
  o += '</g>';
  // every seat reset in range: a short tick on the floor, in the seat colour
  SEATS.forEach((st) => { if (!st.five) return; for (let r = st.five.resetsAt - FIVE_H; r > first; r -= FIVE_H) if (r <= last) o += '<line x1="' + xs(r) + '" x2="' + xs(r) + '" y1="' + (ys(0) - 7) + '" y2="' + ys(0) + '" stroke="' + SEAT_COLORS[st.id] + '" stroke-width="2" stroke-linecap="round"/>'; });
  const pts = [];
  pool.forEach((v, j) => { if (v != null) pts.push([xs(times[j]), ys(v)]); });
  if (pts.length > 1) {
    o += '<g class="' + (anim && !RM ? 'reveal' : '') + '"><path d="' + mono(pts) + 'L' + pts[pts.length - 1][0] + ' ' + ys(0) + 'L' + pts[0][0] + ' ' + ys(0) + 'Z" fill="url(#qg)"/>' +
      '<path d="' + mono(pts) + '" fill="none" stroke="var(--s1)" stroke-width="2"/>' +
      '<circle cx="' + pts[pts.length - 1][0] + '" cy="' + pts[pts.length - 1][1] + '" r="3.5" fill="var(--s1)" stroke="var(--elev)" stroke-width="2"/></g>';
  }
  o += '<line id="qx" y1="' + padT + '" y2="' + (H - padB) + '" stroke="var(--muted)" stroke-dasharray="2 3" visibility="hidden"/>';
  o += '<rect id="qhit" x="' + padL + '" y="' + padT + '" width="' + Math.max(0, W - padL - padR) + '" height="' + Math.max(0, H - padT - padB) + '" fill="transparent"/>';
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); setHtml(svg, o);
  const sampled = SEATS.filter((s) => D.pool && D.pool[s.id] && D.pool[s.id].length).length;
  const nowUsed = pool[pool.length - 1];
  setHtml($('#quotaFig'), (nowUsed == null ? '<b>—</b>' : '<b>' + Math.round(nowUsed) + '%</b> used now') + ' · plan-weighted (' + weightsLabel() + ') · ' + sampled + ' of ' + SEATS.length + ' seats sampled');
  setHtml($('#quotaLegend'), '<span><i class="sw" style="background:var(--s1)"></i>pool used</span><span><i class="ln" style="border-color:var(--warn)"></i>threshold</span><span><i style="display:inline-block;width:2px;height:8px;background:var(--muted)"></i>seat reset</span>');
  quotaState = { lines, pool, xs, times };
}
$('#quotaSvg').addEventListener('mousemove', (e) => {
  const st = quotaState; if (!st) return;
  const box = e.currentTarget.getBoundingClientRect(), mx = e.clientX - box.left;
  let i = 0, best = 1e9; st.times.forEach((t, j) => { const d = Math.abs(st.xs(t) - mx); if (d < best) { best = d; i = j; } });
  const x = st.xs(st.times[i]), q = $('#qx'); if (q) { q.setAttribute('x1', x); q.setAttribute('x2', x); q.setAttribute('visibility', 'visible'); }
  const rows = st.lines.map((l) => ({ l, v: l.pts[i][1] })).sort((a, b) => (b.v == null ? -1 : b.v) - (a.v == null ? -1 : a.v));
  showTip('<div class="th">' + hhmm(st.times[i]) + '<span>pool ' + (st.pool[i] == null ? '—' : Math.round(st.pool[i]) + '%') + ' used · weighted</span></div>' + rows.map((r) => '<div class="trr"><i class="sw" style="background:' + SEAT_COLORS[r.l.s.id] + '"></i><span>' + esc(short(r.l.s.id)) + ' <span class="dim">×' + (r.l.s.weight || 1) + '</span></span><span>' + (r.v == null ? '<span class="dim">no sample</span>' : Math.round(r.v) + '%') + '</span><span class="p">' + (r.v == null ? '' : Math.round(100 - r.v) + '% left') + '</span></div>').join(''), e.clientX, e.clientY);
});
$('#quotaSvg').addEventListener('mouseleave', () => { hideTip(); const q = $('#qx'); if (q) q.setAttribute('visibility', 'hidden'); });
`;
