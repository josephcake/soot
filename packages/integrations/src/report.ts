import type { TaskOutcome } from '@soot/agent-runtime';
import {
  buildCostReport,
  renderCostReport,
  type CostReport,
  type PlanningCostInput,
} from '@soot/observability';
import type { TaskGraph } from '@soot/task-graph';
import type { CheckEvidence } from './commands.js';
import type { IntegrationResult } from './integrate.js';
import type { FileChange } from './repository.js';
import type { TaskVerification, Verdict } from './runner.js';
import type { DiffOverlap } from './scope.js';

/*
 * Consolidated run report (M5-05, spec §11.8): what each task did, whether soot verified it
 * from its own evidence, whether it was integrated, what it cost — and an explicit list of
 * everything that is NOT complete. A run is `complete` only if every task is.
 */

export type IntegrationState = 'merged' | 'conflict' | 'not-integrated' | 'read-only';

export interface TaskReport {
  readonly taskId: string;
  readonly title: string;
  readonly schedulerState: TaskOutcome['state'];
  readonly verdict: Verdict | 'not-run';
  readonly reason: string;
  readonly integration: IntegrationState;
  readonly conflicts: readonly string[];
  readonly branch: string | null;
  readonly files: readonly FileChange[];
  readonly checks: readonly Pick<CheckEvidence, 'name' | 'kind' | 'status' | 'exitCode'>[];
  readonly attempts: number;
  readonly modelPath: readonly string[];
  readonly complete: boolean;
  /** Agent claims soot did not rely on (shown so a reader can compare). */
  readonly agentClaimedEvidence: number;
}

export interface WorkingTreeUpdate {
  readonly updated: boolean;
  readonly reason: string;
}

export interface ConsolidatedReport {
  readonly runId: string;
  readonly prompt: string | null;
  readonly repository: {
    readonly root: string;
    readonly branch: string | null;
    readonly base: string;
  };
  readonly status: 'complete' | 'incomplete' | 'cancelled';
  readonly counts: {
    readonly tasks: number;
    readonly complete: number;
    readonly incomplete: number;
  };
  /** Every task that is not complete, with the reason. Never empty unless status is `complete`. */
  readonly incomplete: readonly { readonly taskId: string; readonly reason: string }[];
  /** Run-level problems (final validation, working tree not updated). */
  readonly problems: readonly string[];
  readonly tasks: readonly TaskReport[];
  readonly diffOverlaps: readonly DiffOverlap[];
  readonly integration: IntegrationResult | null;
  readonly finalValidation: readonly CheckEvidence[] | null;
  readonly workingTree: WorkingTreeUpdate;
  readonly cost: CostReport;
}

export interface ReportInput {
  readonly runId: string;
  readonly prompt: string | null;
  readonly repository: ConsolidatedReport['repository'];
  readonly graph: TaskGraph;
  readonly outcomes: ReadonlyMap<string, TaskOutcome>;
  readonly verifications: ReadonlyMap<string, readonly TaskVerification[]>;
  readonly integration: IntegrationResult | null;
  readonly finalValidation: readonly CheckEvidence[] | null;
  readonly workingTree: WorkingTreeUpdate;
  readonly diffOverlaps: readonly DiffOverlap[];
  readonly cancelled: boolean;
  /** The planning model call, for the cost report's own planning line (ADR-045). */
  readonly planning?: PlanningCostInput | null;
}

export function buildConsolidatedReport(input: ReportInput): ConsolidatedReport {
  const steps = new Map((input.integration?.steps ?? []).map((s) => [s.taskId, s]));
  const tasks: TaskReport[] = input.graph.tasks.map((task) => {
    const outcome = input.outcomes.get(task.id);
    const v = input.verifications.get(task.id)?.at(-1);
    const step = steps.get(task.id);
    const isWrite = task.files.write.length > 0;
    const integration: IntegrationState = !isWrite
      ? 'read-only'
      : step === undefined
        ? 'not-integrated'
        : step.status;
    const succeeded = outcome?.state === 'succeeded';
    const verified = succeeded && v?.verdict === 'verified';
    const complete = verified && (integration === 'merged' || integration === 'read-only');
    const latestAttempt = outcome?.attempts.at(-1)?.attempt ?? outcome?.attempt ?? null;
    let reason: string;
    if (outcome?.state !== 'succeeded') {
      // Prefer soot's own verdict on the final attempt over the scheduler's summary.
      reason =
        v !== undefined && v.verdict !== 'verified' && v.attempt === latestAttempt
          ? `${v.verdict}: ${v.reason}`
          : `${outcome?.state ?? 'not run'}: ${outcome?.error ?? 'no outcome'}`;
    } else if (v === undefined) {
      reason = 'no soot verification recorded';
    } else if (v.verdict !== 'verified') {
      reason = `${v.verdict}: ${v.reason}`;
    } else if (step?.status === 'conflict') {
      reason = `integration conflict in ${step.conflicts.join(', ')}; branch ${step.branch} kept`;
    } else if (integration === 'not-integrated') {
      reason = 'verified but not integrated';
    } else {
      reason = v.reason;
    }
    const models = (outcome?.attempts ?? [])
      .map((a) => a.assignment?.model ?? a.result?.usage.model ?? null)
      .filter((m): m is string => m !== null);
    return {
      taskId: task.id,
      title: task.title,
      schedulerState: outcome?.state ?? 'skipped',
      verdict: v?.verdict ?? 'not-run',
      reason,
      integration,
      conflicts: step?.status === 'conflict' ? step.conflicts : [],
      branch: v?.branch ?? null,
      files: v?.files ?? [],
      checks: (v?.checks ?? []).map((c) => ({
        name: c.name,
        kind: c.kind,
        status: c.status,
        exitCode: c.exitCode,
      })),
      attempts: outcome?.attempts.length ?? 0,
      modelPath: models.filter((m, i) => models[i - 1] !== m),
      complete,
      agentClaimedEvidence: v?.claims.evidence.length ?? 0,
    };
  });

  const problems: string[] = [];
  const finalBad = (input.finalValidation ?? []).filter((c) => c.required && c.status !== 'passed');
  if (finalBad.length > 0) {
    problems.push(
      `final validation of the integrated result failed: ${finalBad.map((c) => `${c.name} ${c.status}`).join(', ')}`,
    );
  }
  const anythingMerged = (input.integration?.steps ?? []).some((s) => s.status === 'merged');
  if (anythingMerged && !input.workingTree.updated) {
    problems.push(`working tree not updated: ${input.workingTree.reason}`);
  }
  const incomplete = tasks
    .filter((t) => !t.complete)
    .map((t) => ({ taskId: t.taskId, reason: t.reason }));
  const cost = buildCostReport(
    input.graph.tasks.map((task) => ({
      taskId: task.id,
      plannedInputTokens: task.estimate.inputTokens,
      plannedOutputTokens: task.estimate.outputTokens,
      attempts: (input.outcomes.get(task.id)?.attempts ?? []).map((a) => ({
        attempt: a.attempt,
        model: a.assignment?.model ?? null,
        estimatedUsd: a.assignment?.estimatedCostUsd ?? null,
        result: a.result,
      })),
    })),
    input.planning ?? null,
  );
  return {
    runId: input.runId,
    prompt: input.prompt,
    repository: input.repository,
    status: input.cancelled
      ? 'cancelled'
      : incomplete.length === 0 && problems.length === 0
        ? 'complete'
        : 'incomplete',
    counts: {
      tasks: tasks.length,
      complete: tasks.length - incomplete.length,
      incomplete: incomplete.length,
    },
    incomplete,
    problems,
    tasks,
    diffOverlaps: input.diffOverlaps,
    integration: input.integration,
    finalValidation: input.finalValidation,
    workingTree: input.workingTree,
    cost,
  };
}

/** Plain-text report (ADR-009: structured text, no UI). Incomplete work is listed first. */
export function renderConsolidatedReport(r: ConsolidatedReport): string {
  const lines: string[] = [
    `soot run ${r.runId}: ${r.status.toUpperCase()} (${String(r.counts.complete)}/${String(r.counts.tasks)} tasks complete)`,
    `repository ${r.repository.root} on ${r.repository.branch ?? '(detached)'} from ${r.repository.base.slice(0, 12)}`,
  ];
  if (r.incomplete.length > 0 || r.problems.length > 0) {
    lines.push('', 'NOT COMPLETE:');
    for (const i of r.incomplete) lines.push(`- ${i.taskId}: ${i.reason}`);
    for (const p of r.problems) lines.push(`- run: ${p}`);
  }
  lines.push('', 'Tasks:');
  for (const t of r.tasks) {
    lines.push(
      `- [${t.complete ? 'x' : ' '}] ${t.taskId} — ${t.verdict}, ${t.integration}${t.modelPath.length > 0 ? `, models ${t.modelPath.join(' → ')}` : ''}, ${String(t.attempts)} attempt(s)`,
    );
    if (t.files.length > 0)
      lines.push(`    files: ${t.files.map((f) => `${f.status} ${f.path}`).join(', ')}`);
    for (const c of t.checks)
      lines.push(
        `    check ${c.name} (${c.kind}): ${c.status}${c.exitCode === null ? '' : ` exit ${String(c.exitCode)}`}`,
      );
    if (t.agentClaimedEvidence > 0)
      lines.push(
        `    agent claimed ${String(t.agentClaimedEvidence)} evidence item(s); not used for verification`,
      );
  }
  if (r.diffOverlaps.length > 0) {
    lines.push('', 'Overlapping changes:');
    for (const o of r.diffOverlaps)
      lines.push(`- ${o.first} and ${o.second}: ${o.paths.join(', ')}`);
  }
  if (r.integration !== null) {
    lines.push(
      '',
      `Integration onto ${r.integration.onto.slice(0, 12)} → ${r.integration.head.slice(0, 12)}:`,
    );
    for (const s of r.integration.steps) {
      lines.push(
        s.status === 'merged'
          ? `- merged ${s.taskId}`
          : `- CONFLICT ${s.taskId} in ${s.conflicts.join(', ')} (branch ${s.branch} kept)`,
      );
    }
  }
  if (r.finalValidation !== null) {
    lines.push('', 'Final validation of the integrated result:');
    for (const c of r.finalValidation) lines.push(`- ${c.name}: ${c.status}`);
  }
  lines.push(
    '',
    `Working tree: ${r.workingTree.updated ? 'updated' : 'not updated'} (${r.workingTree.reason})`,
    '',
    renderCostReport(r.cost),
  );
  return lines.join('\n');
}
