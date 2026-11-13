# soot demo app

A tiny fixture project for trying soot without keys. Its files match the build spec's example
prompts (§17 Tests 1, 2 and 4), which soot's fixture decomposer knows. `mock-agent.json`
scripts what the mock agent writes for each task: **no model is called**. `models.json` names
real models (Claude Haiku 5.5, GPT-6.1 Terra, Claude Opus 5.5) with their official list prices
(source and date on each), so routed cost estimates are realistic; the reliability priors and
the mock agent's reported usage are fictional. See
`docs/guides/installation.md` for the walkthrough.
