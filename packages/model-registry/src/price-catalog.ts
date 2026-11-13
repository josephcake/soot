import { PricingSchema, type Pricing, type ProviderConfig, type RegistryConfig } from './config.js';
import { modelRef } from './registry.js';

/*
 * soot's price catalog (ADR-037): official list prices for popular hosted models, each with the
 * official pricing page it came from and the date it was checked. It adds PRICES ONLY: it never
 * adds a model, picks a default, or overrides a price the user configured. A configured model
 * with no `pricing` gets the catalog price when its provider's API host and its model id both
 * match an entry. Anything else stays unpriced ("price not set").
 *
 * Maintained by the update-model-pricing prompt (skills/update-model-pricing/SKILL.md). Never
 * add a number that is not on the vendor's own pricing page.
 */

/** One catalog row. `pricing.source` is the official pricing page URL; `pricing.asOf` the check date. */
export interface CatalogEntry {
  /** API hostnames this price applies to (the vendor's own API, not resellers). */
  readonly hosts: readonly string[];
  /** The vendor's model id, exactly as sent on the wire. */
  readonly modelId: string;
  readonly pricing: Pricing;
  /** First day (YYYY-MM-DD, inclusive) the price applies; omitted = already in effect. */
  readonly effectiveFrom?: string;
  /** Last day (YYYY-MM-DD, inclusive) the price applies; omitted = no announced end. */
  readonly effectiveUntil?: string;
}

const CHECKED = '2026-11-13';

const OPENAI = { hosts: ['api.openai.com'], source: 'https://platform.openai.com/docs/pricing' };
const ANTHROPIC = {
  hosts: ['api.anthropic.com'],
  source: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
};
const GOOGLE = {
  hosts: ['generativelanguage.googleapis.com'],
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
};
const XAI = { hosts: ['api.x.ai'], source: 'https://docs.x.ai/docs/models' };
const DEEPSEEK = {
  hosts: ['api.deepseek.com'],
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
};
const MISTRAL = { hosts: ['api.mistral.ai'], source: 'https://docs.mistral.ai/inference/pricing' };

interface Rates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

function entry(
  vendor: { readonly hosts: readonly string[]; readonly source: string },
  modelId: string,
  rates: Rates,
  extra: {
    readonly longContext?: Rates & { readonly above: number };
    readonly notes?: string;
    readonly effectiveFrom?: string;
    readonly effectiveUntil?: string;
  } = {},
): CatalogEntry {
  const lc = extra.longContext;
  const pricing = PricingSchema.parse({
    inputPerMTokUsd: rates.input,
    outputPerMTokUsd: rates.output,
    cacheReadPerMTokUsd: rates.cacheRead ?? null,
    cacheWritePerMTokUsd: rates.cacheWrite ?? null,
    source: vendor.source,
    asOf: CHECKED,
    ...(lc === undefined
      ? {}
      : {
          longContext: {
            aboveInputTokens: lc.above,
            inputPerMTokUsd: lc.input,
            outputPerMTokUsd: lc.output,
            cacheReadPerMTokUsd: lc.cacheRead ?? null,
            cacheWritePerMTokUsd: lc.cacheWrite ?? null,
          },
        }),
    notes: `soot price catalog (standard tier)${extra.notes === undefined ? '' : `. ${extra.notes}`}`,
  });
  return Object.freeze({
    hosts: vendor.hosts,
    modelId,
    pricing,
    ...(extra.effectiveFrom === undefined ? {} : { effectiveFrom: extra.effectiveFrom }),
    ...(extra.effectiveUntil === undefined ? {} : { effectiveUntil: extra.effectiveUntil }),
  });
}

const OPENAI_LONG =
  'Long context is more than 272K input tokens; cacheWrite is the 30-minute write.';
const XAI_LONG =
  'Prompts of 200k tokens or more bill every token at the long-context rate (modeled as > 199,999).';
const ANTHROPIC_CACHE = 'cacheWrite is the 5-minute write; 1-hour writes cost 2x base input.';
const DEEPSEEK_PEAK =
  'Peak rates (01:00-04:00 and 06:00-10:00 UTC on weekdays); off-peak is half. soot does not model time of day, so costs are an upper bound.';

/** The shipped catalog. Order does not matter; ids and date ranges never overlap (tested). */
export const PRICE_CATALOG: readonly CatalogEntry[] = Object.freeze([
  // OpenAI (standard processing).
  entry(
    OPENAI,
    'gpt-6-astra',
    { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    {
      longContext: { above: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
      notes: OPENAI_LONG,
    },
  ),
  entry(
    OPENAI,
    'gpt-6.1-sol',
    { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    {
      longContext: { above: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
      notes: OPENAI_LONG,
    },
  ),
  entry(
    OPENAI,
    'gpt-6.1-terra',
    { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
    {
      longContext: { above: 272_000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 },
      notes: OPENAI_LONG,
    },
  ),
  entry(
    OPENAI,
    'gpt-6-luna',
    { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    {
      longContext: { above: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
      notes: OPENAI_LONG,
    },
  ),
  entry(OPENAI, 'gpt-5.4-mini', { input: 0.75, output: 4.5, cacheRead: 0.075 }),
  entry(OPENAI, 'gpt-5.4-nano', { input: 0.2, output: 1.25, cacheRead: 0.02 }),

  // Anthropic (Claude API, global inference).
  entry(
    ANTHROPIC,
    'claude-fable-5-2',
    { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
    { notes: ANTHROPIC_CACHE },
  ),
  entry(
    ANTHROPIC,
    'claude-opus-5-5',
    { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    { notes: ANTHROPIC_CACHE },
  ),
  entry(
    ANTHROPIC,
    'claude-sonnet-5-5',
    { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    { notes: ANTHROPIC_CACHE },
  ),
  entry(
    ANTHROPIC,
    'claude-haiku-5-5',
    { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    {
      longContext: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
      notes: `Prompts over 100,000 tokens use the higher rates. ${ANTHROPIC_CACHE}`,
    },
  ),

  // Google Gemini API (paid tier, standard). Some prices are announced to change on a date.
  entry(
    GOOGLE,
    'gemini-4-carbon',
    { input: 2, output: 10, cacheRead: 0.1 },
    { effectiveUntil: '2026-11-30', notes: 'Output includes thinking tokens.' },
  ),
  entry(
    GOOGLE,
    'gemini-4-carbon',
    { input: 4, output: 20, cacheRead: 0.2 },
    { effectiveFrom: '2026-12-01', notes: 'Output includes thinking tokens.' },
  ),
  entry(
    GOOGLE,
    'gemini-4-argon',
    { input: 2, output: 10, cacheRead: 0.1 },
    { effectiveUntil: '2026-11-30', notes: 'Output includes thinking tokens.' },
  ),
  entry(
    GOOGLE,
    'gemini-4-argon',
    { input: 4, output: 20, cacheRead: 0.2 },
    { effectiveFrom: '2026-12-01', notes: 'Output includes thinking tokens.' },
  ),
  entry(
    GOOGLE,
    'gemini-4-hydrogen',
    { input: 1.5, output: 7.5, cacheRead: 0.075 },
    { notes: 'Output includes thinking tokens.' },
  ),
  entry(
    GOOGLE,
    'gemini-3.8-flash',
    { input: 0.75, output: 3.75, cacheRead: 0.075 },
    { effectiveUntil: '2026-12-31', notes: 'Output includes thinking tokens.' },
  ),
  entry(
    GOOGLE,
    'gemini-3.8-flash',
    { input: 1.5, output: 7.5, cacheRead: 0.15 },
    { effectiveFrom: '2027-01-01', notes: 'Output includes thinking tokens.' },
  ),
  entry(
    GOOGLE,
    'gemini-3.5-flash-lite',
    { input: 0.3, output: 2.5, cacheRead: 0.03 },
    { notes: 'Output includes thinking tokens. Cache storage is billed separately.' },
  ),

  // xAI.
  entry(
    XAI,
    'grok-4.7',
    { input: 2, output: 6, cacheRead: 0.5 },
    { longContext: { above: 199_999, input: 4, output: 12, cacheRead: 1 }, notes: XAI_LONG },
  ),
  entry(
    XAI,
    'grok-4.3',
    { input: 1.25, output: 2.5, cacheRead: 0.2 },
    { longContext: { above: 199_999, input: 2.5, output: 5, cacheRead: 0.4 }, notes: XAI_LONG },
  ),
  entry(
    XAI,
    'grok-build-0.1',
    { input: 1, output: 2, cacheRead: 0.2 },
    { longContext: { above: 199_999, input: 2, output: 4, cacheRead: 0.4 }, notes: XAI_LONG },
  ),

  // DeepSeek (peak rates).
  entry(
    DEEPSEEK,
    'deepseek-flash',
    { input: 0.3, output: 1.2, cacheRead: 0.006 },
    { notes: DEEPSEEK_PEAK },
  ),
  entry(
    DEEPSEEK,
    'deepseek-v4-pro',
    { input: 1.32, output: 3.96, cacheRead: 0.044 },
    { notes: DEEPSEEK_PEAK },
  ),

  // Mistral.
  entry(MISTRAL, 'mistral-large-4', { input: 0.7, output: 2.1, cacheRead: 0.07 }),
  entry(MISTRAL, 'mistral-small-2603', { input: 0.15, output: 0.6 }),
  entry(MISTRAL, 'codestral-2508', { input: 0.3, output: 0.9 }),
]);

/** Default API host per provider kind, when no `baseURL` overrides it (the SDK defaults). */
const DEFAULT_HOST: Partial<Record<ProviderConfig['kind'], string>> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
};

/** The API hostname a provider sends requests to, or `null` (listed-only, or unknown). */
export function providerHost(provider: ProviderConfig): string | null {
  if (provider.kind === 'listed-only') return null;
  if (provider.baseURL !== undefined) return new URL(provider.baseURL).hostname.toLowerCase();
  return DEFAULT_HOST[provider.kind] ?? null;
}

const inEffect = (e: CatalogEntry, day: string): boolean =>
  (e.effectiveFrom === undefined || e.effectiveFrom <= day) &&
  (e.effectiveUntil === undefined || day <= e.effectiveUntil);

/** The catalog price for this host and model id on `day` (YYYY-MM-DD), or `null`. */
export function catalogPrice(
  host: string,
  modelId: string,
  day: string,
  catalog: readonly CatalogEntry[] = PRICE_CATALOG,
): Pricing | null {
  const hit = catalog.find(
    (e) => e.modelId === modelId && e.hosts.includes(host) && inEffect(e, day),
  );
  return hit?.pricing ?? null;
}

export interface PricedConfig {
  readonly config: RegistryConfig;
  /** Refs (`provider/modelId`) whose price came from the catalog. */
  readonly catalogPriced: readonly string[];
}

/**
 * Fill in catalog prices for configured models that have none. A user-configured price always
 * wins; models the catalog does not cover stay unpriced. No network calls.
 */
export function applyPriceCatalog(
  config: RegistryConfig,
  options: { readonly today?: string; readonly catalog?: readonly CatalogEntry[] } = {},
): PricedConfig {
  const day = options.today ?? new Date().toISOString().slice(0, 10);
  const hosts = new Map(config.providers.map((p) => [p.id, providerHost(p)]));
  const catalogPriced: string[] = [];
  const models = config.models.map((m) => {
    if (m.pricing !== null) return m;
    const host = hosts.get(m.provider) ?? null;
    const pricing = host === null ? null : catalogPrice(host, m.modelId, day, options.catalog);
    if (pricing === null) return m;
    catalogPriced.push(modelRef(m.provider, m.modelId));
    return { ...m, pricing };
  });
  return { config: { ...config, models }, catalogPriced };
}

/** Where the prompt that adds missing prices lives (shown in warnings). */
export const PRICING_PROMPT_PATH = 'skills/update-model-pricing/SKILL.md';

/**
 * Callable configured models with no price (neither configured nor from the catalog), as refs.
 * Listed-only providers are skipped: soot never calls them.
 */
export function unpricedModels(config: RegistryConfig): string[] {
  const callable = new Set(
    config.providers.filter((p) => p.kind !== 'listed-only').map((p) => p.id),
  );
  return config.models
    .filter((m) => m.pricing === null && callable.has(m.provider))
    .map((m) => modelRef(m.provider, m.modelId));
}

/** One-line warning for unpriced models, or `null` when every callable model has a price. */
export function unpricedWarning(refs: readonly string[]): string | null {
  if (refs.length === 0) return null;
  return `${String(refs.length)} model(s) have no price (${refs.join(', ')}); their costs show as "price not set". Run the update-model-pricing prompt (${PRICING_PROMPT_PATH}) to look up official prices and add them.`;
}
