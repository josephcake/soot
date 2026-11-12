/**
 * @soot/model-registry
 *
 * Milestone 2: thin model registry (ADR-019). Loads the user's model config (no built-in model
 * names), overlays provider discovery and availability, selects models by requirements, and
 * computes costs from sourced list prices. Unknown metadata stays unknown.
 */

export const PACKAGE_NAME = '@soot/model-registry';

/** `partial`: the Milestone 2 scope is implemented; later milestones extend it. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 2;

export {
  CAPABILITIES,
  CONFIG_VERSION,
  CapabilitiesSchema,
  ModelConfigSchema,
  PROVIDER_KINDS,
  PricingSchema,
  ProviderConfigSchema,
  RegistryConfigError,
  RegistryConfigSchema,
  loadRegistryConfigFile,
  parseRegistryConfig,
  type Capabilities,
  type Capability,
  type ModelConfig,
  type Pricing,
  type ProviderConfig,
  type ProviderKind,
  type RegistryConfig,
  type RegistryConfigInput,
} from './config.js';
export { isCallable, providerRestriction, type ProviderRestriction } from './policy.js';
export {
  DEFAULT_COOLDOWN_MS,
  ProviderHealth,
  type ProviderStatus,
  type UnavailableReason,
} from './health.js';
export {
  ModelRegistry,
  modelRef,
  type ExclusionReason,
  type ModelEntry,
  type ModelRequirements,
  type Selection,
} from './registry.js';
export {
  actualCostFromUsage,
  estimateCost,
  type PriceBasis,
  type ReportedTokenUsage,
  type TokenCounts,
} from './pricing.js';
