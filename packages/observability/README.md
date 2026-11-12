# @soot/observability

> **Status: partial (Milestone 1, 3 and 5 scope implemented).** Types and functions only. No
> dashboard or UI (ADR-009).

- `AuditLog` (M5): one redacted JSON Lines entry per event (worktrees, leases, attempts,
  commands run or refused, approvals, verdicts, integration, routing decisions and ACP model
  routes), file mode 0600. `redactSecrets`
  masks key-like strings.
- `buildCostReport` / `renderCostReport` (M5): per task, per attempt and by model, the planner
  estimate and routed estimates next to reported actual usage, never mixed. Unknown stays
  unknown.

- Cost records (M1): planner/router estimates and reported actuals kept in distinct types.
- `RoutingLog` (M3): one entry per routing decision (task, policy, selected model, reason,
  every candidate with its estimated cost and reliability). `formatRoutingEntry` renders
  text and `toJSONL()` exports JSON Lines. It holds estimates only, never actual spend.

## Task cost records

- `createCostRecord(task)`: a `TaskCostRecord` holding the planner `estimate` and no attempts.
- `recordAttempt(record, agentResult)`: returns a new record with that attempt's reported usage
  appended (every attempt counts, so escalations are billed to the task). The estimate never
  changes.
- `summarizeCosts(records)` / `taskActualTotals(record)`: totals with `estimated` and `actual`
  summed separately.

Estimates and actuals use distinct branded types (`EstimatedUsd`, `ActualUsd`) that cannot be
assigned to each other. Unknown costs stay `null` and make the total `null`; they are never
counted as zero.
