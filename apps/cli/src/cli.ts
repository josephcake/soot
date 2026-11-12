import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { createLogger } from '@soot/core';
// Type only (erased at build): the dashboard module itself is loaded lazily in `soot dashboard`.
import type * as Dashboard from '@soot/dashboard';
import type { CommandOutput } from '@soot/harness-adapters';
import { interactiveApprovals, unattendedApprovals } from './approvals.js';
import { SootEngine, runtimeFromEnv, type AgentMode } from './engine.js';
import { SKILL_TARGETS, installSkill, type SkillTarget } from './install-skill.js';
import { VERSION } from './version.js';

export { VERSION };

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly stdin: Readable;
  readonly stdinIsTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /** `soot dashboard --open` only; defaults to the platform's browser opener. */
  readonly openUrl?: (url: string) => void;
}

export const USAGE = `soot ${VERSION} — task-level orchestration for coding harnesses

Usage:
  soot run "<prompt>" [--repo <dir>] [--agent mock --mock-script <file> | --agent acp] [--run-id <id>] [--interactive]
  soot status [<run-id>]
  soot cost [<run-id>]
  soot models
  soot config [--repo <dir>]
  soot stop <run-id> [--task <task-id>]
  soot mcp [--agent mock --mock-script <file> | --agent acp]   MCP server on stdio (unattended)
  soot install-skill [--target <dir>] [--harness agents,claude,grok] [--force]
  soot dashboard [--port <n>] [--open]   optional local dashboard on 127.0.0.1 (default port 8787)

Global options:
  --config <file>   project config (default <repo>/soot.config.json)
  --data-dir <dir>  state directory (default $SOOT_DATA_DIR or ~/.soot)
  --json            print JSON instead of text (no log lines on stderr)

Environment: SOOT_DATA_DIR (state directory), SOOT_LOG_LEVEL (silent|error|warn|info|debug,
default info; log lines go to stderr). No .env file is read.

Agents: --agent mock runs a scripted test double (no model is called). --agent acp runs each
task through the ACP agent command configured as "acpAgent" in soot.config.json (generic ACP
driver; no harness is verified). Decomposition uses recorded fixtures only. soot never approves anything for you: with --interactive (or a terminal)
it asks; otherwise approval-needing work is refused.

Dashboard: off unless you run "soot dashboard". It binds 127.0.0.1 only, fails if the port is
taken (no other port is tried), is read-only, and opens a browser only with --open. Every
other command is headless and never loads it.

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
  if (agent !== 'mock') throw new UsageError(`unknown agent "${agent}" (available: mock, acp)`);
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
    const interactive = command === 'run' && (values.interactive === true || io.stdinIsTTY);
    const approvals = interactive
      ? interactiveApprovals({ input: io.stdin, ask: io.stderr })
      : { gate: unattendedApprovals(), close: () => undefined };
    const engine = new SootEngine({
      cwd: io.cwd,
      dataDir,
      ...(values.config === undefined ? {} : { configPath: values.config }),
      agent,
      approvals: approvals.gate,
      gitEnv: { ...io.env },
      agentEnv: { ...io.env },
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
          if (rest.length > 0) throw new UsageError('dashboard takes no arguments');
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
          const server = await dashboard.startDashboard({ source: engine, port });
          print(
            io,
            {
              ok: true,
              text: `soot dashboard: ${server.url} (127.0.0.1 only, read-only; Ctrl-C stops it)`,
              data: {
                url: server.url,
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
