# Architecture and Repository Layout

> **Current state (Milestone 0):** only the repository foundation exists. The component
> design below is the _plan_ from [`specs/build-spec.md`](specs/build-spec.md) §14; each
> package is a stub until its milestone is verified. See [`../ROADMAP.md`](../ROADMAP.md).

## Design summary (planned)

A universal TypeScript orchestration core with thin adapters. The core never depends on a
particular IDE, harness, or provider.

```text
 host harness / IDE / CLI ──► harness-adapters ──► core orchestrator
                                                    │
     planner ─► task-graph ─► model-router ◄─ model-registry ◄─ provider-adapters (LiteLLM, local)
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
│   ├── core/                 # foundation: package metadata + IAR_* env parsing (real, tested)
│   ├── planner/              # stub — prompt analysis, task decomposition (M1)
│   ├── task-graph/           # stub — task schema, dependency graph, scheduler (M1)
│   ├── model-registry/       # stub — model discovery, capability/pricing registry (M2)
│   ├── model-router/         # stub — per-task routing, cost/reliability policies (M3)
│   ├── agent-runtime/        # stub — parallel/sequential agent execution (M1)
│   ├── context-manager/      # stub — per-task context, persisted state (M1)
│   ├── escalation/           # stub — escalation/downgrade rules (M4)
│   ├── provider-adapters/    # stub — provider abstraction, LiteLLM, local endpoints (M2)
│   ├── harness-adapters/     # stub — Claude Code, Codex, MCP, etc. (M6)
│   ├── integrations/         # stub — worktrees, conflict detection, validation (M5)
│   └── observability/        # stub — task-level cost, audit log (M1, expanded later)
├── docs/
│   ├── architecture.md       # this file
│   ├── configuration.md      # environment variables
│   ├── development.md        # package conventions, scripts
│   └── specs/                # original build + project-management specs (verbatim)
└── tests/
    └── repo-structure.test.ts  # guards: build graph, docs, env secrets, CI parity
```

### Workspace packages

| Path                          | Status            | First real milestone | Responsibility                                   |
| ----------------------------- | ----------------- | -------------------- | ------------------------------------------------ |
| `apps/cli/`                   | stub              | M6                   | Future `orchestrator` CLI; depends on core       |
| `packages/core/`              | foundation (real) | M0                   | Package metadata, `parseEnv` for `IAR_*` vars    |
| `packages/planner/`           | stub              | M1                   | Prompt analyzer, task decomposer                 |
| `packages/task-graph/`        | stub              | M1                   | Task schema, dependency graph, scheduler         |
| `packages/model-registry/`    | stub              | M2                   | Model discovery, capability/pricing registry     |
| `packages/model-router/`      | stub              | M3                   | Per-task routing, cost/reliability policies      |
| `packages/agent-runtime/`     | stub              | M1                   | Agent execution engine                           |
| `packages/context-manager/`   | stub              | M1                   | Per-task context, persisted workflow state       |
| `packages/escalation/`        | stub              | M4                   | Escalation and downgrade rules                   |
| `packages/provider-adapters/` | stub              | M2                   | Provider abstraction (LiteLLM-compatible, local) |
| `packages/harness-adapters/`  | stub              | M6                   | Harness adapters (Claude Code, Codex, MCP, …)    |
| `packages/integrations/`      | stub              | M5                   | Worktrees, conflict detection, validation        |
| `packages/observability/`     | stub              | M1                   | Task-level cost, audit log, reports              |

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
