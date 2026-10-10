/**
 * Client script, part 4: the Usage tab's side and bottom — the DPS-style
 * leaderboard (seats / agents / threads), "Where the $ goes", the discreet
 * cache-health line — and every detail drawer opened from a KPI or a link
 * (cost, cache, tokens, subscription, models, agents, records, seats,
 * threads). One delegated click listener opens them.
 */

export const BOARD_JS = String.raw`
/* ================= DPS-style leaderboard ================= */
let dpsBy = 'seat';
const dpsNodes = new Map();
function dpsData() {
  if (dpsBy === 'seat') return Object.keys(P.seat).filter((k) => k !== 'unknown').map((k) => { const s = seatOf(k); return { id: 's:' + k, name: short(k), tag: s ? s.plan : '', v: valT(P.seat[k]), c: SEAT_COLORS[k] || 'var(--s-neutral)' }; });
  if (dpsBy === 'agent') return (D.agents || []).map((a) => ({ id: 'a:' + a.name, name: a.name, tag: a.p[P.p][2] + ' thr', v: a.p[P.p][0], c: AGENT_COLORS[a.name] || 'var(--s1)' }));
  return (D.convs || []).map((c) => ({ id: 'c:' + c.key, name: c.title, tag: c.agent, v: c.p[P.p][2], c: AGENT_COLORS[c.agent] || 'var(--s1)' }));
}
function renderDps() {
  const box = $('#dps'); if (!visible(box)) return;
  const rowH = 26, cap = Math.max(3, Math.floor((box.clientHeight + 4) / rowH));
  const all = dpsData().filter((d) => d.v > 0).sort((a, b) => b.v - a.v);
  const list = all.slice(0, cap);
  const max = list.length ? list[0].v : 1, tot = all.reduce((a, d) => a + d.v, 0);
  const keep = new Set(list.map((d) => d.id));
  dpsNodes.forEach((el, id) => { if (!keep.has(id)) { el.remove(); dpsNodes.delete(id); } });
  const none = box.querySelector('.none');
  if (!list.length) { if (!none) { const n = document.createElement('div'); n.className = 'none'; n.textContent = dpsBy === 'seat' ? 'No spend in this period.' : 'No thread recorded in this period yet (tracked since the update).'; box.appendChild(n); } return; }
  if (none) none.remove();
  list.forEach((d, i) => {
    let el = dpsNodes.get(d.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'dr'; el.style.transform = 'translateY(' + (cap * rowH) + 'px)';
      el.innerHTML = '<div class="bar"><i style="width:0"></i><span></span></div><span class="v"></span><span class="p"></span>';
      box.appendChild(el); dpsNodes.set(d.id, el);
    }
    el.querySelector('.bar i').style.background = d.c;
    setHtml(el.querySelector('.bar span'), esc(d.name) + ' <small>' + esc(d.tag) + '</small>');
    el.querySelector('.v').textContent = usd(d.v, d.v >= 100 ? 0 : 1);
    el.querySelector('.p').textContent = pctOf(d.v, tot) + '%';
    el.title = d.name;
    const place = () => { el.style.transform = 'translateY(' + (i * rowH) + 'px)'; el.querySelector('.bar i').style.width = (d.v / max * 100) + '%'; };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(place)); else place();
  });
}
seg('#dpsBy', (v) => { dpsBy = v; dpsNodes.forEach((el) => el.remove()); dpsNodes.clear(); renderDps(); });

/* ================= where the $ goes ================= */
let splitEnt = [];
function renderSplit() {
  const ent = Object.keys(P.model).map((k) => ({ k, v: valT(P.model[k]), t: tokT(P.model[k]) })).filter((e) => e.t > 0).sort((a, b) => b.v - a.v);
  splitEnt = ent;
  const tot = ent.reduce((a, e) => a + e.v, 0);
  const R = 38, C = 2 * Math.PI * R; let off = 0;
  let donut = '<svg width="92" height="92" viewBox="0 0 92 92"><g transform="rotate(-90 46 46)"><circle cx="46" cy="46" r="' + R + '" fill="none" stroke="var(--panel)" stroke-width="11"/>';
  ent.forEach((e) => { const len = tot > 0 ? e.v / tot * C : 0; donut += '<circle class="dn" data-m="' + esc(e.k) + '" cx="46" cy="46" r="' + R + '" fill="none" stroke="' + modelMeta(e.k)[1] + '" stroke-width="11" stroke-dasharray="' + Math.max(0, len - 1.5).toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '"/>'; off += len; });
  donut += '</g><text x="46" y="44" text-anchor="middle" font-size="13" font-weight="650" fill="var(--text)">' + usd(tot, 0) + '</text><text x="46" y="58" text-anchor="middle" font-size="9.5" fill="var(--dim)">' + ent.length + ' model' + (ent.length === 1 ? '' : 's') + '</text></svg>';
  const T = P.tot, val = valT(T), ord = [TYPES[1], TYPES[4], TYPES[0], TYPES[3], TYPES[2]].map((t) => ({ t, v: T[t.usd] || 0 })).sort((a, b) => b.v - a.v);
  const bmax = ord[0].v || 1;
  setHtml($('#split2'), '<div class="donut" data-open="models">' + donut + '</div><div class="hb" data-open="cost">' + ord.map((o) => '<div class="hbr"><span class="nm">' + o.t.name + '</span><span class="t"><i style="width:' + (o.v / bmax * 100).toFixed(1) + '%;background:' + o.t.c + '"></i></span><span class="v">' + usd(o.v, o.v >= 100 ? 0 : 1) + '</span><span class="p">' + pctOf(o.v, val) + '%</span></div>').join('') + '</div>');
  setHtml($('#splitFig'), ent.slice(0, 2).map((e) => '<i class="sw" style="background:' + modelMeta(e.k)[1] + '"></i> ' + esc(modelMeta(e.k)[0]) + ' <b>' + pctOf(e.v, tot) + '%</b>').join(' &nbsp;'));
}
$('#split2').addEventListener('mousemove', (ev) => {
  const c = ev.target.closest('.dn'); if (!c) return hideTip();
  const e = splitEnt.find((x) => x.k === c.dataset.m); if (!e) return hideTip();
  const tot = splitEnt.reduce((a, x) => a + x.v, 0);
  showTip('<div class="th">' + esc(modelMeta(e.k)[0]) + '<span>' + pctOf(e.v, tot) + '%</span></div><div class="kv"><span>API value</span><b>' + usd(e.v, 0) + '</b><span>Tokens</span><b>' + tok(e.t) + '</b></div>', ev.clientX, ev.clientY);
});
$('#split2').addEventListener('mouseleave', hideTip);

/* ================= cache health (a bug-detection signal, not a hero stat) ================= */
function coldToday() { return D.cold.filter((e) => e.at >= D.day0); }
function compToday() { return D.compactions.filter((e) => e.at >= D.day0); }
function renderEvents() {
  const T = periodData('today').tot, read = T[0] + T[1] + T[2], hit = read > 0 ? T[2] / read : null;
  const c = coldToday(), wasted = c.reduce((a, e) => a + (e.wasted || 0), 0), rew = c.reduce((a, e) => a + e.tok, 0);
  const lastHour = c.filter((e) => e.at > now() - HOUR).length;
  const comp = compToday(), freed = comp.reduce((a, e) => a + Math.max(0, e.before - (e.after || 0)), 0);
  const issues = [];
  if (hit != null && hit < 0.9) issues.push('hit rate under 90%');
  if (lastHour > 8) issues.push(lastHour + ' cold starts in the last hour');
  const ok = !issues.length;
  const last = c.reduce((a, e) => (!a || e.at > a.at ? e : a), null);
  setHtml($('#events'), '<span class="eh" style="display:inline-flex;align-items:center;gap:6px;color:' + (ok ? 'var(--ok)' : 'var(--warn)') + '"><span class="d" style="width:7px;height:7px;border-radius:50%;background:currentColor"></span>Cache ' + (ok ? 'OK' : 'anomaly') + '</span>' +
    (ok ? '' : '<span class="ei" style="color:var(--warn)">' + issues.join(' · ') + '</span>') +
    '<span class="ei">hit <b>' + (hit == null ? '—' : (hit * 100).toFixed(1) + '%') + '</b></span>' +
    '<span class="ei">cold today <b>' + D.coldTotal + '</b> · ' + tok(rew) + ' rewritten · +' + usd(wasted) + '</span>' +
    '<span class="ei">compactions <b>' + comp.length + '</b> · ' + tok(freed) + ' freed</span>' +
    (last ? '<span class="ei"><span class="tm">last cold ' + hhmm(last.at) + '</span><span class="tt" title="' + esc(last.title || '') + '">' + esc(last.title || last.agent || '') + '</span><span>' + esc(reasonOf(last.reason)) + '</span></span>' : '') +
    '<button class="all" data-open="cache">Details →</button>');
}

/* ================= detail drawers ================= */
const convsBy = (p) => (D.convs || []).filter((c) => c.p[p][2] > 0 || c.p[p][1] > 0).sort((a, b) => b.p[p][2] - a.p[p][2]);
const OPEN = {
  cost() {
    const T = P.tot, value = valT(T), nocache = T[9] || 0;
    const ord = [TYPES[2], TYPES[1], TYPES[0], TYPES[3], TYPES[4]];
    const bar = (parts, sc) => '<div class="stack">' + parts.map((p) => '<i style="width:' + (sc > 0 ? p[1] / sc * 100 : 0).toFixed(2) + '%;background:' + p[0] + '"></i>').join('') + '</div>';
    const convs = convsBy(P.p);
    return ['API cost', periodLabel(),
      sub('Actual vs without cache', bar(ord.map((t) => [t.c, T[t.usd] || 0]), nocache) + '<div style="height:4px"></div>' + bar([['repeating-linear-gradient(135deg,var(--panel-3) 0 5px,var(--panel-2) 5px 10px)', nocache]], nocache) +
        '<div class="kv"><span>Actual</span><b>' + usd(value, 0) + '</b><span>Without cache</span><b>' + usd(nocache, 0) + '</b></div>') +
      sub('By type', '<div class="kv">' + ord.map((t) => '<span><i class="sw" style="background:' + t.c + '"></i> ' + t.name + ' · ' + tok(T[t.tok] || 0) + '</span><b>' + usd(T[t.usd] || 0) + '</b>').join('') +
        '<span>Requests</span><b>' + (T[8] || 0).toLocaleString('en-US') + '</b><span>Per request</span><b>' + usd(value / Math.max(1, T[8] || 0), 3) + '</b></div>') +
      sub('By seat', '<div class="kv">' + Object.keys(P.seat).filter((k) => k !== 'unknown').sort((a, b) => valT(P.seat[b]) - valT(P.seat[a])).map((k) => '<span><i class="sw" style="background:' + (SEAT_COLORS[k] || 'var(--s-neutral)') + '"></i> ' + esc(short(k)) + ' · ' + tok(tokT(P.seat[k])) + '</span><b>' + usd(valT(P.seat[k]), 0) + '</b>').join('') +
        (P.seat.unknown ? '<span class="dim">before seat tracking · ' + tok(tokT(P.seat.unknown)) + '</span><b class="dim">' + usd(valT(P.seat.unknown), 0) + '</b>' : '') + '</div>') +
      sub('Top threads · ' + periodLabel(), convs.length ? '<div class="list">' + convs.slice(0, 15).map((c) => convLi(c, '<b>' + usd(c.p[P.p][2]) + '</b> · ' + tok(c.p[P.p][1]))).join('') + '</div>' : '<span class="dim">No thread recorded in this period yet.</span>')];
  },
  cache() {
    const T = P.tot, cold = coldToday(), comp = compToday();
    const wasted = cold.reduce((a, e) => a + (e.wasted || 0), 0), rew = cold.reduce((a, e) => a + e.tok, 0);
    const reasons = {}; cold.forEach((e) => { const r = reasonOf(e.reason); reasons[r] = (reasons[r] || 0) + 1; });
    const m = D.modesToday || {}, mAll = Object.keys(m).reduce((a, k) => a + m[k], 0);
    const desc = (l) => l.slice().sort((a, b) => b.at - a.at);
    return ['Cache', periodLabel() + ' · journal since ' + new Date(D.firstAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      sub('Saved', '<div class="kv"><span>Without cache</span><b>' + usd(T[9] || 0, 0) + '</b><span>Actual</span><b>' + usd(valT(T), 0) + '</b><span>Saved</span><b style="color:var(--ok)">' + usd((T[9] || 0) - valT(T), 0) + '</b>' +
        '<span>Read from cache</span><b>' + tok(T[2] || 0) + '</b><span>Written to cache</span><b>' + tok(T[1] || 0) + '</b></div>') +
      sub('Sessions today · ' + mAll.toLocaleString('en-US') + ' requests', mAll ? '<div class="kv">' + Object.keys(m).sort((a, b) => m[b] - m[a]).map((k) => '<span>' + esc(k) + '</span><b>' + m[k].toLocaleString('en-US') + ' · ' + pctOf(m[k], mAll) + '%</b>').join('') + '</div>' : '<span class="dim">None recorded yet.</span>') +
      sub('Cold cache today · ' + D.coldTotal + ' · ' + tok(rew) + ' rewritten · +' + usd(wasted), '<div class="kv">' + Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a]).map((k) => '<span>' + esc(k) + '</span><b>' + reasons[k] + '</b>').join('') + '</div>' +
        '<div class="list">' + desc(cold).slice(0, 80).map((e) => convLi(e, hhmm(e.at) + ' · ' + esc(short(e.seat)) + ' · <b>' + tok(e.tok) + '</b> · +' + usd(e.wasted || 0))).join('') + '</div>') +
      sub('Compactions today · ' + comp.length, comp.length ? '<div class="list">' + desc(comp).map((e) => convLi(e, hhmm(e.at) + ' · ' + tok(e.before) + ' → <b>' + tok(e.after) + '</b>' + (e.trigger ? ' · ' + esc(e.trigger) : ''))).join('') + '</div>' : '<span class="dim">None today.</span>')];
  },
  tokens() {
    const T = P.tot, all = tokT(T);
    return ['Tokens', periodLabel(),
      sub('By type', '<div class="kv">' + TYPES.map((t) => '<span><i class="sw" style="background:' + t.c + '"></i> ' + t.name + '</span><b>' + tok(T[t.tok] || 0) + ' · ' + pctOf(T[t.tok] || 0, all) + '%</b>').join('') + '</div>') +
      sub('By model', '<div class="kv">' + Object.keys(P.model).sort((a, b) => tokT(P.model[b]) - tokT(P.model[a])).map((k) => '<span><i class="sw" style="background:' + modelMeta(k)[1] + '"></i> ' + esc(modelMeta(k)[0]) + '</span><b>' + tok(tokT(P.model[k])) + '</b>').join('') + '</div>') +
      sub('Daily', '<div class="kv">' + D.daily.slice().reverse().slice(0, 21).map((d) => '<span>' + dayName(d.d) + '</span><b>' + tok(tokT(d.tot)) + ' · ' + usd(valT(d.tot), 0) + '</b>').join('') + '</div>')];
  },
  sub() {
    const p24 = periodData('24h'), perDay = valT(p24.tot), S = D.subscription || { monthlyUsd: 0, perDayUsd: 0, plans: [] };
    const m = subMultiple(valT(P.tot), P.span), m24 = subMultiple(perDay, 1);
    return ['Subscription vs API', 'list prices of the seats\' plans',
      sub('Plans', '<div class="kv">' + S.plans.map((p) => '<span>' + p.count + ' × ' + esc(p.label) + '</span><b>' + usd(p.monthlyUsd, 0) + '</b>').join('') + '<span>Total</span><b>' + usd(S.monthlyUsd, 0) + ' / mo</b><span>Per day</span><b>' + usd(S.perDayUsd, 2) + '</b></div>') +
      sub('Return', '<div class="kv"><span>' + periodLabel() + '</span><b>' + usd(valT(P.tot), 0) + ' · ×' + fmtMult(m) + '</b><span>Pace, last 24h</span><b>' + usd(perDay, 0) + ' / day · ×' + fmtMult(m24) + '</b>' +
        '<span>Monthly projection</span><b>' + usd(perDay * 30.4, 0) + '</b></div><span class="dim">×N = API value over the period ÷ the plans\' price over the same period.</span>')];
  },
  models() {
    const ent = Object.keys(P.model).filter((k) => tokT(P.model[k]) > 0).sort((a, b) => valT(P.model[b]) - valT(P.model[a]));
    return ['Models', periodLabel(), sub('API value', '<div class="kv">' + ent.map((k) => { const m = modelMeta(k);
      return '<span><i class="sw" style="background:' + m[1] + '"></i> ' + esc(m[0]) + ' · ' + tok(tokT(P.model[k])) + '</span><b>' + usd(valT(P.model[k]), 0) + '</b>'; }).join('') + '</div>')];
  },
  agents() {
    const ag = (D.agents || []).filter((a) => a.p[P.p][0] > 0).sort((a, b) => b.p[P.p][0] - a.p[P.p][0]);
    const convs = convsBy(P.p);
    return ['Agents', periodLabel() + ' · ' + usd(D.attributed[P.p] || 0, 0) + ' attributed of ' + usd(valT(P.tot), 0),
      sub('Ranking', ag.length ? '<div class="kv">' + ag.map((a, i) => '<span>' + (i + 1) + '. ' + esc(a.name) + ' · ' + a.p[P.p][2] + ' thread' + (a.p[P.p][2] === 1 ? '' : 's') + '</span><b>' + usd(a.p[P.p][0]) + ' · ' + tok(a.p[P.p][1]) + '</b>').join('') + '</div>' : '<span class="dim">Per-thread spend is recorded since ' + new Date(D.threadsSince || D.now).toLocaleString('en-US') + '.</span>') +
      sub('Top threads · ' + D.convCount, '<div class="list">' + convs.slice(0, 20).map((c) => convLi(c, '<b>' + usd(c.p[P.p][2]) + '</b> · ' + c.p[P.p][0] + ' req' + (c.cold ? ' · ' + c.cold + ' cold' : ''))).join('') + '</div>')];
  },
  records() {
    const hours = D.hourly.slice().sort((a, b) => tokT(b.tot) - tokT(a.tot)).slice(0, 5);
    const best = D.daily.slice().sort((a, b) => valT(b.tot) - valT(a.tot))[0];
    const all = D.daily.reduce((a, d) => addc(a, d.tot), []);
    const big = convsBy(P.p).sort((a, b) => b.p[P.p][1] - a.p[P.p][1]).slice(0, 8);
    return ['Records', '',
      sub('Top hours · last 72h', '<div class="kv">' + hours.map((h) => '<span>' + new Date(h.t).toLocaleDateString('en-US', { weekday: 'short' }) + ' ' + hh(h.t) + ':00</span><b>' + tok(tokT(h.tot)) + ' · ' + usd(valT(h.tot), 0) + '</b>').join('') + '</div>') +
      (best ? sub('Best day', '<div class="kv"><span>' + dayName(best.d) + '</span><b>' + usd(valT(best.tot), 0) + ' · ' + tok(tokT(best.tot)) + '</b><span>Billion-token days</span><b>' + D.daily.filter((d) => tokT(d.tot) > 1e9).length + '</b></div>') : '') +
      sub('Since tracking', '<div class="kv"><span>Tokens</span><b>' + tok(tokT(all)) + '</b><span>API value</span><b>' + usd(valT(all), 0) + '</b><span>Without cache</span><b>' + usd(all[9] || 0, 0) + '</b><span>Advisor</span><b>' + usd(all[11] || 0, 0) + '</b><span>Requests</span><b>' + (all[8] || 0).toLocaleString('en-US') + '</b></div>') +
      (big.length ? sub('Biggest threads · ' + periodLabel(), '<div class="list">' + big.map((c) => convLi(c, '<b>' + tok(c.p[P.p][1]) + '</b>')).join('') + '</div>') : '')];
  },
  seats() {
    return ['Seats', SEATS.length + ' seats · weights ' + weightsLabel(),
      sub('5h · week · burn', '<div class="kv">' + TEAM.concat(PERSO).map((s) => { const st = seatState(s);
        return '<span data-seat="' + esc(s.id) + '" style="cursor:pointer">' + esc(short(s.id)) + ' · ' + esc(s.plan) + ' · ' + esc(st.status) + '</span><b>' + (st.fiveLeft == null ? '—' : st.fiveLeft + '%') + ' · ' + (s.week ? st.weekLeft + '%' : '—') + ' · ' + (st.burn == null ? '—' : st.burn.toFixed(1) + '%/h') + '</b>'; }).join('') + '</div>')];
  },
  threads() {
    const live = SEATS.filter((s) => s.threads.length);
    return ['Threads', SEATS.reduce((a, s) => a + s.threads.length, 0) + ' warm (used in the last hour)',
      live.length ? live.map((s) => sub(esc(short(s.id)) + ' · ' + s.threads.length, '<div class="list">' + s.threads.map((t) => '<div class="li"><span class="bd' + (t.busy ? '' : ' idle') + '"></span><span class="t" title="' + esc(t.title) + '"><span class="ag">' + esc(t.agent) + '</span> ' + esc(t.title) + '</span><span class="r">' + tok(t.ctx) + '</span></div>').join('') + '</div>')).join('') : '<span class="dim">No thread used a seat in the last hour.</span>'];
  },
};
function openKeys(keys) {
  const parts = keys.split('+').filter((k) => OPEN[k]).map((k) => OPEN[k]());
  if (!parts.length) return null;
  return [parts[0][0], parts[0][1], parts.map((r, i) => (i ? '<div style="font-size:13px;font-weight:600;margin-top:4px">' + r[0] + '</div>' : '') + r[2]).join('')];
}
function showOpen(keys) {
  const d = openKeys(keys); if (!d) return;
  drawerOf = 'open:' + keys;
  document.querySelectorAll('.bub.sel').forEach((x) => x.classList.remove('sel'));
  openDrawer(d[0], d[1], d[2]);
}
/** Redraws the open drawer with fresh numbers, unless the user is typing in it. */
function refreshDrawer() {
  if (!drawerOf || $('#drawer').hidden) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest('#drawer') && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
  let d = null;
  if (drawerOf.indexOf('seat:') === 0) d = seatDrawer(drawerOf.slice(5));
  else if (drawerOf.indexOf('open:') === 0) d = openKeys(drawerOf.slice(5));
  if (!d) return;
  if ($('#dTitle').textContent !== d[0]) $('#dTitle').textContent = d[0];
  if ($('#dSub').textContent !== (d[1] || '')) $('#dSub').textContent = d[1] || '';
  setHtml($('#dBody'), d[2]);
}
// one delegated listener: every [data-open] (KPI, strip, link) and every [data-seat] (bubble, KPI) opens the drawer
document.addEventListener('click', (e) => {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest('.seg') || e.target.closest('[data-sact]')) return;
  const o = e.target.closest('[data-open]');
  if (o) return showOpen(o.dataset.open);
  const s = e.target.closest('[data-seat]');
  if (s && D) openSeat(s.dataset.seat);
});
$('#dClose').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
document.addEventListener('mousedown', (e) => { if (!$('#drawer').hidden && e.target && e.target.closest && !e.target.closest('#drawer, [data-open], [data-seat], #flash')) closeDrawer(); });
`;
