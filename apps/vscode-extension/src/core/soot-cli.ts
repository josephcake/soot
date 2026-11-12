import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/*
 * The extension's only way into soot: run the soot CLI as a child process and read its JSON.
 * The extension contains no orchestration (ADR-029); the engine stays independent of the IDE.
 *
 * Runs started here are unattended (stdin is closed, not a terminal): soot never asks the
 * extension to approve anything, so approval-needing work is refused and the result waits on
 * `soot/<run>/integration`. The extension never answers approvals and has no "approve all".
 */

export type AgentSetting = 'none' | 'mock' | 'acp';

export interface SootCliOptions {
  /** Node.js executable (not the editor's own Electron binary). */
  readonly nodePath: string;
  /** Absolute path to `apps/cli/dist/bin.js`. */
  readonly cliPath: string;
  /** Workspace folder: the repository soot runs in. */
  readonly cwd: string;
  /** `SOOT_DATA_DIR`, or `null` for soot's default. */
  readonly dataDir: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CliResult {
  readonly code: number;
  readonly data: Record<string, unknown> | null;
  readonly stderr: string;
}

export interface RunHandle {
  readonly runId: string;
  readonly done: Promise<CliResult>;
}

export function newIdeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `ide-${stamp}-${randomBytes(2).toString('hex')}`;
}

export function agentArgs(agent: AgentSetting, mockScript: string): string[] {
  if (agent === 'mock') return ['--agent', 'mock', '--mock-script', mockScript];
  if (agent === 'acp') return ['--agent', 'acp'];
  return [];
}

function parseJson(stdout: string): Record<string, unknown> | null {
  if (stdout.trim() === '') return null;
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class SootCli {
  readonly #o: SootCliOptions;

  constructor(options: SootCliOptions) {
    this.#o = options;
  }

  #spawn(args: readonly string[], onStderr?: (line: string) => void): Promise<CliResult> {
    const env: NodeJS.ProcessEnv = { ...(this.#o.env ?? process.env) };
    if (this.#o.dataDir !== null) env.SOOT_DATA_DIR = this.#o.dataDir;
    return new Promise((resolve) => {
      const child = spawn(this.#o.nodePath, [this.#o.cliPath, ...args, '--json'], {
        cwd: this.#o.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        stdout += c;
      });
      let partial = '';
      child.stderr.on('data', (c: string) => {
        stderr += c;
        partial += c;
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const l of lines) onStderr?.(l);
      });
      child.on('error', (error) => {
        resolve({ code: -1, data: null, stderr: `${stderr}\n${error.message}` });
      });
      child.on('close', (code) => {
        const data = parseJson(stdout);
        resolve({ code: code ?? -1, data, stderr });
      });
    });
  }

  status(runId?: string): Promise<CliResult> {
    return this.#spawn(runId === undefined ? ['status'] : ['status', runId]);
  }

  cost(runId: string): Promise<CliResult> {
    return this.#spawn(['cost', runId]);
  }

  stop(runId: string, taskId?: string): Promise<CliResult> {
    return this.#spawn(taskId === undefined ? ['stop', runId] : ['stop', runId, '--task', taskId]);
  }

  /** Start `soot run` in the background; progress lines arrive on `onProgress`. */
  run(
    prompt: string,
    agent: AgentSetting,
    mockScript: string,
    onProgress?: (line: string) => void,
    runId = newIdeRunId(),
  ): RunHandle {
    const done = this.#spawn(
      ['run', prompt, ...agentArgs(agent, mockScript), '--run-id', runId],
      onProgress,
    );
    return { runId, done };
  }
}
