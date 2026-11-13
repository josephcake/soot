# @soot/integrations

> **Status: partial (Milestone 5 scope implemented).** Verified on real temporary git
> repositories with mock agents. No model or provider is called here.

`runCodebaseWorkflow(options)` runs a task graph against a git repository:

1. **Open:** refuse a dirty working tree, pin `HEAD` as the base, start an audit log at
   `<dataDir>/audit/<runId>.jsonl`.
2. **Isolate:** each attempt runs in its own worktree (`<dataDir>/worktrees/<runId>/<task>`) on
   branch `soot/<runId>/<task>`, under a write lease. A dependent starts from the base merged
   with its prerequisites' verified commits. Retries reset the same worktree.
3. **Verify:** soot commits the worktree, reads the real diff, rejects edits outside the write
   set and asks for approval before deletions. It then runs the configured project checks
   (test, typecheck, lint) and per-task acceptance commands itself. Only that evidence makes a
   task `verified`; agent-reported evidence is kept as a claim. A failed verification is
   returned to the supervisor as a failure, so it can retry or escalate.
4. **Integrate:** verified tasks are merged one by one onto the current `HEAD` with
   `git merge-tree` (no checkout). Conflicts are recorded and the branch is kept. The merged
   result is validated again in a detached worktree.
5. **Apply:** the user's working tree is fast-forwarded only after final validation passes and
   a person approves; unattended runs leave the result on `soot/<runId>/integration`.
6. **Report:** `buildConsolidatedReport` / `renderConsolidatedReport` list incomplete work
   first, then tasks, overlapping changes, integration, final validation, working tree and
   cost (estimates and actuals separate). Verdicts can be stored as model outcomes for routing.

Building blocks: `Repository`, `WriteLeases`, `findDiffOverlaps`, `runCheck` / `checkCommand`
(argv only, executable allowlist, destructive commands refused, scrubbed environment),
`IsolatedTaskRunner`, `integrateSerially`, `applyStructuredEdits` (ADR-020). Design: ADR-025.

Limits: worktrees isolate git state, not processes; there is no OS sandbox (see
`docs/project/TECHNICAL_DEBT.md`). Requires git ≥ 2.38.
