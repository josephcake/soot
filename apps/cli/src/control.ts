import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Cross-process run control. A running `soot run` holds `<dataDir>/control/<run>.lock` (its pid)
 * and polls for `<run>.stop`; `soot stop <run>` only writes that request file. Nothing is
 * killed: the run aborts its own agents and cleans up (M4-06, M5). `soot stop <run> --task <id>`
 * writes `<run>.stop-task.<id>`; the run cancels that one task (M7 task cancellation).
 */

const dirOf = (dataDir: string) => join(dataDir, 'control');
const lockPath = (dataDir: string, runId: string) => join(dirOf(dataDir), `${runId}.lock`);
const stopPath = (dataDir: string, runId: string) => join(dirOf(dataDir), `${runId}.stop`);
const TASK_STOP = '.stop-task.';
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

/** Ask a running run to cancel one task (its dependents are skipped; other tasks continue). */
export function requestTaskStop(dataDir: string, runId: string, taskId: string): boolean {
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
  if (runningInfo(dataDir, runId) === null) return false;
  writeFileSync(join(dirOf(dataDir), `${runId}${TASK_STOP}${taskId}`), new Date().toISOString(), {
    mode: 0o600,
  });
  return true;
}

function taskStops(dataDir: string, runId: string): string[] {
  const prefix = `${runId}${TASK_STOP}`;
  return readdirSync(dirOf(dataDir))
    .filter((f) => f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    .filter((id) => TASK_ID.test(id));
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
  onTaskStop?: (taskId: string) => void,
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
  const clearTaskStops = () => {
    for (const id of taskStops(dataDir, runId)) {
      rmSync(join(dirOf(dataDir), `${runId}${TASK_STOP}${id}`), { force: true });
    }
  };
  clearTaskStops();
  const timer = setInterval(() => {
    if (existsSync(stopPath(dataDir, runId))) {
      stopped = true;
      controller.abort();
    }
    for (const id of taskStops(dataDir, runId)) {
      rmSync(join(dirOf(dataDir), `${runId}${TASK_STOP}${id}`), { force: true });
      onTaskStop?.(id);
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
      clearTaskStops();
    },
  };
}
