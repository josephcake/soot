import { LOG_LEVELS, type LogLevel } from './env.js';

/*
 * Leveled log lines for soot's runtime (`SOOT_LOG_LEVEL`). A line is written when its level is
 * at or above the configured level: `silent` writes nothing, `error` only errors, `warn` adds
 * warnings, `info` (default) adds progress, `debug` adds diagnostics. Command results (what a
 * command prints on stdout, and its final error) are not log lines and are never suppressed.
 */

export type LineLevel = Exclude<LogLevel, 'silent'>;

export interface Logger {
  readonly level: LogLevel;
  readonly enabled: (level: LineLevel) => boolean;
  readonly error: (line: string) => void;
  readonly warn: (line: string) => void;
  readonly info: (line: string) => void;
  readonly debug: (line: string) => void;
}

const rank = (level: LogLevel) => LOG_LEVELS.indexOf(level);

export function createLogger(level: LogLevel, sink: (line: string) => void): Logger {
  const enabled = (at: LineLevel) => level !== 'silent' && rank(at) <= rank(level);
  const at = (l: LineLevel) => (line: string) => {
    if (enabled(l)) sink(line);
  };
  return {
    level,
    enabled,
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
  };
}

/** A logger that writes nothing (for embedding the engine without output). */
export const SILENT_LOGGER: Logger = createLogger('silent', () => undefined);
