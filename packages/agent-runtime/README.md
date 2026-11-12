# @soot/agent-runtime

> **Status: partial (Milestone 1 and Milestone 4 scope implemented).** There is **no real
> agent runner** (no model or harness calls). The only runner is `MockAgentRunner`, a test
> double.

## Scheduler

`new Scheduler(graph, options).run()` (or `runTaskGraph`) executes a `TaskGraph` from
`@soot/task-graph`:

- tasks whose prerequisites succeeded run concurrently, up to `concurrency` (default 4);
- dependents wait; a failed, blocked, or cancelled task skips its transitive dependents while
  unrelated tasks continue;
- every agent return value is validated against `AgentResultSchema`; invalid results,
  mismatched task ids or attempts, and runner crashes are failures;
- cancellation: abort `signal` or call `cancel()` for the whole run, `cancel(taskId)` for one
  task. The scheduler does not wait for runners that ignore the abort;
- resume: `completed` (results from an earlier run) are not re-run; `previousAttempts` keeps
  attempt numbering;
- `journal` receives each start and finish synchronously (see `@soot/context-manager`);
- the `RunReport` holds per-task outcomes with timestamps, the event log, and the peak
  observed concurrency.

### Supervised attempts (Milestone 4)

With a `supervisor` (`AttemptSupervisor`; `@soot/escalation` provides `AdaptiveSupervisor`):

- `plan` runs before every attempt and returns a model `assignment` or `stop` (the task fails
  with the reason);
- the runner receives the `assignment` and `priorAttempts` (summaries, structured findings,
  failure, and the supervisor's note from earlier attempts; never transcripts);
- each attempt becomes an `AttemptRecord`; thrown errors are classified (`classifyError`:
  rate-limited, unavailable, timeout, auth, invalid-output, crash);
- `review` returns accept, retry after `delayMs`, or fail. Retry timers hold no concurrency
  slot and are cleared on cancellation;
- `attemptTimeoutMs` aborts a hung attempt and records a timeout;
- `previousAttemptRecords` continues persisted history after a restart.

Without a supervisor the default `SINGLE_ATTEMPT` keeps the Milestone 1 behaviour.

`succeeded` means the agent reported success with a valid structured result. Checking
acceptance criteria against real evidence is Milestone 5.

Agents receive their task and their prerequisites' structured results, not the original
prompt.

## MockAgentRunner (test double)

Scripted outcomes per task and attempt (`succeed`, `fail`, `block`, `throw`, `invalid`,
`hang`, `provider-error`), optional `signals` and `findings`, `scriptFor(input)` for scripts
that depend on the assigned model, delays that honor abort, and a call log with timestamps,
assignments, and prior-attempt context. Its results are prefixed
`[mock]` and report `model: null`, `costUsd: null`.
