/*
 * Aggregate view across every recorded run (prompts → models). Built only from status and
 * cost data the engine already reports; unknown stays null and nothing is invented.
 */

import type { DashboardRun } from './view.js';

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
  };
}
