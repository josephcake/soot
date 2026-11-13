# Documentation

Index of every document in this tree. Start here, or at the root [`README.md`](../README.md).

## Guides

| Document                                               | Description                                                                                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Installation and quick start](guides/installation.md) | Build from source and run the keyless demo (mock agent, no provider calls).                                                                           |
| [Configuration](guides/configuration.md)               | Environment variables, `soot.config.json`, model registry, and the optional decomposer. Keys stay in env vars, never in config; `.env` is not loaded. |
| [Architecture](guides/architecture.md)                 | How the engine is put together, and the actual repository layout.                                                                                     |
| [Development](guides/development.md)                   | Toolchain, scripts, how to add a package, and CI.                                                                                                     |
| [Providers](guides/providers.md)                       | Provider adapters (mocked HTTP only so far) and how to configure models.                                                                              |
| [Model routing](guides/model-routing.md)               | Per-task routing, policies, and how explanations are produced.                                                                                        |
| [Security](guides/security.md)                         | What soot enforces today, known limits, and how credentials are handled.                                                                              |

## Project tracking

| Document                                      | Description                                              |
| --------------------------------------------- | -------------------------------------------------------- |
| [Project status](project/PROJECT_STATUS.md)   | Current phase, progress, and latest validation evidence. |
| [Roadmap](project/ROADMAP.md)                 | Milestone sequence and status.                           |
| [Tasks](project/TASKS.md)                     | The work breakdown, dependencies, and completion notes.  |
| [Technical debt](project/TECHNICAL_DEBT.md)   | Known limits, intentional gaps, and blocked work.        |
| [Future features](project/FUTURE_FEATURES.md) | Ideas deferred from the MVP.                             |

## Decisions

| Document                                   | Description                                    |
| ------------------------------------------ | ---------------------------------------------- |
| [Decisions (ADRs)](decisions/DECISIONS.md) | Architecture decision records for the project. |

## Specifications

Historical, kept as written (except a live-location note on the project-management spec).

| Document                                          | Description                                                 |
| ------------------------------------------------- | ----------------------------------------------------------- |
| [Build spec](specs/build-spec.md)                 | Original product and engine specification.                  |
| [Project management](specs/project-management.md) | Original process for status, roadmap, tasks, and decisions. |

## Research

| Document                                                | Description                                        |
| ------------------------------------------------------- | -------------------------------------------------- |
| [Research index](research/README.md)                    | Read-only copies of pre-implementation research.   |
| [2026-11-12 soot research](research/2026-11-12-soot.md) | Lumen's research notes that informed early design. |

## Brand

Pixel logo assets used by the root README and the optional local dashboard.

| File                                           | Description                    |
| ---------------------------------------------- | ------------------------------ |
| [soot-lockup-4x.png](brand/soot-lockup-4x.png) | Wordmark lockup, 4× (576×128). |
| [soot-lockup.png](brand/soot-lockup.png)       | Wordmark lockup, 1× (144×32).  |
| [soot-mark.png](brand/soot-mark.png)           | Mark only, 32×32.              |
| [soot-mark-16.png](brand/soot-mark-16.png)     | Mark only, 16×16.              |

## Repository root

These stay at the root as standard GitHub files.

| Document                                 | Description                    |
| ---------------------------------------- | ------------------------------ |
| [README](../README.md)                   | Project front door.            |
| [Changelog](../CHANGELOG.md)             | Notable changes, by milestone. |
| [Contributing](../CONTRIBUTING.md)       | How to contribute.             |
| [Code of conduct](../CODE_OF_CONDUCT.md) | Contributor covenant.          |
| [Security policy](../SECURITY.md)        | How to report a vulnerability. |
| [License](../LICENSE)                    | MIT.                           |
