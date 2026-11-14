/*
 * The dashboard page: plain HTML, one stylesheet and one small script, no framework (ADR-009,
 * ADR-031). Every section is a block built from the JSON API; swapping a block means changing
 * one function. All text is set with textContent (prompts and reasons are untrusted). Prompt
 * text drawn on the canvas uses fillText only. The script only talks to this server's own
 * /api paths.
 *
 * Views (hash routes, no router library): `#/` the prompt box (the default, ADR-038),
 * `#/overview` Overview (aggregates across every prompt only), `#/history` the run list
 * (ADR-042), `#/history/<runId>` one prompt's detail. Old `#/prompts` links still open the
 * same views.
 *
 * The prompt box works like a chat prompt: submit plans and runs right away. While the user is
 * typing or a prompt is working, the page drops to focus mode: the prompt, a compact live task
 * list (model, status, cost so far) and Stop. Everything else (tabs, meta, charts) steps back.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>soot dashboard (local)</title>
    <link rel="icon" href="/mark.png" type="image/png" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div class="wrap">
      <header class="top">
        <h1>
          <img src="/logo.png" alt="soot" width="144" height="32" />
          <span>local dashboard</span>
        </h1>
        <p class="meta" id="meta">loading…</p>
      </header>
      <nav class="tabs" aria-label="views">
        <a class="tab" id="tab-compose" href="#/">Prompt</a>
        <a class="tab" id="tab-overview" href="#/overview">Overview</a>
        <a class="tab" id="tab-prompts" href="#/history">History</a>
      </nav>
      <main id="view-compose" class="compose" aria-label="prompt">
        <div id="cmp-live" class="cmp-live" hidden></div>
        <form id="cmp-form" class="cmp-form" novalidate>
          <label class="sr-only" for="cmp-prompt">Prompt</label>
          <textarea id="cmp-prompt" rows="3" placeholder="What should soot do?" aria-describedby="cmp-why" spellcheck="true"></textarea>
          <div class="cmp-bar">
            <label class="sr-only" for="cmp-project">Project</label>
            <select id="cmp-project" class="cmp-select"></select>
            <span class="cmp-labels" id="cmp-labels"></span>
            <button id="cmp-send" class="btn primary" type="submit">Run <kbd>↵</kbd></button>
          </div>
          <p id="cmp-why" class="cmp-why" role="status" aria-live="polite"></p>
          <p id="cmp-sr" class="sr-only" role="status" aria-live="polite"></p>
        </form>
        <details id="cmp-setup" class="cmp-setup" hidden><summary>setup</summary><div id="cmp-setup-body"></div></details>
      </main>
      <main id="view-overview" class="grid" hidden>
        <section id="tiles" class="tiles wide" aria-label="summary"></section>
        <section id="pgrid-panel" class="block wide pgrid-panel" aria-label="prompts over time"></section>
        <section id="centerpiece" class="block wide centerpiece">
          <h2>Where tasks went · latest prompts</h2>
          <p class="note">Tasks per model for the latest 8 prompts. A task that used more than one model is counted under each. The largest share is bracketed in cream. The legend counts every prompt.</p>
          <canvas id="flow" width="960" height="320" aria-label="Tasks from prompts to models"></canvas>
          <div id="legend" class="model-legend" aria-label="model legend"></div>
        </section>
        <div id="agg" class="grid wide"></div>
      </main>
      <main id="view-prompts" class="grid" hidden>
        <section id="prompts" class="block wide prompts" aria-label="history">loading…</section>
      </main>
      <main id="view-prompt" class="grid" hidden>
        <p class="wide"><a class="back" href="#/history">← History</a></p>
        <div id="run" class="grid wide"></div>
      </main>
    </div>
    <script src="/app.js" defer></script>
  </body>
</html>
`;

export const GATE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>soot dashboard (local)</title>
    <link rel="icon" href="/mark.png" type="image/png" />
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <div class="wrap">
      <header class="top">
        <h1><img src="/logo.png" alt="soot" width="144" height="32" /><span>local dashboard</span></h1>
        <p class="meta">127.0.0.1 only</p>
      </header>
      <main class="gate block">
        <h2>Open the link from your terminal</h2>
        <p>This dashboard only opens with the link printed by <code>soot dashboard</code>. It looks like <code>http://127.0.0.1:8787/?token=…</code>.</p>
        <p class="note">The link holds an access token, new each start. Opening it signs this browser in with a cookie and removes the token from the address bar. Restarting the dashboard prints a new link.</p>
      </main>
    </div>
  </body>
</html>
`;

export const STYLE_CSS = `/* Palette (ADR-031 amendment): near-black, orange accent, cream text, warm grays.
   Spacing: one 8px scale. Square corners, 1px hairlines, blocky pieces (ADR-009). */
:root {
  --page: #0a0a0a; --block: #141414; --raised: #1f1b18; --line: #2e2a27; --line-2: #4a433d;
  --text: #d6ccbd; --cream: #e8dcc8; --muted: #8c8278; --orange: #ff7a1a; --orange-dark: #c25510;
  --error: #ff4d2e; --ink: rgba(10, 10, 10, 0.62);
  --s1: 8px; --s2: 16px; --s3: 24px; --s4: 32px;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--page); color: var(--text); font: 13px/1.45 ui-monospace, Menlo, Consolas, monospace; }
a { color: var(--orange); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--cream); outline-offset: 2px; }
.wrap { max-width: 1280px; margin: 0 auto; padding: var(--s3) var(--s2) var(--s4); }
.grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--s2); }
.wide { grid-column: 1 / -1; }
.top { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--s1) var(--s2); margin-bottom: var(--s2); }
h1 { display: flex; align-items: center; gap: var(--s1); font-size: 16px; margin: 0; color: var(--orange); font-weight: normal; }
h1 img { height: 32px; width: auto; image-rendering: pixelated; image-rendering: crisp-edges; display: block; }
.meta { margin: 0; color: var(--muted); font-size: 12px; }
.meta time { color: var(--cream); }
.tabs { display: flex; border-bottom: 1px solid var(--line); margin-bottom: var(--s3); }
.tab { display: block; padding: var(--s1) var(--s2); margin-right: -1px; border: 1px solid var(--line); border-bottom: 0; color: var(--muted); text-decoration: none; text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; }
.tab:hover { color: var(--cream); background: var(--raised); }
.tab.active { color: var(--page); background: var(--orange); border-color: var(--orange); }
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s2); }
.tile { background: var(--block); border: 1px solid var(--line); border-top: 4px solid var(--orange); padding: var(--s2); min-width: 0; }
.tile .num { font-size: 28px; line-height: 1.1; color: var(--cream); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile .lbl { margin-top: var(--s1); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--orange); }
.tile .sub { font-size: 12px; color: var(--muted); }
.block { grid-column: span 6; min-width: 0; border: 1px solid var(--line); background: var(--block); padding: var(--s2); }
.block.wide { grid-column: 1 / -1; }
.block h2 { display: flex; align-items: center; gap: var(--s1); font-size: 12px; font-weight: normal; text-transform: uppercase; letter-spacing: 0.08em; margin: 0 0 var(--s2); padding-bottom: var(--s1); border-bottom: 1px solid var(--line); color: var(--orange); }
.block h2::before { content: ''; width: 8px; height: 8px; background: var(--orange); flex: none; }
.block pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.note { margin: 0 0 var(--s2); color: var(--muted); font-size: 12px; }
pre.note { margin: var(--s1) 0 0; }
.error { color: var(--error); }
.centerpiece { display: flex; flex-direction: column; }
#flow { width: 100%; height: auto; background: var(--block); border: 1px solid var(--line); image-rendering: pixelated; image-rendering: crisp-edges; display: block; }
.model-legend { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3); margin-top: var(--s2); font-size: 12px; }
.model-legend .item { display: flex; align-items: center; color: var(--cream); }
.model-legend .n { color: var(--muted); margin-left: var(--s1); }
.sub-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s1) var(--s3); }
.chart { margin: 0 0 var(--s2); min-width: 0; }
.chart h3 { font-size: 12px; margin: 0 0 var(--s1); color: var(--muted); font-weight: normal; text-transform: uppercase; letter-spacing: 0.06em; }
.row { display: grid; grid-template-columns: minmax(0, 17em) minmax(0, 1fr) minmax(0, 9em); gap: var(--s1); align-items: center; min-height: 20px; font-size: 12px; }
.row.long { grid-template-columns: minmax(0, 8em) minmax(0, 1fr) minmax(0, 15em); }
.row .label, .row .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .label { display: flex; align-items: center; min-width: 0; }
.row .label > span:last-child { overflow: hidden; text-overflow: ellipsis; }
.row .value { text-align: right; color: var(--cream); }
.track { height: 12px; background: #1f1c1a; position: relative; display: flex; }
.bar { height: 12px; }
.bar.act { background: var(--orange); }
.bar.act-2 { background: var(--orange-dark); }
.bar.est { background: repeating-linear-gradient(90deg, var(--cream) 0 4px, transparent 4px 6px); border: 1px solid var(--cream); }
.bar.est-2 { background: repeating-linear-gradient(90deg, var(--muted) 0 4px, transparent 4px 6px); border: 1px solid var(--muted); }
.bar.cnt { background: var(--muted); }
.bar.pass { background: var(--orange); }
.bar.fail { background: var(--error); }
.bar.other { background: var(--muted); }
.span { position: absolute; top: 0; height: 12px; }
.tick { position: absolute; top: -2px; width: 2px; height: 16px; background: var(--cream); }
.unknown { color: var(--muted); font-style: italic; }
.pair { display: flex; flex-wrap: wrap; gap: var(--s3); }
.donut { display: grid; grid-template-columns: repeat(11, 8px); grid-auto-rows: 8px; gap: 1px; margin: 2px 0; flex: none; }
.px { width: 8px; height: 8px; }
.legend { display: flex; flex-direction: column; gap: 4px; font-size: 12px; min-width: 0; }
.legend .item { display: flex; align-items: center; }
.sw { display: inline-block; width: 12px; height: 12px; margin-right: var(--s1); flex: none; border: 1px solid var(--ink); }
.pat-hatch { background-image: repeating-linear-gradient(45deg, var(--ink) 0 2px, transparent 2px 6px); }
.pat-dots { background-image: radial-gradient(var(--ink) 1.5px, transparent 1.7px); background-size: 6px 6px; }
.pat-checker { background-image: conic-gradient(var(--ink) 25%, transparent 0 50%, var(--ink) 0 75%, transparent 0); background-size: 6px 6px; }
.pat-hstripe { background-image: repeating-linear-gradient(0deg, var(--ink) 0 2px, transparent 2px 5px); }
.pat-vstripe { background-image: repeating-linear-gradient(90deg, var(--ink) 0 2px, transparent 2px 5px); }
.share { display: flex; gap: var(--s2); align-items: center; }
.tag { display: inline-block; max-width: 100%; vertical-align: middle; border: 1px solid var(--line-2); padding: 0 6px; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag.state { color: var(--cream); }
.tag.state-succeeded, .tag.state-passed { color: var(--orange); border-color: var(--orange-dark); }
.tag.state-failed { color: var(--error); border-color: var(--error); }
.tags { display: flex; flex-wrap: wrap; gap: var(--s1); align-items: center; }
.tags .note, .model-chain .note, .tags p { margin: 0; }
.model { display: inline-flex; align-items: center; min-width: 0; }
.prompt-list { display: flex; flex-direction: column; gap: var(--s1); }
a.prompt-row { display: grid; grid-template-columns: 11em minmax(0, 1fr) auto; gap: var(--s1) var(--s2); align-items: start; color: var(--text); text-decoration: none; background: var(--page); border: 1px solid var(--line); border-left: 4px solid var(--line); padding: var(--s1) var(--s2); }
a.prompt-row:hover { background: var(--raised); border-left-color: var(--line-2); }
a.prompt-row.current { background: var(--raised); border-color: var(--orange); border-left-color: var(--orange); }
.prompt-when { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; font-size: 12px; color: var(--muted); }
.prompt-text { color: var(--cream); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.prompt-models { display: flex; flex-wrap: wrap; gap: 4px var(--s2); margin-top: 4px; font-size: 12px; color: var(--muted); }
.prompt-models .item { display: flex; align-items: center; }
.prompt-stats { text-align: right; font-size: 12px; color: var(--cream); white-space: nowrap; }
.prompt-stats .sub { color: var(--muted); }
.prompt-stats b { color: var(--cream); font-weight: normal; }
.back { display: inline-block; text-decoration: none; text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; border: 1px solid var(--line); padding: 4px var(--s1); margin: 0; }
.back:hover { background: var(--raised); }
p.wide { margin: 0; }
.prompt { border: 1px dashed var(--orange); padding: var(--s1); white-space: pre-wrap; color: var(--cream); margin-bottom: var(--s1); }
.task-row { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--s2); align-items: start; border-top: 1px solid var(--line); padding: var(--s1) 0; }
.task-row .t { color: var(--orange); }
.task-row .r { text-align: right; }
.model-chain { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.split { color: var(--muted); margin: var(--s1) 0; }
.layer { display: flex; flex-wrap: wrap; gap: var(--s1); margin: 0 0 var(--s1) var(--s2); }
.card { border: 1px solid var(--line); background: var(--page); padding: var(--s1); min-width: 16em; max-width: 34em; }
.card .t { color: var(--orange); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: var(--s1); }
.chip { display: inline-flex; align-items: center; border: 1px solid var(--line-2); padding: 0 6px; color: var(--cream); font-size: 12px; }
.chip .sw { margin-right: 6px; width: 10px; height: 10px; }
.via { color: var(--orange); font-size: 12px; }
.pgrid-panel { position: relative; }
.pgrid-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s1) var(--s2); margin-bottom: var(--s2); padding-bottom: var(--s1); border-bottom: 1px solid var(--line); }
.pgrid-head h2 { margin: 0; padding: 0; border: 0; }
.seg { display: inline-flex; border: 1px solid var(--line-2); }
.seg-b { padding: 4px var(--s2); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); text-decoration: none; border-left: 1px solid var(--line-2); }
.seg-b:first-child { border-left: 0; }
.seg-b:hover { color: var(--cream); background: var(--raised); }
.seg-b.on { color: var(--page); background: var(--orange); }
.pgrid-scroll { overflow-x: auto; padding: 4px 0 var(--s1); }
.pgrid { display: flex; gap: 1px; align-items: flex-start; --c: 20px; width: max-content; }
.pgrid.z-hour { --c: 12px; }
.gcol { display: flex; flex-direction: column; gap: 1px; width: var(--c); flex: none; }
.gcol.rlabels { width: 36px; margin-right: 4px; }
.glabel { height: 18px; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: visible; }
.rlabel { height: var(--c); font-size: 12px; line-height: var(--c); color: var(--muted); white-space: nowrap; overflow: visible; }
.cell { display: block; width: var(--c); height: var(--c); flex: none; box-shadow: inset 1px 1px 0 rgba(255, 255, 255, 0.16), inset -1px -1px 0 rgba(0, 0, 0, 0.4); }
.cell.empty { background: #1a1715; box-shadow: inset 0 0 0 1px #24201d; }
.cell.none { background: transparent; box-shadow: none; }
.cell.l0 { background: #3b2414; }
.cell.l1 { background: #6b3511; }
.cell.l2 { background: #a1480f; }
.cell.l3 { background: #d45f12; }
.cell.l4 { background: #ff7a1a; }
a.cell:hover, a.cell:focus-visible { outline: 2px solid var(--cream); outline-offset: 0; position: relative; z-index: 1; }
.more { font-size: 12px; color: var(--orange); text-decoration: none; white-space: nowrap; margin-top: 2px; }
.more:hover { text-decoration: underline; }
.ramp-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); margin-top: var(--s2); }
.ramp-wrap .note { margin: 0; }
.ramp { display: flex; align-items: center; gap: 4px; }
.ramp .cell { width: 12px; height: 12px; }
.ramp .note + .cell.empty { margin-left: var(--s1); }
.empty-msg { color: var(--cream); margin: var(--s2) 0 0; }
.gtip { position: absolute; z-index: 5; max-width: 320px; background: var(--raised); border: 1px solid var(--orange); padding: var(--s1); font-size: 12px; white-space: pre-line; color: var(--cream); pointer-events: none; box-shadow: 4px 4px 0 #000; }
.filter-chip { display: inline-flex; flex-wrap: wrap; gap: var(--s1); align-items: center; border: 1px solid var(--orange); background: var(--raised); padding: 4px var(--s1); margin-bottom: var(--s2); color: var(--cream); font-size: 12px; }
.filter-chip .clear { text-decoration: none; border-left: 1px solid var(--line-2); padding-left: var(--s1); }
.dsum-block { display: flex; flex-direction: column; gap: var(--s2); }
.prompt-line { color: var(--cream); font-size: 14px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
.full-prompt summary, .more-charts > summary, .about > summary { cursor: pointer; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--orange); }
.full-prompt .prompt { margin-top: var(--s1); }
.dsum { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); gap: var(--s2); }
.dstat { border: 1px solid var(--line); border-top: 4px solid var(--line-2); background: var(--page); padding: var(--s1) var(--s2); min-width: 0; }
.dstat.big { border-top-color: var(--orange); }
.dstat .v { color: var(--cream); font-size: 18px; line-height: 1.3; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dstat.big .v { font-size: 32px; line-height: 1.1; }
.dstat .k { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-top: 4px; }
.dstat .tag { font-size: 13px; }
.est-label { font-size: 12px; color: var(--muted); margin-left: 4px; }
.dstat.big .est-label { font-size: 13px; }
.partial { font-size: 12px; color: var(--muted); margin-left: var(--s1); border-bottom: 1px dotted var(--muted); vertical-align: middle; }
.dstat.big .partial { font-size: 13px; }
.dmeta { font-size: 12px; color: var(--muted); }
.table-scroll { overflow-x: auto; }
.dtable { width: 100%; border-collapse: collapse; font-size: 13px; }
.dtable th { text-align: left; font-weight: normal; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); padding: var(--s1); border-bottom: 1px solid var(--line-2); white-space: nowrap; }
.dtable td { padding: var(--s1); border-bottom: 1px solid var(--line); vertical-align: middle; }
.dtable .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dtable td.task { min-width: 12em; }
.dtable .tname { color: var(--cream); margin-bottom: 4px; }
.dtable tr.planning td { background: #100e0d; color: var(--muted); }
.dtable tr.totals td { border-top: 2px solid var(--line-2); border-bottom: 0; color: var(--cream); font-size: 14px; }
.dtable tbody tr:hover td { background: var(--raised); }
.muted-val { color: var(--muted); }
.more-charts > .grid { margin-top: var(--s2); }
.about { font-size: 12px; color: var(--muted); }
.about ul { margin: var(--s1) 0 0; padding-left: var(--s2); }
.about li { margin: 4px 0; }
@media (max-width: 760px) {
  .dsum { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dsum .dstat.big, .dsum .dstat:nth-child(2) { grid-column: 1 / -1; }
  .dtable tr.totals .partial { display: block; margin-left: 0; border-bottom: 0; }
  .dtable { font-size: 12px; }
  .dtable td.task { min-width: 0; }
  .dtable thead, .dtable tbody, .dtable tfoot { display: block; }
  .dtable tr { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
  .dtable td, .dtable th { border-bottom: 0; }
  .dtable td.task, .dtable td.who, .dtable td[colspan] { grid-column: 1 / -1; }
  .dtable th:nth-child(1), .dtable th:nth-child(2), .dtable td.empty { display: none; }
  .dtable tr.totals td { border-top: 0; }
  .dtable tfoot tr { border-top: 2px solid var(--line-2); border-bottom: 0; }
  .block { grid-column: 1 / -1; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pgrid { --c: 16px; }
  .pgrid.z-hour { --c: 10px; }
  .sub-grid { grid-template-columns: minmax(0, 1fr); }
  a.prompt-row { grid-template-columns: minmax(0, 1fr); }
  .prompt-when { flex-direction: row; flex-wrap: wrap; }
  .prompt-stats { text-align: left; }
  .task-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .task-row .r { text-align: left; }
  .row, .row.long { grid-template-columns: minmax(0, 9em) minmax(0, 1fr) minmax(0, 7em); }
}

/* Prompt box (ADR-038): pixel buttons with a hard "stud" shadow, square inputs, focus mode. */
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.top, .tabs { transition: opacity 0.2s; }
body.focus .tabs, body.focus .meta { opacity: 0; pointer-events: none; }
body.focus .tabs { height: 0; overflow: hidden; margin-bottom: 0; border-bottom: 0; }
.compose { max-width: 760px; margin: 12vh auto 0; display: flex; flex-direction: column; gap: var(--s2); }
body.working .compose { margin-top: var(--s2); }
.cmp-form { display: flex; flex-direction: column; gap: var(--s1); }
.cmp-form textarea { font: inherit; font-size: 14px; color: var(--cream); background: var(--block); border: 1px solid var(--muted); border-radius: 0; padding: var(--s2); min-height: 96px; max-height: 50vh; width: 100%; resize: vertical; line-height: 1.5; box-shadow: 0 4px 0 0 var(--line); }
.cmp-form textarea::placeholder { color: var(--muted); }
.cmp-form textarea:focus { outline: 2px solid var(--cream); outline-offset: 2px; border-color: var(--orange); }
.cmp-form textarea:disabled { color: var(--muted); border-color: var(--line-2); cursor: not-allowed; }
.cmp-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); margin-top: var(--s1); }
.cmp-select { font: inherit; font-size: 12px; color: var(--cream); background: var(--page); border: 1px solid var(--muted); border-radius: 0; min-height: 40px; padding: 0 var(--s1); max-width: 18em; }
.cmp-select:focus-visible, .btn:focus-visible { outline: 2px solid var(--cream); outline-offset: 3px; }
.cmp-labels { flex: 1 1 14em; min-width: 0; font-size: 12px; line-height: 1.5; color: var(--muted); }
.cmp-labels b { color: var(--text); font-weight: normal; }
.cmp-why { margin: 0; min-height: 1.45em; font-size: 12px; color: var(--muted); }
.cmp-why.error { color: var(--error); }
.btn { font: inherit; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; min-height: 40px; padding: 0 var(--s3); border: 1px solid var(--line-2); background: var(--block); color: var(--cream); border-radius: 0; cursor: pointer; display: inline-flex; align-items: center; gap: var(--s1); box-shadow: 0 4px 0 0 var(--line); text-decoration: none; }
.btn:active { transform: translateY(2px); box-shadow: 0 2px 0 0 var(--line); }
.btn.primary { background: var(--orange); border-color: var(--orange); color: var(--page); box-shadow: 0 4px 0 0 var(--orange-dark); }
.btn.danger { border-color: var(--error); color: var(--error); box-shadow: 0 4px 0 0 #5a1a10; }
.btn.small { min-height: 28px; padding: 0 var(--s1); font-size: 11px; box-shadow: 0 2px 0 0 var(--line); }
.btn[disabled], .btn[aria-disabled="true"] { background: var(--block); border-color: var(--line); color: var(--muted); box-shadow: none; cursor: not-allowed; transform: none; }
.btn kbd { font: inherit; font-size: 11px; border: 1px solid currentColor; padding: 0 4px; opacity: 0.7; }
.cmp-setup { font-size: 12px; color: var(--muted); }
.cmp-setup summary { cursor: pointer; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.cmp-setup ul { list-style: none; margin: var(--s1) 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.cmp-setup code, .cmp-off code { color: var(--cream); background: var(--page); border: 1px solid var(--line); padding: 1px 6px; }
.pill { font-size: 11px; padding: 0 6px; border: 1px solid; margin-left: var(--s1); }
.pill.set { color: var(--orange); border-color: var(--orange-dark); }
.pill.missing { color: var(--error); border-color: var(--error); }
.pill.none-needed { color: var(--muted); border-color: var(--line-2); }
.cmp-off { display: flex; flex-direction: column; gap: var(--s1); padding: var(--s2); border: 1px solid var(--line); border-left: 8px solid var(--line-2); background: var(--block); color: var(--cream); font-size: 12px; }
.cmp-off.err { border-left-color: var(--error); }
.cmp-live { display: flex; flex-direction: column; gap: var(--s2); border: 1px solid var(--line); border-left: 8px solid var(--orange); background: var(--block); padding: var(--s2); }
.cmp-live.done { border-left-color: var(--orange-dark); }
.cmp-live.failed { border-left-color: var(--error); }
.cmp-live.cancelled { border-left-color: var(--line-2); }
.cmp-quote { color: var(--cream); font-size: 14px; white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.cmp-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); }
.cmp-head .what { flex: 1 1 16em; color: var(--cream); font-size: 12px; }
.cmp-head .what small { display: block; color: var(--muted); }
.cmp-cost { text-align: right; }
.cmp-cost .v { color: var(--cream); font-size: 22px; line-height: 1.1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cmp-cost .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.blocks { display: inline-grid; grid-template-columns: repeat(8, 8px); gap: 2px; flex: none; }
.blocks i { width: 8px; height: 8px; background: var(--line-2); display: block; }
.blocks i.on { background: var(--orange); }
.blocks.live i.next { animation: blink 1s steps(2, start) infinite; background: var(--orange-dark); }
@keyframes blink { to { visibility: hidden; } }
@media (prefers-reduced-motion: reduce) { .blocks.live i.next { animation: none; } .top, .tabs { transition: none; } }
.cmp-tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.cmp-tasks li { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 11em) auto 8.5em; gap: var(--s1) var(--s2); align-items: center; padding: 6px 0; border-top: 1px solid var(--line); font-size: 12px; }
.cmp-tasks li.plan { color: var(--muted); }
.cmp-tasks .t { color: var(--cream); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmp-tasks li.plan .t { color: var(--muted); }
.cmp-tasks .c { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cmp-tasks .s { display: flex; align-items: center; gap: 4px; justify-content: flex-start; min-width: 0; }
.tag.state-running, .tag.state-planning { color: var(--cream); border-color: var(--cream); }
.tag.state-cancelled, .tag.state-skipped { color: var(--muted); border-style: dashed; }
.tag.state-pending, .tag.state-queued { color: var(--muted); }
.taskstop { font: inherit; font-size: 11px; background: none; padding: 0 6px; border: 1px solid var(--line-2); color: var(--muted); cursor: pointer; }
.taskstop:hover { color: var(--error); border-color: var(--error); }
.cmp-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s1) var(--s2); font-size: 12px; color: var(--muted); }
.cmp-foot .acts { display: flex; gap: var(--s1); align-items: center; }
.gate { max-width: 640px; margin: 10vh auto 0; }
.gate h2 { color: var(--cream); }
@media (max-width: 760px) {
  .compose { margin-top: var(--s3); }
  .cmp-bar { flex-direction: column; align-items: stretch; }
  .cmp-select { max-width: none; }
  .cmp-bar .btn { justify-content: center; }
  .cmp-tasks li { grid-template-columns: minmax(0, 1fr) auto; }
  .cmp-tasks .m { grid-column: 1 / -1; grid-row: 2; }
}
`;

export const APP_JS = String.raw`'use strict';
const $ = (id) => document.getElementById(id);
const usd = (v) => (v === null || v === undefined ? 'unknown' : '$' + v.toFixed(6));
const pct = (v) => (v === null ? 'n/a' : (v * 100).toFixed(0) + '%');
const short = (m) => (m === null ? 'no model' : m.split('/').pop());
const DASH = '—';
let timer = null;
let lastOverview = null;
let lastRunId = null;

// ---- Pure helpers (tested in ui.test.ts) -------------------------------------------------

// Hash route: '' | '#' | '#/' → the prompt box; '#/overview' → overview; '#/history' → list;
// '#/history/<runId>' → detail. Old '#/prompts' and '#/prompts/<runId>' links still open the
// same views. An old-style '#<runId>' link still opens that prompt, and an old
// '#/?zoom=hour' overview link still opens the overview. Anything else is the prompt box.
function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const qi = raw.indexOf('?');
  const h = qi === -1 ? raw : raw.slice(0, qi);
  const q = parseQuery(qi === -1 ? '' : raw.slice(qi + 1));
  const zoomed = q.zoom === 'hour' || q.zoom === 'day';
  if (h === '' || h === '/') return zoomed ? { view: 'overview', zoom: q.zoom } : { view: 'compose' };
  if (h === '/overview' || h === '/overview/') return zoomed ? { view: 'overview', zoom: q.zoom } : { view: 'overview' };
  const m = /^\/(?:history|prompts)\/?(.*)$/.exec(h);
  if (m) {
    const rest = m[1].replace(/\/+$/, '');
    if (rest === '') {
      const f = Date.parse(q.from), t = Date.parse(q.to);
      if (!Number.isNaN(f) && !Number.isNaN(t) && f < t) return { view: 'prompts', filter: { from: new Date(f).toISOString(), to: new Date(t).toISOString() } };
      return { view: 'prompts' };
    }
    let id = rest;
    try { id = decodeURIComponent(rest); } catch (e) { id = rest; }
    return { view: 'prompt', runId: id };
  }
  if (h.charAt(0) !== '/') {
    try { return { view: 'prompt', runId: decodeURIComponent(h) }; } catch (e) { return { view: 'prompt', runId: h }; }
  }
  return { view: 'compose' };
}
const promptHref = (runId) => '#/history/' + encodeURIComponent(runId);

// Keep a tag short; the full string goes in its title.
function truncate(s, max) {
  const t = String(s === null || s === undefined ? '' : s);
  return t.length <= max ? t : t.slice(0, Math.max(max - 1, 1)) + '…';
}

// Local date and time ("Nov 12, 10:41 PM"); locale and zone only for tests. Bad input → null.
function fmtDate(iso, locale, timeZone) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (timeZone) opts.timeZone = timeZone;
  return new Date(ms).toLocaleString(locale, opts);
}
const fmtInt = (n) => (n === null || n === undefined ? DASH : Number(n).toLocaleString('en-US'));

// One model → style map for the canvas, every chart and the prompt detail. Order is the
// models' names sorted by code point, so the same set always gets the same styles.
const MODEL_COLORS = ['#ff7a1a', '#e8dcc8', '#4fc3b5', '#7aa7ff', '#c79bff', '#b5d957', '#ff6f91', '#ffd166'];
const MODEL_PATTERNS = ['solid', 'hatch', 'dots', 'checker', 'hstripe', 'vstripe'];
const NO_MODEL_STYLE = { color: '#5a524b', pattern: 'solid', index: -1 };
const isNoModel = (m) => m === null || m === undefined || m === '' || m === '(no model)' || m === '(model unknown)';
const styleAt = (i) => ({ color: MODEL_COLORS[i % MODEL_COLORS.length], pattern: MODEL_PATTERNS[i % MODEL_PATTERNS.length], index: i });
function buildModelStyles(names) {
  const uniq = [];
  for (const n of names) if (!isNoModel(n) && uniq.indexOf(n) === -1) uniq.push(n);
  uniq.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const map = {};
  uniq.forEach((n, i) => { map[n] = styleAt(i); });
  return map;
}
let MODEL_STYLES = {};
function useModels(names) {
  MODEL_STYLES = buildModelStyles(names);
}
// A model outside the known set (should not happen: the set is every recorded model) gets a
// style from a fixed string hash, so it is still stable.
function modelStyle(name) {
  if (isNoModel(name)) return NO_MODEL_STYLE;
  if (MODEL_STYLES[name]) return MODEL_STYLES[name];
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h * 33) ^ name.charCodeAt(i)) >>> 0;
  return styleAt(h % (MODEL_COLORS.length * MODEL_PATTERNS.length));
}

// ---- DOM pieces ---------------------------------------------------------------------------

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}

function block(title, lines, wide) {
  const s = section(title, wide);
  s.append(el('pre', '', lines.length > 0 ? lines.join('\n') : '(none)'));
  return s;
}

function section(title, wide) {
  const s = el('section', 'block' + (wide ? ' wide' : ''));
  s.append(el('h2', '', title));
  return s;
}

function swatch(model) {
  const st = modelStyle(model);
  const s = el('span', 'sw' + (st.pattern === 'solid' ? '' : ' pat-' + st.pattern));
  s.style.backgroundColor = st.color;
  s.title = (isNoModel(model) ? 'no model' : model) + ' · ' + st.pattern;
  return s;
}

// Swatch + model name, for every place a model appears.
function modelLabel(model, text) {
  const w = el('span', 'model');
  w.append(swatch(model), el('span', '', text === undefined ? (isNoModel(model) ? 'no model' : model) : text));
  w.title = isNoModel(model) ? 'no model' : model;
  return w;
}

function tag(text, max, cls) {
  const t = el('span', 'tag' + (cls ? ' ' + cls : ''), truncate(text, max || 28));
  t.title = String(text);
  return t;
}
const stateTag = (state) => tag(state, 16, 'state state-' + state);

function timeEl(iso) {
  const shown = fmtDate(iso);
  const t = el('time', '', shown || 'date unknown');
  if (shown) { t.dateTime = iso; t.title = iso; }
  return t;
}

// One horizontal bar chart. kind 'est' (hatched) or 'act' (solid) never share a chart.
// A null value is written as "unknown", never drawn as a zero bar. A row with a model
// key gets that model's swatch beside its label.
function chart(title, kind, rows, fmt) {
  const c = el('div', 'chart');
  c.append(el('h3', '', title));
  const known = rows.map((r) => r.value).filter((v) => v !== null);
  const max = known.length > 0 ? Math.max(...known) : 0;
  if (rows.length === 0) c.append(el('div', 'unknown', '(no data)'));
  for (const r of rows) {
    const row = el('div', 'row');
    const label = el('span', 'label');
    if ('model' in r) label.append(swatch(r.model));
    label.append(el('span', '', r.label));
    row.append(label);
    const track = el('div', 'track');
    if (r.value === null) {
      row.append(el('span', 'unknown', 'unknown'));
    } else {
      const bar = el('div', 'bar ' + kind);
      bar.style.width = (max > 0 ? (r.value / max) * 100 : 0) + '%';
      track.append(bar);
      row.append(track);
    }
    row.append(el('span', 'value' + (r.value === null ? ' unknown' : ''), r.value === null ? r.why : fmt(r.value)));
    row.title = r.label;
    c.append(row);
  }
  return c;
}

const tokensOf = (side) => (side.inputTokens === null || side.outputTokens === null ? null : side.inputTokens + side.outputTokens);
const tok = (v) => fmtInt(v) + ' tok';

// Slice colours: actuals in the orange family, estimates in the cream family, outcomes by kind.
// Usage-by-model donuts use the model styles instead, so a model looks the same everywhere.
const ACT_SHADES = ['#ff7a1a', '#c25510', '#ffa25c', '#8a3a08', '#ffc79a'];
const EST_SHADES = ['#e8dcc8', '#b8ab96', '#8c8278', '#f5efe4', '#6e665c'];
const OUTCOME_COLORS = { succeeded: '#ff7a1a', failed: '#ff4d2e', cancelled: '#8c8278', skipped: '#b8ab96', unfinished: '#3a3430' };
const CELL = 8;
const FLOW_MAX = 8;

// slices: { label, value, color } or { label, value, model } (model style: colour + pattern).
function donut(title, slices, fmt) {
  const c = el('div', 'chart share-chart');
  c.append(el('h3', '', title));
  const shown = slices.filter((x) => x.value > 0);
  const total = shown.reduce((n, x) => n + x.value, 0);
  if (total === 0) {
    c.append(el('div', 'unknown', '(nothing to show)'));
    return c;
  }
  const paint = (node, x) => {
    if ('model' in x) {
      const st = modelStyle(x.model);
      if (st.pattern !== 'solid') node.className += ' pat-' + st.pattern;
      node.style.backgroundColor = st.color;
    } else {
      node.style.background = x.color;
    }
  };
  const wrap = el('div', 'share');
  const grid = el('div', 'donut');
  const N = 11, mid = (N - 1) / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - mid, dy = y - mid, d = Math.sqrt(dx * dx + dy * dy);
      const cell = el('div', 'px');
      if (d <= mid + 0.4 && d >= mid - 2.6) {
        const turn = ((Math.atan2(dx, -dy) / (2 * Math.PI)) + 1) % 1;
        let acc = 0, k = shown.length - 1;
        for (let i = 0; i < shown.length; i++) {
          acc += shown[i].value / total;
          if (turn < acc) { k = i; break; }
        }
        cell.className = 'px k-' + k;
        paint(cell, shown[k]);
      }
      grid.append(cell);
    }
  }
  const legend = el('div', 'legend');
  for (const x of shown) {
    const item = el('div', 'item');
    const sw = el('span', 'sw');
    paint(sw, x);
    item.append(sw, el('span', '', x.label + ' ' + fmt(x.value) + ' (' + Math.round((x.value / total) * 100) + '%)'));
    legend.append(item);
  }
  wrap.append(grid, legend);
  c.append(wrap);
  return c;
}

function meter(title, rate) {
  const c = el('div', 'chart');
  c.append(el('h3', '', title));
  const row = el('div', 'row');
  row.append(el('span', 'label', title));
  if (rate === null) {
    row.append(el('span', 'unknown', 'n/a'), el('span', 'value unknown', 'n/a (no task finished)'));
  } else {
    const track = el('div', 'track');
    const bar = el('div', 'bar act');
    bar.style.width = rate * 100 + '%';
    track.append(bar);
    row.append(track, el('span', 'value', pct(rate)));
  }
  c.append(row);
  return c;
}

function stacked(title, kind, parts, fmt, why, model) {
  const c = el('div', 'chart');
  const h = el('h3', '');
  if (model !== undefined) h.append(modelLabel(model, title)); else h.textContent = title;
  c.append(h);
  const row = el('div', 'row long');
  row.append(el('span', 'label', parts.map((p) => p.label).join(' / ')));
  const known = parts.every((p) => p.value !== null);
  const total = known ? parts.reduce((n, p) => n + p.value, 0) : null;
  if (total === null) {
    row.append(el('span', 'unknown', 'unknown'), el('span', 'value unknown', why));
  } else {
    const track = el('div', 'track');
    parts.forEach((p, i) => {
      const seg = el('div', 'bar ' + kind + (i > 0 ? '-2' : ''));
      seg.style.width = (total > 0 ? (p.value / total) * 100 : 0) + '%';
      seg.title = p.label + ' ' + fmt(p.value);
      track.append(seg);
    });
    row.append(track, el('span', 'value', parts.map((p) => fmt(p.value)).join(' / ')));
  }
  c.append(row);
  return c;
}

// rows: UsageRow[]; opts.byModel → rows are models (swatches, model-styled share donuts).
function usageBlock(title, rows, note, opts) {
  const byModel = !!(opts && opts.byModel);
  const s = section(title, true);
  if (rows.length === 0) {
    s.append(el('pre', 'unknown', note));
    return s;
  }
  const pick = (f, why) => rows.map((r) => {
    const row = { label: r.label + ' (' + r.attempts + 'x)', value: f(r), why: why(r) };
    if (byModel) row.model = r.label;
    return row;
  });
  const grid = el('div', 'sub-grid');
  grid.append(
    chart('estimated USD (router, not spent)', 'est', pick((r) => r.estimated.usd, () => 'unpriced'), usd),
    chart('actual USD (reported by the runner)', 'act', pick((r) => r.actual.usd, () => 'unknown'), usd),
    chart('estimated tokens (planner)', 'est', pick((r) => tokensOf(r.estimated), () => 'unknown'), tok),
    chart('actual tokens (reported)', 'act', pick((r) => tokensOf(r.actual), () => 'not reported'), tok),
  );
  s.append(grid);
  const pair = el('div', 'pair');
  const share = (t, side, shades) => {
    const unknown = rows.filter((r) => r[side].usd === null).length;
    if (unknown > 0) {
      const c = el('div', 'chart share-chart');
      c.append(el('h3', '', t), el('div', 'unknown', 'unknown (' + unknown + ' of ' + rows.length + ' without a known amount)'));
      return c;
    }
    return donut(t, rows.map((r, i) => (byModel ? { label: r.label, value: r[side].usd, model: r.label } : { label: r.label, value: r[side].usd, color: shades[i % shades.length] })), usd);
  };
  pair.append(share('estimated USD share', 'estimated', EST_SHADES), share('actual USD share', 'actual', ACT_SHADES));
  s.append(pair);
  const n = (v) => (v === null ? 'unknown' : String(v));
  s.append(el('pre', 'note', rows.map((r) => r.label + ': ' + r.attempts + ' attempt(s) · estimated ' + n(r.estimated.inputTokens) + ' in / ' + n(r.estimated.outputTokens) + ' out, ' + usd(r.estimated.usd) + ' · actual ' + n(r.actual.inputTokens) + ' in / ' + n(r.actual.outputTokens) + ' out, ' + usd(r.actual.usd)).join('\n')));
  return s;
}

function outcomesBlock(r, title) {
  const o = r.outcomes;
  const s = section(title || 'Success and failure', false);
  s.append(donut('task outcomes (' + r.taskCount + ' tasks)', ['succeeded', 'failed', 'cancelled', 'skipped', 'unfinished'].map((k) => ({ label: k, value: o[k], color: OUTCOME_COLORS[k] })), String));
  s.append(meter('success rate', o.successRate));
  s.append(el('pre', 'note', 'succeeded ' + o.succeeded + ' · failed ' + o.failed + ' · cancelled ' + o.cancelled + ' · skipped ' + o.skipped + ' · unfinished ' + o.unfinished + '\nsuccess rate ' + pct(o.successRate) + ' · failure rate ' + pct(o.failureRate) + ' · soot-verified complete ' + o.complete + '/' + r.taskCount));
  return s;
}

function perModelTokens(s, rows) {
  for (const row of rows) {
    s.append(stacked(
      short(row.label) + ' reported in / out',
      'act',
      [{ label: 'in', value: row.actual.inputTokens }, { label: 'out', value: row.actual.outputTokens }],
      tok,
      'not reported',
      row.label,
    ));
  }
}

function tokensBlock(r) {
  const s = section('Token usage', false);
  const e = r.tokens.estimated, a = r.tokens.actual;
  s.append(stacked('planned (planner estimate)', 'est', [{ label: 'in', value: e ? e.inputTokens : null }, { label: 'out', value: e ? e.outputTokens : null }], tok, 'no plan data'));
  s.append(stacked('reported (runner usage)', 'act', [{ label: 'in', value: a ? a.inputTokens : null }, { label: 'out', value: a ? a.outputTokens : null }], tok, 'not reported'));
  if (a && a.unreportedAttempts > 0) s.append(el('div', 'unknown', a.unreportedAttempts + ' attempt(s) reported nothing (not in the reported bar)'));
  perModelTokens(s, r.usage.byModel);
  return s;
}

function costBlock(r) {
  const s = section('Cost', false);
  s.append(chart('estimates (not spent)', 'est', [
    { label: 'planner', value: r.cost.estimatedUsd, why: 'unpriced' },
    { label: 'router', value: r.cost.routedEstimateUsd, why: 'unpriced' },
  ], usd));
  s.append(chart('actual (reported)', 'act', [
    { label: 'reported', value: r.cost.actualUsd, why: r.cost.unpricedAttempts ? r.cost.unpricedAttempts + ' unpriced attempt(s)' : 'unknown' },
  ], usd));
  s.append(el('pre', 'note', 'Estimates are never shown as actuals. Mock runs report fictional amounts.'));
  return s;
}

function timelineBlock(r) {
  const s = section('Duration (attempt timeline)', true);
  const t0 = r.duration.startedAt ? Date.parse(r.duration.startedAt) : NaN;
  const attempts = r.tasks.flatMap((t) => t.attempts.map((a) => ({ t, a, start: a.startedAt ? Date.parse(a.startedAt) : NaN, end: a.finishedAt ? Date.parse(a.finishedAt) : NaN })));
  const times = attempts.flatMap((x) => [x.start, x.end]).filter((v) => !Number.isNaN(v));
  const base = Number.isNaN(t0) ? (times.length ? Math.min(...times) : NaN) : t0;
  const last = times.length ? Math.max(...times, base) : base;
  const span = last - base;
  const pos = (v) => (span > 0 ? ((v - base) / span) * 100 : 0);
  const total = el('div', 'row');
  total.append(el('span', 'label', 'run total'));
  if (r.duration.ms === null) {
    total.append(el('span', 'unknown', r.running ? 'running' : 'unknown'), el('span', 'value unknown', r.running ? 'still running' : 'end unknown'));
  } else {
    const track = el('div', 'track');
    const bar = el('div', 'bar act');
    bar.style.width = '100%';
    track.append(bar);
    total.append(track, el('span', 'value', (r.duration.ms / 1000).toFixed(1) + ' s'));
  }
  s.append(total);
  if (attempts.length === 0) s.append(el('div', 'unknown', 'no attempts yet'));
  for (const x of attempts) {
    const row = el('div', 'row');
    const label = el('span', 'label');
    label.append(swatch(x.a.model), el('span', '', x.t.id + ' #' + x.a.attempt + ' ' + short(x.a.model)));
    label.title = x.t.id + ' #' + x.a.attempt + ' ' + (x.a.model || 'no model');
    row.append(label);
    if (Number.isNaN(x.start) || Number.isNaN(base)) {
      row.append(el('span', 'unknown', 'not started'), el('span', 'value unknown', 'start unknown'));
    } else if (Number.isNaN(x.end)) {
      const track = el('div', 'track');
      const tick = el('div', 'tick');
      tick.style.left = pos(x.start) + '%';
      track.append(tick);
      row.append(track, el('span', 'value unknown', x.a.state === 'running' ? 'running (no end yet)' : 'end unknown'));
    } else {
      const track = el('div', 'track');
      const bar = el('div', 'bar span ' + (x.a.state === 'succeeded' ? 'act' : 'cnt'));
      bar.style.left = pos(x.start) + '%';
      bar.style.width = Math.max(pos(x.end) - pos(x.start), 0.5) + '%';
      track.append(bar);
      const value = el('span', 'value', ((x.end - x.start) / 1000).toFixed(1) + ' s ' + x.a.state + (x.a.why ? ' · ' + x.a.why : ''));
      if (x.a.why) value.title = x.a.why;
      row.append(track, value);
    }
    s.append(row);
  }
  s.append(el('div', 'note', 'Wall clock from saved timestamps; ' + r.duration.basis + '.'));
  return s;
}

const statusKind = (st) => (st === 'passed' ? 'pass' : st === 'failed' ? 'fail' : 'other');

// counts: { status: n } or null when none were recorded.
function statusCountBar(title, counts) {
  const c = el('div', 'chart');
  c.append(el('h3', '', title));
  const row = el('div', 'row');
  if (counts === null) {
    row.append(el('span', 'label', ''), el('span', 'unknown', 'none recorded'), el('span', 'value unknown', 'n/a'));
    c.append(row);
    return c;
  }
  const keys = Object.keys(counts).sort();
  const n = keys.reduce((m, k) => m + counts[k], 0);
  row.append(el('span', 'label', n + ' check(s)'));
  if (n === 0) {
    row.append(el('span', 'unknown', 'none'), el('span', 'value', '0'));
  } else {
    const track = el('div', 'track');
    for (const k of keys) {
      const seg = el('div', 'bar ' + statusKind(k));
      seg.style.width = (counts[k] / n) * 100 + '%';
      seg.title = k + ' ' + counts[k];
      track.append(seg);
    }
    row.append(track, el('span', 'value', keys.map((k) => k + ' ' + counts[k]).join(' · ')));
  }
  c.append(row);
  return c;
}

function countStatuses(checks) {
  if (checks === null) return null;
  const counts = {};
  for (const ch of checks) counts[ch.status] = (counts[ch.status] || 0) + 1;
  return counts;
}
const statusBar = (title, checks) => statusCountBar(title, countStatuses(checks));

function validationBlock(r) {
  const s = section('Validation', false);
  s.append(el('pre', '', 'report: ' + (r.validation.reportStatus || 'no report yet')));
  s.append(statusBar('task checks (soot-run)', r.tasks.flatMap((t) => t.checks)));
  s.append(statusBar('final validation', r.validation.final));
  const lines = [
    ...r.tasks.flatMap((t) => t.checks.map((c) => t.id + ' · ' + c.kind + ' ' + c.name + ': ' + c.status + (c.exitCode === null ? '' : ' (exit ' + c.exitCode + ')'))),
    ...(r.validation.final === null ? ['final validation: none recorded'] : r.validation.final.map((c) => 'final · ' + c.kind + ' ' + c.name + ': ' + c.status + (c.required ? ' (required)' : ''))),
    ...r.validation.problems.map((p) => 'problem: ' + p),
  ];
  s.append(el('pre', 'note', lines.join('\n')));
  return s;
}

function transitionsBlock(r) {
  const s = section('Model transitions', false);
  const counts = {};
  for (const e of r.transitions) counts[e.type] = (counts[e.type] || 0) + 1;
  if (r.transitions.length > 0) s.append(chart('count by type', 'cnt', Object.keys(counts).sort().map((k) => ({ label: k, value: counts[k], why: '' })), String));
  s.append(el('pre', 'note', r.transitions.length > 0 ? r.transitions.map((e) => e.type.toUpperCase() + ' ' + e.taskId + ' #' + e.attempt + ' → ' + (e.model || '-') + ': ' + e.reason).join('\n') : '(none)'));
  return s;
}

function assignmentBlock(r) {
  const a = r.assignment;
  const s = section('Assignment: prompt → tasks → models', true);
  s.append(el('div', 'prompt', a.prompt));
  const split = el('div', 'split tags');
  split.append(el('span', '', '│ split by the planner into ' + a.tasks.length + ' task(s); runner:'), r.agent.label ? tag(r.agent.label, 32) : el('span', 'unknown', 'unknown (no saved report yet)'));
  s.append(split);
  for (const ids of r.graph.layers) {
    const layer = el('div', 'layer');
    for (const id of ids) {
      const t = a.tasks.find((x) => x.id === id);
      if (!t) continue;
      const card = el('div', 'card');
      card.append(el('div', 't', '■ ' + t.id + (t.dependsOn.length > 0 ? '  ← ' + t.dependsOn.join(', ') : '')));
      card.append(el('div', '', t.title));
      if (t.instructions) card.append(el('div', 'note', t.instructions.length > 240 ? t.instructions.slice(0, 237) + '...' : t.instructions));
      const chips = el('div', 'chips');
      if (t.attempts.length === 0) chips.append(el('span', 'unknown', 'not started'));
      t.attempts.forEach((x, i) => {
        if (i > 0) chips.append(el('span', 'via', '⇒ ' + (x.via || '?').toUpperCase()));
        const chip = el('span', 'chip');
        chip.append(swatch(x.routedModel), el('span', '', '#' + x.attempt + ' ' + (x.routedModel || 'no model') + ' [' + x.state + ']'));
        chip.title = (x.reason || '') + (x.reportedModel && x.reportedModel !== x.routedModel ? ' · runner reported ' + x.reportedModel : '');
        chips.append(chip);
        if (x.reportedModel && x.reportedModel !== x.routedModel) chips.append(el('span', 'unknown', '(ran ' + x.reportedModel + ')'));
      });
      card.append(chips);
      layer.append(card);
    }
    s.append(layer);
  }
  return s;
}

// ---- Overview (aggregates across every prompt; nothing here is about one prompt) -----------

const coverage = (c, of) => c.runs + '/' + of + ' runs';

function tile(label, value, sub, title) {
  const t = el('div', 'tile');
  const n = el('div', 'num', value);
  if (title) n.title = title;
  t.append(n, el('div', 'lbl', label), el('div', 'sub', sub));
  return t;
}

// Only computed values; unknown is an em dash.
function tilesFor(ov) {
  const ag = ov.aggregate;
  const runs = ov.promptCount;
  const out = [
    tile('Prompts', runs > 0 ? fmtInt(runs) : DASH, 'recorded runs'),
    tile('Tasks', runs > 0 ? fmtInt(ov.taskCount) : DASH, 'planned, across all prompts'),
  ];
  const at = ag ? ag.tokens.actual : { value: null, runs: 0 };
  if (at.value === null) out.push(tile('Tokens', DASH, 'not reported'));
  else out.push(tile('Tokens', fmtInt(at.value.inputTokens + at.value.outputTokens), 'reported · ' + coverage(at, runs) + (at.value.unreportedAttempts > 0 ? ' · ' + at.value.unreportedAttempts + ' attempt(s) unreported' : '')));
  const ac = ag ? ag.cost.actualUsd : { value: null, runs: 0 };
  const unpriced = ag && ag.cost.unpricedAttempts > 0 ? ' · ' + ag.cost.unpricedAttempts + ' unpriced attempt(s)' : '';
  if (ac.value === null) out.push(tile('Cost', DASH, 'actual not reported' + unpriced));
  else out.push(tile('Cost', '$' + ac.value.toFixed(4), 'reported actual · ' + coverage(ac, runs) + unpriced, usd(ac.value)));
  return out;
}

function aggCostBlock(ov) {
  const c = ov.aggregate.cost, n = ov.promptCount;
  const s = section('Cost · all prompts', false);
  s.append(chart('estimates (not spent)', 'est', [
    { label: 'planner · ' + coverage(c.estimatedUsd, n), value: c.estimatedUsd.value, why: 'unpriced' },
    { label: 'router · ' + coverage(c.routedEstimateUsd, n), value: c.routedEstimateUsd.value, why: 'unpriced' },
  ], usd));
  s.append(chart('actual (reported)', 'act', [
    { label: 'reported · ' + coverage(c.actualUsd, n), value: c.actualUsd.value, why: c.unpricedAttempts ? c.unpricedAttempts + ' unpriced attempt(s)' : 'unknown' },
  ], usd));
  s.append(el('pre', 'note', 'Sums only what each run reported; the run count says how many runs are in each sum. Estimates are never shown as actuals. Mock runs report fictional amounts.'));
  return s;
}

function aggTokensBlock(ov) {
  const t = ov.aggregate.tokens, n = ov.promptCount;
  const s = section('Token usage · all prompts', false);
  const e = t.estimated.value, a = t.actual.value;
  s.append(stacked('planned (planner estimate) · ' + coverage(t.estimated, n), 'est', [{ label: 'in', value: e ? e.inputTokens : null }, { label: 'out', value: e ? e.outputTokens : null }], tok, 'no plan data'));
  s.append(stacked('reported (runner usage) · ' + coverage(t.actual, n), 'act', [{ label: 'in', value: a ? a.inputTokens : null }, { label: 'out', value: a ? a.outputTokens : null }], tok, 'not reported'));
  if (a && a.unreportedAttempts > 0) s.append(el('div', 'unknown', a.unreportedAttempts + ' attempt(s) reported nothing (not in the reported bar)'));
  perModelTokens(s, ov.aggregate.usageByModel);
  return s;
}

function aggValidationBlock(ov) {
  const v = ov.aggregate.validation;
  const s = section('Validation · all prompts', false);
  s.append(statusCountBar('task checks (soot-run)', v.taskChecks));
  s.append(statusCountBar('final validation · ' + v.runsWithFinal + ' of ' + ov.promptCount + ' run(s) recorded one', v.runsWithFinal === 0 ? null : v.final));
  return s;
}

function aggTransitionsBlock(ov) {
  const t = ov.aggregate.transitions;
  const keys = Object.keys(t).sort();
  const s = section('Model transitions · all prompts', false);
  if (keys.length === 0) s.append(el('pre', 'note', '(none)'));
  else s.append(chart('count by type', 'cnt', keys.map((k) => ({ label: k, value: t[k], why: '' })), String));
  return s;
}

const AGG_BLOCKS = [
  (ov) => usageBlock('Usage by model · all prompts', ov.aggregate.usageByModel, ov.aggregate.usageNote, { byModel: true }),
  (ov) => outcomesBlock({ outcomes: ov.aggregate.outcomes, taskCount: ov.taskCount }, 'Success and failure · all prompts'),
  (ov) => aggCostBlock(ov),
  (ov) => aggTokensBlock(ov),
  (ov) => aggValidationBlock(ov),
  (ov) => aggTransitionsBlock(ov),
  (ov) => usageBlock('Usage by runner (agent/bot) · all prompts', ov.aggregate.usageByAgent, 'Runner unknown until a run has a saved report. Runner is recorded per run, not per task.'),
  (ov) => block('How to read the charts', [ov.aggregate.usageNote, 'Hatched cream = estimate, solid orange = reported actual; they never share a chart or a donut. Each magnitude chart is scaled to its own largest known value. Unknown is written as unknown, with no bar or slice. Each model keeps one colour and one pattern on every view.', ov.aggregate.savingsNote], true),
];

function renderLegend(ov) {
  const lg = $('legend');
  lg.replaceChildren();
  for (const m of ov.byModel) {
    const item = el('div', 'item');
    item.append(modelLabel(m.model), el('span', 'n', m.tasks + ' task(s)'));
    lg.append(item);
  }
}

// ---- Prompt grid (GitHub-contribution style). Pure layout helpers first, then the DOM. ----

const ZOOMS = ['prompt', 'hour', 'day'];
const HOUR = 3600000, DAY = 86400000;
const STACK_CAP = 7;
const MAX_DAYS = 42;
const MIN_DAYS = 28;
const MAX_WEEKS = 26;
const MIN_WEEKS = 12;

// Minutes east of UTC at an instant, in this browser's zone (tests pass a fixed function).
const localOffset = (ms) => -new Date(ms).getTimezoneOffset();
const wallMs = (ms, off) => ms + off(ms) * 60000;
// Turn a local wall-clock time back into an instant (refined once for DST edges).
function fromWall(wall, off) {
  let inst = wall - off(wall) * 60000;
  inst = wall - off(inst) * 60000;
  return inst;
}
const dayIndex = (ms, off) => Math.floor(wallMs(ms, off) / DAY);
// Local [start, end) of the hour or day holding ms.
function localWindow(ms, unit, off) {
  const size = unit === 'hour' ? HOUR : DAY;
  const w = Math.floor(wallMs(ms, off) / size) * size;
  return { from: fromWall(w, off), to: fromWall(w + size, off) };
}
// A local wall-clock label, read back in UTC so the zone is already applied.
const wallLabel = (wall, opts) => new Date(wall).toLocaleString('en-US', Object.assign({ timeZone: 'UTC' }, opts));

function parseQuery(q) {
  const out = {};
  for (const part of String(q || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i === -1 ? part : part.slice(0, i);
    const v = i === -1 ? '' : part.slice(i + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  }
  return out;
}
const promptsWindowHref = (from, to) => '#/history?from=' + encodeURIComponent(new Date(from).toISOString()) + '&to=' + encodeURIComponent(new Date(to).toISOString());

// Prompts whose createdAt is in [from, to). A prompt without a date is never in a window.
function filterPrompts(prompts, filter) {
  if (!filter) return prompts;
  const from = Date.parse(filter.from), to = Date.parse(filter.to);
  return prompts.filter((p) => {
    const t = p.createdAt ? Date.parse(p.createdAt) : NaN;
    return !Number.isNaN(t) && t >= from && t < to;
  });
}

// Bucket activity = sum of the prompts' complexity scores (a missing score counts 0).
// Level within one view: empty → no cell level; 0 activity → 0; else ceil(4 × activity / max).
const activityOf = (list) => list.reduce((n, p) => n + (p.complexity && p.complexity.score !== null ? p.complexity.score : 0), 0);
function scaleLevels(values) {
  const max = values.reduce((m, v) => Math.max(m, v), 0);
  return values.map((v) => (v <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((4 * v) / max - 1e-9)))));
}

function bucketCell(list, w) {
  const tokensKnown = list.filter((p) => p.tokens !== null);
  return {
    kind: list.length === 0 ? 'empty' : 'bucket',
    from: w.from,
    to: w.to,
    prompts: list.length,
    tasks: list.reduce((n, p) => n + p.taskCount, 0),
    tokens: tokensKnown.length === 0 ? null : tokensKnown.reduce((n, p) => n + p.tokens.inputTokens + p.tokens.outputTokens, 0),
    tokensReported: tokensKnown.length,
    activity: Math.round(activityOf(list) * 1000) / 1000,
    level: 0,
    href: list.length === 0 ? null : promptsWindowHref(w.from, w.to),
  };
}

/*
 * The grid model for one zoom. Columns run oldest → newest and end on the later of now and the
 * newest prompt. prompt: a column per local day, up to STACK_CAP prompt squares stacked
 * (oldest at the top), then a +N chip. hour: a column per day, a row per local hour (0–23).
 * day: a column per week (Sunday first), a row per weekday. Undated prompts are left out and
 * counted in 'undated'.
 */
function gridModel(prompts, zoom, now, off) {
  off = off || localOffset;
  const z = ZOOMS.indexOf(zoom) === -1 ? 'prompt' : zoom;
  const dated = prompts.filter((p) => p.createdAt && !Number.isNaN(Date.parse(p.createdAt)));
  const times = dated.map((p) => Date.parse(p.createdAt));
  const endMs = Math.max(now, times.length ? Math.max(...times) : now);
  const endDay = dayIndex(endMs, off);
  const firstDay = times.length ? dayIndex(Math.min(...times), off) : endDay;
  const byDay = {};
  for (const p of dated) {
    const d = dayIndex(Date.parse(p.createdAt), off);
    (byDay[d] = byDay[d] || []).push(p);
  }
  for (const k of Object.keys(byDay)) byDay[k].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const dayWall = (d) => d * DAY;
  const columns = [];
  let rows, rowLabels;
  if (z === 'day') {
    const week = (d) => Math.floor((d + 4) / 7); // day 0 (1970-01-01) was a Thursday
    const endW = week(endDay);
    const startW = Math.min(Math.max(week(firstDay), endW - MAX_WEEKS + 1), endW - MIN_WEEKS + 1);
    rows = 7;
    rowLabels = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
    for (let w = startW; w <= endW; w++) {
      const cells = [];
      let label = '';
      for (let wd = 0; wd < 7; wd++) {
        const d = w * 7 - 4 + wd;
        if (d > endDay) { cells.push({ kind: 'none' }); continue; }
        const wall = dayWall(d);
        if (wallLabel(wall, { day: 'numeric' }) === '1') label = wallLabel(wall, { month: 'short' });
        cells.push(bucketCell(byDay[d] || [], { from: fromWall(wall, off), to: fromWall(wall + DAY, off) }));
      }
      if (w === startW && !label) label = wallLabel(dayWall(w * 7 - 4), { month: 'short' });
      columns.push({ key: 'w' + w, label: label, cells: cells });
    }
  } else {
    const startDay = Math.min(Math.max(firstDay, endDay - MAX_DAYS + 1), endDay - MIN_DAYS + 1);
    rows = z === 'hour' ? 24 : STACK_CAP;
    rowLabels = z === 'hour' ? Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? h + 'h' : '')) : [];
    for (let d = startDay; d <= endDay; d++) {
      const wall = dayWall(d);
      const weekday = (((d + 4) % 7) + 7) % 7;
      const label = d === startDay || weekday === 1 ? wallLabel(wall, { month: 'short', day: 'numeric' }) : '';
      const list = byDay[d] || [];
      const col = { key: 'd' + d, label: label, cells: [], overflow: 0, from: fromWall(wall, off), to: fromWall(wall + DAY, off) };
      if (z === 'prompt') {
        list.slice(0, STACK_CAP).forEach((p) => col.cells.push({ kind: 'prompt', prompt: p, level: p.complexity ? p.complexity.level : 0, href: promptHref(p.runId) }));
        while (col.cells.length < STACK_CAP) col.cells.push({ kind: 'empty' });
        col.overflow = Math.max(0, list.length - STACK_CAP);
        col.overflowHref = promptsWindowHref(col.from, col.to);
      } else {
        for (let h = 0; h < 24; h++) {
          const from = fromWall(wall + h * HOUR, off), to = fromWall(wall + (h + 1) * HOUR, off);
          col.cells.push(bucketCell(list.filter((p) => { const t = Date.parse(p.createdAt); return t >= from && t < to; }), { from: from, to: to }));
        }
      }
      columns.push(col);
    }
  }
  // The first column's label gives way to a nearby one so labels never collide.
  if (columns.length > 1 && columns[0].label && columns.slice(1, 4).some((c) => c.label)) columns[0].label = '';
  if (z !== 'prompt') {
    const buckets = columns.flatMap((c) => c.cells.filter((x) => x.kind === 'bucket'));
    const levels = scaleLevels(buckets.map((b) => b.activity));
    buckets.forEach((b, i) => { b.level = levels[i]; });
  }
  return { zoom: z, rows: rows, rowLabels: rowLabels, columns: columns, total: dated.length, undated: prompts.length - dated.length };
}

const GRID_LEGEND = {
  prompt: 'One square per prompt, by complexity: mean of tasks, planner complexity, dependency depth, reported tokens (log scale) and retries/escalations per task. Fixed 0–1 scale.',
  hour: 'One square per local hour: summed prompt complexity in that hour, scaled to this view (darkest = busiest hour shown).',
  day: 'One square per local day: summed prompt complexity that day, scaled to this view (darkest = busiest day shown).',
};

function fmtWindow(from, to, zoom) {
  const a = new Date(from), b = new Date(to);
  if (zoom === 'day') return a.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return a.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' – ' + b.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function cellLines(cell, zoom) {
  if (cell.kind === 'prompt') {
    const p = cell.prompt, c = p.complexity;
    return [
      truncate(p.prompt, 64),
      fmtDate(p.createdAt) || 'date unknown',
      p.taskCount + ' task(s) · ' + (p.tokens === null ? 'tokens not reported' : fmtInt(p.tokens.inputTokens + p.tokens.outputTokens) + ' tok'),
      'complexity ' + (c && c.score !== null ? c.level + '/4 (score ' + c.score.toFixed(2) + ')' : 'unknown') + (c && c.missing.length ? ' · no ' + c.missing.join(', ') : ''),
    ];
  }
  return [
    fmtWindow(cell.from, cell.to, zoom),
    cell.prompts + ' prompt(s) · ' + cell.tasks + ' task(s) · ' + (cell.tokens === null ? 'tokens not reported' : fmtInt(cell.tokens) + ' tok' + (cell.tokensReported < cell.prompts ? ' (' + cell.tokensReported + ' of ' + cell.prompts + ' reported)' : '')),
    'activity ' + cell.activity.toFixed(2) + ' · level ' + cell.level + '/4, scaled to this view',
  ];
}

function showTip(panel, cell, zoom, target) {
  const tip = panel.tip;
  if (!tip) return;
  tip.textContent = cellLines(cell, zoom).join('\n');
  tip.hidden = false;
  if (target.getBoundingClientRect && panel.getBoundingClientRect) {
    const r = target.getBoundingClientRect(), b = panel.getBoundingClientRect();
    const left = Math.min(Math.max(r.left - b.left - 8, 8), Math.max(b.width - 328, 8));
    tip.style.left = left + 'px';
    tip.style.top = (r.bottom - b.top + 6) + 'px';
  }
}
const hideTip = (panel) => { if (panel.tip) panel.tip.hidden = true; };

function zoomToggle(zoom) {
  const nav = el('div', 'seg');
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'zoom');
  for (const z of ZOOMS) {
    const a = el('a', 'seg-b' + (z === zoom ? ' on' : ''), z.charAt(0).toUpperCase() + z.slice(1));
    a.href = z === 'prompt' ? '#/overview' : '#/overview?zoom=' + z;
    if (z === zoom) a.setAttribute('aria-current', 'true');
    nav.append(a);
  }
  return nav;
}

function rampLegend(zoom) {
  const lg = el('div', 'ramp');
  lg.append(el('span', 'note', 'Less'));
  for (let l = 0; l <= 4; l++) {
    const c = el('span', 'cell l' + l);
    c.title = 'level ' + l;
    lg.append(c);
  }
  lg.append(el('span', 'note', 'More'), el('span', 'cell empty'), el('span', 'note', 'no prompt'));
  const wrap = el('div', 'ramp-wrap');
  wrap.append(lg, el('p', 'note', GRID_LEGEND[zoom]));
  return wrap;
}

function renderGrid(ov, zoom, now, off) {
  const panel = $('pgrid-panel');
  const prompts = ov ? ov.prompts : [];
  const m = gridModel(prompts, zoom, now === undefined ? Date.now() : now, off);
  const head = el('div', 'pgrid-head');
  head.append(el('h2', '', 'Prompts over time · all prompts'), zoomToggle(m.zoom));
  const box = el('div', 'pgrid-scroll');
  const grid = el('div', 'pgrid z-' + m.zoom);
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'prompts over time, ' + m.zoom + ' view');
  const rl = el('div', 'gcol rlabels');
  rl.append(el('span', 'glabel', ''));
  for (let i = 0; i < m.rows; i++) rl.append(el('span', 'rlabel', m.rowLabels[i] || ''));
  grid.append(rl);
  for (const col of m.columns) {
    const c = el('div', 'gcol');
    c.append(el('span', 'glabel', col.label));
    for (const cell of col.cells) {
      if (cell.kind === 'none') { c.append(el('span', 'cell none')); continue; }
      if (cell.kind === 'empty') { c.append(el('span', 'cell empty')); continue; }
      const a = el('a', 'cell l' + cell.level);
      a.href = cell.href;
      a.setAttribute('aria-label', cellLines(cell, m.zoom).join('. '));
      a.dataset.level = String(cell.level);
      const on = () => showTip(panel, cell, m.zoom, a);
      a.addEventListener('mouseenter', on);
      a.addEventListener('focus', on);
      a.addEventListener('mouseleave', () => hideTip(panel));
      a.addEventListener('blur', () => hideTip(panel));
      c.append(a);
    }
    if (col.overflow > 0) {
      const chip = el('a', 'more', '+' + col.overflow);
      chip.href = col.overflowHref;
      chip.setAttribute('aria-label', col.overflow + ' more prompt(s) that day');
      c.append(chip);
    }
    grid.append(c);
  }
  box.append(grid);
  const parts = [head, box];
  if (m.total === 0) parts.push(el('p', 'empty-msg', 'No prompts yet. Run soot run and they will appear here.'));
  parts.push(rampLegend(m.zoom));
  const missing = prompts.filter((p) => p.complexity && p.complexity.missing.length > 0);
  if (missing.length > 0) {
    const counts = {};
    for (const p of missing) for (const k of p.complexity.missing) counts[k] = (counts[k] || 0) + 1;
    parts.push(el('p', 'note', 'Not recorded: ' + Object.keys(counts).sort().map((k) => k + ' for ' + counts[k] + ' prompt(s)').join(', ') + '. Those scores average only the fields that are present.'));
  }
  if (m.undated > 0) parts.push(el('p', 'note', m.undated + ' prompt(s) without a date are not on the grid.'));
  const tip = el('div', 'gtip');
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  panel.tip = tip;
  parts.push(tip);
  panel.replaceChildren(...parts);
  if (box.scrollWidth !== undefined) box.scrollLeft = box.scrollWidth;
  return m;
}

function renderOverview(ov) {
  $('tiles').replaceChildren(...tilesFor(ov));
  renderLegend(ov);
  $('agg').replaceChildren(...(ov.aggregate && ov.promptCount > 0 ? AGG_BLOCKS.map((b) => b(ov)) : []));
}

function snap(v) {
  return Math.round(v / CELL) * CELL;
}

function clipText(ctx, text, max) {
  const raw = String(text);
  if (ctx.measureText(raw).width <= max) return raw;
  let s = raw;
  const ell = '...';
  while (s.length > 0 && ctx.measureText(s + ell).width > max) s = s.slice(0, -1);
  return s + ell;
}

// Is the 4px pixel (i, j) inked for a pattern? Same patterns as the CSS .pat-* swatches.
function patternInk(pattern, i, j) {
  if (pattern === 'hatch') return (i + j) % 3 === 0;
  if (pattern === 'dots') return i % 2 === 0 && j % 2 === 0;
  if (pattern === 'checker') return (i + j) % 2 === 0;
  if (pattern === 'hstripe') return j % 2 === 0;
  if (pattern === 'vstripe') return i % 2 === 0;
  return false;
}

// A model-styled block: its colour, then its pattern in 4px pixels on a page-coloured ink.
function paintModel(ctx, model, x, y, w, h) {
  const st = modelStyle(model);
  ctx.fillStyle = st.color;
  ctx.fillRect(x, y, w, h);
  if (st.pattern === 'solid') return;
  ctx.fillStyle = 'rgba(10, 10, 10, 0.62)';
  const P = 4;
  for (let py = Math.ceil(y / P) * P; py < y + h; py += P) {
    for (let px = Math.ceil(x / P) * P; px < x + w; px += P) {
      if (patternInk(st.pattern, px / P, py / P)) ctx.fillRect(px, py, Math.min(P, x + w - px), Math.min(P, y + h - py));
    }
  }
}

// Pixel flow: prompts on the left, models on the right, 8px-grid pipes between them.
// Prompt strings are drawn with fillText only (never interpreted as HTML).
function drawFlow(canvas, overview) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cssW = Math.max(canvas.clientWidth || 960, 320);
  // Secondary view: the latest FLOW_MAX prompts (newest first), models summed over those.
  const prompts = overview && overview.prompts ? overview.prompts.slice(0, FLOW_MAX) : [];
  const shownIds = {};
  for (const p of prompts) shownIds[p.runId] = true;
  const flows = overview && overview.flows ? overview.flows.filter((f) => shownIds[f.runId]) : [];
  const totals = {};
  for (const f of flows) totals[f.model] = (totals[f.model] || 0) + f.tasks;
  const models = Object.keys(totals).map((m) => ({ model: m, tasks: totals[m] })).sort((a, b) => b.tasks - a.tasks || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  const shownTasks = prompts.reduce((n, p) => n + (p.taskCount || 0), 0);
  const rows = Math.max(prompts.length, models.length, 1);
  const height = Math.max(160, 48 + rows * 24);
  canvas.width = cssW;
  canvas.height = height;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, cssW, height);
  ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';
  if (!overview || overview.promptCount === 0) {
    const bw = 16 * CELL, bh = 6 * CELL;
    const bx = snap((cssW - bw) / 2), by = snap((height - bh) / 2);
    ctx.fillStyle = '#1f1c1a';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#2e2a27';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
    ctx.fillStyle = '#8c8278';
    ctx.textAlign = 'center';
    ctx.fillText('no data', cssW / 2, height / 2);
    ctx.textAlign = 'left';
    return;
  }
  if (overview.taskCount === 0 || models.length === 0) {
    ctx.fillStyle = '#8c8278';
    ctx.textAlign = 'center';
    ctx.fillText('no model assignments yet', cssW / 2, height / 2);
    ctx.textAlign = 'left';
    return;
  }
  const pad = 16;
  const leftW = Math.min(280, Math.floor(cssW * 0.28));
  const rightW = Math.min(220, Math.floor(cssW * 0.24));
  const barW = 3 * CELL;
  const leftBarX = pad + leftW + CELL;
  const midL = leftBarX + barW + CELL;
  const midR = cssW - pad - rightW - barW - CELL;
  const rightBarX = midR + CELL;
  const top = 40;
  const bottom = height - 16;
  const usable = bottom - top;
  ctx.fillStyle = '#8c8278';
  ctx.textAlign = 'left';
  ctx.fillText('PROMPTS', pad, 16);
  ctx.textAlign = 'right';
  ctx.fillText('MODELS  (' + shownTasks + ' tasks, ' + prompts.length + (overview.promptCount > prompts.length ? ' of ' + overview.promptCount : '') + ' prompts)', cssW - pad, 16);
  ctx.textAlign = 'left';
  const stack = (items, weightOf) => {
    const total = items.reduce((n, it) => n + Math.max(weightOf(it), 1), 0);
    let y = top;
    const gap = CELL;
    const inner = usable - gap * Math.max(items.length - 1, 0);
    const out = [];
    for (let i = 0; i < items.length; i++) {
      let h = Math.max(2 * CELL, snap((Math.max(weightOf(items[i]), 1) / total) * inner));
      if (y + h > bottom) h = Math.max(CELL, bottom - y);
      out.push({ item: items[i], y: y, h: h });
      y += h + gap;
    }
    return out;
  };
  const promptWeight = (p) => p.taskCountsByModel.reduce((n, m) => n + m.tasks, 0);
  const pSlots = stack(prompts, promptWeight);
  const mSlots = stack(models, (m) => m.tasks);
  const pUsed = pSlots.map(() => 0);
  const mUsed = mSlots.map(() => 0);
  const pIndex = {};
  const mIndex = {};
  pSlots.forEach((s, i) => { pIndex[s.item.runId] = i; });
  mSlots.forEach((s, i) => { mIndex[s.item.model] = i; });
  for (const flow of flows) {
    const pi = pIndex[flow.runId];
    const mi = mIndex[flow.model];
    if (pi === undefined || mi === undefined) continue;
    const ps = pSlots[pi], ms = mSlots[mi];
    const weight = Math.max(promptWeight(ps.item), 1);
    let thick = Math.max(CELL, snap((flow.tasks / weight) * ps.h));
    thick = Math.min(thick, Math.max(CELL, ps.h - pUsed[pi]), Math.max(CELL, ms.h - mUsed[mi]));
    const y1 = snap(ps.y + pUsed[pi]);
    const y2 = snap(ms.y + mUsed[mi]);
    pUsed[pi] += thick;
    mUsed[mi] += thick;
    const mid = snap((midL + midR) / 2);
    paintModel(ctx, flow.model, snap(leftBarX + barW), y1, Math.max(CELL, snap(mid - (leftBarX + barW))), thick);
    const topY = Math.min(y1, y2);
    paintModel(ctx, flow.model, snap(mid), topY, CELL, Math.max(CELL, Math.max(y1, y2) - topY + thick));
    paintModel(ctx, flow.model, snap(mid), y2, Math.max(CELL, snap(rightBarX - mid)), thick);
  }
  for (const s of pSlots) {
    ctx.fillStyle = '#2e2a27';
    ctx.fillRect(snap(leftBarX), snap(s.y), barW, Math.max(CELL, snap(s.h)));
    ctx.fillStyle = '#e8dcc8';
    ctx.textAlign = 'right';
    ctx.fillText(clipText(ctx, s.item.prompt, leftW - 4), pad + leftW - 4, s.y + s.h / 2);
  }
  for (let i = 0; i < mSlots.length; i++) {
    const s = mSlots[i];
    paintModel(ctx, s.item.model, snap(rightBarX), snap(s.y), barW, Math.max(CELL, snap(s.h)));
    if (i === 0) {
      ctx.fillStyle = '#e8dcc8';
      ctx.fillRect(snap(rightBarX) - 4, snap(s.y), 2, Math.max(CELL, snap(s.h)));
      ctx.fillRect(snap(rightBarX) + barW + 2, snap(s.y), 2, Math.max(CELL, snap(s.h)));
    }
    ctx.fillStyle = i === 0 ? '#ff7a1a' : '#e8dcc8';
    ctx.textAlign = 'left';
    const name = s.item.model.split('/').pop() || s.item.model;
    ctx.fillText(clipText(ctx, name + '  ' + s.item.tasks, rightW - 8), rightBarX + barW + 10, s.y + s.h / 2);
  }
  ctx.textAlign = 'left';
}

// ---- Prompts list ----------------------------------------------------------------------------

function promptRow(p) {
  const a = el('a', 'prompt-row' + (p.runId === lastRunId ? ' current' : ''));
  a.href = promptHref(p.runId);
  a.dataset.run = p.runId;
  if (p.runId === lastRunId) a.setAttribute('aria-current', 'true');
  const when = el('div', 'prompt-when');
  when.append(stateTag(p.state), timeEl(p.createdAt));
  const main = el('div', '');
  main.append(el('div', 'prompt-text', p.prompt));
  const models = el('div', 'prompt-models');
  for (const m of p.taskCountsByModel) {
    const item = el('span', 'item');
    item.append(modelLabel(m.model, short(m.model) + ' ×' + m.tasks));
    models.append(item);
  }
  if (p.agent.label) models.append(tag(p.agent.label, 24));
  main.append(models);
  const stats = el('div', 'prompt-stats');
  const tk = p.tokens === null
    ? 'tokens unknown'
    : fmtInt(p.tokens.inputTokens + p.tokens.outputTokens) + ' tok' + (p.tokens.unreportedAttempts > 0 ? ' (' + p.tokens.unreportedAttempts + ' unreported)' : '');
  const cost = p.cost.actualUsd === null
    ? (p.cost.unpricedAttempts ? p.cost.unpricedAttempts + ' unpriced attempt(s)' : 'cost unknown')
    : usd(p.cost.actualUsd);
  stats.append(el('div', '', tk), el('div', '', cost), el('div', 'sub', p.taskCount + ' task(s)'));
  if (p.tokens !== null) stats.title = p.tokens.inputTokens + ' in / ' + p.tokens.outputTokens + ' out';
  a.append(when, main, stats);
  a.title = p.prompt;
  return a;
}

function renderPrompts(all, filter) {
  const nav = $('prompts');
  nav.replaceChildren();
  const prompts = filterPrompts(all, filter);
  nav.append(el('h2', '', 'History · ' + (filter ? prompts.length + ' of ' + all.length : all.length)));
  if (filter) {
    const chip = el('div', 'filter-chip');
    const from = Date.parse(filter.from), to = Date.parse(filter.to);
    const t = el('span', '', 'Window: ' + fmtWindow(from, to, to - from > 2 * HOUR ? 'day' : 'hour'));
    t.title = filter.from + ' – ' + filter.to;
    const clear = el('a', 'clear', '× clear');
    clear.href = '#/history';
    clear.setAttribute('aria-label', 'clear the time filter');
    chip.append(t, clear);
    nav.append(chip);
  }
  if (all.length === 0) {
    nav.append(el('div', 'unknown', 'No runs in this state directory yet (start one with soot run).'));
    return;
  }
  if (prompts.length === 0) {
    nav.append(el('div', 'unknown', 'No runs in this window.'));
    return;
  }
  const list = el('div', 'prompt-list');
  list.setAttribute('role', 'list');
  const rows = prompts.map(promptRow);
  // Arrow keys move between prompts; Enter opens one (native link).
  list.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const i = rows.indexOf(document.activeElement);
    const next = rows[Math.min(Math.max(i + (ev.key === 'ArrowDown' ? 1 : -1), 0), rows.length - 1)];
    if (next) { ev.preventDefault(); next.focus(); }
  });
  list.append(...rows);
  nav.append(list);
}

// ---- Prompt detail ----------------------------------------------------------------------------

async function getJson(path) {
  const r = await fetch(path, { cache: 'no-store' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.error || String(r.status));
  return j;
}

// ---- Prompt detail: summary, one plain table, then collapsed extras ------------------------

// "$0.54", "$0.0009"; never rounds a real non-zero amount to "$0.00".
function fmtUsd(v) {
  if (v === null || v === undefined) return DASH;
  if (v === 0) return '$0.00';
  if (Math.abs(v) < 0.0001) return '<$0.0001';
  if (Math.abs(v) < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

// "850ms", "4.2s", "2m 14s", "1h 3m"; null → null.
function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 10000) return (ms / 1000).toFixed(1) + 's';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

const PRICE_NOT_SET_WHY = 'This model has no price in your model registry, so soot cannot work out a cost. Add a price to the registry to see it.';
const EST_WHY = "estimate from planned tokens × official price; runner didn't report usage";

// Money parts of one row (or of the whole table): the known USD plus how many attempts were
// runner-reported actuals, router estimates, unpriced, unreported, or had no data.
const noCost = () => ({ usd: null, actual: 0, estimated: 0, unpriced: 0, unreported: 0, none: 0, free: 0 });
function addPart(c, kind, v) {
  c[kind] += 1;
  if (v !== null && v !== undefined) c.usd = (c.usd === null ? 0 : c.usd) + v;
  return c;
}

// Models the router priced somewhere in this run (an estimate exists, so the registry has a price).
function pricedModels(r) {
  const s = new Set();
  for (const t of r.taskBreakdown) for (const a of t.costAttempts || []) if (a.estimatedUsd !== null && a.model) s.add(a.model);
  if (r.planning && r.planning.priced === true && r.planning.model) s.add(r.planning.model);
  return s;
}

// One task's cost, attempt by attempt:
// 1. the runner reported a cost → that actual;
// 2. no report but the router estimated it (the model is priced) → the estimate;
// 3. neither, and the model is priced elsewhere in the run → not reported;
// 4. otherwise the model has no registry price → price not set.
function taskCost(t, priced) {
  const c = noCost();
  const attempts = t.costAttempts || [];
  if (attempts.length === 0) return addPart(c, 'none', null);
  for (const a of attempts) {
    if (a.actualUsd !== null) addPart(c, 'actual', a.actualUsd);
    else if (a.estimatedUsd !== null) addPart(c, 'estimated', a.estimatedUsd);
    else if (a.model && priced.has(a.model)) addPart(c, 'unreported', null);
    else addPart(c, 'unpriced', null);
  }
  return c;
}

// Tokens the runner really reported: an attempt with a cost or a non-zero count. A 0 / 0 with
// no cost is "not reported", never 0.
function taskTokens(t) {
  const reported = (t.costAttempts || []).filter((a) => a.actualUsd !== null || (a.inputTokens || 0) + (a.outputTokens || 0) > 0);
  if (reported.length === 0) return { inputTokens: null, outputTokens: null };
  return {
    inputTokens: reported.reduce((n, a) => n + (a.inputTokens || 0), 0),
    outputTokens: reported.reduce((n, a) => n + (a.outputTokens || 0), 0),
  };
}

function planningCost(p) {
  const c = noCost();
  if (p.costUsd !== null) return addPart(c, 'actual', p.costUsd);
  if (p.priced === true) return addPart(c, 'unreported', null);
  if (p.priced === false) return addPart(c, 'unpriced', null);
  return addPart(c, 'none', null);
}

// A row's single kind, for counting rows in the totals tooltip.
function rowKind(c) {
  if (c.free > 0) return 'free';
  if (c.unpriced > 0) return 'unpriced';
  if (c.unreported > 0 || c.none > 0) return 'unreported';
  if (c.estimated > 0) return 'estimated';
  return 'actual';
}

// Table rows for one run: the planning call (null when not recorded) and one row per task.
function detailRows(r) {
  const uniq = (list) => list.filter((m, i) => list.indexOf(m) === i);
  const priced = pricedModels(r);
  const tasks = r.taskBreakdown.map((t) => {
    const tok = taskTokens(t);
    return {
      name: t.title || t.id,
      id: t.id,
      state: t.state,
      models: uniq(t.models),
      runner: t.runner,
      inputTokens: tok.inputTokens,
      outputTokens: tok.outputTokens,
      cost: taskCost(t, priced),
    };
  });
  const p = r.planning || null;
  const planning = p === null ? null : p.kind === 'fixture'
    ? { name: 'Planning', models: [], fixture: true, inputTokens: null, outputTokens: null, cost: addPart(noCost(), 'free', null) }
    : { name: 'Planning', models: [p.model], servedModel: p.servedModel, inputTokens: p.inputTokens, outputTokens: p.outputTokens, cost: planningCost(p) };
  return { planning: planning, tasks: tasks };
}

// Totals: actual costs plus estimates. A fixture plan made no call and is not counted.
function detailTotals(rows) {
  const all = (rows.planning ? [rows.planning] : []).concat(rows.tasks);
  const counted = all.filter((x) => x.cost.free === 0);
  const tok = counted.filter((x) => x.inputTokens !== null && x.outputTokens !== null);
  const cost = noCost();
  for (const x of counted) {
    for (const k of ['actual', 'estimated', 'unpriced', 'unreported', 'none']) cost[k] += x.cost[k];
    if (x.cost.usd !== null) cost.usd = (cost.usd === null ? 0 : cost.usd) + x.cost.usd;
  }
  const kinds = counted.map((x) => rowKind(x.cost));
  const n = (k) => kinds.filter((x) => x === k).length;
  return {
    inputTokens: tok.reduce((s, x) => s + x.inputTokens, 0),
    outputTokens: tok.reduce((s, x) => s + x.outputTokens, 0),
    tokensMissing: counted.length - tok.length,
    cost: cost,
    rows: counted.length,
    actualRows: n('actual'),
    estimatedRows: n('estimated'),
    unpricedRows: n('unpriced'),
    unreportedRows: n('unreported'),
  };
}

// How a cost reads: "$0.54", "~$0.0001" with "est.", a "partial" mark when some parts have no
// amount, or "price not set" / "not reported" / "not recorded" when nothing has an amount.
function costView(c) {
  if (c.usd === null) {
    if (c.free > 0) return { text: 'no model call', est: false, partial: false, muted: true, title: 'The plan came from a recorded fixture; no model was called.' };
    if (c.unpriced > 0) return { text: 'price not set', est: false, partial: false, muted: true, title: PRICE_NOT_SET_WHY };
    if (c.unreported > 0) return { text: 'not reported', est: false, partial: false, muted: true, title: 'The model is priced, but no cost was reported and no estimate was recorded.' };
    return { text: c.none > 0 ? 'not recorded' : DASH, est: false, partial: false, muted: true, title: 'No cost was recorded for this.' };
  }
  const est = c.estimated > 0;
  const partial = c.unpriced + c.unreported + c.none > 0;
  return {
    text: (est ? '~' : '') + fmtUsd(c.usd),
    est: est,
    partial: partial,
    muted: est,
    title: est ? EST_WHY : usd(c.usd),
  };
}

// The total's label and tooltip, counting rows by kind.
function totalCostText(tot) {
  const v = tot.rows === 0 ? { text: DASH, est: false, partial: false, muted: false, title: '' } : costView(tot.cost);
  if (tot.rows === 0) return v;
  const parts = [tot.actualRows + ' actual', tot.estimatedRows + ' estimated', tot.unpricedRows + ' unpriced'];
  if (tot.unreportedRows > 0) parts.push(tot.unreportedRows + ' not reported');
  const notes = [];
  if (v.est) notes.push('Estimates are planned tokens × official price.');
  if (v.partial) notes.push('Rows with no amount are not in this total.');
  return Object.assign({}, v, { muted: false, title: 'Rows: ' + parts.join(', ') + '.' + (notes.length ? ' ' + notes.join(' ') : '') });
}

function appendCost(node, v) {
  node.append(el('span', v.muted ? 'muted-val' : '', v.text));
  if (v.est) node.append(el('span', 'est-label', 'est.'));
  if (v.partial) node.append(el('span', 'partial', 'partial'));
}

function costTd(cost) {
  const td = el('td', 'num');
  const v = costView(cost);
  appendCost(td, v);
  td.title = v.title;
  return td;
}

const tokTd = (v) => {
  const td = el('td', 'num', v === null ? 'not reported' : fmtInt(v));
  if (v === null) td.className = 'num muted-val';
  return td;
};

function whoCell(row) {
  const td = el('td', 'who');
  const line = el('div', 'model-chain');
  if (row.models.length === 0) line.append(el('span', 'muted-val', row.fixture ? 'recorded plan' : 'not started'));
  row.models.forEach((m, i) => {
    if (i > 0) line.append(el('span', 'via', '→'));
    line.append(modelLabel(m, isNoModel(m) ? 'no model' : short(m)));
  });
  if (row.runner) line.append(tag(row.runner, 22));
  td.append(line);
  const full = row.models.map((m) => m || 'no model').join(' → ');
  td.title = (full || '') + (row.servedModel && row.servedModel !== short(row.models[0] || '') ? ' (served as ' + row.servedModel + ')' : '') + (row.runner ? ' · runner: ' + row.runner : '');
  return td;
}

function summaryBlock(r) {
  const s = el('section', 'block wide dsum-block');
  const text = el('div', 'prompt-line', r.prompt);
  text.title = r.prompt;
  s.append(text);
  if (r.prompt.length > 140) {
    const d = el('details', 'full-prompt');
    d.append(el('summary', '', 'Show full prompt'), el('div', 'prompt', r.prompt));
    s.append(d);
  }
  const tot = detailTotals(detailRows(r));
  const cost = totalCostText(tot);
  const strip = el('div', 'dsum');
  const cell = (label, value, cls, title) => {
    const c = el('div', 'dstat' + (cls ? ' ' + cls : ''));
    const v = el('div', 'v', value);
    if (title) v.title = title;
    c.append(v, el('div', 'k', label));
    return c;
  };
  const costCell = el('div', 'dstat big');
  const costValue = el('div', 'v');
  appendCost(costValue, cost);
  costValue.title = cost.title;
  costCell.append(costValue, el('div', 'k', 'Total cost'));
  const tokens = tot.rows === 0 || tot.tokensMissing === tot.rows ? 'not reported' : fmtInt(tot.inputTokens) + ' / ' + fmtInt(tot.outputTokens);
  const statusCell = el('div', 'dstat');
  const pill = el('div', 'v');
  pill.append(stateTag(r.state + (r.running ? ' (running)' : '')));
  statusCell.append(pill, el('div', 'k', 'Status'));
  const dur = fmtDuration(r.duration.ms);
  strip.append(
    costCell,
    cell('Tokens in / out', tokens, '', tot.tokensMissing > 0 ? tot.tokensMissing + ' row(s) did not report tokens' : ''),
    cell('Tasks', String(r.taskCount)),
    statusCell,
    cell('Duration', dur || (r.running ? 'running' : DASH)),
  );
  s.append(strip);
  const meta = el('div', 'tags dmeta');
  meta.append(timeEl(r.createdAt), tag(r.runId, 40));
  s.append(meta);
  return s;
}

function taskTableBlock(r) {
  const s = section('Tasks', true);
  const rows = detailRows(r);
  const wrap = el('div', 'table-scroll');
  const table = el('table', 'dtable');
  const head = el('thead');
  const hr = el('tr');
  for (const [h, num] of [['Task', false], ['Who took it', false], ['Tokens in', true], ['Tokens out', true], ['Cost', true]]) {
    const th = el('th', num ? 'num' : '', h);
    th.setAttribute('scope', 'col');
    hr.append(th);
  }
  head.append(hr);
  const body = el('tbody');
  const rowEl = (row, cls) => {
    const tr = el('tr', cls || '');
    const name = el('td', 'task');
    name.append(el('div', 'tname', row.name));
    if (row.id && row.id !== row.name) name.title = row.id;
    if (row.state) name.append(stateTag(row.state));
    tr.append(name, whoCell(row), tokTd(row.inputTokens), tokTd(row.outputTokens), costTd(row.cost));
    return tr;
  };
  if (rows.planning) {
    body.append(rowEl(rows.planning, 'planning'));
  } else {
    const tr = el('tr', 'planning');
    const td = el('td', '', 'Planning');
    const nr = el('td', 'muted-val', 'not recorded');
    nr.setAttribute('colspan', '4');
    nr.title = 'This run does not include its planning call, so it is not in the totals.';
    tr.append(td, nr);
    body.append(tr);
  }
  if (rows.tasks.length === 0) {
    const tr = el('tr');
    const td = el('td', 'muted-val', 'No tasks.');
    td.setAttribute('colspan', '5');
    tr.append(td);
    body.append(tr);
  }
  for (const row of rows.tasks) body.append(rowEl(row));
  const tot = detailTotals(rows);
  const foot = el('tfoot');
  const fr = el('tr', 'totals');
  const cost = totalCostText(tot);
  const costCell = el('td', 'num');
  appendCost(costCell, cost);
  costCell.title = cost.title;
  const tin = el('td', 'num', tot.rows === tot.tokensMissing ? DASH : fmtInt(tot.inputTokens));
  const tout = el('td', 'num', tot.rows === tot.tokensMissing ? DASH : fmtInt(tot.outputTokens));
  if (tot.tokensMissing > 0) { tin.title = tout.title = tot.tokensMissing + ' row(s) did not report tokens'; }
  fr.append(el('td', 'task', 'Total'), el('td', 'who empty'), tin, tout, costCell);
  foot.append(fr);
  table.append(head, body, foot);
  wrap.append(table);
  s.append(wrap);
  return s;
}

const CHART_BLOCKS = [
  (r) => assignmentBlock(r),
  (r) => timelineBlock(r),
  (r) => usageBlock('Usage by model', r.usage.byModel, r.usage.note, { byModel: true }),
  (r) => outcomesBlock(r),
  (r) => costBlock(r),
  (r) => tokensBlock(r),
  (r) => usageBlock('Usage by task', r.usage.byTask, r.usage.note),
  (r) => usageBlock('Usage by runner (agent/bot)', r.usage.byAgent, 'Runner unknown until the run has a saved report.'),
  (r) => validationBlock(r),
  (r) => transitionsBlock(r),
  (r) => block('Task graph (' + r.taskCount + ' tasks)', r.graph.layers.flatMap((ids, l) => {
    const tasks = ids.map((id) => r.tasks.find((t) => t.id === id));
    const row = 'L' + l + ' ' + tasks.map((t) => '[' + (t.state === 'running' ? '▣' : '■') + ' ' + t.id + ' · ' + (t.models.map(short).join('→') || '-') + ' · ' + t.attempts.length + 'x]').join(' ');
    const deps = tasks.filter((t) => t.dependsOn.length > 0).map((t) => '   └▶ ' + t.id + ' ← ' + t.dependsOn.join(', '));
    return [row, ...deps];
  })),
  (r) => block('Tasks and models', r.tasks.map((t) =>
    t.id + ' [' + t.complexity + '] ' + t.state + ' · ' + (t.models.length > 0 ? t.models.map((m) => m || 'no model').join(' → ') : 'not started') +
    (t.verdict === null ? '' : ' · verdict ' + t.verdict + (t.complete ? ' (complete)' : '')) +
    (t.reason ? '\n    ' + t.reason : ''))),
  (r) => block('Active agents', r.activeAgents.map((a) => '▣ ' + a.taskId + ' #' + a.attempt + ' on ' + (a.model || 'no model'))),
  (r) => block('Run details', [
    'id       ' + r.runId,
    'state    ' + r.state + (r.running ? ' (running)' : ''),
    'started  ' + (fmtDate(r.duration.startedAt) || 'unknown') + (r.duration.startedAt ? '  (' + r.duration.startedAt + ')' : ''),
    'duration ' + (fmtDuration(r.duration.ms) || (r.running ? 'running' : 'unknown')),
  ]),
];

function moreChartsBlock(r) {
  const d = el('details', 'block wide more-charts');
  d.append(el('summary', '', 'More charts'));
  const g = el('div', 'grid');
  g.append(...CHART_BLOCKS.map((b) => b(r)));
  d.append(g);
  return d;
}

function aboutNotes(r) {
  const rows = detailRows(r);
  const planning = rows.planning === null
    ? 'Planning: this run does not include its planning call, so it is not in the totals.'
    : rows.planning.fixture
      ? 'Planning: the plan came from a recorded fixture; no model was called to plan this prompt.'
      : 'Planning: the model that split the prompt into tasks. Its cost is shown only when soot recorded one.';
  return [
    'Who took it: the model or models each task ran on, in order. The runner (agent) is recorded once per run, not per task: ' + (r.agent.label || 'unknown (no saved report yet)') + '.',
    'Cost: the actual cost when the runner reported one. When it did not but the model is priced, the row shows the router\'s estimate ("~$0.0001 est.": planned tokens × official price, the same estimate the Overview charts) and its tokens read "not reported".',
    '"price not set" means the model has no price in your model registry; soot never counts that as $0. soot reads this from the router: it estimates every priced model, so no estimate means no price.',
    'Totals add actual costs and estimates. "est." means an estimate is included; "partial" means some rows have no amount (price not set or not reported) and are left out.',
    planning,
    'Duration: ' + r.duration.basis + '.',
    'Estimates are never shown as actuals. Mock runs report fictional amounts.',
    'Charts (under More charts): hatched cream = estimate, solid orange = reported actual; they never share a chart. Each chart is scaled to its own largest known value. Unknown is written as unknown, with no bar.',
    r.usage.note,
    r.savings.note,
  ];
}

function aboutBlock(r) {
  const d = el('details', 'block wide about');
  d.append(el('summary', '', 'About these numbers'));
  const ul = el('ul', '');
  for (const n of aboutNotes(r)) ul.append(el('li', '', n));
  d.append(ul);
  return d;
}

const BLOCKS = [summaryBlock, taskTableBlock, moreChartsBlock, aboutBlock];

function notFoundBlock(runId) {
  const s = section('Prompt not found', true);
  s.append(el('p', 'note', 'No recorded prompt has the id "' + runId + '".'));
  const back = el('a', 'back', '← History');
  back.href = '#/history';
  s.append(back);
  return s;
}

// Returns whether the shown run is still running (so the page keeps polling).
async function showRun(runId) {
  const main = $('run');
  lastRunId = runId;
  if (lastOverview && !lastOverview.prompts.some((p) => p.runId === runId)) {
    main.replaceChildren(notFoundBlock(runId));
    return false;
  }
  try {
    const { run } = await getJson('/api/runs/' + encodeURIComponent(runId));
    const open = Array.from(main.children || []).filter((c) => c.tagName === 'DETAILS' && c.open).map((c) => c.className);
    main.replaceChildren(...BLOCKS.map((b) => b(run)));
    for (const c of Array.from(main.children || [])) if (c.tagName === 'DETAILS' && open.includes(c.className)) c.open = true;
    return !!run.running;
  } catch (e) {
    if (/not found|404/i.test(e.message)) {
      main.replaceChildren(notFoundBlock(runId));
    } else {
      const p = el('p', 'error wide', 'Could not load run ' + runId + ': ' + e.message);
      main.replaceChildren(p);
    }
    return false;
  }
}

// ---- Prompt box (ADR-038): submit plans and runs right away; focus mode while working -----

const cmp = { session: null, projects: [], job: null, run: null, poll: null, loaded: false, said: '' };
const TERMINAL_TASK = ['succeeded', 'failed', 'cancelled', 'skipped'];
const liveJob = (j) => !!j && (j.state === 'planning' || j.state === 'running');

// "planner: deepseek-flash · ~$0.0016 per plan" for the line next to Run.
function plannerText(p) {
  if (!p || p.status === 'not-configured' || !p.model) return 'planner: recorded prompts only';
  if (p.status === 'unusable') return 'planner: ' + short(p.model) + ' not usable (recorded prompts only)';
  return 'planner: ' + short(p.model) + ' · ' + (p.roughCostUsd === null || p.roughCostUsd === undefined ? 'price not set' : '~' + fmtUsd(p.roughCostUsd) + ' per plan');
}

// The compact live view of one job: the planning row, one row per task (model, state, cost so far),
// the total so far and the worst case. Uses the run once it exists, else the plan preview.
function liveModel(job, run) {
  const pv = job.preview || null;
  const planner = pv ? pv.planner : null;
  const planning = planner === null
    ? { name: 'Planning', model: null, state: job.state === 'planning' ? 'planning' : (job.state === 'failed' ? 'failed' : 'cancelled'), inputTokens: null, outputTokens: null, cost: addPart(noCost(), 'none', null) }
    : planner.kind === 'fixture'
      ? { name: 'Planning', model: null, fixture: true, state: 'succeeded', inputTokens: null, outputTokens: null, cost: addPart(noCost(), 'free', null) }
      : { name: 'Planning', model: planner.model, state: 'succeeded', inputTokens: planner.inputTokens, outputTokens: planner.outputTokens, cost: planningCost(planner) };
  const planned = pv ? pv.tasks : [];
  const byId = {};
  for (const t of planned) byId[t.taskId] = t;
  const fromPlan = (t) => t.estimateUsd === null ? addPart(noCost(), 'unpriced', null) : addPart(noCost(), 'estimated', t.estimateUsd);
  let tasks;
  if (run) {
    tasks = detailRows(run).tasks.map((row) => {
      const p = byId[row.id];
      const started = row.cost.actual + row.cost.estimated + row.cost.unpriced + row.cost.unreported > 0;
      return {
        id: row.id,
        name: row.name,
        models: row.models.length > 0 ? row.models : (p && p.model ? [p.model] : []),
        state: row.state,
        cost: started || !p ? row.cost : fromPlan(p),
        inputTokens: null,
        outputTokens: null,
      };
    });
  } else {
    tasks = planned.map((t) => ({ id: t.taskId, name: t.title || t.taskId, models: t.model ? [t.model] : [], state: job.state === 'running' ? 'pending' : (liveJob(job) ? 'queued' : 'cancelled'), cost: fromPlan(t), inputTokens: null, outputTokens: null }));
  }
  const tot = detailTotals({ planning: planning, tasks: tasks });
  const done = tasks.filter((t) => TERMINAL_TASK.includes(t.state)).length;
  const planCost = planning.cost.usd === null ? 0 : planning.cost.usd;
  const worst = pv && pv.worstCaseUsd !== null && pv.worstCaseUsd !== undefined
    ? { usd: pv.worstCaseUsd + planCost, partial: !!pv.worstCasePartial, basis: pv.worstCaseBasis }
    : null;
  return { planning: planning, tasks: tasks, total: totalCostText(tot), worst: worst, done: done };
}

// One line for the live card's head.
function liveHeadline(job, m, now) {
  const secs = Math.max(0, Math.round(((now || Date.now()) - Date.parse(job.createdAt)) / 1000));
  const clock = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  if (job.state === 'planning') return { text: 'Planning…', sub: 'Splitting the prompt into tasks · ' + clock };
  if (job.state === 'running') return { text: 'Running · ' + m.done + ' of ' + m.tasks.length + ' tasks done · ' + clock, sub: 'Runner: ' + job.runner.label + ' · ' + job.project.label };
  if (job.state === 'done') {
    const st = job.result && job.result.status ? job.result.status : 'done';
    return { text: st === 'complete' ? 'Done · complete' : 'Done · ' + st, sub: m.done + ' of ' + m.tasks.length + ' tasks finished · ' + job.project.label };
  }
  if (job.state === 'cancelled') return { text: 'Stopped', sub: job.runId ? 'Running agents were told to stop. Work merged before the stop stays in ' + job.project.label + '.' : 'Stopped while planning. Nothing ran.' };
  return { text: 'Failed', sub: job.error ? job.error.message : 'The prompt did not finish.' };
}

function setFocus() {
  const ta = $('cmp-prompt');
  const typing = !!ta && document.activeElement === ta && ta.value.trim() !== '';
  const onCompose = parseRoute(location.hash).view === 'compose';
  document.body.classList.toggle('focus', onCompose && (typing || liveJob(cmp.job)));
  document.body.classList.toggle('working', onCompose && cmp.job !== null);
}

async function postJson(path, body, headers) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
  if (cmp.session && cmp.session.csrf) h['x-soot-csrf'] = cmp.session.csrf;
  const r = await fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body), cache: 'no-store', credentials: 'same-origin' });
  let j = {};
  try { j = await r.json(); } catch (e) { j = {}; }
  if (!r.ok) throw new Error(j.message || j.error || String(r.status));
  return j;
}

const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

function selectedProject() {
  const sel = $('cmp-project');
  return cmp.projects.find((p) => p.id === (sel ? sel.value : '')) || null;
}

function say(text, isError) {
  const why = $('cmp-why');
  why.textContent = text;
  why.className = 'cmp-why' + (isError ? ' error' : '');
  if (isError) why.setAttribute('role', 'alert'); else why.setAttribute('role', 'status');
}

function offBox(lines, kind) {
  const box = el('div', 'cmp-off' + (kind ? ' ' + kind : ''));
  box.id = 'cmp-off';
  for (const l of lines) {
    if (typeof l === 'string') box.append(el('div', '', l));
    else { const c = el('div', ''); c.append(el('code', '', l.code)); box.append(c); }
  }
  return box;
}

function setDisabled(disabled, reason) {
  const ta = $('cmp-prompt'), send = $('cmp-send'), sel = $('cmp-project');
  ta.disabled = disabled;
  sel.disabled = disabled || cmp.projects.length === 0;
  send.disabled = disabled;
  if (disabled) send.setAttribute('aria-disabled', 'true'); else send.removeAttribute('aria-disabled');
  if (reason !== undefined) say(reason, false);
}

function renderLabels() {
  const p = selectedProject();
  const box = $('cmp-labels');
  if (!cmp.session || !cmp.session.writes || p === null) { box.replaceChildren(); return; }
  const runner = el('span', '', 'runner: ');
  runner.append(el('b', '', p.runnerLabel || cmp.session.runner.label));
  box.replaceChildren(runner, el('span', '', ' · ' + plannerText(p.planner)));
  box.title = p.path + ' · ' + (p.runnerLabel || '') + ' · ' + plannerText(p.planner);
}

async function renderSetup() {
  const p = selectedProject();
  const d = $('cmp-setup');
  if (p === null) { d.hidden = true; return; }
  try {
    const k = await getJson('/api/keys/status?project=' + encodeURIComponent(p.id));
    const ul = el('ul', '');
    ul.append(el('li', '', 'folder: ' + p.path));
    ul.append(el('li', '', 'models: ' + k.models + (k.unpriced.length > 0 ? ' (' + k.unpriced.length + ' with no price: ' + k.unpriced.map(short).join(', ') + ')' : '')));
    ul.append(el('li', '', plannerText(k.planner) + (k.planner.reason ? ' — ' + k.planner.reason : '')));
    for (const pr of k.providers) {
      const li = el('li', '', pr.id + ' ');
      if (pr.keyVar) li.append(el('code', '', pr.keyVar));
      li.append(el('span', 'pill ' + pr.key, pr.key));
      ul.append(li);
    }
    ul.append(el('li', '', 'Keys show as set or missing only. soot never asks for keys here and never shows them. Approval-needing actions in a run are refused.'));
    $('cmp-setup-body').replaceChildren(ul);
    d.hidden = false;
  } catch (e) {
    d.hidden = true;
  }
}

async function initCompose() {
  if (cmp.loaded) return;
  cmp.loaded = true;
  const ta = $('cmp-prompt');
  const form = $('cmp-form');
  const sel = $('cmp-project');
  ta.addEventListener('input', () => { setFocus(); if (!liveJob(cmp.job)) say('', false); });
  ta.addEventListener('focus', setFocus);
  ta.addEventListener('blur', setFocus);
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void submitPrompt(); }
  });
  form.addEventListener('submit', (ev) => { ev.preventDefault(); void submitPrompt(); });
  sel.addEventListener('change', () => { try { localStorage.setItem('soot.project', sel.value); } catch (e) { /* private mode */ } renderLabels(); void renderSetup(); });
  try {
    cmp.session = await getJson('/api/session');
  } catch (e) {
    setDisabled(true, 'Could not reach the dashboard: ' + e.message);
    return;
  }
  if (lastOverview) renderMeta(lastOverview);
  const view = $('view-compose');
  if (!cmp.session.writes) {
    view.prepend(offBox(['This dashboard is read-only.', 'To run prompts from here, restart it with a runner:', { code: 'soot dashboard --agent mock --mock-script <file>' }, { code: 'soot dashboard --agent acp' }]));
    ta.placeholder = 'Read-only: start soot dashboard with --agent to run prompts';
    setDisabled(true, '');
    return;
  }
  try {
    cmp.projects = (await getJson('/api/projects')).projects;
  } catch (e) {
    setDisabled(true, 'Could not load projects: ' + e.message);
    return;
  }
  if (cmp.projects.length === 0) {
    view.prepend(offBox(['No project folders are allowed yet. For safety, folders can only be added from the terminal, never from this page:', { code: 'soot dashboard allow <dir>' }, 'Then reload this page.']));
    setDisabled(true, '');
    return;
  }
  let saved = null;
  try { saved = localStorage.getItem('soot.project'); } catch (e) { saved = null; }
  sel.replaceChildren(...cmp.projects.map((p) => {
    const o = el('option', '', p.label + (p.config.ok ? '' : ' (config error)'));
    o.value = p.id;
    o.title = p.path;
    return o;
  }));
  if (saved && cmp.projects.some((p) => p.id === saved)) sel.value = saved;
  setDisabled(false);
  renderLabels();
  void renderSetup();
  try {
    const jobs = (await getJson('/api/prompts')).jobs;
    const live = jobs.find(liveJob);
    if (live) { cmp.job = live; startPoll(); }
  } catch (e) { /* nothing to resume */ }
  renderCompose();
  ta.focus();
}

async function submitPrompt() {
  const ta = $('cmp-prompt');
  const p = selectedProject();
  if (ta.disabled || liveJob(cmp.job)) return;
  if (p === null) { say('Pick a project first.', true); return; }
  if (ta.value.trim() === '') { say('Write a prompt first.', true); return; }
  if (!p.config.ok) { say(p.label + ': ' + (p.config.error || 'soot.config.json does not load'), true); return; }
  setDisabled(true, 'Starting…');
  try {
    const out = await postJson('/api/prompts', { project: p.id, prompt: ta.value }, { 'idempotency-key': randomKey() });
    cmp.job = out.job;
    cmp.run = null;
    ta.value = '';
    say('', false);
    startPoll();
  } catch (e) {
    say(e.message, true);
  } finally {
    setDisabled(false);
    renderCompose();
  }
}

async function stopJob() {
  if (!cmp.job) return;
  try { cmp.job = (await postJson('/api/prompts/' + encodeURIComponent(cmp.job.id) + '/cancel', {})).job; } catch (e) { say('Could not stop: ' + e.message, true); }
  renderCompose();
}

async function stopTask(taskId) {
  if (!cmp.job || !cmp.job.runId) return;
  try { await postJson('/api/runs/' + encodeURIComponent(cmp.job.runId) + '/cancel', { task: taskId }); } catch (e) { say('Could not stop ' + taskId + ': ' + e.message, true); }
}

function startPoll() {
  clearTimeout(cmp.poll);
  const tick = async () => {
    if (!cmp.job) return;
    const wasLive = liveJob(cmp.job);
    try {
      cmp.job = (await getJson('/api/prompts/' + encodeURIComponent(cmp.job.id))).job;
      if (cmp.job.runId) {
        try { cmp.run = (await getJson('/api/runs/' + encodeURIComponent(cmp.job.runId))).run; } catch (e) { /* not recorded yet */ }
      }
    } catch (e) {
      say('Lost the dashboard: ' + e.message, true);
      return;
    }
    renderCompose();
    if (liveJob(cmp.job)) cmp.poll = setTimeout(() => { void tick(); }, 1000);
    else if (wasLive) { void refresh(); const ta = $('cmp-prompt'); if (ta && parseRoute(location.hash).view === 'compose') ta.focus(); }
  };
  void tick();
}

// After a run: the first run-level problem (e.g. "working tree not updated: approval
// unavailable; result left on soot/<run>/integration"), else the runner's one-line summary.
function finishNote(job, run) {
  const problems = run && run.validation && run.validation.problems ? run.validation.problems : [];
  if (problems.length > 0) return problems[0];
  return job.result && job.result.message ? job.result.message : '';
}

function liveCard(job, run) {
  const m = liveModel(job, run);
  const head = liveHeadline(job, m);
  const card = el('section', 'cmp-live ' + (job.state === 'done' ? 'done' : job.state));
  card.id = 'cmp-live';
  card.setAttribute('aria-label', 'current prompt');
  card.append(el('div', 'cmp-quote', job.prompt));
  const top = el('div', 'cmp-head');
  const blocks = el('span', 'blocks' + (liveJob(job) ? ' live' : ''));
  const n = m.tasks.length + 1;
  const on = Math.round(((m.done + (job.preview ? 1 : 0)) / n) * 8);
  for (let i = 0; i < 8; i++) blocks.append(el('i', i < on ? 'on' : (i === on && liveJob(job) ? 'next' : '')));
  blocks.setAttribute('aria-hidden', 'true');
  const what = el('div', 'what', head.text);
  what.append(el('small', '', head.sub));
  const cost = el('div', 'cmp-cost');
  const v = el('div', 'v');
  appendCost(v, m.total);
  v.title = m.total.title;
  cost.append(v, el('div', 'k', liveJob(job) ? 'cost so far' : 'cost'));
  if (m.worst) {
    const w = el('div', 'k', 'worst case ≤ ' + fmtUsd(m.worst.usd) + (m.worst.partial ? ' partial' : ''));
    w.title = 'Worst case: planning plus ' + m.worst.basis + '. Not a quote.';
    cost.append(w);
  }
  top.append(blocks, what, cost);
  if (liveJob(job)) {
    const stop = el('button', 'btn danger', job.stopRequested ? 'Stopping…' : 'Stop');
    stop.type = 'button';
    stop.disabled = !!job.stopRequested;
    stop.addEventListener('click', () => { void stopJob(); });
    top.append(stop);
  }
  card.append(top);
  const ul = el('ul', 'cmp-tasks');
  const li = (row, cls, stoppable) => {
    const x = el('li', cls || '');
    x.append(el('span', 't', row.name));
    const mcell = el('span', 'm model-chain');
    const models = row.models || [];
    if (models.length === 0) mcell.append(el('span', 'muted-val', row.fixture ? 'recorded plan' : DASH));
    models.forEach((mm, i) => { if (i > 0) mcell.append(el('span', 'via', '→')); mcell.append(modelLabel(mm, short(mm))); });
    const scell = el('span', 's');
    scell.append(stateTag(row.state));
    if (stoppable) {
      const b = el('button', 'taskstop', 'stop');
      b.type = 'button';
      b.title = 'Stop this task; tasks that depend on it are skipped';
      b.addEventListener('click', () => { void stopTask(row.id); });
      scell.append(b);
    }
    const c = el('span', 'c');
    appendCost(c, costView(row.cost));
    c.title = costView(row.cost).title;
    x.append(mcell, scell, c);
    return x;
  };
  const planRow = Object.assign({}, m.planning, { models: m.planning.model ? [m.planning.model] : [] });
  ul.append(li(planRow, 'plan', false));
  for (const t of m.tasks) ul.append(li(t, '', job.state === 'running' && !!job.runId && !TERMINAL_TASK.includes(t.state) && !job.stopRequested));
  card.append(ul);
  const foot = el('div', 'cmp-foot');
  const landing = job.runner && job.runner.lands ? ' Verified results land on your branch (--apply); other approval-needing actions are refused.' : ' Approval-needing actions are refused.';
  foot.append(el('span', '', liveJob(job) ? 'This run lives in soot dashboard: stopping the dashboard stops it.' + landing : finishNote(job, run)));
  const acts = el('span', 'acts');
  if (job.runId) {
    const a = el('a', 'btn small', 'details');
    a.href = promptHref(job.runId);
    acts.append(a);
  }
  if (!liveJob(job)) {
    const b = el('button', 'btn small', 'dismiss');
    b.type = 'button';
    b.addEventListener('click', () => { cmp.job = null; cmp.run = null; cmp.said = ''; say('', false); renderCompose(); $('cmp-prompt').focus(); });
    acts.append(b);
  }
  foot.append(acts);
  card.append(foot);
  const said = job.state === 'running' ? 'Running · ' + m.done + ' of ' + m.tasks.length + ' tasks done' : head.text + (job.state === 'failed' || job.state === 'cancelled' ? '. ' + head.sub : '');
  return { card: card, said: said };
}

function renderCompose() {
  const live = $('cmp-live');
  const form = $('cmp-form');
  if (!cmp.job) {
    live.hidden = true;
    form.hidden = false;
    setFocus();
    return;
  }
  const out = liveCard(cmp.job, cmp.run);
  live.replaceWith(out.card);
  out.card.hidden = false;
  // While working, the submitted prompt replaces the box; it comes back when the run ends.
  form.hidden = liveJob(cmp.job);
  $('cmp-setup').hidden = liveJob(cmp.job) || $('cmp-setup-body').children.length === 0;
  // Screen readers hear state changes only, not the ticking clock.
  // The card already shows the state, so it is announced in a hidden live region, not repeated
  // under the prompt box.
  if (out.said !== cmp.said) { cmp.said = out.said; const sr = $('cmp-sr'); if (sr) sr.textContent = out.said; }
  setFocus();
}

// ---- Router -------------------------------------------------------------------------------------

function setTab(active) {
  for (const name of ['compose', 'overview', 'prompts']) {
    const t = $('tab-' + name);
    if (!t) continue;
    t.className = 'tab' + (name === active ? ' active' : '');
    if (name === active) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
}

async function route() {
  const r = parseRoute(location.hash);
  setTab(r.view === 'compose' || r.view === 'overview' ? r.view : 'prompts');
  $('view-compose').hidden = r.view !== 'compose';
  $('view-overview').hidden = r.view !== 'overview';
  $('view-prompts').hidden = r.view !== 'prompts';
  $('view-prompt').hidden = r.view !== 'prompt';
  setFocus();
  if (r.view === 'compose') {
    void initCompose();
    return false;
  }
  if (r.view === 'overview') {
    if (lastOverview) {
      renderGrid(lastOverview, r.zoom || 'prompt');
      drawFlow($('flow'), lastOverview);
    }
    return false;
  }
  if (r.view === 'prompts') {
    if (lastOverview) renderPrompts(lastOverview.prompts, r.filter);
    return false;
  }
  return showRun(r.runId);
}

function renderMeta(ov) {
  const meta = $('meta');
  const now = new Date();
  const t = el('time', '', fmtDate(now.toISOString()) || '');
  t.dateTime = now.toISOString();
  t.title = now.toISOString();
  const mode = cmp.session === null ? '' : cmp.session.writes ? 'runner: ' + cmp.session.runner.label + ' · ' : 'read-only · ';
  meta.replaceChildren(el('span', '', ov.promptCount + ' run(s) · ' + mode + '127.0.0.1 only · updated '), t);
}

async function refresh() {
  clearTimeout(timer);
  try {
    const data = await getJson('/api/runs');
    const overview = data.overview || { prompts: [], flows: [], byModel: [], promptCount: 0, taskCount: 0, aggregate: null };
    lastOverview = overview;
    useModels(overview.byModel.map((m) => m.model).concat(overview.aggregate ? overview.aggregate.usageByModel.map((m) => m.label) : []));
    renderMeta(overview);
    renderOverview(overview);
    const runningRun = await route();
    if (runningRun || overview.prompts.some((p) => p.state === 'running')) timer = setTimeout(() => { void refresh(); }, 1500);
  } catch (e) {
    $('meta').textContent = 'Could not reach the soot dashboard API: ' + e.message;
  }
}

window.addEventListener('hashchange', () => { void route(); });
window.addEventListener('resize', () => { if (lastOverview && parseRoute(location.hash).view === 'overview') drawFlow($('flow'), lastOverview); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideTip($('pgrid-panel')); });
void refresh();
`;
