import { validateAgentResult, type AgentResult, type Task, type TaskGraph } from '@soot/task-graph';
import { monotonicClock, type AgentRunner, type Clock } from './agent.js';

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
}

export type SchedulerEvent =
  | {
      readonly type: 'task-started';
      readonly taskId: string;
      readonly attempt: number;
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
  }): void;
  taskFinished(outcome: TaskOutcome): void;
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
    running?.controller.abort();
    this.#record({
      taskId,
      ...end,
      attempt: running?.attempt ?? null,
      startedAt: running?.startedAt ?? null,
      finishedAt: this.#clock(),
      resumed: false,
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
    if (this.#outcomes.has(task.id) || this.#running.has(task.id)) return false;
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
    } else if (this.#running.size === 0 && this.#wake) {
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

  #start(task: Task): void {
    const attempt = (this.#options.previousAttempts?.get(task.id) ?? 0) + 1;
    const controller = new AbortController();
    const startedAt = this.#clock();
    this.#running.set(task.id, { controller, attempt, startedAt });
    this.#maxObserved = Math.max(this.#maxObserved, this.#running.size);
    this.#options.journal?.taskStarted({ taskId: task.id, attempt, at: startedAt });
    this.#emit({ type: 'task-started', taskId: task.id, attempt, at: startedAt });

    const dependencyResults = (this.#graph.prerequisites.get(task.id) ?? []).flatMap((dep) => {
      const result = this.#outcomes.get(dep)?.result;
      return result ? [result] : [];
    });

    let promise: Promise<unknown>;
    try {
      promise = this.#runner.run({ task, attempt, dependencyResults }, controller.signal);
    } catch (error) {
      promise = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    promise.then(
      (raw) => {
        this.#settle(task.id, controller, raw);
      },
      (error: unknown) => {
        if (this.#running.get(task.id)?.controller !== controller) return;
        this.#finish(task.id, {
          state: 'failed',
          result: null,
          error: `agent error: ${error instanceof Error ? error.message : String(error)}`,
        });
        this.#pump();
      },
    );
  }

  #settle(taskId: string, controller: AbortController, raw: unknown): void {
    const running = this.#running.get(taskId);
    // Ignore late results from attempts that were cancelled or already finished.
    if (running?.controller !== controller) return;
    const checked = validateAgentResult(raw);
    if (!checked.ok) {
      const detail = checked.issues
        .map((i) => `${i.path === '' ? '(root)' : i.path}: ${i.message}`)
        .join('; ');
      this.#finish(taskId, {
        state: 'failed',
        result: null,
        error: `invalid agent result: ${detail}`,
      });
    } else if (checked.value.taskId !== taskId || checked.value.attempt !== running.attempt) {
      this.#finish(taskId, {
        state: 'failed',
        result: null,
        error: `agent result is for ${checked.value.taskId}#${checked.value.attempt}, expected ${taskId}#${running.attempt}`,
      });
    } else {
      const result = checked.value;
      const state: TaskFinalState =
        result.status === 'succeeded'
          ? 'succeeded'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
      this.#finish(taskId, {
        state,
        result,
        error: state === 'succeeded' ? null : `agent reported ${result.status}`,
      });
    }
    this.#pump();
  }
}

/** Convenience wrapper: build a scheduler and run it. */
export function runTaskGraph(graph: TaskGraph, options: SchedulerOptions): Promise<RunReport> {
  return new Scheduler(graph, options).run();
}
