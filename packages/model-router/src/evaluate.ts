import type { Capability } from '@soot/model-registry';
import { COMPLEXITY_LEVELS, type Complexity, type Task } from '@soot/task-graph';

/*
 * M3-01: task complexity and required-capability evaluation. HEURISTIC (ADR-023): the planner's
 * declared complexity is the starting point, and deterministic signals may raise it but never
 * lower it. Every rule that fires is recorded as a reason. A model-backed evaluator can
 * replace this later behind the same `TaskProfile` contract.
 */

/** How a task-level capability (open kebab-case vocabulary) maps onto model capabilities. */
export interface CapabilityRule {
  /** Model capabilities the task needs. Empty = covered by the base requirements. */
  readonly model: readonly Capability[];
  /** Work where a failure is costly; routed against the `high` reliability threshold. */
  readonly highRisk?: boolean;
  /** Work that is never trivial; raises complexity to at least `medium`. */
  readonly atLeastMedium?: boolean;
}

export const DEFAULT_CAPABILITY_RULES: Readonly<Record<string, CapabilityRule>> = {
  'code-edit': { model: [] },
  'code-read': { model: [] },
  css: { model: [] },
  react: { model: [] },
  testing: { model: [] },
  debugging: { model: [], atLeastMedium: true },
  'security-review': { model: ['reasoning'], highRisk: true, atLeastMedium: true },
  security: { model: ['reasoning'], highRisk: true, atLeastMedium: true },
  architecture: { model: ['reasoning'], highRisk: true, atLeastMedium: true },
  'data-migration': { model: [], highRisk: true, atLeastMedium: true },
  reasoning: { model: ['reasoning'] },
  vision: { model: ['vision'] },
  'ui-visual': { model: ['vision'] },
  'structured-output': { model: ['structuredOutput'] },
  streaming: { model: ['streaming'] },
};

export interface EvaluationOptions {
  /** Model capabilities every task needs (soot's API executor uses tools + structured results). */
  readonly baseCapabilities?: readonly Capability[];
  readonly rules?: Readonly<Record<string, CapabilityRule>>;
  /** Planned tokens (input + output) above which a task is at least `medium` / `high`. */
  readonly mediumTokenThreshold?: number;
  readonly highTokenThreshold?: number;
}

export const DEFAULT_BASE_CAPABILITIES: readonly Capability[] = ['tools', 'structuredOutput'];

export interface TaskProfile {
  readonly taskId: string;
  readonly declaredComplexity: Complexity;
  /** Complexity used for routing (≥ declared). */
  readonly complexity: Complexity;
  /** Tier whose reliability threshold applies: `high` for high-risk work, else `complexity`. */
  readonly reliabilityTier: Complexity;
  readonly highRisk: boolean;
  /** Mandatory model capabilities. */
  readonly requiredModelCapabilities: readonly Capability[];
  /** Planned tokens; the model's context window must hold them. */
  readonly minContextWindow: number;
  readonly plannedOutputTokens: number;
  /** Task capabilities with no rule: recorded, not silently dropped, and not guessed at. */
  readonly unmappedCapabilities: readonly string[];
  readonly reasons: readonly string[];
}

const rank = (c: Complexity) => COMPLEXITY_LEVELS.indexOf(c);
const maxOf = (a: Complexity, b: Complexity): Complexity => (rank(b) > rank(a) ? b : a);

export function evaluateTask(task: Task, options: EvaluationOptions = {}): TaskProfile {
  const rules = options.rules ?? DEFAULT_CAPABILITY_RULES;
  const base = options.baseCapabilities ?? DEFAULT_BASE_CAPABILITIES;
  const mediumTokens = options.mediumTokenThreshold ?? 50_000;
  const highTokens = options.highTokenThreshold ?? 150_000;
  const reasons: string[] = [`planner declared ${task.complexity} complexity`];
  const required = new Set<Capability>(base);
  if (base.length > 0) reasons.push(`base requirements: ${base.join(', ')}`);
  const unmapped: string[] = [];
  let complexity = task.complexity;
  let highRisk = false;

  for (const capability of task.requiredCapabilities) {
    const rule = rules[capability];
    if (rule === undefined) {
      unmapped.push(capability);
      continue;
    }
    for (const m of rule.model) {
      if (!required.has(m)) reasons.push(`"${capability}" requires model capability ${m}`);
      required.add(m);
    }
    if (rule.highRisk === true && !highRisk) {
      highRisk = true;
      reasons.push(`"${capability}" is high-risk work: the high reliability threshold applies`);
    }
    if (rule.atLeastMedium === true && rank(complexity) < rank('medium')) {
      complexity = 'medium';
      reasons.push(`"${capability}" raises complexity to medium`);
    }
  }
  if (unmapped.length > 0) {
    reasons.push(
      `no capability rule for ${unmapped.map((c) => `"${c}"`).join(', ')}; no extra filter applied`,
    );
  }

  const planned = task.estimate.inputTokens + task.estimate.outputTokens;
  if (planned > highTokens && rank(complexity) < rank('high')) {
    complexity = 'high';
    reasons.push(`${planned} planned tokens exceed ${highTokens}: complexity raised to high`);
  } else if (planned > mediumTokens && rank(complexity) < rank('medium')) {
    complexity = 'medium';
    reasons.push(`${planned} planned tokens exceed ${mediumTokens}: complexity raised to medium`);
  }
  reasons.push(`needs a context window of at least ${planned} tokens`);

  return {
    taskId: task.id,
    declaredComplexity: task.complexity,
    complexity,
    reliabilityTier: highRisk ? maxOf(complexity, 'high') : complexity,
    highRisk,
    requiredModelCapabilities: [...required],
    minContextWindow: planned,
    plannedOutputTokens: task.estimate.outputTokens,
    unmappedCapabilities: unmapped,
    reasons,
  };
}
