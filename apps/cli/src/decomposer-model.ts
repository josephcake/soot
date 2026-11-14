import type { ModelRegistry } from '@soot/model-registry';
import {
  createModelClient,
  type CreateClientOptions,
  type ModelClient,
} from '@soot/provider-adapters';
import type { LoadedConfig } from './config.js';

/*
 * The optional decomposer model from `soot.config.json` (ADR-034), resolved to a client only
 * when one can really be built. soot never invents a client: an unknown model reference, a
 * provider soot will not call, or a missing key leaves the model `unusable`, and decomposition
 * stays fixture-only. Building a client makes no request; keys are read only inside
 * `createModelClient` (the credential boundary, ADR-022) and never returned or printed.
 */

/** Builds a client for a registry model. Default `createModelClient`; tests inject a mock. */
export type ModelClientFactory = (
  provider: NonNullable<ReturnType<ModelRegistry['provider']>>,
  model: NonNullable<ReturnType<ModelRegistry['get']>>,
  options: CreateClientOptions,
) => ModelClient;

export type DecomposerModel =
  /** No `decomposer` in the config: fixture-only, nothing is resolved. */
  | { readonly status: 'not-configured' }
  /** A client exists. It has not been called. `auto`: picked by `"model": "auto"` (ADR-043). */
  | {
      readonly status: 'usable';
      readonly ref: string;
      readonly client: ModelClient;
      readonly auto?: boolean;
    }
  /** Configured, but no client could be built; `reason` says why (never a key value). */
  | { readonly status: 'unusable'; readonly ref: string; readonly reason: string };

/**
 * `"model": "auto"` (ADR-043): the cheapest priced, callable model with structured output whose
 * client can be built (its key is set), preferring models not tiered `low`: planning a whole
 * prompt is not light work. Building a client makes no request.
 */
function pickAutoDecomposer(
  registry: ModelRegistry,
  env: Readonly<Record<string, string | undefined>>,
  factory: ModelClientFactory,
): DecomposerModel {
  const ranked = registry
    .select({ capabilities: ['structuredOutput'] })
    .candidates.filter((m) => m.pricing !== null)
    .sort((a, b) => {
      const weak = (m: typeof a) => (m.tier === 'low' ? 1 : 0);
      const price = (m: typeof a) =>
        (m.pricing?.inputPerMTokUsd ?? 0) + (m.pricing?.outputPerMTokUsd ?? 0);
      return weak(a) - weak(b) || price(a) - price(b) || a.ref.localeCompare(b.ref);
    });
  for (const model of ranked) {
    const provider = registry.provider(model.provider);
    if (provider === undefined) continue;
    try {
      return {
        status: 'usable',
        ref: model.ref,
        client: factory(provider, model, { env }),
        auto: true,
      };
    } catch {
      // No key (or refused): try the next model.
    }
  }
  return {
    status: 'unusable',
    ref: 'auto',
    reason: 'no priced model with structured output has its key set',
  };
}

export function resolveDecomposerModel(
  cfg: LoadedConfig,
  registry: ModelRegistry,
  env: Readonly<Record<string, string | undefined>>,
  factory: ModelClientFactory = createModelClient,
): DecomposerModel {
  const ref = cfg.config.decomposer?.model;
  if (ref === undefined) return { status: 'not-configured' };
  if (ref === 'auto') return pickAutoDecomposer(registry, env, factory);
  const unusable = (reason: string): DecomposerModel => ({ status: 'unusable', ref, reason });
  const model = registry.get(ref);
  if (model === undefined)
    return unusable(
      `model "${ref}" is not in ${cfg.modelsPath ?? 'the models soot detected from your keys (no models file)'}`,
    );
  const provider = registry.provider(model.provider);
  if (provider === undefined) return unusable(`provider "${model.provider}" is not configured`);
  if (model.capabilities.structuredOutput === false) {
    return unusable(`model "${ref}" is configured without structured output`);
  }
  try {
    return { status: 'usable', ref, client: factory(provider, model, { env }) };
  } catch (error) {
    return unusable((error as Error).message);
  }
}

/** One line for `soot config` and run errors. */
export function describeDecomposerModel(d: DecomposerModel): string {
  switch (d.status) {
    case 'not-configured':
      return 'recorded fixtures only (no "decomposer" model configured)';
    case 'usable':
      return `fixtures first, then ${d.ref}${d.auto === true ? ' (picked by "auto": cheapest priced model with structured output whose key is set)' : ''} for prompts with no fixture (client can be built; not called by this command)`;
    case 'unusable':
      return `fixtures only: ${d.ref} is configured but not usable (${d.reason})`;
  }
}
