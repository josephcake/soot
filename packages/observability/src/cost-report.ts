import type { AgentResult } from '@soot/task-graph';
import { actualUsd, estimatedUsd, type ActualUsd, type EstimatedUsd } from './cost.js';

/*
 * Per-task and total cost display (Milestone 5, M5-06, spec §12). Estimates (planner tokens,
 * routed USD per attempt) and actuals (usage each attempt reported) stay in separate fields and
 * types. Every attempt counts, including failed ones and escalations. Attempts that reported no
 * usage (crash, timeout) are counted as `unreported`; totals that depend on them are `null`.
 */

export interface CostAttemptInput {
  readonly attempt: number;
  /** Model assigned to the attempt, if any. */
  readonly model: string | null;
  /** Routed estimate for this attempt (USD), `null` if unknown. Never an actual. */
  readonly estimatedUsd: number | null;
  /** The attempt's structured result, or `null` if it produced none (crash, timeout). */
  readonly result: Pick<AgentResult, 'status' | 'usage'> | null;
}

export interface CostTaskInput {
  readonly taskId: string;
  readonly plannedInputTokens: number;
  readonly plannedOutputTokens: number;
  readonly attempts: readonly CostAttemptInput[];
}

export interface CostAttemptLine {
  readonly attempt: number;
  readonly model: string | null;
  readonly status: AgentResult['status'] | 'no-result';
  readonly estimatedUsd: EstimatedUsd | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly actualUsd: ActualUsd | null;
}

export interface CostSide<T> {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `null` when any contributing amount is unknown. */
  readonly usd: T | null;
}

export interface TaskCostLine {
  readonly taskId: string;
  readonly estimated: CostSide<EstimatedUsd> & { readonly source: 'planner tokens, routed USD' };
  readonly actual: CostSide<ActualUsd> & {
    readonly source: 'reported usage';
    readonly unpricedAttempts: number;
    readonly unreportedAttempts: number;
  };
  readonly attempts: readonly CostAttemptLine[];
  /** Models in attempt order, consecutive duplicates collapsed (escalations, fallbacks). */
  readonly modelPath: readonly string[];
}

export interface ModelCostLine {
  readonly model: string;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly actualUsd: ActualUsd | null;
}

export interface CostReport {
  readonly tasks: readonly TaskCostLine[];
  readonly totals: {
    readonly estimated: CostSide<EstimatedUsd>;
    readonly actual: CostSide<ActualUsd> & {
      readonly attempts: number;
      readonly unpricedAttempts: number;
      readonly unreportedAttempts: number;
    };
  };
  readonly byModel: readonly ModelCostLine[];
}

const sumOrNull = (values: readonly (number | null)[]) =>
  values.some((v) => v === null) ? null : values.reduce<number>((n, v) => n + (v ?? 0), 0);

function taskLine(input: CostTaskInput): TaskCostLine {
  const attempts: CostAttemptLine[] = [...input.attempts]
    .sort((a, b) => a.attempt - b.attempt)
    .map((a) => ({
      attempt: a.attempt,
      model: a.result?.usage.model ?? a.model,
      status: a.result?.status ?? 'no-result',
      estimatedUsd: a.estimatedUsd === null ? null : estimatedUsd(a.estimatedUsd),
      inputTokens: a.result?.usage.inputTokens ?? null,
      outputTokens: a.result?.usage.outputTokens ?? null,
      actualUsd: a.result?.usage.costUsd == null ? null : actualUsd(a.result.usage.costUsd),
    }));
  
  const reported = attempts.filter((a) => a.status !== 'no-result');
  const estimated = sumOrNull(attempts.map((a) => a.estimatedUsd));
  const actual = sumOrNull(reported.map((a) => a.actualUsd)); // Only sum actuals from reported attempts
  
  const modelPath: string[] = [];
  for (const a of attempts)
    if (a.model !== null && modelPath.at(-1) !== a.model) modelPath.push(a.model);
  
  return {
    taskId: input.taskId,
    estimated: {
      source: 'planner tokens, routed USD',
      inputTokens: input.plannedInputTokens,
      outputTokens: input.plannedOutputTokens,
      usd: attempts.length === 0 || estimated === null ? null : estimatedUsd(estimated),
    },
    actual: {
      source: 'reported usage',
      inputTokens: reported.reduce((n, a) => n + (a.inputTokens ?? 0), 0),
      outputTokens: reported.reduce((n, a) => n + (a.outputTokens ?? 0), 0),
      usd: actual === null ? null : actualUsd(actual),
      unpricedAttempts: reported.filter((a) => a.actualUsd === null).length,
      unreportedAttempts: attempts.length - reported.length,
    },
    attempts,
    modelPath,
  };
}

export function buildCostReport(tasks: readonly CostTaskInput[]): CostReport {
  const lines = tasks.map(taskLine);
  const all = lines.flatMap((l) => l.attempts);
  const estimated = sumOrNull(lines.map((l) => l.estimated.usd));
  const actual = sumOrNull(all.map((a) => a.actualUsd));
  const byModel = new Map<string, CostAttemptLine[]>();
  for (const a of all) {
    const key = a.model ?? '(no model)';
    byModel.set(key, [...(byModel.get(key) ?? []), a]);
  }
  return {
    tasks: lines,
    totals: {
      estimated: {
        inputTokens: lines.reduce((n, l) => n + l.estimated.inputTokens, 0),
        outputTokens: lines.reduce((n, l) => n + l.estimated.outputTokens, 0),
        usd: estimated === null ? null : estimatedUsd(estimated),
      },
      actual: {
        attempts: all.length,
        inputTokens: lines.reduce((n, l) => n + l.actual.inputTokens, 0),
        outputTokens: lines.reduce((n, l) => n + l.actual.outputTokens, 0),
        usd: actual === null ? null : actualUsd(actual),
        unpricedAttempts: lines.reduce((n, l) => n + l.actual.unpricedAttempts, 0),
        unreportedAttempts: lines.reduce((n, l) => n + l.actual.unreportedAttempts, 0),
      },
    },
    byModel: [...byModel.entries()]
      .map(([model, attempts]) => {
        const usd = sumOrNull(attempts.map((a) => a.actualUsd));
        return {
          model,
          attempts: attempts.length,
          inputTokens: attempts.reduce((n, a) => n + (a.inputTokens ?? 0), 0),
          outputTokens: attempts.reduce((n, a) => n + (a.outputTokens ?? 0), 0),
          actualUsd: usd === null ? null : actualUsd(usd),
        };
      })
      .sort((a, b) => a.model.localeCompare(b.model)),
  };
}

const fmtUsd = (v: number | null) => (v === null ? 'unknown' : `$${v.toFixed(6)}`);

/** Plain-text rendering (no UI, ADR-009). Estimates and actuals are labelled separately. */
export function renderCostReport(report: CostReport): string {
  const lines: string[] = ['Cost (estimates and actuals are never mixed)'];
  for (const t of report.tasks) {
    lines.push(
      `- ${t.taskId}: estimated ${fmtUsd(t.estimated.usd)} (${String(t.estimated.inputTokens)} in / ${String(t.estimated.outputTokens)} out tokens planned) | actual ${fmtUsd(t.actual.usd)} (${String(t.actual.inputTokens)} in / ${String(t.actual.outputTokens)} out tokens reported) | models ${t.modelPath.join(' → ') || 'none'}`,
    );
    for (const a of t.attempts) {
      lines.push(
        `    attempt ${String(a.attempt)} ${a.model ?? '(no model)'} ${a.status}: est ${fmtUsd(a.estimatedUsd)}, actual ${fmtUsd(a.actualUsd)}`,
      );
    }
  }
  const { estimated, actual } = report.totals;
  lines.push(
    `Total estimated: ${fmtUsd(estimated.usd)} (${String(estimated.inputTokens)} in / ${String(estimated.outputTokens)} out tokens planned)`,
    `Total actual: ${fmtUsd(actual.usd)} over ${String(actual.attempts)} attempts (${String(actual.inputTokens)} in / ${String(actual.outputTokens)} out tokens reported; ${String(actual.unpricedAttempts)} unpriced, ${String(actual.unreportedAttempts)} without usage)`,
    'By model (actual):',
    ...report.byModel.map(
      (m) =>
        `- ${m.model}: ${String(m.attempts)} attempts, ${String(m.inputTokens)} in / ${String(m.outputTokens)} out, ${fmtUsd(m.actualUsd)}`,
    ),
  );
  return lines.join('\n');
}