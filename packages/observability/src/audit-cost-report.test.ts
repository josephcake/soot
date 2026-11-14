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
  it('puts the planning call on its own line and in the run total, never in a task (ADR-045)', () => {
    const tasks = [
      {
        taskId: 't1',
        plannedInputTokens: 100,
        plannedOutputTokens: 10,
        attempts: [
          {
            attempt: 1,
            model: 'a/m',
            estimatedUsd: 0.001,
            result: { status: 'succeeded' as const, usage: usage(120, 12, 0.002, 'a/m') },
          },
        ],
      },
    ];
    const priced = buildCostReport(tasks, {
      model: 'p/planner',
      inputTokens: 700,
      outputTokens: 150,
      costUsd: 0.000145,
      priced: true,
    });
    expect(priced.planning).toMatchObject({
      label: 'planning (decomposition)',
      model: 'p/planner',
    });
    expect(priced.tasks.map((t) => t.taskId)).toEqual(['t1']);
    expect(priced.totals.actual.usd).toBeCloseTo(0.002, 12);
    expect(priced.totals.run.usd).toBeCloseTo(0.002145, 12);
    expect(priced.byModel.map((m) => m.model)).toEqual(['a/m']);
    const text = renderCostReport(priced);
    expect(text).toContain(
      '- Planning (decomposition, not a task): p/planner, 700 in / 150 out tokens reported | actual $0.000145',
    );
    expect(text).toContain(
      'Total actual with planning: $0.002145 (planning $0.000145 + tasks $0.002000)',
    );

    const unpriced = buildCostReport(tasks, {
      model: 'p/planner',
      inputTokens: 700,
      outputTokens: null,
      costUsd: null,
      priced: false,
    });
    expect(unpriced.totals.run).toEqual({ usd: null, planningUsd: null });
    expect(renderCostReport(unpriced)).toContain(
      '700 in / not reported out tokens reported | actual unknown (model has no price)',
    );

    const fixture = buildCostReport(tasks);
    expect(fixture.planning).toBeNull();
    expect(fixture.totals.run.usd).toBe(fixture.totals.actual.usd);
    expect(renderCostReport(fixture)).not.toContain('Planning');
  });

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
