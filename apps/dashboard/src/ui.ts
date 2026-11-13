/*
 * The dashboard page: plain HTML, one stylesheet and one small script, no framework (ADR-009,
 * ADR-031). Every section is a text block built from the JSON API; swapping a block means
 * changing one function. All text is set with textContent (prompts and reasons are untrusted).
 * The script only talks to this server's own /api paths.
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
    <header>
      <h1>
        <img src="/logo.png" alt="soot" width="144" height="32" />
        <span>local dashboard</span>
      </h1>
      <p class="note">Read-only view of this machine's soot state (127.0.0.1 only). Headless soot does not need it.</p>
    </header>
    <nav id="runs" aria-label="runs">loading…</nav>
    <main id="run"></main>
    <script src="/app.js" defer></script>
  </body>
</html>
`;

export const STYLE_CSS = `/* Palette (ADR-031 amendment): near-black, orange accent, cream for estimates, warm grays. */
:root {
  --page: #0a0a0a; --block: #141414; --line: #2e2a27; --text: #d6ccbd; --cream: #e8dcc8;
  --muted: #8c8278; --orange: #ff7a1a; --orange-dark: #c25510; --error: #ff4d2e;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; background: var(--page); color: var(--text); font: 14px/1.35 ui-monospace, Menlo, Consolas, monospace; }
h1 { display: flex; align-items: center; gap: 10px; font-size: 16px; margin: 0 0 4px; color: var(--orange); }
h1 img { height: 32px; width: auto; image-rendering: pixelated; image-rendering: crisp-edges; display: block; }
.note { margin: 0 0 12px; color: var(--muted); }
nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
nav button { font: inherit; color: var(--cream); background: var(--block); border: 2px solid var(--line); padding: 2px 6px; cursor: pointer; }
nav button.current { border-color: var(--orange); color: var(--orange); }
main { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 8px; }
.block { border: 2px solid var(--line); background: var(--block); padding: 6px 8px; }
.block h2 { font-size: 14px; margin: 0 0 4px; color: var(--orange); }
.block pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.error { color: var(--error); }
.chart { margin: 4px 0 8px; }
.chart h3 { font-size: 13px; margin: 0 0 2px; color: var(--muted); font-weight: normal; }
.row { display: grid; grid-template-columns: 11em 1fr 9em; gap: 6px; align-items: center; }
.row.long { grid-template-columns: 11em 1fr 15em; }
.row .label, .row .value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.track { height: 10px; background: #1f1c1a; position: relative; display: flex; }
.bar { height: 10px; }
.bar.act { background: var(--orange); }
.bar.act-2 { background: var(--orange-dark); }
.bar.est { background: repeating-linear-gradient(90deg, var(--cream) 0 4px, transparent 4px 6px); border: 1px solid var(--cream); }
.bar.est-2 { background: repeating-linear-gradient(90deg, var(--muted) 0 4px, transparent 4px 6px); border: 1px solid var(--muted); }
.bar.cnt { background: var(--muted); }
.bar.pass { background: var(--orange); }
.bar.fail { background: var(--error); }
.bar.other { background: var(--muted); }
.span { position: absolute; top: 0; height: 10px; }
.tick { position: absolute; top: -2px; width: 2px; height: 14px; background: var(--cream); }
.unknown { color: var(--muted); font-style: italic; }
.wide { grid-column: 1 / -1; }
.pair { display: flex; flex-wrap: wrap; gap: 16px; }
.donut { display: grid; grid-template-columns: repeat(11, 8px); grid-auto-rows: 8px; gap: 1px; margin: 2px 0; }
.px { width: 8px; height: 8px; }
.legend { display: flex; flex-direction: column; gap: 1px; }
.sw { display: inline-block; width: 8px; height: 8px; margin-right: 4px; }
.share { display: flex; gap: 10px; align-items: center; }
.prompt { border: 2px dashed var(--orange); padding: 4px 6px; white-space: pre-wrap; color: var(--cream); }
.split { color: var(--muted); margin: 4px 0 4px 1em; }
.layer { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 6px 1em; }
.card { border: 2px solid var(--line); padding: 4px 6px; min-width: 16em; max-width: 34em; }
.card .t { color: var(--orange); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; }
.chip { border: 1px solid var(--muted); padding: 0 4px; color: var(--cream); }
.via { color: var(--orange); }
`;

export const APP_JS = String.raw`'use strict';
const $ = (id) => document.getElementById(id);
const usd = (v) => (v === null || v === undefined ? 'unknown' : '$' + v.toFixed(6));
const pct = (v) => (v === null ? 'n/a' : (v * 100).toFixed(0) + '%');
const short = (m) => (m === null ? 'no model' : m.split('/').pop());
let shown = null;
let timer = null;

function block(title, lines, wide) {
  const s = document.createElement('section');
  s.className = 'block' + (wide ? ' wide' : '');
  const h = document.createElement('h2');
  h.textContent = '== ' + title + ' ==';
  const p = document.createElement('pre');
  p.textContent = lines.length > 0 ? lines.join('\n') : '(none)';
  s.append(h, p);
  return s;
}

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt !== undefined) e.textContent = txt;
  return e;
}

// One horizontal bar chart. kind 'est' (hatched) or 'act' (solid) never share a chart.
// A null value is written as "unknown", never drawn as a zero bar.
function chart(title, kind, rows, fmt) {
  const c = el('div', 'chart');
  c.append(el('h3', '', title));
  const known = rows.map((r) => r.value).filter((v) => v !== null);
  const max = known.length > 0 ? Math.max(...known) : 0;
  if (rows.length === 0) c.append(el('div', 'unknown', '(no data)'));
  for (const r of rows) {
    const row = el('div', 'row');
    row.append(el('span', 'label', r.label));
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
const tok = (v) => v + ' tok';

// Slice colours: actuals in the orange family, estimates in the cream family, outcomes by kind.
const ACT_SHADES = ['#ff7a1a', '#c25510', '#ffa25c', '#8a3a08', '#ffc79a'];
const EST_SHADES = ['#e8dcc8', '#b8ab96', '#8c8278', '#f5efe4', '#6e665c'];
const OUTCOME_COLORS = { succeeded: '#ff7a1a', failed: '#ff4d2e', cancelled: '#8c8278', skipped: '#b8ab96', unfinished: '#3a3430' };

// Pixel donut: an 11x11 grid of cells, ring cells coloured by angle (clockwise from the top).
// Slices must be known, non-negative numbers; zero slices are left out of the ring and legend.
// The caller decides what to say when a value is unknown (no donut is drawn then).
function donut(title, slices, fmt) {
  const c = el('div', 'chart share-chart');
  c.append(el('h3', '', title));
  const shown = slices.filter((x) => x.value > 0);
  const total = shown.reduce((n, x) => n + x.value, 0);
  if (total === 0) {
    c.append(el('div', 'unknown', '(nothing to show)'));
    return c;
  }
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
        cell.style.background = shown[k].color;
      }
      grid.append(cell);
    }
  }
  const legend = el('div', 'legend');
  for (const x of shown) {
    const item = el('div', 'item');
    const sw = el('span', 'sw');
    sw.style.background = x.color;
    item.append(sw, el('span', '', x.label + ' ' + fmt(x.value) + ' (' + Math.round((x.value / total) * 100) + '%)'));
    legend.append(item);
  }
  wrap.append(grid, legend);
  c.append(wrap);
  return c;
}

// A 0..100% meter. A null rate is "n/a" with no fill element at all.
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

// One bar split into segments of the same kind family (e.g. input vs output tokens).
function stacked(title, kind, parts, fmt, why) {
  const c = el('div', 'chart');
  c.append(el('h3', '', title));
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

function section(title, wide) {
  const s = el('section', 'block' + (wide ? ' wide' : ''));
  s.append(el('h2', '', '== ' + title + ' =='));
  return s;
}

function usageBlock(title, rows, note) {
  const s = section(title, true);
  if (rows.length === 0) {
    s.append(el('pre', 'unknown', note));
    return s;
  }
  const pick = (f, why) => rows.map((r) => ({ label: r.label + ' (' + r.attempts + 'x)', value: f(r), why: why(r) }));
  s.append(
    chart('estimated USD (router, not spent)', 'est', pick((r) => r.estimated.usd, () => 'unpriced'), usd),
    chart('actual USD (reported by the runner)', 'act', pick((r) => r.actual.usd, () => 'unknown'), usd),
    chart('estimated tokens (planner)', 'est', pick((r) => tokensOf(r.estimated), () => 'unknown'), tok),
    chart('actual tokens (reported)', 'act', pick((r) => tokensOf(r.actual), () => 'not reported'), tok),
  );
  // Shares: one donut per side, never mixed. Drawn only when every part is known.
  const pair = el('div', 'pair');
  const share = (t, side, shades) => {
    const unknown = rows.filter((r) => r[side].usd === null).length;
    if (unknown > 0) {
      const c = el('div', 'chart share-chart');
      c.append(el('h3', '', t), el('div', 'unknown', 'unknown (' + unknown + ' of ' + rows.length + ' without a known amount)'));
      return c;
    }
    return donut(t, rows.map((r, i) => ({ label: r.label, value: r[side].usd, color: shades[i % shades.length] })), usd);
  };
  pair.append(share('estimated USD share', 'estimated', EST_SHADES), share('actual USD share', 'actual', ACT_SHADES));
  s.append(pair);
  // The numbers behind the bars, so nothing is only readable from a bar length.
  const n = (v) => (v === null ? 'unknown' : String(v));
  s.append(el('pre', 'note', rows.map((r) => r.label + ': ' + r.attempts + ' attempt(s) · estimated ' + n(r.estimated.inputTokens) + ' in / ' + n(r.estimated.outputTokens) + ' out, ' + usd(r.estimated.usd) + ' · actual ' + n(r.actual.inputTokens) + ' in / ' + n(r.actual.outputTokens) + ' out, ' + usd(r.actual.usd)).join('\n')));
  return s;
}

function outcomesBlock(r) {
  const o = r.outcomes;
  const s = section('Success and failure', false);
  s.append(donut('task outcomes (' + r.taskCount + ' tasks)', ['succeeded', 'failed', 'cancelled', 'skipped', 'unfinished'].map((k) => ({ label: k, value: o[k], color: OUTCOME_COLORS[k] })), String));
  s.append(meter('success rate', o.successRate));
  s.append(el('pre', '', 'succeeded ' + o.succeeded + ' · failed ' + o.failed + ' · cancelled ' + o.cancelled + ' · skipped ' + o.skipped + ' · unfinished ' + o.unfinished + '\nsuccess rate ' + pct(o.successRate) + ' · failure rate ' + pct(o.failureRate) + ' · soot-verified complete ' + o.complete + '/' + r.taskCount));
  return s;
}

function tokensBlock(r) {
  const s = section('Token usage', false);
  const e = r.tokens.estimated, a = r.tokens.actual;
  s.append(stacked('planned (planner estimate)', 'est', [{ label: 'in', value: e ? e.inputTokens : null }, { label: 'out', value: e ? e.outputTokens : null }], tok, 'no plan data'));
  s.append(stacked('reported (runner usage)', 'act', [{ label: 'in', value: a ? a.inputTokens : null }, { label: 'out', value: a ? a.outputTokens : null }], tok, 'not reported'));
  if (a && a.unreportedAttempts > 0) s.append(el('div', 'unknown', a.unreportedAttempts + ' attempt(s) reported nothing (not in the reported bar)'));
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

// Attempt timeline on one wall-clock axis from the run start to the latest known time.
// An attempt without a finish is drawn as a start tick only and labelled; never a done bar.
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
    row.append(el('span', 'label', x.t.id + ' #' + x.a.attempt + ' ' + short(x.a.model)));
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

// Count of checks by status as one stacked bar; null (no final validation) stays text.
function statusBar(title, checks) {
  const c = el('div', 'chart');
  c.append(el('h3', '', title));
  const row = el('div', 'row');
  if (checks === null) {
    row.append(el('span', 'label', ''), el('span', 'unknown', 'none recorded'), el('span', 'value unknown', 'n/a'));
    c.append(row);
    return c;
  }
  const counts = {};
  for (const ch of checks) counts[ch.status] = (counts[ch.status] || 0) + 1;
  const keys = Object.keys(counts).sort();
  row.append(el('span', 'label', checks.length + ' check(s)'));
  if (checks.length === 0) {
    row.append(el('span', 'unknown', 'none'), el('span', 'value', '0'));
  } else {
    const track = el('div', 'track');
    for (const k of keys) {
      const seg = el('div', 'bar ' + statusKind(k));
      seg.style.width = (counts[k] / checks.length) * 100 + '%';
      seg.title = k + ' ' + counts[k];
      track.append(seg);
    }
    row.append(track, el('span', 'value', keys.map((k) => k + ' ' + counts[k]).join(' · ')));
  }
  c.append(row);
  return c;
}

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
  s.append(el('pre', '', lines.join('\n')));
  return s;
}

function transitionsBlock(r) {
  const s = section('Model transitions', false);
  const counts = {};
  for (const e of r.transitions) counts[e.type] = (counts[e.type] || 0) + 1;
  if (r.transitions.length > 0) s.append(chart('count by type', 'cnt', Object.keys(counts).sort().map((k) => ({ label: k, value: counts[k], why: '' })), String));
  s.append(el('pre', '', r.transitions.length > 0 ? r.transitions.map((e) => e.type.toUpperCase() + ' ' + e.taskId + ' #' + e.attempt + ' → ' + (e.model || '-') + ': ' + e.reason).join('\n') : '(none)'));
  return s;
}

function assignmentBlock(r) {
  const a = r.assignment;
  const s = el('section', 'block wide');
  s.append(el('h2', '', '== Assignment: prompt → tasks → models =='));
  s.append(el('div', 'prompt', a.prompt));
  s.append(el('div', 'split', '│ split by the planner into ' + a.tasks.length + ' task(s); runner: ' + (r.agent.label || 'unknown (no saved report yet)')));
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
        const chip = el('span', 'chip', '#' + x.attempt + ' ' + (x.routedModel || 'no model') + ' [' + x.state + ']');
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

async function getJson(path) {
  const r = await fetch(path, { cache: 'no-store' });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}

function identBlock(r) {
  const duration = r.duration.ms === null ? (r.running ? 'running' : 'unknown') : (r.duration.ms / 1000).toFixed(1) + ' s';
  // One-line ident so the first screen can lead with charts, not the full prompt.
  return block('Run', [r.runId + '  ·  ' + r.state + (r.running ? ' (running)' : '') + '  ·  ' + duration], true);
}

// Insights first: compact ident, assignment graph, usage charts and the legend, then the
// remaining charts, then the text detail blocks (task graph, agents, full prompt, savings).
const BLOCKS = [
  (r) => identBlock(r),
  (r) => assignmentBlock(r),
  (r) => usageBlock('Usage by model (also the cost-by-model numbers)', r.usage.byModel, r.usage.note),
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
    'started  ' + (r.duration.startedAt || 'unknown'),
    'duration ' + (r.duration.ms === null ? (r.running ? 'running' : 'unknown') : (r.duration.ms / 1000).toFixed(1) + ' s') + '  (' + r.duration.basis + ')',
    '',
    'Prompt:',
    r.prompt,
  ]),
  (r) => block('Savings', [r.savings.note]),
];

async function showRun(runId) {
  clearTimeout(timer);
  const main = $('run');
  try {
    const { run } = await getJson('/api/runs/' + encodeURIComponent(runId));
    shown = runId;
    main.replaceChildren(...BLOCKS.map((b) => b(run)));
    for (const b of document.querySelectorAll('nav button')) b.classList.toggle('current', b.dataset.run === runId);
    if (run.running) timer = setTimeout(() => { void refresh(); }, 1500);
  } catch (e) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = 'Could not load run ' + runId + ': ' + e.message;
    main.replaceChildren(p);
  }
}

async function refresh() {
  const nav = $('runs');
  try {
    const { runs } = await getJson('/api/runs');
    nav.replaceChildren();
    if (runs.length === 0) {
      nav.textContent = 'No runs in this state directory yet (start one with soot run).';
      $('run').replaceChildren();
      return;
    }
    for (const r of [...runs].reverse()) {
      const b = document.createElement('button');
      b.dataset.run = r.runId;
      b.textContent = '[' + r.state + '] ' + r.runId + ' · ' + r.tasks + ' tasks';
      b.title = r.prompt;
      b.addEventListener('click', () => { location.hash = encodeURIComponent(r.runId); });
      nav.append(b);
    }
    const wanted = decodeURIComponent(location.hash.slice(1)) || shown || runs[runs.length - 1].runId;
    await showRun(wanted);
  } catch (e) {
    nav.textContent = 'Could not reach the soot dashboard API: ' + e.message;
  }
}

window.addEventListener('hashchange', () => { void showRun(decodeURIComponent(location.hash.slice(1))); });
void refresh();
`;
