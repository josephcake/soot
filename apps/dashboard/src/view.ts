import { usageCharts, type UsageCharts } from './charts.js';
/*
 * Builds the dashboard's run view from what the engine already reports: the `soot status <run>`
 * and `soot cost <run>` data (SQLite state, saved report, events file). Nothing here computes
 * new numbers beyond counting and summing what the engine reported; unknown stays null. There
 * is no benchmark data, so no savings are ever shown.
 */

/** What `soot status` / `soot cost` return (the engine's `CommandOutput`). */
export interface SourceResult {
  readonly ok: boolean;
  readonly text: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The engine, read-only. `soot dashboard` passes the CLI's `SootEngine`. */
export interface DashboardSource {
  status(runId?: string): Promise<SourceResult>;
  cost(runId?: string): Promise<SourceResult>;
}

export interface RunListItem {
  readonly runId: string;
  readonly createdAt: string;
  readonly state: string;
  readonly tasks: number;
  readonly prompt: string;
}

export interface CheckView {
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly exitCode: number | null;
}

export interface AttemptView {
  readonly attempt: number;
  readonly state: string;
  readonly model: string | null;
  readonly estimatedCostUsd: number | null;
  readonly actualCostUsd: number | null;
  readonly failure: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly instructions: string;
  readonly complexity: string;
  readonly dependsOn: readonly string[];
  readonly layer: number;
  readonly state: string;
  /** Model per attempt, in order (the model path). */
  readonly models: readonly (string | null)[];
  readonly verdict: string | null;
  readonly complete: boolean;
  readonly reason: string | null;
  readonly checks: readonly CheckView[];
  readonly attempts: readonly AttemptView[];
}

export interface TransitionView {
  readonly taskId: string;
  readonly attempt: number;
  readonly type: string;
  readonly model: string | null;
  readonly reason: string;
}

export interface ModelCostView {
  readonly model: string;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Reported actual cost; null when any attempt on this model is unpriced. */
  readonly actualUsd: number | null;
}

export interface DashboardRun {
  readonly runId: string;
  readonly state: string;
  readonly running: boolean;
  readonly prompt: string;
  readonly createdAt: string | null;
  readonly agent: { readonly kind: string | null; readonly label: string | null };
  readonly usage: UsageCharts;
  readonly assignment: {
    readonly prompt: string;
    readonly tasks: readonly {
      id: string;
      title: string;
      instructions: string;
      dependsOn: readonly string[];
      runner: string | null;
      attempts: readonly {
        attempt: number;
        routedModel: string | null;
        reportedModel: string | null;
        state: string;
        /** How the supervisor chose this attempt's model (assign, retry, fallback, escalate, downgrade). */
        via: string | null;
        reason: string | null;
      }[];
    }[];
  };
  readonly taskCount: number;
  readonly graph: { readonly layers: readonly (readonly string[])[] };
  readonly tasks: readonly TaskView[];
  readonly activeAgents: readonly { taskId: string; attempt: number; model: string | null }[];
  readonly transitions: readonly TransitionView[];
  readonly tokens: {
    readonly estimated: { readonly inputTokens: number; readonly outputTokens: number } | null;
    readonly actual: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** Attempts with no runner result (their tokens are not in the sums). */
      readonly unreportedAttempts: number;
    } | null;
  };
  readonly cost: {
    /** Planner estimate; null when unknown (an unpriced model). */
    readonly estimatedUsd: number | null;
    /** Sum of reported actuals; null when any attempt is unpriced or no cost data exists. */
    readonly actualUsd: number | null;
    readonly unpricedAttempts: number | null;
    /** Router estimates per attempt, summed; null when unknown. Never an actual. */
    readonly routedEstimateUsd: number | null;
  };
  readonly byModel: readonly ModelCostView[];
  readonly duration: {
    readonly startedAt: string | null;
    /** Latest attempt finish; null while running or before any attempt finished. */
    readonly endedAt: string | null;
    readonly ms: number | null;
    readonly basis: string;
  };
  readonly outcomes: {
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly skipped: number;
    readonly unfinished: number;
    /** soot-verified complete tasks (saved report). */
    readonly complete: number;
    /** succeeded / finished tasks; null when no task finished. */
    readonly successRate: number | null;
    readonly failureRate: number | null;
  };
  readonly validation: {
    readonly reportStatus: string | null;
    readonly final:
      readonly (CheckView & { required: boolean; durationMs: number | null })[] | null;
    readonly problems: readonly string[];
  };
  readonly savings: { readonly claimed: false; readonly note: string };
  /**
   * The planning (decomposition) call, when the status data carries it: `null` when not
   * recorded. A fixture plan made no model call (`kind: 'fixture'`).
   */
  readonly planning: PlanningCall | null;
  /**
   * Per-task tokens, models and the run's runner. soot records one agent/harness
   * per run, not per task; `runner` is that run-level label. Tokens come from
   * the cost report's per-task actuals; null when not reported.
   */
  readonly taskBreakdown: readonly TaskBreakdown[];
}

export interface PlanningCall {
  readonly kind: 'model' | 'fixture';
  /** Registry reference, e.g. `provider/model`; null for a fixture plan. */
  readonly model: string | null;
  /** The model id the provider said it served, when reported. */
  readonly servedModel: string | null;
  /** Reported usage; null when not reported. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Reported or priced cost; null when no price was recorded (never read as 0). */
  readonly costUsd: number | null;
}

export interface TaskBreakdown {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  /** Runner for the whole run (soot does not record a per-task agent). */
  readonly runner: string | null;
  readonly models: readonly (string | null)[];
  readonly attempts: number;
  readonly tokens: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly total: number;
  } | null;
  readonly costUsd: number | null;
  /** Why tokens are unknown; null when reported for every attempt on this task. */
  readonly tokensUnknown: string | null;
  /** Why cost is unknown; null when every attempt on this task is priced. */
  readonly costUnknown: string | null;
  /** Attempts whose model has no price in the registry (from the cost report); null = no data. */
  readonly unpricedAttempts: number | null;
  /** Attempts that reported no usage at all; null = no data. */
  readonly unreportedAttempts: number | null;
}

export const SAVINGS_NOTE =
  'No benchmark data yet: soot does not claim savings against a single expensive model.';

const TRANSITION_EVENTS = new Set(['retry', 'fallback', 'escalate', 'downgrade']);
const ASSIGNING_EVENTS = new Set(['assign', ...TRANSITION_EVENTS]);

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function check(c0: unknown): CheckView {
  const c = rec(c0);
  return {
    name: str(c.name),
    kind: str(c.kind),
    status: str(c.status),
    exitCode: num(c.exitCode),
  };
}

/** Dependency layer per task (0 = no prerequisites); cycles or unknown ids fall to layer 0. */
function layersOf(tasks: readonly { id: string; dependsOn: readonly string[] }[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const layer = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = layer.get(id);
    if (known !== undefined) return known;
    const t = byId.get(id);
    if (t === undefined || seen.has(id)) return 0;
    seen.add(id);
    const deps = t.dependsOn.filter((d) => byId.has(d));
    const l = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => visit(d, seen)));
    layer.set(id, l);
    return l;
  };
  for (const t of tasks) visit(t.id, new Set());
  return layer;
}

function taskBreakdown(
  tasks: readonly TaskView[],
  usage: UsageCharts,
  runner: string | null,
  cost: Readonly<Record<string, unknown>> | null,
): TaskBreakdown[] {
  const byId = new Map(usage.byTask.map((r) => [r.label, r]));
  const actualById = new Map(
    arr(rec(cost?.cost).tasks)
      .map(rec)
      .map((c) => [str(c.taskId), rec(c.actual)] as const),
  );
  return tasks.map((t) => {
    const row = byId.get(t.id);
    const actual = actualById.get(t.id);
    const unpricedAttempts = actual === undefined ? null : num(actual.unpricedAttempts);
    const unreportedAttempts = actual === undefined ? null : num(actual.unreportedAttempts);
    if (row === undefined) {
      return {
        id: t.id,
        title: t.title,
        state: t.state,
        runner,
        models: t.models,
        attempts: t.attempts.length,
        tokens: null,
        costUsd: null,
        tokensUnknown: 'no cost data recorded for this task',
        costUnknown: 'no cost data recorded for this task',
        unpricedAttempts,
        unreportedAttempts,
      };
    }
    const input = row.actual.inputTokens;
    const output = row.actual.outputTokens;
    const tokens =
      input === null || output === null
        ? null
        : { inputTokens: input, outputTokens: output, total: input + output };
    return {
      id: t.id,
      title: t.title,
      state: t.state,
      runner,
      models: t.models,
      attempts: t.attempts.length,
      tokens,
      costUsd: row.actual.usd,
      tokensUnknown: tokens === null ? 'tokens not reported for every attempt on this task' : null,
      costUnknown:
        row.actual.usd === null ? 'cost not reported for every attempt on this task' : null,
      unpricedAttempts,
      unreportedAttempts,
    };
  });
}

/** The saved report's `decomposition` record, when the status data includes it. */
export function planningCall(v: unknown): PlanningCall | null {
  const d = rec(v);
  if (d.kind === 'fixture') {
    return {
      kind: 'fixture',
      model: null,
      servedModel: null,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    };
  }
  if (d.kind !== 'model' || typeof d.modelRef !== 'string') return null;
  const usage = rec(d.usage);
  return {
    kind: 'model',
    model: d.modelRef,
    servedModel: strOrNull(d.servedModelId),
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    costUsd: num(d.costUsd),
  };
}

export function toRunList(status: SourceResult): readonly RunListItem[] {
  return arr(status.data.runs)
    .map(rec)
    .map((r) => ({
      runId: str(r.runId),
      createdAt: str(r.createdAt),
      state: str(r.state, 'unknown'),
      tasks: num(r.tasks) ?? 0,
      prompt: str(r.prompt),
    }));
}

/** `status` is `soot status <run>` data; `cost` is `soot cost <run>` data or null. */
export function toDashboardRun(
  status: Readonly<Record<string, unknown>>,
  cost: Readonly<Record<string, unknown>> | null,
): DashboardRun {
  const raw = arr(status.tasks).map(rec);
  const base = raw.map((t) => ({
    id: str(t.taskId),
    dependsOn: arr(t.dependsOn).map((d) => str(d)),
  }));
  const layer = layersOf(base);
  const tasks: TaskView[] = raw.map((t, i) => ({
    id: base[i]?.id ?? '',
    title: str(t.title),
    instructions: str(t.instructions),
    complexity: str(t.complexity, '?'),
    dependsOn: base[i]?.dependsOn ?? [],
    layer: layer.get(base[i]?.id ?? '') ?? 0,
    state: str(t.state, 'pending'),
    models: arr(t.models).map(strOrNull),
    verdict: strOrNull(t.verdict),
    complete: t.complete === true,
    reason: strOrNull(t.reason),
    checks: arr(t.checks).map(check),
    attempts: arr(t.attemptDetails)
      .map(rec)
      .map((a) => ({
        attempt: num(a.attempt) ?? 0,
        state: str(a.state),
        model: strOrNull(a.model),
        estimatedCostUsd: num(a.estimatedCostUsd),
        actualCostUsd: num(a.actualCostUsd),
        failure: strOrNull(a.failure),
        startedAt: strOrNull(a.startedAt),
        finishedAt: strOrNull(a.finishedAt),
      })),
  }));

  const maxLayer = Math.max(-1, ...tasks.map((t) => t.layer));
  const layers = Array.from({ length: maxLayer + 1 }, (_, l) =>
    tasks.filter((t) => t.layer === l).map((t) => t.id),
  );

  const running = status.running === true;
  const activeAgents = tasks.flatMap((t) => {
    const a = t.attempts.findLast((x) => x.state === 'running');
    return t.state === 'running' && a !== undefined
      ? [{ taskId: t.id, attempt: a.attempt, model: a.model }]
      : [];
  });

  const transitions = arr(status.events)
    .map(rec)
    .filter((e) => TRANSITION_EVENTS.has(str(e.type)))
    .map((e) => ({
      taskId: str(e.taskId),
      attempt: num(e.attempt) ?? 0,
      type: str(e.type),
      model: strOrNull(e.model),
      reason: str(e.reason),
    }));

  const report = cost === null ? null : rec(cost.cost);
  const totals = report === null ? null : rec(report.totals);
  const est = totals === null ? null : rec(totals.estimated);
  const act = totals === null ? null : rec(totals.actual);
  const routed = cost === null ? null : rec(rec(cost.costSummary).routed);

  const starts = tasks.flatMap((t) => t.attempts.map((a) => a.startedAt));
  const ends = tasks.flatMap((t) => t.attempts.map((a) => a.finishedAt));
  const startedAt =
    strOrNull(status.createdAt) ?? starts.filter((s): s is string => s !== null).sort()[0] ?? null;
  const finished = ends.filter((s): s is string => s !== null).sort();
  const endedAt = running ? null : (finished.at(-1) ?? null);
  const ms =
    startedAt === null || endedAt === null ? null : Date.parse(endedAt) - Date.parse(startedAt);

  const count = (s: string) => tasks.filter((t) => t.state === s).length;
  const succeeded = count('succeeded');
  const failed = count('failed');
  const cancelled = count('cancelled');
  const skipped = count('skipped');
  const done = succeeded + failed + cancelled + skipped;
  const agentLabel = strOrNull(status.agentLabel);
  const usage = usageCharts(cost, agentLabel);

  return {
    runId: str(status.runId),
    state: str(status.state, 'unknown'),
    running,
    prompt: str(status.prompt),
    createdAt: strOrNull(status.createdAt),
    agent: { kind: strOrNull(status.agent), label: strOrNull(status.agentLabel) },
    usage,
    assignment: {
      prompt: str(status.prompt),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        instructions: t.instructions,
        dependsOn: t.dependsOn,
        runner: agentLabel,
        attempts: t.attempts.map((a) => {
          const ct = arr(rec(cost?.cost).tasks)
            .map(rec)
            .find((x) => x.taskId === t.id);
          const ca = arr(ct?.attempts)
            .map(rec)
            .find((x) => x.attempt === a.attempt);
          // A transition (retry, fallback, escalate, downgrade) explains the model better than
          // the plain assign event for the same attempt.
          const evs = arr(status.events)
            .map(rec)
            .filter(
              (e) =>
                e.taskId === t.id && e.attempt === a.attempt && ASSIGNING_EVENTS.has(str(e.type)),
            );
          const ev = evs.find((e) => TRANSITION_EVENTS.has(str(e.type))) ?? evs[0];
          return {
            attempt: a.attempt,
            via: ev === undefined ? null : str(ev.type),
            reason: ev === undefined ? null : str(ev.reason),
            routedModel: a.model,
            reportedModel: ca?.status === 'no-result' ? null : strOrNull(ca?.model),
            state: a.state,
          };
        }),
      })),
    },
    taskCount: tasks.length,
    graph: { layers },
    tasks,
    activeAgents,
    transitions,
    tokens: {
      estimated:
        est === null
          ? null
          : { inputTokens: num(est.inputTokens) ?? 0, outputTokens: num(est.outputTokens) ?? 0 },
      actual:
        act === null
          ? null
          : {
              inputTokens: num(act.inputTokens) ?? 0,
              outputTokens: num(act.outputTokens) ?? 0,
              unreportedAttempts: num(act.unreportedAttempts) ?? 0,
            },
    },
    cost: {
      estimatedUsd: est === null ? null : num(est.usd),
      actualUsd: act === null ? null : num(act.usd),
      unpricedAttempts: act === null ? null : num(act.unpricedAttempts),
      routedEstimateUsd: routed === null ? null : num(routed.costUsd),
    },
    byModel:
      report === null
        ? []
        : arr(report.byModel)
            .map(rec)
            .map((m) => ({
              model: str(m.model),
              attempts: num(m.attempts) ?? 0,
              inputTokens: num(m.inputTokens) ?? 0,
              outputTokens: num(m.outputTokens) ?? 0,
              actualUsd: num(m.actualUsd),
            })),
    duration: {
      startedAt,
      endedAt,
      ms: ms === null || Number.isNaN(ms) ? null : ms,
      basis: 'run creation to the last attempt finish (wall clock, from saved state)',
    },
    outcomes: {
      succeeded,
      failed,
      cancelled,
      skipped,
      unfinished: tasks.length - done,
      complete: tasks.filter((t) => t.complete).length,
      successRate: done === 0 ? null : succeeded / done,
      failureRate: done === 0 ? null : (failed + cancelled + skipped) / done,
    },
    validation: {
      reportStatus: strOrNull(status.reportStatus),
      final:
        status.finalValidation === null || status.finalValidation === undefined
          ? null
          : arr(status.finalValidation).map((c) => ({
              ...check(c),
              required: rec(c).required === true,
              durationMs: num(rec(c).durationMs),
            })),
      problems: arr(status.problems).map((p) => str(p)),
    },
    savings: { claimed: false, note: SAVINGS_NOTE },
    taskBreakdown: taskBreakdown(tasks, usage, agentLabel, cost),
    planning: planningCall(status.decomposition),
  };
}
