import { describe, expect, it } from 'vitest';
import { makeTask } from './test-fixtures.js';
import {
  ContractValidationError,
  TaskGraphError,
  buildTaskGraph,
  pathsOverlap,
  readyTasks,
  reviseTaskGraph,
} from './index.js';

const graphError = (fn: () => unknown): TaskGraphError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof TaskGraphError) return error;
    throw error;
  }
  throw new Error('expected TaskGraphError');
};

describe('dependency graph (M1-04)', () => {
  it('builds topological layers from declared dependencies', () => {
    const graph = buildTaskGraph([
      makeTask('implement'),
      makeTask('tests', { dependsOn: ['implement'] }),
      makeTask('review', { dependsOn: ['implement'] }),
      makeTask('docs'),
      makeTask('release', { dependsOn: ['tests', 'review'] }),
    ]);
    expect(graph.revision).toBe(1);
    expect(graph.layers).toEqual([['implement', 'docs'], ['tests', 'review'], ['release']]);
    expect(graph.dependents.get('implement')).toEqual(['tests', 'review']);
    expect(graph.prerequisites.get('release')).toEqual(['tests', 'review']);
    expect(graph.implicitEdges).toEqual([]);
  });

  it('puts independent tasks in one layer', () => {
    const graph = buildTaskGraph([makeTask('a'), makeTask('b'), makeTask('c')]);
    expect(graph.layers).toEqual([['a', 'b', 'c']]);
  });

  it('detects a cycle and reports it in order', () => {
    const error = graphError(() =>
      buildTaskGraph([
        makeTask('a', { dependsOn: ['c'] }),
        makeTask('b', { dependsOn: ['a'] }),
        makeTask('c', { dependsOn: ['b'] }),
        makeTask('d'),
      ]),
    );
    expect(error.code).toBe('cycle');
    expect(error.taskIds).toHaveLength(4);
    expect(error.taskIds[0]).toBe(error.taskIds[3]);
    expect(new Set(error.taskIds)).toEqual(new Set(['a', 'b', 'c']));
    expect(error.message).toMatch(/^Dependency cycle: \w -> \w -> \w -> \w$/);
    // Each arrow points prerequisite -> dependent.
    const deps: Record<string, string> = { a: 'c', b: 'a', c: 'b' };
    for (let i = 0; i < 3; i++) expect(deps[error.taskIds[i + 1] ?? '']).toBe(error.taskIds[i]);
  });

  it('rejects duplicate ids, unknown dependencies, and invalid tasks', () => {
    expect(graphError(() => buildTaskGraph([makeTask('a'), makeTask('a')])).code).toBe(
      'duplicate-task-id',
    );
    expect(graphError(() => buildTaskGraph([makeTask('a', { dependsOn: ['ghost'] })])).code).toBe(
      'unknown-dependency',
    );
    expect(() => buildTaskGraph([{ id: 'a' }])).toThrow(ContractValidationError);
  });

  describe('write-conflict detection', () => {
    it('serializes unordered tasks that write the same file, in declaration order', () => {
      const graph = buildTaskGraph([
        makeTask('title', { files: { read: [], write: ['src/App.tsx'] } }),
        makeTask('button', { files: { read: [], write: ['src/App.tsx', 'src/button.css'] } }),
        makeTask('auth', { files: { read: ['src/auth/'], write: [] } }),
      ]);
      expect(graph.conflicts).toEqual([
        { first: 'title', second: 'button', kind: 'write-write', paths: ['src/App.tsx'] },
      ]);
      expect(graph.implicitEdges.map((e) => [e.from, e.to])).toEqual([['title', 'button']]);
      expect(graph.layers).toEqual([['title', 'auth'], ['button']]);
    });

    it('serializes a reader behind a writer of the same path (directory overlap)', () => {
      const graph = buildTaskGraph([
        makeTask('investigate', { files: { read: ['src/auth/'], write: [] } }),
        makeTask('fix', { files: { read: [], write: ['src/auth/session.ts'] } }),
      ]);
      expect(graph.conflicts[0]?.kind).toBe('read-write');
      expect(graph.layers).toEqual([['investigate'], ['fix']]);
    });

    it('does not add edges when tasks are already ordered or only read', () => {
      const graph = buildTaskGraph([
        makeTask('a', { files: { read: ['x.ts'], write: ['y.ts'] } }),
        makeTask('b', { files: { read: ['x.ts'], write: ['y.ts'] }, dependsOn: ['a'] }),
        makeTask('c', { files: { read: ['x.ts'], write: [] } }),
      ]);
      expect(graph.implicitEdges).toEqual([]);
      expect(graph.layers).toEqual([['a', 'c'], ['b']]);
    });

    it('never lets two tasks with conflicting writes share a layer', () => {
      const tasks = Array.from({ length: 6 }, (_, i) =>
        makeTask(`t${i}`, {
          files: { read: [], write: [i % 2 === 0 ? 'shared.ts' : `own${i}.ts`] },
        }),
      );
      const graph = buildTaskGraph(tasks);
      for (const layer of graph.layers) {
        expect(layer.filter((id) => Number(id.slice(1)) % 2 === 0).length).toBeLessThanOrEqual(1);
      }
    });

    it('path overlap respects directory markers', () => {
      expect(pathsOverlap('src/', 'src/a.ts')).toBe(true);
      expect(pathsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
      expect(pathsOverlap('src', 'src/a.ts')).toBe(false);
      expect(pathsOverlap('src/a.ts', 'src/a.tsx')).toBe(false);
    });
  });

  describe('graph revision', () => {
    const base = () =>
      buildTaskGraph([
        makeTask('a'),
        makeTask('b', { dependsOn: ['a'] }),
        makeTask('c', { dependsOn: ['a'] }),
      ]);

    it('adds and replaces pending tasks while keeping completed tasks identical', () => {
      const graph = base();
      const revised = reviseTaskGraph(
        graph,
        {
          replace: [makeTask('c', { dependsOn: ['a'], instructions: 'Do c differently.' })],
          add: [makeTask('d', { dependsOn: ['b', 'c'] })],
        },
        new Set(['a', 'b']),
      );
      expect(revised.revision).toBe(2);
      expect(revised.tasks.find((t) => t.id === 'a')).toEqual(graph.tasks[0]);
      expect(revised.tasks.find((t) => t.id === 'b')).toEqual(graph.tasks[1]);
      expect(revised.tasks.find((t) => t.id === 'c')?.instructions).toBe('Do c differently.');
      expect(revised.layers).toEqual([['a'], ['b', 'c'], ['d']]);
    });

    it('refuses to replace or remove a completed task', () => {
      const graph = base();
      const done = new Set(['a']);
      expect(graphError(() => reviseTaskGraph(graph, { remove: ['a'] }, done)).code).toBe(
        'completed-task-changed',
      );
      expect(
        graphError(() => reviseTaskGraph(graph, { replace: [makeTask('a')] }, done)).code,
      ).toBe('completed-task-changed');
    });

    it('re-validates the revised graph', () => {
      const graph = base();
      expect(
        graphError(() =>
          reviseTaskGraph(
            graph,
            {
              replace: [makeTask('b', { dependsOn: ['a', 'e'] })],
              add: [makeTask('e', { dependsOn: ['b'] })],
            },
            new Set(),
          ),
        ).code,
      ).toBe('cycle');
      expect(graphError(() => reviseTaskGraph(graph, { remove: ['zzz'] }, new Set())).code).toBe(
        'unknown-task',
      );
    });
  });

  it('readyTasks returns tasks whose prerequisites are done', () => {
    const graph = base2();
    expect(readyTasks(graph, new Set()).map((t) => t.id)).toEqual(['a', 'x']);
    expect(readyTasks(graph, new Set(['a']), new Set(['x'])).map((t) => t.id)).toEqual(['b']);
  });
});

function base2() {
  return buildTaskGraph([makeTask('a'), makeTask('b', { dependsOn: ['a'] }), makeTask('x')]);
}
