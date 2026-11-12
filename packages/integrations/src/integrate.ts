import type { AuditLog } from '@soot/observability';
import type { Repository } from './repository.js';

/*
 * Serial integration (M5-03, ADR-019): verified task commits are merged one at a time, in
 * dependency order, onto the user's current HEAD. Each merge is first a `git merge-tree`
 * dry run; a conflicting task is recorded with its conflicted paths and skipped (its branch
 * is kept), never dropped silently. No working tree is touched here.
 */

export interface IntegrationCandidate {
  readonly taskId: string;
  readonly commit: string;
  readonly branch: string;
}

export type IntegrationStep =
  | {
      readonly taskId: string;
      readonly status: 'merged';
      readonly commit: string;
      readonly mergeCommit: string;
      readonly branch: string;
    }
  | {
      readonly taskId: string;
      readonly status: 'conflict';
      readonly commit: string;
      readonly branch: string;
      readonly conflicts: readonly string[];
      readonly messages: string;
    };

export interface IntegrationResult {
  /** Commit integration started from (the user's HEAD at integration time). */
  readonly onto: string;
  /** Resulting commit (equals `onto` when nothing merged). */
  readonly head: string;
  readonly steps: readonly IntegrationStep[];
}

export async function integrateSerially(
  repo: Repository,
  candidates: readonly IntegrationCandidate[],
  audit: AuditLog,
): Promise<IntegrationResult> {
  const onto = await repo.headCommit();
  let head = onto;
  const steps: IntegrationStep[] = [];
  for (const c of candidates) {
    if (await repo.isAncestor(c.commit, head)) {
      steps.push({
        taskId: c.taskId,
        status: 'merged',
        commit: c.commit,
        mergeCommit: head,
        branch: c.branch,
      });
      continue;
    }
    const dry = await repo.mergeTree(head, c.commit);
    if (!dry.clean) {
      steps.push({
        taskId: c.taskId,
        status: 'conflict',
        commit: c.commit,
        branch: c.branch,
        conflicts: dry.conflicts,
        messages: dry.messages,
      });
      audit.record('integration-conflict', c.taskId, {
        commit: c.commit,
        branch: c.branch,
        onto: head,
        conflicts: [...dry.conflicts],
      });
      continue;
    }
    const merge = await repo.commitTree(dry.tree, [head, c.commit], `soot: integrate ${c.taskId}`);
    steps.push({
      taskId: c.taskId,
      status: 'merged',
      commit: c.commit,
      mergeCommit: merge,
      branch: c.branch,
    });
    audit.record('integration-merged', c.taskId, { commit: c.commit, mergeCommit: merge });
    head = merge;
  }
  return { onto, head, steps };
}
