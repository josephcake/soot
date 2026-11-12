import { describe, expect, it } from 'vitest';
import { makeTask } from './test-fixtures.js';
import { ContractValidationError, parseTask, validateTask } from './index.js';

const issuesOf = (input: unknown) => {
  const result = validateTask(input);
  if (result.ok) throw new Error('expected validation to fail');
  return result.issues;
};

describe('task schema (M1-01)', () => {
  it('accepts a complete task and returns it unchanged', () => {
    const task = makeTask('update-page-title', {
      files: { read: ['src/pages/'], write: ['src/pages/index.html'] },
      dependsOn: ['locate-page'],
      estimate: { inputTokens: 1200, outputTokens: 300, costUsd: 0.002 },
    });
    expect(parseTask(task)).toEqual(task);
  });

  it('rejects missing required fields and names each one', () => {
    const issues = issuesOf({ id: 'x' });
    const paths = issues.map((i) => i.path);
    for (const field of [
      'title',
      'instructions',
      'acceptanceCriteria',
      'requiredCapabilities',
      'complexity',
      'estimate',
      'files',
      'dependsOn',
    ]) {
      expect(paths).toContain(field);
    }
  });

  it('throws a readable error listing every issue', () => {
    expect(() =>
      parseTask({ ...makeTask('a'), complexity: 'trivial', acceptanceCriteria: [] }),
    ).toThrow(ContractValidationError);
    try {
      parseTask({ ...makeTask('a'), complexity: 'trivial', acceptanceCriteria: [] });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^Invalid task:/);
      expect(message).toContain('complexity');
      expect(message).toContain(
        'acceptanceCriteria: at least one acceptance criterion is required',
      );
    }
  });

  it.each([
    ['bad id', { id: 'Has Spaces' }, 'id'],
    ['blank instructions', { instructions: '   ' }, 'instructions'],
    [
      'negative tokens',
      { estimate: { inputTokens: -1, outputTokens: 0, costUsd: null } },
      'estimate.inputTokens',
    ],
    [
      'fractional tokens',
      { estimate: { inputTokens: 1.5, outputTokens: 0, costUsd: null } },
      'estimate.inputTokens',
    ],
    ['absolute path', { files: { read: ['/etc/passwd'], write: [] } }, 'files.read.0'],
    ['parent traversal', { files: { read: [], write: ['src/../secrets'] } }, 'files.write.0'],
    ['backslash path', { files: { read: [], write: ['src\\a.ts'] } }, 'files.write.0'],
    ['duplicate writes', { files: { read: [], write: ['a.ts', 'a.ts'] } }, 'files.write'],
    ['self dependency', { dependsOn: ['a'] }, 'dependsOn'],
    ['duplicate dependency', { dependsOn: ['b', 'b'] }, 'dependsOn'],
    ['no capabilities', { requiredCapabilities: [] }, 'requiredCapabilities'],
    ['bad capability', { requiredCapabilities: ['Code Edit'] }, 'requiredCapabilities.0'],
  ])('rejects %s', (_name, override, path) => {
    const issues = issuesOf({ ...makeTask('a'), ...override });
    expect(issues.map((i) => i.path)).toContain(path);
  });

  it('rejects unknown fields so the contract cannot silently grow', () => {
    const issues = issuesOf({ ...makeTask('a'), model: 'gpt-x' });
    expect(issues[0]?.message).toMatch(/model/);
  });

  it('accepts a directory declaration with a trailing slash', () => {
    expect(validateTask(makeTask('a', { files: { read: ['src/'], write: [] } })).ok).toBe(true);
  });
});
