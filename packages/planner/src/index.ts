/**
 * @soot/planner
 *
 * Milestone 1: prompt intake (immutable original prompt + project context + intended
 * outcome) and the `Decomposer` interface with a deterministic, fixture-backed
 * implementation (the default). `ModelDecomposer` (ADR-033) decomposes other prompts through a
 * caller-supplied `ModelClient`; it is verified with mock clients only, never a real provider.
 */

export const PACKAGE_NAME = '@soot/planner';

/** `partial`: the Milestone 1 scope is implemented; later milestones extend it. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 1;

export {
  ProjectContextSchema,
  PromptIntakeError,
  createPromptIntake,
  promptBytes,
  type IntendedOutcome,
  type ProjectContext,
  type PromptIntake,
  type PromptIntakeInput,
} from './intake.js';
export {
  FixtureDecomposer,
  NoFixtureError,
  normalizePromptForMatching,
  type Decomposer,
  type DecomposerKind,
  type Decomposition,
  type DecompositionFixture,
  type DecompositionSource,
  type DecompositionUsage,
  type FixtureDecompositionSource,
  type ModelDecompositionSource,
} from './decomposer.js';
export {
  DEFAULT_MAX_DECOMPOSITION_TASKS,
  DECOMPOSITION_SYSTEM_PROMPT,
  FixtureThenModelDecomposer,
  ModelDecomposer,
  ModelDecompositionError,
  createDecomposer,
  decompositionOutputSchema,
  type CreateDecomposerOptions,
  type ModelDecomposerOptions,
  type ModelDecompositionFailure,
} from './model-decomposer.js';
export {
  SPEC_FIXTURES,
  SPEC_SECTION_3_FIXTURE,
  SPEC_TEST_1_FIXTURE,
  SPEC_TEST_2_FIXTURE,
  SPEC_TEST_3_FIXTURE,
  SPEC_TEST_4_FIXTURE,
} from './spec-fixtures.js';
