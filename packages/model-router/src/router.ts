import {
  estimateCost,
  type ExclusionReason,
  type ModelEntry,
  type ModelRegistry,
  type PriceBasis,
  type ProviderHealth,
} from '@soot/model-registry';
import {
  estimatedUsd,
  type EstimatedUsd,
  type RoutingCandidateLine,
  type RoutingLog,
  type RoutingLogEntry,
} from '@soot/observability';
import type { Complexity, Task } from '@soot/task-graph';
import { evaluateTask, type EvaluationOptions, type TaskProfile } from './evaluate.js';
import { estimateReliability, type ReliabilityEstimate, type SuccessHistory } from './history.js';
import { resolvePolicy, type BuiltInPolicyName, type RoutingPolicy } from './policy.js';

/*
 * The routing engine (M3-02 … M3-05, spec §5). Per task, never per prompt:
 *   evaluate → filter by mandatory capabilities, availability, and policy (M3-02) →
 *   estimate cost from registry pricing (M3-03) → estimate reliability from priors and
 *   history → pick the best candidate that meets the policy's threshold (M3-04) →
 *   record a readable explanation with every candidate (M3-05).
 */

export type RouterExclusion =
  | ExclusionReason
  | 'provider-excluded-by-policy'
  | 'max-output-too-small'
  | 'unpriced'
  | 'over-cost-cap'
  | 'unknown-reliability';

export interface CostEstimateForTask {
  /** Always an estimate from list prices and planned tokens; never an actual. */
  readonly kind: 'estimate';
  readonly costUsd: EstimatedUsd | null;
  readonly basis: PriceBasis | null;
}

export interface CandidateAssessment {
  readonly ref: string;
  readonly provider: string;
  readonly outcome: 'selected' | 'eligible' | 'below-threshold' | 'excluded';
  readonly exclusions: readonly RouterExclusion[];
  readonly estimate: CostEstimateForTask;
  /** Estimated cost per success (cost ÷ reliability); `null` if either is unknown. */
  readonly expectedCostUsd: EstimatedUsd | null;
  readonly reliability: ReliabilityEstimate;
  readonly meetsThreshold: boolean | null;
  readonly detail: string;
}

export interface RoutingDecision {
  readonly taskId: string;
  readonly policy: string;
  readonly status: 'routed' | 'unroutable';
  /** Selected model ref, or `null` when unroutable. */
  readonly selected: string | null;
  readonly profile: TaskProfile;
  readonly threshold: number;
  readonly estimate: CostEstimateForTask | null;
  /** Every model in the registry, selected first, then eligible by rank, then the rest. */
  readonly candidates: readonly CandidateAssessment[];
  /** One readable sentence. */
  readonly reason: string;
}

export interface RouteContext {
  readonly registry: ModelRegistry;
  readonly policy: BuiltInPolicyName | RoutingPolicy;
  readonly health?: ProviderHealth;
  readonly history?: SuccessHistory;
  readonly evaluation?: EvaluationOptions;
  readonly log?: RoutingLog;
  readonly runId?: string;
  readonly now?: () => Date;
}

const EXCLUSION_TEXT: Record<RouterExclusion, string> = {
  'not-selectable': 'not selectable (configured off or discovered only)',
  'listed-only': 'listed only, never called',
  'provider-unavailable': 'provider currently unavailable',
  'not-listed-by-provider': 'no longer listed by the provider',
  'missing-capability': 'missing a required capability',
  'unknown-capability': 'a required capability is unknown',
  'context-window-too-small': 'context window too small',
  'unknown-context-window': 'context window unknown',
  'provider-filtered': 'provider not allowed by policy',
  'not-local': 'not a local endpoint',
  'provider-excluded-by-policy': 'provider excluded by policy',
  'max-output-too-small': 'max output tokens below the planned output',
  unpriced: 'no configured price',
  'over-cost-cap': 'estimate above the policy cost cap',
  'unknown-reliability': 'reliability unknown (no prior, too little history)',
};

const fmtUsd = (v: number | null) => (v === null ? 'unknown cost' : `est. $${v.toFixed(6)}`);
const fmtP = (v: number | null) => (v === null ? 'unknown reliability' : `p≈${v.toFixed(2)}`);

interface Working {
  model: ModelEntry;
  exclusions: RouterExclusion[];
  estimate: CostEstimateForTask;
  expected: EstimatedUsd | null;
  reliability: ReliabilityEstimate;
  meets: boolean | null;
  missing: string[];
}

const nullsLast = (a: number | null, b: number | null) =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

function comparator(policy: RoutingPolicy): (a: Working, b: Working) => number {
  const cost = (w: Working) => w.estimate.costUsd;
  const p = (w: Working) => w.reliability.value;
  const byCost = (a: Working, b: Working) => nullsLast(cost(a), cost(b));
  const byReliabilityDesc = (a: Working, b: Working) =>
    nullsLast(p(a) === null ? null : -(p(a) ?? 0), p(b) === null ? null : -(p(b) ?? 0));
  switch (policy.objective) {
    case 'cheapest':
      return (a, b) => byCost(a, b) || byReliabilityDesc(a, b);
    case 'expected-cost':
      return (a, b) => nullsLast(a.expected, b.expected) || byCost(a, b) || byReliabilityDesc(a, b);
    case 'most-reliable':
      return (a, b) => byReliabilityDesc(a, b) || byCost(a, b);
  }
}

function describeTier(profile: TaskProfile): string {
  return profile.highRisk ? 'high-risk work' : `${profile.complexity}-complexity work`;
}

function objectiveText(policy: RoutingPolicy, w: Working): string {
  switch (policy.objective) {
    case 'cheapest':
      return `lowest estimated cost (${fmtUsd(w.estimate.costUsd)}, ${fmtP(w.reliability.value)})`;
    case 'expected-cost':
      return `lowest estimated cost per success (${fmtUsd(w.expected)} = ${fmtUsd(w.estimate.costUsd)} ÷ ${fmtP(w.reliability.value)})`;
    case 'most-reliable':
      return `highest estimated reliability (${fmtP(w.reliability.value)}, ${fmtUsd(w.estimate.costUsd)})`;
  }
}

/** Route one task. Pure apart from appending to `ctx.log`. */
export function routeTask(task: Task, ctx: RouteContext): RoutingDecision {
  const policy = resolvePolicy(ctx.policy);
  const profile = evaluateTask(task, ctx.evaluation);
  const tier: Complexity = profile.reliabilityTier;
  const threshold = policy.thresholds[tier];

  const selection = ctx.registry.select(
    {
      capabilities: profile.requiredModelCapabilities,
      minContextWindow: profile.minContextWindow,
      ...(policy.providers === null ? {} : { providers: policy.providers }),
      localOnly: policy.localOnly,
    },
    ctx.health,
  );
  const registryReasons = new Map(selection.excluded.map((e) => [e.ref, e.reasons]));

  const working: Working[] = ctx.registry.models().map((model) => {
    const exclusions: RouterExclusion[] = [...(registryReasons.get(model.ref) ?? [])];
    const missing = profile.requiredModelCapabilities.filter((c) => model.capabilities[c] !== true);
    if (policy.excludeProviders.includes(model.provider))
      exclusions.push('provider-excluded-by-policy');
    if (model.maxOutputTokens !== null && model.maxOutputTokens < profile.plannedOutputTokens) {
      exclusions.push('max-output-too-small');
    }
    const { costUsd, basis } = estimateCost(model, task.estimate);
    if (costUsd === null && !policy.allowUnpriced) exclusions.push('unpriced');
    if (
      costUsd !== null &&
      policy.maxEstimatedCostUsd !== null &&
      costUsd > policy.maxEstimatedCostUsd
    ) {
      exclusions.push('over-cost-cap');
    }
    const reliability = estimateReliability(
      model.reliability[tier],
      ctx.history?.stats(model.ref, tier) ?? { successes: 0, attempts: 0 },
      policy.priorWeight,
      policy.minHistorySamples,
    );
    if (reliability.value === null && !policy.allowUnknownReliability)
      exclusions.push('unknown-reliability');
    const meets = reliability.value === null ? null : reliability.value >= threshold;
    const expected =
      costUsd === null || reliability.value === null || reliability.value === 0
        ? null
        : estimatedUsd(costUsd / reliability.value);
    return {
      model,
      exclusions,
      estimate: { kind: 'estimate', costUsd, basis },
      expected,
      reliability,
      meets,
      missing,
    };
  });

  const order = comparator(policy);
  const open = working.filter((w) => w.exclusions.length === 0);
  const qualifying = open.filter((w) => w.meets !== false).sort(order);
  const below = open
    .filter((w) => w.meets === false)
    .sort(comparator({ ...policy, objective: 'most-reliable' }));

  let chosen: Working | undefined = qualifying[0];
  let fallback = false;
  if (chosen === undefined && policy.onNoQualifying === 'most-reliable') {
    chosen = below[0];
    fallback = chosen !== undefined;
  }

  const excludedCount = working.length - open.length;
  const label = `${policy.name.charAt(0).toUpperCase()}${policy.name.slice(1)}`;
  let reason: string;
  if (chosen === undefined) {
    reason = `${label}: no model meets the ${threshold.toFixed(2)} reliability threshold for ${describeTier(profile)} (${below.length} below threshold, ${excludedCount} excluded).`;
  } else if (fallback) {
    reason = `${label}: no model meets the ${threshold.toFixed(2)} threshold for ${describeTier(profile)}; policy allows the most reliable remaining model (${fmtP(chosen.reliability.value)}, ${fmtUsd(chosen.estimate.costUsd)}).`;
  } else {
    const unknownNote =
      chosen.reliability.value === null ? ' Reliability is unknown; allowed by policy.' : '';
    reason = `${label}: ${objectiveText(policy, chosen)} among ${qualifying.length} model(s) meeting the ${threshold.toFixed(2)} threshold for ${describeTier(profile)}; ${below.length} below threshold, ${excludedCount} excluded.${unknownNote}`;
  }

  const outcomeOf = (w: Working): CandidateAssessment['outcome'] =>
    w === chosen
      ? 'selected'
      : w.exclusions.length > 0
        ? 'excluded'
        : w.meets === false
          ? 'below-threshold'
          : 'eligible';
  const detailOf = (w: Working): string => {
    if (w.exclusions.length > 0) {
      return w.exclusions
        .map((e) =>
          (e === 'missing-capability' || e === 'unknown-capability') && w.missing.length > 0
            ? `${EXCLUSION_TEXT[e]} (${w.missing.join(', ')})`
            : EXCLUSION_TEXT[e],
        )
        .join('; ');
    }
    if (w.meets === false) return `below the ${threshold.toFixed(2)} threshold`;
    return `reliability from ${w.reliability.source}${w.reliability.samples > 0 ? ` (${w.reliability.samples} recorded attempts)` : ''}`;
  };
  const ordered = [
    ...(chosen === undefined ? [] : [chosen]),
    ...qualifying.filter((w) => w !== chosen),
    ...below.filter((w) => w !== chosen),
    ...working.filter((w) => w.exclusions.length > 0),
  ];
  const candidates: CandidateAssessment[] = ordered.map((w) => ({
    ref: w.model.ref,
    provider: w.model.provider,
    outcome: outcomeOf(w),
    exclusions: w.exclusions,
    estimate: w.estimate,
    expectedCostUsd: w.expected,
    reliability: w.reliability,
    meetsThreshold: w.meets,
    detail: detailOf(w),
  }));

  const decision: RoutingDecision = {
    taskId: task.id,
    policy: policy.name,
    status: chosen === undefined ? 'unroutable' : 'routed',
    selected: chosen?.model.ref ?? null,
    profile,
    threshold,
    estimate: chosen?.estimate ?? null,
    candidates,
    reason,
  };
  ctx.log?.append(toLogEntry(decision, ctx));
  return decision;
}

/** Route every task independently (selection is per task, never per prompt). */
export function routeTasks(tasks: readonly Task[], ctx: RouteContext): RoutingDecision[] {
  return tasks.map((task) => routeTask(task, ctx));
}

export function toLogEntry(
  decision: RoutingDecision,
  ctx: Pick<RouteContext, 'runId' | 'now'> = {},
): RoutingLogEntry {
  const lines: RoutingCandidateLine[] = decision.candidates.map((c) => ({
    ref: c.ref,
    outcome: c.outcome,
    estimatedCostUsd: c.estimate.costUsd,
    reliability: c.reliability.value,
    detail: c.detail,
  }));
  return {
    at: (ctx.now ?? (() => new Date()))().toISOString(),
    runId: ctx.runId ?? null,
    taskId: decision.taskId,
    policy: decision.policy,
    status: decision.status,
    selected: decision.selected,
    reason: decision.reason,
    candidates: lines,
  };
}
