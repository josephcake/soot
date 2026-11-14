import type {
  Assignment,
  AttemptRecord,
  AttemptSupervisor,
  PlanContext,
  PlanDecision,
  ReviewContext,
  ReviewDecision,
} from '@soot/agent-runtime';
import type { ModelRegistry, ProviderHealth } from '@soot/model-registry';
import {
  routeTask,
  type BuiltInPolicyName,
  type CandidateAssessment,
  type RoutingDecision,
  type RoutingPolicy,
  type SuccessHistory,
} from '@soot/model-router';
import type { RoutingLog } from '@soot/observability';
import { COMPLEXITY_LEVELS, type Complexity, type Task } from '@soot/task-graph';
import { escalationConfig, type EscalationConfig, type EscalationConfigInput } from './config.js';
import { escalationLevel, nextStep, type NextStep, type Trigger } from './decide.js';

/*
 * AdaptiveSupervisor (M4-01 … M4-05): the decision side of adaptive execution, plugged into
 * the agent-runtime Scheduler. It routes each attempt through @soot/model-router, escalates
 * to a stronger model on triggers, falls back across providers on outages and persistent
 * rate limits, downgrades dependents after a plan or investigation, and enforces attempt,
 * escalation, and budget limits. Every decision is recorded as an `AdaptiveEvent`.
 */

export type AdaptiveEventType =
  | 'assign'
  | 'downgrade'
  | 'downgrade-skipped'
  | 'retry'
  | 'fallback'
  | 'escalate'
  | 'accept'
  | 'fail'
  | 'stop';

export interface AdaptiveEvent {
  readonly taskId: string;
  readonly attempt: number;
  readonly type: AdaptiveEventType;
  /** Model assigned (for assign/retry/fallback/escalate/downgrade), else the model reviewed. */
  readonly model: string | null;
  readonly reason: string;
  readonly triggers: readonly Trigger[];
}

export interface AdaptiveSupervisorOptions {
  readonly registry: ModelRegistry;
  readonly policy: BuiltInPolicyName | RoutingPolicy;
  readonly health?: ProviderHealth;
  readonly history?: SuccessHistory;
  readonly config?: EscalationConfigInput;
  /** Records the initial routing decision of every task. */
  readonly routingLog?: RoutingLog;
  readonly runId?: string;
  readonly onEvent?: (event: AdaptiveEvent) => void;
  /**
   * Persisted per-attempt spend for this run (e.g. `ExecutionStore.spendLedger(runId)`). Spend
   * is loaded from it on construction, so a restarted run's budget includes every attempt of
   * the run, also finished tasks that are not planned again; each new estimate or reported
   * actual is saved to it (ADR-030).
   */
  readonly spend?: SpendLedger;
  /**
   * USD already spent on this run before any task: the priced planning (decomposition) call
   * (issue #5, ADR-045). Counted in `runSpent()` and so against the run budget. Unknown
   * (unpriced) planning is left out by the caller, never guessed.
   */
  readonly planningSpendUsd?: number;
}

/** Spend attributed to one attempt: a reported actual, or the routed estimate. Never invented. */
export interface AttemptSpendEntry {
  readonly taskId: string;
  readonly attempt: number;
  readonly usd: number;
  readonly source: 'actual' | 'estimate';
}

export interface SpendLedger {
  attemptSpend(): readonly AttemptSpendEntry[];
  saveAttemptSpend(spend: AttemptSpendEntry): void;
}

const rank = (c: Complexity) => COMPLEXITY_LEVELS.indexOf(c);
const shift = (c: Complexity, by: number): Complexity =>
  COMPLEXITY_LEVELS[Math.min(COMPLEXITY_LEVELS.length - 1, Math.max(0, rank(c) + by))] ?? c;
const providerOf = (ref: string) => ref.split('/')[0] ?? ref;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number | null) => (x === null ? 'unknown' : `$${x.toFixed(6)}`);

/** Spend attributed to an attempt: reported actual if any, else its routed estimate. */
function spendOf(r: AttemptRecord): Omit<AttemptSpendEntry, 'taskId' | 'attempt'> | null {
  const actual = r.result?.usage.costUsd ?? null;
  if (actual !== null) return { usd: actual, source: 'actual' };
  const estimate = r.assignment?.estimatedCostUsd ?? null;
  return estimate === null ? null : { usd: estimate, source: 'estimate' };
}

export class AdaptiveSupervisor implements AttemptSupervisor {
  readonly config: EscalationConfig;
  readonly events: AdaptiveEvent[] = [];
  readonly #options: AdaptiveSupervisorOptions;
  /** Spend per task and attempt, for the task and run budgets. */
  readonly #spent = new Map<string, Map<number, number>>();

  constructor(options: AdaptiveSupervisorOptions) {
    this.#options = options;
    this.config = escalationConfig(options.config);
    for (const s of options.spend?.attemptSpend() ?? []) this.#setSpend(s.taskId, s.attempt, s.usd);
  }

  #setSpend(taskId: string, attempt: number, usd: number): void {
    const byAttempt = this.#spent.get(taskId) ?? new Map<number, number>();
    byAttempt.set(attempt, usd);
    this.#spent.set(taskId, byAttempt);
  }

  /** Record an attempt's spend (in memory and in the ledger, if any). */
  #recordSpend(taskId: string, attempt: number, spend: ReturnType<typeof spendOf>): void {
    if (spend === null) return;
    this.#setSpend(taskId, attempt, spend.usd);
    this.#options.spend?.saveAttemptSpend({ taskId, attempt, ...spend });
  }

  #taskSpent(taskId: string): number {
    return [...(this.#spent.get(taskId)?.values() ?? [])].reduce((a, b) => a + b, 0);
  }

  /**
   * Total spend of the run so far: planning (when priced) plus each attempt's actual where
   * reported, else its routed estimate.
   */
  runSpent(): number {
    return [...this.#spent.keys()].reduce(
      (n, id) => n + this.#taskSpent(id),
      this.#options.planningSpendUsd ?? 0,
    );
  }

  #emit(event: AdaptiveEvent): void {
    this.events.push(event);
    this.#options.onEvent?.(event);
  }

  #route(task: Task, complexity: Complexity, log = false): RoutingDecision {
    const o = this.#options;
    return routeTask(
      { ...task, complexity },
      {
        registry: o.registry,
        policy: o.policy,
        ...(o.health === undefined ? {} : { health: o.health }),
        ...(o.history === undefined ? {} : { history: o.history }),
        ...(log && o.routingLog !== undefined ? { log: o.routingLog } : {}),
        ...(o.runId === undefined ? {} : { runId: o.runId }),
      },
    );
  }

  /** Candidates the router found usable, in its preference order. */
  static #usable(decision: RoutingDecision, allowBelowThreshold: boolean): CandidateAssessment[] {
    const usable = decision.candidates.filter(
      (c) => c.outcome === 'selected' || c.outcome === 'eligible',
    );
    if (!allowBelowThreshold) return usable;
    const below = decision.candidates
      .filter((c) => c.outcome === 'below-threshold')
      .sort((a, b) => (b.reliability.value ?? 0) - (a.reliability.value ?? 0));
    return [...usable, ...below];
  }

  plan(ctx: PlanContext): PlanDecision {
    const { task, attempt, history } = ctx;
    for (const r of history) {
      const spend = spendOf(r);
      if (spend !== null) this.#setSpend(task.id, r.attempt, spend.usd);
    }
    const last = history.at(-1);
    let decision: PlanDecision;
    if (last === undefined) {
      decision = this.#initial(ctx);
    } else {
      const step = nextStep(task, last, history.slice(0, -1), this.config);
      decision = this.#follow(task, attempt, last, history, step);
    }
    if (decision.action === 'run') decision = this.#checkBudget(task, decision.assignment);
    if (decision.action === 'run') {
      // Reserve the in-flight attempt's estimate so concurrent tasks (and a restarted run, via the
      // ledger) see it against the run budget until the attempt's actual replaces it.
      const reserved = decision.assignment.estimatedCostUsd;
      if (reserved !== null)
        this.#recordSpend(task.id, attempt, { usd: reserved, source: 'estimate' });
    }
    if (decision.action === 'stop') {
      this.#emit({
        taskId: task.id,
        attempt,
        type: 'stop',
        model: null,
        reason: decision.reason,
        triggers: [],
      });
    }
    return decision;
  }

  #checkBudget(task: Task, assignment: Assignment): PlanDecision {
    const { taskBudgetUsd, runBudgetUsd } = this.config;
    if (taskBudgetUsd === null && runBudgetUsd === null) return { action: 'run', assignment };
    const next = assignment.estimatedCostUsd;
    if (next === null) {
      return {
        action: 'stop',
        reason: `budget cannot be checked: ${assignment.model ?? 'the model'} has no price`,
      };
    }
    const taskSpent = this.#taskSpent(task.id);
    if (taskBudgetUsd !== null && taskSpent + next > taskBudgetUsd) {
      return {
        action: 'stop',
        reason: `task budget exhausted: spent ${usd(taskSpent)} + next attempt ${usd(next)} > ${usd(taskBudgetUsd)}`,
      };
    }
    const runSpent = this.runSpent();
    if (runBudgetUsd !== null && runSpent + next > runBudgetUsd) {
      const planning = this.#options.planningSpendUsd ?? 0;
      return {
        action: 'stop',
        reason: `run budget exhausted: spent ${usd(runSpent)}${planning > 0 ? ` (planning ${usd(planning)})` : ''} + next attempt ${usd(next)} > ${usd(runBudgetUsd)}`,
      };
    }
    return { action: 'run', assignment };
  }

  #run(
    task: Task,
    attempt: number,
    type: AdaptiveEventType,
    c: CandidateAssessment,
    level: number,
    tier: Complexity,
    reason: string,
    triggers: readonly Trigger[] = [],
  ): PlanDecision {
    const assignment: Assignment = {
      model: c.ref,
      reason,
      escalationLevel: level,
      estimatedCostUsd: c.estimate.costUsd,
      tier,
    };
    this.#emit({ taskId: task.id, attempt, type, model: c.ref, reason, triggers });
    return { action: 'run', assignment };
  }

  /** First attempt: route the task; downgrade it if a prerequisite produced a plan. */
  #initial(ctx: PlanContext): PlanDecision {
    const { task, attempt, dependencyResults } = ctx;
    const base = this.#route(task, task.complexity, true);
    const baseChoice = base.candidates.find((c) => c.outcome === 'selected');
    if (baseChoice === undefined) return { action: 'stop', reason: `unroutable: ${base.reason}` };

    const planners = dependencyResults
      .filter((r) => r.signals?.planReady === true)
      .map((r) => r.taskId);
    const { downgrade } = this.config;
    if (!downgrade.enabled || planners.length === 0) {
      return this.#run(
        task,
        attempt,
        'assign',
        baseChoice,
        0,
        base.profile.complexity,
        base.reason,
      );
    }
    const from = `prerequisite ${planners.join(', ')} produced a plan`;
    const keep = (why: string) => {
      this.#emit({
        taskId: task.id,
        attempt,
        type: 'downgrade-skipped',
        model: baseChoice.ref,
        reason: `${from}; ${why}`,
        triggers: [],
      });
      return this.#run(
        task,
        attempt,
        'assign',
        baseChoice,
        0,
        base.profile.complexity,
        `${base.reason} (no downgrade: ${why})`,
      );
    };
    if (base.profile.highRisk) return keep('high-risk work is never downgraded');
    if (base.profile.complexity === 'low') return keep('already at the lowest tier');
    const lowered = this.#route(task, shift(base.profile.complexity, -1));
    const low = lowered.candidates.find((c) => c.outcome === 'selected');
    if (low === undefined || low.ref === baseChoice.ref)
      return keep('no cheaper model qualifies at the lower tier');
    const baseCost = baseChoice.estimate.costUsd;
    const lowCost = low.estimate.costUsd;
    if (baseCost === null || lowCost === null || baseCost === 0)
      return keep('savings cannot be estimated');
    const savings = 1 - lowCost / baseCost;
    if (savings < downgrade.minSavingsRatio) {
      return keep(
        `switching would save only ${pct(savings)} (< ${pct(downgrade.minSavingsRatio)}), not worth a model switch`,
      );
    }
    return this.#run(
      task,
      attempt,
      'downgrade',
      low,
      0,
      lowered.profile.complexity,
      `downgraded: ${from}; routed as ${lowered.profile.complexity} instead of ${base.profile.complexity}, est. ${usd(baseCost)} → ${usd(lowCost)} (saves ${pct(savings)})`,
    );
  }

  /** Later attempts: apply the step decided when the previous attempt was reviewed. */
  #follow(
    task: Task,
    attempt: number,
    last: AttemptRecord,
    history: readonly AttemptRecord[],
    step: NextStep,
  ): PlanDecision {
    const level = escalationLevel(last);
    const tier = shift(task.complexity, level);
    const health = this.#options.health;
    // Providers that failed at provider level in this task's history are avoided (restart-safe).
    const failedProviders = new Set(
      history
        .filter((r) => r.failure !== null && ['unavailable', 'auth'].includes(r.failure.kind))
        .flatMap((r) => [
          r.failure?.provider ??
            (r.assignment?.model == null ? null : providerOf(r.assignment.model)),
        ])
        .filter((p): p is string => p !== null),
    );
    switch (step.type) {
      case 'accept':
      case 'fail':
        return { action: 'stop', reason: step.type === 'fail' ? step.reason : 'already accepted' };
      case 'retry-same': {
        const model = last.assignment?.model ?? null;
        if (model !== null && health !== undefined && !health.isAvailable(providerOf(model))) {
          return this.#follow(task, attempt, last, history, {
            type: 'fallback',
            provider: providerOf(model),
            note: `${providerOf(model)} became unavailable`,
          });
        }
        const decision = this.#route(task, tier);
        const c = decision.candidates.find((x) => x.ref === model);
        if (c === undefined)
          return { action: 'stop', reason: 'previous model is no longer in the registry' };
        return this.#run(task, attempt, 'retry', c, level, decision.profile.complexity, step.note);
      }
      case 'fallback': {
        if (step.provider !== null) failedProviders.add(step.provider);
        const decision = this.#route(task, tier);
        const c = AdaptiveSupervisor.#usable(decision, false).find(
          (x) => !failedProviders.has(x.provider),
        );
        if (c === undefined) {
          return {
            action: 'stop',
            reason: `no fallback model available outside ${[...failedProviders].join(', ')}`,
          };
        }
        return this.#run(
          task,
          attempt,
          'fallback',
          c,
          level,
          decision.profile.complexity,
          `${step.note}: ${c.ref}`,
        );
      }
      case 'escalate': {
        const newLevel = level + 1;
        const decision = this.#route(task, shift(task.complexity, newLevel));
        const tried = new Set(
          history.map((r) => r.assignment?.model).filter((m): m is string => m != null),
        );
        const prev = last.assignment?.model ?? null;
        const prevReliability =
          decision.candidates.find((x) => x.ref === prev)?.reliability.value ?? null;
        const c = AdaptiveSupervisor.#usable(decision, true).find(
          (x) =>
            !tried.has(x.ref) &&
            !failedProviders.has(x.provider) &&
            (prevReliability === null || (x.reliability.value ?? -1) > prevReliability),
        );
        if (c === undefined)
          return { action: 'stop', reason: `no stronger model available (${step.note})` };
        const note = `${step.note} → ${c.ref} (${decision.profile.complexity} tier, p≈${(c.reliability.value ?? 0).toFixed(2)}${prevReliability === null ? '' : ` vs ${prevReliability.toFixed(2)}`})`;
        return this.#run(
          task,
          attempt,
          'escalate',
          c,
          newLevel,
          decision.profile.complexity,
          note,
          step.triggers,
        );
      }
    }
  }

  review(ctx: ReviewContext): ReviewDecision {
    const { task, record, history } = ctx;
    for (const r of history) {
      const spend = spendOf(r);
      if (spend !== null) this.#setSpend(task.id, r.attempt, spend.usd);
    }
    this.#recordSpend(task.id, record.attempt, spendOf(record));
    const step = nextStep(task, record, history, this.config);
    const model = record.assignment?.model ?? null;
    const health = this.#options.health;
    const failure = record.failure;
    if (health !== undefined && failure !== null && model !== null) {
      const provider = failure.provider ?? providerOf(model);
      if (failure.kind === 'unavailable')
        health.markUnavailable(provider, 'outage', { detail: failure.message });
      if (failure.kind === 'auth')
        health.markUnavailable(provider, 'auth', { detail: failure.message });
      if (failure.kind === 'rate-limited' && step.type === 'fallback') {
        health.markUnavailable(provider, 'rate-limited', {
          detail: failure.message,
          ...(failure.retryAfterMs === null ? {} : { cooldownMs: failure.retryAfterMs }),
        });
      }
    }
    switch (step.type) {
      case 'accept':
        this.#emit({
          taskId: task.id,
          attempt: record.attempt,
          type: 'accept',
          model,
          reason: 'result accepted',
          triggers: [],
        });
        return { action: 'accept' };
      case 'fail':
        this.#emit({
          taskId: task.id,
          attempt: record.attempt,
          type: 'fail',
          model,
          reason: step.reason,
          triggers: [],
        });
        return { action: 'fail', reason: step.reason };
      case 'retry-same':
        return { action: 'retry', delayMs: step.delayMs, note: step.note };
      case 'fallback':
      case 'escalate':
        return { action: 'retry', delayMs: 0, note: step.note };
    }
  }
}
