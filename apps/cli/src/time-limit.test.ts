import { describe, expect, it } from 'vitest';
import { formatLimit, TimeLimitError, withTimeLimit } from './time-limit.js';

describe('withTimeLimit (ADR-040)', () => {
  it('formats limits the way history and the dashboard show them', () => {
    expect(formatLimit(300)).toBe('300 ms');
    expect(formatLimit(120_000)).toBe('120s');
    expect(formatLimit(1500)).toBe('1.5s');
  });

  it('aborts the signal and rejects at the limit even if the work ignores the abort', async () => {
    let seen: AbortSignal | null = null;
    const started = Date.now();
    const p = withTimeLimit(
      100,
      undefined,
      (s) => {
        seen = s;
        return new Promise<never>(() => undefined); // never settles, never listens
      },
      () => new TimeLimitError(100, 'the thing'),
    );
    await expect(p).rejects.toThrow('the thing timed out after 100 ms');
    expect(Date.now() - started).toBeLessThan(1000);
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });

  it('passes through results and errors, and a caller abort is not a timeout', async () => {
    await expect(
      withTimeLimit(
        1000,
        undefined,
        () => Promise.resolve(7),
        () => new Error('t'),
      ),
    ).resolves.toBe(7);
    await expect(
      withTimeLimit(
        1000,
        undefined,
        () => Promise.reject(new Error('boom')),
        () => new Error('t'),
      ),
    ).rejects.toThrow('boom');
    const stop = new AbortController();
    const p = withTimeLimit(
      5000,
      stop.signal,
      (s) =>
        new Promise((_, reject) => {
          s.addEventListener('abort', () => {
            reject(new Error('cancelled'));
          });
        }),
      () => new Error('timeout'),
    );
    stop.abort();
    await expect(p).rejects.toThrow('cancelled');
  });

  it('remaining() counts down from the limit', async () => {
    const left = await withTimeLimit(
      1000,
      undefined,
      async (_s, remaining) => {
        await new Promise((r) => setTimeout(r, 50));
        return remaining();
      },
      () => new Error('t'),
    );
    expect(left).toBeLessThanOrEqual(960);
    expect(left).toBeGreaterThan(0);
  });
});
