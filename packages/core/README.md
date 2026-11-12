# @soot/core

> **Status: foundation only.** Shared foundation: package metadata, environment configuration parsing and a leveled logger. Orchestration types live in the other packages.

Currently exports:

- `PACKAGE_NAME`, `PACKAGE_VERSION` — read from this package's `package.json`.
- `parseEnv(env, options)` — validates the `SOOT_*` environment variables documented in `docs/configuration.md`. The `soot` CLI and `soot mcp` call it (ADR-030).
- `createLogger(level, sink)`, `SILENT_LOGGER` — stderr lines filtered by `SOOT_LOG_LEVEL`.

No orchestration, routing, or provider code lives here.
