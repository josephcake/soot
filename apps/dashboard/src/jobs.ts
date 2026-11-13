import { randomBytes } from 'node:crypto';

/*
 * Prompt jobs for the dashboard composer (ADR-038). A job is one submitted prompt: it plans, then
 * runs straight away (no approve step), inside this dashboard process. Closing the dashboard
 * aborts every job it started. The dashboard never sees a project path from the browser: it
 * passes the opaque project id to the agent, which resolves it against the CLI-written allowlist.
 *
 * The agent is implemented by the CLI (`soot dashboard --agent mock|acp`); without one the
 * dashboard is read-only and no job can be created.
 */

/** UTF-8 bytes, the same limit as the planner's prompt intake. */
export const MAX_PROMPT_BYTES = 256 * 1024;

export interface RunnerInfo {
  readonly kind: 'mock' | 'acp';
  /** Honest label, e.g. "mock (test double)". */
  readonly label: string;
}

export interface PlannerInfo {
  readonly model: string | null;
  readonly status: 'usable' | 'unusable' | 'not-configured';
  readonly reason: string | null;
  /** Rough planning cost per prompt from list prices (not a quote); `null` when unpriced. */
  readonly roughCostUsd: number | null;
}

export interface DashboardProject {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly config: {
    readonly ok: boolean;
    readonly policy: string | null;
    readonly checks: readonly string[];
    readonly error: string | null;
  };
  readonly planner: PlannerInfo;
  readonly runnerLabel: string;
}

export interface KeyStatus {
  readonly project: { readonly id: string; readonly label: string };
  readonly modelsFile: string | null;
  readonly models: number;
  readonly unpriced: readonly string[];
  readonly planner: PlannerInfo;
  /** Variable names and set / missing only. Values never leave the agent. */
  readonly providers: readonly {
    readonly id: string;
    readonly keyVar: string | null;
    readonly key: 'set' | 'missing' | 'none-needed';
    readonly usedBy: readonly string[];
  }[];
  readonly runner: RunnerInfo;
}

/** JSON-safe plan preview (`PlanPreview` from the engine). */
export type PlanPreviewJson = Readonly<Record<string, unknown>>;

export interface RunResult {
  readonly ok: boolean;
  /** Report status: complete | incomplete | cancelled; `null` when the run failed to start. */
  readonly status: string | null;
  readonly message: string;
}

export type PlanResult =
  | {
      readonly ok: true;
      readonly preview: PlanPreviewJson;
      /** Run the plan. Single use. `onRunStarted` fires once the run is recorded. */
      start(signal: AbortSignal, onRunStarted: (runId: string) => void): Promise<RunResult>;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface DashboardAgent {
  readonly runner: RunnerInfo;
  projects(): DashboardProject[];
  keyStatus(projectId: string): KeyStatus | null;
  plan(projectId: string, prompt: string, signal: AbortSignal): Promise<PlanResult>;
  stop(runId: string, taskId?: string): Promise<{ readonly ok: boolean; readonly message: string }>;
}

export type JobState = 'planning' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobView {
  readonly id: string;
  readonly state: JobState;
  readonly project: { readonly id: string; readonly label: string };
  readonly prompt: string;
  readonly createdAt: string;
  readonly runner: RunnerInfo;
  readonly preview: PlanPreviewJson | null;
  readonly runId: string | null;
  readonly result: RunResult | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly stopRequested: boolean;
}

interface Job {
  view: JobView;
  readonly controller: AbortController;
  done: Promise<void>;
}

export interface SubmitError {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

const MAX_JOBS = 50;
const IDEMPOTENCY_MS = 10 * 60_000;

export function promptProblem(prompt: unknown): SubmitError | null {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, status: 422, code: 'prompt_invalid', message: 'Write a prompt first.' };
  }
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
    return {
      ok: false,
      status: 413,
      code: 'prompt_too_long',
      message: `The prompt is over ${String(MAX_PROMPT_BYTES / 1024)} KB.`,
    };
  }
  return null;
}

export class JobStore {
  readonly #agent: DashboardAgent;
  readonly #jobs = new Map<string, Job>();
  readonly #idem = new Map<string, { id: string; at: number }>();
  #closed = false;

  constructor(agent: DashboardAgent) {
    this.#agent = agent;
  }

  list(): JobView[] {
    return [...this.#jobs.values()].map((j) => j.view).reverse();
  }

  get(id: string): JobView | null {
    return this.#jobs.get(id)?.view ?? null;
  }

  /** Whether `runId` was started by a job of this dashboard (only those can be stopped here). */
  ownsRun(runId: string): boolean {
    return [...this.#jobs.values()].some((j) => j.view.runId === runId);
  }

  submit(
    projectId: unknown,
    prompt: unknown,
    idempotencyKey: string | null,
  ): { ok: true; job: JobView; replay: boolean } | SubmitError {
    if (this.#closed) {
      return {
        ok: false,
        status: 503,
        code: 'closing',
        message: 'The dashboard is shutting down.',
      };
    }
    const now = Date.now();
    for (const [k, v] of this.#idem) if (now - v.at > IDEMPOTENCY_MS) this.#idem.delete(k);
    if (idempotencyKey !== null) {
      const seen = this.#idem.get(idempotencyKey);
      const job = seen === undefined ? undefined : this.#jobs.get(seen.id);
      if (job !== undefined) return { ok: true, job: job.view, replay: true };
    }
    if (typeof projectId !== 'string') {
      return { ok: false, status: 404, code: 'unknown_project', message: 'Pick a project.' };
    }
    const problem = promptProblem(prompt);
    if (problem !== null) return problem;
    const project = this.#agent.projects().find((p) => p.id === projectId);
    if (project === undefined) {
      return {
        ok: false,
        status: 404,
        code: 'unknown_project',
        message: 'That project is not in the allowlist. Add it with "soot dashboard allow <dir>".',
      };
    }
    if (!project.config.ok) {
      return {
        ok: false,
        status: 422,
        code: 'config_invalid',
        message: project.config.error ?? 'soot.config.json does not load.',
      };
    }
    const busy = [...this.#jobs.values()].find(
      (j) =>
        j.view.project.id === projectId &&
        (j.view.state === 'planning' || j.view.state === 'running'),
    );
    if (busy !== undefined) {
      return {
        ok: false,
        status: 409,
        code: 'project_busy',
        message: `Another prompt is working in ${project.label}. Wait for it, or stop it.`,
      };
    }
    const id = `job_${randomBytes(8).toString('hex')}`;
    const controller = new AbortController();
    const job: Job = {
      view: {
        id,
        state: 'planning',
        project: { id: project.id, label: project.label },
        prompt: prompt as string,
        createdAt: new Date().toISOString(),
        runner: this.#agent.runner,
        preview: null,
        runId: null,
        result: null,
        error: null,
        stopRequested: false,
      },
      controller,
      done: Promise.resolve(),
    };
    this.#jobs.set(id, job);
    if (idempotencyKey !== null) this.#idem.set(idempotencyKey, { id, at: now });
    this.#trim();
    job.done = this.#drive(job, project.id, prompt as string);
    return { ok: true, job: job.view, replay: false };
  }

  async #drive(job: Job, projectId: string, prompt: string): Promise<void> {
    const set = (patch: Partial<JobView>) => {
      job.view = { ...job.view, ...patch };
    };
    const { signal } = job.controller;
    let planned: PlanResult;
    try {
      planned = await this.#agent.plan(projectId, prompt, signal);
    } catch (error) {
      planned = { ok: false, code: 'planning_failed', message: (error as Error).message };
    }
    if (signal.aborted) {
      set({
        state: 'cancelled',
        error: { code: 'cancelled', message: 'Stopped while planning. Nothing ran.' },
      });
      return;
    }
    if (!planned.ok) {
      set({ state: 'failed', error: { code: planned.code, message: planned.message } });
      return;
    }
    set({ state: 'running', preview: planned.preview });
    let result: RunResult;
    try {
      result = await planned.start(signal, (runId) => {
        set({ runId });
      });
    } catch (error) {
      result = { ok: false, status: null, message: (error as Error).message };
    }
    const cancelled = result.status === 'cancelled' || job.view.stopRequested;
    set({
      state: cancelled ? 'cancelled' : result.ok ? 'done' : 'failed',
      result,
      error: result.ok ? null : { code: 'run_failed', message: result.message },
    });
  }

  /** Stop a job: abort planning, or ask the run to stop (work merged before stays merged). */
  async cancel(id: string): Promise<JobView | null> {
    const job = this.#jobs.get(id);
    if (job === undefined) return null;
    const { state, runId } = job.view;
    if (state !== 'planning' && state !== 'running') return job.view;
    job.view = { ...job.view, stopRequested: true };
    if (runId !== null) {
      const sent = await this.#agent.stop(runId);
      if (!sent.ok) job.controller.abort();
    } else {
      job.controller.abort();
    }
    return job.view;
  }

  #trim(): void {
    for (const [id, job] of this.#jobs) {
      if (this.#jobs.size <= MAX_JOBS) break;
      if (job.view.state !== 'planning' && job.view.state !== 'running') this.#jobs.delete(id);
    }
  }

  /** Abort every live job and wait (bounded) for runs to release their locks. */
  async close(waitMs = 15_000): Promise<void> {
    this.#closed = true;
    const live = [...this.#jobs.values()].filter(
      (j) => j.view.state === 'planning' || j.view.state === 'running',
    );
    for (const j of live) {
      j.view = { ...j.view, stopRequested: true };
      j.controller.abort();
    }
    await Promise.race([
      Promise.all(live.map((j) => j.done)),
      new Promise((r) => setTimeout(r, waitMs).unref()),
    ]);
  }
}
