/** Chart data from the engine's cost report. Unknown values propagate through sums. */
export interface UsageSide {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly usd: number | null;
}
export interface UsageRow {
  readonly label: string;
  readonly attempts: number;
  readonly estimated: UsageSide;
  readonly actual: UsageSide;
}
export interface UsageCharts {
  readonly byTask: readonly UsageRow[];
  readonly byModel: readonly UsageRow[];
  readonly byAgent: readonly UsageRow[];
  readonly note: string;
}
export const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const number = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const sum = (values: readonly (number | null)[]): number | null =>
  values.length === 0 || values.includes(null)
    ? null
    : values.reduce<number>((n, v) => n + (v ?? 0), 0);
function merge(rows: readonly UsageRow[], label: string): UsageRow {
  const side = (key: 'estimated' | 'actual'): UsageSide => ({
    inputTokens: sum(rows.map((r) => r[key].inputTokens)),
    outputTokens: sum(rows.map((r) => r[key].outputTokens)),
    usd: sum(rows.map((r) => r[key].usd)),
  });
  return {
    label,
    attempts: rows.reduce((n, r) => n + r.attempts, 0),
    estimated: side('estimated'),
    actual: side('actual'),
  };
}
export function usageCharts(
  cost: Readonly<Record<string, unknown>> | null,
  agentLabel: string | null,
): UsageCharts {
  const tasks = list(record(cost?.cost).tasks).map(record);
  const attempts: UsageRow[] = tasks.flatMap((t) => {
    const planned = record(t.estimated);
    return list(t.attempts)
      .map(record)
      .map((a) => ({
        label: text(a.model, '(model unknown)'),
        attempts: 1,
        estimated: {
          inputTokens: number(planned.inputTokens),
          outputTokens: number(planned.outputTokens),
          usd: number(a.estimatedUsd),
        },
        actual: {
          inputTokens: number(a.inputTokens),
          outputTokens: number(a.outputTokens),
          usd: number(a.actualUsd),
        },
      }));
  });
  const byTask: UsageRow[] = tasks.map((t) => {
    const planned = record(t.estimated);
    const actuals = list(t.attempts).map(record);
    return {
      label: text(t.taskId, '(task unknown)'),
      attempts: actuals.length,
      estimated: {
        inputTokens: number(planned.inputTokens),
        outputTokens: number(planned.outputTokens),
        usd: sum(actuals.map((a) => number(a.estimatedUsd))),
      },
      actual: {
        inputTokens: sum(actuals.map((a) => number(a.inputTokens))),
        outputTokens: sum(actuals.map((a) => number(a.outputTokens))),
        usd: sum(actuals.map((a) => number(a.actualUsd))),
      },
    };
  });
  const groups = new Map<string, UsageRow[]>();
  for (const a of attempts) {
    const group = groups.get(a.label) ?? [];
    group.push(a);
    groups.set(a.label, group);
  }
  return {
    byTask,
    byModel: [...groups].map(([label, rows]) => merge(rows, label)),
    byAgent: agentLabel === null ? [] : [merge(attempts, agentLabel)],
    note: 'Estimated tokens: planner tokens once per task; by model/runner, repeated per attempt (not measured). Estimated USD: routed estimates summed across attempts. Actual: reported usage only; any missing amount makes its sum unknown. Runner label is from the saved report; not an independent bot identity.',
  };
}
