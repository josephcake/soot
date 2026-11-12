import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ExecutionJournal, TaskFinalState, TaskOutcome } from '@soot/agent-runtime';
import {
  parseAgentResult,
  parseTask,
  type AgentResult,
  type Task,
  type TaskGraph,
} from '@soot/task-graph';

/** File name of the state database inside `SOOT_DATA_DIR`. */
export const STATE_DB_FILE = 'soot.sqlite';
const SCHEMA_VERSION = 1;

/**
 * Per-task state as persisted. `running`: started with no recorded finish (the process may
 * have died). `interrupted`: a `running` attempt that `recoverInterrupted` closed on restart.
 */
export type PersistedTaskState = 'running' | 'interrupted' | TaskFinalState;

export interface PersistedAttempt {
  readonly taskId: string;
  /** 0 for tasks that ended without ever starting (cancelled or skipped). */
  readonly attempt: number;
  readonly state: PersistedTaskState;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly result: AgentResult | null;
  readonly error: string | null;
}

export interface PersistedRun {
  readonly runId: string;
  readonly createdAt: string;
  /** Exact original prompt (stored as UTF-8 bytes). */
  readonly originalPrompt: string;
  readonly promptSha256: string;
  readonly graphRevision: number;
  readonly tasks: readonly Task[];
  readonly attempts: readonly PersistedAttempt[];
  /** Latest succeeded result per task: pass as `completed` to the scheduler to resume. */
  readonly completed: ReadonlyMap<string, AgentResult>;
  /** Highest attempt number started per task: pass as `previousAttempts`. */
  readonly attemptCounts: ReadonlyMap<string, number>;
}

export interface CreateRunInput {
  readonly runId?: string;
  readonly intake: { readonly originalPrompt: string; readonly promptSha256: string };
  readonly graph: TaskGraph;
}

export interface OpenExecutionStoreOptions {
  /** Local-first state directory, normally `parseEnv(process.env).dataDir` (`SOOT_DATA_DIR`). */
  readonly dataDir: string;
  readonly now?: () => Date;
}

interface RunRow {
  created_at: string;
  original_prompt: Uint8Array;
  prompt_sha256: string;
  graph_revision: number;
  tasks_json: string;
}

interface AttemptRow {
  task_id: string;
  attempt: number;
  state: string;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  error: string | null;
}

/**
 * SQLite-backed execution state (task state machine, ADR-019) using Node's built-in
 * `node:sqlite`. Every write is a synchronous, committed statement, so state survives the
 * process being killed at any point. Only validated tasks and structured agent results are
 * stored; nothing free-form from agents is persisted.
 */
export class ExecutionStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(options: OpenExecutionStoreOptions) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.path = join(options.dataDir, STATE_DB_FILE);
    this.#now = options.now ?? (() => new Date());
    this.#db = new DatabaseSync(this.path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        original_prompt BLOB NOT NULL,
        prompt_sha256 TEXT NOT NULL,
        graph_revision INTEGER NOT NULL,
        tasks_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_attempts (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        result_json TEXT,
        error TEXT,
        PRIMARY KEY (run_id, task_id, attempt)
      );
    `);
    const version = this.#db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;
    if (version === undefined) {
      this.#db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(SCHEMA_VERSION));
    } else if (Number(version.value) !== SCHEMA_VERSION) {
      throw new Error(`Unsupported state schema version ${version.value} in ${this.path}`);
    }
  }

  close(): void {
    this.#db.close();
  }

  createRun(input: CreateRunInput): string {
    const runId = input.runId ?? randomUUID();
    this.#db
      .prepare(
        'INSERT INTO runs (run_id, created_at, original_prompt, prompt_sha256, graph_revision, tasks_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        runId,
        this.#now().toISOString(),
        Buffer.from(input.intake.originalPrompt, 'utf8'),
        input.intake.promptSha256,
        input.graph.revision,
        JSON.stringify(input.graph.tasks),
      );
    return runId;
  }

  /** Persist a revised graph for a run (see `reviseTaskGraph`). */
  saveGraph(runId: string, graph: TaskGraph): void {
    const changed = this.#db
      .prepare('UPDATE runs SET graph_revision = ?, tasks_json = ? WHERE run_id = ?')
      .run(graph.revision, JSON.stringify(graph.tasks), runId);
    if (Number(changed.changes) !== 1) throw new Error(`Unknown run "${runId}"`);
  }

  listRunIds(): string[] {
    return (
      this.#db.prepare('SELECT run_id FROM runs ORDER BY created_at, run_id').all() as {
        run_id: string;
      }[]
    ).map((r) => r.run_id);
  }

  /** A journal that records a run's task transitions as they happen. */
  journal(runId: string): ExecutionJournal {
    this.#requireRun(runId);
    const start = this.#db.prepare(
      `INSERT INTO task_attempts (run_id, task_id, attempt, state, started_at) VALUES (?, ?, ?, 'running', ?)`,
    );
    const finishStarted = this.#db.prepare(
      'UPDATE task_attempts SET state = ?, finished_at = ?, result_json = ?, error = ? WHERE run_id = ? AND task_id = ? AND attempt = ?',
    );
    const finishUnstarted = this.#db.prepare(
      `INSERT OR REPLACE INTO task_attempts (run_id, task_id, attempt, state, finished_at, error) VALUES (?, ?, 0, ?, ?, ?)`,
    );
    return {
      taskStarted: ({ taskId, attempt }) => {
        start.run(runId, taskId, attempt, this.#now().toISOString());
      },
      taskFinished: (outcome: TaskOutcome) => {
        const at = this.#now().toISOString();
        if (outcome.attempt === null) {
          finishUnstarted.run(runId, outcome.taskId, outcome.state, at, outcome.error);
          return;
        }
        const resultJson =
          outcome.result === null ? null : JSON.stringify(parseAgentResult(outcome.result));
        finishStarted.run(
          outcome.state,
          at,
          resultJson,
          outcome.error,
          runId,
          outcome.taskId,
          outcome.attempt,
        );
      },
    };
  }

  /**
   * Call on restart, before resuming: closes attempts left `running` by a dead process as
   * `interrupted` and returns their task ids. Those tasks will run again with a new attempt.
   */
  recoverInterrupted(runId: string): string[] {
    this.#requireRun(runId);
    const rows = this.#db
      .prepare(
        `UPDATE task_attempts SET state = 'interrupted', finished_at = ?, error = 'process exited before the attempt finished'
         WHERE run_id = ? AND state = 'running' RETURNING task_id`,
      )
      .all(this.#now().toISOString(), runId) as { task_id: string }[];
    return rows.map((r) => r.task_id).sort();
  }

  /** Load a run for inspection or resumption. Stored tasks and results are re-validated. */
  loadRun(runId: string): PersistedRun {
    const row = this.#requireRun(runId);
    const tasks = (JSON.parse(row.tasks_json) as unknown[]).map(parseTask);
    const rows = this.#db
      .prepare('SELECT * FROM task_attempts WHERE run_id = ? ORDER BY task_id, attempt')
      .all(runId) as unknown as AttemptRow[];
    const attempts = rows.map((r): PersistedAttempt => ({
      taskId: r.task_id,
      attempt: r.attempt,
      state: r.state as PersistedTaskState,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      result: r.result_json === null ? null : parseAgentResult(JSON.parse(r.result_json)),
      error: r.error,
    }));
    const completed = new Map<string, AgentResult>();
    const attemptCounts = new Map<string, number>();
    for (const a of attempts) {
      if (a.attempt > 0)
        attemptCounts.set(a.taskId, Math.max(a.attempt, attemptCounts.get(a.taskId) ?? 0));
      if (a.state === 'succeeded' && a.result !== null) completed.set(a.taskId, a.result);
    }
    return {
      runId,
      createdAt: row.created_at,
      originalPrompt: Buffer.from(row.original_prompt).toString('utf8'),
      promptSha256: row.prompt_sha256,
      graphRevision: row.graph_revision,
      tasks,
      attempts,
      completed,
      attemptCounts,
    };
  }

  #requireRun(runId: string): RunRow {
    const row = this.#db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    if (row === undefined) throw new Error(`Unknown run "${runId}"`);
    return row as unknown as RunRow;
  }
}

export function openExecutionStore(options: OpenExecutionStoreOptions): ExecutionStore {
  return new ExecutionStore(options);
}
