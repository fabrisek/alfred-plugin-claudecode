/**
 * Client script, part 6: polling and boot. The page polls `seatsUsage` with
 * ONE self-rescheduling timeout, passing the version it already drew: an
 * unchanged pool answers `{ unchanged: true }` and nothing is redrawn. Polls
 * pause while the panel is hidden. Tabs, density, resize and the 1 s
 * countdown ticker live here.
 */

export const BOOT_JS = String.raw`
const USAGE_POLL_MS = 15000;
let usageTimer = 0, usagePolling = null, version = null;

function pollUsage(force) {
  clearTimeout(usageTimer); usageTimer = 0;
  if (usagePolling) return usagePolling;
  usagePolling = invoke('seatsUsage', { since: force ? null : version }).then((r) => {
    if (!r || r.ok === false) throw new Error((r && r.error) || 'seatsUsage failed');
    setConn('');
    if (r.unchanged) return;
    const first = !D;
    D = r; version = r.version;
    indexSeats();
    if (first) ANIM = true;
    renderAll();
    ANIM = false;
  }).catch((err) => setConn('usage unavailable: ' + String((err && err.message) || err))).then(() => {
    usagePolling = null;
    if (!document.hidden) usageTimer = setTimeout(() => pollUsage(false), USAGE_POLL_MS);
  });
  return usagePolling;
}

function renderAll() {
  if (!D) return;
  P = periodData(getPeriod() || 'today');
  renderSeatKpis(); renderSeatRows();
  renderUseKpis(); drawChart(ANIM); drawQuota(ANIM); renderDps(); renderSplit(); renderEvents();
  const threads = SEATS.reduce((a, s) => a + s.threads.length, 0), busyN = SEATS.reduce((a, s) => a + s.threads.filter((t) => t.busy).length, 0);
  const lt = threads + ' thread' + (threads === 1 ? '' : 's') + (busyN ? ' · ' + busyN + ' busy' : '');
  if ($('#liveThreads').textContent !== lt) $('#liveThreads').textContent = lt;
  $('#livePulse').classList.toggle('idle', !busyN);
  refreshDrawer();
  tickResets();
}

/* ---------- countdowns ---------- */
function tickResets() {
  const t = now();
  document.querySelectorAll('[data-reset]').forEach((el) => {
    const r = Number(el.dataset.reset); if (!r) return;
    const txt = el.dataset.long ? dur(r - t) : durShort(r - t);
    if (el.textContent !== txt) el.textContent = txt;
  });
  document.querySelectorAll('[data-since]').forEach((el) => {
    const a = Number(el.dataset.since), b = Number(el.dataset.until) || t;
    const txt = dur(b - a);
    if (el.textContent !== txt) el.textContent = txt;
  });
}

/* ---------- tabs, density ---------- */
let tab = 'seats';
function showTab(name) {
  tab = name === 'usage' ? 'usage' : 'seats';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
  document.body.classList.toggle('t-seats', tab === 'seats'); document.body.classList.toggle('t-usage', tab === 'usage');
  closeDrawer();
  ANIM = true; renderAll(); ANIM = false;
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
seg('#density', (v) => {
  document.body.classList.toggle('compact', v === 'compact'); document.body.classList.toggle('balanced', v !== 'compact');
  dpsNodes.forEach((el) => el.remove()); dpsNodes.clear();
  ANIM = true; renderAll(); ANIM = false;
});

/* ---------- resize: charts draw at their box size ---------- */
let rz = 0;
function onResize() {
  clearTimeout(rz);
  rz = setTimeout(() => { if (!D) return; drawChart(false); drawQuota(false); renderDps(); }, 120);
}
window.addEventListener('resize', onResize);
if (typeof ResizeObserver === 'function') {
  try { const ro = new ResizeObserver(onResize); ['#chartWrap', '#quotaWrap', '#app'].forEach((q) => ro.observe($(q))); } catch (e) { /* the window listener is enough */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(usageTimer); usageTimer = 0; clearTimeout(snapTimer); snapTimer = 0; }
  else { pollUsage(false); pollSnap(); }
});

/* ---------- boot ---------- */
const hash = String((window.location && window.location.hash) || '');
if (hash.indexOf('usage') >= 0) { tab = 'usage'; document.body.classList.remove('t-seats'); document.body.classList.add('t-usage'); document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'usage')); }
if (hash.indexOf('compact') >= 0) { document.body.classList.remove('balanced'); document.body.classList.add('compact'); document.querySelectorAll('#density button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'compact')); }
setInterval(tickResets, 1000);
pollUsage(true);
pollSnap();
`;
