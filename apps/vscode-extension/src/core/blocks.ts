import type { CostView, EventView, RunView, TaskView } from './view-model.js';

/*
 * Lego-block text pieces (ADR-009): each function renders one small, self-contained block from
 * plain view data. Views are made by stacking blocks; a new view swaps or adds blocks rather
 * than redesigning anything. Deliberately plain and pixel-ish; no custom UI.
 */

/** One glyph per state, like a pixel. */
export function stateGlyph(state: string): string {
  switch (state) {
    case 'succeeded':
      return '■';
    case 'running':
      return '▣';
    case 'retried':
      return '↻';
    case 'interrupted':
      return '?';
    case 'failed':
      return '✕';
    case 'cancelled':
    case 'skipped':
    case 'blocked':
      return '⊘';
    default:
      return '□';
  }
}

const shortModel = (m: string | null): string =>
  m === null ? 'no model' : m.includes('/') ? m.slice(m.indexOf('/') + 1) : m;

const usd = (v: number | null): string => (v === null ? 'unknown' : `$${v.toFixed(6)}`);

/** `[■ task-id · demo-small · 1x]` (model path joined with →, attempts as Nx). */
export function taskBlock(t: TaskView): string {
  const path = t.models.length === 0 ? '—' : t.models.map(shortModel).join('→');
  return `[${stateGlyph(t.state)} ${t.id} · ${path} · ${String(t.attempts.length)}x]`;
}

/** One layer of the graph: all tasks that can run together, side by side. */
export function layerBlock(layer: number, tasks: readonly TaskView[]): string {
  return `L${String(layer)} ${tasks.map(taskBlock).join(' ')}`;
}

/** Dependency edges into one task: `   └▶ review ← implement, tests`. */
export function edgeBlock(t: TaskView): string | null {
  return t.dependsOn.length === 0 ? null : `   └▶ ${t.id} ← ${t.dependsOn.join(', ')}`;
}

export function graphBlock(tasks: readonly TaskView[]): string[] {
  const max = tasks.reduce((m, t) => Math.max(m, t.layer), 0);
  const lines: string[] = [];
  for (let l = 0; l <= max; l++) {
    const row = tasks.filter((t) => t.layer === l);
    if (row.length === 0) continue;
    lines.push(layerBlock(l, row));
    for (const t of row) {
      const edge = edgeBlock(t);
      if (edge !== null) lines.push(edge);
    }
  }
  return lines;
}

export function activeBlock(tasks: readonly TaskView[]): string[] {
  const active = tasks.filter((t) => t.active);
  return active.length === 0
    ? ['(no agent running)']
    : active.map(
        (t) =>
          `▣ ${t.id} on ${shortModel(t.models.at(-1) ?? null)} ${t.attempts.length === 0 ? '(starting)' : `(attempt ${String(t.attempts.length)})`}`,
      );
}

export function eventBlock(e: EventView): string {
  return `${e.type.toUpperCase()} ${e.taskId} #${String(e.attempt)}${e.model === null ? '' : ` → ${shortModel(e.model)}`}: ${e.reason}`;
}

export function failureBlock(tasks: readonly TaskView[]): string[] {
  const lines = tasks.flatMap((t) =>
    t.attempts
      .filter((a) => a.failure !== null || a.state === 'failed' || a.state === 'cancelled')
      .map(
        (a) =>
          `✕ ${t.id} #${String(a.attempt)} ${a.state}${a.failure === null ? '' : ` (${a.failure})`}${a.error === null ? '' : `: ${a.error}`}`,
      ),
  );
  return lines.length === 0 ? ['(no failed attempts)'] : lines;
}

export function costBlock(cost: CostView | null): string[] {
  if (cost === null) return ['(cost not available yet)'];
  return [`estimate ${usd(cost.estimatedUsd)} | actual ${usd(cost.actualUsd)}`, cost.note];
}

export function verdictBlock(tasks: readonly TaskView[]): string[] {
  return tasks.map(
    (t) =>
      `${t.complete ? '■' : t.verdict === null ? stateGlyph(t.state) : '✕'} ${t.id}: ${t.verdict ?? t.state}${t.reason === null ? '' : ` (${t.reason})`}`,
  );
}

const section = (title: string, lines: readonly string[]): string[] => [
  `== ${title} ==`,
  ...lines,
  '',
];

/** The whole board: blocks stacked top to bottom. */
export function renderBoard(view: RunView): string {
  return [
    ...section(`soot run ${view.runId}: ${view.state}`, [view.prompt]),
    ...section('Task graph', graphBlock(view.tasks)),
    ...section('Active agents', activeBlock(view.tasks)),
    ...section(
      'Escalations and retries',
      view.events.length === 0 ? ['(none)'] : view.events.map(eventBlock),
    ),
    ...section('Failures', failureBlock(view.tasks)),
    ...section('Verdicts', verdictBlock(view.tasks)),
    ...section('Cost', costBlock(view.cost)),
    'Legend: ■ done  ▣ running  ↻ retried  □ pending  ✕ failed  ⊘ cancelled/skipped  ? interrupted',
  ].join('\n');
}
