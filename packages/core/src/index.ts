/**
 * @intelligent-agent-router/core
 *
 * Milestone 0 foundation only: package metadata and environment parsing.
 * No orchestration, routing, or provider code exists yet (see ROADMAP.md).
 */

export { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';
export {
  EnvConfigError,
  LOG_LEVELS,
  parseEnv,
  type EnvConfig,
  type LogLevel,
  type ParseEnvOptions,
} from './env.js';
