# @soot/model-router

> **Status: partial (Milestone 3 scope implemented).** Routing is verified with a fictional
> registry and the spec's fixture prompts only. Complexity evaluation is heuristic (ADR-023).
> The router calls no model. Re-routing during execution (escalation) is Milestone 4.

Picks a model **per task**, never per prompt (build spec §5):

1. **Evaluate** (`evaluateTask`). Starts from the planner's complexity. Signals such as
   debugging, security work, or large token plans can raise it, but never lower it. Task
   capabilities map onto model capabilities: `tools` and `structuredOutput` always, plus
   `vision`, `reasoning`, or `streaming` when needed. High-risk work (security review,
   architecture, data migration) uses the `high` reliability threshold. Every rule that
   fires is recorded as a reason, and unmapped capabilities are recorded rather than guessed.
2. **Filter**. Uses `ModelRegistry.select` to check capabilities (unknown counts as missing),
   context window, availability, listed-only providers (never selected), and policy
   provider limits. The router adds checks for max output
   tokens, unpriced models, the cost cap, and unknown reliability.
3. **Estimate cost** (`estimateCost`) from the registry's sourced list prices and the task's
   planned tokens. The result is always labelled `kind: 'estimate'` and is an `EstimatedUsd`,
   never an actual.
4. **Estimate reliability**. The model's configured prior for the tier is blended with
   recorded history: (prior·k + successes) / (k + attempts). History alone counts after
   `minHistorySamples` attempts. With neither, reliability is unknown.
5. **Select** the best candidate that meets the policy threshold. If none does, the task is
   `unroutable` unless the policy says `onNoQualifying: 'most-reliable'`.
6. **Explain**. Each `RoutingDecision` has a one-sentence `reason`, the task profile, and every
   model with its outcome, estimate, reliability and exclusion reasons. Pass a `RoutingLog`
   (`@soot/observability`) to record decisions as text or JSON Lines.

## Policies

| Policy   | Objective                                                                                                                               | Thresholds (low / medium / high) | Unpriced models |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------- |
| Economy  | cheapest estimate                                                                                                                       | 0.60 / 0.70 / 0.80               | excluded        |
| Balanced | lowest estimated cost per success (cost ÷ p)                                                                                            | 0.75 / 0.85 / 0.90               | excluded        |
| Quality  | highest reliability, then cheapest                                                                                                      | 0.85 / 0.90 / 0.95               | allowed         |
| Custom   | `customPolicy({...})`: any preset plus overrides (thresholds, objective, provider allow/deny lists, local-only, cost cap, prior weight) |                                  |                 |

These defaults are soot's choices, not measurements. Reliability priors come from your model
config (`reliability: { low, medium, high, source }`); soot ships none.

```ts
const decisions = routeTasks(tasks, { registry, policy: 'balanced', health, history, log });
decisions[0].selected; // 'provider/model' or null
decisions[0].reason; // 'Balanced: lowest estimated cost per success (...) among 4 model(s) ...'
```
