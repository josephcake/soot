# @soot/planner

> **Status: partial (Milestone 1 scope implemented, plus a model-backed decomposer).** The
> default decomposer is a deterministic fixture lookup. `ModelDecomposer` (ADR-033) has been
> verified with **mock model clients only**: no real provider has decomposed a prompt (M2-07 is
> blocked), and the CLI does not use it yet.

## Prompt intake

`createPromptIntake({ prompt, context, intendedOutcome })` returns a deep-frozen `PromptIntake`:

- `originalPrompt` is the exact input (string or UTF-8 bytes), never trimmed or normalized, and
  `promptSha256` identifies it byte-for-byte. Invalid UTF-8 and lone surrogates are rejected
  because they cannot round-trip.
- `context` is validated against `ProjectContextSchema` (name, relevant files, issue/doc
  references, notes). Unknown fields are rejected.
- `intendedOutcome` is the caller's statement (`source: 'user'`) or, if none is given, the
  prompt itself (`source: 'prompt'`). No interpretation happens in Milestone 1.

## Decomposition

`Decomposer` is the interface every decomposer satisfies. `FixtureDecomposer` matches a prompt (case/whitespace-insensitive) against recorded
fixtures and returns validated tasks plus their dependency graph, or throws `NoFixtureError`.
It does not analyze language.

`SPEC_FIXTURES` records expected decompositions for the build spec's §3 example and §17 Tests
1, 2, and 4. Token estimates in fixtures are placeholders, not measurements; costs are `null`
until model routing (Milestone 3).

## Model-backed decomposition (mocks only)

`ModelDecomposer({ model })` asks a caller-supplied `ModelClient` (from
`@soot/provider-adapters`) for structured output shaped like the task contract, then validates
the answer exactly like a fixture: every task through `parseTask` (ids, non-empty criteria,
project-relative paths, no self-dependency), the set through `buildTaskGraph` (unique ids, known
dependencies, no cycles, file conflicts serialized), plus `estimate.costUsd` must be `null` and
the task count must stay under `maxTasks` (default 20). Any failure is a
`ModelDecompositionError` with a `reason` (`model-call-failed`, `invalid-output`,
`invalid-graph`) and the issues found; no partial graph is returned and the prompt text is not
copied into the error.

`createDecomposer({ fixtures, model })` picks the implementation:

- no `model` (or `null`): a plain `FixtureDecomposer`. No model client is created and nothing
  touches the network; unknown prompts throw `NoFixtureError`.
- a `model`: `FixtureThenModelDecomposer`. Recorded prompts still come from fixtures without a
  model call; only prompts with no fixture go to the model.

The planner never creates a client or reads keys itself (ADR-022); the caller must pass one.
Tests use `createMockModelClient` and a `fetch` spy that fails on any call.
