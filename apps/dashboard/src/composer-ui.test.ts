import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { APP_JS, INDEX_HTML, STYLE_CSS } from './ui.js';

/*
 * The prompt box's pure helpers and its live card (ADR-038), run from the real page script
 * against a tiny fake DOM: the plan shows at once with cost so far and a worst case, Stop and
 * per-task stop are there while it works, and there is no approve or confirm step anywhere.
 */

interface N {
  tag: string;
  className: string;
  textContent: string;
  title: string;
  style: Record<string, string>;
  type?: string;
  href?: string;
  disabled?: boolean;
  hidden?: boolean;
  id?: string;
  attrs: Record<string, string>;
  children: N[];
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  append(...c: (N | string)[]): void;
  replaceChildren(...c: N[]): void;
  addEventListener(): void;
}

function node(tag: string): N {
  return {
    tag,
    className: '',
    textContent: '',
    title: '',
    style: {},
    attrs: {},
    children: [],
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    removeAttribute(k) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.attrs[k];
    },
    append(...c) {
      for (const x of c)
        this.children.push(typeof x === 'string' ? { ...node('#text'), textContent: x } : x);
    },
    replaceChildren(...c) {
      this.children = c;
    },
    addEventListener() {
      /* not fired */
    },
  };
}
const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const text = (n: N) =>
  all(n)
    .map((x) => x.textContent)
    .join(' ');

interface Ui {
  plannerText(p: unknown): string;
  liveModel(
    job: unknown,
    run: unknown,
  ): {
    planning: { model: string | null; cost: { usd: number | null } };
    tasks: {
      id: string;
      models: string[];
      state: string;
      cost: { usd: number | null; estimated: number; actual: number };
    }[];
    total: { text: string; est: boolean; partial: boolean };
    worst: { usd: number; partial: boolean; basis: string } | null;
    done: number;
  };
  liveHeadline(job: unknown, m: unknown, now: number): { text: string; sub: string };
  liveCard(job: unknown, run: unknown): { card: N; said: string };
  finishNote(job: unknown, run: unknown): string;
}

function load(): Ui {
  const byId: Record<string, N> = {};
  return runInNewContext(
    `${APP_JS}\n;({ plannerText, liveModel, liveHeadline, liveCard, finishNote })`,
    {
      document: {
        createElement: node,
        addEventListener: () => undefined,
        getElementById: (id: string) => (byId[id] ??= node('div')),
        body: { classList: { toggle: () => undefined } },
        activeElement: null,
      },
      window: { addEventListener: () => undefined },
      location: { hash: '' },
      fetch: () => new Promise(() => undefined),
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    },
  ) as Ui;
}

const PREVIEW = {
  runId: 'run-1',
  planner: {
    kind: 'model',
    model: 'deepseek/deepseek-flash',
    fixtureId: null,
    inputTokens: 687,
    outputTokens: 475,
    costUsd: 0.0008,
    priced: true,
  },
  tasks: [
    {
      taskId: 'cta',
      title: 'Change CTA color',
      complexity: 'low',
      dependsOn: [],
      model: 'anthropic/claude-haiku-5-5',
      estimateUsd: 0.0001,
      worstCaseUsd: 0.002,
      plannedInputTokens: 600,
      plannedOutputTokens: 150,
      reason: '',
    },
    {
      taskId: 'fmt',
      title: 'Test formatPrice',
      complexity: 'medium',
      dependsOn: [],
      model: 'openai/gpt-6.1-terra',
      estimateUsd: 0.004,
      worstCaseUsd: 0.03,
      plannedInputTokens: 900,
      plannedOutputTokens: 400,
      reason: '',
    },
  ],
  estimateUsd: 0.0041,
  estimatePartial: false,
  worstCaseUsd: 0.032,
  worstCasePartial: false,
  worstCaseBasis: 'up to 5 attempts per task on the priciest model the router accepts',
  policy: 'balanced',
  agentLabel: 'mock',
};
const job = (over: Record<string, unknown> = {}) => ({
  id: 'job_0123456789abcdef',
  state: 'running',
  project: { id: 'p_1', label: 'demo-app' },
  prompt: 'Change the CTA button color and add a formatPrice test',
  createdAt: '2026-11-13T09:00:00.000Z',
  runner: { kind: 'mock', label: 'mock (test double)' },
  preview: PREVIEW,
  runId: 'run-1',
  result: null,
  error: null,
  stopRequested: false,
  ...over,
});
const RUN = {
  runId: 'run-1',
  state: 'running',
  running: true,
  planning: null,
  validation: { problems: [] },
  taskBreakdown: [
    {
      id: 'cta',
      title: 'Change CTA color',
      state: 'succeeded',
      models: ['anthropic/claude-haiku-5-5'],
      runner: 'mock',
      costAttempts: [
        {
          model: 'anthropic/claude-haiku-5-5',
          estimatedUsd: 0.0001,
          actualUsd: null,
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
    },
    {
      id: 'fmt',
      title: 'Test formatPrice',
      state: 'pending',
      models: [],
      runner: 'mock',
      costAttempts: [],
    },
  ],
};

describe('prompt box helpers', () => {
  const ui = load();

  it('labels the planner with its rough cost, or says recorded prompts only', () => {
    expect(
      ui.plannerText({
        model: 'deepseek/deepseek-flash',
        status: 'usable',
        reason: null,
        roughCostUsd: 0.0013,
      }),
    ).toBe('planner: deepseek-flash · ~$0.0013 per plan');
    expect(
      ui.plannerText({ model: 'xai/grok-4.7', status: 'usable', reason: null, roughCostUsd: null }),
    ).toBe('planner: grok-4.7 · price not set');
    expect(
      ui.plannerText({
        model: 'xai/grok-4.7',
        status: 'unusable',
        reason: 'no key',
        roughCostUsd: 0.01,
      }),
    ).toBe('planner: grok-4.7 not usable (recorded prompts only)');
    expect(
      ui.plannerText({ model: null, status: 'not-configured', reason: null, roughCostUsd: null }),
    ).toBe('planner: recorded prompts only');
  });

  it('shows the plan right away from the preview: planning spent, tasks estimated, worst case', () => {
    const m = ui.liveModel(job({ runId: null }), null);
    expect(m.planning.model).toBe('deepseek/deepseek-flash');
    expect(m.tasks.map((t) => [t.id, t.models, t.state])).toEqual([
      ['cta', ['anthropic/claude-haiku-5-5'], 'pending'],
      ['fmt', ['openai/gpt-6.1-terra'], 'pending'],
    ]);
    expect(m.total).toMatchObject({ text: '~$0.0049', est: true, partial: false });
    expect(m.worst?.usd).toBeCloseTo(0.0328, 6);
  });

  it('switches to live run data as tasks start, keeping planned estimates for tasks not started', () => {
    const m = ui.liveModel(job(), RUN);
    expect(m.done).toBe(1);
    expect(m.tasks.map((t) => [t.id, t.state, t.models])).toEqual([
      ['cta', 'succeeded', ['anthropic/claude-haiku-5-5']],
      ['fmt', 'pending', ['openai/gpt-6.1-terra']],
    ]);
    expect(m.tasks[1]?.cost.estimated).toBe(1);
    expect(m.total.text).toBe('~$0.0049');
  });

  it('a recorded-fixture plan costs nothing and is not counted', () => {
    const m = ui.liveModel(
      job({
        preview: {
          ...PREVIEW,
          planner: {
            kind: 'fixture',
            model: null,
            fixtureId: 'x',
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            priced: null,
          },
        },
      }),
      null,
    );
    expect(m.total.text).toBe('~$0.0041');
  });

  it('while planning there is no plan yet; the headline says so', () => {
    const j = job({ state: 'planning', preview: null, runId: null });
    const m = ui.liveModel(j, null);
    expect(m.tasks).toEqual([]);
    expect(ui.liveHeadline(j, m, Date.parse('2026-11-13T09:00:07Z')).text).toBe('Planning…');
  });

  it('the live card has the prompt, the tasks with models and state, cost so far, Stop and per-task stop', () => {
    const { card, said } = ui.liveCard(job(), RUN);
    const t = text(card);
    expect(t).toContain('Change the CTA button color');
    expect(t).toContain('claude-haiku-5-5');
    expect(t).toContain('gpt-6.1-terra');
    expect(t).toContain('cost so far');
    expect(t).toContain('worst case ≤ $0.03');
    expect(t).toContain('stopping the dashboard stops it');
    const buttons = all(card).filter((n) => n.tag === 'button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Stop', 'stop']);
    expect(all(card).find((n) => n.tag === 'a')?.href).toBe('#/history/run-1');
    expect(said).toBe('Running · 1 of 2 tasks done');
    // No approve or confirm step anywhere on the card.
    expect(t).not.toMatch(/approve and run|confirm/i);
    expect(t).toContain('Approval-needing actions are refused.');
  });

  it('with --apply the live card says verified results land on the branch', () => {
    const lands = job({
      runner: { kind: 'api', label: 'api (routed models, called directly)', lands: true },
    });
    const t = text(ui.liveCard(lands, RUN).card);
    expect(t).toContain('Verified results land on your branch (--apply)');
  });

  it('when finished: no Stop, a details link and dismiss, and the run problem is shown', () => {
    const done = job({
      state: 'done',
      result: { ok: true, status: 'incomplete', message: 'soot run run-1 (INCOMPLETE)' },
    });
    const run = {
      ...RUN,
      running: false,
      validation: {
        problems: [
          'working tree not updated: approval unavailable; result left on soot/run-1/integration',
        ],
      },
    };
    const { card } = ui.liveCard(done, run);
    expect(
      all(card)
        .filter((n) => n.tag === 'button')
        .map((b) => b.textContent),
    ).toEqual(['dismiss']);
    expect(text(card)).toContain('result left on soot/run-1/integration');
    expect(ui.finishNote(done, null)).toBe('soot run run-1 (INCOMPLETE)');
  });
});

describe('page shell', () => {
  it('the prompt box is the first tab and the landing view; there is no Approve control', () => {
    expect(INDEX_HTML.indexOf('id="tab-compose"')).toBeLessThan(
      INDEX_HTML.indexOf('id="tab-overview"'),
    );
    expect(INDEX_HTML).toContain('href="#/history">History</a>');
    expect(INDEX_HTML).toContain('href="#/">Prompt</a>');
    expect(INDEX_HTML).not.toContain('>Prompts</a>');
    expect(INDEX_HTML).toMatch(/id="view-compose"[^>]*>/);
    expect(INDEX_HTML).not.toMatch(/id="view-compose"[^>]*hidden/);
    expect(INDEX_HTML).toMatch(/id="view-overview" class="grid" hidden/);
    expect(INDEX_HTML + APP_JS).not.toMatch(/Approve and run|approve-bar/i);
  });
  it('focus mode hides the tabs and meta, in the locked palette', () => {
    expect(STYLE_CSS).toContain('body.focus .tabs, body.focus .meta { opacity: 0;');
    expect(STYLE_CSS).toContain('--orange: #ff7a1a');
    expect(STYLE_CSS).toContain('--cream: #e8dcc8');
  });
});
