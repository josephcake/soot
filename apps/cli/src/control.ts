import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Cross-process run control. A running `soot run` holds `<dataDir>/control/<run>.lock` (its pid)
 * and polls for `<run>.stop`; `soot stop <run>` only writes that request file. Nothing is
 * killed: the run aborts its own agents and cleans up (M4-06, M5).
 */

const dirOf = (dataDir: string) => join(dataDir, 'control');
const lockPath = (dataDir: string, runId: string) => join(dirOf(dataDir), `${runId}.lock`);
const stopPath = (dataDir: string, runId: string) => join(dirOf(dataDir), `${runId}.stop`);

interface LockInfo {
  readonly pid: number;
  readonly startedAt: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence probe only, sends nothing
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function runningInfo(dataDir: string, runId: string): LockInfo | null {
  const path = lockPath(dataDir, runId);
  if (!existsSync(path)) return null;
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
    return alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

export function requestStop(dataDir: string, runId: string): boolean {
  if (runningInfo(dataDir, runId) === null) return false;
  writeFileSync(stopPath(dataDir, runId), new Date().toISOString(), { mode: 0o600 });
  return true;
}

export interface RunControl {
  readonly signal: AbortSignal;
  readonly stopRequested: () => boolean;
  release(): void;
}

export function holdRun(
  dataDir: string,
  runId: string,
  outer?: AbortSignal,
  pollMs = 200,
): RunControl {
  mkdirSync(dirOf(dataDir), { recursive: true, mode: 0o700 });
  if (runningInfo(dataDir, runId) !== null) throw new Error(`run ${runId} is already running`);
  rmSync(stopPath(dataDir, runId), { force: true });
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(lockPath(dataDir, runId), JSON.stringify(info), { mode: 0o600 });
  const controller = new AbortController();
  let stopped = false;
  const onOuter = () => {
    controller.abort();
  };
  outer?.addEventListener('abort', onOuter, { once: true });
  if (outer?.aborted === true) controller.abort();
  const timer = setInterval(() => {
    if (existsSync(stopPath(dataDir, runId))) {
      stopped = true;
      controller.abort();
    }
  }, pollMs);
  timer.unref();
  return {
    signal: controller.signal,
    stopRequested: () => stopped,
    release: () => {
      clearInterval(timer);
      outer?.removeEventListener('abort', onOuter);
      rmSync(lockPath(dataDir, runId), { force: true });
      rmSync(stopPath(dataDir, runId), { force: true });
    },
  };
}
