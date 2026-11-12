import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/*
 * Audit log (Milestone 5, spec §13). Append-only JSON Lines: one entry per security-relevant
 * action (worktrees, attempts, diffs, scope violations, commands run or refused, approvals,
 * integration, working-tree updates, routing decisions). Each line is written synchronously so the log survives
 * a crash. Values are redacted for key-like strings before they are stored.
 */

export const AUDIT_EVENT_TYPES = [
  'run-started',
  'run-finished',
  'worktree-created',
  'worktree-reset',
  'worktree-removed',
  'lease-acquired',
  'lease-released',
  'lease-refused',
  'attempt-started',
  'attempt-finished',
  'change-collected',
  'scope-violation',
  'command-run',
  'command-refused',
  'approval-requested',
  'approval-answered',
  'task-verified',
  'task-not-verified',
  'integration-merged',
  'integration-conflict',
  'working-tree-updated',
  'working-tree-not-updated',
  'untrusted-content-flagged',
  // Routing (ADR-030): every supervisor decision (assign, retry, fallback, escalate, downgrade,
  // accept, fail, stop), and for ACP whether the agent applied the routed model (ADR-028).
  'routing-decision',
  'model-route',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditValue =
  string | number | boolean | null | readonly AuditValue[] | { readonly [key: string]: AuditValue };

export interface AuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly runId: string;
  readonly type: AuditEventType;
  readonly taskId: string | null;
  readonly detail: Readonly<Record<string, AuditValue>>;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=\S+/g,
];

/** Replace key-like substrings with `[redacted]` (defence in depth; keys never reach tasks). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, name?: string) =>
      typeof name === 'string' && match.includes('=') ? `${name}=[redacted]` : '[redacted]',
    );
  }
  return out;
}

function redact(value: AuditValue): AuditValue {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return (value as readonly AuditValue[]).map(redact);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

export interface AuditLogOptions {
  readonly runId: string;
  /** JSON Lines file to append to (created with mode 0600). Omit for in-memory only. */
  readonly file?: string;
  readonly now?: () => Date;
}

export class AuditLog {
  readonly runId: string;
  readonly file: string | null;
  readonly #entries: AuditEntry[] = [];
  readonly #now: () => Date;

  constructor(options: AuditLogOptions) {
    this.runId = options.runId;
    this.file = options.file ?? null;
    this.#now = options.now ?? (() => new Date());
    if (this.file !== null) mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
  }

  record(
    type: AuditEventType,
    taskId: string | null,
    detail: Readonly<Record<string, AuditValue>> = {},
  ): AuditEntry {
    const entry: AuditEntry = Object.freeze({
      seq: this.#entries.length + 1,
      at: this.#now().toISOString(),
      runId: this.runId,
      type,
      taskId,
      detail: redact(detail) as Readonly<Record<string, AuditValue>>,
    });
    this.#entries.push(entry);
    if (this.file !== null) {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    return entry;
  }

  entries(filter?: { type?: AuditEventType; taskId?: string }): AuditEntry[] {
    return this.#entries.filter(
      (e) =>
        (filter?.type === undefined || e.type === filter.type) &&
        (filter?.taskId === undefined || e.taskId === filter.taskId),
    );
  }
}
