# @soot/escalation

> **Status: partial (Milestone 4 scope implemented, verified with mock agents).** Escalated
> tasks cannot run on real providers until M2-07 (Blocked). See ADR-024.

`AdaptiveSupervisor` plugs into the `@soot/agent-runtime` Scheduler (`supervisor` option) and
decides, per attempt, which model runs and what happens after a failure:

- **Triggers** (`detectTriggers`): repeated failure, unexpected complexity, unmet acceptance
  criteria, low confidence, tool errors, token blowup, invalid output, crash. Signals come from
  the agent's structured result (`AgentResult.signals`).
- **Next step** (`nextStep`, pure and replayable from persisted history): accept, retry the
  same model (rate limit or timeout with retry-after/backoff; one retry after a plain failure),
  fall back to another provider (outage, auth, persistent rate limit), escalate one tier to an
  untried, more reliable model, or fail with a reason (blocked work, limits).
- **Bounds:** `maxAttemptsPerTask` (5), `maxEscalationsPerTask` (2), `taskBudgetUsd`,
  `runBudgetUsd`. Spend uses reported actual cost, else the routed estimate.
- **Downgrade:** when a prerequisite reports `planReady`, the dependent is routed one tier
  lower if that saves at least `downgrade.minSavingsRatio` (30%). High-risk work is never
  downgraded.
- **Events:** every decision is an `AdaptiveEvent` with a readable reason (`supervisor.events`,
  `onEvent`).

Routing goes through `@soot/model-router` with the run's policy and `ProviderHealth`, so
listed-only and unavailable providers are skipped. All thresholds are defaults in
`EscalationConfigSchema`, not measurements.
