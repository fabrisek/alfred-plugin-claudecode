/**
 * Client script, part 2: the Seats tab — the KPI band aggregated over every
 * account, one bubble per seat (5h ring, week arc, plan, status, threads,
 * API value today, burn / ETA, 24h sparkline), the halo on the next seat,
 * the personal seat apart as last resort, the hover card and the seat
 * drawer. Bubbles are keyed: a poll only replaces the ones whose markup
 * changed, so nothing flickers.
 */

export const SEATS_JS = String.raw`
const STRATEGY = { headroom: 'most quota left', drain: 'use it or lose it', fill: 'fill in order', spread: 'spread' };

function seatRing(s, st) {
  const R1 = 37, C1 = 2 * Math.PI * R1, f1 = st.fiveLeft == null ? 0 : C1 * st.fiveLeft / 100;
  const R2 = 47, C2 = 2 * Math.PI * R2, f2 = s.week ? C2 * st.weekLeft / 100 : 0;
  const from = (f) => (ANIM && !RM ? 0 : f).toFixed(2);
  return '<svg class="rg" viewBox="0 0 100 100">' +
    '<circle cx="50" cy="50" r="' + R2 + '" fill="none" stroke="var(--panel-3)" stroke-width="3"' + (s.week ? '' : ' stroke-dasharray="1.5 3.5"') + '/>' +
    (s.week ? '<circle class="arc" cx="50" cy="50" r="' + R2 + '" fill="none" stroke="' + lvl(st.weekLeft) + '" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + from(f2) + ' ' + C2.toFixed(2) + '" data-to="' + f2.toFixed(2) + '" data-c="' + C2.toFixed(2) + '" transform="rotate(-90 50 50)" style="transition:stroke-dasharray 1s var(--ease)"/>' : '') +
    '<circle cx="50" cy="50" r="' + R1 + '" fill="none" stroke="var(--panel-3)" stroke-width="8"/>' +
    (st.fiveLeft == null ? '' : '<circle class="arc" cx="50" cy="50" r="' + R1 + '" fill="none" stroke="' + lvl(st.fiveLeft) + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + from(f1) + ' ' + C1.toFixed(2) + '" data-to="' + f1.toFixed(2) + '" data-c="' + C1.toFixed(2) + '" transform="rotate(-90 50 50)" style="transition:stroke-dasharray 1s var(--ease)"/>') +
    '<text x="50" y="52" text-anchor="middle" font-size="21" font-weight="650" fill="var(--text)" style="font-variant-numeric:tabular-nums">' + (st.fiveLeft == null ? '—' : st.fiveLeft + '%') + '</text>' +
    '<text x="50" y="67" text-anchor="middle" font-size="10" fill="var(--dim)"' + (s.five ? ' data-reset="' + s.five.resetsAt + '"' : '') + '>' + (s.five ? '' : '5h n/a') + '</text></svg>';
}
function threadsLine(s) {
  if (!s.threads.length) return '<span class="dimv">no thread</span>';
  const ags = [];
  s.threads.forEach((t) => { if (ags.indexOf(t.agent) < 0) ags.push(t.agent); });
  return '<b>' + s.threads.length + '</b> thread' + (s.threads.length > 1 ? 's' : '') + ' · ' + esc(ags.slice(0, 2).join(', ')) + (ags.length > 2 ? ' +' + (ags.length - 2) : '');
}
function burnLine(st) {
  if (st.burn == null) return '<span class="bline burn dimv">burn: not enough samples</span>';
  return '<span class="bline burn"><b>' + st.burn.toFixed(1) + '</b>%/h · ' + (st.pastReset ? 'lasts past reset' : '<span class="' + (st.eta < HOUR ? 'err' : 'warn') + '">empty in ' + durShort(st.eta) + '</span>') + '</span>';
}
function seatBubble(s) {
  const st = seatState(s), isNext = D.next && s.id === D.next.id;
  const cls = 'bub' + (isNext ? ' next' : '') + (s.org === 'team' ? '' : ' perso') + (s.enabled ? '' : ' disabled') + (drawerOf === 'seat:' + s.id ? ' sel' : '');
  return '<div class="' + cls + '" data-seat="' + esc(s.id) + '">' +
    '<div class="bh2"><i class="sw" style="background:' + SEAT_COLORS[s.id] + '"></i><span class="nm">' + esc(short(s.id)) + '</span><span class="plan ' + esc(s.plan) + '" title="' + esc(s.planLabel) + '">' + esc(s.plan) + '</span>' +
      (s.advisor == null ? '' : '<span class="adv' + (s.advisor ? '' : ' off') + '" title="' + (s.advisor ? 'advisor active' : 'advisor not in plan') + '">ADV</span>') +
      (isNext ? '<span class="nx">NEXT</span>' : s.lastResort ? '<span class="nx" style="color:var(--dim)">LAST RESORT</span>' : '') +
      '<span class="c-st ' + stCls[st.cls] + '"><span class="d"></span>' + esc(st.status) + '</span></div>' +
    '<div class="bmid">' + seatRing(s, st) + '<div class="binfo">' +
      '<span class="bval">' + usd(s.todayUsd, 0) + '<small>today</small></span>' +
      '<span class="bline">' + threadsLine(s) + '</span>' +
      burnLine(st) +
      '<span class="bline">week <b>' + (s.week ? st.weekLeft + '%' : '—') + '</b>' + (s.week ? '' : ' <span class="dimv">not reported</span>') + '</span>' +
    '</div></div>' +
    '<div class="bsp">' + sparkArea(s.spark, SEAT_COLORS[s.id], 200, 26, 'seat' + SEATS.indexOf(s)) + '</div></div>';
}
const bubbleHtml = new Map();
function renderSeatRows() {
  const box = $('#seatRows');
  const order = TEAM.concat(PERSO);
  const want = new Set(order.map((s) => s.id));
  Array.prototype.slice.call(box.children).forEach((el) => { if (!want.has(el.dataset.seat)) { el.remove(); bubbleHtml.delete(el.dataset.seat); } });
  const fresh = [];
  order.forEach((s, i) => {
    const html = seatBubble(s);
    let el = Array.prototype.slice.call(box.children).find((x) => x.dataset.seat === s.id);
    if (!el || bubbleHtml.get(s.id) !== html) {
      const tmp = document.createElement('div'); tmp.innerHTML = html;
      const nu = tmp.firstElementChild;
      if (el) { box.insertBefore(nu, el); el.remove(); } else box.appendChild(nu);
      bubbleHtml.set(s.id, html); el = nu; fresh.push(nu);
    }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
  });
  if (ANIM && !RM && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(() => fresh.forEach((b) => b.querySelectorAll('.arc').forEach((a) => a.setAttribute('stroke-dasharray', a.dataset.to + ' ' + a.dataset.c)))));
  }
  tickResets();
}
/** Aggregate KPI band across every account. */
function renderSeatKpis() {
  const states = SEATS.map(seatState), n = SEATS.length;
  const capLeft = states.reduce((a, s) => a + (s.fiveLeft || 0), 0) / 100;
  const weekSeats = SEATS.filter((s) => s.week), weekLeft = weekSeats.length ? weekSeats.reduce((a, s) => a + (100 - s.week.pct), 0) / weekSeats.length : null;
  const threads = SEATS.reduce((a, s) => a + s.threads.length, 0);
  const agentsOn = new Set(); SEATS.forEach((s) => s.threads.forEach((t) => agentsOn.add(t.agent)));
  const nx = D.next && seatOf(D.next.id), ns = nx && seatState(nx);
  const today = periodData('today'), value = valT(today.tot), mult = subMultiple(value, today.span);
  const nextReset = SEATS.filter((s) => s.five && s.five.resetsAt > now()).sort((a, b) => a.five.resetsAt - b.five.resetsAt)[0];
  const avail = states.filter((s) => s.status === 'ready' || s.status === 'in use').length;
  const capBar = '<svg viewBox="0 0 ' + (n * 10) + ' 8" preserveAspectRatio="none" style="height:8px">' + states.map((s, i) => '<rect x="' + (i * 10) + '" y="0" width="8.5" height="8" rx="1.5" fill="var(--panel-3)"/>' + (s.fiveLeft == null ? '' : '<rect x="' + (i * 10) + '" y="' + (8 - s.fiveLeft / 100 * 8) + '" width="8.5" height="' + (s.fiveLeft / 100 * 8) + '" rx="1.5" fill="' + lvl(s.fiveLeft) + '"/>')).join('') + '</svg>';
  const strat = D.settings ? STRATEGY[D.settings.strategy] || D.settings.strategy : '';
  const html =
    '<div class="kp" data-open="seats"><span class="l">5h capacity left</span><div class="vrow"><span class="v" id="ks1"></span><div class="ks" style="height:10px">' + capBar + '</div></div><span class="s">seats-worth of ' + n + ' · <b>' + avail + '</b> available</span></div>' +
    '<div class="kp" data-open="seats"><span class="l">Week left</span><span class="v">' + (weekLeft == null ? '—' : Math.round(weekLeft) + '%') + '</span><span class="s">' + weekSeats.length + ' of ' + n + ' seats report it</span></div>' +
    '<div class="kp" data-open="threads"><span class="l">Threads</span><span class="v" id="ks2"></span><span class="s">' + agentsOn.size + ' agents · ' + SEATS.filter((s) => s.threads.length).length + ' seats</span></div>' +
    '<div class="kp" data-open="cost+sub"><span class="l">API value today</span><span class="v" id="ks5"></span><span class="s"><b>×' + fmtMult(mult) + '</b> the subscription</span></div>' +
    '<div class="kp" data-open="tokens+records"><span class="l">Tokens today</span><span class="v" id="ks6"></span><span class="s">' + (today.tot[8] || 0).toLocaleString('en-US') + ' requests</span></div>' +
    (nx ? '<div class="kp" data-seat="' + esc(nx.id) + '"><span class="l">Next seat</span><span class="v">' + esc(short(nx.id)) + '</span><span class="s"><b>' + Math.round(ns.left) + '%</b> left · ' + esc(strat) + '</span></div>'
      : '<div class="kp" data-open="seats"><span class="l">Next seat</span><span class="v err">none</span><span class="s">no seat ready</span></div>') +
    (nextReset ? '<div class="kp" data-seat="' + esc(nextReset.id) + '"><span class="l">Next reset</span><span class="v" data-reset="' + nextReset.five.resetsAt + '" data-long="1"></span><span class="s">' + esc(short(nextReset.id)) + ' · ' + seatState(nextReset).fiveLeft + '% left</span></div>'
      : '<div class="kp"><span class="l">Next reset</span><span class="v">—</span><span class="s">no 5h window known</span></div>');
  const key = html + '|' + capLeft + '|' + threads + '|' + value + '|' + tokT(today.tot);
  const box = $('#kSeat');
  if (box.__key === key) return;
  box.__key = key; box.innerHTML = html;
  countUp($('#ks1'), capLeft, (v) => v.toFixed(1));
  countUp($('#ks2'), threads, (v) => String(Math.round(v)));
  countUp($('#ks5'), value, (v) => usd(v, 0));
  countUp($('#ks6'), tokT(today.tot), tok);
  tickResets();
}
function seatCard(s) {
  const st = seatState(s);
  return '<div class="th">' + esc(s.label) + '<span>' + esc(s.plan) + ' · ' + esc(st.status) + '</span></div>' +
    '<div class="kv"><span>5h</span><b>' + (s.five ? st.fiveLeft + '% left · resets ' + dur(s.five.resetsAt - now()) : 'not reported') + '</b><span>Week</span><b>' + (s.week ? st.weekLeft + '% left' : 'not reported') + '</b>' +
    s.scoped.map((w) => '<span>' + esc(w.label) + ' week</span><b>' + Math.round(100 - w.pct) + '% left</b>').join('') +
    '<span>Today</span><b>' + tok(s.todayTok) + ' · ' + usd(s.todayUsd, 0) + '</b><span>Hit 100% today</span><b>' + (s.hitsToday ? '×' + s.hitsToday : 'no') + '</b></div>' +
    (s.threads.length ? '<div class="tf" style="display:block">' + s.threads.slice(0, 8).map((t) => '<div class="ev"><span class="tm">' + tok(t.ctx) + '</span><span class="tt"><span class="ag">' + esc(t.agent) + '</span> ' + esc(t.title) + '</span><span></span></div>').join('') + (s.threads.length > 8 ? '<div class="dim">+' + (s.threads.length - 8) + ' more</div>' : '') + '</div>' : '');
}
$('#seatRows').addEventListener('mousemove', (e) => {
  const r = e.target.closest('.bub'); if (!r) return hideTip();
  const s = seatOf(r.dataset.seat); if (!s) return hideTip();
  showTip(seatCard(s), e.clientX, e.clientY);
});
$('#seatRows').addEventListener('mouseleave', hideTip);

/** Seat drawer: quota, burn, last 24h, threads, today's cold cache, and the seat's actions. */
function seatDrawer(id) {
  const s = seatOf(id); if (!s) return null;
  const st = seatState(s);
  const cold = D.cold.filter((e) => e.seat === id && e.at >= D.day0);
  const body =
    sub('Quota', '<div class="kv"><span>5h left</span><b>' + (s.five ? st.fiveLeft + '% · resets ' + dur(s.five.resetsAt - now()) : 'not reported') + '</b>' +
      '<span>Week left</span><b>' + (s.week ? st.weekLeft + '% · resets ' + dur(s.week.resetsAt - now()) : 'not reported') + '</b>' +
      s.scoped.map((w) => '<span>' + esc(w.label) + ' week left</span><b>' + Math.round(100 - w.pct) + '%' + (w.resetsAt ? ' · resets ' + dur(w.resetsAt - now()) : '') + '</b>').join('') +
      '<span>Burn</span><b>' + (st.burn == null ? '—' : st.burn.toFixed(1) + ' %/h') + '</b>' +
      '<span>At this pace</span><b style="color:' + (st.pastReset ? 'var(--ok)' : 'var(--warn)') + '">' + (st.burn == null ? '—' : st.pastReset ? 'lasts past reset' : 'empty in ' + dur(st.eta)) + '</b>' +
      '<span>Hit 100% today</span><b>' + (s.hitsToday ? '×' + s.hitsToday : 'never') + '</b>' +
      '<span>Advisor</span><b>' + (s.advisor == null ? 'off / not seen' : s.advisor ? 'active' : 'not in plan') + '</b>' +
      '<span>Plan</span><b>' + esc(s.planLabel) + ' · weight ×' + s.weight + '</b>' +
      (s.statusDetail ? '<span>Status</span><b>' + esc(s.statusDetail) + '</b>' : '') +
      (s.lastError ? '<span>Last error</span><b class="err" title="' + esc(s.lastError) + '">' + esc(String(s.lastError).slice(0, 60)) + '</b>' : '') +
      (s.usageStale ? '<span>Usage</span><b class="warn">stale</b>' : '') + '</div>') +
    sub('Last 24h · API value per hour', spark(s.spark, SEAT_COLORS[s.id]) + '<div class="kv"><span>Today</span><b>' + tok(s.todayTok) + ' · ' + usd(s.todayUsd, 0) + '</b><span>Requests, since start</span><b>' + (s.requests || 0).toLocaleString('en-US') + '</b></div>') +
    sub('Threads · ' + s.threads.length, s.threads.length ? '<div class="list">' + s.threads.map((t) => '<div class="li"><span class="bd' + (t.busy ? '' : ' idle') + '"></span><span class="t" title="' + esc(t.title) + '"><span class="ag">' + esc(t.agent) + '</span> ' + esc(t.title) + '</span><span class="r">' + tok(t.ctx) + '</span></div>').join('') + '</div>'
      : '<span class="dim">Idle' + (s.lastUsedAt ? ' · last turn ' + dur(now() - s.lastUsedAt) + ' ago' : '') + '</span>') +
    (cold.length ? sub('Cold cache today · ' + cold.length, '<div class="list">' + cold.slice(0, 30).map((e) => convLi(e, hhmm(e.at) + ' · <b>' + tok(e.tok) + '</b>')).join('') + '</div>') : '') +
    sub('Actions', seatActionsHtml(s));
  return [s.label, s.planLabel + (s.lastResort ? ' · personal, last resort' : ' · team') + (s.email ? ' · ' + s.email : ''), body];
}
function openSeat(id) {
  const d = seatDrawer(id); if (!d) return;
  drawerOf = 'seat:' + id;
  document.querySelectorAll('.bub').forEach((x) => x.classList.toggle('sel', x.dataset.seat === id));
  openDrawer(d[0], d[1], d[2]);
}
`;
