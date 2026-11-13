import {
  CAPABILITIES,
  UNKNOWN_RELIABILITY,
  type Capability,
  type ModelConfig,
  type ProviderConfig,
  type RegistryConfig,
} from './config.js';
import type { ProviderHealth } from './health.js';
import { isCallable } from './policy.js';

/** A configured (or discovered) model with its provider. */
export interface ModelEntry extends ModelConfig {
  /** Stable reference `provider/modelId`. */
  readonly ref: string;
  /** Where the entry came from. Discovered entries have unknown metadata. */
  readonly origin: 'config' | 'discovered';
  /** Result of the last discovery for this provider; `null` if discovery has not run. */
  readonly listedByProvider: boolean | null;
}

export interface ModelRequirements {
  /** Capabilities the model must be KNOWN to have. */
  readonly capabilities?: readonly Capability[];
  /** Minimum context window in tokens; models with unknown windows do not qualify. */
  readonly minContextWindow?: number;
  /** Restrict to these providers. */
  readonly providers?: readonly string[];
  /** Only endpoints on the user's machine. */
  readonly localOnly?: boolean;
}

export type ExclusionReason =
  | 'not-selectable'
  | 'listed-only'
  | 'provider-unavailable'
  | 'not-listed-by-provider'
  | 'missing-capability'
  | 'unknown-capability'
  | 'context-window-too-small'
  | 'unknown-context-window'
  | 'provider-filtered'
  | 'not-local';

export interface Selection {
  /** Eligible models in configuration order (cost-based ranking is Milestone 3). */
  readonly candidates: readonly ModelEntry[];
  /** Why every other model was excluded (several reasons may apply). */
  readonly excluded: readonly {
    readonly ref: string;
    readonly reasons: readonly ExclusionReason[];
  }[];
}

/**
 * Context window assumed for a hosted (non-local) model whose window is not configured: tasks
 * planned at or below this many tokens may still route to it (ADR-039). Hosted chat models
 * offered today take far more; anything larger needs a configured `contextWindow`.
 */
export const HOSTED_CONTEXT_FLOOR = 32_000;

export const modelRef = (provider: string, modelId: string): string => `${provider}/${modelId}`;

/**
 * Thin model registry (ADR-019): user config, optional discovery overlay, availability, and
 * requirement-based selection. It contains no model names of its own.
 */
export class ModelRegistry {
  readonly #providers: ReadonlyMap<string, ProviderConfig>;
  readonly #models: ModelEntry[];

  constructor(config: RegistryConfig) {
    this.#providers = new Map(config.providers.map((p) => [p.id, p]));
    this.#models = config.models.map((m) => ({
      ...m,
      ref: modelRef(m.provider, m.modelId),
      origin: 'config' as const,
      listedByProvider: null,
    }));
  }

  providers(): ProviderConfig[] {
    return [...this.#providers.values()];
  }

  provider(id: string): ProviderConfig | undefined {
    return this.#providers.get(id);
  }

  models(): readonly ModelEntry[] {
    return this.#models;
  }

  get(ref: string): ModelEntry | undefined {
    return this.#models.find((m) => m.ref === ref);
  }

  /**
   * Overlay a provider's model listing. Configured models it does not list are marked
   * `listedByProvider: false` (and excluded from selection); listed models that are not
   * configured are added with every metadata field unknown and `selectable: false`, because
   * nothing about them has been checked.
   */
  applyDiscovery(
    providerId: string,
    listedModelIds: readonly string[],
  ): { added: string[]; missing: string[] } {
    if (!this.#providers.has(providerId)) throw new Error(`Unknown provider "${providerId}"`);
    const listed = new Set(listedModelIds);
    const missing: string[] = [];
    for (const [i, model] of this.#models.entries()) {
      if (model.provider !== providerId) continue;
      const isListed = listed.has(model.modelId);
      if (!isListed) missing.push(model.ref);
      this.#models[i] = { ...model, listedByProvider: isListed };
    }
    const added: string[] = [];
    for (const modelId of listed) {
      if (this.#models.some((m) => m.provider === providerId && m.modelId === modelId)) continue;
      const ref = modelRef(providerId, modelId);
      added.push(ref);
      this.#models.push({
        provider: providerId,
        modelId,
        family: null,
        capabilities: {
          tools: null,
          structuredOutput: null,
          vision: null,
          reasoning: null,
          streaming: null,
        },
        contextWindow: null,
        maxOutputTokens: null,
        pricing: null,
        reliability: { ...UNKNOWN_RELIABILITY },
        selectable: false,
        ref,
        origin: 'discovered',
        listedByProvider: true,
      });
    }
    return { added, missing };
  }

  /** Models that satisfy the requirements right now, plus the reason each other model was excluded. */
  select(requirements: ModelRequirements = {}, health?: ProviderHealth): Selection {
    const candidates: ModelEntry[] = [];
    const excluded: { ref: string; reasons: ExclusionReason[] }[] = [];
    for (const model of this.#models) {
      const reasons = this.#exclusions(model, requirements, health);
      if (reasons.length === 0) candidates.push(model);
      else excluded.push({ ref: model.ref, reasons });
    }
    return { candidates, excluded };
  }

  #exclusions(
    model: ModelEntry,
    req: ModelRequirements,
    health?: ProviderHealth,
  ): ExclusionReason[] {
    const reasons: ExclusionReason[] = [];
    const provider = this.#providers.get(model.provider);
    if (provider === undefined) return ['provider-unavailable'];
    if (!model.selectable) reasons.push('not-selectable');
    if (!isCallable(provider)) reasons.push('listed-only');
    if (health !== undefined && !health.isAvailable(provider.id))
      reasons.push('provider-unavailable');
    if (model.listedByProvider === false) reasons.push('not-listed-by-provider');
    if (req.providers !== undefined && !req.providers.includes(provider.id))
      reasons.push('provider-filtered');
    if (req.localOnly === true && !provider.local) reasons.push('not-local');
    for (const capability of req.capabilities ?? []) {
      if (!CAPABILITIES.includes(capability)) throw new Error(`Unknown capability "${capability}"`);
      const value = model.capabilities[capability];
      if (value === false && !reasons.includes('missing-capability'))
        reasons.push('missing-capability');
      if (value === null && !reasons.includes('unknown-capability'))
        reasons.push('unknown-capability');
    }
    if (req.minContextWindow !== undefined) {
      // Unknown window (ADR-039): a hosted API model is assumed to take at least
      // HOSTED_CONTEXT_FLOOR tokens; a local endpoint may be configured far smaller, so it
      // must state its window.
      if (model.contextWindow === null) {
        if (provider.local || req.minContextWindow > HOSTED_CONTEXT_FLOOR)
          reasons.push('unknown-context-window');
      } else if (model.contextWindow < req.minContextWindow)
        reasons.push('context-window-too-small');
    }
    return reasons;
  }
}
