import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import {
  InteractiveApprovalGate,
  UNATTENDED_APPROVALS,
  type ApprovalGate,
} from '@soot/agent-runtime';

/*
 * Approvals for the CLI (ADR-018). Interactive: each request is printed and the run waits for
 * the person to type y or n on stdin (anything else, or end of input, is a denial). Unattended:
 * every request is unavailable, so the task is refused. There is no flag to approve everything;
 * `--apply` pre-approves only landing a fully verified result (see `withApply`).
 */

export interface ApprovalIo {
  readonly input: Readable;
  readonly ask: (line: string) => void;
}

export function interactiveApprovals(io: ApprovalIo): { gate: ApprovalGate; close: () => void } {
  const gate = new InteractiveApprovalGate();
  const rl = createInterface({ input: io.input, terminal: false });
  const lines: string[] = [];
  let ended = false;
  const waiting: (() => void)[] = [];
  rl.on('line', (line) => {
    lines.push(line);
    waiting.shift()?.();
  });
  rl.on('close', () => {
    ended = true;
    for (const w of waiting.splice(0)) w();
  });
  const nextLine = async (): Promise<string | null> => {
    while (lines.length === 0 && !ended) {
      await new Promise<void>((r) => waiting.push(r));
    }
    return lines.shift() ?? null;
  };
  // One question at a time, in request order.
  let queue = Promise.resolve();
  gate.onRequest((pending) => {
    queue = queue.then(async () => {
      const r = pending.request;
      io.ask(
        `soot: approval needed (${r.action}) for ${r.taskId ?? 'the run'}: ${r.detail}\nsoot: approve? [y/N] `,
      );
      const answer = (await nextLine())?.trim().toLowerCase();
      if (!gate.pending().some((p) => p.id === pending.id)) return; // cancelled meanwhile
      gate.answer(pending.id, answer === 'y' || answer === 'yes' ? 'approved' : 'denied');
    });
  });
  return {
    gate,
    close: () => {
      rl.close();
    },
  };
}

export const unattendedApprovals = (): ApprovalGate => UNATTENDED_APPROVALS;

/**
 * `--apply` (ADR-039): the person pre-approves exactly one action for this invocation,
 * fast-forwarding their checked-out branch to the integrated result. soot asks only after
 * every merged task was verified and final validation passed, and still refuses when the
 * working tree is dirty or HEAD moved. Every other request goes to `base` unchanged.
 */
export function withApply(base: ApprovalGate): ApprovalGate {
  return {
    mode: base.mode,
    request: (request, signal) =>
      request.action === 'integrate-into-working-tree'
        ? Promise.resolve('approved' as const)
        : base.request(request, signal),
  };
}
