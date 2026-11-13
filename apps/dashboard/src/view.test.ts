import { describe, expect, it } from 'vitest';
import { SAVINGS_NOTE, planningCall, toDashboardRun, toRunList } from './view.js';

const status = {
  runId: 'r1',
  state: 'running',
  running: true,
  prompt: 'do two things',
  createdAt: '2026-11-12T10:00:00.000Z',
  reportStatus: null,
  finalValidation: null,
  problems: [],
  tasks: [
    {
      taskId: 'a',
      complexity: 'low',
      dependsOn: [],
      state: 'succeeded',
      models: ['p/small', 'p/mid'],
      verdict: null,
      complete: false,
      reason: null,
      checks: [],
      attemptDetails: [
        {
          attempt: 1,
          state: 'retried',
          model: 'p/small',
          estimatedCostUsd: 0.001,
          actualCostUsd: null,
          failure: 'crash',
          startedAt: '2026-11-12T10:00:01.000Z',
          finishedAt: '2026-11-12T10:00:02.000Z',
        },
        {
          attempt: 2,
          state: 'succeeded',
          model: 'p/mid',
          estimatedCostUsd: 0.002,
          actualCostUsd: 0.003,
          failure: null,
          startedAt: '2026-11-12T10:00:03.000Z',
          finishedAt: '2026-11-12T10:00:05.000Z',
        },
      ],
    },
    {
      taskId: 'b',
      complexity: 'medium',
      dependsOn: ['a'],
      state: 'running',
      models: ['p/small'],
      verdict: null,
      complete: false,
      reason: null,
      checks: [],
      attemptDetails: [
        {
          attempt: 1,
          state: 'running',
          model: 'p/small',
          estimatedCostUsd: null,
          actualCostUsd: null,
          failure: null,
          startedAt: '2026-11-12T10:00:06.000Z',
          finishedAt: null,
        },
      ],
    },
  ],
  events: [
    { type: 'assign', taskId: 'a', attempt: 1, model: 'p/small', reason: 'cheapest' },
    { type: 'escalate', taskId: 'a', attempt: 2, model: 'p/mid', reason: 'crashed' },
  ],
};

describe('toDashboardRun', () => {
  it('builds the §12 fields from status data without inventing anything', () => {
    const v = toDashboardRun(status, null);
    expect(v.prompt).toBe('do two things');
    expect(v.taskCount).toBe(2);
    expect(v.graph.layers).toEqual([['a'], ['b']]);
    expect(v.activeAgents).toEqual([{ taskId: 'b', attempt: 1, model: 'p/small' }]);
    expect(v.tasks.map((t) => t.models)).toEqual([['p/small', 'p/mid'], ['p/small']]);
    expect(v.transitions).toEqual([
      { taskId: 'a', attempt: 2, type: 'escalate', model: 'p/mid', reason: 'crashed' },
    ]);
    // No cost data: everything unknown, nothing zero-filled.
    expect(v.tokens).toEqual({ estimated: null, actual: null });
    expect(v.cost).toEqual({
      estimatedUsd: null,
      actualUsd: null,
      unpricedAttempts: null,
      routedEstimateUsd: null,
    });
    expect(v.byModel).toEqual([]);
    // Still running: no end time and no duration.
    expect(v.duration).toMatchObject({
      startedAt: '2026-11-12T10:00:00.000Z',
      endedAt: null,
      ms: null,
    });
    expect(v.outcomes).toMatchObject({
      succeeded: 1,
      unfinished: 1,
      successRate: 1,
      failureRate: 0,
    });
    expect(v.validation).toEqual({ reportStatus: null, final: null, problems: [] });
    expect(v.savings).toEqual({ claimed: false, note: SAVINGS_NOTE });
  });

  it('keeps an unpriced actual unknown and computes duration only once finished', () => {
    const done = {
      ...status,
      running: false,
      state: 'incomplete',
      tasks: status.tasks.slice(0, 1),
      reportStatus: 'incomplete',
      finalValidation: [
        {
          name: 'test',
          kind: 'test',
          status: 'passed',
          required: true,
          exitCode: 0,
          durationMs: 12,
        },
      ],
      problems: ['working tree not updated'],
    };
    const cost = {
      cost: {
        totals: {
          estimated: { inputTokens: 100, outputTokens: 50, usd: 0.002 },
          actual: {
            attempts: 2,
            inputTokens: 80,
            outputTokens: 40,
            usd: null,
            unpricedAttempts: 1,
            unreportedAttempts: 1,
          },
        },
        byModel: [
          { model: 'p/small', attempts: 1, inputTokens: 0, outputTokens: 0, actualUsd: null },
          { model: 'p/mid', attempts: 1, inputTokens: 80, outputTokens: 40, actualUsd: 0.003 },
        ],
      },
      costSummary: { routed: { costUsd: 0.003 } },
    };
    const v = toDashboardRun(done, cost);
    expect(v.cost).toEqual({
      estimatedUsd: 0.002,
      actualUsd: null,
      unpricedAttempts: 1,
      routedEstimateUsd: 0.003,
    });
    expect(v.tokens.actual).toEqual({ inputTokens: 80, outputTokens: 40, unreportedAttempts: 1 });
    expect(v.byModel.map((m) => [m.model, m.actualUsd])).toEqual([
      ['p/small', null],
      ['p/mid', 0.003],
    ]);
    expect(v.duration).toMatchObject({ endedAt: '2026-11-12T10:00:05.000Z', ms: 5000 });
    expect(v.validation.final).toEqual([
      { name: 'test', kind: 'test', status: 'passed', exitCode: 0, required: true, durationMs: 12 },
    ]);
    expect(v.validation.problems).toEqual(['working tree not updated']);
  });

  it('lists runs from `soot status` data', () => {
    expect(
      toRunList({
        ok: true,
        text: '',
        data: {
          runs: [{ runId: 'r1', createdAt: 't', state: 'incomplete', tasks: 2, prompt: 'p' }],
        },
      }),
    ).toEqual([{ runId: 'r1', createdAt: 't', state: 'incomplete', tasks: 2, prompt: 'p' }]);
  });

  it('assignment: prompt, each task with its text, and the model chain with how it was chosen', () => {
    const withText = {
      ...status,
      agent: 'acp',
      agentLabel: 'acp (example agent)',
      tasks: status.tasks.map((t) => ({
        ...t,
        title: `Title ${t.taskId}`,
        instructions: `Do ${t.taskId}`,
      })),
    };
    const cost = {
      cost: {
        tasks: [
          {
            taskId: 'a',
            attempts: [
              { attempt: 1, model: 'p/small', status: 'failed' },
              // The runner reported another model: the route was not applied.
              { attempt: 2, model: 'vendor/own-choice', status: 'succeeded' },
            ],
          },
          { taskId: 'b', attempts: [{ attempt: 1, model: 'p/small', status: 'no-result' }] },
        ],
      },
    };
    const v = toDashboardRun(withText, cost);
    expect(v.agent).toEqual({ kind: 'acp', label: 'acp (example agent)' });
    expect(v.assignment.prompt).toBe('do two things');
    expect(v.assignment.tasks).toEqual([
      {
        id: 'a',
        title: 'Title a',
        instructions: 'Do a',
        dependsOn: [],
        runner: 'acp (example agent)',
        attempts: [
          {
            attempt: 1,
            via: 'assign',
            reason: 'cheapest',
            routedModel: 'p/small',
            reportedModel: 'p/small',
            state: 'retried',
          },
          {
            attempt: 2,
            via: 'escalate',
            reason: 'crashed',
            routedModel: 'p/mid',
            reportedModel: 'vendor/own-choice',
            state: 'succeeded',
          },
        ],
      },
      {
        id: 'b',
        title: 'Title b',
        instructions: 'Do b',
        dependsOn: ['a'],
        runner: 'acp (example agent)',
        // No result yet: which model really ran is unknown, not assumed to be the routed one.
        attempts: [
          {
            attempt: 1,
            via: null,
            reason: null,
            routedModel: 'p/small',
            reportedModel: null,
            state: 'running',
          },
        ],
      },
    ]);
    expect(v.usage.byAgent.map((r) => r.label)).toEqual(['acp (example agent)']);
  });

  it('without a saved report the runner is unknown and no runner row is drawn', () => {
    const v = toDashboardRun(status, null);
    expect(v.agent).toEqual({ kind: null, label: null });
    expect(v.usage).toMatchObject({ byTask: [], byModel: [], byAgent: [] });
    expect(v.assignment.tasks.every((t) => t.runner === null)).toBe(true);
  });

  it('task breakdown uses recorded per-task tokens when present, otherwise says they are unknown', () => {
    const noCost = toDashboardRun(status, null);
    expect(noCost.taskBreakdown.map((t) => [t.id, t.tokens, t.tokensUnknown, t.runner])).toEqual([
      ['a', null, 'no cost data recorded for this task', null],
      ['b', null, 'no cost data recorded for this task', null],
    ]);
    const v = toDashboardRun(status, {
      cost: {
        tasks: [
          {
            taskId: 'a',
            estimated: { inputTokens: 100, outputTokens: 10 },
            attempts: [
              { attempt: 1, model: 'p/small', inputTokens: 10, outputTokens: 2, actualUsd: null },
              { attempt: 2, model: 'p/mid', inputTokens: 20, outputTokens: 4, actualUsd: 0.003 },
            ],
          },
          {
            taskId: 'b',
            estimated: { inputTokens: 50, outputTokens: 5 },
            attempts: [
              {
                attempt: 1,
                model: 'p/small',
                inputTokens: null,
                outputTokens: null,
                actualUsd: null,
              },
            ],
          },
        ],
      },
    });
    expect(v.taskBreakdown).toEqual([
      {
        id: 'a',
        title: '',
        state: 'succeeded',
        runner: null,
        models: ['p/small', 'p/mid'],
        attempts: 2,
        tokens: { inputTokens: 30, outputTokens: 6, total: 36 },
        costUsd: null,
        tokensUnknown: null,
        costUnknown: 'cost not reported for every attempt on this task',
        unpricedAttempts: null,
        unreportedAttempts: null,
      },
      {
        id: 'b',
        title: '',
        state: 'running',
        runner: null,
        models: ['p/small'],
        attempts: 1,
        tokens: null,
        costUsd: null,
        tokensUnknown: 'tokens not reported for every attempt on this task',
        costUnknown: 'cost not reported for every attempt on this task',
        unpricedAttempts: null,
        unreportedAttempts: null,
      },
    ]);
  });

  it('reads per-task unpriced counts from the cost report and the planning call from status', () => {
    const v = toDashboardRun(
      {
        runId: 'r',
        prompt: 'p',
        tasks: [{ taskId: 'a', state: 'failed', attemptDetails: [] }],
        decomposition: {
          kind: 'model',
          modelRef: 'x/plan',
          servedModelId: 'plan-7',
          usage: { inputTokens: 662, outputTokens: 518 },
          attempts: 1,
        },
      },
      {
        cost: {
          tasks: [
            {
              taskId: 'a',
              attempts: [],
              actual: {
                inputTokens: 0,
                outputTokens: 0,
                usd: null,
                unpricedAttempts: 3,
                unreportedAttempts: 0,
              },
            },
          ],
        },
      },
    );
    expect(v.taskBreakdown[0]).toMatchObject({ unpricedAttempts: 3, unreportedAttempts: 0 });
    expect(v.planning).toEqual({
      kind: 'model',
      model: 'x/plan',
      servedModel: 'plan-7',
      inputTokens: 662,
      outputTokens: 518,
      costUsd: null,
    });
    expect(planningCall(undefined)).toBeNull();
    expect(planningCall({ kind: 'model' })).toBeNull();
    expect(planningCall({ kind: 'fixture' })?.kind).toBe('fixture');
  });
});
