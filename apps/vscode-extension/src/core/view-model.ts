/*
 * Plain data for the extension's views, built only from `soot status <run> --json` and
 * `soot cost <run> --json`. Nothing here orchestrates; it reads what the engine reports.
 */

export interface AttemptView {
  readonly attempt: number;
  readonly state: string;
  readonly model: string | null;
  readonly escalationLevel: number | null;
  readonly estimatedCostUsd: number | null;
  readonly actualCostUsd: number | null;
  readonly failure: string | null;
  readonly error: string | null;
}

export interface TaskView {
  readonly id: string;
  readonly state: string;
  readonly complexity: string;
  readonly dependsOn: readonly string[];
  /** 0 for tasks without dependencies, else 1 + the deepest dependency's layer. */
  readonly layer: number;
  readonly models: readonly (string | null)[];
  readonly attempts: readonly AttemptView[];
  readonly verdict: string | null;
  readonly complete: boolean;
  readonly reason: string | null;
  readonly active: boolean;
}

export interface EventView {
  readonly taskId: string;
  readonly attempt: number;
  readonly type: string;
  readonly model: string | null;
  readonly reason: string;
}

export interface TriggerView {
  /** Engine trigger kind, e.g. `repeated-failure`, `unmet-criteria`, `low-confidence`. */
  readonly kind: string;
  readonly detail: string;
}

/**
 * One escalation (M7-06): the engine moved a task to a stronger model. `toModel` is the model
 * the `escalate` event assigned; `fromModel` is the model of the attempt before it (or, if the
 * engine reported no attempts, the task's previous routing event). Nothing here is guessed:
 * a value the engine did not report stays null.
 */
export interface EscalationView {
  readonly taskId: string;
  /** The new attempt the escalation planned (attempt #N runs on `toModel`). */
  readonly attempt: number;
  readonly fromModel: string | null;
  readonly toModel: string | null;
  /** Escalation level of the new attempt (0 = the first model), from `attemptDetails`. */
  readonly level: number | null;
  readonly reason: string;
  readonly triggers: readonly TriggerView[];
}

export interface CostView {
  readonly estimatedUsd: number | null;
  readonly actualUsd: number | null;
  readonly note: string;
}

export interface RunView {
  readonly runId: string;
  readonly state: string;
  readonly running: boolean;
  readonly prompt: string;
  readonly tasks: readonly TaskView[];
  /** Escalations, fallbacks, retries, downgrades, failures, cancellations. */
  readonly events: readonly EventView[];
  /** Only the `escalate` events, with from/to models, attempt, level and triggers. */
  readonly escalations: readonly EscalationView[];
  readonly cost: CostView | null;
}

/** Event types that put a model on a task; the last one before an escalation is its "from". */
const ROUTING_EVENTS = new Set(['assign', 'retry', 'fallback', 'escalate', 'downgrade']);

/** Event types that are about routing changes or trouble (not routine assign/accept). */
export const NOTABLE_EVENTS = new Set([
  'escalate',
  'fallback',
  'retry',
  'downgrade',
  'downgrade-skipped',
  'fail',
  'stop',
]);

const ACTIVE_STATES = new Set(['running']);

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

function layers(
  tasks: readonly { id: string; dependsOn: readonly string[] }[],
): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = byId.get(id)?.dependsOn ?? [];
    const layer = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => visit(d, seen)));
    memo.set(id, layer);
    return layer;
  };
  for (const t of tasks) visit(t.id, new Set());
  return memo;
}

function costOf(cost: Record<string, unknown> | null): CostView | null {
  if (cost === null) return null;
  const totals = rec(rec(cost.cost).totals);
  const estimate = rec(totals.estimated);
  const actual = rec(totals.actual);
  return {
    estimatedUsd: num(estimate.usd),
    actualUsd: num(actual.usd),
    note: 'Estimates come from the registry prices; actuals are what runners reported (mock runs report fictional amounts).',
  };
}

function escalationsOf(
  rawEvents: readonly Record<string, unknown>[],
  tasks: readonly TaskView[],
): EscalationView[] {
  const lastModel = new Map<string, string>();
  const out: EscalationView[] = [];
  for (const e of rawEvents) {
    const taskId = str(e.taskId);
    const type = str(e.type);
    const model = typeof e.model === 'string' ? e.model : null;
    if (type === 'escalate') {
      const attempt = num(e.attempt) ?? 0;
      const attempts = tasks.find((t) => t.id === taskId)?.attempts ?? [];
      const before = attempts.find((a) => a.attempt === attempt - 1);
      const after = attempts.find((a) => a.attempt === attempt);
      out.push({
        taskId,
        attempt,
        fromModel: before?.model ?? lastModel.get(taskId) ?? null,
        toModel: model ?? after?.model ?? null,
        level: after?.escalationLevel ?? null,
        reason: str(e.reason),
        triggers: arr(e.triggers)
          .map(rec)
          .map((t) => ({ kind: str(t.kind, 'unknown'), detail: str(t.detail) })),
      });
    }
    if (ROUTING_EVENTS.has(type) && model !== null) lastModel.set(taskId, model);
  }
  return out;
}

export function toRunView(
  status: Record<string, unknown>,
  cost: Record<string, unknown> | null = null,
): RunView {
  const rawTasks = arr(status.tasks).map(rec);
  const base = rawTasks.map((t) => ({
    id: str(t.taskId),
    dependsOn: arr(t.dependsOn).map((d) => str(d)),
  }));
  const layerOf = layers(base);
  const tasks: TaskView[] = rawTasks.map((t) => {
    const id = str(t.taskId);
    const state = str(t.state, 'pending');
    return {
      id,
      state,
      complexity: str(t.complexity, '?'),
      dependsOn: arr(t.dependsOn).map((d) => str(d)),
      layer: layerOf.get(id) ?? 0,
      models: arr(t.models).map((m) => (typeof m === 'string' ? m : null)),
      attempts: arr(t.attemptDetails).map((a0) => {
        const a = rec(a0);
        return {
          attempt: num(a.attempt) ?? 0,
          state: str(a.state),
          model: typeof a.model === 'string' ? a.model : null,
          escalationLevel: num(a.escalationLevel),
          estimatedCostUsd: num(a.estimatedCostUsd),
          actualCostUsd: num(a.actualCostUsd),
          failure: typeof a.failure === 'string' ? a.failure : null,
          error: typeof a.error === 'string' ? a.error : null,
        };
      }),
      verdict: typeof t.verdict === 'string' ? t.verdict : null,
      complete: t.complete === true,
      reason: typeof t.reason === 'string' ? t.reason : null,
      active: ACTIVE_STATES.has(state),
    };
  });
  const rawEvents = arr(status.events).map(rec);
  const events: EventView[] = rawEvents
    .map((e) => ({
      taskId: str(e.taskId),
      attempt: num(e.attempt) ?? 0,
      type: str(e.type),
      model: typeof e.model === 'string' ? e.model : null,
      reason: str(e.reason),
    }))
    .filter((e) => NOTABLE_EVENTS.has(e.type));
  return {
    runId: str(status.runId),
    state: str(status.state, 'unknown'),
    running: status.running === true,
    prompt: str(status.prompt),
    tasks,
    events,
    escalations: escalationsOf(rawEvents, tasks),
    cost: costOf(cost),
  };
}
