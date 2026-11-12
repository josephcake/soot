# @soot/observability

> **Status: partial (Milestone 1 scope implemented).** Types and pure functions only. No
> dashboard or UI (ADR-009); audit logs and reports come later.

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
