import { describe, expect, it } from 'vitest';
import { escalationBlock, escalationDetails, escalationTitle, renderBoard } from './blocks.js';
import { toRunView } from './view-model.js';

/*
 * M7-06: escalations shown as the engine recorded them. The fixture is trimmed from a real
 * `soot status <run> --json` of the demo app (mock agent, `sameModelRetries: 0`, the first
 * button attempt scripted to fail), captured 2026-11-14.
 */
const escalated = {
  ok: true,
  runId: 'esc-demo',
  state: 'incomplete',
  running: false,
  prompt: 'Change the page title to HELLO WORLD and update the primary button to purple.',
  tasks: [
    {
      taskId: 'update-page-title',
      state: 'succeeded',
      dependsOn: [],
      models: ['anthropic/claude-haiku-5-5'],
      attemptDetails: [
        { attempt: 1, state: 'succeeded', model: 'anthropic/claude-haiku-5-5', escalationLevel: 0 },
      ],
    },
    {
      taskId: 'update-button-color',
      state: 'succeeded',
      dependsOn: [],
      models: ['anthropic/claude-haiku-5-5', 'openai/gpt-6.1-terra'],
      attemptDetails: [
        {
          attempt: 1,
          state: 'retried',
          model: 'anthropic/claude-haiku-5-5',
          escalationLevel: 0,
          failure: 'reported-failure',
          error: 'agent reported failed',
        },
        { attempt: 2, state: 'succeeded', model: 'openai/gpt-6.1-terra', escalationLevel: 1 },
      ],
    },
  ],
  events: [
    {
      taskId: 'update-page-title',
      attempt: 1,
      type: 'assign',
      model: 'anthropic/claude-haiku-5-5',
      reason: 'Balanced: lowest estimated cost per success',
      triggers: [],
    },
    {
      taskId: 'update-button-color',
      attempt: 1,
      type: 'assign',
      model: 'anthropic/claude-haiku-5-5',
      reason: 'Balanced: lowest estimated cost per success',
      triggers: [],
    },
    {
      taskId: 'update-button-color',
      attempt: 2,
      type: 'escalate',
      model: 'openai/gpt-6.1-terra',
      reason:
        'escalate: 1 unsuccessful attempts on anthropic/claude-haiku-5-5 → openai/gpt-6.1-terra (medium tier, p≈0.88 vs 0.70)',
      triggers: [
        {
          kind: 'repeated-failure',
          detail: '1 unsuccessful attempts on anthropic/claude-haiku-5-5',
        },
      ],
    },
    {
      taskId: 'update-button-color',
      attempt: 2,
      type: 'accept',
      model: 'openai/gpt-6.1-terra',
      reason: 'result accepted',
      triggers: [],
    },
  ],
};

describe('escalations in the view model', () => {
  it('names the task, attempt, from and to models, level, reason and triggers', () => {
    expect(toRunView(escalated).escalations).toEqual([
      {
        taskId: 'update-button-color',
        attempt: 2,
        fromModel: 'anthropic/claude-haiku-5-5',
        toModel: 'openai/gpt-6.1-terra',
        level: 1,
        reason:
          'escalate: 1 unsuccessful attempts on anthropic/claude-haiku-5-5 → openai/gpt-6.1-terra (medium tier, p≈0.88 vs 0.70)',
        triggers: [
          {
            kind: 'repeated-failure',
            detail: '1 unsuccessful attempts on anthropic/claude-haiku-5-5',
          },
        ],
      },
    ]);
  });

  it('takes "from" from the previous routing event when attempts are not reported yet', () => {
    const view = toRunView({
      tasks: [{ taskId: 't', attemptDetails: [] }],
      events: [
        { taskId: 't', attempt: 1, type: 'assign', model: 'a/small' },
        { taskId: 'other', attempt: 1, type: 'assign', model: 'a/unrelated' },
        { taskId: 't', attempt: 2, type: 'retry', model: 'a/small' },
        { taskId: 't', attempt: 3, type: 'escalate', model: 'b/mid', reason: 'r1' },
        { taskId: 't', attempt: 4, type: 'escalate', model: 'c/big', reason: 'r2' },
      ],
    });
    expect(view.escalations.map((e) => [e.attempt, e.fromModel, e.toModel, e.level])).toEqual([
      [3, 'a/small', 'b/mid', null],
      [4, 'b/mid', 'c/big', null],
    ]);
  });

  it('leaves unknown values null instead of guessing', () => {
    const [e] = toRunView({ events: [{ taskId: 't', attempt: 2, type: 'escalate' }] }).escalations;
    expect(e).toMatchObject({ fromModel: null, toModel: null, level: null, reason: '' });
    expect(e?.triggers).toEqual([]);
  });

  it('keeps escalations out of the other-events list but in the raw events', () => {
    const view = toRunView(escalated);
    expect(view.events.map((e) => e.type)).toEqual(['escalate']);
    expect(renderBoard(view)).toMatch(/== Retries and other events ==\n\(none\)/);
  });
});

describe('escalation blocks', () => {
  const [e] = toRunView(escalated).escalations;
  if (e === undefined) throw new Error('fixture has one escalation');

  it('title: glyph, task, attempt, short model step and level', () => {
    expect(escalationTitle(e)).toBe(
      '▲ update-button-color #2 · claude-haiku-5-5 ──▶ gpt-6.1-terra · L1',
    );
  });

  it('details: from (previous attempt), to (this attempt and level), why, each trigger', () => {
    expect(escalationDetails(e)).toEqual([
      'from  anthropic/claude-haiku-5-5 (attempt #1)',
      'to    openai/gpt-6.1-terra (attempt #2, level 1)',
      'why   escalate: 1 unsuccessful attempts on anthropic/claude-haiku-5-5 → openai/gpt-6.1-terra (medium tier, p≈0.88 vs 0.70)',
      '      · repeated-failure: 1 unsuccessful attempts on anthropic/claude-haiku-5-5',
    ]);
  });

  it('board: a counted Escalations section, details indented under each title', () => {
    const board = renderBoard(toRunView(escalated));
    expect(board).toContain(
      [
        '== Escalations (1) ==',
        '▲ update-button-color #2 · claude-haiku-5-5 ──▶ gpt-6.1-terra · L1',
        '   from  anthropic/claude-haiku-5-5 (attempt #1)',
        '   to    openai/gpt-6.1-terra (attempt #2, level 1)',
      ].join('\n'),
    );
    expect(board).toMatch(/Legend: .*▲ escalated/);
  });

  it('says so plainly when nothing escalated', () => {
    expect(escalationBlock([])).toEqual(['(no escalations)']);
    expect(renderBoard(toRunView({ runId: 'x' }))).toMatch(
      /== Escalations \(0\) ==\n\(no escalations\)/,
    );
  });
});
