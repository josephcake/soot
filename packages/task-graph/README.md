# @soot/task-graph

> **Status: partial (Milestone 1 scope implemented).** Contracts and the dependency graph.
> The scheduler that executes a graph lives in `@soot/agent-runtime`.

## Contracts

- `TaskSchema` / `parseTask` / `validateTask`: the task contract (id, title, instructions,
  acceptance criteria, required capabilities, complexity, token/cost estimate, files read and
  written, dependencies). Strict: unknown fields are rejected. Paths are project-relative POSIX
  paths; a trailing `/` declares a directory.
- `AgentResultSchema` / `parseAgentResult`: the only agent output the engine accepts (status,
  summary, findings, patch reference, evidence, reported usage). Strict and length-capped so
  free-form transcripts cannot enter shared state.
- JSON Schema (draft 2020-12) generated from the same validators: `taskJsonSchema()`,
  `agentResultJsonSchema()`, and committed copies in `schema/`. Regenerate with
  `pnpm --filter @soot/task-graph run schema`; a test fails if the copies are stale.
  Cross-field rules (no self-dependency, unique items, path segments) are enforced only by the
  runtime validators.

Invalid input throws `ContractValidationError`, whose message lists every issue by path.

## Dependency graph

`buildTaskGraph(tasks)` validates tasks and returns a `TaskGraph`:

- rejects duplicate ids, unknown dependencies, and cycles (`TaskGraphError` with the cycle);
- detects file conflicts (write/write, read/write, directory-aware) between tasks the planner
  left unordered and serializes them in declaration order with recorded `implicitEdges`;
- computes topological `layers` (tasks in one layer can run concurrently).

`reviseTaskGraph(graph, { add, replace, remove }, completedIds)` produces the next revision and
refuses to change or remove completed tasks. `readyTasks(graph, done)` lists runnable tasks.
