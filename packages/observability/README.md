# @soot/observability

> **Status: partial (Milestone 1 and 3 scope implemented).** Types and pure functions only. No
> dashboard or UI (ADR-009); audit logs and reports come later.

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
