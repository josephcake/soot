import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AuditLog, buildCostReport, redactSecrets, renderCostReport } from './index.js';

const usage = (
  inputTokens: number,
  outputTokens: number,
  costUsd: number | null,
  model: string,
) => ({
  inputTokens,
  outputTokens,
  durationMs: 1,
  costUsd,
  model,
});

describe('AuditLog', () => {
  it('appends redacted JSON lines to a 0600 file and filters entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soot-audit-'));
    try {
      const file = join(dir, 'nested', 'run.jsonl');
      const log = new AuditLog({ runId: 'r1', file, now: () => new Date('2026-01-01T00:00:00Z') });
      log.record('command-run', 't1', {
        output: 'OPENAI_API_KEY=abc123 and sk-abcdefghijklmnop',
        list: ['ghp_aaaaaaaaaaaaaaaaaaaaaaaa'],
      });
      log.record('task-verified', 't2');
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0] ?? '') as {
        seq: number;
        detail: { output: string; list: string[] };
      };
      expect(first.seq).toBe(1);
      expect(first.detail.output).toBe('OPENAI_API_KEY=[redacted] and [redacted]');
      expect(first.detail.list).toEqual(['[redacted]']);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(log.entries({ taskId: 't2' }).map((e) => e.type)).toEqual(['task-verified']);
      expect(log.entries({ type: 'command-run' })).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('ask-me later; task-123 passed')).toBe('ask-me later; task-123 passed');
  });
});

describe('buildCostReport', () => {
  it('keeps estimates and actuals apart and totals match the reported usage', () => {
    const report = buildCostReport([
      {
        taskId: 'a',
        plannedInputTokens: 1000,
        plannedOutputTokens: 200,
        attempts: [
          {
            attempt: 1,
            model: 'x/small',
            estimatedUsd: 0.001,
            result: { status: 'failed', usage: usage(900, 100, 0.0005, 'x/small') },
          },
          {
            attempt: 2,
            model: 'x/mid',
            estimatedUsd: 0.004,
            result: { status: 'succeeded', usage: usage(1100, 300, 0.003, 'x/mid') },
          },
        ],
      },
      {
        taskId: 'b',
        plannedInputTokens: 50,
        plannedOutputTokens: 5,
        attempts: [
          {
            attempt: 1,
            model: 'x/small',
            estimatedUsd: 0.0001,
            result: { status: 'succeeded', usage: usage(40, 4, null, 'x/small') },
          },
          { attempt: 2, model: 'x/small', estimatedUsd: 0.0001, result: null },
        ],
      },
    ]);
    const [a, b] = report.tasks;
    expect(a?.estimated).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
    expect(a?.estimated.usd).toBeCloseTo(0.005, 12);
    expect(a?.actual).toMatchObject({ inputTokens: 2000, outputTokens: 400, unpricedAttempts: 0 });
    expect(a?.actual.usd).toBeCloseTo(0.0035, 12);
    expect(a?.modelPath).toEqual(['x/small', 'x/mid']);
    // An unpriced attempt makes the actual unknown rather than silently zero.
    expect(b?.actual).toMatchObject({
      usd: null,
      unpricedAttempts: 1,
      unreportedAttempts: 1,
      inputTokens: 40,
    });
    expect(report.totals.actual).toMatchObject({
      attempts: 4,
      inputTokens: 2040,
      outputTokens: 404,
      usd: null,
    });
    expect(report.totals.estimated.inputTokens).toBe(1050);
    expect(report.byModel.map((m) => [m.model, m.attempts])).toEqual([
      ['x/mid', 1],
      ['x/small', 3],
    ]);
    const text = renderCostReport(report);
    expect(text).toMatch(
      /Total actual: unknown over 4 attempts \(2040 in \/ 404 out tokens reported; 1 unpriced, 1 without usage\)/,
    );
    expect(text).toMatch(/models x\/small → x\/mid/);
  });
});
