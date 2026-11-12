# @intelligent-agent-router/core

> **Status: foundation only.** Shared foundation: package metadata and environment configuration parsing. Orchestration types arrive in Milestone 1.

Currently exports:

- `PACKAGE_NAME`, `PACKAGE_VERSION` — read from this package's `package.json`.
- `parseEnv(env, options)` — validates the `IAR_*` environment variables documented in `docs/configuration.md`.

No orchestration, routing, or provider code lives here yet.
