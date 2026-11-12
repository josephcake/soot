/**
 * @soot/core
 *
 * Package metadata, `SOOT_*` environment parsing, and the leveled logger that applies
 * `SOOT_LOG_LEVEL`. No orchestration code lives here.
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
export { SILENT_LOGGER, createLogger, type LineLevel, type Logger } from './log.js';
