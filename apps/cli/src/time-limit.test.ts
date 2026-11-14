import { describe, expect, it } from 'vitest';
import {
  formatLimit,
  REQUEST_TIMEOUT_MARGIN_MS,
  TimeLimitError,
  withTimeLimit,
} from './time-limit.js';

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

  it('requestTimeout() counts down from the limit, plus the margin', async () => {
    const left = await withTimeLimit(
      1000,
      undefined,
      async (_s, requestTimeout) => {
        await new Promise((r) => setTimeout(r, 50));
        return requestTimeout();
      },
      () => new Error('t'),
    );
    expect(left).toBeLessThanOrEqual(960 + REQUEST_TIMEOUT_MARGIN_MS);
    expect(left).toBeGreaterThan(REQUEST_TIMEOUT_MARGIN_MS);
  });

  it('an adapter timeout built from requestTimeout() never beats the limit', async () => {
    // Shaped like ai-sdk-client: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]).
    // When timeoutMs was just the time left, both timers came due in the same millisecond and
    // the adapter's won about 1 in 50 runs on Node 26, so callers got its generic error instead
    // of onTimeout() (flaky api-runner and api-providers tests in CI). 200 runs caught that
    // every time locally; with the margin the limit always fires first.
    const adapterLike = (signal: AbortSignal, requestTimeout: () => number) =>
      new Promise<never>((_, reject) => {
        const own = AbortSignal.timeout(requestTimeout());
        AbortSignal.any([signal, own]).addEventListener(
          'abort',
          () => {
            reject(new Error(own.aborted && !signal.aborted ? 'adapter timeout' : 'aborted'));
          },
          { once: true },
        );
      });
    const messages: string[] = [];
    for (let i = 0; i < 200; i++) {
      messages.push(
        await withTimeLimit(10, undefined, adapterLike, () => new Error('limit')).catch(
          (e: unknown) => (e as Error).message,
        ),
      );
    }
    expect(messages.filter((m) => m !== 'limit')).toEqual([]);
  });
});
