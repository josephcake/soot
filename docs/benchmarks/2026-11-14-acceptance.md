# Live acceptance runs, 2026-11-14

Build spec §17 Tests 1 to 6, run with real models through `soot run --agent api --apply` on
2026-11-14 (about 1:03 PM PT), soot built from `5dfbd8d`. Keys: `XAI_API_KEY` and
`DEEPSEEK_API_KEY` (Anthropic and OpenAI unset). Each run used a throwaway copy of
[`examples/demo-app`](../../examples/demo-app) with its own git repo and data dir. Test 5 is
the [savings benchmark](2026-11-14.md). Decision record: ADR-050.

| Test                                                | Result              | Cost (USD)   | What happened                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Simple parallel                                   | Pass                | 0.0096       | Two tasks, both routed to `deepseek/deepseek-flash`, ran concurrently (max concurrency 2). The title task failed its acceptance check twice, escalated to `xai/grok-4.3` and passed. Final validation passed; the result landed.                                                                                                                                                                             |
| 2 Mixed complexity                                  | Pass                | 0.0143       | Button → `deepseek-flash`, dropdown → `xai/grok-4.3` (passed on its second try), auth investigation → `xai/grok-4.7` (strongest available; no high-tier model in the pool). All three ran concurrently (max 3), all verified, final validation passed, landed.                                                                                                                                               |
| 3 Runtime escalation                                | Partial             | 0.0036       | Started on the cheapest model (`deepseek-flash`), which passed on its second try. The theme fixture (derived hover/active shades) did not trip escalation. Live escalation with earlier findings passed to the stronger model was seen in Test 1 and in benchmark runs, triggered by repeated failed checks, not by theme complexity.                                                                        |
| 4 Cross-provider                                    | Pass (see note)     | 0.0197       | Implement → `xai/grok-4.3`, tests → `deepseek/deepseek-flash`, security review → `xai/grok-4.7`; two providers. Tests and review ran concurrently after the implementation. Implementation and tests verified, final validation passed, landed. The review cited its file and stated its scope, but soot marks read-only work "unverified" by design, so the run status is "incomplete".                     |
| 5 Cost optimization                                 | See benchmark       | 0.25         | [2026-11-14.md](2026-11-14.md).                                                                                                                                                                                                                                                                                                                                                                              |
| 6a Provider outage                                  | Pass                | 0.0012 known | A stand-in cheapest model pointing at a closed local port took both Test 1 tasks first. soot detected the outage and fell back to `deepseek-flash` on the other provider; both tasks verified, final validation passed, landed.                                                                                                                                                                              |
| 6b Model timeout                                    | Pass, except resume | 0.0001 known | Test 2 with `modelCallTimeoutMs: 8000`. The button task finished and stayed finished. Dropdown: two retries on `grok-4.3`, fallback to `deepseek/deepseek-v4-pro`, then stopped at the attempt limit (5). Auth: two retries on `grok-4.7`, then stopped ("no fallback model available outside xai"). The run ended incomplete with the verified task landed and state kept. Resuming the run was not tested. |
| 6 Rate limit, agent failure, invalid output, resume | Not run live        | —            | Not simulated against real providers. A forced invalid-output attempt (tiny `maxOutputTokens`) was excluded by the router before any call, so it tested nothing ($0.0175 spent on the fallback models). These paths stay verified with mocks only (M4-05); the CLI has no resume command.                                                                                                                    |

Setup that differs from the stock demo, all in the throwaway copies:

- Every test: the demo's models file removed, so the models come from the keys (ADR-043).
- Test 3: added `src/theme/tokens.css` and an acceptance test (primary changed, derived shades
  not stale, other tokens unchanged).
- Test 4: added `src/feature/README.md` describing the requested feature (the fixture's
  instructions say only "the requested feature"), and a models file for xAI that declares
  `reasoning: true` on `grok-4.7`, because security review needs the `reasoning` capability and
  auto models never claim it (ADR-043). DeepSeek stayed auto.
- Test 6a: a models file with one keyless provider at `http://127.0.0.1:9/v1`, priced lowest.
- Test 6b: `"modelCallTimeoutMs": 8000` in `soot.config.json`.

Spend for these runs: $0.066 known (including the $0.0175 invalid-output attempt), plus $0.0015
for a first smoke run of Test 1. The 6a outage calls never connected; the 8 timed-out 6b calls reported no usage.
