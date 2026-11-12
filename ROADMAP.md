# Roadmap

Milestones follow `docs/specs/project-management.md` §4. A milestone is Completed only when
every exit criterion is verified from real runs. Dates are recorded only when verified.

| Milestone | Title                             | Status                                              | Completion date |
| --------- | --------------------------------- | --------------------------------------------------- | --------------- |
| M0        | Repository Foundation             | Completed (verified locally; hosted CI not yet run) | 2026-11-12      |
| M1        | Core Orchestration                | Completed (verified locally with mock agents)       | 2026-11-12      |
| M2        | Multi-Provider Model Connectivity | In Progress (partial; mocks only, M2-07 blocked)    | —               |
| M3        | Intelligent Model Routing         | Completed (verified locally with fixture registry)  | 2026-11-12      |
| M4        | Adaptive Execution                | Completed (verified locally with mock agents)       | 2026-11-12      |
| M5        | Codebase Integration and Safety   | Not Started                                         | —               |
| M6        | Universal Skill and CLI           | Not Started                                         | —               |
| M7        | IDE Extensions                    | Not Started                                         | —               |

The MVP (MVP-01…MVP-08) is reached at the end of M5 for the engine and M6 for the first
harness-facing surface. Stack intent: ADR-007. UI constraint for M5–M7: ADR-009.

---

## M0 — Repository Foundation

- **Objectives:** A clean, reproducible monorepo where every package builds and tests independently, with tooling, docs, CI, and tracking in place.
- **Deliverables:** repository initialized (local git); monorepo structure; pnpm; strict TypeScript; ESLint + Prettier; Vitest; environment configuration; basic documentation; CI pipeline; license (MIT).
- **Dependencies:** None.
- **Acceptance / exit criteria:** project builds; tests execute; CI passes (locally — hosted CI not running, repo unpublished); repository structure is documented.
- **Status:** Completed (verified locally; hosted CI not yet run)
- **Completion date:** 2026-11-12
- **Evidence:** see `PROJECT_STATUS.md` → Latest Validation.

## M1 — Core Orchestration

- **Objectives:** Turn one prompt into an inspectable task graph and schedule it, with mocked agents.
- **Deliverables:** prompt intake; task decomposition; task schema (JSON Schema); dependency graph; task scheduler; structured agent results; basic execution state (SQLite).
- **Dependencies:** M0.
- **Acceptance / exit criteria:** a single prompt is decomposed into multiple tasks; dependencies are represented correctly; independent tasks are scheduled concurrently (verified by timing/ordering, not assumed); results can be collected and inspected.
- **Status:** Completed (verified locally with mock agents; decomposition is fixture-backed)
- **Completion date:** 2026-11-12
- **Evidence:** `tests/m1-end-to-end.test.ts` (EC1–EC4), `tests/resume-after-kill.test.ts`, package tests; see `PROJECT_STATUS.md` → Latest Validation. Model-backed decomposition and real agents are later milestones.

## M2 — Multi-Provider Model Connectivity

- **Objectives:** Invoke multiple models across providers through one abstraction, BYOK.
- **Deliverables:** provider abstraction (Vercel AI SDK in-process, ADR-019); Anthropic and OpenAI first (ADR-017), then Google, OpenRouter (DeepSeek listed in the registry but outside the default path, ADR-016); local endpoints (Ollama/LM Studio); model registry; pricing and capability metadata.
- **Dependencies:** M0; M1 task schema.
- **Acceptance / exit criteria:** at least two independent providers work with real API credentials; multiple models can be invoked; provider failures are handled; models can be selected dynamically.
- **Note:** Real-credential verification is blocked until a user supplies their own keys (ADR-011). Mocked-provider tests are required regardless.
- **Status:** In Progress (partial). Mockable scope (M2-01, -02, -04, -05, -06, -08) verified with mocked HTTP; M2-03 live local test skipped (no local runtime); M2-07 Blocked on BYOK keys. Not Completed: the real-credential exit criterion is unmet.
- **Evidence:** `packages/provider-adapters`, `packages/model-registry` tests; `tests/credential-boundary.test.ts`; ADR-022.
- **Completion date:** —

## M3 — Intelligent Model Routing

- **Objectives:** Pick the cheapest capable model per task, explainably.
- **Deliverables:** task complexity evaluation; capability matching; cost estimation; model selection; routing explanations; configurable policies (Economy / Balanced / Quality / Custom).
- **Dependencies:** M1, M2.
- **Acceptance / exit criteria:** simple tasks go to inexpensive capable models; complex tasks can go to stronger models; selection is per task; routing decisions are logged and explainable.
- **Status:** Completed. Verified locally with a fictional model registry and the spec's fixture prompts, without network access or keys. Complexity evaluation is heuristic until a model-backed planner exists (ADR-023). Routed tasks cannot run on real providers until M2-07 (Blocked).
- **Evidence:** `tests/m3-routing-end-to-end.test.ts` (EC1–EC4), `packages/model-router` tests (M3-01…M3-06), `packages/observability/src/routing-log.test.ts`.
- **Completion date:** 2026-11-12

## M4 — Adaptive Execution

- **Objectives:** Escalate/downgrade mid-flight without restarting unrelated work.
- **Deliverables:** execution monitoring; escalation and downgrade rules; retry management; context transfer; failure recovery; task cancellation.
- **Dependencies:** M1, M3.
- **Acceptance / exit criteria:** a task can be escalated during execution; previous findings are preserved; unrelated completed tasks are not restarted; escalation loops are bounded.
- **Status:** Completed. Verified locally with mock agents, the fictional routing registry and the spec's fixture prompts (§17 Tests 3 and 6), without network access or keys. Triggers rely on agents' structured self-report until Milestone 5 checks evidence (ADR-024). Escalated tasks cannot run on real providers until M2-07 (Blocked).
- **Evidence:** `tests/m4-adaptive-end-to-end.test.ts` (EC1–EC6), `packages/escalation` tests (M4-01…M4-04), `packages/agent-runtime/src/scheduler-attempts.test.ts` (M4-05, M4-06), `packages/context-manager/src/execution-store.test.ts` (attempt history, schema v2).
- **Completion date:** 2026-11-12

## M5 — Codebase Integration and Safety

- **Objectives:** Let multiple tasks change a real repository safely and prove the result.
- **Deliverables:** filesystem integration; git integration; file-conflict detection; git worktree isolation; patch integration; test execution; final validation; task-level cost reporting.
- **Dependencies:** M1, M4.
- **Acceptance / exit criteria:** multiple tasks modify a real repository safely; conflicting changes are detected; integration failures are reported; relevant tests are executed.
- **Status:** Not Started
- **Completion date:** —

## M6 — Universal Skill and CLI

- **Objectives:** Make orchestration invocable from existing harnesses.
- **Deliverables:** universal orchestration skill (`SKILL.md`); Claude Code integration; Codex integration; MCP server where appropriate; standalone CLI (`orchestrator run|models|status|config|cost|stop`); installation docs.
- **Dependencies:** M5.
- **Acceptance / exit criteria:** a user invokes orchestration from a supported harness; one prompt triggers the complete workflow; the user receives the consolidated result.
- **Status:** Not Started
- **Completion date:** —

## M7 — IDE Extensions

- **Objectives:** Visibility and control inside IDEs, as thin adapters (UI per ADR-009).
- **Deliverables:** VS Code extension; Cursor, Windsurf, Kilo Code compatibility; task visualization; model assignment visibility; cost reporting.
- **Dependencies:** M6.
- **Acceptance / exit criteria:** at least one functional IDE extension; additional integrations verified individually; core orchestration remains independent of IDE implementation.
- **Status:** Not Started
- **Completion date:** —
