/**
 * @soot/cli
 *
 * Milestone 6 (partial): the `soot` command (run, status, cost, models, config, stop, mcp,
 * install-skill) and the engine behind it and the MCP server. Fixture-backed: decomposition
 * uses recorded fixtures, plus an optional configured decomposer model for other prompts
 * (ADR-034, verified with mock clients only). Agent runners: the scripted mock and the generic
 * ACP driver.
 */

export const PACKAGE_NAME = '@soot/cli';

/** `partial`: commands work against fixtures; no real agent runner exists yet. */
export const IMPLEMENTATION_STATUS = 'partial' as const;

/** Milestone that delivered the first real implementation. */
export const PLANNED_MILESTONE = 6;

export { USAGE, VERSION, main, type CliIo } from './cli.js';
export { SootEngine, type AgentMode, type EngineOptions } from './engine.js';
export {
  CONFIG_FILE,
  ConfigError,
  DecomposerConfigSchema,
  ProjectConfigSchema,
  loadProjectConfig,
  type LoadedConfig,
  type ProjectConfig,
} from './config.js';
export {
  describeDecomposerModel,
  resolveDecomposerModel,
  type DecomposerModel,
  type ModelClientFactory,
} from './decomposer-model.js';
export { MockScriptFileSchema, loadMockScript } from './mock-script.js';
export { interactiveApprovals, unattendedApprovals } from './approvals.js';
export {
  DEFAULT_SKILL_SOURCE,
  SKILL_NAME,
  SKILL_TARGETS,
  installSkill,
  type InstallResult,
  type InstallSkillOptions,
  type SkillTarget,
} from './install-skill.js';
export { holdRun, requestStop, runningInfo } from './control.js';
