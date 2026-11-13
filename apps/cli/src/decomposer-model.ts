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
  /** A client exists. It has not been called. */
  | { readonly status: 'usable'; readonly ref: string; readonly client: ModelClient }
  /** Configured, but no client could be built; `reason` says why (never a key value). */
  | { readonly status: 'unusable'; readonly ref: string; readonly reason: string };

export function resolveDecomposerModel(
  cfg: LoadedConfig,
  registry: ModelRegistry,
  env: Readonly<Record<string, string | undefined>>,
  factory: ModelClientFactory = createModelClient,
): DecomposerModel {
  const ref = cfg.config.decomposer?.model;
  if (ref === undefined) return { status: 'not-configured' };
  const unusable = (reason: string): DecomposerModel => ({ status: 'unusable', ref, reason });
  const model = registry.get(ref);
  if (model === undefined) return unusable(`model "${ref}" is not in ${cfg.modelsPath}`);
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
      return `fixtures first, then ${d.ref} for prompts with no fixture (client can be built; not called by this command)`;
    case 'unusable':
      return `fixtures only: ${d.ref} is configured but not usable (${d.reason})`;
  }
}
