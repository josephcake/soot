import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { usageCharts } from './charts.js';
import { APP_JS } from './ui.js';
import { toDashboardRun } from './view.js';

/*
 * Runs the page script's chart blocks against a tiny fake DOM, so the drawn blocks are checked
 * from the same run payload the API serves: unknown values are written as text with no bar, and
 * estimates and actuals never share a chart.
 */

interface FakeNode {
  tag: string;
  className: string;
  textContent: string;
  title: string;
  style: { width?: string; left?: string; background?: string; backgroundColor?: string };
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  children: FakeNode[];
  width?: number;
  height?: number;
  clientWidth?: number;
  clientHeight?: number;
  dataset?: Record<string, string>;
  _calls: unknown[];
  _ctx?: unknown;
  append(...n: FakeNode[]): void;
  replaceChildren?(...n: FakeNode[]): void;
  addEventListener?(type: string, fn: () => void): void;
  getContext?(type: string): unknown;
}

function node(tag: string): FakeNode {
  const n: FakeNode = {
    tag,
    className: '',
    textContent: '',
    title: '',
    style: {},
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    removeAttribute(k) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.attrs[k];
    },
    children: [],
    width: 0,
    height: 0,
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    _calls: [],
    append(...c) {
      this.children.push(...c);
    },
    replaceChildren(...c) {
      this.children = c;
    },
    addEventListener() {
      /* tests do not fire events */
    },
    getContext(type: string) {
      if (tag !== 'canvas' || type !== '2d') return null;
      if (!this._ctx) {
        const calls = this._calls;
        const ctx: Record<string, unknown> = {
          measureText: (t: string) => ({ width: t.length * 7 }),
          fillRect: (...a: unknown[]) => calls.push(['fillRect', a]),
          fillText: (...a: unknown[]) => calls.push(['fillText', a]),
          strokeRect: (...a: unknown[]) => calls.push(['strokeRect', a]),
          clearRect: (...a: unknown[]) => calls.push(['clearRect', a]),
        };
        this._ctx = new Proxy(ctx, {
          set(t, prop, v) {
            const key = typeof prop === 'string' ? prop : prop.toString();
            calls.push(['set', key, v]);
            t[key] = v;
            return true;
          },
        });
      }
      return this._ctx;
    },
  };
  return n;
}

const all = (n: FakeNode): FakeNode[] => [n, ...n.children.flatMap(all)];
const at = (list: FakeNode[], i: number): FakeNode => {
  const n = list[i];
  if (n === undefined) throw new Error(`no node ${String(i)}`);
  return n;
};
const text = (n: FakeNode): string =>
  all(n)
    .map((x) => x.textContent)
    .join(' ');

function load() {
  const byId: Record<string, FakeNode> = {};
  const fake = {
    __byId: byId,
    document: {
      createElement: node,
      addEventListener: () => undefined,
      getElementById: (id: string) => (byId[id] ??= node('div')),
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined },
    location: { hash: '' },
    fetch: () => new Promise(() => undefined),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  return runInNewContext(
    `${APP_JS}\n;({ chart, usageBlock, assignmentBlock, donut, meter, outcomesBlock, tokensBlock, costBlock, timelineBlock, validationBlock, transitionsBlock, BLOCKS, AGG_BLOCKS, ACT_SHADES, EST_SHADES, MODEL_COLORS, MODEL_PATTERNS, drawFlow, renderPrompts, summaryBlock, taskTableBlock, moreChartsBlock, aboutBlock, detailRows, detailTotals, fmtDuration, fmtUsd, parseRoute, truncate, fmtDate, buildModelStyles, modelStyle, useModels, tilesFor, patternInk, notFoundBlock, promptRow, gridModel, localWindow, filterPrompts, scaleLevels, renderGrid, cellLines, GRID_LEGEND, STACK_CAP, __byId });`,
    fake,
  ) as {
    chart: (title: string, kind: string, rows: unknown[], fmt: (v: number) => string) => FakeNode;
    usageBlock: (
      title: string,
      rows: unknown[],
      note: string,
      opts?: { byModel: boolean },
    ) => FakeNode;
    assignmentBlock: (run: unknown) => FakeNode;
    donut: (title: string, slices: unknown[], fmt: (v: number) => string) => FakeNode;
    meter: (title: string, rate: number | null) => FakeNode;
    outcomesBlock: (run: unknown) => FakeNode;
    tokensBlock: (run: unknown) => FakeNode;
    costBlock: (run: unknown) => FakeNode;
    timelineBlock: (run: unknown) => FakeNode;
    validationBlock: (run: unknown) => FakeNode;
    transitionsBlock: (run: unknown) => FakeNode;
    BLOCKS: ((run: unknown) => FakeNode)[];
    AGG_BLOCKS: ((overview: unknown) => FakeNode)[];
    ACT_SHADES: string[];
    EST_SHADES: string[];
    MODEL_COLORS: string[];
    MODEL_PATTERNS: string[];
    parseRoute: (hash: string) => { view: string; runId?: string };
    truncate: (s: string, max: number) => string;
    fmtDate: (iso: string | null, locale?: string, timeZone?: string) => string | null;
    buildModelStyles: (
      names: (string | null)[],
    ) => Record<string, { color: string; pattern: string; index: number }>;
    modelStyle: (name: string | null) => { color: string; pattern: string; index: number };
    useModels: (names: string[]) => void;
    tilesFor: (overview: unknown) => FakeNode[];
    patternInk: (pattern: string, i: number, j: number) => boolean;
    notFoundBlock: (runId: string) => FakeNode;
    promptRow: (p: unknown) => FakeNode;
    gridModel: (
      prompts: unknown[],
      zoom: string,
      now: number,
      off?: (ms: number) => number,
    ) => Grid;
    localWindow: (
      ms: number,
      unit: string,
      off: (ms: number) => number,
    ) => { from: number; to: number };
    filterPrompts: (
      prompts: unknown[],
      filter: { from: string; to: string } | null,
    ) => { runId: string }[];
    scaleLevels: (values: number[]) => number[];
    renderGrid: (ov: unknown, zoom: string, now: number, off?: (ms: number) => number) => Grid;
    cellLines: (cell: unknown, zoom: string) => string[];
    GRID_LEGEND: Record<string, string>;
    STACK_CAP: number;
    __byId: Record<string, FakeNode>;
    drawFlow: (canvas: FakeNode, overview: unknown) => void;
    renderPrompts: (prompts: unknown[]) => void;
    summaryBlock: (run: unknown) => FakeNode;
    taskTableBlock: (run: unknown) => FakeNode;
    moreChartsBlock: (run: unknown) => FakeNode & { open?: boolean };
    aboutBlock: (run: unknown) => FakeNode;
    detailRows: (run: unknown) => { planning: unknown; tasks: unknown[] };
    detailTotals: (rows: unknown) => { cost: { usd: number | null }; rows: number };
    fmtDuration: (ms: number | null) => string | null;
    fmtUsd: (v: number | null) => string;
  };
}

interface GridCell {
  kind: string;
  level?: number;
  href?: string | null;
  from?: number;
  to?: number;
  prompts?: number;
  tasks?: number;
  tokens?: number | null;
  activity?: number;
  prompt?: { runId: string };
}
interface Grid {
  zoom: string;
  rows: number;
  total: number;
  undated: number;
  columns: {
    key: string;
    label: string;
    cells: GridCell[];
    overflow?: number;
    overflowHref?: string;
  }[];
}

const bars = (n: FakeNode) => all(n).filter((x) => /^bar( |$)/.test(x.className));
const charts = (n: FakeNode) => all(n).filter((x) => x.className.startsWith('chart'));
const ringCells = (n: FakeNode) => all(n).filter((x) => x.className.startsWith('px k-'));
/** A bar's family: est (est, est-2), act (act, act-2), or something else. */
const family = (b: FakeNode) => {
  const k = b.className.split(' ').find((c) => c !== 'bar' && c !== 'span') ?? '';
  return k.startsWith('est') ? 'est' : k.startsWith('act') ? 'act' : k;
};

describe('page chart blocks', () => {
  const ui = load();

  it('draws a bar only for known values and writes "unknown" for null', () => {
    const c = ui.chart(
      'actual USD',
      'act',
      [
        { label: 'a', value: 0.002, why: '' },
        { label: 'b', value: null, why: 'not reported' },
        { label: 'c', value: 0, why: '' },
      ],
      (v) => `$${v.toFixed(3)}`,
    );
    const rows = c.children.filter((n) => n.className === 'row');
    expect(rows).toHaveLength(3);
    const bars = (r: FakeNode) => all(r).filter((n) => n.className.startsWith('bar'));
    expect(bars(at(rows, 0)).map((b) => [b.className, b.style.width])).toEqual([
      ['bar act', '100%'],
    ]);
    expect(bars(at(rows, 1))).toEqual([]);
    expect(text(at(rows, 1))).toContain('unknown');
    expect(text(at(rows, 1))).toContain('not reported');
    expect(text(at(rows, 1))).not.toContain('$');
    // A reported zero is a real value: drawn as an empty bar with its number.
    expect(bars(at(rows, 2)).map((b) => b.style.width)).toEqual(['0%']);
    expect(text(at(rows, 2))).toContain('$0.000');
  });

  it('usage blocks keep estimate and actual charts apart', () => {
    const usage = usageCharts(
      {
        cost: {
          tasks: [
            {
              taskId: 't',
              estimated: { inputTokens: 10, outputTokens: 1 },
              attempts: [
                {
                  attempt: 1,
                  model: 'm',
                  estimatedUsd: 0.01,
                  inputTokens: null,
                  outputTokens: null,
                  actualUsd: null,
                },
              ],
            },
          ],
        },
      },
      'mock',
    );
    const block = ui.usageBlock('Usage by model', [...usage.byModel], usage.note);
    const charts = all(block).filter((n) => n.className === 'chart');
    expect(charts.map((c) => c.children[0]?.textContent)).toEqual([
      'estimated USD (router, not spent)',
      'actual USD (reported by the runner)',
      'estimated tokens (planner)',
      'actual tokens (reported)',
    ]);
    for (const c of charts) {
      const kinds = new Set(
        all(c)
          .filter((n) => n.className.startsWith('bar '))
          .map((n) => n.className),
      );
      expect(kinds.size).toBeLessThanOrEqual(1);
    }
    // Actual cost and tokens were never reported: written as unknown, no bar drawn.
    for (const c of charts.slice(1, 2).concat(charts.slice(3))) {
      expect(all(c).filter((n) => n.className.startsWith('bar '))).toEqual([]);
      expect(text(c)).toContain('unknown');
    }
  });

  it('assignment block shows the prompt, each task, and the model chain with the transition', () => {
    const run = toDashboardRun(
      {
        runId: 'r',
        prompt: 'the whole prompt',
        agentLabel: 'mock',
        tasks: [
          {
            taskId: 'x',
            title: 'Part X',
            instructions: 'do x',
            dependsOn: [],
            state: 'succeeded',
            attemptDetails: [
              { attempt: 1, state: 'retried', model: 'p/small' },
              { attempt: 2, state: 'succeeded', model: 'p/mid' },
            ],
          },
        ],
        events: [
          { type: 'assign', taskId: 'x', attempt: 1, model: 'p/small', reason: 'cheap' },
          { type: 'escalate', taskId: 'x', attempt: 2, model: 'p/mid', reason: 'failed' },
        ],
      },
      null,
    );
    const t = text(ui.assignmentBlock(run));
    expect(t).toContain('the whole prompt');
    expect(t).toContain('split by the planner into 1 task(s); runner: mock');
    expect(t).toContain('Part X');
    expect(t).toMatch(/#1 p\/small \[retried\].*⇒ ESCALATE.*#2 p\/mid \[succeeded\]/);
  });

  const baseRun = (over: Record<string, unknown> = {}) =>
    toDashboardRun(
      {
        runId: 'r',
        state: 'incomplete',
        running: false,
        prompt: 'p',
        createdAt: '2026-11-12T10:00:00.000Z',
        reportStatus: 'incomplete',
        finalValidation: null,
        problems: ['working tree not updated'],
        tasks: [
          {
            taskId: 'a',
            state: 'succeeded',
            checks: [
              { name: 'test', kind: 'test', status: 'passed', exitCode: 0 },
              { name: 'lint', kind: 'lint', status: 'failed', exitCode: 1 },
            ],
            attemptDetails: [
              {
                attempt: 1,
                state: 'succeeded',
                model: 'p/small',
                startedAt: '2026-11-12T10:00:01.000Z',
                finishedAt: '2026-11-12T10:00:03.000Z',
              },
            ],
          },
          {
            taskId: 'b',
            state: 'running',
            checks: [],
            attemptDetails: [
              {
                attempt: 1,
                state: 'running',
                model: 'p/mid',
                startedAt: '2026-11-12T10:00:02.000Z',
                finishedAt: null,
              },
            ],
          },
        ],
        events: [{ type: 'escalate', taskId: 'b', attempt: 1, model: 'p/mid', reason: 'r' }],
        ...over,
      },
      null,
    );

  it('outcome donut leaves zero slices out of the ring and the legend', () => {
    const block = ui.outcomesBlock(baseRun());
    const donutChart = at(charts(block), 0);
    // 1 succeeded, 1 unfinished; failed/cancelled/skipped are zero.
    const legend = text(donutChart);
    expect(legend).toContain('succeeded 1 (50%)');
    expect(legend).toContain('unfinished 1 (50%)');
    for (const zero of ['failed', 'cancelled', 'skipped']) expect(legend).not.toContain(zero);
    expect(new Set(ringCells(donutChart).map((c) => c.className))).toEqual(
      new Set(['px k-0', 'px k-1']),
    );
    // Nothing at all: no ring is drawn.
    const empty = ui.donut('x', [{ label: 'a', value: 0, color: '#000' }], String);
    expect(ringCells(empty)).toEqual([]);
    expect(text(empty)).toContain('(nothing to show)');
  });

  it('a null rate is n/a with no fill; a real 0% has an empty fill', () => {
    const na = ui.meter('success rate', null);
    expect(bars(na)).toEqual([]);
    expect(text(na)).toContain('n/a');
    expect(text(na)).not.toContain('0%');
    const zero = ui.meter('success rate', 0);
    expect(bars(zero).map((b) => b.style.width)).toEqual(['0%']);
    expect(text(zero)).toContain('0%');
    const noneFinished = ui.outcomesBlock(
      baseRun({ tasks: [{ taskId: 'x', state: 'running', attemptDetails: [] }] }),
    );
    expect(text(noneFinished)).toContain('n/a');
  });

  it('token and cost charts never put an estimate and an actual in one chart', () => {
    const run = toDashboardRun(
      { runId: 'r', prompt: 'p', tasks: [{ taskId: 'a', state: 'succeeded' }] },
      {
        cost: {
          totals: {
            estimated: { inputTokens: 100, outputTokens: 20, usd: 0.01 },
            actual: {
              inputTokens: 80,
              outputTokens: 10,
              usd: null,
              unpricedAttempts: 1,
              unreportedAttempts: 0,
            },
          },
        },
        costSummary: { routed: { costUsd: 0.012 } },
      },
    );
    for (const block of [ui.tokensBlock(run), ui.costBlock(run)]) {
      for (const c of charts(block))
        expect(new Set(bars(c).map(family)).size).toBeLessThanOrEqual(1);
    }
    const tokens = charts(ui.tokensBlock(run));
    expect(
      tokens.map((c) => [c.children[0]?.textContent, [...new Set(bars(c).map(family))]]),
    ).toEqual([
      ['planned (planner estimate)', ['est']],
      ['reported (runner usage)', ['act']],
    ]);
    // Stacked input/output split of the planned bar: 100 in, 20 out.
    expect(bars(at(tokens, 0)).map((b) => b.style.width)).toEqual([
      `${String((100 / 120) * 100)}%`,
      `${String((20 / 120) * 100)}%`,
    ]);
    const cost = charts(ui.costBlock(run));
    expect(cost.map((c) => c.children[0]?.textContent)).toEqual([
      'estimates (not spent)',
      'actual (reported)',
    ]);
    expect(bars(at(cost, 0)).map(family)).toEqual(['est', 'est']);
    // Unpriced actual: unknown with its reason, no bar.
    expect(bars(at(cost, 1))).toEqual([]);
    expect(text(at(cost, 1))).toContain('1 unpriced attempt(s)');

    const unknown = ui.tokensBlock(toDashboardRun({ runId: 'r', prompt: 'p', tasks: [] }, null));
    expect(bars(unknown)).toEqual([]);
    expect(text(unknown)).toContain('not reported');
  });

  it('usage share donuts are per side, and an unknown side draws no donut', () => {
    const usage = usageCharts(
      {
        cost: {
          tasks: [
            {
              taskId: 't',
              estimated: { inputTokens: 10, outputTokens: 1 },
              attempts: [
                {
                  attempt: 1,
                  model: 'm1',
                  estimatedUsd: 0.01,
                  inputTokens: 5,
                  outputTokens: 1,
                  actualUsd: 0.02,
                },
                {
                  attempt: 2,
                  model: 'm2',
                  estimatedUsd: 0.03,
                  inputTokens: null,
                  outputTokens: null,
                  actualUsd: null,
                },
              ],
            },
          ],
        },
      },
      'mock',
    );
    ui.useModels(['m1', 'm2']);
    const block = ui.usageBlock('Usage by model', [...usage.byModel], usage.note, {
      byModel: true,
    });
    const shares = all(block).filter((n) => n.className === 'chart share-chart');
    expect(shares.map((c) => c.children[0]?.textContent)).toEqual([
      'estimated USD share',
      'actual USD share',
    ]);
    const estCells = ringCells(at(shares, 0));
    expect(estCells.length).toBeGreaterThan(0);
    // By model, each slice wears its model's colour and pattern (same as the canvas).
    expect(new Set(estCells.map((c) => c.style.backgroundColor))).toEqual(
      new Set([ui.modelStyle('m1').color, ui.modelStyle('m2').color]),
    );
    expect(estCells.some((c) => c.className.includes('pat-' + ui.modelStyle('m2').pattern))).toBe(
      true,
    );
    // By task (not models), the estimate shades are kept.
    const byTask = ui.usageBlock('Usage by task', [...usage.byTask], usage.note);
    const taskCells = ringCells(
      at(
        all(byTask).filter((n) => n.className === 'chart share-chart'),
        0,
      ),
    );
    expect(taskCells.every((c) => ui.EST_SHADES.includes(c.style.background ?? ''))).toBe(true);
    // One model's actual is unknown: no actual donut, only the reason.
    expect(ringCells(at(shares, 1))).toEqual([]);
    expect(text(at(shares, 1))).toContain('unknown (1 of 2 without a known amount)');
    // The numbers stay readable as text.
    expect(text(block)).toContain(
      'm2: 1 attempt(s) · estimated 10 in / 1 out, $0.030000 · actual unknown in / unknown out, unknown',
    );
  });

  it('timeline: a still-running attempt is a start tick, never a finished bar', () => {
    const run = baseRun({ running: true, state: 'running' });
    const block = ui.timelineBlock(run);
    const rows = all(block).filter((n) => n.className === 'row');
    expect(rows.map((r) => (r.children[0] ? text(r.children[0]).trim() : ''))).toEqual([
      'run total',
      'a #1 small',
      'b #1 mid',
    ]);
    // Run total while running: labelled, no bar.
    expect(bars(at(rows, 0))).toEqual([]);
    expect(text(at(rows, 0))).toContain('still running');
    // Finished attempt: a bar from 1 s to 3 s on a 0..3 s axis.
    const done = bars(at(rows, 1));
    expect(done).toHaveLength(1);
    expect(parseFloat(at(done, 0).style.left ?? '')).toBeCloseTo(100 / 3);
    expect(parseFloat(at(done, 0).style.width ?? '')).toBeCloseTo(200 / 3);
    // Running attempt: only a tick at its start, and a label.
    expect(bars(at(rows, 2))).toEqual([]);
    expect(
      all(at(rows, 2))
        .filter((n) => n.className === 'tick')
        .map((n) => n.style.left),
    ).toEqual([`${String((2 / 3) * 100)}%`]);
    expect(text(at(rows, 2))).toContain('running (no end yet)');
  });

  it('validation counts checks by status; no final validation stays text', () => {
    const block = ui.validationBlock(baseRun());
    const [taskChecks, final] = charts(block);
    expect(taskChecks && bars(taskChecks).map((b) => [b.className, b.style.width])).toEqual([
      ['bar fail', '50%'],
      ['bar pass', '50%'],
    ]);
    expect(taskChecks && text(taskChecks)).toContain('failed 1 · passed 1');
    expect(final && bars(final)).toEqual([]);
    expect(final && text(final)).toContain('none recorded');
    expect(text(block)).toContain('problem: working tree not updated');
  });

  it('transitions: a count chart plus the reasons as text', () => {
    const block = ui.transitionsBlock(baseRun());
    expect(bars(block).map((b) => b.className)).toEqual(['bar cnt']);
    expect(text(block)).toContain('ESCALATE b #1 → p/mid: r');
    expect(bars(ui.transitionsBlock(baseRun({ events: [] })))).toEqual([]);
  });

  it('the prompt page is a summary, one task table, then collapsed charts and notes', () => {
    const run = baseRun();
    const sections = ui.BLOCKS.map((b) => b(run));
    expect(sections.map((s) => [s.tag, s.className])).toEqual([
      ['section', 'block wide dsum-block'],
      ['section', 'block wide'],
      ['details', 'block wide more-charts'],
      ['details', 'block wide about'],
    ]);
    expect(at(sections, 1).children[0]?.textContent).toBe('Tasks');
    expect(at(sections, 2).children[0]?.textContent).toBe('More charts');
    expect(at(sections, 3).children[0]?.textContent).toBe('About these numbers');
    const summary = text(at(sections, 0));
    for (const k of ['Total cost', 'Tokens in / out', 'Tasks', 'Status', 'Duration']) {
      expect(summary).toContain(k);
    }
    expect(summary).toContain('incomplete');
    expect(summary).toMatch(/Nov 12/);
    expect(summary).not.toContain('2026-11-12T10:00:00.000Z');
    // The honest-limit notes live only in the footnote, not inline on the page.
    expect(text(at(sections, 3))).toContain('not per task');
    expect(text(at(sections, 1))).not.toContain('not per task');
  });

  it('charts are collapsed under "More charts" by default and keep every chart', () => {
    const d = ui.moreChartsBlock(baseRun());
    expect(d.tag).toBe('details');
    expect(d.open).toBeUndefined();
    expect(d.attrs.open).toBeUndefined();
    const titles = all(d)
      .filter((n) => n.tag === 'section')
      .map((n) => n.children[0]?.textContent);
    expect(titles).toContain('Assignment: prompt → tasks → models');
    expect(titles).toContain('Duration (attempt timeline)');
    expect(titles).toContain('Cost');
  });

  interface Att {
    model: string;
    actualUsd: number | null;
    estimatedUsd: number | null;
    inputTokens: number;
    outputTokens: number;
  }
  // Runner reported a cost / priced model with nothing reported / model with no registry price.
  const ACT: Att = {
    model: 'p/small',
    actualUsd: 0.5,
    estimatedUsd: 0.4,
    inputTokens: 800,
    outputTokens: 200,
  };
  const EST: Att = {
    model: 'p/mid',
    actualUsd: null,
    estimatedUsd: 0.0001,
    inputTokens: 0,
    outputTokens: 0,
  };
  const NOPRICE: Att = {
    model: 'p/free',
    actualUsd: null,
    estimatedUsd: null,
    inputTokens: 0,
    outputTokens: 0,
  };
  const costRun = (tasks: Record<string, Att[]>, decomposition?: unknown) =>
    toDashboardRun(
      {
        runId: 'r',
        prompt: 'do it',
        agentLabel: 'mock-test-double',
        createdAt: '2026-11-12T10:00:00.000Z',
        tasks: Object.entries(tasks).map(([id, atts]) => ({
          taskId: id,
          title: 'Task ' + id.toUpperCase(),
          state: 'succeeded',
          models: atts.map((x) => x.model),
          attemptDetails: atts.map((x, i) => ({
            attempt: i + 1,
            state: 'succeeded',
            model: x.model,
          })),
        })),
        ...(decomposition === undefined ? {} : { decomposition }),
      },
      {
        cost: {
          tasks: Object.entries(tasks).map(([id, atts]) => ({
            taskId: id,
            attempts: atts.map((x, i) => ({ attempt: i + 1, ...x })),
            actual: {
              usd: null,
              unpricedAttempts: atts.filter((x) => x.actualUsd === null).length,
              unreportedAttempts: 0,
            },
          })),
        },
      },
    );
  const pricedRun = () => costRun({ a: [ACT], b: [EST] });
  const EST_WHY = "estimate from planned tokens × official price; runner didn't report usage";

  const rowsOf = (n: FakeNode) => all(n).filter((x) => x.tag === 'tr');
  /** [task, tokens in, tokens out, cost] cell text and the cost cell, for task row i (0-based). */
  const taskRow = (run: unknown, i: number) => {
    const tds = at(rowsOf(ui.taskTableBlock(run)), i + 2).children;
    return { cells: tds.map((td) => text(td).trim()), cost: at(tds, 4), tokIn: at(tds, 2) };
  };
  const totalRow = (run: unknown) => {
    const rows = rowsOf(ui.taskTableBlock(run));
    const tr = at(rows, rows.length - 1);
    expect(tr.className).toBe('totals');
    return { text: text(tr).replace(/\s+/g, ' ').trim(), cost: at(tr.children, 4) };
  };

  it('a reported actual cost is shown as is, with its tokens', () => {
    const run = costRun({ a: [ACT] });
    const row = taskRow(run, 0);
    expect(row.cells.slice(2)).toEqual(['800', '200', '$0.50']);
    expect(row.cost.title).toBe('$0.500000');
    const total = totalRow(run);
    expect(total.text).toBe('Total 800 200 $0.50');
    expect(total.cost.title).toBe('Rows: 1 actual, 0 estimated, 0 unpriced.');
  });

  it('a priced model with nothing reported shows the router estimate and "not reported" tokens', () => {
    const run = costRun({ b: [EST] });
    const row = taskRow(run, 0);
    expect(row.cells.slice(2)).toEqual(['not reported', 'not reported', '~$0.0001 est.']);
    expect(row.cost.title).toBe(EST_WHY);
    expect(all(row.cost).some((n) => n.className === 'muted-val')).toBe(true);
    expect(row.tokIn.className).toBe('num muted-val');
    expect(row.cells.join(' ')).not.toContain('price not set');
    expect(totalRow(run).text).toBe('Total — — ~$0.0001 est.');
    // A priced model (estimated elsewhere in the run) with no estimate either: not reported.
    const missing = costRun({ b: [EST], d: [{ ...NOPRICE, model: 'p/mid' }] });
    expect(taskRow(missing, 1).cells[4]).toBe('not reported');
    expect(totalRow(missing).text).toBe('Total — — ~$0.0001 est. partial');
  });

  it('only a model with no registry price reads "price not set", never $0', () => {
    const run = costRun({ c: [NOPRICE] });
    const row = taskRow(run, 0);
    expect(row.cells.slice(2)).toEqual(['not reported', 'not reported', 'price not set']);
    expect(row.cells.join(' ')).not.toMatch(/\$0(\.0+)?\b/);
    expect(totalRow(run).text).toBe('Total — — price not set');
  });

  it('total labels: actual only, with est., with partial, with both', () => {
    expect(totalRow(costRun({ a: [ACT] })).text).toBe('Total 800 200 $0.50');
    expect(totalRow(costRun({ a: [ACT], b: [EST] })).text).toBe('Total 800 200 ~$0.50 est.');
    expect(totalRow(costRun({ a: [ACT], c: [NOPRICE] })).text).toBe('Total 800 200 $0.50 partial');
    const both = costRun({ a: [ACT], b: [EST], c: [NOPRICE] });
    const total = totalRow(both);
    expect(total.text).toBe('Total 800 200 ~$0.50 est. partial');
    expect(total.cost.title).toBe(
      'Rows: 1 actual, 1 estimated, 1 unpriced. Estimates are planned tokens × official price. Rows with no amount are not in this total.',
    );
    const tot = ui.detailTotals(ui.detailRows(both));
    expect(tot.cost.usd).toBeCloseTo(0.5001, 10);
    // The summary tile reads the same as the Totals row.
    const summary = text(ui.summaryBlock(both));
    expect(summary).toContain('~$0.50 est. partial');
  });

  it('a retried task adds its actual and estimated attempts', () => {
    const run = costRun({ a: [EST, ACT] });
    expect(taskRow(run, 0).cells.slice(2)).toEqual(['800', '200', '~$0.50 est.']);
  });

  it('the planning row: actual when priced, not reported, or price not set', () => {
    const plan = (extra: Record<string, unknown>) =>
      costRun(
        { a: [ACT] },
        {
          kind: 'model',
          modelRef: 'p/plan',
          servedModelId: 'plan-1',
          usage: { inputTokens: 100, outputTokens: 30 },
          attempts: 1,
          ...extra,
        },
      );
    const basis = { ref: 'p/plan', source: 'https://example.invalid', asOf: '2026-11-13' };
    const priced = plan({ costUsd: 0.25, priceBasis: basis });
    const p = text(at(rowsOf(ui.taskTableBlock(priced)), 1)).replace(/\s+/g, ' ');
    expect(p).toContain('Planning');
    expect(p).toContain('100 30 $0.25');
    expect(totalRow(priced).text).toBe('Total 900 230 $0.75');
    const unreported = plan({ costUsd: null, priceBasis: basis });
    expect(text(at(rowsOf(ui.taskTableBlock(unreported)), 1))).toContain('not reported');
    expect(totalRow(unreported).text).toBe('Total 900 230 $0.50 partial');
    const unpriced = plan({ costUsd: null, priceBasis: null });
    expect(text(at(rowsOf(ui.taskTableBlock(unpriced)), 1))).toContain('price not set');
    expect(totalRow(unpriced).cost.title).toBe(
      'Rows: 1 actual, 0 estimated, 1 unpriced. Rows with no amount are not in this total.',
    );
  });

  it('fmtUsd never rounds a real amount to $0.00', () => {
    expect(ui.fmtUsd(1.234)).toBe('$1.23');
    expect(ui.fmtUsd(0.0009)).toBe('$0.0009');
    expect(ui.fmtUsd(0.00001)).toBe('<$0.0001');
    expect(ui.fmtUsd(0)).toBe('$0.00');
  });

  it('the planning row says "not recorded" when the run does not include it', () => {
    const run = pricedRun();
    expect(ui.detailRows(run).planning).toBeNull();
    const planning = at(rowsOf(ui.taskTableBlock(run)), 1);
    expect(planning.className).toBe('planning');
    expect(text(planning).trim()).toBe('Planning not recorded');
    expect(text(ui.aboutBlock(run))).toContain('does not include its planning call');
    // A fixture plan made no model call: shown as such and never makes the total partial.
    const fixture = costRun({}, { kind: 'fixture', usage: null, attempts: 0 });
    expect(text(at(rowsOf(ui.taskTableBlock(fixture)), 1))).toContain('no model call');
  });

  it('who took it shows each model (with its swatch) and the runner tag', () => {
    const rows = rowsOf(ui.taskTableBlock(pricedRun()));
    const a = at(rows, 2);
    expect(text(a)).toContain('small');
    expect(text(a)).toContain('mock-test-double');
    expect(all(a).some((n) => n.className.startsWith('sw'))).toBe(true);
  });

  it('formats duration for people', () => {
    expect(ui.fmtDuration(null)).toBeNull();
    expect(ui.fmtDuration(850)).toBe('850ms');
    expect(ui.fmtDuration(4200)).toBe('4.2s');
    expect(ui.fmtDuration(14_000)).toBe('14s');
    expect(ui.fmtDuration(134_000)).toBe('2m 14s');
    expect(ui.fmtDuration(3_780_000)).toBe('1h 3m');
    expect(text(ui.summaryBlock(baseRun()))).toContain('Duration');
  });

  it('drawFlow paints a no-data block when there are no runs, and fills prompt text safely', () => {
    const empty = node('canvas');
    ui.drawFlow(empty, { prompts: [], flows: [], byModel: [], promptCount: 0, taskCount: 0 });
    const emptyText = empty._calls
      .filter((c) => Array.isArray(c) && c[0] === 'fillText')
      .map((c) => (c as [string, unknown[]])[1][0]);
    expect(emptyText).toContain('no data');
    expect(
      empty._calls.some(
        (c) =>
          Array.isArray(c) && c[0] === 'set' && c[1] === 'imageSmoothingEnabled' && c[2] === false,
      ),
    ).toBe(true);

    const nasty = '<img src=x onerror=alert(1)> & prompt';
    const canvas = node('canvas');
    ui.drawFlow(canvas, {
      promptCount: 2,
      taskCount: 3,
      prompts: [
        {
          runId: 'r1',
          prompt: nasty,
          createdAt: '2026-11-12T11:00:00.000Z',
          taskCountsByModel: [{ model: 'p/small', tasks: 2 }],
        },
        {
          runId: 'r2',
          prompt: 'other',
          createdAt: '2026-11-12T10:00:00.000Z',
          taskCountsByModel: [{ model: 'p/mid', tasks: 1 }],
        },
      ],
      flows: [
        { runId: 'r1', prompt: nasty, model: 'p/small', tasks: 2 },
        { runId: 'r2', prompt: 'other', model: 'p/mid', tasks: 1 },
      ],
      byModel: [
        { model: 'p/small', tasks: 2 },
        { model: 'p/mid', tasks: 1 },
      ],
    });
    const texts = canvas._calls
      .filter((c) => Array.isArray(c) && c[0] === 'fillText')
      .map((c) => String((c as [string, unknown[]])[1][0]));
    expect(texts.some((t) => t.includes(nasty) || t.includes('<img'))).toBe(true);
    expect(texts.join(' ')).not.toMatch(/innerHTML|createElement/);
    // Pipes and model bars wear the shared model styles: p/mid sorts first (orange, solid),
    // p/small second (cream, hatched with page-coloured ink).
    ui.useModels(['p/small', 'p/mid']);
    const styled = node('canvas');
    ui.drawFlow(styled, {
      promptCount: 2,
      taskCount: 3,
      prompts: [
        { runId: 'r1', prompt: 'a', taskCountsByModel: [{ model: 'p/small', tasks: 2 }] },
        { runId: 'r2', prompt: 'b', taskCountsByModel: [{ model: 'p/mid', tasks: 1 }] },
      ],
      flows: [
        { runId: 'r1', prompt: 'a', model: 'p/small', tasks: 2 },
        { runId: 'r2', prompt: 'b', model: 'p/mid', tasks: 1 },
      ],
      byModel: [
        { model: 'p/small', tasks: 2 },
        { model: 'p/mid', tasks: 1 },
      ],
    });
    const styles = styled._calls
      .filter((c) => Array.isArray(c) && c[0] === 'set' && c[1] === 'fillStyle')
      .map((c) => (c as unknown[])[2]);
    expect(ui.modelStyle('p/mid')).toEqual({ color: '#ff7a1a', pattern: 'solid', index: 0 });
    expect(ui.modelStyle('p/small')).toEqual({ color: '#e8dcc8', pattern: 'hatch', index: 1 });
    expect(styles).toContain('#ff7a1a');
    expect(styles).toContain('#e8dcc8');
    expect(styles).toContain('rgba(10, 10, 10, 0.62)');
  });
});

describe('page helpers', () => {
  const ui = load();

  it('parses hash routes: the prompt box by default, the overview, the list and one prompt', () => {
    // The prompt box is the landing view (ADR-038); unknown routes land there too.
    for (const h of ['', '#', '#/', '#/nope/x'])
      expect(ui.parseRoute(h)).toEqual({ view: 'compose' });
    expect(ui.parseRoute('#/overview')).toEqual({ view: 'overview' });
    expect(ui.parseRoute('#/overview/')).toEqual({ view: 'overview' });
    expect(ui.parseRoute('#/prompts')).toEqual({ view: 'prompts' });
    expect(ui.parseRoute('#/prompts/')).toEqual({ view: 'prompts' });
    expect(ui.parseRoute('#/prompts/run-1')).toEqual({ view: 'prompt', runId: 'run-1' });
    expect(ui.parseRoute('#/prompts/a%2Fb/')).toEqual({ view: 'prompt', runId: 'a/b' });
    // A malformed escape is kept as typed (the page then shows "not found").
    expect(ui.parseRoute('#/prompts/%E0%A4%A')).toEqual({ view: 'prompt', runId: '%E0%A4%A' });
    // Old single-page links (#<runId>) still open that prompt.
    expect(ui.parseRoute('#dropdown-auth')).toEqual({ view: 'prompt', runId: 'dropdown-auth' });
  });

  it('truncates tags with an ellipsis and leaves short strings alone', () => {
    expect(ui.truncate('mock', 8)).toBe('mock');
    expect(ui.truncate('12345678', 8)).toBe('12345678');
    expect(ui.truncate('mock-test-double (test double, no model is called)', 10)).toBe(
      'mock-test…',
    );
    expect(ui.truncate('mock-test-double', 10)).toHaveLength(10);
  });

  it('formats dates as local date and time, never a raw ISO Z string', () => {
    expect(ui.fmtDate('2026-11-13T06:49:22.524Z', 'en-US', 'America/Los_Angeles')).toBe(
      'Nov 12, 10:49 PM',
    );
    expect(ui.fmtDate('2026-11-13T06:49:22.524Z', 'en-US', 'UTC')).toBe('Nov 13, 6:49 AM');
    expect(ui.fmtDate(null)).toBeNull();
    expect(ui.fmtDate('not a date')).toBeNull();
  });

  it('gives each model one deterministic colour and pattern, whatever order it arrives in', () => {
    const a = ui.buildModelStyles(['p/small', 'p/mid', 'p/large', 'p/mid', null, '(no model)']);
    const b = ui.buildModelStyles(['p/large', 'p/small', 'p/mid']);
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(['p/large', 'p/mid', 'p/small']);
    // Distinct colour and pattern for every model up to the palette size.
    const many = ui.buildModelStyles(
      Array.from({ length: 24 }, (_, i) => `m${String(i).padStart(2, '0')}`),
    );
    const combos = new Set(Object.values(many).map((s) => `${s.color}|${s.pattern}`));
    expect(combos.size).toBe(24);
    expect(new Set(Object.values(a).map((s) => s.pattern)).size).toBe(3);
    // The patterns differ pixel by pixel, so models stay apart without colour.
    const sig = (p: string) =>
      Array.from({ length: 36 }, (_, k) =>
        ui.patternInk(p, k % 6, Math.floor(k / 6)) ? 1 : 0,
      ).join('');
    expect(new Set(ui.MODEL_PATTERNS.map(sig)).size).toBe(ui.MODEL_PATTERNS.length);
    // A model outside the known set still gets a stable style.
    ui.useModels(['p/small']);
    expect(ui.modelStyle('x/other')).toEqual(ui.modelStyle('x/other'));
    expect(ui.modelStyle(null).pattern).toBe('solid');
  });

  it('summary tiles show computed totals with coverage, and an em dash when unknown', () => {
    const covered = (value: unknown, runs: number) => ({ value, runs });
    const tiles = ui.tilesFor({
      promptCount: 2,
      taskCount: 5,
      aggregate: {
        tokens: {
          actual: covered({ inputTokens: 1000, outputTokens: 234, unreportedAttempts: 0 }, 1),
        },
        cost: { actualUsd: covered(null, 0), unpricedAttempts: 2 },
      },
    });
    expect(tiles.map((t) => text(t))).toEqual(
      [
        '2 Prompts recorded runs',
        '5 Tasks planned, across all prompts',
        '1,234 Tokens reported · 1/2 runs',
        '— Cost actual not reported · 2 unpriced attempt(s)',
      ].map((s) => ` ${s}`),
    );
    const none = ui.tilesFor({ promptCount: 0, taskCount: 0, aggregate: null });
    expect(none.map((t) => t.children[0]?.textContent)).toEqual(['—', '—', '—', '—']);
  });

  it('overview blocks are all aggregates; nothing names one prompt', () => {
    ui.useModels(['p/small']);
    const covered = (value: unknown, runs: number) => ({ value, runs });
    const ov = {
      promptCount: 1,
      taskCount: 1,
      aggregate: {
        usageByModel: [],
        usageByAgent: [],
        tokens: { estimated: covered(null, 0), actual: covered(null, 0) },
        cost: {
          estimatedUsd: covered(null, 0),
          routedEstimateUsd: covered(null, 0),
          actualUsd: covered(null, 0),
          unpricedAttempts: 0,
        },
        outcomes: {
          succeeded: 1,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          unfinished: 0,
          complete: 1,
          successRate: 1,
          failureRate: 0,
        },
        validation: { taskChecks: {}, final: {}, runsWithFinal: 0 },
        transitions: {},
        usageNote: 'usage note',
        savingsNote: 'savings note',
      },
    };
    const titles = ui.AGG_BLOCKS.map((b) => b(ov).children[0]?.textContent ?? '');
    expect(titles.slice(0, -1).every((t) => t.endsWith('· all prompts'))).toBe(true);
    expect(titles.join(' ')).not.toMatch(/this prompt|Assignment|timeline/i);
    const how = text(ui.AGG_BLOCKS.at(-1)?.(ov) ?? node('div'));
    expect(how).toContain('usage note');
    expect(how).toContain('savings note');
  });

  it('an unknown prompt shows "not found" and a link back to the list', () => {
    const block = ui.notFoundBlock('gone');
    expect(text(block)).toContain('Prompt not found');
    expect(text(block)).toContain('"gone"');
    expect(
      all(block).some(
        (n) => n.tag === 'a' && (n as unknown as { href: string }).href === '#/prompts',
      ),
    ).toBe(true);
  });

  it('a prompt row links to its detail route and shows local dates and model swatches', () => {
    ui.useModels(['p/small']);
    const row = ui.promptRow({
      runId: 'r 1',
      createdAt: '2026-11-12T10:00:00.000Z',
      state: 'succeeded',
      prompt: 'do it',
      taskCount: 1,
      agent: { kind: 'mock', label: 'mock-test-double (test double, no model is called)' },
      tokens: { inputTokens: 1200, outputTokens: 34, unreportedAttempts: 0 },
      cost: { actualUsd: 0.001, unpricedAttempts: 0 },
      taskCountsByModel: [{ model: 'p/small', tasks: 1 }],
    });
    expect((row as unknown as { href: string }).href).toBe('#/prompts/r%201');
    const t = text(row);
    expect(t).not.toContain('2026-11-12T10:00:00.000Z');
    expect(t).toContain('1,234 tok');
    const time = all(row).find((n) => n.tag === 'time');
    expect(time?.title).toBe('2026-11-12T10:00:00.000Z');
    const runner = all(row).find((n) => n.className === 'tag' && n.title.startsWith('mock-test'));
    expect(runner?.title).toBe('mock-test-double (test double, no model is called)');
    expect(runner?.textContent.endsWith('…')).toBe(true);
    const sw = all(row).find((n) => n.className.startsWith('sw'));
    expect(sw?.style.backgroundColor).toBe(ui.modelStyle('p/small').color);
  });
});

describe('prompt grid', () => {
  const ui = load();
  // Los Angeles: PDT (UTC-7) until 2026-11-01 09:00 UTC, then PST (UTC-8).
  const LA = (ms: number) => (ms < Date.parse('2026-11-01T09:00:00Z') ? -420 : -480);
  const NOW = Date.parse('2026-11-13T07:00:00Z'); // Nov 12, 11:00 PM in LA
  const P = (runId: string, createdAt: string | null, level = 1, score: number | null = 0.3) => ({
    runId,
    createdAt,
    prompt: 'prompt ' + runId,
    taskCount: 2,
    state: 'succeeded',
    agent: { kind: null, label: null },
    tokens: { inputTokens: 1000, outputTokens: 200, unreportedAttempts: 0 },
    cost: { actualUsd: null, unpricedAttempts: null },
    taskCountsByModel: [],
    complexity: { score, level, missing: [] },
  });

  it('local hour and day windows follow the local clock, across a DST change', () => {
    // 9:59:59 and 10:00 PM in LA on Nov 12 fall in different hours; 11:59 PM and 12:00 AM in
    // different days.
    const h1 = ui.localWindow(Date.parse('2026-11-13T05:59:59Z'), 'hour', LA);
    const h2 = ui.localWindow(Date.parse('2026-11-13T06:00:00Z'), 'hour', LA);
    expect(new Date(h1.from).toISOString()).toBe('2026-11-13T05:00:00.000Z');
    expect(h1.to).toBe(h2.from);
    const d1 = ui.localWindow(Date.parse('2026-11-13T07:59:00Z'), 'day', LA);
    const d2 = ui.localWindow(Date.parse('2026-11-13T08:00:00Z'), 'day', LA);
    expect(new Date(d1.from).toISOString()).toBe('2026-11-12T08:00:00.000Z');
    expect(new Date(d2.from).toISOString()).toBe('2026-11-13T08:00:00.000Z');
    // Nov 1 is 25 hours long in LA (fall back).
    const dst = ui.localWindow(Date.parse('2026-11-01T12:00:00Z'), 'day', LA);
    expect(new Date(dst.from).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect((dst.to - dst.from) / 3600000).toBe(25);
  });

  it('groups prompts by local day, stacks them oldest first, and marks empty days faint', () => {
    const prompts = [
      P('late', '2026-11-13T07:30:00Z'), // Nov 12, 11:30 PM local, not Nov 13
      P('early', '2026-11-12T16:00:00Z'), // Nov 12, 8:00 AM local
      P('gap', '2026-11-09T18:00:00Z'),
      P('undated', null),
    ];
    const m = ui.gridModel(prompts, 'prompt', NOW, LA);
    expect(m.rows).toBe(ui.STACK_CAP);
    expect(m.total).toBe(3);
    expect(m.undated).toBe(1);
    expect(m.columns.length).toBeGreaterThanOrEqual(28);
    const last = m.columns.at(-1);
    expect(last?.cells.filter((c) => c.kind === 'prompt').map((c) => c.prompt?.runId)).toEqual([
      'early',
      'late',
    ]);
    expect(last?.cells.slice(2).every((c) => c.kind === 'empty')).toBe(true);
    // Nov 10 and 11 had no prompts: all faint.
    for (const c of m.columns.slice(-3, -1))
      expect(c.cells.every((x) => x.kind === 'empty')).toBe(true);
    // Clicking a prompt square opens its detail route.
    expect(last?.cells[0]?.href).toBe('#/prompts/early');
  });

  it('caps a heavy day at the stack height and links the rest to the filtered list', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      P('r' + String(i), new Date(Date.parse('2026-11-10T17:00:00Z') + i * 60000).toISOString()),
    );
    const m = ui.gridModel(many, 'prompt', NOW, LA);
    const day = m.columns.find((c) => c.cells.some((x) => x.kind === 'prompt'));
    expect(day?.cells).toHaveLength(ui.STACK_CAP);
    expect(day?.overflow).toBe(3);
    expect(day?.overflowHref).toBe(
      '#/prompts?from=' +
        encodeURIComponent('2026-11-10T08:00:00.000Z') +
        '&to=' +
        encodeURIComponent('2026-11-11T08:00:00.000Z'),
    );
  });

  it('hour and day buckets sum activity and scale levels to their own view', () => {
    expect(ui.scaleLevels([0, 0.1, 0.5, 1, 2])).toEqual([0, 1, 1, 2, 4]);
    expect(ui.scaleLevels([0, 0])).toEqual([0, 0]);
    const prompts = [
      P('a', '2026-11-12T17:05:00Z', 2, 0.5), // Nov 12, 9:05 AM
      P('b', '2026-11-12T17:55:00Z', 1, 0.25), // same hour
      P('c', '2026-11-12T18:00:00Z', 0, null), // next hour; unknown score counts 0
    ];
    const hour = ui.gridModel(prompts, 'hour', NOW, LA);
    expect(hour.rows).toBe(24);
    const today = hour.columns.at(-1)?.cells ?? [];
    expect(today[9]).toMatchObject({
      kind: 'bucket',
      prompts: 2,
      tasks: 4,
      tokens: 2400,
      activity: 0.75,
      level: 4,
    });
    expect(today[10]).toMatchObject({ kind: 'bucket', prompts: 1, activity: 0, level: 0 });
    expect(today[8]?.kind).toBe('empty');
    expect(today[9]?.href).toBe(
      '#/prompts?from=' +
        encodeURIComponent('2026-11-12T17:00:00.000Z') +
        '&to=' +
        encodeURIComponent('2026-11-12T18:00:00.000Z'),
    );
    const day = ui.gridModel(prompts, 'day', NOW, LA);
    expect(day.rows).toBe(7);
    const cells = day.columns.flatMap((c) => c.cells).filter((c) => c.kind === 'bucket');
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ prompts: 3, activity: 0.75, level: 4 });
    // Nov 12, 2026 is a Thursday: row 4 of the last week; later days are not drawn.
    const lastWeek = day.columns.at(-1)?.cells ?? [];
    expect(lastWeek[4]?.kind).toBe('bucket');
    expect(lastWeek.slice(5).map((c) => c.kind)).toEqual(['none', 'none']);
    // Each zoom has its own legend that says it is scaled to the view.
    expect(ui.GRID_LEGEND.hour).toContain('scaled to this view');
    expect(ui.GRID_LEGEND.day).toContain('scaled to this view');
    expect(ui.GRID_LEGEND.prompt).toContain('Fixed 0–1 scale');
    expect(ui.cellLines(today[9], 'hour').join(' ')).toMatch(
      /2 prompt\(s\) · 4 task\(s\) · 2,400 tok/,
    );
  });

  it('with no runs, draws an empty frame of faint cells and says so', () => {
    const m = ui.renderGrid({ prompts: [] }, 'prompt', NOW, LA);
    expect(m.total).toBe(0);
    expect(m.columns.every((c) => c.cells.every((x) => x.kind === 'empty'))).toBe(true);
    const panel = ui.__byId['pgrid-panel'];
    expect(panel).toBeDefined();
    const t = text(panel ?? node('div'));
    expect(t).toContain('No prompts yet');
    expect(t).toContain('Less');
    expect(t).toContain('More');
    expect(
      all(panel ?? node('div')).filter((n) => n.tag === 'a' && n.className.startsWith('cell')),
    ).toEqual([]);
    for (const z of ['hour', 'day']) {
      const e = ui.gridModel([], z, NOW, LA);
      expect(e.columns.flatMap((c) => c.cells).some((x) => x.kind === 'bucket')).toBe(false);
    }
  });

  it('renders prompt squares as focusable links with an aria-label and the zoom toggle', () => {
    ui.renderGrid({ prompts: [P('x', '2026-11-12T17:05:00Z', 3, 0.7)] }, 'prompt', NOW, LA);
    const panel = ui.__byId['pgrid-panel'] ?? node('div');
    const links = all(panel).filter((n) => n.tag === 'a' && n.className === 'cell l3');
    expect(links).toHaveLength(1);
    const link = links[0] as FakeNode & { href: string };
    expect(link.href).toBe('#/prompts/x');
    expect(link.attrs['aria-label']).toContain('prompt x');
    expect(link.attrs['aria-label']).toContain('complexity 3/4 (score 0.70)');
    const seg = all(panel).filter((n) => n.className.startsWith('seg-b'));
    expect(
      seg.map((n) => [n.textContent, (n as FakeNode & { href: string }).href, n.className]),
    ).toEqual([
      ['Prompt', '#/overview', 'seg-b on'],
      ['Hour', '#/overview?zoom=hour', 'seg-b'],
      ['Day', '#/overview?zoom=day', 'seg-b'],
    ]);
  });

  it('parses the zoom and the prompt-list window filter routes', () => {
    expect(ui.parseRoute('#/overview?zoom=hour')).toEqual({ view: 'overview', zoom: 'hour' });
    expect(ui.parseRoute('#/overview?zoom=day')).toEqual({ view: 'overview', zoom: 'day' });
    expect(ui.parseRoute('#/overview?zoom=bogus')).toEqual({ view: 'overview' });
    // Old overview zoom links still open the overview.
    expect(ui.parseRoute('#/?zoom=hour')).toEqual({ view: 'overview', zoom: 'hour' });
    expect(ui.parseRoute('#/?zoom=bogus')).toEqual({ view: 'compose' });
    const from = '2026-11-12T17:00:00.000Z',
      to = '2026-11-12T18:00:00.000Z';
    expect(
      ui.parseRoute('#/prompts?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)),
    ).toEqual({ view: 'prompts', filter: { from, to } });
    // A bad or reversed window is ignored: the whole list.
    expect(ui.parseRoute('#/prompts?from=x&to=' + to)).toEqual({ view: 'prompts' });
    expect(ui.parseRoute('#/prompts?from=' + to + '&to=' + from)).toEqual({ view: 'prompts' });
  });

  it('filters the prompt list to [from, to), leaving undated prompts out', () => {
    const list = [
      P('in', '2026-11-12T17:00:00Z'),
      P('edge', '2026-11-12T18:00:00Z'),
      P('none', null),
    ];
    const f = { from: '2026-11-12T17:00:00.000Z', to: '2026-11-12T18:00:00.000Z' };
    expect(ui.filterPrompts(list, f).map((p) => p.runId)).toEqual(['in']);
    expect(ui.filterPrompts(list, null)).toHaveLength(3);
  });
});
