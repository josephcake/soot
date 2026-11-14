# Security model

What soot enforces today, and what it does not. Design records: ADR-015, ADR-016 (superseded by ADR-035), ADR-018,
ADR-020, ADR-022, ADR-025, ADR-026.

## Approvals: never automatic

- soot never approves anything for you (ADR-018). There is no "approve all" flag.
- Interactive (`--interactive`, or a terminal): the task waits until you answer `y` or `n`.
- Unattended (no terminal, and always over MCP): every approval is unavailable, so that task
  is refused and reported; independent tasks continue.
- Approval is needed to delete files and to update your working tree. Your tree only ever
  moves by fast-forward, after final validation passed, with a clean tree and an unchanged
  `HEAD`. Otherwise the result waits on `soot/<run-id>/integration`.

## Isolation and write scope

- soot refuses a dirty working tree and pins the base commit.
- Each writing task runs in its own git worktree (outside the repository, under the state
  directory) on its own branch, under a write lease on its declared files.
- soot reads the **real diff**: edits outside the lease fail the task. Edits to protected
  paths fail the task even inside the lease. `soot.config.json`, the model registry, the
  fixtures file and the mock script are protected automatically when they live in the repo;
  add acceptance tests and similar to `protectedPaths`.
- Integration is serial: a `git merge-tree` dry run per task, then a commit. Conflicts are
  reported and their branches kept, never silently dropped.

## Evidence

A task is complete only when soot itself ran the configured checks on that task's commit and
they passed. Agent-reported evidence is shown as a claim and never decides anything.

## Commands

- Check commands come **only** from `soot.config.json`, never from agents or tool output.
- They run as argument vectors without a shell, only if `argv[0]` is in `allowedExecutables`,
  with a timeout. Destructive programs (`rm`, `sudo`, `curl`, shells, …) and git subcommands
  (`push`, `reset`, `checkout`, …) are refused.
- The environment is scrubbed to `PATH`, `HOME`, locale and temp variables: no keys or tokens,
  no `NODE_OPTIONS`.

## ACP agents

- soot spawns only the `acpAgent` command in `soot.config.json`, only with `--agent acp`, without
  a shell, in the task's worktree, with a scrubbed environment (plus the names you list in
  `passEnv`; credential-like names are refused).
- Permission requests from the agent are answered by a person or rejected. soot never chooses
  "allow always", never signs in, and never changes the agent's mode or approval settings. The only setting soot
  changes is the agent's `model` option, to the routed model (ADR-028).
- Harness runners (`--agent claude-code`, `--agent codex`, ADR-047) follow the same rules, need
  an absolute adapter path in `harnesses`, and refuse a session whose reported mode turns the
  harness's own approvals off (`bypassPermissions`, `agent-full-access`) or is outside your
  `allowedModes`. Config arguments that skip approvals or the sandbox are refused for every ACP
  agent. Tested against simulated adapters only.
- Over ACP the agent can read the worktree and write inside the write lease only. It may still
  have its own tools: **a spawned agent runs with your user's rights**, so confine it with the
  harness's own sandbox settings. soot's diff, protected paths and checks catch changes inside
  the worktree, not outside it.

## Untrusted content

Dependency results, earlier attempts and command output are passed on as fenced, untrusted
data with an injection scan (flags are audited). Permissions come only from the task; nothing
in untrusted text can widen scope, approve, or mark work verified.

## Credentials

Bring your own keys, read only by the provider adapters from environment variables
([providers](providers.md)). Reports and the audit log are redacted.

## Audit and state

- `SOOT_DATA_DIR/audit/<run>.jsonl` (mode 0600): worktrees, leases, attempts, scope violations,
  commands run or refused, approvals, verdicts, merges and working-tree updates, plus every
  routing decision and ACP model-route outcome (ADR-030).
- `soot.sqlite` stores the prompt, tasks, results, outcomes, provider cooldowns (provider id,
  reason, until, error detail) and per-attempt spend in plain text (no encryption at rest); the
  state directory is created with mode 0700. No credential is stored.

## Local dashboard (optional)

`soot dashboard` (ADR-031, ADR-038) is off unless you run it. It binds 127.0.0.1 only, verifies
the bound address, answers only requests with `Host: 127.0.0.1:<port>` or `localhost:<port>`
(other hosts get 421, against DNS rebinding), and sends a strict Content-Security-Policy. It
makes no outbound requests and never shows key values.

- **Access token.** Each start makes a new link, `http://127.0.0.1:<port>/?token=…` (256
  bits). It is printed only when output is a terminal; it is always written to
  `<dataDir>/dashboard-link-<port>.txt` (0600) and that file is removed when the dashboard
  stops (Ctrl-C or SIGTERM), so redirecting output to a log file does not copy the token there
  (ADR-039). `--open` opens it either way. Opening it sets an `HttpOnly; SameSite=Strict`
  session cookie and redirects to `/`. Without it the page is an access gate and the API
  answers 401. Scripts can send `Authorization: Bearer <token>`. Anyone who has the link can
  use the dashboard until it stops, so treat it like a password.
- **Read-only by default.** Plain `soot dashboard` cannot change anything. With
  `--agent api`, `--agent mock --mock-script <file>` or `--agent acp` it adds a prompt box that plans and runs
  prompts at once, inside the dashboard process (Ctrl-C stops those runs too).
- **Writes** need JSON, the exact loopback `Origin`, `Sec-Fetch-Site: same-origin` when sent,
  and the session's `X-Soot-CSRF` header. No CORS headers are sent.
- **Folders** come only from `soot dashboard allow <dir>`, stored in `<dataDir>/dashboard.json`
  (0600), never in a repository and never from the browser. The page sends an opaque id; a
  folder whose real path changed since it was allowed is refused.
- **Keys** appear only as variable names with `set` or `missing`.
- **Approvals** inside a dashboard run are refused, including updating your working tree:
  the result stays on `soot/<run>/integration` for you to merge. Starting it with `--apply`
  pre-approves only that one step, and only for a fully verified result on a clean tree.

## Direct-API runner (`--agent api`, ADR-039)

- Each task's routed model gets the task, its allowed and readable files (current contents),
  and earlier attempts' findings. It never gets the original prompt, other tasks' transcripts,
  keys, or a shell: it can only return whole-file contents.
- Every returned path must stay inside the task's worktree (no absolute paths, `..`, `.git`
  or symlinks); one bad path fails the attempt and nothing is written. soot's usual scope,
  protected-path and check rules then apply before anything is merged.
- File contents are sent to the provider you configured for that model. Do not route tasks
  over files you would not send to that provider.

## Known limits

- **No OS sandbox.** Worktrees isolate git state, not processes. A runner that writes outside
  its worktree is not seen in the diff; real runners must be confined by the host harness or a
  sandbox. Check commands also run unsandboxed.
- Allowing an executable such as `node` allows whatever arguments the config gives it.
- Injection detection is heuristic.
- See [`TECHNICAL_DEBT.md`](../project/TECHNICAL_DEBT.md).

Report vulnerabilities as described in [`SECURITY.md`](../../SECURITY.md).
