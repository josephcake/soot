/*
 * Aggregate view across every recorded run (prompts → models). Built only from status and
 * cost data the engine already reports; unknown stays null and nothing is invented.
 */

import { usageCharts, type UsageRow, type UsageSide } from './charts.js';
import { SAVINGS_NOTE, type DashboardRun } from './view.js';

export interface PromptIndexItem {
  readonly runId: string;
  readonly createdAt: string | null;
  readonly state: string;
  readonly prompt: string;
  readonly taskCount: number;
  readonly agent: { readonly kind: string | null; readonly label: string | null };
  /** Reported runner tokens for the run; null when cost data is missing. */
  readonly tokens: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly unreportedAttempts: number;
  } | null;
  readonly cost: {
    readonly actualUsd: number | null;
    readonly unpricedAttempts: number | null;
  };
  /** Unique tasks in this run that had at least one attempt on the model. */
  readonly taskCountsByModel: readonly { readonly model: string; readonly tasks: number }[];
}

/** One prompt's tasks that were assigned to one model. */
export interface TaskModelFlow {
  readonly runId: string;
  readonly prompt: string;
  readonly model: string;
  readonly tasks: number;
}

export interface Overview {
  /** Newest first (by createdAt; missing dates last). */
  readonly prompts: readonly PromptIndexItem[];
  readonly flows: readonly TaskModelFlow[];
  /** Task counts per model, summed across prompts, largest first. */
  readonly byModel: readonly { readonly model: string; readonly tasks: number }[];
  /** Number of recorded runs/prompts. */
  readonly promptCount: number;
  /** Sum of tasks in those runs (a task that hit two models still counts once here). */
  readonly taskCount: number;
  /** Totals across every recorded run, for the overview page. */
  readonly aggregate: Aggregate;
}

/**
 * A sum over runs that only adds what was reported. `runs` is how many runs had a known value
 * (out of `promptCount`); `value` is null when none did. The page shows the coverage beside
 * the number, so a partial sum is never passed off as a total.
 */
export interface Covered<T> {
  readonly value: T | null;
  readonly runs: number;
}

export interface Aggregate {
  /** Usage rows merged by model across runs. Unknown amounts propagate (any null → null). */
  readonly usageByModel: readonly UsageRow[];
  /** Usage rows merged by runner label across runs (runner is recorded per run). */
  readonly usageByAgent: readonly UsageRow[];
  readonly tokens: {
    readonly estimated: Covered<{ readonly inputTokens: number; readonly outputTokens: number }>;
    readonly actual: Covered<{
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly unreportedAttempts: number;
    }>;
  };
  readonly cost: {
    readonly estimatedUsd: Covered<number>;
    readonly routedEstimateUsd: Covered<number>;
    readonly actualUsd: Covered<number>;
    /** Unpriced attempts summed over runs that have cost data. */
    readonly unpricedAttempts: number;
  };
  readonly outcomes: {
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly skipped: number;
    readonly unfinished: number;
    readonly complete: number;
    /** succeeded / finished tasks across runs; null when no task finished. */
    readonly successRate: number | null;
    readonly failureRate: number | null;
  };
  readonly validation: {
    /** soot-run task checks counted by status, across runs. */
    readonly taskChecks: Readonly<Record<string, number>>;
    /** Final validation checks counted by status, across runs that recorded one. */
    readonly final: Readonly<Record<string, number>>;
    /** Runs that recorded a final validation. */
    readonly runsWithFinal: number;
  };
  /** Model transitions (retry, fallback, escalate, downgrade) counted by type. */
  readonly transitions: Readonly<Record<string, number>>;
  /** The same honest-limit notes the run view shows. */
  readonly usageNote: string;
  readonly savingsNote: string;
}

const strictSum = (values: readonly (number | null)[]): number | null =>
  values.length === 0 || values.includes(null)
    ? null
    : values.reduce<number>((n, v) => n + (v ?? 0), 0);

function mergeRows(rows: readonly UsageRow[]): UsageRow[] {
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) groups.set(r.label, [...(groups.get(r.label) ?? []), r]);
  const side = (list: readonly UsageRow[], key: 'estimated' | 'actual'): UsageSide => ({
    inputTokens: strictSum(list.map((r) => r[key].inputTokens)),
    outputTokens: strictSum(list.map((r) => r[key].outputTokens)),
    usd: strictSum(list.map((r) => r[key].usd)),
  });
  return [...groups]
    .map(([label, list]) => ({
      label,
      attempts: list.reduce((n, r) => n + r.attempts, 0),
      estimated: side(list, 'estimated'),
      actual: side(list, 'actual'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function covered<T>(values: readonly (T | null)[], add: (a: T, b: T) => T): Covered<T> {
  const known = values.filter((v): v is T => v !== null);
  return { value: known.length === 0 ? null : known.reduce(add), runs: known.length };
}

const countBy = (keys: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
};

export function toAggregate(runs: readonly DashboardRun[]): Aggregate {
  const o = (k: 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'unfinished' | 'complete') =>
    runs.reduce((n, r) => n + r.outcomes[k], 0);
  const succeeded = o('succeeded');
  const failed = o('failed');
  const cancelled = o('cancelled');
  const skipped = o('skipped');
  const done = succeeded + failed + cancelled + skipped;
  const plus = (a: number, b: number) => a + b;
  const finals = runs.flatMap((r) => (r.validation.final === null ? [] : [r.validation.final]));
  return {
    usageByModel: mergeRows(runs.flatMap((r) => r.usage.byModel)),
    usageByAgent: mergeRows(runs.flatMap((r) => r.usage.byAgent)),
    tokens: {
      estimated: covered(
        runs.map((r) => r.tokens.estimated),
        (a, b) => ({
          inputTokens: a.inputTokens + b.inputTokens,
          outputTokens: a.outputTokens + b.outputTokens,
        }),
      ),
      actual: covered(
        runs.map((r) => r.tokens.actual),
        (a, b) => ({
          inputTokens: a.inputTokens + b.inputTokens,
          outputTokens: a.outputTokens + b.outputTokens,
          unreportedAttempts: a.unreportedAttempts + b.unreportedAttempts,
        }),
      ),
    },
    cost: {
      estimatedUsd: covered(
        runs.map((r) => r.cost.estimatedUsd),
        plus,
      ),
      routedEstimateUsd: covered(
        runs.map((r) => r.cost.routedEstimateUsd),
        plus,
      ),
      actualUsd: covered(
        runs.map((r) => r.cost.actualUsd),
        plus,
      ),
      unpricedAttempts: runs.reduce((n, r) => n + (r.cost.unpricedAttempts ?? 0), 0),
    },
    outcomes: {
      succeeded,
      failed,
      cancelled,
      skipped,
      unfinished: o('unfinished'),
      complete: o('complete'),
      successRate: done === 0 ? null : succeeded / done,
      failureRate: done === 0 ? null : (failed + cancelled + skipped) / done,
    },
    validation: {
      taskChecks: countBy(
        runs.flatMap((r) => r.tasks.flatMap((t) => t.checks.map((c) => c.status))),
      ),
      final: countBy(finals.flatMap((f) => f.map((c) => c.status))),
      runsWithFinal: finals.length,
    },
    transitions: countBy(runs.flatMap((r) => r.transitions.map((t) => t.type))),
    usageNote: usageCharts(null, null).note,
    savingsNote: SAVINGS_NOTE,
  };
}

/** Unique tasks that had at least one attempt on each model. */
export function taskCountsByModel(
  run: DashboardRun,
): readonly { readonly model: string; readonly tasks: number }[] {
  const map = new Map<string, Set<string>>();
  for (const t of run.tasks) {
    const seen = new Set<string>();
    for (const a of t.attempts) {
      const model = a.model ?? '(no model)';
      if (seen.has(model)) continue;
      seen.add(model);
      const set = map.get(model) ?? new Set();
      set.add(t.id);
      map.set(model, set);
    }
  }
  return [...map]
    .map(([model, ids]) => ({ model, tasks: ids.size }))
    .sort((a, b) => b.tasks - a.tasks || a.model.localeCompare(b.model));
}

export function toPromptIndexItem(run: DashboardRun): PromptIndexItem {
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    state: run.state,
    prompt: run.prompt,
    taskCount: run.taskCount,
    agent: run.agent,
    tokens: run.tokens.actual,
    cost: { actualUsd: run.cost.actualUsd, unpricedAttempts: run.cost.unpricedAttempts },
    taskCountsByModel: taskCountsByModel(run),
  };
}

const createdMs = (iso: string | null): number => {
  if (iso === null || iso === '') return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

export function toOverview(runs: readonly DashboardRun[]): Overview {
  const prompts = [...runs]
    .map(toPromptIndexItem)
    .sort((a, b) => createdMs(b.createdAt) - createdMs(a.createdAt));
  const flows: TaskModelFlow[] = prompts.flatMap((p) =>
    p.taskCountsByModel.map((m) => ({
      runId: p.runId,
      prompt: p.prompt,
      model: m.model,
      tasks: m.tasks,
    })),
  );
  const totals = new Map<string, number>();
  for (const f of flows) totals.set(f.model, (totals.get(f.model) ?? 0) + f.tasks);
  const byModel = [...totals]
    .map(([model, tasks]) => ({ model, tasks }))
    .sort((a, b) => b.tasks - a.tasks || a.model.localeCompare(b.model));
  return {
    prompts,
    flows,
    byModel,
    promptCount: prompts.length,
    taskCount: prompts.reduce((n, p) => n + p.taskCount, 0),
    aggregate: toAggregate(runs),
  };
}
