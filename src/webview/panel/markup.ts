/**
 * Body of the Claude panel: top line (tabs, period, live threads, Running,
 * Manage, density), the grid zones the Seats and Usage tabs share, the
 * detail drawer and the tooltip. Everything inside is drawn by the client
 * script from the `seatsUsage` and `poolSnapshot` actions.
 */

export const PANEL_BODY = String.raw`
<div class="top">
  <h1>Claude</h1>
  <div class="tabs" role="tablist">
    <button class="tab on" data-tab="seats" role="tab">Seats</button>
    <button class="tab" data-tab="usage" role="tab">Usage</button>
  </div>
  <div id="periodBox"><div class="seg xs" id="period"><button data-v="5h">5h</button><button data-v="today" class="on">Today</button><button data-v="7d">7d</button><button data-v="all">All</button></div></div>
  <div class="spacer"></div>
  <span class="conn" id="conn" hidden></span>
  <span class="live-top"><span class="pulse idle" id="livePulse"></span><span class="muted num" id="liveThreads"></span></span>
  <button class="tbtn" id="runsBtn" data-open="runs" title="Turns running on the seats now"><span class="d"></span><span id="runsCount">0 running</span></button>
  <button class="tbtn" id="manageBtn" data-open="manage" title="Strategy, threshold, add a seat">Manage</button>
  <div class="seg xs" id="density"><button data-v="compact">Compact</button><button data-v="balanced" class="on">Balanced</button></div>
</div>

<div id="app">
  <div class="kstrip" id="kSeat"></div>
  <div class="kstrip" id="kUse"></div>

  <div class="blk" id="seats">
    <div class="bubs" id="seatRows"></div>
  </div>

  <div class="blk" id="quota">
    <div class="bh"><h2>Pool 5h capacity</h2><span class="fig" id="quotaFig"></span><div class="spacer"></div><div class="legend" id="quotaLegend"></div></div>
    <div class="cw" id="quotaWrap"><svg id="quotaSvg"></svg></div>
  </div>

  <div class="blk" id="main">
    <div class="bh"><h2 id="mainTitle">Throughput</h2><span class="fig" id="mainFig"></span><div class="spacer"></div>
      <div class="seg xs" id="unit"><button data-v="tok" class="on">Tokens</button><button data-v="usd">$</button></div>
      <div class="seg xs" id="split"><button data-v="type" class="on">Type</button><button data-v="seat">Seat</button></div>
      <div class="seg xs" id="evSeg"><button data-v="on" title="Show cold cache and compactions on the curve">Cache events</button></div></div>
    <div class="legend" id="chartLegend"></div>
    <div class="cw" id="chartWrap"><svg id="chart"></svg></div>
  </div>

  <div id="side">
    <div class="blk grow"><div class="bh"><h2>Leaderboard</h2><div class="spacer"></div><div class="seg xs" id="dpsBy"><button data-v="seat" class="on">Seats</button><button data-v="agent">Agents</button><button data-v="conv">Threads</button></div></div><div class="dps" id="dps"></div></div>
    <div class="blk"><div class="bh"><h2>Where the $ goes</h2><span class="fig" id="splitFig"></span></div><div class="split" id="split2"></div></div>
  </div>

  <div id="events"></div>
</div>

<aside class="drawer" id="drawer" hidden>
  <div class="dh"><h3 id="dTitle"></h3><span class="dim" id="dSub"></span><div class="spacer"></div><button class="x" id="dClose" aria-label="Close">×</button></div>
  <div class="db" id="dBody"></div>
</aside>
<div class="tip" id="tip" hidden></div>
<div id="flash" hidden></div>
`;
