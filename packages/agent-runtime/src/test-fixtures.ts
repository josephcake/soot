import { buildTaskGraph, type Task, type TaskGraph } from '@soot/task-graph';

/** Test helper: valid task with optional dependencies and written files. */
export function task(id: string, dependsOn: string[] = [], write: string[] = []): Task {
  return {
    id,
    title: `Task ${id}`,
    instructions: `Do ${id}.`,
    acceptanceCriteria: [`${id} is done`],
    requiredCapabilities: ['code-edit'],
    complexity: 'low',
    estimate: { inputTokens: 100, outputTokens: 10, costUsd: null },
    files: { read: [], write },
    dependsOn,
  };
}

export function graphOf(...tasks: Task[]): TaskGraph {
  return buildTaskGraph(tasks);
}
