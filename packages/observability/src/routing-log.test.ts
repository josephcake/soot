import { describe, expect, it } from 'vitest';
import { estimatedUsd } from './cost.js';
import { RoutingLog, formatRoutingEntry, type RoutingLogEntry } from './routing-log.js';

const entry = (taskId: string, runId: string | null = 'run-1'): RoutingLogEntry => ({
  at: '2026-11-12T09:00:00.000Z',
  runId,
  taskId,
  policy: 'balanced',
  status: 'routed',
  selected: 'p/cheap',
  reason: 'cheapest model meeting the 0.75 reliability threshold for low-complexity work',
  candidates: [
    {
      ref: 'p/cheap',
      outcome: 'selected',
      estimatedCostUsd: estimatedUsd(0.001),
      reliability: 0.9,
      detail: '',
    },
    {
      ref: 'p/blind',
      outcome: 'excluded',
      estimatedCostUsd: null,
      reliability: null,
      detail: 'missing capability: tools',
    },
  ],
});

describe('RoutingLog (M3-05)', () => {
  it('stores decisions, filters by task and run, and exports JSON Lines', () => {
    const log = new RoutingLog();
    log.append(entry('a'));
    log.append(entry('b', 'run-2'));
    expect(log.entries({ taskId: 'a' })).toHaveLength(1);
    expect(log.entries({ runId: 'run-2' }).map((e) => e.taskId)).toEqual(['b']);
    const lines = log
      .toJSONL()
      .split('\n')
      .map((l) => JSON.parse(l) as RoutingLogEntry);
    expect(lines.map((l) => l.selected)).toEqual(['p/cheap', 'p/cheap']);
  });

  it('refuses a decision without a reason', () => {
    expect(() => {
      new RoutingLog().append({ ...entry('a'), reason: '  ' });
    }).toThrow(/reason/);
  });

  it('renders a readable explanation with every candidate, costs labelled as estimates', () => {
    const text = formatRoutingEntry(entry('a'));
    expect(text).toContain('[balanced] a → p/cheap');
    expect(text).toContain('est. $0.001000');
    expect(text).toContain('missing capability: tools');
    expect(text).toContain('cost unknown');
  });
});
