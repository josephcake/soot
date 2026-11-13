# Model routing

Every task is routed on its own (ADR-023). The router calls no model: it uses the task's
declared profile, your registry, and soot's own record of past outcomes.

## Steps

1. **Evaluate the task.** Start from the planner's complexity (`low`, `medium`, `high`) and only
   raise it: debugging, security and architecture work is at least medium; more than 50k
   planned tokens is at least medium, more than 150k is high. Security, architecture and data
   migrations are _high-risk_ and use the `high` threshold. Every rule that fires is recorded.
2. **Filter models.** Required capabilities (unknown counts as missing), context window, max
   output, availability, price, cost caps, and listed-only providers (never called).
3. **Estimate cost** from your registry's sourced prices, or soot's sourced price catalog for
   models you left unpriced (`EstimatedUsd`, never an actual; see
   [prices](configuration.md#prices)). A model with no price has an unknown estimate; run the
   [update-model-pricing prompt](../../skills/update-model-pricing/SKILL.md) to add one.
4. **Estimate reliability** for the task's tier: your prior blended with history,
   (prior·5 + successes) / (5 + attempts). Without a prior, history counts after 3 attempts.
5. **Pick by policy:**

| Policy   | Thresholds (low/medium/high) | Picks                                                  |
| -------- | ---------------------------- | ------------------------------------------------------ |
| Economy  | 0.60 / 0.70 / 0.80           | cheapest model above the threshold                     |
| Balanced | 0.75 / 0.85 / 0.90           | lowest estimated cost per success (cost ÷ reliability) |
| Quality  | 0.85 / 0.90 / 0.95           | most reliable model above the threshold                |

These are untuned defaults, not measurements. If nothing qualifies, the task is unroutable
with a reason (no silent fallback).

## History comes from soot's verdicts

After each attempt soot records its **own** verdict with the model and tier in `soot.sqlite`:
`verified` (soot's checks passed on the task's real diff) or `failed` (checks failed, edits
outside the lease or to protected paths, no changes, or the agent failed). Agent claims never
count. `soot run` loads these outcomes before routing, so a model that keeps failing soot's
checks at a tier stops being chosen for that tier (`tests/m6-cli-end-to-end.test.ts`).

## During a run

The adaptive supervisor (ADR-024) retries, falls back to another provider, or escalates one
tier up when an attempt fails or soot's verification fails, passing the earlier findings on.
Attempts, escalations and budgets are bounded. Every decision is printed by `soot run`, kept
in the run's report and appended to its audit log (ADR-030).

## Inspect

```sh
soot models   # every configured model: eligible, or why it is excluded
soot status <run-id>   # the model path of each task and every decision
```

No cost savings are claimed: savings will be reported only from measured benchmark runs
(M6-08).
