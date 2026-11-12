# @soot/planner

> **Status: partial (Milestone 1 scope implemented).** There is **no model-backed
> decomposition** yet. The only decomposer is a deterministic fixture lookup.

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

`Decomposer` is the interface later implementations (model-backed, after Milestone 2) will
satisfy. `FixtureDecomposer` matches a prompt (case/whitespace-insensitive) against recorded
fixtures and returns validated tasks plus their dependency graph, or throws `NoFixtureError`.
It does not analyze language.

`SPEC_FIXTURES` records expected decompositions for the build spec's §3 example and §17 Tests
1, 2, and 4. Token estimates in fixtures are placeholders, not measurements; costs are `null`
until model routing (Milestone 3).
