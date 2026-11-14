import type { CostView, EscalationView, EventView, RunView, TaskView } from './view-model.js';

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

export const shortModel = (m: string | null): string =>
  m === null ? 'no model' : m.includes('/') ? m.slice(m.indexOf('/') + 1) : m;

const usd = (v: number | null): string => (v === null ? 'unknown' : `$${v.toFixed(6)}`);

/** `[■ task-id · claude-haiku-5-5 · 1x]` (model path joined with →, attempts as Nx). */
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

/** Glyph that marks an escalation everywhere it is shown (tree, board, legend). */
export const ESCALATION_GLYPH = '▲';

/** `claude-haiku-5-5 ──▶ gpt-6.1-terra`: one step up, from the old model to the new one. */
export function modelStepBlock(from: string | null, to: string | null): string {
  return `${shortModel(from)} ──▶ ${shortModel(to)}`;
}

/** `update-button-color #2 · claude-haiku-5-5 ──▶ gpt-6.1-terra · L1` (task, attempt, step, level). */
export function escalationLine(e: EscalationView): string {
  const level = e.level === null ? '' : ` · L${String(e.level)}`;
  return `${e.taskId} #${String(e.attempt)} · ${modelStepBlock(e.fromModel, e.toModel)}${level}`;
}

/** The board's title line for one escalation: the escalation glyph, then `escalationLine`. */
export function escalationTitle(e: EscalationView): string {
  return `${ESCALATION_GLYPH} ${escalationLine(e)}`;
}

/** What escalated, from which model to which, on which attempt, and why (engine's words). */
export function escalationDetails(e: EscalationView): string[] {
  const prev = e.attempt > 1 ? ` (attempt #${String(e.attempt - 1)})` : '';
  const level = e.level === null ? '' : `, level ${String(e.level)}`;
  return [
    `from  ${e.fromModel ?? 'unknown model'}${prev}`,
    `to    ${e.toModel ?? 'unknown model'} (attempt #${String(e.attempt)}${level})`,
    `why   ${e.reason === '' ? '(no reason reported)' : e.reason}`,
    ...e.triggers.map((t) => `      · ${t.kind}${t.detail === '' ? '' : `: ${t.detail}`}`),
  ];
}

/** The board's escalation block: a title line per escalation with its details indented. */
export function escalationBlock(escalations: readonly EscalationView[]): string[] {
  if (escalations.length === 0) return ['(no escalations)'];
  return escalations.flatMap((e) => [
    escalationTitle(e),
    ...escalationDetails(e).map((l) => `   ${l}`),
  ]);
}

/** Routing events other than escalations (retry, fallback, downgrade, fail, stop). */
export function otherEventsBlock(events: readonly EventView[]): string[] {
  const rest = events.filter((e) => e.type !== 'escalate');
  return rest.length === 0 ? ['(none)'] : rest.map(eventBlock);
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
      `Escalations (${String(view.escalations.length)})`,
      escalationBlock(view.escalations),
    ),
    ...section('Retries and other events', otherEventsBlock(view.events)),
    ...section('Failures', failureBlock(view.tasks)),
    ...section('Verdicts', verdictBlock(view.tasks)),
    ...section('Cost', costBlock(view.cost)),
    `Legend: ■ done  ▣ running  ↻ retried  □ pending  ✕ failed  ⊘ cancelled/skipped  ? interrupted  ${ESCALATION_GLYPH} escalated  L<n> escalation level`,
  ].join('\n');
}
