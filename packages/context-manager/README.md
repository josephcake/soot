# @soot/context-manager

> **Status: partial (Milestone 1 and Milestone 4 scope implemented).** Persisted execution
> state only.
> Per-task context selection arrives in later milestones.

## Execution state

`openExecutionStore({ dataDir })` opens (creating if needed) `soot.sqlite` in the state
directory, normally `parseEnv(process.env).dataDir` (`SOOT_DATA_DIR`, default `~/.soot`). It
uses Node's built-in `node:sqlite` (ADR-019, ADR-021), WAL mode, and `synchronous = FULL`.

- `createRun({ intake, graph })` stores the exact original prompt (as UTF-8 bytes) and the
  validated tasks; `saveGraph` stores a revision.
- `journal(runId)` is an `ExecutionJournal` for the `@soot/agent-runtime` scheduler: every task
  start and finish is committed synchronously, so state survives the process being killed.
- `recoverInterrupted(runId)` marks attempts a dead process left `running` as `interrupted`.
- `loadRun(runId)` re-validates stored tasks and results and returns `completed` and
  `attemptCounts` to pass to the scheduler, which then skips completed tasks.

Schema v2 (Milestone 4) adds `attempt_details`: each attempt's model assignment, classified
failure, and supervisor review. A v1 database is migrated in place; unknown versions are
refused. Attempts the supervisor retried are stored as `retried`, and `loadRun` returns
`attemptRecords` to pass as `previousAttemptRecords`, so retry limits, budgets, and context
transfer continue after a restart.

Only validated tasks and structured agent results are stored. Nothing free-form from agents
is persisted.
