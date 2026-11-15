import { describe, expect, it } from 'vitest';
import { acceptanceForTask } from './runner.js';
import type { CheckCommand } from './commands.js';

const specific: CheckCommand = {
  name: 'acceptance:title',
  kind: 'acceptance',
  argv: ['node', '--test', 'acceptance/title.test.ts'],
};
const fallback: CheckCommand = {
  name: 'acceptance:generic',
  kind: 'acceptance',
  argv: ['node', '--test', 'tests'],
};

describe('acceptanceForTask (ADR-057)', () => {
  it('returns the per-id list when the task id is listed, and does not also add "*"', () => {
    const acceptance = { 'update-page-title': [specific], '*': [fallback] };
    expect(acceptanceForTask('update-page-title', acceptance)).toEqual([specific]);
  });

  it('returns the "*" list when the task id has no entry, including model-invented ids', () => {
    const acceptance = { 'update-page-title': [specific], '*': [fallback] };
    expect(acceptanceForTask('update-greeting-string', acceptance)).toEqual([fallback]);
  });

  it('returns an empty list when there is no match and no "*"', () => {
    expect(
      acceptanceForTask('update-greeting-string', { 'update-page-title': [specific] }),
    ).toEqual([]);
    expect(acceptanceForTask('update-greeting-string', {})).toEqual([]);
    expect(acceptanceForTask('update-greeting-string', undefined)).toEqual([]);
  });
});
