import { parseTask, type Task } from './task.js';

/** Why a graph could not be built or revised. */
export type TaskGraphErrorCode =
  'duplicate-task-id' | 'unknown-dependency' | 'cycle' | 'completed-task-changed' | 'unknown-task';

export class TaskGraphError extends Error {
  readonly code: TaskGraphErrorCode;
  /** Task ids involved; for `cycle`, the cycle in order with the first id repeated at the end. */
  readonly taskIds: readonly string[];

  constructor(code: TaskGraphErrorCode, message: string, taskIds: readonly string[]) {
    super(message);
    this.name = 'TaskGraphError';
    this.code = code;
    this.taskIds = taskIds;
  }
}

/** Two unordered tasks that declare overlapping files, at least one of them as a write. */
export interface FileConflict {
  readonly first: string;
  readonly second: string;
  readonly kind: 'write-write' | 'read-write';
  readonly paths: readonly string[];
}

/** An ordering edge the engine added (not declared by the planner). */
export interface ImplicitEdge {
  readonly from: string;
  readonly to: string;
  readonly reason: FileConflict;
}

export interface TaskGraph {
  /** Increments on every revision; the first graph is revision 1. */
  readonly revision: number;
  /** Tasks in declaration order. */
  readonly tasks: readonly Task[];
  /** Every prerequisite of each task: declared `dependsOn` plus implicit edges. */
  readonly prerequisites: ReadonlyMap<string, readonly string[]>;
  /** Inverse of `prerequisites`. */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
  /** Edges added to serialize conflicting file access. */
  readonly implicitEdges: readonly ImplicitEdge[];
  /** Conflicts found between tasks the planner left unordered (each one produced an implicit edge). */
  readonly conflicts: readonly FileConflict[];
  /** Topological layers: every task in layer n depends only on tasks in layers < n. */
  readonly layers: readonly (readonly string[])[];
}

const isDir = (p: string) => p.endsWith('/');

/** True when two declared paths can refer to the same file (directories end with `/`). */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (isDir(a) && b.startsWith(a)) return true;
  if (isDir(b) && a.startsWith(b)) return true;
  return false;
}

function overlapping(left: readonly string[], right: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const a of left)
    for (const b of right) if (pathsOverlap(a, b)) hits.add(a.length >= b.length ? a : b);
  return [...hits].sort();
}

/** Conflict between two tasks' declared files, or `undefined` if they can safely run together. */
export function fileConflict(a: Task, b: Task): FileConflict | undefined {
  const ww = overlapping(a.files.write, b.files.write);
  if (ww.length > 0) return { first: a.id, second: b.id, kind: 'write-write', paths: ww };
  const rw = [
    ...overlapping(a.files.read, b.files.write),
    ...overlapping(a.files.write, b.files.read),
  ];
  if (rw.length > 0) {
    return { first: a.id, second: b.id, kind: 'read-write', paths: [...new Set(rw)].sort() };
  }
  return undefined;
}

function findCycle(
  ids: readonly string[],
  prereqs: ReadonlyMap<string, readonly string[]>,
): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of prereqs.get(id) ?? []) {
      const s = state.get(dep);
      if (s === 'visiting') return [...stack.slice(stack.indexOf(dep)), dep];
      if (s === undefined) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const id of ids) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found.reverse(); // report in execution order: prerequisite -> dependent
  }
  return undefined;
}

function reaches(
  from: string,
  to: string,
  prereqs: ReadonlyMap<string, readonly string[]>,
): boolean {
  // Is `from` a (transitive) prerequisite of `to`?
  const seen = new Set<string>();
  const queue = [...(prereqs.get(to) ?? [])];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(prereqs.get(id) ?? []));
  }
  return false;
}

function computeLayers(
  ids: readonly string[],
  prereqs: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const d = Math.max(-1, ...(prereqs.get(id) ?? []).map(depthOf)) + 1;
    depth.set(id, d);
    return d;
  };
  const layers: string[][] = [];
  for (const id of ids) (layers[depthOf(id)] ??= []).push(id);
  return layers;
}

/**
 * Validate tasks and build an acyclic dependency graph.
 *
 * Tasks the planner left unordered but whose declared files conflict (write/write or
 * read/write) are serialized in declaration order with an implicit edge, so no two
 * concurrently running tasks ever hold conflicting access to the same path.
 */
export function buildTaskGraph(input: readonly unknown[], revision = 1): TaskGraph {
  const tasks = input.map(parseTask);
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      throw new TaskGraphError('duplicate-task-id', `Duplicate task id "${task.id}"`, [task.id]);
    }
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!byId.has(dep)) {
        throw new TaskGraphError(
          'unknown-dependency',
          `Task "${task.id}" depends on unknown task "${dep}"`,
          [task.id, dep],
        );
      }
    }
  }

  const ids = tasks.map((t) => t.id);
  const prereqs = new Map<string, string[]>(tasks.map((t) => [t.id, [...t.dependsOn]]));
  const cycle = findCycle(ids, prereqs);
  if (cycle) {
    throw new TaskGraphError('cycle', `Dependency cycle: ${cycle.join(' -> ')}`, cycle);
  }

  // Serialize conflicting, otherwise-unordered pairs. Edges always point from the earlier
  // declared task to the later one and are only added when the pair is still unordered,
  // so they can never introduce a cycle.
  const conflicts: FileConflict[] = [];
  const implicitEdges: ImplicitEdge[] = [];
  for (const [i, a] of tasks.entries()) {
    for (const b of tasks.slice(i + 1)) {
      const conflict = fileConflict(a, b);
      if (!conflict) continue;
      if (reaches(a.id, b.id, prereqs) || reaches(b.id, a.id, prereqs)) continue;
      conflicts.push(conflict);
      implicitEdges.push({ from: a.id, to: b.id, reason: conflict });
      prereqs.get(b.id)?.push(a.id);
    }
  }

  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [id, deps] of prereqs) for (const dep of deps) dependents.get(dep)?.push(id);

  return {
    revision,
    tasks,
    prerequisites: prereqs,
    dependents,
    implicitEdges,
    conflicts,
    layers: computeLayers(ids, prereqs),
  };
}

/** Changes to apply to a graph when new information emerges. */
export interface GraphRevision {
  /** New tasks to add. */
  readonly add?: readonly unknown[];
  /** Replacement definitions for existing, not-yet-completed tasks (matched by id). */
  readonly replace?: readonly unknown[];
  /** Ids of not-yet-completed tasks to drop. */
  readonly remove?: readonly string[];
}

/**
 * Produce the next revision of a graph. Completed tasks are kept exactly as they were:
 * replacing or removing one throws `completed-task-changed`. The result is re-validated
 * (ids, dependencies, cycles, conflicts) like a fresh graph.
 */
export function reviseTaskGraph(
  graph: TaskGraph,
  revision: GraphRevision,
  completedTaskIds: ReadonlySet<string>,
): TaskGraph {
  const existing = new Set(graph.tasks.map((t) => t.id));
  const replacements = new Map((revision.replace ?? []).map(parseTask).map((t) => [t.id, t]));
  const removals = new Set(revision.remove ?? []);

  for (const id of [...replacements.keys(), ...removals]) {
    if (!existing.has(id)) {
      throw new TaskGraphError('unknown-task', `Cannot revise unknown task "${id}"`, [id]);
    }
    if (completedTaskIds.has(id)) {
      throw new TaskGraphError(
        'completed-task-changed',
        `Task "${id}" is completed and cannot be replaced or removed`,
        [id],
      );
    }
  }

  const kept = graph.tasks
    .filter((t) => !removals.has(t.id))
    .map((t) => replacements.get(t.id) ?? t);
  return buildTaskGraph([...kept, ...(revision.add ?? [])], graph.revision + 1);
}

/** Tasks whose prerequisites are all in `done` and that are not themselves done or excluded. */
export function readyTasks(
  graph: TaskGraph,
  done: ReadonlySet<string>,
  exclude: ReadonlySet<string> = new Set(),
): Task[] {
  return graph.tasks.filter(
    (t) =>
      !done.has(t.id) &&
      !exclude.has(t.id) &&
      (graph.prerequisites.get(t.id) ?? []).every((dep) => done.has(dep)),
  );
}
