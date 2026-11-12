# Architecture and Repository Layout

> **Current state (Milestones 1–3):** task-graph, planner (fixture decomposer only),
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
├── .github/workflows/ci.yml  # hosted CI (not yet running: repo unpublished)
├── scripts/ci.sh             # local CI, same steps as the workflow
├── apps/
│   └── cli/                  # stub — future `orchestrator` CLI (M6); depends on core
├── packages/
│   ├── core/                 # foundation: package metadata + SOOT_* env parsing (real, tested)
│   ├── planner/              # prompt intake, fixture decomposer (M1, partial)
│   ├── task-graph/           # task/result contracts + JSON Schema, dependency graph (M1, partial)
│   ├── model-registry/       # partial (M2) — user model config, availability, selection, sourced pricing
│   ├── model-router/         # partial (M3) — per-task routing, policies, explanations
│   ├── agent-runtime/        # scheduler, mock agent runner (M1, partial)
│   ├── context-manager/      # SQLite execution state (M1, partial); context selection later
│   ├── escalation/           # stub — escalation/downgrade rules (M4)
│   ├── provider-adapters/    # partial (M2) — ModelClient over AI SDK; Anthropic, OpenAI, OpenAI-compatible
│   ├── harness-adapters/     # stub — Claude Code, Codex, MCP, etc. (M6)
│   ├── integrations/         # stub — worktrees, conflict detection, validation (M5)
│   └── observability/        # cost records (M1), routing explanation log (M3); audit log later
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

| Path                          | Status            | First real milestone | Responsibility                                   |
| ----------------------------- | ----------------- | -------------------- | ------------------------------------------------ |
| `apps/cli/`                   | stub              | M6                   | Future `orchestrator` CLI; depends on core       |
| `packages/core/`              | foundation (real) | M0                   | Package metadata, `parseEnv` for `SOOT_*` vars   |
| `packages/planner/`           | partial (M1)      | M1                   | Prompt intake; fixture decomposer (no model yet) |
| `packages/task-graph/`        | partial (M1)      | M1                   | Task/result contracts, JSON Schema, DAG          |
| `packages/model-registry/`    | partial (M2)      | M2                   | User model config, availability, sourced pricing |
| `packages/model-router/`      | partial (M3)      | M3                   | Per-task routing, cost/reliability policies      |
| `packages/agent-runtime/`     | partial (M1)      | M1                   | Scheduler; MockAgentRunner test double           |
| `packages/context-manager/`   | partial (M1)      | M1                   | SQLite execution state; context selection later  |
| `packages/escalation/`        | stub              | M4                   | Escalation and downgrade rules                   |
| `packages/provider-adapters/` | partial (M2)      | M2                   | ModelClient over AI SDK; retries, fallback, keys |
| `packages/harness-adapters/`  | stub              | M6                   | Harness adapters (Claude Code, Codex, MCP, …)    |
| `packages/integrations/`      | stub              | M5                   | Worktrees, conflict detection, validation        |
| `packages/observability/`     | partial (M1, M3)  | M1                   | Cost records; routing log; audit log later       |

### Planned directories not created yet

These appear in the spec's suggested layout but are intentionally absent until their milestone,
so the tree never implies support that does not exist:

- `skills/universal-orchestrator/` — universal agent skill (`SKILL.md`), Milestone 6.
- `extensions/{cursor,windsurf,kilo,vscode}/` and `apps/vscode-extension/` — Milestone 7.
- `examples/` — once there is something runnable end to end.
- `docs/{installation,providers,model-routing,task-decomposition,harness-integrations,security,examples}.md` — written alongside the features they describe.

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
