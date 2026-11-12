import type { Task } from './task.js';

/** Build a valid task for tests; override any field. Not exported from the package index. */
export function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    instructions: `Do ${id}.`,
    acceptanceCriteria: [`${id} is done`],
    requiredCapabilities: ['code-edit'],
    complexity: 'low',
    estimate: { inputTokens: 1000, outputTokens: 200, costUsd: null },
    files: { read: [], write: [] },
    dependsOn: [],
    ...overrides,
  };
}
