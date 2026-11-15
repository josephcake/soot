import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { createLogger } from '@soot/core';
// Type only (erased at build): the dashboard module itself is loaded lazily in `soot dashboard`.
import type * as Dashboard from '@soot/dashboard';
import type { CommandOutput } from '@soot/harness-adapters';
import { interactiveApprovals, unattendedApprovals, withApply } from './approvals.js';
import { allowProject, disallowProject, projectId, readAllowlist } from './dashboard-allowlist.js';
import type { createComposerAgent } from './dashboard-agent.js';
import { SootEngine, runtimeFromEnv, type AgentMode } from './engine.js';
import { SKILL_TARGETS, installSkill, type SkillTarget } from './install-skill.js';
import { formatInitResult, initConfig } from './init-config.js';
import { VERSION } from './version.js';

export { VERSION };

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdin: Readable;
  readonly stdinIsTTY: boolean;
  /** Whether stdout is a terminal; the dashboard prints its access link only then. */
  readonly stdoutIsTTY?: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /** `soot dashboard --open` only; defaults to the platform's browser opener. */
  readonly openUrl?: (url: string) => void;
}

export const USAGE = `soot ${VERSION} — task-level orchestration for coding harnesses

Usage:
  soot run "<prompt>" [--repo <dir>] [--agent api | --agent mock --mock-script <file> | --agent acp | --agent claude-code | --agent codex] [--run-id <id>] [--interactive] [--apply]
  soot resume <run-id> | --latest [--agent ...] [--repo <dir>] [--allow-config-change] [--retry-blocked] [--interactive] [--apply]
                                continue an interrupted, stopped or blocked run where it left off
  soot status [<run-id>]
  soot cost [<run-id>]
  soot models
  soot config [--repo <dir>]
  soot stop <run-id> [--task <task-id>]
  soot mcp [--agent mock --mock-script <file> | --agent acp | --agent claude-code | --agent codex]   MCP server on stdio (unattended)
  soot init [--repo <dir>] [--force] [--decomposer auto | --decomposer <provider/modelId>]
                                write soot.config.json from discovered project checks
  soot install-skill [--target <dir>] [--harness agents,claude,grok] [--force]
  soot dashboard [--port <n>] [--open] [--agent api | --agent mock --mock-script <file> | --agent acp | --agent claude-code | --agent codex] [--apply]
                                optional local dashboard on 127.0.0.1 (default port 8787)
  soot dashboard allow <dir> | disallow <dir> | list   folders the dashboard may run prompts in

Global options:
  --config <file>   project config (default <repo>/soot.config.json)
  --data-dir <dir>  state directory (default $SOOT_DATA_DIR or ~/.soot)
  --json            print JSON instead of text (no log lines on stderr)

Environment: SOOT_DATA_DIR (state directory), SOOT_LOG_LEVEL (silent|error|warn|info|debug,
default info; log lines go to stderr). No .env file is read.

Agents: --agent api sends each task to the model the router picked, through soot's provider
adapters, and applies the edits it returns (targeted replacements or whole files, all or
nothing) in the task's worktree (keys come from the variables your models file names). --agent mock runs a scripted test double (no model is
called). --agent acp runs each task through the ACP agent command configured as "acpAgent" in
soot.config.json (generic ACP driver; no harness is verified). --agent claude-code and --agent
codex run each task through the ACP adapter you installed and signed in to, named by absolute
path in "harnesses" (runner profiles over the same driver, tested against simulated adapters
only; soot never signs in and refuses bypass modes). soot never approves anything for
you: with --interactive (or a terminal) it asks; otherwise approval-needing work is refused.
--apply pre-approves one thing only: fast-forwarding your branch to the result once every task
is verified and final validation passed (refused if your working tree is dirty).

Resume: "soot resume <run-id>" continues a run from soot.sqlite instead of starting over. Done
tasks are kept; unfinished ones run again on fresh worktrees; blocked ones (sign-in, approval,
budget, escalation) stay blocked unless you pass --retry-blocked; approvals are asked again. It
refuses a run another soot process is running, and refuses if the config, models, routes or
agent changed unless you pass --allow-config-change. A complete run is a no-op.

Decomposition: recorded fixtures. Prompts with no fixture go to the optional "decomposer"
model in soot.config.json, only when its key variable is set ("soot config" shows whether it
is usable). Without it, such prompts are refused.

Init: "soot init" writes soot.config.json from package.json scripts (test, lint, typecheck)
and other common markers (pytest, go test, cargo test). It sets allowedExecutables from those
commands. A decomposer is opt-in only: pass --decomposer auto or --decomposer <provider/modelId>,
or enter one when the command asks on a terminal. soot never writes a vendor default or a
decomposer model unless you asked. --force overwrites an existing file.

Dashboard: off unless you run "soot dashboard". It binds 127.0.0.1 only, fails if the port is
taken (no other port is tried), and opens a browser only with --open. Each start makes a new
access link with a token. On a terminal it is printed; otherwise (output redirected) it is only
written to a 0600 file in the data dir, and --open still opens it. Without --agent it is
read-only. With --agent it adds a prompt box that plans and runs prompts right away, only in
folders added with "soot dashboard allow <dir>" (never from the browser). Runs live in the
dashboard process: stopping the dashboard stops them. Approval-needing actions are refused;
with --apply a fully verified result is landed on the folder's branch.
Every other command is headless and never loads it.

Exit codes: 0 ok / run complete, 1 error, 2 run incomplete, 3 run cancelled.`;

const OPTIONS = {
  config: { type: 'string' },
  'data-dir': { type: 'string' },
  json: { type: 'boolean' },
  repo: { type: 'string' },
  agent: { type: 'string' },
  'mock-script': { type: 'string' },
  'run-id': { type: 'string' },
  task: { type: 'string' },
  interactive: { type: 'boolean' },
  target: { type: 'string' },
  harness: { type: 'string' },
  force: { type: 'boolean' },
  port: { type: 'string' },
  open: { type: 'boolean' },
  apply: { type: 'boolean' },
  latest: { type: 'boolean' },
  'allow-config-change': { type: 'boolean' },
  'retry-blocked': { type: 'boolean' },
  decomposer: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

class UsageError extends Error {}

function agentMode(agent: string | undefined, script: string | undefined): AgentMode {
  if (agent === undefined || agent === 'none') {
    if (script !== undefined) throw new UsageError('--mock-script needs --agent mock');
    return { kind: 'none' };
  }
  if (agent === 'acp') {
    if (script !== undefined) throw new UsageError('--mock-script is only for --agent mock');
    return { kind: 'acp' };
  }
  if (agent === 'claude-code' || agent === 'codex') {
    if (script !== undefined) throw new UsageError('--mock-script is only for --agent mock');
    return { kind: 'acp', harness: agent };
  }
  if (agent === 'api') {
    if (script !== undefined) throw new UsageError('--mock-script is only for --agent mock');
    return { kind: 'api' };
  }
  if (agent !== 'mock')
    throw new UsageError(
      `unknown agent "${agent}" (available: api, mock, acp, claude-code, codex)`,
    );
  if (script === undefined) throw new UsageError('--agent mock needs --mock-script <file>');
  return { kind: 'mock', script };
}

function print(io: CliIo, out: CommandOutput, asJson: boolean): void {
  if (asJson) io.stdout(`${JSON.stringify({ ok: out.ok, ...out.data }, null, 2)}\n`);
  else (out.ok ? io.stdout : io.stderr)(`${out.text}\n`);
}

function runExitCode(out: CommandOutput): number {
  if (!out.ok) return 1;
  const status = (out.data.report as { status?: string } | undefined)?.status;
  return status === 'complete' ? 0 : status === 'cancelled' ? 3 : 2;
}

/** Ask on a terminal whether to set an opt-in decomposer. Blank means fixtures only. */
async function askDecomposer(io: CliIo): Promise<string | undefined> {
  io.stderr(
    'Configure a decomposer model so prompts with no recorded fixture can be planned?\n' +
      'Enter a model reference (provider/modelId), "auto", or leave blank to skip: ',
  );
  const line = await new Promise<string>((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      buf += String(chunk);
      if (buf.includes('\n') || buf.includes('\r')) {
        io.stdin.off('data', onData);
        resolve(buf.split(/\r?\n/)[0] ?? '');
      }
    };
    if (io.stdin.readableEnded) {
      resolve('');
      return;
    }
    io.stdin.on('data', onData);
    io.stdin.once('end', () => {
      io.stdin.off('data', onData);
      resolve(buf.split(/\r?\n/)[0] ?? '');
    });
  });
  const trimmed = line.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Run the CLI. Returns the process exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`soot: ${(error as Error).message}\n\n${USAGE}\n`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.version === true) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (values.help === true || command === undefined || command === 'help') {
    io.stdout(`${USAGE}\n`);
    return command === undefined && values.help !== true ? 1 : 0;
  }
  const asJson = values.json === true;
  try {
    if (command !== 'dashboard' && (values.port !== undefined || values.open !== undefined))
      throw new UsageError('--port and --open are only for soot dashboard');
    // SOOT_DATA_DIR / SOOT_LOG_LEVEL (parseEnv). With --json, log lines are off so stdout and
    // stderr stay machine-readable; otherwise they go to stderr at SOOT_LOG_LEVEL.
    const runtime = runtimeFromEnv(io.env, io.cwd, values['data-dir']);
    const dataDir = runtime.dataDir;
    const log = createLogger(asJson ? 'silent' : runtime.logLevel, (line) => {
      io.stderr(`${line}\n`);
    });
    log.debug(
      `soot: debug: state dir ${dataDir} (from ${runtime.dataDirSource}); log level ${runtime.logLevel}; command ${command}`,
    );
    const agent = agentMode(values.agent, values['mock-script']);
    const runs = command === 'run' || command === 'resume';
    const interactive = runs && (values.interactive === true || io.stdinIsTTY);
    if (values.apply === true && !runs && command !== 'dashboard')
      throw new UsageError('--apply is only for soot run, soot resume and soot dashboard');
    if (values.apply === true && agent.kind === 'none' && command !== 'resume')
      throw new UsageError('--apply needs --agent');
    if (
      command !== 'resume' &&
      (values.latest !== undefined ||
        values['allow-config-change'] !== undefined ||
        values['retry-blocked'] !== undefined)
    )
      throw new UsageError(
        '--latest, --allow-config-change and --retry-blocked are only for soot resume',
      );
    if (values.decomposer !== undefined && command !== 'init')
      throw new UsageError('--decomposer is only for soot init');
    const base = interactive
      ? interactiveApprovals({ input: io.stdin, ask: io.stderr })
      : { gate: unattendedApprovals(), close: () => undefined };
    const approvals =
      values.apply === true ? { gate: withApply(base.gate), close: base.close } : base;
    const engine = new SootEngine({
      cwd: io.cwd,
      dataDir,
      ...(values.config === undefined ? {} : { configPath: values.config }),
      agent,
      approvals: approvals.gate,
      gitEnv: { ...io.env },
      agentEnv: { ...io.env },
      modelEnv: { ...io.env },
      // Sandbox host facts from the same environment (ADR-051): home is hidden from agents.
      sandboxHost: {
        home: io.env.HOME ?? homedir(),
        path: io.env.PATH ?? '',
      },
      log,
    });
    try {
      switch (command) {
        case 'run': {
          // The prompt is passed through verbatim, so it must be one (quoted) argument.
          if (rest.length !== 1) throw new UsageError('run needs exactly one quoted prompt');
          const prompt = rest[0] ?? '';
          if (prompt.trim() === '') throw new UsageError('run needs a prompt');
          const out = await engine.run(
            {
              prompt,
              ...(values.repo === undefined ? {} : { repo: values.repo }),
              ...(values['run-id'] === undefined ? {} : { runId: values['run-id'] }),
            },
            io.signal,
          );
          print(io, out, asJson);
          return runExitCode(out);
        }
        case 'resume': {
          if (rest.length > 1) throw new UsageError('resume takes one run id');
          const runId = rest[0];
          if ((runId === undefined) === (values.latest !== true))
            throw new UsageError('resume needs a run id or --latest (not both)');
          const out = await engine.resume(
            {
              ...(runId === undefined ? { latest: true } : { runId }),
              ...(values.repo === undefined ? {} : { repo: values.repo }),
              allowConfigChange: values['allow-config-change'] === true,
              retryBlocked: values['retry-blocked'] === true,
            },
            io.signal,
          );
          print(io, out, asJson);
          if (out.ok && out.data.noop === true) return 0;
          return runExitCode(out);
        }
        case 'status':
        case 'cost': {
          const out = await engine[command](rest[0]);
          print(io, out, asJson);
          return out.ok ? 0 : 1;
        }
        case 'models': {
          const out = await engine.models();
          print(io, out, asJson);
          return out.ok ? 0 : 1;
        }
        case 'config': {
          // Probe local runtimes first so `soot config` lists their models (ADR-045).
          await engine.probeLocalModels(values.repo);
          const out = engine.config(values.repo);
          print(io, out, asJson);
          return out.ok ? 0 : 1;
        }
        case 'stop': {
          if (rest[0] === undefined) throw new UsageError('stop needs a run id');
          const out = await engine.stop(rest[0], values.task);
          print(io, out, asJson);
          return out.ok ? 0 : 1;
        }
        case 'init': {
          if (rest.length > 0) throw new UsageError('init takes no positional arguments');
          if (values.agent !== undefined || values.apply === true)
            throw new UsageError('soot init does not take --agent or --apply');
          let decomposer = values.decomposer;
          if (decomposer === undefined && io.stdinIsTTY) {
            decomposer = await askDecomposer(io);
          }
          const result = initConfig({
            root: resolve(io.cwd, values.repo ?? '.'),
            force: values.force === true,
            ...(decomposer === undefined || decomposer.trim() === ''
              ? {}
              : { decomposer: decomposer.trim() }),
          });
          print(
            io,
            {
              ok: true,
              text: formatInitResult(result, io.cwd),
              data: {
                path: result.path,
                checks: result.discovery.checks.map((c) => ({
                  name: c.check.name,
                  kind: c.check.kind,
                  argv: [...c.check.argv],
                  source: c.source,
                })),
                notes: [...result.discovery.notes],
                allowedExecutables: [...result.config.allowedExecutables],
                decomposer: result.config.decomposer?.model ?? null,
              },
            },
            asJson,
          );
          return 0;
        }
        case 'install-skill': {
          const harnesses = (values.harness ?? Object.keys(SKILL_TARGETS).join(','))
            .split(',')
            .map((h) => h.trim()) as SkillTarget[];
          const unknown = harnesses.filter((h) => !(h in SKILL_TARGETS));
          if (unknown.length > 0) throw new UsageError(`unknown harness: ${unknown.join(', ')}`);
          const results = installSkill({
            target: resolve(io.cwd, values.target ?? '.'),
            harnesses,
            force: values.force === true,
          });
          const skipped = results.some((r) => r.action === 'skipped-different');
          print(
            io,
            {
              ok: !skipped,
              text: [
                ...results.map((r) => `${r.action}: ${r.path}`),
                ...(skipped
                  ? ['An existing different copy was kept; rerun with --force to replace it.']
                  : []),
              ].join('\n'),
              data: { results: results.map((r) => ({ ...r })) },
            },
            asJson,
          );
          return skipped ? 1 : 0;
        }
        case 'mcp': {
          const { serveMcpStdio } = await import('./mcp.js');
          await serveMcpStdio(engine);
          return 0;
        }
        case 'dashboard': {
          const [sub, dir, ...extra] = rest;
          if (sub !== undefined) {
            // Allowlist management: CLI only, never the browser (ADR-038).
            if (
              values.port !== undefined ||
              values.open !== undefined ||
              values.agent !== undefined ||
              values.apply !== undefined
            )
              throw new UsageError(`dashboard ${sub} takes no --port, --open, --agent or --apply`);
            if (sub === 'list') {
              if (dir !== undefined) throw new UsageError('dashboard list takes no arguments');
              const projects = readAllowlist(dataDir);
              print(
                io,
                {
                  ok: true,
                  text:
                    projects.length === 0
                      ? 'No folders allowed yet. Add one with: soot dashboard allow <dir>'
                      : [
                          'Folders the dashboard may run prompts in:',
                          ...projects.map((p) => `- ${p.path} (${projectId(p.path)})`),
                        ].join('\n'),
                  data: { projects: projects.map((p) => ({ ...p, id: projectId(p.path) })) },
                },
                asJson,
              );
              return 0;
            }
            if (sub !== 'allow' && sub !== 'disallow')
              throw new UsageError(`unknown dashboard command "${sub}" (allow, disallow, list)`);
            if (dir === undefined || extra.length > 0)
              throw new UsageError(`dashboard ${sub} needs exactly one folder`);
            if (sub === 'allow') {
              const entry = allowProject(dataDir, io.cwd, dir);
              print(
                io,
                {
                  ok: true,
                  text: `Allowed ${entry.path} for the dashboard prompt box (stored in ${dataDir}).`,
                  data: { project: { ...entry, id: projectId(entry.path) } },
                },
                asJson,
              );
              return 0;
            }
            const removed = disallowProject(dataDir, io.cwd, dir);
            print(
              io,
              {
                ok: removed,
                text: removed
                  ? `Removed ${dir} from the dashboard allowlist.`
                  : `${dir} was not allowed.`,
                data: { removed },
              },
              asJson,
            );
            return removed ? 0 : 1;
          }
          if (values.config !== undefined || values.repo !== undefined)
            throw new UsageError(
              "soot dashboard uses each allowed folder's own soot.config.json; --config and --repo do not apply",
            );
          // The optional dashboard is loaded here and only here (ADR-031).
          let dashboard: typeof Dashboard;
          try {
            dashboard = await import('@soot/dashboard');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
            throw new Error(
              'the optional @soot/dashboard package is not installed (headless commands do not need it)',
              { cause: error },
            );
          }
          let port: number;
          try {
            port = dashboard.parsePort(values.port);
          } catch (error) {
            throw new UsageError((error as Error).message);
          }
          // Writes only with an explicit runner, fixed for the life of this process.
          let composer: ReturnType<typeof createComposerAgent> | undefined;
          if (agent.kind !== 'none') {
            const { createComposerAgent: create } = await import('./dashboard-agent.js');
            composer = create({
              dataDir,
              agent:
                agent.kind === 'mock'
                  ? { kind: 'mock', script: resolve(io.cwd, agent.script) }
                  : agent,
              env: io.env,
              log,
              apply: values.apply === true,
            });
          }
          const server = await dashboard.startDashboard({
            source: engine,
            port,
            ...(composer === undefined ? {} : { agent: composer }),
          });
          const mode =
            composer === undefined
              ? 'read-only'
              : `prompt box on, runner: ${composer.runner.label}; runs stop when the dashboard stops`;
          // The access link holds the session token. Print it only to a terminal; when output
          // is redirected (a log file), write it to a 0600 file instead (ADR-039).
          const showLink = io.stdoutIsTTY === true;
          const { writeLinkFile, removeLinkFile } = await import('./dashboard-link.js');
          const linkFile = writeLinkFile(dataDir, server.address.port, server.url);
          const where = showLink
            ? `soot dashboard: ${server.url}\n  open this link (it holds an access token, new each start)`
            : `soot dashboard: ${server.baseUrl}\n  access link (with its token) is in ${linkFile} (0600); not printed because output is not a terminal${values.open === true ? '; opening it in your browser' : ''}`;
          print(
            io,
            {
              ok: true,
              text: `${where}; 127.0.0.1 only, ${mode}; Ctrl-C stops it`,
              data: {
                url: showLink ? server.url : server.baseUrl,
                linkFile,
                writes: composer !== undefined,
                runner: composer === undefined ? null : { ...composer.runner },
                address: server.address.address,
                family: server.address.family,
                port: server.address.port,
              },
            },
            asJson,
          );
          if (values.open === true) {
            if (io.openUrl !== undefined) io.openUrl(server.url);
            else {
              const { openInBrowser } = await import('./open-url.js');
              openInBrowser(server.url, (line) => {
                io.stderr(`${line}\n`);
              });
            }
          }
          await new Promise<void>((done) => {
            if (io.signal === undefined) return;
            if (io.signal.aborted) done();
            else
              io.signal.addEventListener(
                'abort',
                () => {
                  done();
                },
                { once: true },
              );
          });
          await server.close();
          removeLinkFile(linkFile);
          return 0;
        }
        default:
          throw new UsageError(`unknown command "${command}"`);
      }
    } finally {
      approvals.close();
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`soot: ${error.message}\n\n${USAGE}\n`);
    } else {
      io.stderr(`soot: ${(error as Error).message}\n`);
    }
    return 1;
  }
}
