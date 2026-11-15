import * as acp from '@agentclientprotocol/sdk';
import { killProcessTree, unsandboxed, type Sandbox } from '@soot/agent-runtime';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { AcpConnector, AcpEndpoint } from './runner.js';

/*
 * Spawn a user-configured ACP agent command and talk ACP over its stdio (newline-delimited
 * JSON-RPC, the protocol's stdio transport). soot never chooses, searches for, or installs a
 * command: the user names it in their config. No shell is used. The environment is scrubbed;
 * only variables the user lists in `passEnv` (for example the harness's own sign-in location)
 * are passed on. ADR-051: the process runs under the configured process sandbox (its own tools
 * then inherit it); credential-like variable names are stripped again at that layer.
 */

export interface AcpAgentCommand {
  /** Executable (absolute path or a name on PATH). */
  readonly command: string;
  readonly args?: readonly string[];
  /** Extra environment variable NAMES to pass through from soot's environment. */
  readonly passEnv?: readonly string[];
}

const BASE_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'SHELL'];
const STDERR_TAIL = 4000;

export function agentEnvironment(
  spec: AcpAgentCommand,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...BASE_ENV, ...(spec.passEnv ?? [])]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export function describeCommand(spec: AcpAgentCommand): string {
  return [spec.command, ...(spec.args ?? [])].join(' ');
}

export interface SpawnAcpOptions {
  /** Process sandbox (ADR-051). Default: the `none` fallback (no OS isolation). */
  readonly sandbox?: Sandbox;
}

/** Connector that spawns `spec` once per attempt, in the task's worktree. */
export function spawnAcpAgent(
  spec: AcpAgentCommand,
  env: NodeJS.ProcessEnv = process.env,
  options: SpawnAcpOptions = {},
): AcpConnector {
  if (spec.command.trim() === '' || /[\n\r\0]/.test(spec.command)) {
    throw new Error('ACP agent command must be a single executable');
  }
  const sandbox = options.sandbox ?? unsandboxed();
  return (cwd: string): AcpEndpoint => {
    if (!isAbsolute(cwd)) throw new Error(`ACP agent cwd must be absolute: ${cwd}`);
    // Throws when the sandbox is blocked or the cwd is not a task worktree.
    const prepared = sandbox.prepare([spec.command, ...(spec.args ?? [])], {
      cwd,
      env: agentEnvironment(spec, env),
    });
    const child = spawn(prepared.command, [...prepared.args], {
      cwd,
      env: prepared.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        prepared.cleanup();
        resolve();
      });
      child.once('error', (error) => {
        stderr += `\n${error.message}`;
        resolve();
      });
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    return {
      target: stream,
      label: `${describeCommand(spec)} [${prepared.backend === 'none' ? 'no OS sandbox' : `sandbox ${prepared.backend}`}]`,
      diagnostics: () => stderr,
      close: async () => {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) {
          const timer = setTimeout(() => child.kill('SIGTERM'), 500);
          const hard = setTimeout(() => {
            killProcessTree(child);
          }, 2000);
          await exited;
          clearTimeout(timer);
          clearTimeout(hard);
        }
        // Nothing the agent started in its process group outlives the attempt.
        killProcessTree(child);
      },
    };
  };
}
