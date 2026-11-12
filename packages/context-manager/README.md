# @soot/context-manager

> **Status: partial (Milestone 1, 4 and 5 scope implemented).** Persisted execution state,
> model outcomes, and untrusted-content handling. Context selection arrives later.

## Untrusted content (Milestone 5)

`buildAgentContext` builds what a runner may show an agent: trusted task fields, permissions
taken only from the task (write set, no agent commands, approval mode), and untrusted blocks
(dependency results, prior attempts, tool output) fenced with `fenceUntrusted` and scanned by
`scanForInjection` (heuristic; flags are audited, never obeyed).

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

Schema v3 (Milestone 5) adds `model_outcomes`: soot's verdict (`verified` or `failed`) per
attempt with model and tier (`recordModelOutcome`, `modelOutcomes`), to feed routing history.

Schema v4 (ADR-030) adds `provider_cooldowns` (timed provider outages, through
`saveProviderCooldown` / `providerCooldowns`, used as a `ProviderHealthStore`) and
`attempt_spend` (per-attempt run-budget spend, reported actual or routed estimate, through
`spendLedger(runId)`), so a restarted run skips providers still cooling down and rebuilds its
budget. v1–v3 databases are migrated in place.

Only validated tasks, structured agent results, provider cooldowns and spend amounts are stored. Nothing free-form from agents
is persisted.
