import { describe, expect, it } from 'vitest';
import { parseAgentResult } from '@soot/task-graph';
import { task } from './test-fixtures.js';
import { MockAgentRunner } from './index.js';

const input = (id: string, attempt = 1) => ({ task: task(id), attempt, dependencyResults: [] });

describe('MockAgentRunner (M1-08, test double)', () => {
  it('is labeled as a test double and its results say so', async () => {
    const runner = new MockAgentRunner();
    expect(runner.kind).toBe('mock-test-double');
    const result = parseAgentResult(await runner.run(input('a'), new AbortController().signal));
    expect(result.summary).toMatch(/^\[mock\]/);
    expect(result.usage.model).toBeNull();
    expect(result.usage.costUsd).toBeNull();
  });

  it('follows per-attempt scripts', async () => {
    const runner = new MockAgentRunner({
      scripts: { a: [{ outcome: 'fail' }, { outcome: 'succeed' }] },
    });
    const signal = new AbortController().signal;
    expect(parseAgentResult(await runner.run(input('a', 1), signal)).status).toBe('failed');
    expect(parseAgentResult(await runner.run(input('a', 2), signal)).status).toBe('succeeded');
    expect(parseAgentResult(await runner.run(input('a', 3), signal)).status).toBe('succeeded');
  });

  it('honors scripted delays and reports token usage', async () => {
    const runner = new MockAgentRunner({
      scripts: { a: { delayMs: 50, usage: { inputTokens: 7, outputTokens: 3 } } },
    });
    const result = parseAgentResult(await runner.run(input('a'), new AbortController().signal));
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(45);
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it('rejects on abort', async () => {
    const runner = new MockAgentRunner({ defaultScript: { delayMs: 5000 } });
    const controller = new AbortController();
    const pending = runner.run(input('a'), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(runner.calls[0]?.settledAs).toBe('aborted');
  });
});
