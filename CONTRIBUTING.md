# Contributing

Thanks for your interest. The project is at **Milestone 0 (repository foundation)**, so the
most useful contributions right now are to tooling, docs, and the Milestone 1 design in
[`docs/project/TASKS.md`](docs/project/TASKS.md).

## Ground rules

- **Truth over optimism.** Do not mark work complete because code exists. A task is
  `Implemented` when code lands and `Verified` only after its acceptance criteria are checked
  with real runs. Update `docs/project/PROJECT_STATUS.md` / `docs/project/TASKS.md` with actual results.
- **No fake integrations.** Never claim provider, harness, or IDE support that is not tested.
  Stubs must say they are stubs.
- **Never commit secrets.** Only `.env.example` is tracked. Tests must not call paid APIs;
  use mocked providers unless a test is explicitly opt-in with your own keys.
- **Stay in scope.** Out-of-milestone ideas go in `docs/project/FUTURE_FEATURES.md`, not in code.
- **Record decisions.** Foundational changes need an entry in `docs/decisions/DECISIONS.md`.

## Setup

```sh
nvm use            # Node from .nvmrc (24 LTS or newer is supported)
pnpm install
pnpm run ci        # the same checks GitHub Actions runs
```

## Workflow

1. Pick a task from `docs/project/TASKS.md` (respect its dependencies).
2. Make the change in the relevant package with tests next to the code (`src/**/*.test.ts`).
3. Run `pnpm run ci` and make sure it passes.
4. Update tracking files and docs that your change affects.
5. Use clear, conventional commit subjects (`feat(core): …`, `docs: …`, `chore: …`).

See [`docs/guides/development.md`](docs/guides/development.md) for package conventions.

By contributing, you agree that your contributions are licensed under the MIT license.
