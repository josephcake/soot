import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Log levels accepted by `SOOT_LOG_LEVEL`. */
export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Validated runtime configuration derived from `SOOT_*` environment variables. */
export interface EnvConfig {
  /** Verbosity for future engine logging. Default: `info`. */
  readonly logLevel: LogLevel;
  /**
   * Absolute directory for local-first state (future SQLite DB, worktrees, audit logs).
   * Default: `~/.soot`.
   */
  readonly dataDir: string;
}

export interface ParseEnvOptions {
  /** Override the home directory (used for the default data dir). Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** Base for resolving a relative `SOOT_DATA_DIR`. Defaults to `process.cwd()`. */
  readonly cwd?: string;
}

/** Thrown when an `SOOT_*` variable is set to an invalid value. */
export class EnvConfigError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(`${variable}: ${message}`);
    this.name = 'EnvConfigError';
  }
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse and validate the orchestrator's own environment variables.
 *
 * Only `SOOT_*` variables are read. Provider API keys are intentionally NOT read here:
 * no provider integration exists yet (Milestone 2), and credentials must never flow
 * through general config objects.
 */
export function parseEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: ParseEnvOptions = {},
): EnvConfig {
  const rawLevel = env.SOOT_LOG_LEVEL?.trim().toLowerCase();
  let logLevel: LogLevel = 'info';
  if (rawLevel !== undefined && rawLevel !== '') {
    if (!isLogLevel(rawLevel)) {
      throw new EnvConfigError(
        'SOOT_LOG_LEVEL',
        `expected one of ${LOG_LEVELS.join(', ')}, got "${rawLevel}"`,
      );
    }
    logLevel = rawLevel;
  }

  const rawDir = env.SOOT_DATA_DIR?.trim();
  const dataDir =
    rawDir === undefined || rawDir === ''
      ? join(options.homeDir ?? homedir(), '.soot')
      : isAbsolute(rawDir)
        ? rawDir
        : resolve(options.cwd ?? process.cwd(), rawDir);

  return { logLevel, dataDir };
}
