/*
 * The dashboard page: plain HTML, one stylesheet and one small script, no framework (ADR-009,
 * ADR-031). Every section is a block built from the JSON API; swapping a block means changing
 * one function. All text is set with textContent (prompts and reasons are untrusted). Prompt
 * text drawn on the canvas uses fillText only. The script only talks to this server's own
 * /api paths.
 *
 * Views (hash routes, no router library): `#/` Overview (aggregates across every prompt only),
 * `#/prompts` the prompt list, `#/prompts/<runId>` one prompt's detail.
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
        <a class="tab" id="tab-overview" href="#/">Overview</a>
        <a class="tab" id="tab-prompts" href="#/prompts">Prompts</a>
      </nav>
      <main id="view-overview" class="grid">
        <section id="tiles" class="tiles wide" aria-label="summary"></section>
        <section id="centerpiece" class="block wide centerpiece">
          <h2>Where tasks went · all prompts</h2>
          <p class="note">Tasks per model across every recorded prompt. A task that used more than one model is counted under each. The largest share is bracketed in cream.</p>
          <canvas id="flow" width="960" height="320" aria-label="Tasks from prompts to models"></canvas>
          <div id="legend" class="model-legend" aria-label="model legend"></div>
        </section>
        <div id="agg" class="grid wide"></div>
      </main>
      <main id="view-prompts" class="grid" hidden>
        <section id="prompts" class="block wide prompts" aria-label="previous prompts">loading…</section>
      </main>
      <main id="view-prompt" class="grid" hidden>
        <p class="wide"><a class="back" href="#/prompts">← All prompts</a></p>
        <div id="run" class="grid wide"></div>
      </main>
    </div>
    <script src="/app.js" defer></script>
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
@media (max-width: 760px) {
  .block { grid-column: 1 / -1; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sub-grid { grid-template-columns: minmax(0, 1fr); }
  a.prompt-row { grid-template-columns: minmax(0, 1fr); }
  .prompt-when { flex-direction: row; flex-wrap: wrap; }
  .prompt-stats { text-align: left; }
  .task-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .task-row .r { text-align: left; }
  .row, .row.long { grid-template-columns: minmax(0, 9em) minmax(0, 1fr) minmax(0, 7em); }
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

// Hash route: '' | '#' | '#/' → overview; '#/prompts' → list; '#/prompts/<runId>' → detail.
// An old-style '#<runId>' link still opens that prompt. Anything else is the overview.
function parseRoute(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (h === '' || h === '/') return { view: 'overview' };
  const m = /^\/prompts\/?(.*)$/.exec(h);
  if (m) {
    const rest = m[1].replace(/\/+$/, '');
    if (rest === '') return { view: 'prompts' };
    let id = rest;
    try { id = decodeURIComponent(rest); } catch (e) { id = rest; }
    return { view: 'prompt', runId: id };
  }
  if (h.charAt(0) !== '/') {
    try { return { view: 'prompt', runId: decodeURIComponent(h) }; } catch (e) { return { view: 'prompt', runId: h }; }
  }
  return { view: 'overview' };
}
const promptHref = (runId) => '#/prompts/' + encodeURIComponent(runId);

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
      row.append(track, el('span', 'value', ((x.end - x.start) / 1000).toFixed(1) + ' s ' + x.a.state));
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

function identBlock(r) {
  const s = section('Prompt', true);
  s.append(el('div', 'prompt', r.prompt));
  const duration = r.duration.ms === null ? (r.running ? 'running' : 'unknown') : (r.duration.ms / 1000).toFixed(1) + ' s';
  const meta = el('div', 'tags');
  meta.append(stateTag(r.state + (r.running ? ' (running)' : '')), timeEl(r.createdAt), el('span', 'note', duration), tag(r.runId, 40));
  s.append(meta);
  return s;
}

function taskBreakdownBlock(r) {
  const s = section('Tasks in this prompt', true);
  const head = el('div', 'note tags');
  head.append(el('span', '', 'Runner is recorded per run, not per task:'), r.agent.label ? tag(r.agent.label, 96) : el('span', 'unknown', 'unknown (no saved report yet)'));
  if (r.agent.kind) head.append(tag(r.agent.kind, 24));
  s.append(head);
  if (r.taskBreakdown.length === 0) {
    s.append(el('div', 'unknown', '(no tasks)'));
    return s;
  }
  for (const t of r.taskBreakdown) {
    const row = el('div', 'task-row');
    const left = el('div', '');
    const idLine = el('div', 'tags');
    idLine.append(el('span', 't', t.id), stateTag(t.state));
    left.append(idLine);
    if (t.title) left.append(el('div', '', t.title));
    const mid = el('div', '');
    const chain = el('div', 'model-chain');
    chain.append(el('span', 'note', 'model:'));
    if (t.models.length === 0) chain.append(el('span', 'unknown', 'not started'));
    t.models.forEach((m, i) => {
      if (i > 0) chain.append(el('span', 'via', '→'));
      chain.append(modelLabel(m));
    });
    chain.append(el('span', 'note', '· ' + t.attempts + ' attempt(s)'));
    mid.append(chain);
    const runner = el('div', 'tags');
    runner.append(el('span', 'note', 'runner:'), t.runner ? tag(t.runner, 28) : el('span', 'unknown', 'unknown'));
    mid.append(runner);
    const right = el('div', 'r');
    if (t.tokens === null) {
      right.append(el('div', 'unknown', t.tokensUnknown || 'tokens unknown'));
    } else {
      right.append(el('div', '', fmtInt(t.tokens.total) + ' tok'), el('div', 'note', fmtInt(t.tokens.inputTokens) + ' in / ' + fmtInt(t.tokens.outputTokens) + ' out'));
    }
    if (t.costUsd === null) {
      right.append(el('div', 'unknown', t.costUnknown || 'cost unknown'));
    } else {
      right.append(el('div', '', usd(t.costUsd)));
    }
    row.append(left, mid, right);
    s.append(row);
  }
  const tk = r.tokens.actual;
  const tokLine = tk === null
    ? 'total tokens unknown (no cost data)'
    : 'total tokens  ' + fmtInt(tk.inputTokens + tk.outputTokens) + '  (' + fmtInt(tk.inputTokens) + ' in / ' + fmtInt(tk.outputTokens) + ' out)' + (tk.unreportedAttempts > 0 ? '; ' + tk.unreportedAttempts + ' attempt(s) unreported' : '');
  const costLine = r.cost.actualUsd === null
    ? (r.cost.unpricedAttempts ? 'total cost unknown (' + r.cost.unpricedAttempts + ' unpriced attempt(s))' : 'total cost unknown')
    : 'total cost  ' + usd(r.cost.actualUsd);
  s.append(el('pre', 'note', tokLine + '\n' + costLine));
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
  const prompts = overview && overview.prompts ? overview.prompts : [];
  const models = overview && overview.byModel ? overview.byModel : [];
  const flows = overview && overview.flows ? overview.flows : [];
  const rows = Math.max(prompts.length, models.length, 1);
  const height = Math.max(240, 56 + rows * 40 + 24);
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
  ctx.fillText('MODELS  (' + overview.taskCount + ' tasks, ' + overview.promptCount + ' prompts)', cssW - pad, 16);
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

function renderPrompts(prompts) {
  const nav = $('prompts');
  nav.replaceChildren();
  nav.append(el('h2', '', 'Previous prompts · ' + prompts.length));
  if (prompts.length === 0) {
    nav.append(el('div', 'unknown', 'No runs in this state directory yet (start one with soot run).'));
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
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}

const BLOCKS = [
  (r) => identBlock(r),
  (r) => taskBreakdownBlock(r),
  (r) => assignmentBlock(r),
  (r) => usageBlock('Usage by model (also the cost-by-model numbers)', r.usage.byModel, r.usage.note, { byModel: true }),
  (r) => block('How to read the charts', [r.usage.note, 'Hatched cream = estimate, solid orange = reported actual; they never share a chart or a donut. Each magnitude chart is scaled to its own largest known value. Unknown is written as unknown, with no bar or slice.', r.savings.note]),
  (r) => outcomesBlock(r),
  (r) => costBlock(r),
  (r) => tokensBlock(r),
  (r) => usageBlock('Usage by task', r.usage.byTask, r.usage.note),
  (r) => usageBlock('Usage by runner (agent/bot)', r.usage.byAgent, 'Runner unknown until the run has a saved report.'),
  (r) => timelineBlock(r),
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
    'duration ' + (r.duration.ms === null ? (r.running ? 'running' : 'unknown') : (r.duration.ms / 1000).toFixed(1) + ' s') + '  (' + r.duration.basis + ')',
    '',
    'Prompt:',
    r.prompt,
  ]),
  (r) => block('Savings', [r.savings.note]),
];

function notFoundBlock(runId) {
  const s = section('Prompt not found', true);
  s.append(el('p', 'note', 'No recorded prompt has the id "' + runId + '".'));
  const back = el('a', 'back', '← All prompts');
  back.href = '#/prompts';
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
    main.replaceChildren(...BLOCKS.map((b) => b(run)));
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

// ---- Router -------------------------------------------------------------------------------------

function setTab(active) {
  for (const name of ['overview', 'prompts']) {
    const t = $('tab-' + name);
    if (!t) continue;
    t.className = 'tab' + (name === active ? ' active' : '');
    if (name === active) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
}

async function route() {
  const r = parseRoute(location.hash);
  setTab(r.view === 'overview' ? 'overview' : 'prompts');
  $('view-overview').hidden = r.view !== 'overview';
  $('view-prompts').hidden = r.view !== 'prompts';
  $('view-prompt').hidden = r.view !== 'prompt';
  if (r.view === 'overview') {
    if (lastOverview) drawFlow($('flow'), lastOverview);
    return false;
  }
  if (r.view === 'prompts') {
    if (lastOverview) renderPrompts(lastOverview.prompts);
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
  meta.replaceChildren(el('span', '', ov.promptCount + ' run(s) · read-only · 127.0.0.1 only · updated '), t);
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
    renderPrompts(overview.prompts);
    const runningRun = await route();
    if (runningRun || overview.prompts.some((p) => p.state === 'running')) timer = setTimeout(() => { void refresh(); }, 1500);
  } catch (e) {
    $('meta').textContent = 'Could not reach the soot dashboard API: ' + e.message;
  }
}

window.addEventListener('hashchange', () => { void route(); });
window.addEventListener('resize', () => { if (lastOverview && parseRoute(location.hash).view === 'overview') drawFlow($('flow'), lastOverview); });
void refresh();
`;
