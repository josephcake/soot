import {
  ModelConfigSchema,
  ProviderConfigSchema,
  type ModelConfig,
  type ModelTier,
  type Pricing,
  type ProviderConfig,
  type RegistryConfig,
} from './config.js';
import { PRICE_CATALOG, catalogPrice, providerHost, type CatalogEntry } from './price-catalog.js';
import { modelRef } from './registry.js';

/*
 * Key-based auto pool (ADR-043). When a well-known vendor key variable is set (checked for
 * presence only, in the adapter layer), soot adds that vendor's models from its sourced price
 * catalog, each with a tier from its list price, so the router can send light work to cheap
 * models and hard work to strong ones without a hand-written models file. This module is pure:
 * it never reads the environment; the caller says which providers have a key.
 *
 * The user's models file always wins: a vendor whose provider id or key variable the file
 * already configures gets nothing added, and `"autoModels": false` turns the pool off.
 */

/** A vendor soot can configure by itself when its key variable is set. */
export interface KnownProvider {
  readonly provider: ProviderConfig;
  /** How this endpoint's wire format was checked (docs and `soot config`). */
  readonly verified: string;
}

const known = (provider: Record<string, unknown>, verified: string): KnownProvider =>
  Object.freeze({ provider: ProviderConfigSchema.parse(provider), verified });

/**
 * Only vendors whose API soot has exercised end to end. Others (Gemini, Mistral, FreeLLMAPI)
 * still work through a models file. Keyless local runtimes are probed separately (ADR-045,
 * `local-pool.ts`).
 */
export const KNOWN_PROVIDERS: readonly KnownProvider[] = Object.freeze([
  known(
    { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    'native Messages API, fake-server end to end (ADR-040)',
  ),
  known(
    { id: 'openai', kind: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    'Chat Completions, fake-server end to end (ADR-040)',
  ),
  known(
    {
      id: 'xai',
      kind: 'openai-compatible',
      baseURL: 'https://api.x.ai/v1',
      apiKeyEnv: 'XAI_API_KEY',
    },
    'OpenAI-compatible, live runs 2026-11-13 (ADR-039)',
  ),
  known(
    {
      id: 'deepseek',
      kind: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      structuredOutputMode: 'json_object',
    },
    'OpenAI-compatible with json_object output, live runs 2026-11-13 (ADR-036, ADR-039)',
  ),
]);

/**
 * Price bands for auto tiers, on the list OUTPUT price in USD per million tokens: below
 * `medium` is `low`, from `medium` up to `high` is `medium`, `high` and above is `high`.
 * Price stands in for strength only until soot has measured the model (ADR-043).
 */
export const TIER_BANDS = Object.freeze({ medium: 2.5, high: 15 });

export function tierFromPrice(pricing: Pick<Pricing, 'outputPerMTokUsd'>): ModelTier {
  if (pricing.outputPerMTokUsd >= TIER_BANDS.high) return 'high';
  if (pricing.outputPerMTokUsd >= TIER_BANDS.medium) return 'medium';
  return 'low';
}

export interface AutoModelReport {
  readonly ref: string;
  readonly tier: ModelTier;
  readonly outputPerMTokUsd: number;
}

export interface AutoProviderReport {
  readonly id: string;
  /** Name of the key variable (never its value). */
  readonly apiKeyEnv: string;
  /**
   * `added`: key set, models added. `no-key`: key variable not set. `configured`: the models
   * file already covers this vendor, nothing added. `off`: `"autoModels": false`.
   */
  readonly status: 'added' | 'no-key' | 'configured' | 'off';
  readonly models: readonly AutoModelReport[];
  readonly reason: string;
}

export interface AutoPoolResult {
  /** The models file plus the auto-added providers and models. */
  readonly config: RegistryConfig;
  /** Refs added by detection (pass to `new ModelRegistry(config, { autoRefs })`). */
  readonly autoRefs: readonly string[];
  /** One row per known vendor. */
  readonly providers: readonly AutoProviderReport[];
}

export interface AutoPoolOptions {
  /** True when the provider's key variable is set. Presence only; see `hasApiKey`. */
  readonly keyIsSet: (provider: ProviderConfig) => boolean;
  /** `false` turns the pool off (`"autoModels": false`). Default true. */
  readonly enabled?: boolean;
  /** Day (YYYY-MM-DD) for dated catalog prices. Default: today (UTC). */
  readonly today?: string;
  readonly catalog?: readonly CatalogEntry[];
  readonly knownProviders?: readonly KnownProvider[];
}

/** Catalog models for a provider's API host on `day`, cheapest output price first. */
function catalogModels(
  provider: ProviderConfig,
  day: string,
  catalog: readonly CatalogEntry[],
): ModelConfig[] {
  const host = providerHost(provider);
  if (host === null) return [];
  const ids = [...new Set(catalog.filter((e) => e.hosts.includes(host)).map((e) => e.modelId))];
  const models: ModelConfig[] = [];
  for (const modelId of ids) {
    const pricing = catalogPrice(host, modelId, day, catalog);
    if (pricing === null) continue;
    models.push(
      ModelConfigSchema.parse({
        provider: provider.id,
        modelId,
        // soot's API runner needs both; every catalog chat model offers them. Everything else
        // (vision, reasoning, context window) stays unknown rather than guessed.
        capabilities: { tools: true, structuredOutput: true },
        pricing,
        tier: tierFromPrice(pricing),
      }),
    );
  }
  return models.sort(
    (a, b) =>
      (a.pricing?.outputPerMTokUsd ?? 0) - (b.pricing?.outputPerMTokUsd ?? 0) ||
      a.modelId.localeCompare(b.modelId),
  );
}

/**
 * Merge the auto pool into a models-file config. Never changes or removes anything the file
 * configures. No network calls; reads no environment.
 */
export function addAutoModels(base: RegistryConfig, options: AutoPoolOptions): AutoPoolResult {
  const day = options.today ?? new Date().toISOString().slice(0, 10);
  const catalog = options.catalog ?? PRICE_CATALOG;
  const enabled = options.enabled ?? true;
  const providers = [...base.providers];
  const models = [...base.models];
  const autoRefs: string[] = [];
  const reports: AutoProviderReport[] = [];

  for (const { provider } of options.knownProviders ?? KNOWN_PROVIDERS) {
    const env = provider.apiKeyEnv ?? '';
    const row = (status: AutoProviderReport['status'], reason: string, list = []) =>
      reports.push({ id: provider.id, apiKeyEnv: env, status, models: list, reason });
    if (!enabled) {
      row('off', 'autoModels is false in soot.config.json');
      continue;
    }
    const covered = base.providers.find(
      (p) => p.id === provider.id || (p.apiKeyEnv !== undefined && p.apiKeyEnv === env),
    );
    if (covered !== undefined) {
      row(
        'configured',
        `your models file configures provider "${covered.id}"${covered.apiKeyEnv === undefined ? '' : ` ($${covered.apiKeyEnv})`}; soot adds nothing for it`,
      );
      continue;
    }
    if (!options.keyIsSet(provider)) {
      row('no-key', `$${env} is not set`);
      continue;
    }
    const added = catalogModels(provider, day, catalog);
    providers.push(provider);
    models.push(...added);
    const list: AutoModelReport[] = added.map((m) => ({
      ref: modelRef(m.provider, m.modelId),
      tier: m.tier ?? 'low',
      outputPerMTokUsd: m.pricing?.outputPerMTokUsd ?? 0,
    }));
    autoRefs.push(...list.map((m) => m.ref));
    reports.push({
      id: provider.id,
      apiKeyEnv: env,
      status: 'added',
      models: list,
      reason: `$${env} is set: ${String(list.length)} model(s) from soot's price catalog`,
    });
  }
  return { config: { ...base, providers, models }, autoRefs, providers: reports };
}

/** The empty models file used when soot.config.json names none. */
export const EMPTY_REGISTRY_CONFIG: RegistryConfig = Object.freeze({
  version: 1,
  providers: [],
  models: [],
});

/** One line per vendor for `soot config` / `soot models`. Names key variables, never values. */
export function describeAutoPool(reports: readonly AutoProviderReport[]): string[] {
  return reports.map((r) =>
    r.status === 'added'
      ? `- ${r.id}: ${r.reason}: ${r.models.map((m) => `${m.ref} [${m.tier}]`).join(', ')}`
      : `- ${r.id}: ${r.status === 'no-key' ? 'not used' : r.status}; ${r.reason}`,
  );
}
