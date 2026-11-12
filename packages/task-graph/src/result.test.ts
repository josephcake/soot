import { describe, expect, it } from 'vitest';
import {
  RESULT_TEXT_LIMIT,
  parseAgentResult,
  validateAgentResult,
  type AgentResult,
} from './index.js';

const result = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  taskId: 'update-button-color',
  attempt: 1,
  status: 'succeeded',
  summary: 'Primary button now uses the purple token.',
  findings: [
    {
      kind: 'observation',
      message: 'Color comes from a CSS variable.',
      files: ['src/styles/button.css'],
    },
  ],
  patch: {
    format: 'unified-diff',
    ref: 'patches/update-button-color.1.diff',
    filesChanged: ['src/styles/button.css'],
  },
  evidence: [{ kind: 'test', description: 'button.test.ts', passed: true }],
  usage: { inputTokens: 900, outputTokens: 120, durationMs: 1500, costUsd: null, model: null },
  ...overrides,
});

describe('agent result schema (M1-06)', () => {
  it('accepts a structured result', () => {
    expect(parseAgentResult(result())).toEqual(result());
  });

  it('accepts a failed result without a patch', () => {
    expect(validateAgentResult(result({ status: 'failed', patch: null, evidence: [] })).ok).toBe(
      true,
    );
  });

  it.each(['transcript', 'messages', 'conversation'])('rejects a free-form `%s` field', (field) => {
    const check = validateAgentResult({
      ...result(),
      [field]: [{ role: 'assistant', content: '...' }],
    });
    expect(check.ok).toBe(false);
  });

  it('caps text so whole conversations cannot be stored as a summary or finding', () => {
    const huge = 'x'.repeat(RESULT_TEXT_LIMIT + 1);
    expect(validateAgentResult(result({ summary: huge })).ok).toBe(false);
    expect(validateAgentResult(result({ findings: [{ kind: 'issue', message: huge }] })).ok).toBe(
      false,
    );
  });

  it('rejects unknown statuses, attempt 0, and missing usage', () => {
    expect(validateAgentResult({ ...result(), status: 'done' }).ok).toBe(false);
    expect(validateAgentResult(result({ attempt: 0 })).ok).toBe(false);
    const noUsage: Partial<AgentResult> = result();
    delete noUsage.usage;
    const check = validateAgentResult(noUsage);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.issues.map((i) => i.path)).toContain('usage');
  });

  it('throws with a clear message', () => {
    expect(() => parseAgentResult({ ...result(), evidence: [{ kind: 'vibes' }] })).toThrow(
      /^Invalid agent result:/,
    );
  });
});
