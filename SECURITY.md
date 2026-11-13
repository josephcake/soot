# Security Policy

## Status

The project is pre-release. No version is published. The code reads provider keys only in the
provider adapters, runs project checks, and changes git repositories through isolated worktrees;
see [`docs/guides/security.md`](docs/guides/security.md) for what is enforced and the known limits.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Once the repository is published,
use GitHub's private vulnerability reporting ("Report a vulnerability" under the Security tab).
Until then, report privately to the maintainers. A dedicated security contact will be added
before the first release (tracked in `docs/project/TECHNICAL_DEBT.md`).

## Security principles the engine must uphold

These come from the project spec and apply to every future milestone:

- Bring-your-own keys; credentials stay local and are never sent between agents or placed in task context.
- Agents never bypass the host harness's permissions or approval settings.
- Destructive operations require explicit approval.
- File-access boundaries, command execution controls, and audit logs.
- Tool output and repository content are treated as untrusted (prompt-injection defense).
- Concurrent agents are isolated (git worktrees or equivalent).

## Supported versions

None yet. This section will list supported releases after the first release.
