/**
 * Client script, part 5: everything that acts on the pool — the live turns
 * (Running drawer, with their Stop button), the Manage drawer (strategy,
 * switch threshold, refresh, add a seat) and each seat's actions in its
 * drawer (refresh, test, login, enable, order, expose models, clear, token,
 * remove). Reads `poolSnapshot`, a local and cheap action, on its own poll.
 *
 * No confirm() in the sandbox: destructive buttons are two-step, their armed
 * state kept here so it survives a redraw.
 */

export const MANAGE_JS = String.raw`
const LIVE_ST = { starting: 1, running: 1, tool: 1, compacting: 1, retrying: 1 };
const isLive = (s) => LIVE_ST[s] === 1;
const SNAP_LIVE_MS = 3000, SNAP_IDLE_MS = 10000, ARM_MS = 3000;
let snapTimer = 0, snapPolling = false;
const busy = {}, armed = {};
let flashTimer = 0;

function flash(kind, text) {
  const f = $('#flash');
  clearTimeout(flashTimer);
  if (!text) { f.hidden = true; return; }
  f.className = kind; f.hidden = false;
  f.innerHTML = '<span>' + esc(text) + '</span><button data-sact="flash-close" aria-label="Close">×</button>';
  if (kind === 'ok') flashTimer = setTimeout(() => { f.hidden = true; }, 6000);
}
function isArmed(key) { return armed[key] > now(); }
/** First click arms, the second (within 3 s) goes. */
function arm(key) {
  if (isArmed(key)) { delete armed[key]; return false; }
  armed[key] = now() + ARM_MS;
  setTimeout(() => { delete armed[key]; refreshDrawer(); }, ARM_MS + 50);
  refreshDrawer();
  return true;
}
function liveItems() { return SNAP && SNAP.activity ? SNAP.activity.filter((a) => isLive(a.status)) : []; }
function pollSnap() {
  clearTimeout(snapTimer); snapTimer = 0;
  if (snapPolling) return Promise.resolve();
  snapPolling = true;
  return invoke('poolSnapshot', {}).then((r) => {
    if (r && r.ok === false) throw new Error(r.error || 'poolSnapshot failed');
    SNAP = r; setConn('');
    renderRuns();
  }, (err) => setConn('offline: ' + String((err && err.message) || err))).then(() => {
    snapPolling = false;
    if (!document.hidden) snapTimer = setTimeout(pollSnap, liveItems().length ? SNAP_LIVE_MS : SNAP_IDLE_MS);
  });
}
function setConn(text) {
  const c = $('#conn');
  c.hidden = !text; if (c.textContent !== text) c.textContent = text;
}
function renderRuns() {
  const n = liveItems().length, b = $('#runsBtn');
  const t = n + ' running';
  if ($('#runsCount').textContent !== t) $('#runsCount').textContent = t;
  b.classList.toggle('live', n > 0);
  if (drawerOf === 'open:runs' || drawerOf === 'open:manage') refreshDrawer();
}
function runRow(a) {
  const live = isLive(a.status);
  const tk = a.tokens ? a.tokens[0] + a.tokens[1] + a.tokens[2] + a.tokens[3] : (a.tokensIn || 0) + (a.tokensOut || 0);
  const cost = a.cost ? a.cost[0] + a.cost[1] + a.cost[2] + a.cost[3] : null;
  const key = 'stop:' + a.id;
  const dot = live ? '<span class="bd"></span>' : '<span class="bd idle"></span>';
  return '<div class="run">' + dot + '<span class="t" title="' + esc(a.title) + '">' + (a.agent ? '<span class="ag">' + esc(a.agent) + '</span> ' : '') + esc(a.title) + '</span>' +
    (live && a.canStop ? '<button class="btn danger' + (isArmed(key) ? ' armed' : '') + '" data-sact="stop" data-id="' + esc(a.id) + '"' + (busy[key] ? ' disabled' : '') + '>' + (isArmed(key) ? 'Confirm stop' : 'Stop') + '</button>' : '<span class="dim">' + esc(a.status) + '</span>') +
    '<span class="m">' + esc(a.status + (a.phase ? ' · ' + a.phase : a.detail ? ' · ' + a.detail : '')) + ' · ' + esc(a.seat || 'no seat yet') + ' · ' + esc(a.servedModel || a.model || '') + ' · ' + tok(tk) + ' tok' + (cost != null ? ' · ' + usd(cost) : '') +
      ' · <span data-since="' + a.startedAt + '"' + (a.endedAt ? ' data-until="' + a.endedAt + '"' : '') + '></span>' + (a.loop ? ' · <span class="warn">loop ×' + a.loop.streak + '</span>' : '') + '</span></div>';
}
OPEN.runs = () => {
  const list = SNAP && SNAP.activity ? SNAP.activity : [];
  const live = list.filter((a) => isLive(a.status)), done = list.filter((a) => !isLive(a.status)).slice(0, 6);
  return ['Running', live.length + ' live turn' + (live.length === 1 ? '' : 's'),
    sub('Now', live.length ? '<div class="list">' + live.map(runRow).join('') + '</div>' : '<span class="dim">Nothing runs on the seats right now.</span>') +
    (done.length ? sub('Finished recently', '<div class="list">' + done.map(runRow).join('') + '</div>') : '')];
};
OPEN.manage = () => {
  const st = (SNAP && SNAP.settings) || D.settings || {};
  const sel = (v, cur, label) => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + label + '</option>';
  return ['Manage', SNAP && SNAP.cli ? 'CLI ' + (SNAP.cli.version || SNAP.cli.source || '') : '',
    sub('Placement', '<div class="frow"><label for="mStrategy">Strategy</label><select class="field" id="mStrategy">' + Object.keys(STRATEGY).map((k) => sel(k, st.strategy, STRATEGY[k])).join('') + '</select></div>' +
      '<div class="frow"><label for="mThreshold">Switch at %</label><input class="field" id="mThreshold" type="number" min="1" max="100" value="' + (st.threshold || 80) + '"><button class="btn" data-sact="threshold">Set</button></div>' +
      '<div class="frow"><label for="mSort">Seat order</label><select class="field" id="mSort">' + sel('manual', st.seatSort || 'manual', 'manual order') + sel('reset', st.seatSort, 'by reset') + '</select></div>') +
    sub('Usage', '<div class="acts"><button class="btn" data-sact="refreshall"' + (busy['refresh:*'] ? ' disabled' : '') + '>Refresh every seat</button></div>') +
    sub('Add a seat', '<div class="frow"><input class="field" id="mLabel" placeholder="Label"></div>' +
      '<div class="frow"><input class="field" id="mToken" type="password" placeholder="setup-token (optional, else a login window opens)"><button class="btn primary" data-sact="add"' + (busy.add ? ' disabled' : '') + '>Add</button></div>')];
};
/** Buttons of one seat, in its drawer. */
function seatActionsHtml(s) {
  const id = esc(s.id);
  const b = (act, label, extra) => { const key = act + ':' + s.id; return '<button class="btn' + (extra || '') + '" data-sact="' + act + '" data-id="' + id + '"' + (busy[key] ? ' disabled' : '') + '>' + label + '</button>'; };
  const rk = 'remove:' + s.id;
  const stuck = s.exhaustedUntil || s.throttledUntil;
  return '<div class="acts">' + b('refresh', 'Refresh usage') + b('test', 'Test') + b('login', 'Log in again') + b('toggle', s.enabled ? 'Disable' : 'Enable') +
    (stuck ? b('clear', 'Clear limit') : '') + b('pin', s.exposeModels ? 'Hide its models' : 'Expose its models') + '</div>' +
    '<div class="acts">' + b('top', 'Move to top') + b('up', 'Move up') + b('down', 'Move down') +
    '<button class="btn danger' + (isArmed(rk) ? ' armed' : '') + '" data-sact="remove" data-id="' + id + '"' + (busy[rk] ? ' disabled' : '') + '>' + (isArmed(rk) ? 'Confirm remove' : 'Remove') + '</button></div>' +
    '<div class="frow"><input class="field" id="tok-' + id + '" type="password" placeholder="setup-token (empty = use its login)"><button class="btn" data-sact="savetoken" data-id="' + id + '">Save token</button></div>';
}
function run(key, action, args, okText) {
  busy[key] = true; refreshDrawer();
  return invoke(action, args).then((r) => {
    if (r && r.ok === false) throw new Error(r.error || action + ' failed');
    if (okText) flash('ok', typeof okText === 'function' ? okText(r) : okText);
    return r;
  }, (err) => { throw err; }).catch((err) => { flash('err', String((err && err.message) || err)); return null; }).then((r) => {
    delete busy[key];
    return Promise.all([pollSnap(), pollUsage(true)]).then(() => { refreshDrawer(); return r; });
  });
}
const labelOf = (id) => { const s = seatOf(id); return s ? s.label : id; };
function onSeatAct(btn) {
  const act = btn.dataset.sact, id = btn.dataset.id;
  const s = id ? seatOf(id) : null;
  if (act === 'flash-close') return flash('', '');
  if (act === 'stop') { if (arm('stop:' + id)) return; return run('stop:' + id, 'stopActivity', { id }, 'Stop requested.'); }
  if (act === 'remove') { if (arm('remove:' + id)) return; const name = labelOf(id); return run('remove:' + id, 'removeAccount', { id }, 'Removed ' + name + '.').then(() => closeDrawer()); }
  if (act === 'refresh') return run('refresh:' + id, 'refreshUsage', { id }, 'Usage refreshed.');
  if (act === 'refreshall') return run('refresh:*', 'refreshUsage', {}, 'Usage refreshed.');
  if (act === 'test') return run('test:' + id, 'testConnection', { accountId: id }, (r) => labelOf(id) + ' answered: ' + (r && r.sample ? r.sample : 'ok'));
  if (act === 'login') return run('login:' + id, 'loginAccount', { id }, 'Login window opened for ' + labelOf(id) + '.');
  if (act === 'toggle') return run('toggle:' + id, 'updateAccount', { id, enabled: !(s && s.enabled) });
  if (act === 'pin') return run('pin:' + id, 'updateAccount', { id, exposeModels: !(s && s.exposeModels) });
  if (act === 'clear') return run('clear:' + id, 'clearExhausted', { id });
  if (act === 'top' || act === 'up' || act === 'down') return run(act + ':' + id, 'moveAccount', act === 'top' ? { id, index: 0 } : { id, delta: act === 'up' ? -1 : 1 });
  if (act === 'savetoken') {
    const v = $('#tok-' + id), token = v ? v.value.trim() : '';
    return run('savetoken:' + id, 'setAccountToken', { id, token }, token ? 'Token saved for ' + labelOf(id) + '.' : labelOf(id) + ' uses its login again.').then((r) => { if (r && v) v.value = ''; });
  }
  if (act === 'threshold') {
    const n = Math.round(Number(($('#mThreshold') || {}).value));
    if (!(n >= 1 && n <= 100)) return flash('err', 'Switch threshold must be 1 to 100.');
    return run('settings', 'updateSettings', { threshold: n }, 'Switch threshold set to ' + n + '%.');
  }
  if (act === 'add') {
    const label = (($('#mLabel') || {}).value || '').trim(), token = (($('#mToken') || {}).value || '').trim();
    if (!label) { const l = $('#mLabel'); if (l) l.focus(); return flash('err', 'A label is needed.'); }
    return run('add', 'addAccount', { label, token, login: !token }, token ? 'Added ' + label + '.' : 'Added ' + label + ': finish the login in the window that opened.')
      .then((r) => { if (r) { $('#mLabel').value = ''; $('#mToken').value = ''; } });
  }
}
document.addEventListener('click', (e) => {
  const b = e.target && e.target.closest ? e.target.closest('[data-sact]') : null;
  if (!b || b.disabled) return;
  e.stopPropagation();
  return onSeatAct(b);
});
document.addEventListener('change', (e) => {
  const t = e.target; if (!t || !t.id) return;
  if (t.id === 'mStrategy') return run('settings', 'updateSettings', { strategy: t.value }, 'Strategy: ' + (STRATEGY[t.value] || t.value) + '.');
  if (t.id === 'mSort') return run('settings', 'updateSettings', { seatSort: t.value });
});
`;
