import type { AgentResult, AgentSignals, Finding, ReportedUsage } from '@soot/task-graph';
import { monotonicClock, type AgentRunner, type AgentTaskInput, type Clock } from './agent.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { Assignment, PriorAttempt } from './attempts.js';
import type { ApprovalAction, ApprovalDecision } from './permissions.js';

/*
 * TEST DOUBLE. MockAgentRunner calls no model, reads no files, and makes no network
 * requests. It writes only scripted files inside the workspace soot gave it (Milestone 5). It returns scripted results after scripted delays so the scheduler, state
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
  | 'hang'
  /** Reject with a provider-style error (`error` below), e.g. a rate limit or outage. */
  | 'provider-error';

export interface MockScript {
  readonly outcome?: MockOutcome;
  /** Delay before settling, in ms. Default 0. Honors abort unless `outcome` is `hang`. */
  readonly delayMs?: number;
  readonly summary?: string;
  /** Reported usage. `costUsd` stands in for provider usage metadata (fictional amounts). */
  readonly usage?: Partial<Pick<ReportedUsage, 'inputTokens' | 'outputTokens' | 'costUsd'>>;
  /**
   * Files to write in the task workspace before settling (`null` deletes). Paths are relative
   * to the workspace root; the double may write outside the declared scope (soot must catch
   * that) but never outside the workspace root.
   */
  readonly writes?: Readonly<Record<string, string | null>>;
  /** Ask for approval first; if not approved, return `blocked` without writing anything. */
  readonly approval?: { readonly action: ApprovalAction; readonly detail: string };
  /** Self-assessment to report (confidence, complexity, tool errors, ...). */
  readonly signals?: AgentSignals;
  /** Findings to report instead of the default `[mock]` observation. */
  readonly findings?: readonly Finding[];
  /** For `provider-error`: the error's kind, provider, and retry-after. */
  readonly error?: {
    readonly kind: 'rate-limited' | 'unavailable' | 'timeout' | 'auth' | 'invalid-output';
    readonly provider?: string;
    readonly retryAfterMs?: number;
  };
}

/** Provider-shaped error thrown by the mock (recognised structurally, like `ProviderError`). */
export class MockProviderError extends Error {
  readonly kind: string;
  readonly provider: string | null;
  readonly retryAfterMs: number | null;
  constructor(kind: string, provider: string | null, retryAfterMs: number | null) {
    super(`[mock] ${kind}${provider === null ? '' : ` from ${provider}`} (scripted)`);
    this.name = 'MockProviderError';
    this.kind = kind;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface MockCall {
  /** Answer to the scripted approval request, if any. */
  approval: ApprovalDecision | null;
  readonly taskId: string;
  readonly attempt: number;
  readonly dependencyTaskIds: readonly string[];
  /** Model the scheduler assigned to this attempt, if any. */
  readonly assignment: Assignment | null;
  /** Context transferred from earlier attempts of the same task. */
  readonly priorAttempts: readonly PriorAttempt[];
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
  /** Script chosen from the full input (e.g. by assigned model); takes precedence when it returns one. */
  readonly scriptFor?: (input: AgentTaskInput) => MockScript | undefined;
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
    const script = this.#options.scriptFor?.(input) ?? this.#scriptFor(task.id, attempt);
    const outcome = script.outcome ?? 'succeed';
    const call: MockCall = {
      taskId: task.id,
      attempt,
      dependencyTaskIds: input.dependencyResults.map((r) => r.taskId),
      assignment: input.assignment ?? null,
      priorAttempts: input.priorAttempts ?? [],
      startedAt: this.#clock(),
      finishedAt: null,
      settledAs: null,
      approval: null,
    };
    this.calls.push(call);

    if (outcome === 'hang') return new Promise<never>(() => undefined);
    if (script.approval !== undefined || script.writes !== undefined) {
      return this.#prepare(input, script, call, signal).then(
        (blocked) => blocked ?? this.#settle(input, script, outcome, call, signal),
      );
    }
    return this.#settle(input, script, outcome, call, signal);
  }

  /** Approval and file writes; returns a `blocked` result when approval is not granted. */
  async #prepare(
    input: AgentTaskInput,
    script: MockScript,
    call: MockCall,
    signal: AbortSignal,
  ): Promise<AgentResult | null> {
    if (script.approval !== undefined) {
      const decision =
        input.permissions === undefined
          ? 'unavailable'
          : await input.permissions.requestApproval(script.approval, signal);
      call.approval = decision;
      if (decision !== 'approved') {
        call.finishedAt = this.#clock();
        call.settledAs = 'resolved';
        return {
          ...this.#result(input, script, 'block', call),
          summary: `[mock] approval ${decision} for ${script.approval.action}: ${script.approval.detail}`,
        };
      }
    }
    const root = input.workspace?.root;
    if (script.writes !== undefined) {
      if (root === undefined) throw new Error(`mock agent for "${input.task.id}" has no workspace`);
      for (const [path, content] of Object.entries(script.writes)) {
        const target = resolve(root, path);
        if (isAbsolute(path) || !target.startsWith(root + sep)) {
          throw new Error(`mock agent refuses to write outside its workspace: ${path}`);
        }
        if (content === null) rmSync(target, { force: true });
        else {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
      }
    }
    return null;
  }

  #settle(
    input: AgentTaskInput,
    script: MockScript,
    outcome: Exclude<MockOutcome, 'hang'>,
    call: MockCall,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { task } = input;
    const settle = (as: NonNullable<MockCall['settledAs']>) => {
      call.finishedAt = this.#clock();
      call.settledAs = as;
    };
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        settle('aborted');
        reject(new MockAgentAbortError(task.id));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        if (outcome === 'provider-error') {
          settle('rejected');
          reject(
            new MockProviderError(
              script.error?.kind ?? 'unavailable',
              script.error?.provider ?? null,
              script.error?.retryAfterMs ?? null,
            ),
          );
          return;
        }
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
      findings: script.findings
        ? [...script.findings]
        : [{ kind: 'observation', message: '[mock] scripted result; no real work was performed.' }],
      patch: null,
      evidence: [],
      usage: {
        inputTokens: script.usage?.inputTokens ?? 0,
        outputTokens: script.usage?.outputTokens ?? 0,
        durationMs: (call.finishedAt ?? call.startedAt) - call.startedAt,
        costUsd: script.usage?.costUsd ?? null,
        model: input.assignment?.model ?? null,
      },
      ...(script.signals === undefined ? {} : { signals: script.signals }),
    };
  }
}
