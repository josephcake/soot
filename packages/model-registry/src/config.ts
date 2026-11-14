import { readFileSync } from 'node:fs';
import { z } from 'zod';

/*
 * User-supplied registry configuration. soot ships NO built-in model list: every model comes
 * from this config (or is discovered from a provider and then has unknown metadata). A model
 * the user leaves unpriced may get a sourced list price from soot's price catalog
 * (`price-catalog.ts`, ADR-037); that adds prices only, never models.
 * Credentials never appear here: a provider names the environment variable that holds its
 * key (`apiKeyEnv`), and objects are strict, so an inline `apiKey` field is rejected.
 */

export const CONFIG_VERSION = 1;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'must be a lowercase kebab-case id');

/**
 * `anthropic` / `openai`: native APIs via the Vercel AI SDK (ADR-017, ADR-019).
 * `openai-compatible`: any OpenAI-compatible endpoint (Ollama, LM Studio, an optional LiteLLM
 * proxy, ...). `listed-only`: metadata only; soot never calls it.
 */
export const PROVIDER_KINDS = ['anthropic', 'openai', 'openai-compatible', 'listed-only'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * How structured output is requested on the wire (ADR-036). `json_schema` is the default
 * (strict OpenAI-style structured outputs). `json_object` sends
 * `response_format: { "type": "json_object" }` and validates the JSON against the schema
 * after it comes back. Set this when an endpoint does not accept `json_schema`.
 */
export const STRUCTURED_OUTPUT_MODES = ['json_schema', 'json_object'] as const;
export type StructuredOutputMode = (typeof STRUCTURED_OUTPUT_MODES)[number];
export const StructuredOutputModeSchema = z.enum(STRUCTURED_OUTPUT_MODES);
export const DEFAULT_STRUCTURED_OUTPUT_MODE: StructuredOutputMode = 'json_schema';

export const ProviderConfigSchema = z
  .object({
    id: slug,
    kind: z.enum(PROVIDER_KINDS),
    /** Override the API base URL (required for `openai-compatible`). */
    baseURL: z.url({ protocol: /^https?$/ }).optional(),
    /** NAME of the environment variable holding the API key, e.g. `ANTHROPIC_API_KEY`. */
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/, 'must be an environment variable name, not a key')
      .optional(),
    /** True for endpoints on the user's machine (no data leaves it). */
    local: z.boolean().default(false),
    /** Default structured-output wire format for this provider's models, unless a model overrides it. */
    structuredOutputMode: StructuredOutputModeSchema.optional(),
  })
  .strict()
  .refine((p) => p.kind !== 'openai-compatible' || p.baseURL !== undefined, {
    message: 'openai-compatible providers need a baseURL',
    path: ['baseURL'],
  });

/** `true` / `false` when known; `null` when unknown. Unknown is never treated as `true`. */
const known = z.boolean().nullable().default(null);

export const CAPABILITIES = [
  'tools',
  'structuredOutput',
  'vision',
  'reasoning',
  'streaming',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CapabilitiesSchema = z
  .object({
    tools: known,
    structuredOutput: known,
    vision: known,
    reasoning: known,
    streaming: known,
  })
  .strict();

const tokens = z.int().positive().nullable().default(null);
const usdPerMTok = z.number().nonnegative();

/** Long-context tier of a price (see `PricingSchema.longContext`). */
export const LongContextPricingSchema = z
  .object({
    /** The tier applies when a request's input tokens are strictly greater than this. */
    aboveInputTokens: z.int().positive(),
    inputPerMTokUsd: usdPerMTok,
    outputPerMTokUsd: usdPerMTok,
    cacheReadPerMTokUsd: usdPerMTok.nullable().default(null),
    cacheWritePerMTokUsd: usdPerMTok.nullable().default(null),
  })
  .strict();

/**
 * List prices in USD per million tokens, with provenance. A price without `source` and
 * `asOf` is rejected. Cache prices are optional (`null` = unknown).
 */
export const PricingSchema = z
  .object({
    inputPerMTokUsd: usdPerMTok,
    outputPerMTokUsd: usdPerMTok,
    cacheReadPerMTokUsd: usdPerMTok.nullable().default(null),
    cacheWritePerMTokUsd: usdPerMTok.nullable().default(null),
    /** Where the price came from: a URL or a short description such as `user-config`. */
    source: z.string().min(1).max(500),
    /** Date the price was checked (YYYY-MM-DD). */
    asOf: z.iso.date(),
    /**
     * Higher rates for long prompts: when a request's input tokens (incl. cached) exceed
     * `aboveInputTokens`, every token in that request is billed at these rates (ADR-037).
     */
    longContext: LongContextPricingSchema.optional(),
    /** Free-text caveats (e.g. time-of-day discounts, which soot does not model). */
    notes: z.string().max(1000).optional(),
  })
  .strict();

const probability = z.number().min(0).max(1).nullable().default(null);

/**
 * User-declared prior probability that the model completes a task of each complexity
 * (0..1), with provenance. Routing (Milestone 3) blends it with measured history.
 * `null` = unknown; soot never invents a reliability for a model.
 */
export const ReliabilitySchema = z
  .object({
    low: probability,
    medium: probability,
    high: probability,
    /** Where the prior came from, e.g. `team benchmark 2026-11` or `user judgement`. */
    source: z.string().min(1).max(500).nullable().default(null),
  })
  .strict()
  .superRefine((r, ctx) => {
    const declared = r.low !== null || r.medium !== null || r.high !== null;
    if (declared && r.source === null)
      ctx.addIssue({
        code: 'custom',
        message: 'a reliability prior needs a source',
        path: ['source'],
      });
  });

/**
 * Model tiers (ADR-043), the same three levels as task complexity. A model's `tier` is the
 * hardest task complexity soot routes to it WHILE its reliability for that complexity is
 * unknown (no prior, too little history): a `low` model takes only low-complexity work, a
 * `high` model takes anything. Once reliability is known, the policy threshold decides
 * instead. `null` (the default) = no tier: unknown reliability is excluded as before.
 */
export const MODEL_TIERS = ['low', 'medium', 'high'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const ModelTierSchema = z.enum(MODEL_TIERS);

export const UNKNOWN_RELIABILITY = Object.freeze({
  low: null,
  medium: null,
  high: null,
  source: null,
});

export const ModelConfigSchema = z
  .object({
    provider: slug,
    /** The provider's own model identifier, passed through verbatim. */
    modelId: z.string().min(1).max(200),
    family: z.string().min(1).max(100).nullable().default(null),
    capabilities: CapabilitiesSchema.default({
      tools: null,
      structuredOutput: null,
      vision: null,
      reasoning: null,
      streaming: null,
    }),
    contextWindow: tokens,
    maxOutputTokens: tokens,
    /** `null` = price unknown. */
    pricing: PricingSchema.nullable().default(null),
    /** Prior success probability per complexity; `null` fields = unknown. */
    reliability: ReliabilitySchema.default(UNKNOWN_RELIABILITY),
    /** Set false to keep a model listed but out of automatic selection. */
    selectable: z.boolean().default(true),
    /** Hardest task complexity routed here while reliability is unknown (ADR-043). */
    tier: ModelTierSchema.nullable().default(null),
    /** Wire format for structured output; omitted = inherit from the provider, else `json_schema`. */
    structuredOutputMode: StructuredOutputModeSchema.optional(),
  })
  .strict();

export const RegistryConfigSchema = z
  .object({
    version: z.literal(CONFIG_VERSION),
    providers: z.array(ProviderConfigSchema),
    models: z.array(ModelConfigSchema),
  })
  .strict()
  .superRefine((config, ctx) => {
    const providerIds = new Set<string>();
    config.providers.forEach((p, i) => {
      if (providerIds.has(p.id))
        ctx.addIssue({
          code: 'custom',
          message: `duplicate provider "${p.id}"`,
          path: ['providers', i, 'id'],
        });
      providerIds.add(p.id);
    });
    const refs = new Set<string>();
    config.models.forEach((m, i) => {
      if (!providerIds.has(m.provider)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown provider "${m.provider}"`,
          path: ['models', i, 'provider'],
        });
      }
      const ref = `${m.provider}/${m.modelId}`;
      if (refs.has(ref))
        ctx.addIssue({
          code: 'custom',
          message: `duplicate model "${ref}"`,
          path: ['models', i, 'modelId'],
        });
      refs.add(ref);
    });
  });

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Effective structured-output mode: the model's setting, else the provider's, else `json_schema`.
 * No vendor-specific branches; the user names the mode in config.
 */
export function structuredOutputMode(
  provider: ProviderConfig,
  model: Pick<ModelConfig, 'structuredOutputMode'>,
): StructuredOutputMode {
  return (
    model.structuredOutputMode ?? provider.structuredOutputMode ?? DEFAULT_STRUCTURED_OUTPUT_MODE
  );
}
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
export type Reliability = z.infer<typeof ReliabilitySchema>;
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;
export type RegistryConfigInput = z.input<typeof RegistryConfigSchema>;

export class RegistryConfigError extends Error {
  readonly issues: readonly { readonly path: string; readonly message: string }[];
  constructor(
    source: string,
    issues: readonly { readonly path: string; readonly message: string }[],
  ) {
    super(
      `Invalid model registry config (${source}):\n${issues.map((i) => `  - ${i.path || '(root)'}: ${i.message}`).join('\n')}`,
    );
    this.name = 'RegistryConfigError';
    this.issues = issues;
  }
}

export function parseRegistryConfig(input: unknown, source = 'input'): RegistryConfig {
  const parsed = RegistryConfigSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new RegistryConfigError(
    source,
    parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  );
}

/** Read and validate a JSON registry config file. */
export function loadRegistryConfigFile(path: string): RegistryConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RegistryConfigError(path, [
      { path: '', message: `cannot read JSON: ${(error as Error).message}` },
    ]);
  }
  return parseRegistryConfig(raw, path);
}
