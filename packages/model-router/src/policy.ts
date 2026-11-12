import { z } from 'zod';

/*
 * M3-06: routing policies. Economy, Balanced, and Quality are presets of one validated
 * structure; Custom is the same structure with user overrides on top of a preset. The numbers
 * are soot's defaults (ADR-023), not measurements, and users can change all of them.
 */

const probability = z.number().min(0).max(1);

export const ROUTING_OBJECTIVES = ['cheapest', 'expected-cost', 'most-reliable'] as const;
export type RoutingObjective = (typeof ROUTING_OBJECTIVES)[number];

export const RoutingPolicySchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    /** Minimum estimated success probability per reliability tier. */
    thresholds: z.object({ low: probability, medium: probability, high: probability }).strict(),
    /**
     * `cheapest`: lowest estimated cost. `expected-cost`: lowest cost ÷ success probability
     * (the cost of a success, counting retries). `most-reliable`: highest probability.
     */
    objective: z.enum(ROUTING_OBJECTIVES),
    /** Allow models without a configured price (they rank after priced ones). */
    allowUnpriced: z.boolean(),
    /** Allow models whose reliability is unknown (treated as qualifying, ranked last). */
    allowUnknownReliability: z.boolean(),
    /** When nothing meets the threshold: fail, or take the most reliable remaining model. */
    onNoQualifying: z.enum(['fail', 'most-reliable']),
    /** Restrict to these providers (`null` = all callable providers). */
    providers: z.array(z.string()).nullable(),
    excludeProviders: z.array(z.string()),
    localOnly: z.boolean(),
    /** Upper bound on a task's estimated cost in USD (`null` = no cap). */
    maxEstimatedCostUsd: z.number().nonnegative().nullable(),
    /** Weight of the configured prior, in pseudo-observations, when blending with history. */
    priorWeight: z.number().positive(),
    /** History-only estimates (no prior) need at least this many recorded attempts. */
    minHistorySamples: z.int().positive(),
  })
  .strict();

export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

const common = {
  allowUnknownReliability: false,
  onNoQualifying: 'fail',
  providers: null,
  excludeProviders: [],
  localOnly: false,
  maxEstimatedCostUsd: null,
  priorWeight: 5,
  minHistorySamples: 3,
} as const;

export const ECONOMY: RoutingPolicy = RoutingPolicySchema.parse({
  ...common,
  name: 'economy',
  thresholds: { low: 0.6, medium: 0.7, high: 0.8 },
  objective: 'cheapest',
  allowUnpriced: false,
});

export const BALANCED: RoutingPolicy = RoutingPolicySchema.parse({
  ...common,
  name: 'balanced',
  thresholds: { low: 0.75, medium: 0.85, high: 0.9 },
  objective: 'expected-cost',
  allowUnpriced: false,
});

export const QUALITY: RoutingPolicy = RoutingPolicySchema.parse({
  ...common,
  name: 'quality',
  thresholds: { low: 0.85, medium: 0.9, high: 0.95 },
  objective: 'most-reliable',
  allowUnpriced: true,
});

export const BUILT_IN_POLICIES = {
  economy: ECONOMY,
  balanced: BALANCED,
  quality: QUALITY,
} as const;
export type BuiltInPolicyName = keyof typeof BUILT_IN_POLICIES;

export type CustomPolicyInput = Partial<Omit<RoutingPolicy, 'thresholds' | 'name'>> & {
  readonly name?: string;
  readonly extends?: BuiltInPolicyName;
  readonly thresholds?: Partial<RoutingPolicy['thresholds']>;
};

/** Custom policy: a preset (default Balanced) with validated user overrides. */
export function customPolicy(input: CustomPolicyInput): RoutingPolicy {
  const { extends: base = 'balanced', thresholds, ...rest } = input;
  const preset = BUILT_IN_POLICIES[base];
  return RoutingPolicySchema.parse({
    ...preset,
    ...rest,
    name: input.name ?? 'custom',
    thresholds: { ...preset.thresholds, ...thresholds },
  });
}

export function resolvePolicy(policy: BuiltInPolicyName | RoutingPolicy): RoutingPolicy {
  return typeof policy === 'string' ? BUILT_IN_POLICIES[policy] : RoutingPolicySchema.parse(policy);
}
