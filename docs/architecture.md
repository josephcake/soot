# Architecture and Repository Layout

> **Current state (Milestones 1–5):** integrations has the Milestone 5 scope (worktrees,
> soot-run validation, serial integration, reports); escalation has Milestone 4. task-graph, planner (fixture decomposer by default; a model-backed decomposer verified with mocks only, ADR-033, selectable in the CLI/MCP engine through `decomposer` in soot.config.json, ADR-034),
> agent-runtime (scheduler + mock runner), context-manager (SQLite state), and observability
> (cost records, routing log) have their Milestone 1 scope; model-registry and
> provider-adapters have the Milestone 2 mockable scope; model-router has Milestone 3. The rest of the design below is the _plan_ from
> [`specs/build-spec.md`](specs/build-spec.md) §14 and ADR-019; other packages are stubs.
> See [`../ROADMAP.md`](../ROADMAP.md).

## Milestone 1 data flow (implemented)

```text
prompt + context ─► planner.createPromptIntake ─► planner.FixtureDecomposer
                                                        │ tasks (TaskSchema)
                                                        ▼
                                         task-graph.buildTaskGraph (DAG, layers, conflicts)
                                                        │
                                                        ▼
       context-manager.ExecutionStore ◄─journal── agent-runtime.Scheduler ──► AgentRunner
       (soot.sqlite in SOOT_DATA_DIR)                   │                     (MockAgentRunner)
                                                        ▼
                                 RunReport + AgentResult (validated) ─► observability cost records
```

## Milestone 3 routing flow (implemented)

```text
tasks ─► model-router.evaluateTask (complexity, mandatory capabilities, risk; reasons)
           │
           ▼
   model-registry.select (capabilities, context, availability, DeepSeek restricted)
           │  + router checks (max output, price, cost cap, reliability known)
           ▼
   estimateCost (list prices → EstimatedUsd) + reliability (prior ⊕ history)
           │
           ▼
   policy (Economy / Balanced / Quality / Custom) ─► RoutingDecision per task
           │                                          (reason + every candidate)
           ▼
   observability.RoutingLog (text / JSON Lines)
```

`model-router` depends on `model-registry`, `observability`, and `task-graph`; it calls no model.

Package dependencies: `planner`, `agent-runtime`, and `observability` depend on `task-graph`;
`context-manager` depends on `task-graph` and (types only) `agent-runtime`. `task-graph` depends
only on `zod`. `core` has no workspace dependencies.

## Milestone 4 adaptive execution flow (implemented)

```text
Scheduler (agent-runtime) ── per task ──►  supervisor.plan(task, attempt, history, deps)
   │                                           │  AdaptiveSupervisor (escalation):
   │                                           │  first attempt: route (+ downgrade if a dep is planReady)
   │                                           │  later: nextStep(history) → retry-same / fallback / escalate
   │                                           │  budgets → run {assignment} | stop {reason}
   ▼                                           ▼
runner.run({task, assignment, priorAttempts, dependencyResults}, signal)   ← timeout aborts
   │
   ▼
validate result → AttemptRecord {assignment, result, failure} → supervisor.review
   │                                   accept │ retry {delayMs} (timer, no slot held) │ fail
   ▼
journal.attemptFinished → soot.sqlite attempt_details (resume replays the same decisions)
```

`escalation` depends on `agent-runtime` (types), `model-router`, `model-registry`
(`ProviderHealth`), `observability`, and `task-graph`. The scheduler does not depend on
`escalation`; the supervisor is injected.

## Milestone 5 codebase flow (implemented)

```text
runCodebaseWorkflow (integrations)
   │ open repo: refuse dirty tree, pin base, audit log → SOOT_DATA_DIR/audit/<run>.jsonl
   ▼
Scheduler (+ optional AdaptiveSupervisor) ── runner = IsolatedTaskRunner(inner)
   │  per attempt: lease write set → worktree soot/<run>/<task> from base (+ verified deps)
   │               context packet: trusted task + fenced untrusted data; permissions from task
   │               inner.run({workspace, permissions}) → commit → real diff
   │               out-of-scope / no-changes / deletion approval → soot-run checks (argv, allowlist,
   │               scrubbed env) → verified | failed-validation (→ supervisor retries/escalates)
   ▼
integrateSerially: merge-tree each verified task onto HEAD (dependency order); conflicts kept on branch
   ▼
final validation in a detached worktree → approval → fast-forward user's tree (else soot/<run>/integration)
   ▼
consolidated report (incomplete first, overlaps, integration, validation, cost) + model_outcomes → routing
```

## Milestone 7 IDE flow (partial, not run in a real editor)

```
VS Code / Cursor ──► apps/vscode-extension ──spawn──► node apps/cli/dist/bin.js <cmd> --json
   tree + board         (no @soot imports)              run | status <run> | cost <run> | stop <run> [--task id]
        ▲                                                       │
        └──────────── polls status (events.jsonl, attempts) ◄───┘
```

The extension holds no orchestration state; everything it shows comes from the engine's JSON
(ADR-029). Runs from the editor are unattended, so approvals are refused, never given.

## Design summary (planned)

A universal TypeScript orchestration core with thin adapters. The core never depends on a
particular IDE, harness, or provider.

```text
 host harness / IDE / CLI ──► harness-adapters ──► core orchestrator
                                                    │
     planner ─► task-graph ─► model-router ◄─ model-registry ◄─ provider-adapters (AI SDK, local)
                    │              │
                    ▼              ▼
             agent-runtime ◄── escalation        context-manager (per-task context, SQLite state)
                    │
                    ▼
             integrations (git worktrees, conflict detection, validation)
                    │
                    ▼
             observability (task-level cost, audit log, reports)
```

First-class concerns (per the spec's architectural warning): the task graph, execution state,
and file-conflict management.

## Repository layout (actual)

```text
/
├── README.md, LICENSE (MIT), CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
├── PROJECT_STATUS.md, ROADMAP.md, TASKS.md, DECISIONS.md     # project tracking
├── TECHNICAL_DEBT.md, FUTURE_FEATURES.md, CHANGELOG.md
├── package.json              # root scripts: build, typecheck, lint, format:check, test, ci
├── pnpm-workspace.yaml       # workspaces: apps/*, packages/*
├── pnpm-lock.yaml
├── tsconfig.base.json        # shared strict compiler options
├── tsconfig.json             # solution file: project references to every package (build)
├── tsconfig.typecheck.json   # no-emit typecheck of all sources + tests (also used by ESLint)
├── eslint.config.js          # ESLint flat config (typescript-eslint strict, type-checked)
├── .prettierrc.json          # Prettier config
├── vitest.config.ts          # one Vitest project per package + repo-level tests
├── .nvmrc, .npmrc            # Node pin (26), engine-strict
├── .env.example              # documented env vars, no secrets
├── .github/workflows/ci.yml  # hosted CI (GitHub Actions, Node 24 and 26)
├── scripts/ci.sh             # local CI, same steps as the workflow
├── apps/
│   ├── cli/                  # partial — `soot` CLI and SootEngine (M6)
│   ├── vscode-extension/     # partial — thin VS Code / Cursor view over the CLI (M7, ADR-029)
│   └── dashboard/            # optional local dashboard, `soot dashboard`, 127.0.0.1 only (ADR-031)
├── packages/
│   ├── core/                 # foundation: package metadata, SOOT_* env parsing, logger (real, tested)
│   ├── planner/              # prompt intake, fixture + model decomposers (M1, partial; model: mocks only)
│   ├── task-graph/           # task/result contracts + JSON Schema, dependency graph (M1, partial)
│   ├── model-registry/       # partial (M2) — user model config, availability, selection, sourced pricing
│   ├── model-router/         # partial (M3) — per-task routing, policies, explanations
│   ├── agent-runtime/        # scheduler, mock agent runner (M1, partial)
│   ├── context-manager/      # SQLite execution state (M1, partial); context selection later
│   ├── escalation/           # adaptive supervisor: triggers, escalation, bounds (M4)
│   ├── provider-adapters/    # partial (M2) — ModelClient over AI SDK; Anthropic, OpenAI, OpenAI-compatible
│   ├── harness-adapters/     # partial — OrchestrationService, MCP server, generic ACP runner (M6)
│   ├── integrations/         # partial (M5) — worktrees, validation, integration, reports
│   └── observability/        # cost records/reports (M1, M5), routing log (M3), audit log (M5)
├── docs/
│   ├── architecture.md       # this file
│   ├── configuration.md      # environment variables
│   ├── development.md        # package conventions, scripts
│   └── specs/                # original build + project-management specs (verbatim)
└── tests/
    ├── repo-structure.test.ts     # guards: build graph, docs, env secrets, CI parity
    ├── m1-end-to-end.test.ts      # Milestone 1 exit criteria, end to end (mock agents)
    ├── resume-after-kill.test.ts  # SIGKILL a run, resume from SQLite (builds packages first)
    └── fixtures/crash-child.mjs   # child process for the kill test
```

### Workspace packages

| Path                          | Status            | First real milestone | Responsibility                                        |
| ----------------------------- | ----------------- | -------------------- | ----------------------------------------------------- |
| `apps/cli/`                   | partial           | M6                   | `soot` CLI, SootEngine, config, skill installer       |
| `apps/vscode-extension/`      | partial (M7)      | M7                   | Editor view over the CLI; no orchestration            |
| `apps/dashboard/`             | optional          | — (ADR-031)          | Local read-only page + JSON API over status/cost      |
| `packages/core/`              | foundation (real) | M0                   | Package metadata, `parseEnv`, leveled logger          |
| `packages/planner/`           | partial (M1)      | M1                   | Prompt intake; fixture + model decomposers (mocks)    |
| `packages/task-graph/`        | partial (M1)      | M1                   | Task/result contracts, JSON Schema, DAG               |
| `packages/model-registry/`    | partial (M2)      | M2                   | User model config, availability, sourced pricing      |
| `packages/model-router/`      | partial (M3)      | M3                   | Per-task routing, cost/reliability policies           |
| `packages/agent-runtime/`     | partial (M1, M5)  | M1                   | Scheduler, attempts, approvals; MockAgentRunner       |
| `packages/context-manager/`   | partial (M1, M5)  | M1                   | SQLite state, outcomes; untrusted context             |
| `packages/escalation/`        | partial (M4)      | M4                   | Escalation, fallback, bounds, downgrade rules         |
| `packages/provider-adapters/` | partial (M2)      | M2                   | ModelClient over AI SDK; retries, fallback, keys      |
| `packages/harness-adapters/`  | partial           | M6                   | Service, MCP server, generic ACP runner (mock-tested) |
| `packages/integrations/`      | partial (M5)      | M5                   | Worktrees, conflict detection, validation             |
| `packages/observability/`     | partial (M1, M5)  | M1                   | Cost records/reports; routing log; audit log          |

### Planned directories not created yet

These appear in the spec's suggested layout but are intentionally absent until their milestone,
so the tree never implies support that does not exist:

- `extensions/{cursor,windsurf,kilo}/` — per-editor work, only if an editor needs more than `apps/vscode-extension` (M7-02…M7-04).
- `docs/{task-decomposition,harness-integrations,examples}.md` — written alongside the features they describe.

`skills/universal-orchestrator/` (installed by `soot install-skill`), `examples/demo-app/` (quick
start and M6 tests) and `docs/{installation,providers,model-routing,security}.md` now exist.

## Package conventions

Every workspace package:

- is ESM (`"type": "module"`), `private: true`, MIT;
- compiles `src/` → `dist/` with `tsc -b` as a `composite` project extending `tsconfig.base.json`;
- exports through `package.json#exports` (`types` + `import` pointing at `dist/`);
- keeps tests beside source as `src/**/*.test.ts` (excluded from `dist/`);
- can be built (`pnpm --filter <name> build`) and tested (`pnpm --filter <name> test`) on its own.

Cross-package imports use workspace dependencies (`workspace:*`) plus a tsconfig project
reference (see `apps/cli` → `packages/core`). Vitest and the typecheck config resolve
workspace packages to source, so tests never run against a stale `dist/`.
