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
  style: { width?: string; left?: string; background?: string };
  children: FakeNode[];
  append(...n: FakeNode[]): void;
}

function node(tag: string): FakeNode {
  return {
    tag,
    className: '',
    textContent: '',
    title: '',
    style: {},
    children: [],
    append(...n) {
      this.children.push(...n);
    },
  };
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
  const fake = {
    document: {
      createElement: node,
      getElementById: () => node('div'),
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined },
    location: { hash: '' },
    fetch: () => new Promise(() => undefined),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  return runInNewContext(
    `${APP_JS}\n;({ chart, usageBlock, assignmentBlock, donut, meter, outcomesBlock, tokensBlock, costBlock, timelineBlock, validationBlock, transitionsBlock, BLOCKS, ACT_SHADES, EST_SHADES });`,
    fake,
  ) as {
    chart: (title: string, kind: string, rows: unknown[], fmt: (v: number) => string) => FakeNode;
    usageBlock: (title: string, rows: unknown[], note: string) => FakeNode;
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
    ACT_SHADES: string[];
    EST_SHADES: string[];
  };
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
    const charts = block.children.filter((n) => n.className === 'chart');
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
    const block = ui.usageBlock('Usage by model', [...usage.byModel], usage.note);
    const shares = all(block).filter((n) => n.className === 'chart share-chart');
    expect(shares.map((c) => c.children[0]?.textContent)).toEqual([
      'estimated USD share',
      'actual USD share',
    ]);
    const estCells = ringCells(at(shares, 0));
    expect(estCells.length).toBeGreaterThan(0);
    expect(estCells.every((c) => ui.EST_SHADES.includes(c.style.background ?? ''))).toBe(true);
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
    expect(rows.map((r) => r.children[0]?.textContent)).toEqual([
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

  it('the run view leads with the assignment graph and charts, not the text details', () => {
    const run = baseRun();
    const sections = ui.BLOCKS.map((b) => b(run));
    expect(sections.map((s) => s.children[0]?.textContent)).toEqual([
      '== Run ==',
      '== Assignment: prompt → tasks → models ==',
      '== Usage by model (also the cost-by-model numbers) ==',
      '== How to read the charts ==',
      '== Success and failure ==',
      '== Cost ==',
      '== Token usage ==',
      '== Usage by task ==',
      '== Usage by runner (agent/bot) ==',
      '== Duration (attempt timeline) ==',
      '== Validation ==',
      '== Model transitions ==',
      '== Task graph (2 tasks) ==',
      '== Tasks and models ==',
      '== Active agents ==',
      '== Run details ==',
      '== Savings ==',
    ]);
    const ident = text(at(sections, 0));
    expect(ident).toContain('r  ·  incomplete  ·  ');
    expect(ident).not.toContain('Prompt:');
    expect(ident).not.toMatch(/\bp\b/);
    const details = text(at(sections, 15));
    expect(details).toContain('Prompt:');
    expect(details).toContain('p');
    // The ident is wide so it sits above the wide assignment and usage charts.
    expect(at(sections, 0).className).toBe('block wide');
    expect(at(sections, 1).className).toBe('block wide');
    expect(at(sections, 2).className).toBe('block wide');
  });
});
