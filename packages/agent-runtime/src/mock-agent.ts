import type { AgentResult, ReportedUsage } from '@soot/task-graph';
import { monotonicClock, type AgentRunner, type AgentTaskInput, type Clock } from './agent.js';

/*
 * TEST DOUBLE. MockAgentRunner calls no model, reads no files, and makes no network
 * requests. It returns scripted results after scripted delays so the scheduler, state
 * store, and end-to-end flow can be tested deterministically. Never present its output as
 * real agent work.
 */

export type MockOutcome =
  /** Return a valid `succeeded` result. */
  | 'succeed'
  /** Return a valid `failed` result. */
  | 'fail'
  /** Return a valid `blocked` result. */
  | 'block'
  /** Reject with an error (agent crash). */
  | 'throw'
  /** Return an object that violates `AgentResultSchema`. */
  | 'invalid'
  /** Never settle and ignore abort signals (a hung agent). */
  | 'hang';

export interface MockScript {
  readonly outcome?: MockOutcome;
  /** Delay before settling, in ms. Default 0. Honors abort unless `outcome` is `hang`. */
  readonly delayMs?: number;
  readonly summary?: string;
  readonly usage?: Partial<Pick<ReportedUsage, 'inputTokens' | 'outputTokens'>>;
}

export interface MockCall {
  readonly taskId: string;
  readonly attempt: number;
  readonly dependencyTaskIds: readonly string[];
  readonly startedAt: number;
  finishedAt: number | null;
  settledAs: 'resolved' | 'rejected' | 'aborted' | null;
}

export class MockAgentAbortError extends Error {
  constructor(taskId: string) {
    super(`mock agent for "${taskId}" aborted`);
    this.name = 'AbortError';
  }
}

export interface MockAgentRunnerOptions {
  /** Script per task id. An array gives one script per attempt (last one repeats). */
  readonly scripts?: Readonly<Record<string, MockScript | readonly MockScript[]>>;
  /** Script for tasks without an entry. Default: succeed immediately. */
  readonly defaultScript?: MockScript;
  readonly clock?: Clock;
}

/** Scripted, in-memory stand-in for an agent. See the TEST DOUBLE note above. */
export class MockAgentRunner implements AgentRunner {
  readonly kind = 'mock-test-double';
  readonly calls: MockCall[] = [];
  readonly #options: MockAgentRunnerOptions;
  readonly #clock: Clock;

  constructor(options: MockAgentRunnerOptions = {}) {
    this.#options = options;
    this.#clock = options.clock ?? monotonicClock;
  }

  /** Task ids in the order the runner was invoked. */
  get invokedTaskIds(): string[] {
    return this.calls.map((c) => c.taskId);
  }

  #scriptFor(taskId: string, attempt: number): MockScript {
    const entry = this.#options.scripts?.[taskId];
    if (entry === undefined) return this.#options.defaultScript ?? {};
    if (!Array.isArray(entry)) return entry as MockScript;
    const list = entry as readonly MockScript[];
    return list[Math.min(attempt, list.length) - 1] ?? {};
  }

  run(input: AgentTaskInput, signal: AbortSignal): Promise<unknown> {
    const { task, attempt } = input;
    const script = this.#scriptFor(task.id, attempt);
    const outcome = script.outcome ?? 'succeed';
    const call: MockCall = {
      taskId: task.id,
      attempt,
      dependencyTaskIds: input.dependencyResults.map((r) => r.taskId),
      startedAt: this.#clock(),
      finishedAt: null,
      settledAs: null,
    };
    this.calls.push(call);
    const settle = (as: NonNullable<MockCall['settledAs']>) => {
      call.finishedAt = this.#clock();
      call.settledAs = as;
    };

    if (outcome === 'hang') return new Promise<never>(() => undefined);

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        settle('aborted');
        reject(new MockAgentAbortError(task.id));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        if (outcome === 'throw') {
          settle('rejected');
          reject(new Error(`mock agent for "${task.id}" crashed (scripted)`));
          return;
        }
        settle('resolved');
        resolve(
          outcome === 'invalid'
            ? { taskId: task.id, transcript: 'free-form text' }
            : this.#result(input, script, outcome, call),
        );
      }, script.delayMs ?? 0);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  #result(
    input: AgentTaskInput,
    script: MockScript,
    outcome: 'succeed' | 'fail' | 'block',
    call: MockCall,
  ): AgentResult {
    const status = outcome === 'succeed' ? 'succeeded' : outcome === 'fail' ? 'failed' : 'blocked';
    return {
      taskId: input.task.id,
      attempt: input.attempt,
      status,
      summary: script.summary ?? `[mock] ${status}: ${input.task.title}`,
      findings: [
        { kind: 'observation', message: '[mock] scripted result; no real work was performed.' },
      ],
      patch: null,
      evidence: [],
      usage: {
        inputTokens: script.usage?.inputTokens ?? 0,
        outputTokens: script.usage?.outputTokens ?? 0,
        durationMs: (call.finishedAt ?? call.startedAt) - call.startedAt,
        costUsd: null,
        model: null,
      },
    };
  }
}
