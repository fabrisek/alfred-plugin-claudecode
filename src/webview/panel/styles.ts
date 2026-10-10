/**
 * Styles of the Claude panel (Seats / Usage), from the validated mockup
 * (docs/seats-usage-mockup.html). Host theme first: the Alfred UI copies its
 * tokens into the iframe as `--alfred-color-*` (and `--color-*`); the `--fb-*`
 * palette is only the standalone fallback, same values as autopilot's.
 *
 * Layout: the page never scrolls. A CSS grid per tab and density (Balanced,
 * the default, or Compact) shares the height; charts draw at their box size.
 */

export const PANEL_CSS = String.raw`
:root, :root[data-theme='dark'] {
  --fb-bg: #0a0a0a; --fb-bg-elev: #131313; --fb-panel: #181818; --fb-panel-2: #222222;
  --fb-panel-3: #2c2c2c; --fb-border: #1f1f1f; --fb-border-strong: #2e2e2e;
  --fb-text: #ededed; --fb-text-muted: #9a9a9a; --fb-text-dim: #6a6a6a;
  --fb-accent: #ededed; --fb-on-accent: #0a0a0a;
  --fb-success: #6fae7a; --fb-warning: #d0a050; --fb-danger: #d76558; --fb-info: #5b9bf8;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300; --s7: #9085e9; --s8: #e66767;
  --s-neutral: #77756f; --shadow: rgba(0,0,0,.45);
  color-scheme: dark;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    --fb-bg: #fafafa; --fb-bg-elev: #ffffff; --fb-panel: #f3f3f4; --fb-panel-2: #e8e8ea;
    --fb-panel-3: #dadadd; --fb-border: #e4e4e7; --fb-border-strong: #c9c9ce;
    --fb-text: #141414; --fb-text-muted: #5e5e66; --fb-text-dim: #8e8e96;
    --fb-accent: #141414; --fb-on-accent: #ffffff;
    --fb-success: #3f7d4d; --fb-warning: #a37314; --fb-danger: #b8463a; --fb-info: #2f6fd0;
    --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7; --s8: #e34948;
    --s-neutral: #8e8c86; --shadow: rgba(0,0,0,.12);
    color-scheme: light;
  }
}
:root[data-theme='light'] {
  --fb-bg: #fafafa; --fb-bg-elev: #ffffff; --fb-panel: #f3f3f4; --fb-panel-2: #e8e8ea;
  --fb-panel-3: #dadadd; --fb-border: #e4e4e7; --fb-border-strong: #c9c9ce;
  --fb-text: #141414; --fb-text-muted: #5e5e66; --fb-text-dim: #8e8e96;
  --fb-accent: #141414; --fb-on-accent: #ffffff;
  --fb-success: #3f7d4d; --fb-warning: #a37314; --fb-danger: #b8463a; --fb-info: #2f6fd0;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300; --s7: #4a3aa7; --s8: #e34948;
  --s-neutral: #8e8c86; --shadow: rgba(0,0,0,.12);
  color-scheme: light;
}
:root {
  --bg: var(--alfred-color-bg, var(--fb-bg));
  --elev: var(--alfred-color-bg-elev, var(--fb-bg-elev));
  --panel: var(--alfred-color-panel, var(--fb-panel));
  --panel-2: var(--alfred-color-panel-2, var(--fb-panel-2));
  --panel-3: var(--alfred-color-panel-3, var(--fb-panel-3));
  --border: var(--alfred-color-border, var(--fb-border));
  --border-strong: var(--alfred-color-border-strong, var(--fb-border-strong));
  --text: var(--alfred-color-text, var(--fb-text));
  --muted: var(--alfred-color-text-muted, var(--fb-text-muted));
  --dim: var(--alfred-color-text-dim, var(--fb-text-dim));
  --accent: var(--alfred-color-accent, var(--fb-accent));
  --on-accent: var(--alfred-color-on-accent, var(--fb-on-accent));
  --ok: var(--alfred-color-success, var(--fb-success));
  --warn: var(--alfred-color-warning, var(--fb-warning));
  --err: var(--alfred-color-danger, var(--fb-danger));
  --info: var(--alfred-color-info, var(--fb-info));
  --font: var(--alfred-font-sans, 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
  --mono: var(--alfred-font-mono, 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace);
  --r: var(--alfred-radius, .375rem); --r-lg: var(--alfred-radius-lg, .5rem); --r-xl: var(--alfred-radius-xl, .75rem);
  --ease: cubic-bezier(.2, .7, .2, 1);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; line-height: 1.4;
  -webkit-font-smoothing: antialiased; font-feature-settings: 'cv11', 'ss01', 'ss03'; }
body { padding: 0 16px 12px; overflow: hidden; display: flex; flex-direction: column; gap: 12px; }
button { font-family: inherit; cursor: pointer; color: inherit; }
:where(button, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }
.label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--dim); font-weight: 600; white-space: nowrap; }
.sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; flex: none; }
.seg { display: inline-flex; background: var(--panel); border: 1px solid var(--border); border-radius: var(--r); padding: 2px; gap: 2px; }
.seg button { border: 0; background: none; color: var(--muted); font-size: 11.5px; padding: 2px 8px; border-radius: calc(var(--r) - 2px); }
.seg button:hover { color: var(--text); }
.seg button.on { background: var(--panel-3); color: var(--text); font-weight: 600; }
.seg.xs button { font-size: 11px; padding: 1px 7px; }
.spacer { flex: 1; }
.num { font-variant-numeric: tabular-nums; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

/* top line */
.top { display: flex; align-items: center; flex: none; border-bottom: 1px solid var(--border); gap: 14px; min-height: 42px; }
.top h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: pulse 2s infinite; display: inline-block; }
.pulse.idle { background: var(--panel-3); animation: none; }
.live-top { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
.tabs { display: flex; gap: 2px; align-self: stretch; }
.tab { border: 0; background: none; padding: 0 10px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; font-size: 13px; }
.tab:hover { color: var(--text); }
.tab.on { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
body.compact .tabs { display: none; }
.tbtn { border: 1px solid var(--border); background: var(--panel); color: var(--muted); font-size: 11.5px; padding: 3px 9px; border-radius: var(--r); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.tbtn:hover { color: var(--text); border-color: var(--border-strong); }
.tbtn .d { width: 6px; height: 6px; border-radius: 50%; background: var(--panel-3); }
.tbtn.live .d { background: var(--ok); animation: pulse 2s infinite; }
.conn { font-size: 11.5px; color: var(--err); }
#flash { position: fixed; left: 50%; transform: translateX(-50%); bottom: 14px; z-index: 40; padding: 7px 12px; border-radius: var(--r-lg); font-size: 12px;
  background: var(--panel); border: 1px solid var(--border-strong); box-shadow: 0 8px 24px var(--shadow); display: flex; gap: 10px; align-items: center; max-width: 70vw; }
#flash.ok { color: var(--ok); } #flash.err { color: var(--err); }
#flash button { border: 0; background: none; color: var(--muted); font-size: 14px; padding: 0 2px; }

/* ===== layout ===== */
#app { flex: 1; min-height: 0; display: grid; gap: 12px; }
#app > * { min-width: 0; min-height: 0; }
.blk { background: var(--elev); border-radius: var(--r-xl); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.bh { display: flex; align-items: center; gap: 10px; flex: none; min-width: 0; }
.bh h2 { margin: 0; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.bh .fig { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bh .fig b { color: var(--text); font-weight: 600; }
#kSeat { grid-area: kseat; } #seats { grid-area: seats; } #quota { grid-area: quota; }
#kUse { grid-area: kuse; } #main { grid-area: main; } #side { grid-area: side; } #events { grid-area: events; }
body.balanced.t-seats #app { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); grid-template-areas: "kseat" "seats"; }
body.balanced.t-seats #kUse, body.balanced.t-seats #main, body.balanced.t-seats #side, body.balanced.t-seats #events, body.balanced.t-seats #quota { display: none; }
body.balanced.t-usage #app { grid-template-columns: minmax(0, 65fr) minmax(0, 35fr); grid-template-rows: auto minmax(0, 1fr) minmax(150px, 30%) auto; grid-template-areas: "kuse kuse" "main side" "quota side" "events events"; }
body.balanced.t-usage #kSeat, body.balanced.t-usage #seats { display: none; }
body.compact #app { grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr) minmax(0, .8fr); grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  grid-template-areas: "kuse kuse kuse" "kseat kseat kseat" "seats seats side" "main main side" "events events events"; gap: 10px; }
body.compact #quota { display: none; }
#periodBox { display: flex; } body.balanced.t-seats #periodBox { visibility: hidden; }

/* ===== KPI strips ===== */
.kstrip { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); background: var(--elev); border-radius: var(--r-xl); padding: 12px 4px; }
.kp { padding: 0 14px; display: flex; flex-direction: column; gap: 3px; min-width: 0; position: relative; cursor: pointer; }
.kp + .kp { box-shadow: -1px 0 0 var(--border); }
.kp .l { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kp .vrow { display: flex; align-items: flex-end; gap: 8px; min-width: 0; }
.kp .v { font-size: 22px; font-weight: 650; letter-spacing: -.025em; line-height: 1.15; font-variant-numeric: tabular-nums; white-space: nowrap; }
.kp .s { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.kp .s b { color: var(--text); font-weight: 600; }
.kp .ks { flex: 1; min-width: 40px; height: 26px; margin-bottom: 3px; }
.kp .ks svg { display: block; width: 100%; height: 100%; overflow: visible; }
.delta { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.delta.up { color: var(--ok); } .delta.down { color: var(--err); } .delta.flat { color: var(--dim); }
body.compact .kp .v { font-size: 17px; } body.compact .kp { padding: 0 10px; } body.compact .kstrip { padding: 9px 2px; }
body.compact .kp .ks { height: 20px; }

/* ===== seat badges ===== */
.plan { font: 600 9.5px/1 var(--mono); padding: 2px 4px; border-radius: 3px; background: var(--panel-3); color: var(--muted); letter-spacing: .04em; flex: none; }
.plan.MAX { color: var(--on-accent); background: var(--accent); }
.adv { font: 600 9.5px/1 var(--mono); color: var(--s7); flex: none; } .adv.off { color: var(--dim); text-decoration: line-through; opacity: .55; }
.nx { font-size: 9.5px; font-weight: 700; color: var(--ok); letter-spacing: .06em; white-space: nowrap; }
.c-st { display: flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 12.5px; }
.c-st .d { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.ok { color: var(--ok); } .info-c { color: var(--info); } .warn { color: var(--warn); } .err { color: var(--err); } .off-c { color: var(--dim); }
.dimv { color: var(--dim); }

/* ===== seat bubbles ===== */
.bubs { height: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: minmax(0, 1fr); gap: 12px; }
.bub { position: relative; background: var(--elev); border-radius: 16px; padding: 12px 14px 8px; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 6px;
  min-width: 0; min-height: 0; cursor: pointer; transition: transform .18s var(--ease), box-shadow .18s, background .18s; }
.bub:hover { transform: scale(1.03); background: var(--panel); box-shadow: 0 12px 30px var(--shadow); z-index: 2; }
.bub.sel { background: var(--panel); }
.bub.next { box-shadow: 0 0 0 1px color-mix(in srgb, var(--ok) 50%, transparent), 0 0 28px -6px color-mix(in srgb, var(--ok) 45%, transparent); }
.bub.perso { background: transparent; border: 1px dashed var(--border-strong); }
.bub.disabled { opacity: .55; }
.bub .bh2 { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 13px; }
.bub .bh2 .nm { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bub .bh2 .c-st { margin-left: auto; font-size: 11.5px; }
.bub .bmid { display: flex; align-items: center; gap: 14px; min-height: 0; }
.bub .rg { height: 100%; max-height: 108px; min-height: 56px; aspect-ratio: 1; flex: none; display: block; }
.bub .binfo { display: flex; flex-direction: column; gap: 7px; min-width: 0; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.bub .bval { font-size: 18px; font-weight: 650; color: var(--text); letter-spacing: -.02em; line-height: 1.1; }
.bub .bval small { font-size: 11.5px; font-weight: 500; color: var(--muted); letter-spacing: 0; margin-left: 4px; }
.bub .bline { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bub .bline b { color: var(--text); font-weight: 600; }
.bub .bsp svg { display: block; width: 100%; height: 26px; overflow: visible; }
body.compact .bubs { grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
body.compact .bub { padding: 8px 10px 6px; border-radius: 12px; gap: 4px; }
body.compact .bub .rg { max-height: 62px; min-height: 40px; }
body.compact .bub .bsp, body.compact .bub .bline.burn { display: none; }
body.compact .bub .bval { font-size: 15px; }
#seats { background: none; padding: 0; }

/* ===== charts ===== */
.cw { position: relative; flex: 1; min-height: 0; }
.cw svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.axis text { fill: var(--dim); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.axis .r { fill: var(--s4); }
.grid line { stroke: var(--border); }
.legend { display: flex; gap: 6px 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--muted); min-width: 0; }
.legend span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.legend .ln { width: 12px; height: 0; border-top: 2px dashed var(--s4); display: inline-block; }
.peak-l { fill: var(--text); font-size: 11px; font-weight: 600; }
.peak-s { fill: var(--muted); font-weight: 500; }
.xh line { stroke: var(--muted); stroke-dasharray: 2 3; }
.mark { transition: transform .12s; transform-box: fill-box; transform-origin: center; }
.mark.hot { transform: scale(1.6); }
.empty-c { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--dim); font-size: 12px; }
@media (prefers-reduced-motion: no-preference) {
  .reveal { animation: reveal 1s var(--ease) both; }
  @keyframes reveal { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
}

/* ===== side ===== */
#side { display: flex; flex-direction: column; gap: 12px; }
#side > .blk { flex: none; }
#side > .blk.grow { flex: 1; min-height: 0; }
.dps { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.dr { position: absolute; left: 0; right: 0; height: 22px; display: grid; grid-template-columns: minmax(0, 1fr) 56px 34px; gap: 8px; align-items: center;
  transition: transform .55s var(--ease); font-size: 12px; font-variant-numeric: tabular-nums; cursor: default; }
.dr .bar { position: relative; height: 100%; border-radius: 4px; overflow: hidden; background: var(--panel); }
.dr .bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; opacity: .62; transition: width .8s var(--ease); }
.dr .bar span { position: absolute; left: 8px; top: 0; bottom: 0; display: flex; align-items: center; gap: 6px; white-space: nowrap; font-weight: 600; color: var(--text);
  text-shadow: 0 1px 2px rgba(0,0,0,.45); max-width: calc(100% - 12px); overflow: hidden; }
.dr .bar span small { font: 500 10.5px var(--mono); opacity: .8; }
.dr .v { text-align: right; font-weight: 600; } .dr .p { text-align: right; color: var(--dim); font-size: 11px; }
.dps .none { color: var(--dim); font-size: 12px; }
.split { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 14px; align-items: center; }
.donut svg { display: block; }
.hb { display: flex; flex-direction: column; gap: 5px; }
.hbr { display: grid; grid-template-columns: 78px minmax(0, 1fr) 46px 30px; gap: 8px; align-items: center; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.hbr .t { height: 6px; background: var(--panel); border-radius: 3px; overflow: hidden; }
.hbr .t i { display: block; height: 100%; border-radius: 3px; transition: width .9s var(--ease); }
.hbr .nm { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hbr .v { text-align: right; font-weight: 600; } .hbr .p { text-align: right; color: var(--dim); }

/* ===== cache health strip ===== */
#events { display: flex; align-items: center; gap: 18px; background: var(--elev); border-radius: var(--r-xl); padding: 8px 14px; font-size: 12px; min-width: 0; overflow: hidden; white-space: nowrap; }
#events .eh { font-size: 10.5px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
#events .ei { display: inline-flex; gap: 6px; align-items: baseline; min-width: 0; overflow: hidden; color: var(--muted); }
#events .ei .tm { color: var(--dim); font-variant-numeric: tabular-nums; }
#events .ei b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
#events .ei .tt { max-width: 200px; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
#events .all { margin-left: auto; border: 0; background: none; color: var(--info); font-size: 12px; padding: 0; }

/* ===== drawer + tooltip ===== */
.drawer { position: fixed; top: 12px; right: 16px; bottom: 12px; width: min(440px, 46vw); z-index: 20; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--border-strong); border-radius: var(--r-xl); box-shadow: 0 18px 50px var(--shadow); }
@media (prefers-reduced-motion: no-preference) { .drawer:not([hidden]) { animation: slide .22s var(--ease); } @keyframes slide { from { opacity: 0; transform: translateX(12px); } } }
.dh { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.dh h3 { margin: 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dh .x { border: 0; background: none; color: var(--muted); font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: var(--r); }
.dh .x:hover { background: var(--panel-2); color: var(--text); }
.db { padding: 14px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; }
.db .sub { display: flex; flex-direction: column; gap: 8px; }
.kv { display: grid; grid-template-columns: 1fr auto; gap: 5px 12px; font-size: 12px; font-variant-numeric: tabular-nums; }
.kv span { color: var(--muted); } .kv b { font-weight: 600; text-align: right; }
.list { display: flex; flex-direction: column; font-size: 12px; }
.li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--border); }
.li:last-child { border-bottom: 0; }
.li .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.li .r { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
.li .r b { color: var(--text); font-weight: 600; }
.ag { font: 500 10.5px/1.6 var(--mono); color: var(--muted); background: var(--panel-2); padding: 0 5px; border-radius: 3px; white-space: nowrap; }
.bd { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); display: inline-block; }
.bd.idle { background: var(--panel-3); }
.spark { display: block; width: 100%; height: 40px; }
.stack { display: flex; height: 10px; gap: 2px; }
.stack i { display: block; height: 100%; }
.stack i:first-child { border-radius: 3px 0 0 3px; } .stack i:last-child { border-radius: 0 3px 3px 0; }
.tip { position: fixed; pointer-events: none; background: var(--panel); border: 1px solid var(--border-strong); border-radius: var(--r-lg);
  padding: 8px 10px; font-size: 12px; min-width: 190px; max-width: 330px; box-shadow: 0 8px 24px var(--shadow); z-index: 30; }
.tip .th { display: flex; justify-content: space-between; gap: 12px; font-weight: 600; margin-bottom: 4px; }
.tip .th span { color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums; }
.tip .trr { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto 34px; gap: 6px; align-items: center; font-variant-numeric: tabular-nums; line-height: 1.6; }
.tip .trr > span:nth-child(2) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tip .trr .p { color: var(--dim); text-align: right; }
.tip .tf { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px; display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
.tip .tf b { color: var(--ok); font-weight: 600; }
.tip .kv { margin-top: 2px; }
.tip .ev { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: 6px; line-height: 1.55; }
.tip .ev .tm { color: var(--dim); font-variant-numeric: tabular-nums; }
.tip .ev .tt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tip .ev .why { color: var(--muted); grid-column: 2 / -1; margin-top: -3px; }
.dim { color: var(--dim); } .muted { color: var(--muted); }

/* ===== drawer controls (seat actions, Manage, Running) ===== */
.acts { display: flex; flex-wrap: wrap; gap: 6px; }
.btn { border: 1px solid var(--border-strong); background: var(--panel-2); color: var(--text); font-size: 12px; padding: 4px 10px; border-radius: var(--r); white-space: nowrap; }
.btn:hover { background: var(--panel-3); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.btn.danger { color: var(--err); }
.btn.armed { background: var(--err); color: #fff; border-color: var(--err); }
.field { font: inherit; font-size: 12px; color: var(--text); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r); padding: 4px 8px; min-width: 0; }
.frow { display: flex; gap: 8px; align-items: center; }
.frow .field { flex: 1; }
.frow label { color: var(--muted); font-size: 12px; min-width: 92px; }
.run { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 8px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.run:last-child { border-bottom: 0; }
.run .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.run .m { grid-column: 2 / -1; color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;
