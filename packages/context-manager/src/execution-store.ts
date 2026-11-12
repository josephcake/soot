import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Assignment,
  AttemptFailure,
  AttemptRecord,
  ExecutionJournal,
  ReviewDecision,
  TaskFinalState,
  TaskOutcome,
} from '@soot/agent-runtime';
import {
  ComplexitySchema,
  parseAgentResult,
  parseTask,
  type AgentResult,
  type Complexity,
  type Task,
  type TaskGraph,
} from '@soot/task-graph';

/** File name of the state database inside `SOOT_DATA_DIR`. */
export const STATE_DB_FILE = 'soot.sqlite';
/**
 * v2 (Milestone 4) adds `attempt_details`; v3 (Milestone 5) adds `model_outcomes`. Older
 * databases are migrated in place (both changes only add tables).
 */
const SCHEMA_VERSION = 3;

/**
 * Per-attempt state as persisted. `running`: started with no recorded finish (the process may
 * have died). `interrupted`: a `running` attempt that `recoverInterrupted` closed on restart.
 * `retried`: the attempt ended and the supervisor scheduled another attempt (Milestone 4).
 */
export type PersistedTaskState = 'running' | 'interrupted' | 'retried' | TaskFinalState;

export interface PersistedAttempt {
  readonly taskId: string;
  /** 0 for tasks that ended without ever starting (cancelled or skipped). */
  readonly attempt: number;
  readonly state: PersistedTaskState;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly result: AgentResult | null;
  readonly error: string | null;
  /** Model assignment, failure, and review (Milestone 4); `null` for unreviewed attempts. */
  readonly assignment: Assignment | null;
  readonly failure: AttemptFailure | null;
  readonly review: ReviewDecision | null;
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
  /**
   * Reviewed attempts per task, oldest first: pass as `previousAttemptRecords` so retry and
   * escalation limits, budgets, and context transfer continue across restarts.
   */
  readonly attemptRecords: ReadonlyMap<string, readonly AttemptRecord[]>;
}

export interface ModelOutcome {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly model: string;
  /** Complexity tier the model was routed at. */
  readonly tier: Complexity;
  readonly outcome: 'verified' | 'failed';
  readonly reason: string;
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
  assignment_json: string | null;
  failure_json: string | null;
  review_json: string | null;
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
      CREATE TABLE IF NOT EXISTS attempt_details (
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        assignment_json TEXT,
        failure_json TEXT,
        review_json TEXT,
        PRIMARY KEY (run_id, task_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS model_outcomes (
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        model TEXT NOT NULL,
        tier TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
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
    } else if (Number(version.value) === 1 || Number(version.value) === 2) {
      // v1/v2 → v3: the only changes are new tables, created above.
      this.#db
        .prepare('UPDATE meta SET value = ? WHERE key = ?')
        .run(String(SCHEMA_VERSION), 'schema_version');
    } else if (Number(version.value) !== SCHEMA_VERSION) {
      throw new Error(`Unsupported state schema version ${version.value} in ${this.path}`);
    }
  }

  /**
   * Record a model's outcome on a task attempt as soot judged it (Milestone 5, M5-07):
   * `verified` only from soot's own evidence; `failed` when the agent failed or soot's
   * validation failed. Outcomes that say nothing about the model (blocked, cancelled, provider
   * errors) should not be recorded. Kept across runs: outcome history feeds later routing.
   */
  recordModelOutcome(outcome: ModelOutcome): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO model_outcomes
           (run_id, task_id, attempt, model, tier, outcome, reason, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.runId,
        outcome.taskId,
        outcome.attempt,
        outcome.model,
        outcome.tier,
        outcome.outcome,
        outcome.reason,
        this.#now().toISOString(),
      );
  }

  /** All recorded model outcomes, oldest first. */
  modelOutcomes(): ModelOutcome[] {
    const rows = this.#db
      .prepare(
        `SELECT run_id, task_id, attempt, model, tier, outcome, reason FROM model_outcomes
         ORDER BY recorded_at, run_id, task_id, attempt`,
      )
      .all() as {
      run_id: string;
      task_id: string;
      attempt: number;
      model: string;
      tier: string;
      outcome: string;
      reason: string;
    }[];
    return rows.map((r) => ({
      runId: r.run_id,
      taskId: r.task_id,
      attempt: r.attempt,
      model: r.model,
      tier: ComplexitySchema.parse(r.tier),
      outcome: r.outcome === 'verified' ? 'verified' : 'failed',
      reason: r.reason,
    }));
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
    const details = this.#db.prepare(
      'INSERT OR REPLACE INTO attempt_details (run_id, task_id, attempt, assignment_json, failure_json, review_json) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const finishAttempt = this.#db.prepare(
      'UPDATE task_attempts SET state = ?, finished_at = ?, result_json = ?, error = ? WHERE run_id = ? AND task_id = ? AND attempt = ?',
    );
    const json = (value: unknown) =>
      value === null || value === undefined ? null : JSON.stringify(value);
    return {
      taskStarted: ({ taskId, attempt, assignment }) => {
        start.run(runId, taskId, attempt, this.#now().toISOString());
        details.run(runId, taskId, attempt, json(assignment), null, null);
      },
      attemptFinished: (record: AttemptRecord) => {
        details.run(
          runId,
          record.taskId,
          record.attempt,
          json(record.assignment),
          json(record.failure),
          json(record.review),
        );
        if (record.review?.action === 'retry') {
          finishAttempt.run(
            'retried',
            this.#now().toISOString(),
            record.result === null ? null : JSON.stringify(parseAgentResult(record.result)),
            record.failure?.message ?? null,
            runId,
            record.taskId,
            record.attempt,
          );
        }
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
      .prepare(
        `SELECT a.*, d.assignment_json, d.failure_json, d.review_json FROM task_attempts a
         LEFT JOIN attempt_details d USING (run_id, task_id, attempt)
         WHERE a.run_id = ? ORDER BY a.task_id, a.attempt`,
      )
      .all(runId) as unknown as AttemptRow[];
    const attempts = rows.map((r): PersistedAttempt => ({
      taskId: r.task_id,
      attempt: r.attempt,
      state: r.state as PersistedTaskState,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      result: r.result_json === null ? null : parseAgentResult(JSON.parse(r.result_json)),
      error: r.error,
      assignment: r.assignment_json === null ? null : (JSON.parse(r.assignment_json) as Assignment),
      failure: r.failure_json === null ? null : (JSON.parse(r.failure_json) as AttemptFailure),
      review: r.review_json === null ? null : (JSON.parse(r.review_json) as ReviewDecision),
    }));
    const attemptRecords = new Map<string, AttemptRecord[]>();
    for (const a of attempts) {
      if (a.review === null) continue; // only reviewed attempts count towards limits and context
      const list = attemptRecords.get(a.taskId) ?? [];
      list.push({
        taskId: a.taskId,
        attempt: a.attempt,
        assignment: a.assignment,
        result: a.result,
        failure: a.failure,
        review: a.review,
        // Monotonic timestamps do not survive a restart.
        startedAt: null,
        finishedAt: null,
      });
      attemptRecords.set(a.taskId, list);
    }
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
      attemptRecords,
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
