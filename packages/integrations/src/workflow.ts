import { join } from 'node:path';
import {
  Scheduler,
  type AgentRunner,
  type ApprovalGate,
  type AttemptSupervisor,
  type ExecutionJournal,
  type RunReport,
} from '@soot/agent-runtime';
import type { ModelOutcome } from '@soot/context-manager';
import { AuditLog } from '@soot/observability';
import type { TaskGraph } from '@soot/task-graph';
import { runCheck, type CheckCommand, type CheckEvidence, type CommandPolicy } from './commands.js';
import {
  integrateSerially,
  type IntegrationCandidate,
  type IntegrationResult,
} from './integrate.js';
import {
  buildConsolidatedReport,
  type ConsolidatedReport,
  type WorkingTreeUpdate,
} from './report.js';
import { Repository, type GitIdentity } from './repository.js';
import { IsolatedTaskRunner, type TaskVerification } from './runner.js';
import { findDiffOverlaps } from './scope.js';

/*
 * The Milestone 5 workflow on a real repository:
 *   pin base → one worktree per task (leases) → agents work → soot commits, checks scope, runs
 *   checks → serial merge-tree integration of verified work → final validation of the
 *   integrated tree → fast-forward the user's working tree ONLY with a person's approval →
 *   clean up worktrees → consolidated report + audit log.
 */

export interface OutcomeSink {
  recordModelOutcome(outcome: ModelOutcome): void;
}

export interface CodebaseWorkflowOptions {
  readonly repoRoot: string;
  /** soot state directory (`SOOT_DATA_DIR`); worktrees and the audit log live under it. */
  readonly dataDir: string;
  readonly runId: string;
  readonly graph: TaskGraph;
  readonly runner: AgentRunner;
  readonly checks: readonly CheckCommand[];
  readonly acceptance?: Readonly<Record<string, readonly CheckCommand[]>>;
  /** Paths no task may change even inside its lease (acceptance tests, CI config, …). */
  readonly protectedPaths?: readonly string[];
  readonly policy: CommandPolicy;
  readonly approvals: ApprovalGate;
  readonly supervisor?: AttemptSupervisor;
  readonly concurrency?: number;
  readonly attemptTimeoutMs?: number;
  readonly journal?: ExecutionJournal;
  readonly signal?: AbortSignal;
  /** Where soot-verified model outcomes are stored for routing feedback (M5-07). */
  readonly outcomes?: OutcomeSink;
  readonly prompt?: string;
  readonly identity?: GitIdentity;
  readonly gitEnv?: NodeJS.ProcessEnv;
  /** Called with the scheduler as soon as it exists (to cancel single tasks). */
  readonly onScheduler?: (scheduler: Scheduler) => void;
}

export interface CodebaseRunResult {
  readonly report: ConsolidatedReport;
  readonly run: RunReport;
  readonly verifications: ReadonlyMap<string, readonly TaskVerification[]>;
  readonly audit: AuditLog;
  readonly repository: Repository;
}

/** Map soot's verdicts to model outcomes. Only verdicts that say something about the model count. */
function outcomesOf(
  runId: string,
  run: RunReport,
  verifications: ReadonlyMap<string, readonly TaskVerification[]>,
): ModelOutcome[] {
  const out: ModelOutcome[] = [];
  for (const [taskId, list] of verifications) {
    const attempts = run.outcomes.get(taskId)?.attempts ?? [];
    for (const v of list) {
      const tier = attempts.find((a) => a.attempt === v.attempt)?.assignment?.tier;
      if (v.model === null || tier === undefined) continue;
      const verdict = v.verdict;
      if (verdict === 'verified') {
        out.push({
          runId,
          taskId,
          attempt: v.attempt,
          model: v.model,
          tier,
          outcome: 'verified',
          reason: v.reason,
        });
      } else if (
        verdict === 'failed-validation' ||
        verdict === 'out-of-scope' ||
        verdict === 'no-changes' ||
        (verdict === 'agent-not-succeeded' && v.claims.status === 'failed')
      ) {
        out.push({
          runId,
          taskId,
          attempt: v.attempt,
          model: v.model,
          tier,
          outcome: 'failed',
          reason: `${verdict}: ${v.reason}`,
        });
      }
    }
  }
  return out;
}

export async function runCodebaseWorkflow(o: CodebaseWorkflowOptions): Promise<CodebaseRunResult> {
  const repo = await Repository.open({
    root: o.repoRoot,
    worktreesDir: join(o.dataDir, 'worktrees'),
    runId: o.runId,
    ...(o.identity === undefined ? {} : { identity: o.identity }),
    ...(o.gitEnv === undefined ? {} : { gitEnv: o.gitEnv }),
  });
  const audit = new AuditLog({
    runId: o.runId,
    file: join(o.dataDir, 'audit', `${o.runId}.jsonl`),
  });
  audit.record('run-started', null, {
    repository: repo.root,
    branch: repo.branch,
    base: repo.baseCommit,
    tasks: o.graph.tasks.map((t) => t.id),
    approvals: o.approvals.mode,
  });
  const isolated = new IsolatedTaskRunner({
    repo,
    graph: o.graph,
    inner: o.runner,
    checks: o.checks,
    ...(o.acceptance === undefined ? {} : { acceptance: o.acceptance }),
    ...(o.protectedPaths === undefined ? {} : { protectedPaths: o.protectedPaths }),
    policy: o.policy,
    approvals: o.approvals,
    audit,
  });

  let run: RunReport | undefined;
  let integration: IntegrationResult | null = null;
  let finalValidation: CheckEvidence[] | null = null;
  let workingTree: WorkingTreeUpdate = { updated: false, reason: 'nothing to integrate' };
  const deleteBranches: string[] = [];
  try {
    const scheduler = new Scheduler(o.graph, {
      runner: isolated,
      concurrency: o.concurrency ?? 4,
      ...(o.supervisor === undefined ? {} : { supervisor: o.supervisor }),
      ...(o.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: o.attemptTimeoutMs }),
      ...(o.journal === undefined ? {} : { journal: o.journal }),
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    });
    o.onScheduler?.(scheduler);
    run = await scheduler.run();
    for (const outcome of outcomesOf(o.runId, run, isolated.verifications))
      o.outcomes?.recordModelOutcome(outcome);

    if (run.status !== 'cancelled' && o.signal?.aborted !== true) {
      const order = o.graph.layers.flat();
      const candidates: IntegrationCandidate[] = order.flatMap((id) => {
        const v = isolated.latest(id);
        const ok = run?.outcomes.get(id)?.state === 'succeeded' && v?.verdict === 'verified';
        return ok && v.commit !== null && v.branch !== null
          ? [{ taskId: id, commit: v.commit, branch: v.branch }]
          : [];
      });
      integration = await integrateSerially(repo, candidates, audit);
      const merged = integration.steps.filter((s) => s.status === 'merged');
      if (integration.head !== integration.onto) {
        await repo.setBranch(`soot/${o.runId}/integration`, integration.head);
        const path = await repo.detachedWorktree('integration', integration.head);
        finalValidation = [];
        for (const check of o.checks) {
          const e = await runCheck(check, {
            cwd: path,
            policy: o.policy,
            commit: integration.head,
          });
          finalValidation.push(e);
          audit.record(e.status === 'refused' ? 'command-refused' : 'command-run', null, {
            check: e.name,
            argv: [...e.argv],
            status: e.status,
            exitCode: e.exitCode,
            stage: 'final-validation',
          });
        }
        workingTree = await applyToWorkingTree(repo, o, audit, integration, finalValidation);
        if (workingTree.updated) deleteBranches.push(...merged.map((s) => s.branch));
      }
    } else {
      workingTree = { updated: false, reason: 'run cancelled' };
    }
  } finally {
    await repo.cleanup(deleteBranches);
  }

  const latest = [...isolated.verifications.values()]
    .map((list) => list.at(-1))
    .filter((v): v is TaskVerification => v !== undefined && v.files.length > 0);
  const report = buildConsolidatedReport({
    runId: o.runId,
    prompt: o.prompt ?? null,
    repository: { root: repo.root, branch: repo.branch, base: repo.baseCommit },
    graph: o.graph,
    outcomes: run.outcomes,
    verifications: isolated.verifications,
    integration,
    finalValidation,
    workingTree,
    diffOverlaps: findDiffOverlaps(latest.map((v) => ({ taskId: v.taskId, files: v.files }))),
    cancelled: run.status === 'cancelled',
  });
  audit.record('run-finished', null, {
    status: report.status,
    complete: report.counts.complete,
    incomplete: report.incomplete.map((i) => i.taskId),
    workingTreeUpdated: workingTree.updated,
  });
  return { report, run, verifications: isolated.verifications, audit, repository: repo };
}

async function applyToWorkingTree(
  repo: Repository,
  o: CodebaseWorkflowOptions,
  audit: AuditLog,
  integration: IntegrationResult,
  finalValidation: readonly CheckEvidence[],
): Promise<WorkingTreeUpdate> {
  const not = (reason: string): WorkingTreeUpdate => {
    audit.record('working-tree-not-updated', null, { reason, integrationHead: integration.head });
    return { updated: false, reason };
  };
  const branch = `soot/${o.runId}/integration`;
  const failed = finalValidation.filter((c) => c.required && c.status !== 'passed');
  if (failed.length > 0)
    return not(
      `final validation failed (${failed.map((c) => c.name).join(', ')}); result left on ${branch}`,
    );
  if (repo.branch === null) return not(`HEAD is detached; result left on ${branch}`);
  const merged = integration.steps.filter((s) => s.status === 'merged').map((s) => s.taskId);
  const request = {
    taskId: null,
    action: 'integrate-into-working-tree' as const,
    detail: `fast-forward ${repo.branch} in ${repo.root} from ${integration.onto.slice(0, 12)} to ${integration.head.slice(0, 12)} (${merged.join(', ')})`,
  };
  audit.record('approval-requested', null, {
    action: request.action,
    detail: request.detail,
    mode: o.approvals.mode,
  });
  const decision = await o.approvals.request(request, o.signal);
  audit.record('approval-answered', null, { action: request.action, decision });
  if (decision !== 'approved') return not(`approval ${decision}; result left on ${branch}`);
  const status = await repo.workingTreeStatus();
  if (status.trim() !== '')
    return not(`working tree has uncommitted changes; result left on ${branch}`);
  if ((await repo.headCommit()) !== integration.onto)
    return not(`HEAD moved during integration; result left on ${branch}`);
  await repo.fastForwardTo(integration.head);
  audit.record('working-tree-updated', null, {
    branch: repo.branch,
    from: integration.onto,
    to: integration.head,
  });
  return {
    updated: true,
    reason: `fast-forwarded ${repo.branch} to ${integration.head.slice(0, 12)} with approval`,
  };
}
