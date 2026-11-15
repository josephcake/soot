import { spawn } from 'node:child_process';
import { findProgram, type Sandbox, type SandboxBackendName } from './sandbox.js';

/*
 * Run one command to completion under a `Sandbox` (ADR-051). These protections hold for every
 * backend, including the `none` fallback: argument vector only (never a shell), environment
 * with credential-like variables stripped, cwd pinned to the task worktree, a timeout, the
 * whole process group killed on timeout or cancellation, and a cap on total output (the
 * process is killed when it is exceeded; only a bounded tail is kept).
 */

export interface SandboxedRunOptions {
  readonly sandbox: Sandbox;
  /** The task worktree. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Kill the process once stdout+stderr exceed this many bytes. Default 16 MiB. */
  readonly maxOutputBytes?: number;
  /** Characters of output kept (the end). Default 64 KiB. */
  readonly keepChars?: number;
}

export type SandboxedRunKind =
  'exited' | 'timed-out' | 'cancelled' | 'output-limit' | 'not-found' | 'spawn-error' | 'blocked';

export interface SandboxedRunResult {
  readonly kind: SandboxedRunKind;
  /** Exit code when the process exited normally; otherwise null. */
  readonly exitCode: number | null;
  /** Last `keepChars` of stdout+stderr (raw; callers redact). */
  readonly output: string;
  readonly outputBytes: number;
  readonly durationMs: number;
  /** Backend the command ran under; null when it never started. */
  readonly backend: SandboxBackendName | null;
  readonly reason: string | null;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Kill `pid`'s whole process group (POSIX), falling back to the process itself. */
export function killProcessTree(child: {
  pid?: number | undefined;
  kill: (s?: NodeJS.Signals) => boolean;
}): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // group already gone or not a leader; fall through
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already exited
  }
}

export function runSandboxed(
  argv: readonly string[],
  options: SandboxedRunOptions,
): Promise<SandboxedRunResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const early = (kind: SandboxedRunKind, reason: string): Promise<SandboxedRunResult> =>
    Promise.resolve({
      kind,
      exitCode: null,
      output: '',
      outputBytes: 0,
      durationMs: elapsed(),
      backend: null,
      reason,
    });
  const { sandbox } = options;
  if (sandbox.blocked !== null) return early('blocked', sandbox.blocked);
  const program = argv[0] ?? '';
  if (findProgram(program, options.env.PATH) === null)
    return early('not-found', `${program} not found`);
  if (options.signal?.aborted === true) return early('cancelled', 'cancelled before start');
  let prepared;
  try {
    prepared = sandbox.prepare(argv, { cwd: options.cwd, env: options.env });
  } catch (error) {
    return early('blocked', (error as Error).message);
  }
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const keep = options.keepChars ?? 64 * 1024;
  const p = prepared;
  return new Promise((resolvePromise) => {
    let output = '';
    let bytes = 0;
    let ended: SandboxedRunKind | null = null;
    let reason: string | null = null;
    const child = spawn(p.command, [...p.args], {
      cwd: options.cwd,
      env: p.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const stop = (kind: SandboxedRunKind, why: string) => {
      if (ended !== null) return;
      ended = kind;
      reason = why;
      killProcessTree(child);
    };
    const timer = setTimeout(() => {
      stop('timed-out', `killed after ${String(options.timeoutMs)} ms`);
    }, options.timeoutMs);
    const onAbort = () => {
      stop('cancelled', 'killed on cancellation');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      output = (output + chunk.toString('utf8')).slice(-keep);
      if (bytes > maxBytes) stop('output-limit', `output exceeded ${String(maxBytes)} bytes`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const spawnError: { error: NodeJS.ErrnoException | null } = { error: null };
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError.error = error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      // The leader is gone; make sure nothing it started in its group survives.
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // no group left
        }
      }
      p.cleanup();
      const err = spawnError.error;
      const kind: SandboxedRunKind =
        ended ?? (err !== null ? (err.code === 'ENOENT' ? 'not-found' : 'spawn-error') : 'exited');
      resolvePromise({
        kind,
        exitCode: kind === 'exited' ? code : null,
        output,
        outputBytes: bytes,
        durationMs: elapsed(),
        backend: err === null ? p.backend : null,
        reason: reason ?? (err === null ? null : err.message),
      });
    });
  });
}
