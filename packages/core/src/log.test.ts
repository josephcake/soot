import { describe, expect, it } from 'vitest';
import { createLogger } from './log.js';

const linesAt = (level: Parameters<typeof createLogger>[0]) => {
  const out: string[] = [];
  const log = createLogger(level, (l) => out.push(l));
  log.error('e');
  log.warn('w');
  log.info('i');
  log.debug('d');
  return out;
};

describe('createLogger (SOOT_LOG_LEVEL)', () => {
  it('writes lines at or above the configured level', () => {
    expect(linesAt('silent')).toEqual([]);
    expect(linesAt('error')).toEqual(['e']);
    expect(linesAt('warn')).toEqual(['e', 'w']);
    expect(linesAt('info')).toEqual(['e', 'w', 'i']);
    expect(linesAt('debug')).toEqual(['e', 'w', 'i', 'd']);
  });
});
