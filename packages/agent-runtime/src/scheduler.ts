import { validateAgentResult, type AgentResult, type Task, type TaskGraph } from '@soot/task-graph';
import { monotonicClock, type AgentRunner, type Clock } from './agent.js';
import {
  SINGLE_ATTEMPT,
  classifyError,
  toPriorAttempt,
  type Assignment,
  type AttemptFailure,
  type AttemptRecord,
  type AttemptSupervisor,
} from './attempts.js';

export type TaskFinalState = 'succeeded' | 'failed' | 'cancelled' | 'skipped';

/** Final record of one task in a run. `succeeded` means the agent REPORTED success with a
 * valid result; checking acceptance criteria against real evidence is Milestone 5. */
export interface TaskOutcome {
  readonly taskId: string;
  readonly state: TaskFinalState;
  /** Attempt number that produced this outcome; `null` if the task never started. */
  readonly attempt: number | null;
  /** The validated agent result, if the agent returned one. */
  readonly result: AgentResult | null;
  /** Why the task did not succeed (validation error, crash, cancellation, failed prerequisite). */
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  /** True when the outcome was restored from a previous run instead of executed. */
  readonly resumed: boolean;
  /** Every attempt of this task, oldest first (including earlier runs' attempts when seeded). */
  readonly attempts: readonly AttemptRecord[];
}

export type SchedulerEvent =
  | {
      readonly type: 'task-started';
      readonly taskId: string;
      readonly attempt: number;
      readonly assignment: Assignment | null;
      readonly at: number;
    }
  | {
      /** An attempt ended and the supervisor reviewed it (accept, retry, or fail). */
      readonly type: 'attempt-finished';
      readonly taskId: string;
      readonly record: AttemptRecord;
      readonly at: number;
    }
  | {
      readonly type: 'task-finished';
      readonly taskId: string;
      readonly outcome: TaskOutcome;
      readonly at: number;
    };

/**
 * Durable sink for execution state. Called synchronously, so a journal that writes to disk
 * (e.g. the SQLite store in @soot/context-manager) has persisted each transition before the
 * scheduler moves on.
 */
export interface ExecutionJournal {
  taskStarted(event: {
    readonly taskId: string;
    readonly attempt: number;
    readonly at: number;
    readonly assignment?: Assignment | null;
  }): void;
  /** Every reviewed attempt, before the task's final `taskFinished` (Milestone 4). */
  attemptFinished?(record: AttemptRecord): void;
  taskFinished(outcome: TaskOutcome): void;
}

/**
 * Attempt timeout used when `attemptTimeoutMs` is not set: 30 minutes. Long enough for real
 * agent work, short enough that a hung runner (one that never settles and ignores abort) ends
 * as a `timeout` failure instead of blocking the run. Documented in docs/guides/configuration.md.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * 60_000;

/** "300 ms", "120s", "1.5s", "30 min": how timeouts read in history and the dashboard. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)} ms`;
  if (ms >= 120_000 && ms % 60_000 === 0) return `${String(ms / 60_000)} min`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? String(s) : s.toFixed(1)}s`;
}

export interface SchedulerOptions {
  readonly runner: AgentRunner;
  /** Maximum tasks running at once. Default 4. */
  readonly concurrency?: number;
  /** Aborting cancels the whole run. */
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
  readonly journal?: ExecutionJournal;
  /** Results of tasks that already succeeded in an earlier run; they are not re-run. */
  readonly completed?: ReadonlyMap<string, AgentResult>;
  /** Attempts already started per task in earlier runs; new attempts continue the count. */
  readonly previousAttempts?: ReadonlyMap<string, number>;
  readonly onEvent?: (event: SchedulerEvent) => void;
  /**
   * Decides the model for each attempt and whether to accept, retry, or fail it
   * (Milestone 4, e.g. @soot/escalation). Default: one attempt per task.
   */
  readonly supervisor?: AttemptSupervisor;
  /**
   * Abort an attempt that runs longer than this and record it as a `timeout` failure.
   * Default: `DEFAULT_ATTEMPT_TIMEOUT_MS` (30 minutes), so a hung runner never blocks a run
   * forever. An explicit value always wins.
   */
  readonly attemptTimeoutMs?: number;
  /** Reviewed attempts from earlier runs (e.g. loaded from the state store), per task. */
  readonly previousAttemptRecords?: ReadonlyMap<string, readonly AttemptRecord[]>;
}

export interface RunReport {
  /** `succeeded` only if every task succeeded. */
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly outcomes: ReadonlyMap<string, TaskOutcome>;
  readonly events: readonly SchedulerEvent[];
  readonly startedAt: number;
  readonly finishedAt: number;
  /** Highest number of tasks observed running at the same time. */
  readonly maxObservedConcurrency: number;
}

interface Running {
  readonly controller: AbortController;
  readonly attempt: number;
  readonly startedAt: number;
  readonly assignment: Assignment;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Executes a task graph: tasks whose prerequisites have succeeded run concurrently up to
 * `concurrency`; dependents wait; a failed or cancelled task skips its transitive
 * dependents; cancellation (whole run via `signal`/`cancel()`, or one task via
 * `cancel(taskId)`) stops work without waiting for runners that ignore the abort.
 */
export class Scheduler {
  readonly #graph: TaskGraph;
  readonly #runner: AgentRunner;
  readonly #concurrency: number;
  readonly #clock: Clock;
  readonly #options: SchedulerOptions;
  readonly #byId: ReadonlyMap<string, Task>;
  readonly #outcomes = new Map<string, TaskOutcome>();
  readonly #running = new Map<string, Running>();
  /** Tasks waiting for a scheduled retry (backoff); they hold no concurrency slot. */
  readonly #waiting = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #history = new Map<string, AttemptRecord[]>();
  readonly #supervisor: AttemptSupervisor;
  readonly #events: SchedulerEvent[] = [];
  #runCancelled = false;
  #maxObserved = 0;
  #started = false;
  #wake: (() => void) | undefined;

  constructor(graph: TaskGraph, options: SchedulerOptions) {
    const concurrency = options.concurrency ?? 4;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('concurrency must be a positive integer');
    }
    this.#graph = graph;
    this.#runner = options.runner;
    this.#concurrency = concurrency;
    this.#clock = options.clock ?? monotonicClock;
    this.#options = options;
    this.#byId = new Map(graph.tasks.map((t) => [t.id, t]));
    this.#supervisor = options.supervisor ?? SINGLE_ATTEMPT;
    for (const [taskId, records] of options.previousAttemptRecords ?? []) {
      this.#history.set(taskId, [...records]);
    }
  }

  /** Cancel one task (and skip its dependents), or the whole run when no id is given. */
  cancel(taskId?: string): void {
    if (taskId === undefined) {
      this.#cancelRun();
      return;
    }
    if (!this.#byId.has(taskId)) throw new Error(`Unknown task "${taskId}"`);
    if (this.#outcomes.has(taskId)) return;
    this.#finish(taskId, { state: 'cancelled', result: null, error: 'cancelled by request' });
    this.#pump();
  }

  async run(): Promise<RunReport> {
    if (this.#started) throw new Error('Scheduler.run() can only be called once');
    this.#started = true;
    const startedAt = this.#clock();
    const signal = this.#options.signal;
    const onAbort = () => {
      this.#cancelRun();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    for (const [taskId, result] of this.#options.completed ?? []) {
      if (!this.#byId.has(taskId) || result.status !== 'succeeded') continue;
      this.#record({
        taskId,
        state: 'succeeded',
        attempt: result.attempt,
        result,
        error: null,
        startedAt: null,
        finishedAt: null,
        resumed: true,
        attempts: [...(this.#history.get(taskId) ?? [])],
      });
    }
    if (signal?.aborted === true) this.#cancelRun();

    await new Promise<void>((resolve) => {
      this.#wake = resolve;
      this.#pump();
    });
    signal?.removeEventListener('abort', onAbort);

    const outcomes = new Map<string, TaskOutcome>();
    for (const task of this.#graph.tasks) {
      const taskOutcome = this.#outcomes.get(task.id);
      if (!taskOutcome) throw new Error(`internal: task "${task.id}" has no outcome`);
      outcomes.set(task.id, taskOutcome);
    }
    const states = [...outcomes.values()].map((o) => o.state);
    return {
      status: this.#runCancelled
        ? 'cancelled'
        : states.every((s) => s === 'succeeded')
          ? 'succeeded'
          : 'failed',
      outcomes,
      events: [...this.#events],
      startedAt,
      finishedAt: this.#clock(),
      maxObservedConcurrency: this.#maxObserved,
    };
  }

  #emit(event: SchedulerEvent): void {
    this.#events.push(event);
    this.#options.onEvent?.(event);
  }

  #record(outcome: TaskOutcome): void {
    this.#outcomes.set(outcome.taskId, outcome);
    if (!outcome.resumed) this.#options.journal?.taskFinished(outcome);
    this.#emit({
      type: 'task-finished',
      taskId: outcome.taskId,
      outcome,
      at: outcome.finishedAt ?? this.#clock(),
    });
  }

  #finish(taskId: string, end: Pick<TaskOutcome, 'state' | 'result' | 'error'>): void {
    if (this.#outcomes.has(taskId)) return;
    const running = this.#running.get(taskId);
    this.#running.delete(taskId);
    if (running !== undefined) {
      clearTimeout(running.timer);
      running.controller.abort();
    }
    const waiting = this.#waiting.get(taskId);
    if (waiting !== undefined) {
      clearTimeout(waiting);
      this.#waiting.delete(taskId);
    }
    const history = this.#history.get(taskId) ?? [];
    const last = history.at(-1);
    this.#record({
      taskId,
      ...end,
      attempt: running?.attempt ?? last?.attempt ?? null,
      startedAt: history[0]?.startedAt ?? running?.startedAt ?? null,
      finishedAt: this.#clock(),
      resumed: false,
      attempts: [...history],
    });
    if (end.state !== 'succeeded' && !this.#runCancelled) this.#skipDependents(taskId);
  }

  #skipDependents(taskId: string): void {
    for (const dependent of this.#graph.dependents.get(taskId) ?? []) {
      if (this.#outcomes.has(dependent)) continue;
      this.#finish(dependent, {
        state: 'skipped',
        result: null,
        error: `prerequisite "${taskId}" did not succeed`,
      });
    }
  }

  #cancelRun(): void {
    if (this.#runCancelled) return;
    this.#runCancelled = true;
    for (const task of this.#graph.tasks) {
      if (!this.#outcomes.has(task.id)) {
        this.#finish(task.id, { state: 'cancelled', result: null, error: 'run cancelled' });
      }
    }
    this.#pump();
  }

  #isReady(task: Task): boolean {
    if (this.#outcomes.has(task.id) || this.#running.has(task.id) || this.#waiting.has(task.id))
      return false;
    return (this.#graph.prerequisites.get(task.id) ?? []).every(
      (dep) => this.#outcomes.get(dep)?.state === 'succeeded',
    );
  }

  #pump(): void {
    if (!this.#runCancelled) {
      for (const task of this.#graph.tasks) {
        if (this.#running.size >= this.#concurrency) break;
        if (this.#isReady(task)) this.#start(task);
      }
    }
    if (this.#running.size === 0 && this.#outcomes.size === this.#graph.tasks.length) {
      const wake = this.#wake;
      this.#wake = undefined;
      wake?.();
    } else if (this.#running.size === 0 && this.#waiting.size === 0 && this.#wake) {
      // Nothing running and nothing startable: every remaining task must be blocked by a
      // prerequisite that cannot succeed. Graphs are acyclic, so this is unreachable;
      // guard anyway so a bug cannot hang the run.
      for (const task of this.#graph.tasks) {
        if (!this.#outcomes.has(task.id)) {
          this.#finish(task.id, {
            state: 'skipped',
            result: null,
            error: 'unreachable: no runnable prerequisites',
          });
        }
      }
      this.#pump();
    }
  }

  #nextAttempt(taskId: string): number {
    const fromHistory = this.#history.get(taskId)?.at(-1)?.attempt ?? 0;
    return Math.max(this.#options.previousAttempts?.get(taskId) ?? 0, fromHistory) + 1;
  }

  #start(task: Task): void {
    const history = this.#history.get(task.id) ?? [];
    const attempt = this.#nextAttempt(task.id);
    const dependencyResults = (this.#graph.prerequisites.get(task.id) ?? []).flatMap((dep) => {
      const result = this.#outcomes.get(dep)?.result;
      return result ? [result] : [];
    });
    const plan = this.#supervisor.plan({ task, attempt, history, dependencyResults });
    if (plan.action === 'stop') {
      const last = history.at(-1);
      this.#finish(task.id, {
        state: 'failed',
        result: last?.result ?? null,
        error: plan.reason,
      });
      return;
    }

    const controller = new AbortController();
    const startedAt = this.#clock();
    const running: Running = {
      controller,
      attempt,
      startedAt,
      assignment: plan.assignment,
      timedOut: false,
      timer: undefined,
    };
    this.#running.set(task.id, running);
    this.#maxObserved = Math.max(this.#maxObserved, this.#running.size);
    this.#options.journal?.taskStarted({
      taskId: task.id,
      attempt,
      at: startedAt,
      assignment: plan.assignment,
    });
    this.#emit({
      type: 'task-started',
      taskId: task.id,
      attempt,
      assignment: plan.assignment,
      at: startedAt,
    });
    const timeoutMs = this.#options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    running.timer = setTimeout(() => {
      running.timedOut = true;
      this.#endAttempt(task, controller, null, {
        kind: 'timeout',
        message: `attempt timed out after ${formatDuration(timeoutMs)}`,
        provider: null,
        retryAfterMs: null,
      });
      controller.abort();
    }, timeoutMs);

    let promise: Promise<unknown>;
    try {
      promise = this.#runner.run(
        {
          task,
          attempt,
          dependencyResults,
          assignment: plan.assignment,
          priorAttempts: history.map(toPriorAttempt),
        },
        controller.signal,
      );
    } catch (error) {
      promise = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    promise.then(
      (raw) => {
        this.#settle(task, controller, raw);
      },
      (error: unknown) => {
        this.#endAttempt(task, controller, null, classifyError(error));
      },
    );
  }

  #settle(task: Task, controller: AbortController, raw: unknown): void {
    const running = this.#running.get(task.id);
    // Ignore late results from attempts that were cancelled, timed out, or already finished.
    if (running?.controller !== controller) return;
    const invalid = (message: string): AttemptFailure => ({
      kind: 'invalid-output',
      message,
      provider: null,
      retryAfterMs: null,
    });
    const checked = validateAgentResult(raw);
    if (!checked.ok) {
      const detail = checked.issues
        .map((i) => `${i.path === '' ? '(root)' : i.path}: ${i.message}`)
        .join('; ');
      this.#endAttempt(task, controller, null, invalid(`invalid agent result: ${detail}`));
      return;
    }
    const result = checked.value;
    if (result.taskId !== task.id || result.attempt !== running.attempt) {
      this.#endAttempt(
        task,
        controller,
        null,
        invalid(
          `agent result is for ${result.taskId}#${result.attempt}, expected ${task.id}#${running.attempt}`,
        ),
      );
      return;
    }
    const failure: AttemptFailure | null =
      result.status === 'succeeded'
        ? null
        : {
            kind:
              result.status === 'failed'
                ? 'reported-failure'
                : result.status === 'blocked'
                  ? 'blocked'
                  : 'cancelled',
            message: `agent reported ${result.status}`,
            provider: null,
            retryAfterMs: null,
          };
    this.#endAttempt(task, controller, result, failure);
  }

  /** Review a finished attempt and accept it, schedule a retry, or fail the task. */
  #endAttempt(
    task: Task,
    controller: AbortController,
    result: AgentResult | null,
    failure: AttemptFailure | null,
  ): void {
    const running = this.#running.get(task.id);
    if (running?.controller !== controller) return;
    clearTimeout(running.timer);
    this.#running.delete(task.id);
    const history = this.#history.get(task.id) ?? [];
    const base: AttemptRecord = {
      taskId: task.id,
      attempt: running.attempt,
      assignment: running.assignment,
      result,
      failure,
      review: null,
      startedAt: running.startedAt,
      finishedAt: this.#clock(),
    };
    let review = this.#supervisor.review({ task, record: base, history });
    if (review.action === 'accept' && failure !== null) {
      review = { action: 'fail', reason: failure.message };
    }
    const record: AttemptRecord = {
      ...base,
      review,
      failure:
        failure ??
        (review.action === 'accept'
          ? null
          : {
              kind: 'rejected',
              message: review.action === 'retry' ? review.note : review.reason,
              provider: null,
              retryAfterMs: null,
            }),
    };
    this.#history.set(task.id, [...history, record]);
    this.#options.journal?.attemptFinished?.(record);
    this.#emit({ type: 'attempt-finished', taskId: task.id, record, at: record.finishedAt ?? 0 });

    if (review.action === 'accept') {
      this.#finishAttempted(task.id, running, { state: 'succeeded', result, error: null });
    } else if (review.action === 'fail') {
      this.#finishAttempted(task.id, running, {
        state: record.failure?.kind === 'cancelled' ? 'cancelled' : 'failed',
        result,
        error: review.reason,
      });
    } else if (!this.#runCancelled) {
      const timer = setTimeout(
        () => {
          this.#waiting.delete(task.id);
          this.#pump();
        },
        Math.max(0, review.delayMs),
      );
      this.#waiting.set(task.id, timer);
    }
    this.#pump();
  }

  /** Finish a task whose last attempt has already been removed from `#running`. */
  #finishAttempted(
    taskId: string,
    running: Running,
    end: Pick<TaskOutcome, 'state' | 'result' | 'error'>,
  ): void {
    if (this.#outcomes.has(taskId)) return;
    const history = this.#history.get(taskId) ?? [];
    this.#record({
      taskId,
      ...end,
      attempt: running.attempt,
      startedAt: history[0]?.startedAt ?? running.startedAt,
      finishedAt: this.#clock(),
      resumed: false,
      attempts: [...history],
    });
    if (end.state !== 'succeeded' && !this.#runCancelled) this.#skipDependents(taskId);
  }
}

/** Convenience wrapper: build a scheduler and run it. */
export function runTaskGraph(graph: TaskGraph, options: SchedulerOptions): Promise<RunReport> {
  return new Scheduler(graph, options).run();
}
