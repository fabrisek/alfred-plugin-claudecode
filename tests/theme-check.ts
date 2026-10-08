/**
 * End-to-end check of the theme a plugin webview gets, without a browser:
 * the UI's real tokens (apps/ui/src/index.css, dark and light), passed
 * through the host's real hostTheme() / buildSrcDoc() (what the iframe
 * receives), then resolved through this panel's real stylesheet (plugin-kit
 * DESIGN_TOKENS + the panel's own variables). Prints, per role, the UI value
 * and the value the panel computes, and exits non-zero on a mismatch.
 *
 *   node --import tsx tests/theme-check.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderDashboard } from '../src/webview/dashboard.js';

const AGENT = process.env.ALFRED_AGENT_DIR ?? join(process.env.USERPROFILE ?? '', 'Documents', 'alfred-agent');

function block(css: string, head: string): Record<string, string> {
  const at = css.indexOf(head);
  if (at < 0) throw new Error(`no ${head} in index.css`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

/** Custom properties of every `:root { }` rule outside media queries, in order (later wins). */
function rootVars(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const noMedia = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const m of noMedia.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const d of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}

/** Resolves var() chains the way the cascade would, with `vars` as the computed custom properties. */
function resolve(value: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 10) return '<cycle>';
  return value.replace(/var\((--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_m, name: string, fb?: string) => {
    const v = vars[name];
    if (v !== undefined && v !== '<cycle>') return resolve(v, vars, depth + 1);
    return fb !== undefined ? resolve(fb.trim(), vars, depth + 1) : '<unset>';
  });
}

async function main(): Promise<void> {
  const css = readFileSync(join(AGENT, 'apps', 'ui', 'src', 'index.css'), 'utf8').replace(/\r\n/g, '\n');
  const themes = { dark: { ...block(css, '@theme {'), ...block(css, ":root,\n[data-theme='dark']") }, light: { ...block(css, '@theme {'), ...block(css, "[data-theme='light']") } };
  const shim = (await import(pathToFileURL(join(AGENT, 'apps', 'ui', 'src', 'components', 'PluginWebview', 'hostShim.ts')).href)) as {
    hostTheme(): { theme: string; css: string };
    buildSrcDoc(html: string, t?: { theme: string; css: string }): string;
  };
  const page = renderDashboard();
  const panelCss = page.slice(page.indexOf('<style>') + 7, page.indexOf('</style>'));
  const roles: Array<[string, string, string]> = [
    ['page background', '--color-bg', '--bg'],
    ['cards / zones', '--color-panel', '--panel'],
    ['hover, inputs', '--color-panel-2', '--panel-2'],
    ['lines', '--color-border', '--border'],
    ['text', '--color-text', '--text'],
    ['secondary text', '--color-text-muted', '--muted'],
    ['dim text', '--color-text-dim', '--dim'],
    ['primary button / active tab', '--color-accent', '--accent-strong'],
    ['text on primary', '--color-on-accent', '--on-accent-strong'],
    ['info / live', '--color-info', '--accent'],
    ['ok', '--color-success', '--ok'],
    ['warning', '--color-warning', '--warn'],
    ['error', '--color-danger', '--err'],
    ['font', '--font-sans', '--font'],
    ['monospace', '--font-mono', '--mono'],
    ['radius', '--radius', '--r'],
    ['radius (large)', '--radius-lg', '--r-lg'],
  ];
  const rows: string[][] = [];
  let bad = 0;
  for (const [name, t] of Object.entries(themes)) {
    // The host side, for real: hostTheme() reading the UI's computed tokens.
    (globalThis as Record<string, unknown>).document = { documentElement: { getAttribute: () => name } };
    (globalThis as Record<string, unknown>).getComputedStyle = () => ({ getPropertyValue: (k: string) => t[k] ?? '' });
    const theme = shim.hostTheme();
    const doc = shim.buildSrcDoc(page, theme);
    // The iframe's cascade: the host style comes first, then the panel's stylesheet.
    const hostCss = doc.slice(doc.indexOf('<style id="alfred-host-theme">') + 30, doc.indexOf('</style>', doc.indexOf('alfred-host-theme')));
    const vars = { ...rootVars(hostCss), ...rootVars(panelCss) };
    const computed: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) computed[k] = resolve(v, vars);
    for (const [role, ui, panel] of roles) {
      const want = resolve(t[ui] ?? '<unset>', t);
      const got = computed[panel] ?? '<unset>';
      const ok = want === got;
      if (!ok) bad++;
      rows.push([name, role, ui, want, panel, got, ok ? 'ok' : 'MISMATCH']);
    }
    if (!doc.includes(`setAttribute('data-theme', '${name}')`)) {
      bad++;
      rows.push([name, 'data-theme on <html>', '', name, '', 'missing', 'MISMATCH']);
    }
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join(' | '));
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
