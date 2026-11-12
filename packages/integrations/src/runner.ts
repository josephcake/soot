import type {
  AgentRunner,
  AgentTaskInput,
  ApprovalDecision,
  ApprovalGate,
  ApprovalRequest,
  TaskPermissions,
} from '@soot/agent-runtime';
import { buildAgentContext } from '@soot/context-manager';
import type { AuditLog } from '@soot/observability';
import {
  validateAgentResult,
  type AgentResult,
  type Evidence,
  type Finding,
  type Task,
  type TaskGraph,
} from '@soot/task-graph';
import { runCheck, type CheckCommand, type CheckEvidence, type CommandPolicy } from './commands.js';
import type { FileChange, Repository, Worktree } from './repository.js';
import { WriteLeases, withinScope } from './scope.js';

/*
 * IsolatedTaskRunner (M5-01, M5-04, M5-08, M5-09): wraps any AgentRunner so that each task
 * works in its own worktree under a write lease, and soot — not the agent — decides whether
 * the work is verified: it commits the worktree, reads the actual diff, checks it against the
 * write scope, asks a person before deletions, and runs the configured checks itself.
 *
 * The scheduler sees the outcome: a task whose diff or checks fail comes back `failed` (so the
 * M4 supervisor may retry or escalate it with the failure as context); a refused approval comes
 * back `blocked` (ADR-018: refused, never auto-approved). Agent-claimed evidence and patch
 * metadata are recorded but never trusted.
 */

export type Verdict =
  /** soot ran every required check on the real diff and all passed. */
  | 'verified'
  /** The agent did not report success (failed, blocked, cancelled). */
  | 'agent-not-succeeded'
  /** The diff touched files outside the write lease. */
  | 'out-of-scope'
  /** A write task produced no changes. */
  | 'no-changes'
  /** A required approval was denied or could not be collected. */
  | 'refused'
  /** A required check failed, timed out, was refused, or is unavailable. */
  | 'failed-validation'
  /** Read-only task with no soot-run checks: only the agent's word. Never counted as verified. */
  | 'unverified';

export interface TaskVerification {
  readonly taskId: string;
  readonly attempt: number;
  readonly model: string | null;
  readonly verdict: Verdict;
  readonly reason: string;
  readonly worktree: string | null;
  readonly branch: string | null;
  readonly base: string;
  readonly commit: string | null;
  readonly files: readonly FileChange[];
  readonly outOfScope: readonly string[];
  readonly checks: readonly CheckEvidence[];
  /** What the agent claimed (for the report); not used to decide anything. */
  readonly claims: {
    readonly status: AgentResult['status'] | 'invalid';
    readonly evidence: readonly Evidence[];
    readonly patchFiles: readonly string[];
  };
}

export interface IsolatedRunnerOptions {
  readonly repo: Repository;
  readonly graph: TaskGraph;
  readonly inner: AgentRunner;
  /** Project checks run for every task that changes files (tests, typecheck, lint). */
  readonly checks: readonly CheckCommand[];
  /** Extra acceptance commands per task id (also run for read-only tasks). */
  readonly acceptance?: Readonly<Record<string, readonly CheckCommand[]>>;
  readonly policy: CommandPolicy;
  readonly approvals: ApprovalGate;
  readonly audit: AuditLog;
  /**
   * Paths no task may change, even inside its write lease (e.g. the acceptance tests soot runs).
   * A change to one fails the attempt as `out-of-scope`.
   */
  readonly protectedPaths?: readonly string[];
}

const attemptLabel = (input: AgentTaskInput) => `${input.task.id} attempt ${String(input.attempt)}`;

export class IsolatedTaskRunner implements AgentRunner {
  readonly kind: string;
  readonly leases = new WriteLeases();
  /** Every attempt's verification, per task, oldest first. */
  readonly verifications = new Map<string, TaskVerification[]>();
  readonly #o: IsolatedRunnerOptions;

  constructor(options: IsolatedRunnerOptions) {
    this.#o = options;
    this.kind = `isolated(${options.inner.kind})`;
  }

  latest(taskId: string): TaskVerification | undefined {
    return this.verifications.get(taskId)?.at(-1);
  }

  async run(input: AgentTaskInput, signal: AbortSignal): Promise<unknown> {
    const { task } = input;
    const { audit } = this.#o;
    const lease = this.leases.acquire(task.id, task.files.write);
    if (!lease.ok) {
      audit.record('lease-refused', task.id, { heldBy: lease.heldBy, paths: [...lease.paths] });
      throw new Error(`write lease on ${lease.paths.join(', ')} is held by ${lease.heldBy}`);
    }
    audit.record('lease-acquired', task.id, { paths: [...task.files.write] });
    try {
      return await this.#run(input, signal);
    } finally {
      this.leases.release(task.id);
      audit.record('lease-released', task.id);
    }
  }

  async #run(input: AgentTaskInput, signal: AbortSignal): Promise<unknown> {
    const { task } = input;
    const { repo, audit } = this.#o;
    const base = await this.#baseFor(task);
    const { worktree, reset } = await repo.ensureWorktree(task.id, base);
    audit.record(reset ? 'worktree-reset' : 'worktree-created', task.id, {
      path: worktree.path,
      branch: worktree.branch,
      base,
    });

    // Untrusted context: flag (and audit) instruction-like content; permissions never change.
    const packet = buildAgentContext({
      task,
      dependencyResults: input.dependencyResults,
      priorAttempts: input.priorAttempts ?? [],
      approvals: this.#o.approvals.mode,
    });
    for (const b of packet.untrusted) {
      if (b.flags.length > 0) {
        audit.record('untrusted-content-flagged', task.id, {
          source: b.source,
          rules: b.flags.map((f) => f.rule),
        });
      }
    }

    const permissions: TaskPermissions = {
      requestApproval: (request, s) => this.#approve({ ...request, taskId: task.id }, s ?? signal),
    };
    audit.record('attempt-started', task.id, {
      attempt: input.attempt,
      model: input.assignment?.model ?? null,
      worktree: worktree.path,
    });
    const raw = await this.#o.inner.run(
      {
        ...input,
        workspace: { root: worktree.path, writeScope: [...task.files.write] },
        permissions,
      },
      signal,
    );
    const parsed = validateAgentResult(raw);
    if (!parsed.ok) {
      audit.record('attempt-finished', task.id, { attempt: input.attempt, status: 'invalid' });
      return raw;
    }
    const result = parsed.value;
    audit.record('attempt-finished', task.id, { attempt: input.attempt, status: result.status });
    if (signal.aborted) return result;
    return this.#verify(input, result, worktree, signal);
  }

  async #verify(
    input: AgentTaskInput,
    result: AgentResult,
    worktree: Worktree,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const { task } = input;
    const { repo, audit } = this.#o;
    const isWrite = task.files.write.length > 0;
    const commit = await repo.commitAll(worktree, `soot: ${attemptLabel(input)}`);
    const files = commit === null ? [] : await repo.changedFiles(worktree.base, commit);
    const protectedPaths = this.#o.protectedPaths ?? [];
    const outOfScope = files
      .map((f) => f.path)
      .filter((p) => !withinScope(p, task.files.write) || withinScope(p, protectedPaths));
    const touchedProtected = outOfScope.filter((p) => withinScope(p, protectedPaths));
    audit.record('change-collected', task.id, {
      attempt: input.attempt,
      commit,
      files: files.map((f) => `${f.status}:${f.path}`),
    });
    const record = (
      verdict: Verdict,
      reason: string,
      checks: readonly CheckEvidence[] = [],
    ): TaskVerification => {
      const v: TaskVerification = {
        taskId: task.id,
        attempt: input.attempt,
        model: input.assignment?.model ?? result.usage.model,
        verdict,
        reason,
        worktree: worktree.path,
        branch: worktree.branch,
        base: worktree.base,
        commit,
        files,
        outOfScope,
        checks,
        claims: {
          status: result.status,
          evidence: result.evidence,
          patchFiles: result.patch?.filesChanged ?? [],
        },
      };
      this.verifications.set(task.id, [...(this.verifications.get(task.id) ?? []), v]);
      audit.record(verdict === 'verified' ? 'task-verified' : 'task-not-verified', task.id, {
        attempt: input.attempt,
        verdict,
        reason,
      });
      return v;
    };

    if (result.status !== 'succeeded') {
      record('agent-not-succeeded', `agent reported ${result.status}`);
      return result;
    }
    if (outOfScope.length > 0) {
      audit.record('scope-violation', task.id, {
        attempt: input.attempt,
        paths: outOfScope,
        protected: touchedProtected,
      });
      const outside = outOfScope.filter((p) => !touchedProtected.includes(p));
      const reasons = [
        ...(outside.length > 0
          ? [
              `changed files outside the write lease (${task.files.write.join(', ') || 'read-only task'}): ${outside.join(', ')}`,
            ]
          : []),
        ...(touchedProtected.length > 0
          ? [`changed protected files: ${touchedProtected.join(', ')}`]
          : []),
      ];
      const v = record('out-of-scope', reasons.join('; '));
      return this.#asFailed(result, v);
    }
    if (isWrite && files.length === 0) {
      return this.#asFailed(
        result,
        record('no-changes', 'the agent reported success but changed no files'),
      );
    }
    const deleted = files.filter((f) => f.status === 'deleted').map((f) => f.path);
    if (deleted.length > 0) {
      const answer = await this.#approve(
        { taskId: task.id, action: 'delete-files', detail: `delete ${deleted.join(', ')}` },
        signal,
      );
      if (answer !== 'approved') {
        const v = record('refused', `deleting ${deleted.join(', ')} needs approval; ${answer}`);
        return { ...result, status: 'blocked', summary: `[soot] refused: ${v.reason}` };
      }
    }

    const checks = [
      ...(files.length > 0 ? this.#o.checks : []),
      ...(this.#o.acceptance?.[task.id] ?? []),
    ];
    if (checks.length === 0) {
      record(
        'unverified',
        'read-only task with no soot-run acceptance checks; only the agent reported success',
      );
      return result;
    }
    const evidence: CheckEvidence[] = [];
    for (const check of checks) {
      if (signal.aborted) break;
      const e = await runCheck(check, {
        cwd: worktree.path,
        policy: this.#o.policy,
        commit,
        signal,
      });
      evidence.push(e);
      audit.record(e.status === 'refused' ? 'command-refused' : 'command-run', task.id, {
        check: e.name,
        argv: [...e.argv],
        status: e.status,
        exitCode: e.exitCode,
        durationMs: e.durationMs,
        reason: e.reason,
      });
    }
    const bad = evidence.filter((e) => e.required && e.status !== 'passed');
    if (bad.length > 0 || evidence.length < checks.length) {
      const v = record(
        'failed-validation',
        bad.length > 0
          ? bad
              .map(
                (e) =>
                  `${e.name} ${e.status}${e.exitCode === null ? '' : ` (exit ${String(e.exitCode)})`}${e.reason === null ? '' : `: ${e.reason}`}`,
              )
              .join('; ')
          : 'validation was cancelled',
        evidence,
      );
      return this.#asFailed(result, v);
    }
    const v = record(
      'verified',
      `${String(evidence.length)} soot-run checks passed on ${commit ?? 'the base commit'}`,
      evidence,
    );
    return {
      ...result,
      patch:
        commit === null
          ? null
          : { format: 'git-commit', ref: commit, filesChanged: files.map((f) => f.path) },
      evidence: [
        ...result.evidence.slice(0, Math.max(0, 50 - v.checks.length)),
        ...v.checks.map((c): Evidence => ({
          kind: c.kind === 'test' || c.kind === 'acceptance' ? 'test' : 'command',
          description: `[soot] ${c.name} ${c.status}`,
          passed: c.status === 'passed',
          ref: `soot-check:${c.name}`,
        })),
      ],
    };
  }

  /** The agent's result as soot sees it: `failed`, with the reason as a finding. */
  #asFailed(result: AgentResult, v: TaskVerification): AgentResult {
    const failing = v.checks.find((c) => c.required && c.status !== 'passed');
    const finding: Finding = {
      kind: 'issue',
      message:
        `[soot] not verified (${v.verdict}): ${v.reason}${failing === undefined || failing.outputTail === '' ? '' : `\noutput (untrusted): ${failing.outputTail.slice(-600)}`}`.slice(
          0,
          2000,
        ),
      ...(v.outOfScope.length > 0 ? { files: v.outOfScope.slice(0, 50) } : {}),
    };
    return {
      ...result,
      status: 'failed',
      summary: `[soot] ${v.verdict}: ${v.reason}`.slice(0, 2000),
      findings: [...result.findings.slice(0, 49), finding],
      patch: null,
    };
  }

  async #approve(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const { audit, approvals } = this.#o;
    audit.record('approval-requested', request.taskId, {
      action: request.action,
      detail: request.detail,
      mode: approvals.mode,
    });
    const decision = await approvals.request(request, signal);
    audit.record('approval-answered', request.taskId, { action: request.action, decision });
    return decision;
  }

  /**
   * Base commit for a task's worktree: the pinned run base, plus the verified commits of its
   * prerequisites (merged without touching any working tree), so dependents build on them.
   */
  async #baseFor(task: Task): Promise<string> {
    const { repo, graph } = this.#o;
    const commits = (graph.prerequisites.get(task.id) ?? [])
      .map((id) => this.latest(id))
      .filter((v): v is TaskVerification => v?.verdict === 'verified' && v.commit !== null)
      .map((v) => v.commit ?? '');
    let base = repo.baseCommit;
    for (const commit of commits) {
      if (await repo.isAncestor(commit, base)) continue;
      if (await repo.isAncestor(base, commit)) {
        base = commit;
        continue;
      }
      const merged = await repo.mergeTree(base, commit);
      if (!merged.clean) {
        throw new Error(
          `prerequisite changes conflict for ${task.id}: ${merged.conflicts.join(', ')}`,
        );
      }
      base = await repo.commitTree(merged.tree, [base, commit], `soot: base for ${task.id}`);
    }
    return base;
  }
}
