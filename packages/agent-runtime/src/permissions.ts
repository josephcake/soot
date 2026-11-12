/*
 * Approvals and task permissions (Milestone 5, ADR-018: never auto-approve).
 *
 * soot never answers an approval request itself. A request either waits for a person
 * (`InteractiveApprovalGate`, the task pauses) or, when the run is unattended, comes back
 * `unavailable` and the task is refused. There is deliberately no "approve all" gate.
 */

export const APPROVAL_ACTIONS = [
  /** Deleting files in the task's worktree. */
  'delete-files',
  /** Running a command that changes state outside the worktree or is irreversible. */
  'destructive-command',
  /** Writing a path outside the task's write lease. */
  'write-outside-scope',
  /** Fast-forwarding the user's working tree to the integrated result. */
  'integrate-into-working-tree',
  /** A harness agent (over ACP) asks permission for one of its own tool calls. */
  'harness-permission',
] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export interface ApprovalRequest {
  /** Task asking, or `null` for run-level operations (integration). */
  readonly taskId: string | null;
  readonly action: ApprovalAction;
  /** What exactly would happen (paths, command, commit). Shown to the person approving. */
  readonly detail: string;
}

/** `unavailable`: nobody can answer (unattended run, or the run was cancelled while waiting). */
export type ApprovalDecision = 'approved' | 'denied' | 'unavailable';

export interface ApprovalGate {
  readonly mode: 'interactive' | 'unattended';
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
}

/** Unattended runs: nobody can approve, so every request is `unavailable` (the task is refused). */
export const UNATTENDED_APPROVALS: ApprovalGate = Object.freeze({
  mode: 'unattended' as const,
  request: () => Promise.resolve<ApprovalDecision>('unavailable'),
});

export interface PendingApproval {
  readonly id: number;
  readonly request: ApprovalRequest;
  readonly requestedAt: number;
}

/**
 * A person answers each request (a CLI prompt, an IDE dialog, a host-harness approval). Until
 * then the requesting task waits. Aborting the signal resolves the request as `unavailable`.
 */
export class InteractiveApprovalGate implements ApprovalGate {
  readonly mode = 'interactive' as const;
  readonly #pending = new Map<
    number,
    { readonly entry: PendingApproval; readonly resolve: (d: ApprovalDecision) => void }
  >();
  readonly #listeners: ((pending: PendingApproval) => void)[] = [];
  #nextId = 1;

  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (signal?.aborted === true) return Promise.resolve('unavailable');
    return new Promise<ApprovalDecision>((resolve) => {
      const entry: PendingApproval = { id: this.#nextId++, request, requestedAt: Date.now() };
      const onAbort = () => {
        this.#pending.delete(entry.id);
        resolve('unavailable');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(entry.id, {
        entry,
        resolve: (decision) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(decision);
        },
      });
      for (const listener of this.#listeners) listener(entry);
    });
  }

  /** Requests waiting for an answer, oldest first. */
  pending(): PendingApproval[] {
    return [...this.#pending.values()].map((p) => p.entry);
  }

  /** Called when a new request starts waiting. */
  onRequest(listener: (pending: PendingApproval) => void): void {
    this.#listeners.push(listener);
  }

  /** A person's answer. Only `approved` or `denied`; soot cannot answer for them. */
  answer(id: number, decision: 'approved' | 'denied'): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) throw new Error(`no pending approval #${String(id)}`);
    this.#pending.delete(id);
    pending.resolve(decision);
  }
}

/** Workspace a write task may change: its own worktree, limited to its write lease. */
export interface TaskWorkspace {
  /** Absolute path of the task's worktree (a soot-owned git worktree). */
  readonly root: string;
  /** Declared write set (paths relative to `root`; directories end with `/`). */
  readonly writeScope: readonly string[];
}

/** What a runner may ask the host for while working on a task. */
export interface TaskPermissions {
  /** Ask a person to approve an action. Never answered by soot itself. */
  requestApproval(
    request: Omit<ApprovalRequest, 'taskId'>,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
}
