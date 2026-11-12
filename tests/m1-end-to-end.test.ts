/**
 * Milestone 1 exit criteria, end to end, with mock agents (TEST DOUBLE; no model calls):
 * one prompt -> fixture decomposer -> dependency graph -> concurrent schedule -> persisted,
 * inspectable structured results.
 *
 *  EC1 a single prompt is decomposed into multiple tasks
 *  EC2 dependencies are represented correctly
 *  EC3 independent tasks are scheduled concurrently (proven by timestamps and ordering)
 *  EC4 results can be collected and inspected
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MockAgentRunner, runTaskGraph, type RunReport } from '@soot/agent-runtime';
import { openExecutionStore } from '@soot/context-manager';
import { parseEnv } from '@soot/core';
import { createCostRecord, recordAttempt, summarizeCosts } from '@soot/observability';
import { FixtureDecomposer, SPEC_FIXTURES, createPromptIntake } from '@soot/planner';

const TEST_1_PROMPT =
  'Change the page title to HELLO WORLD and update the primary button to purple.';
const TEST_4_PROMPT =
  'Implement a new feature, add tests, and review the implementation for security issues.';
const DELAY_MS = 150;

const dataRoot = mkdtempSync(join(tmpdir(), 'soot-e2e-'));
afterAll(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

const span = (report: RunReport, id: string): [number, number] => {
  const o = report.outcomes.get(id);
  if (o?.startedAt == null || o.finishedAt == null) throw new Error(`${id} did not run`);
  return [o.startedAt, o.finishedAt];
};

async function runPrompt(prompt: string, sub: string) {
  const { dataDir } = parseEnv({ SOOT_DATA_DIR: join(dataRoot, sub) });
  const intake = createPromptIntake({ prompt, context: { name: 'demo-app' } });
  const decomposition = await new FixtureDecomposer(SPEC_FIXTURES).decompose(intake);
  const store = openExecutionStore({ dataDir });
  const runId = store.createRun({ intake, graph: decomposition.graph });
  const runner = new MockAgentRunner({
    defaultScript: { delayMs: DELAY_MS, usage: { inputTokens: 1200, outputTokens: 250 } },
  });
  const report = await runTaskGraph(decomposition.graph, {
    runner,
    concurrency: 4,
    journal: store.journal(runId),
  });
  const persisted = store.loadRun(runId);
  store.close();
  return { intake, decomposition, report, runner, persisted, dataDir };
}

describe('Milestone 1 end to end: spec §17 Test 1', () => {
  it('EC1-EC4: one prompt becomes two tasks that run concurrently and yield inspectable results', async () => {
    const { intake, decomposition, report, runner, persisted } = await runPrompt(
      TEST_1_PROMPT,
      'test-1',
    );

    // EC1: decomposed into multiple tasks.
    expect(decomposition.decomposer).toEqual({
      kind: 'fixture',
      fixtureId: 'build-spec-17-test-1',
    });
    expect(decomposition.tasks.map((t) => t.id)).toEqual([
      'update-page-title',
      'update-button-color',
    ]);

    // EC2: no dependencies between them, no file conflicts, one layer.
    expect(decomposition.graph.layers).toEqual([['update-page-title', 'update-button-color']]);
    expect(decomposition.graph.implicitEdges).toEqual([]);

    // EC3: both intervals overlap; wall time ~ one delay, not two.
    const title = span(report, 'update-page-title');
    const button = span(report, 'update-button-color');
    expect(Math.max(title[0], button[0])).toBeLessThan(Math.min(title[1], button[1]));
    expect(report.maxObservedConcurrency).toBe(2);
    expect(report.finishedAt - report.startedAt).toBeLessThan(DELAY_MS * 1.9);
    expect(report.events.slice(0, 2).map((e) => e.type)).toEqual(['task-started', 'task-started']);

    // EC4: results collected in memory and persisted; both validate and can be inspected.
    expect(report.status).toBe('succeeded');
    for (const id of ['update-page-title', 'update-button-color']) {
      const result = report.outcomes.get(id)?.result;
      expect(result).toMatchObject({ taskId: id, attempt: 1, status: 'succeeded' });
      expect(persisted.completed.get(id)).toEqual(result);
    }
    expect(persisted.originalPrompt).toBe(intake.originalPrompt);
    expect(persisted.promptSha256).toBe(intake.promptSha256);
    expect(runner.calls).toHaveLength(2);

    const costs = summarizeCosts(
      decomposition.tasks.map((task) => {
        const result = report.outcomes.get(task.id)?.result;
        if (!result) throw new Error('missing result');
        return recordAttempt(createCostRecord(task), result);
      }),
    );
    expect(costs.estimated).toMatchObject({ inputTokens: 4500, outputTokens: 600, costUsd: null });
    expect(costs.actual).toMatchObject({
      attempts: 2,
      inputTokens: 2400,
      outputTokens: 500,
      costUsd: null,
    });
  });
});

describe('Milestone 1 end to end: spec §17 Test 4 (dependencies)', () => {
  it('EC2/EC3: dependents wait for the implementation, then run concurrently with each other', async () => {
    const { decomposition, report, runner } = await runPrompt(TEST_4_PROMPT, 'test-4');
    expect(decomposition.tasks).toHaveLength(3);
    expect(decomposition.graph.prerequisites.get('add-feature-tests')).toEqual([
      'implement-feature',
    ]);
    expect(decomposition.graph.prerequisites.get('security-review')).toEqual(['implement-feature']);

    const implement = span(report, 'implement-feature');
    const tests = span(report, 'add-feature-tests');
    const review = span(report, 'security-review');
    expect(tests[0]).toBeGreaterThanOrEqual(implement[1]);
    expect(review[0]).toBeGreaterThanOrEqual(implement[1]);
    expect(Math.max(tests[0], review[0])).toBeLessThan(Math.min(tests[1], review[1]));
    expect(report.status).toBe('succeeded');

    // Dependents received the implementation's structured result, not the prompt.
    for (const id of ['add-feature-tests', 'security-review']) {
      expect(runner.calls.find((c) => c.taskId === id)?.dependencyTaskIds).toEqual([
        'implement-feature',
      ]);
    }
  });
});
