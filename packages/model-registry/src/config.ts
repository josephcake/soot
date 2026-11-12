import { readFileSync } from 'node:fs';
import { z } from 'zod';

/*
 * User-supplied registry configuration. soot ships NO built-in model list: every model comes
 * from this config (or is discovered from a provider and then has unknown metadata).
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
    /** Free-text caveats (time-of-day or long-context tiers are not modeled yet). */
    notes: z.string().max(1000).optional(),
  })
  .strict();

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
    /** Set false to keep a model listed but out of automatic selection. */
    selectable: z.boolean().default(true),
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
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type Pricing = z.infer<typeof PricingSchema>;
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
