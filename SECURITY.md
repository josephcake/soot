# Security Policy

## Status

The project is pre-release (Milestone 0). No version is published and no code yet handles
provider credentials, executes agents, or touches user repositories.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Once the repository is published,
use GitHub's private vulnerability reporting ("Report a vulnerability" under the Security tab).
Until then, report privately to the maintainers. A dedicated security contact will be added
before the first release (tracked in `TECHNICAL_DEBT.md`).

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
