/** M3-01: complexity and required-capability evaluation, with recorded reasons. */
import { describe, expect, it } from 'vitest';
import { evaluateTask } from './evaluate.js';
import { makeTask } from './test-fixtures.js';

describe('evaluateTask (M3-01)', () => {
  it('keeps a simple edit at low complexity with only the base requirements', () => {
    const p = evaluateTask(makeTask('rename', { requiredCapabilities: ['code-edit', 'css'] }));
    expect(p).toMatchObject({
      complexity: 'low',
      reliabilityTier: 'low',
      highRisk: false,
      requiredModelCapabilities: ['tools', 'structuredOutput'],
      minContextWindow: 2300,
      unmappedCapabilities: [],
    });
    expect(p.reasons[0]).toBe('planner declared low complexity');
  });

  it('marks security review as high-risk and requiring reasoning', () => {
    const p = evaluateTask(
      makeTask('review', {
        requiredCapabilities: ['code-read', 'security-review'],
        complexity: 'medium',
      }),
    );
    expect(p.highRisk).toBe(true);
    expect(p.complexity).toBe('medium');
    expect(p.reliabilityTier).toBe('high');
    expect(p.requiredModelCapabilities).toContain('reasoning');
    expect(p.reasons.join('\n')).toMatch(/"security-review" is high-risk/);
    expect(p.reasons.join('\n')).toMatch(/requires model capability reasoning/);
  });

  it('raises complexity from signals but never lowers the planner', () => {
    const debugging = evaluateTask(makeTask('dbg', { requiredCapabilities: ['debugging'] }));
    expect(debugging.complexity).toBe('medium');
    expect(debugging.reasons).toContain('"debugging" raises complexity to medium');

    const big = evaluateTask(
      makeTask('big', { estimate: { inputTokens: 160_000, outputTokens: 5000, costUsd: null } }),
    );
    expect(big.complexity).toBe('high');
    expect(big.reasons.join('\n')).toMatch(/165000 planned tokens exceed 150000/);

    const declaredHigh = evaluateTask(makeTask('hard', { complexity: 'high' }));
    expect(declaredHigh.complexity).toBe('high');
  });

  it('maps vision, reasoning, streaming, and structured-output vocabulary onto model capabilities', () => {
    const p = evaluateTask(
      makeTask('multi', {
        requiredCapabilities: ['ui-visual', 'reasoning', 'streaming', 'structured-output'],
      }),
      { baseCapabilities: [] },
    );
    expect([...p.requiredModelCapabilities].sort()).toEqual([
      'reasoning',
      'streaming',
      'structuredOutput',
      'vision',
    ]);
  });

  it('records capabilities it has no rule for instead of dropping or guessing them', () => {
    const p = evaluateTask(
      makeTask('odd', { requiredCapabilities: ['code-edit', 'quantum-tuning'] }),
    );
    expect(p.unmappedCapabilities).toEqual(['quantum-tuning']);
    expect(p.reasons.join('\n')).toMatch(/no capability rule for "quantum-tuning"/);
  });
});
