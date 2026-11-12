import { describe, expect, it } from 'vitest';

import { InteractiveApprovalGate, UNATTENDED_APPROVALS } from './index.js';

const req = { taskId: 't', action: 'delete-files' as const, detail: 'delete src/a.ts' };

describe('approval gates (never auto-approve)', () => {
  it('unattended runs always get unavailable', async () => {
    await expect(UNATTENDED_APPROVALS.request(req)).resolves.toBe('unavailable');
  });

  it('interactive requests wait for a person and resolve with their answer', async () => {
    const gate = new InteractiveApprovalGate();
    const seen: number[] = [];
    gate.onRequest((p) => seen.push(p.id));
    let settled = false;
    const decision = gate.request(req).then((d) => {
      settled = true;
      return d;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(gate.pending().map((p) => p.request.detail)).toEqual(['delete src/a.ts']);
    gate.answer(seen[0] ?? 0, 'denied');
    await expect(decision).resolves.toBe('denied');
    expect(gate.pending()).toEqual([]);
    expect(() => {
      gate.answer(seen[0] ?? 0, 'approved');
    }).toThrow(/no pending approval/);
  });

  it('cancelling while waiting resolves as unavailable, not approved', async () => {
    const gate = new InteractiveApprovalGate();
    const ac = new AbortController();
    const decision = gate.request(req, ac.signal);
    ac.abort();
    await expect(decision).resolves.toBe('unavailable');
    expect(gate.pending()).toEqual([]);
    const pre = new AbortController();
    pre.abort();
    await expect(gate.request(req, pre.signal)).resolves.toBe('unavailable');
  });
});
