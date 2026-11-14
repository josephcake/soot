# Roadmap

Milestones follow `docs/specs/project-management.md` §4. A milestone is Completed only when
every exit criterion is verified from real runs. Dates are recorded only when verified.

| Milestone | Title                             | Status                                             | Completion date |
| --------- | --------------------------------- | -------------------------------------------------- | --------------- |
| M0        | Repository Foundation             | Completed (verified locally and on hosted CI)      | 2026-11-12      |
| M1        | Core Orchestration                | Completed (verified locally with mock agents)      | 2026-11-12      |
| M2        | Multi-Provider Model Connectivity | In Progress (partial; mocks only, M2-07 blocked)   | —               |
| M3        | Intelligent Model Routing         | Completed (verified locally with fixture registry) | 2026-11-12      |
| M4        | Adaptive Execution                | Completed (verified locally with mock agents)      | 2026-11-12      |
| M5        | Codebase Integration and Safety   | Completed (verified locally; fixture repos, mocks) | 2026-11-12      |
| M6        | Universal Skill and CLI           | In Progress (partial)                              | —               |
| M7        | IDE Extensions                    | In Progress (partial; run in VS Code only)         | —               |

Engine hardening (ADR-030: env-driven runtime, persisted provider health and spend, audited
routing, default attempt timeout) is tracked in `docs/project/TASKS.md` (H-01…H-05) and changes no milestone
status.

The optional local dashboard (ADR-031: `soot dashboard`, 127.0.0.1 only, read-only, headless
stays the default) is tracked in `docs/project/TASKS.md` (D-01, charts D-02, palette and chart types D-03) and changes no milestone status. The
elaborate web dashboard stays deferred (`docs/project/FUTURE_FEATURES.md`).

The MVP (MVP-01…MVP-08) is reached at the end of M5 for the engine and M6 for the first
harness-facing surface. Stack intent: ADR-007. UI constraint for M5–M7: ADR-009.

---

## M0 — Repository Foundation

- **Objectives:** A clean, reproducible monorepo where every package builds and tests independently, with tooling, docs, CI, and tracking in place.
- **Deliverables:** repository initialized (local git); monorepo structure; pnpm; strict TypeScript; ESLint + Prettier; Vitest; environment configuration; basic documentation; CI pipeline; license (MIT).
- **Dependencies:** None.
- **Acceptance / exit criteria:** project builds; tests execute; CI passes (locally, and on GitHub Actions for Node 24 and 26 since the repo was published, ADR-032); repository structure is documented.
- **Status:** Completed (verified locally and on hosted CI)
- **Completion date:** 2026-11-12
- **Evidence:** see `docs/project/PROJECT_STATUS.md` → Latest Validation; hosted run [43334786373](https://github.com/josephcake/soot/actions/runs/43334786373) (M0-11).

## M1 — Core Orchestration

- **Objectives:** Turn one prompt into an inspectable task graph and schedule it, with mocked agents.
- **Deliverables:** prompt intake; task decomposition; task schema (JSON Schema); dependency graph; task scheduler; structured agent results; basic execution state (SQLite).
- **Dependencies:** M0.
- **Acceptance / exit criteria:** a single prompt is decomposed into multiple tasks; dependencies are represented correctly; independent tasks are scheduled concurrently (verified by timing/ordering, not assumed); results can be collected and inspected.
- **Status:** Completed (verified locally with mock agents; decomposition is fixture-backed)
- **Completion date:** 2026-11-12
- **Evidence:** `tests/m1-end-to-end.test.ts` (EC1–EC4), `tests/resume-after-kill.test.ts`, package tests; see `docs/project/PROJECT_STATUS.md` → Latest Validation. Model-backed decomposition and real agents are later milestones.

## M2 — Multi-Provider Model Connectivity

- **Objectives:** Invoke multiple models across providers through one abstraction, BYOK.
- **Deliverables:** provider abstraction (Vercel AI SDK in-process, ADR-019); Anthropic and OpenAI first (ADR-017), then Google, OpenRouter (DeepSeek: optional, user-configured as an OpenAI-compatible provider; the ADR-016 hold was lifted by ADR-035, and it is not a default); local endpoints (Ollama/LM Studio); model registry; pricing and capability metadata.
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
- **Status:** Completed. Verified locally on real temporary git repositories with real `node --test`, `tsc` and lint commands run by soot itself; agents are mocks that write files, so no model or provider is called (ADR-025). A task is Verified only from soot-run evidence on its real diff. Real-model execution still depends on M2-07 (Blocked) and harness runners (M6).
- **Evidence:** `tests/m5-codebase-end-to-end.test.ts` (12 tests: EC1–EC4, M5-05…M5-09), `packages/integrations` tests (worktrees, cleanup, merge-tree integration, scope, structured edits, command controls), `packages/observability/src/audit-cost-report.test.ts`, `packages/context-manager/src/untrusted.test.ts` and `execution-store.test.ts` (schema v3), `packages/agent-runtime/src/permissions.test.ts`.
- **Completion date:** 2026-11-12

## M6 — Universal Skill and CLI

- **Objectives:** Make orchestration invocable from existing harnesses.
- **Deliverables:** universal orchestration skill (`SKILL.md`); Claude Code integration; Codex integration; MCP server where appropriate; standalone CLI (`orchestrator run|models|status|config|cost|stop`); installation docs.
- **Dependencies:** M5.
- **Acceptance / exit criteria:** a user invokes orchestration from a supported harness; one prompt triggers the complete workflow; the user receives the consolidated result.
- **Status:** In Progress (partial). Exit criteria **not met**: no harness is supported yet (M6-04/05 Implemented as ACP runner profiles but tested against simulated adapters only, ADR-047; no real run) and real execution needs BYOK providers (M2-07, Blocked). Done: the `soot` CLI, the MCP server (tested with the official SDK client), the universal skill and its installer, and the docs, all against fixtures and a scripted mock agent (ADR-026); and one generic ACP driver with `soot run --agent acp`, tested only against soot's own mock ACP agent (ADR-027). No vendor harness has been run through it.
- **Completion date:** —

## M7 — IDE Extensions

- **Objectives:** Visibility and control inside IDEs, as thin adapters (UI per ADR-009).
- **Deliverables:** VS Code extension; Cursor, Windsurf, Kilo Code compatibility; task visualization; model assignment visibility; cost reporting.
- **Dependencies:** M6.
- **Acceptance / exit criteria:** at least one functional IDE extension; additional integrations verified individually; core orchestration remains independent of IDE implementation.
- **Status:** In Progress (partial, ADR-029, ADR-041). A thin VS Code extension (`apps/vscode-extension`) exists, is tested against a fake `vscode` module and the real CLI with `--agent mock`, and was loaded and used in VS Code 1.144.0 on macOS on 2026-11-14 (M7-01 Verified, mock agent only); a `.vsix` builds locally and is not published. The on/off fix that run prompted (ADR-041) was re-run in the editor the same day (M7-08 Verified). Exit criteria not met: no other editor (Cursor, Windsurf, Kilo Code) is verified. Core independence holds by construction (the extension only runs the CLI) and is checked by a test.
- **Completion date:** —
