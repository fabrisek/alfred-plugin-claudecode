/**
 * The Claude panel (`claude-accounts` webview): two tabs over the same data.
 *  - Seats: a KPI band aggregated over every account, then one bubble per
 *    seat (5h ring, week arc, plan, status, threads, API value today, burn /
 *    ETA, 24h sparkline); halo on the seat that gets the next conversation;
 *    the personal seat apart as last resort. Click = the seat's drawer, with
 *    its actions.
 *  - Usage: KPIs (API value, live tokens / second, tokens split, 5h and week
 *    used plan-weighted), the stacked-area throughput chart with the
 *    cumulative API cost, the pooled 5h capacity curve, a DPS-style
 *    leaderboard, "Where the $ goes" and a discreet cache-health line.
 * A Compact density shows both at once. Every detail lives in one drawer.
 *
 * One document in a null-origin sandboxed iframe: no stylesheet fetch, no
 * storage, no dialogs, every interaction through `window.alfred.invoke`. The
 * page never scrolls (1280×800 and up): a grid shares the height and charts
 * draw at their box size. It polls `seatsUsage` (usage/seatsUsageAction.ts)
 * with the version it drew, so an idle panel never redraws, and
 * `poolSnapshot` for the live turns and the settings.
 *
 * The parts live in webview/panel/: styles, markup and the client script,
 * split by feature. The script parts are raw templates with no backtick and
 * no dollar-brace, so nothing is rewritten on the way out.
 */

import { ESC_FN_JS, invokeFnJs } from '@alfred/plugin-kit/webview';
import type { Webview } from '@alfred/sdk';
import { BOARD_JS } from './panel/clientBoard.js';
import { BOOT_JS } from './panel/clientBoot.js';
import { CORE_JS } from './panel/clientCore.js';
import { MANAGE_JS } from './panel/clientManage.js';
import { SEATS_JS } from './panel/clientSeats.js';
import { USAGE_JS } from './panel/clientUsage.js';
import { PANEL_BODY } from './panel/markup.js';
import { PANEL_CSS } from './panel/styles.js';

/** The client script: bridge helpers, then the parts in dependency order (boot last). */
export function panelScript(): string {
  return ['const invoke = ' + invokeFnJs() + ';', 'const esc = ' + ESC_FN_JS + ';', CORE_JS, SEATS_JS, USAGE_JS, BOARD_JS, MANAGE_JS, BOOT_JS].join('\n');
}

export function renderDashboard(): string {
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Claude</title>\n<style>' +
    PANEL_CSS +
    '</style>\n</head>\n<body class="balanced t-seats">' +
    PANEL_BODY +
    '<script>\n' +
    panelScript() +
    '\n</script>\n</body>\n</html>'
  );
}

export function createDashboardWebview(): Webview {
  return {
    id: 'claude-accounts',
    title: 'Claude accounts',
    icon: 'sparkles',
    render: () => ({ html: renderDashboard() }),
  };
}
