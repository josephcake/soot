import { describe, expect, it } from 'vitest';
import { EnvConfigError, parseEnv } from './env.js';

const opts = { homeDir: '/home/tester', cwd: '/work/project' };

describe('parseEnv', () => {
  it('applies local-first defaults when nothing is set', () => {
    expect(parseEnv({}, opts)).toEqual({
      logLevel: 'info',
      dataDir: '/home/tester/.intelligent-agent-router',
    });
  });

  it('treats empty strings as unset', () => {
    expect(parseEnv({ IAR_LOG_LEVEL: '  ', IAR_DATA_DIR: '' }, opts)).toEqual(parseEnv({}, opts));
  });

  it('accepts a valid log level case-insensitively', () => {
    expect(parseEnv({ IAR_LOG_LEVEL: 'DEBUG' }, opts).logLevel).toBe('debug');
  });

  it('rejects an unknown log level with the variable name', () => {
    expect(() => parseEnv({ IAR_LOG_LEVEL: 'verbose' }, opts)).toThrow(EnvConfigError);
    expect(() => parseEnv({ IAR_LOG_LEVEL: 'verbose' }, opts)).toThrow(/IAR_LOG_LEVEL/);
  });

  it('keeps an absolute data dir and resolves a relative one against cwd', () => {
    expect(parseEnv({ IAR_DATA_DIR: '/var/iar' }, opts).dataDir).toBe('/var/iar');
    expect(parseEnv({ IAR_DATA_DIR: './state' }, opts).dataDir).toBe('/work/project/state');
  });

  it('does not read provider credentials', () => {
    const config = parseEnv({ OPENAI_API_KEY: 'sk-should-not-appear' }, opts);
    expect(JSON.stringify(config)).not.toContain('sk-should-not-appear');
  });
});
