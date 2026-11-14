import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunner, AgentTaskInput } from '@soot/agent-runtime';
import { withinScope } from '@soot/integrations';
import { ProviderError, type ModelClient, type Usage } from '@soot/provider-adapters';
import type { AgentResult, Finding } from '@soot/task-graph';
import { z } from 'zod';
import {
  API_EDIT_LIMITS,
  ApiEditOpSchema,
  WholeEditSchema,
  applyPlan,
  checkEditPath,
  formatFailures,
  planEdits,
  type ApiEditOp,
  type EditFailure,
  type PlannedWrite,
} from './api-edits.js';
import { DEFAULT_MODEL_CALL_TIMEOUT_MS, formatLimit, withTimeLimit } from './time-limit.js';

export { checkEditPath } from './api-edits.js';

/*
 * Direct-API task runner (ADR-039, ADR-048). For each routed attempt it sends the task
 * (instructions, acceptance criteria, declared files and their current contents, what earlier
 * attempts and prerequisites reported) to the routed model through soot's provider adapters,
 * asks for edits as JSON (targeted "replace" edits, new files, or whole files; whole files only
 * with `apiEditFormat: "whole"`), checks every edit in memory (paths, write lease, a unique
 * match, sizes), and writes them all or none into the task's worktree. soot then commits,
 * verifies and merges as for any runner.
 *
 * The model never runs commands and never sees the original prompt or other tasks' transcripts
 * (build spec §7, §10). Keys stay inside @soot/provider-adapters (ADR-022).
 */

/** Per-file and total caps on what is sent, and on what a model may write. */
export const API_RUNNER_LIMITS = {
  /** Per-file send cap for read-only files, and for every file with `apiEditFormat: "whole"`. */
  fileBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  filesPerDir: 40,
  editBytes: API_EDIT_LIMITS.wholeBytes,
  /** Whole-file edits per reply with `apiEditFormat: "whole"` (ADR-039). */
  edits: 40,
} as const;

export type ApiEditFormat = 'auto' | 'whole';

const envelope = <T extends z.ZodType>(edit: T, max: number) =>
  z
    .object({
      summary: z.string().min(1).max(2000),
      edits: z.array(edit).max(max),
      notes: z.array(z.string().min(1).max(1000)).max(20).optional(),
    })
    .strict();

/** ADR-039 reply: whole files only (`apiEditFormat: "whole"`). */
export const ApiWholeEditsSchema = envelope(WholeEditSchema, API_RUNNER_LIMITS.edits);
/**
 * ADR-048 reply: replace / create / whole-file edits. The array cap here is a hard bound; the
 * planner enforces `API_EDIT_LIMITS.ops` with a model-facing message.
 */
export const ApiEditsSchema = envelope(ApiEditOpSchema, 1000);
export interface ApiEdits {
  readonly summary: string;
  readonly edits: readonly ApiEditOp[];
  readonly notes?: readonly string[] | undefined;
}

export interface ApiRunnerOptions {
  /** Client for a routed model ref; throws a `ProviderError` when it cannot be built (e.g. no key). */
  readonly clientFor: (ref: string) => ModelClient;
  /** Cost of reported usage at the model's list price, or `null` when unknown. */
  readonly priceUsage: (ref: string, usage: Usage) => number | null;
  /**
   * Wall-clock limit for one try's model calls (both rounds, the adapter's own transient
   * retries included), in ms. Default `DEFAULT_MODEL_CALL_TIMEOUT_MS` (120 s). On expiry the
   * request is aborted and the try ends as a retryable `timeout` provider error. The
   * scheduler's attempt timeout still applies on top, and covers soot's checks as well.
   */
  readonly tryTimeoutMs?: number;
  readonly maxOutputTokens?: number;
  /**
   * `auto` (default, ADR-048): targeted edits or whole files, writable files sent up to
   * 256 KiB. `whole`: the ADR-039 prompt, reply schema and 64 KiB per-file cap exactly.
   */
  readonly editFormat?: ApiEditFormat;
  readonly now?: () => number;
}

/** The ADR-039 prompt, verbatim (`apiEditFormat: "whole"`). */
export const SYSTEM_WHOLE = `You are a careful software engineer working inside one git worktree. You get ONE task.
Make the smallest change that meets every acceptance criterion. Only change files the task allows.
Reply with JSON only (no prose, no markdown fences), exactly this shape:
{"summary": "<one or two sentences>", "edits": [{"path": "<relative path>", "content": "<the COMPLETE new file content>"}], "notes": ["<optional caveat>"]}
Rules: paths are relative to the worktree root, use "/" separators, never start with "/" or contain "..";
"content" is the whole file after your change (not a diff); omit files you do not change; you cannot delete files
or run commands; if nothing needs to change, return "edits": [].`;

/** The ADR-048 prompt (`apiEditFormat: "auto"`, the default). */
export const SYSTEM_EDITS = `You are a careful software engineer working inside one git worktree. You get ONE task.
Make the smallest change that meets every acceptance criterion. Only change files the task allows.
Reply with JSON only (no prose, no markdown fences), exactly this shape:
{"summary": "<one or two sentences>", "edits": [<edit>, ...], "notes": ["<optional caveat>"]}
Each <edit> is one of:
  {"op": "replace", "path": "<file>", "old": "<exact current text>", "new": "<replacement text>"}
  {"op": "create",  "path": "<new file>", "content": "<whole file>"}
  {"path": "<file>", "content": "<the COMPLETE new file content>"}
Rules: paths are relative to the worktree root, use "/" separators, never start with "/" or contain "..".
For "replace", copy "old" exactly from the current file (same indentation, same blank lines), include enough
surrounding lines that it occurs exactly once, and do not use line numbers or "..." placeholders.
Prefer replacing a whole function or block over many one-line edits. Several "replace" edits on one file are
fine if they do not overlap. Use the whole-file form only for files shown in full below and only when most
of the file changes. You cannot delete files or run commands. If nothing needs to change, return "edits": [].`;

/** Extract the JSON object from a reply that may carry fences or stray prose. */
export function parseEditsReply(
  text: string,
  format: ApiEditFormat = 'auto',
): { ok: true; value: ApiEdits } | { ok: false; error: string } {
  let body = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fence?.[1] !== undefined) body = fence[1].trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start)
    return { ok: false, error: 'the reply contains no JSON object' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `the reply is not valid JSON (${(e as Error).message})` };
  }
  const checked = (format === 'whole' ? ApiWholeEditsSchema : ApiEditsSchema).safeParse(parsed);
  if (!checked.success) {
    return {
      ok: false,
      error: `the JSON does not match the schema: ${checked.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    };
  }
  return { ok: true, value: checked.data as ApiEdits };
}

export interface FileView {
  readonly path: string;
  readonly content: string | null;
  readonly note?: string;
}

const kib = (n: number) => `${String(Math.round(n / 1024))} KiB`;

/**
 * Current contents of the task's declared files (directories expand one level of files).
 * With `writable` (ADR-048 `auto`), files inside that scope are sent up to
 * `API_EDIT_LIMITS.sendWritableBytes` instead of `fileBytes`; the total budget is unchanged.
 */
export function gatherFiles(
  root: string,
  paths: readonly string[],
  opts: { readonly writable?: readonly string[] } = {},
): FileView[] {
  const out: FileView[] = [];
  const seen = new Set<string>();
  let total = 0;
  const add = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const checked = checkEditPath(root, rel);
    if (!checked.ok) return;
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      out.push({ path: rel, content: null, note: 'does not exist yet' });
      return;
    }
    const size = statSync(abs).size;
    const writable = opts.writable !== undefined && withinScope(checked.rel, opts.writable);
    const cap = writable ? API_EDIT_LIMITS.sendWritableBytes : API_RUNNER_LIMITS.fileBytes;
    if (size > cap || total + size > API_RUNNER_LIMITS.totalBytes) {
      out.push({
        path: rel,
        content: null,
        note:
          opts.writable === undefined
            ? `not sent (${String(size)} bytes, over the size limit)`
            : `not sent (${String(size)} bytes, over the size limit; cannot be edited by this runner)`,
      });
      return;
    }
    const buf = readFileSync(abs);
    if (buf.includes(0)) {
      out.push({ path: rel, content: null, note: 'binary file, not sent' });
      return;
    }
    total += size;
    out.push({
      path: rel,
      content: buf.toString('utf8'),
      ...(size > API_RUNNER_LIMITS.fileBytes
        ? { note: `${kib(size)}, edit with "replace" only` }
        : {}),
    });
  };
  for (const p of paths) {
    const clean = p.replace(/\/+$/, '');
    const abs = join(root, clean);
    if (p.endsWith('/') || (existsSync(abs) && statSync(abs).isDirectory())) {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        out.push({ path: p, content: null, note: 'directory does not exist yet' });
        continue;
      }
      const files = readdirSync(abs, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => `${clean}/${d.name}`)
        .sort()
        .slice(0, API_RUNNER_LIMITS.filesPerDir);
      for (const f of files) add(f);
    } else add(clean);
  }
  return out;
}

/** The user message for one attempt. Exported for tests. */
export function taskMessage(input: AgentTaskInput, files: readonly FileView[]): string {
  const { task } = input;
  const lines: string[] = [
    `Task ${task.id}: ${task.title}`,
    '',
    'Instructions:',
    task.instructions,
    '',
    'Acceptance criteria:',
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
    '',
    `Files you may change: ${task.files.write.length === 0 ? '(none: read-only task)' : task.files.write.join(', ')}`,
    `Files to read: ${task.files.read.length === 0 ? '(none listed)' : task.files.read.join(', ')}`,
  ];
  for (const d of input.dependencyResults) {
    lines.push('', `Earlier task ${d.taskId} (${d.status}): ${d.summary}`);
  }
  for (const p of input.priorAttempts ?? []) {
    lines.push(
      '',
      `Attempt ${String(p.attempt)}${p.model === null ? '' : ` by ${p.model}`} was not accepted (${p.outcome}): ${p.failure}`,
      ...(p.summary === null ? [] : [`It reported: ${p.summary}`]),
      ...p.findings.slice(0, 10).map((f) => `- ${f.kind}: ${f.message}`),
    );
  }
  lines.push('', 'Current files:');
  for (const f of files) {
    if (f.content === null) lines.push('', `=== ${f.path} (${f.note ?? 'not sent'}) ===`);
    else
      lines.push(
        '',
        f.note === undefined ? `=== ${f.path} ===` : `=== ${f.path} (${f.note}) ===`,
        f.content,
        `=== end ${f.path} ===`,
      );
  }
  lines.push('', 'Reply with the JSON object only.');
  return lines.join('\n');
}

/** What the files changed, for the attempt summary. */
function describeWrites(writes: readonly PlannedWrite[]): string {
  return writes
    .map((w) =>
      w.mode === 'replace'
        ? `replaced ${String(w.ops)} block${w.ops === 1 ? '' : 's'} in ${w.rel}${w.fuzzy > 0 ? ` (${String(w.fuzzy)} ignoring trailing spaces)` : ''}`
        : `${w.mode === 'create' ? 'created' : 'wrote'} ${w.rel}`,
    )
    .join(', ');
}

/** The repair-round message after edits that did not apply. */
function repairMessage(
  failures: readonly EditFailure[],
  wholeOk: readonly string[],
  format: ApiEditFormat,
): string {
  const lines = [
    'Those edits could not be applied, and nothing was written:',
    ...formatFailures(failures).map((f) => `- ${f}`),
  ];
  if (format === 'auto') {
    for (const p of wholeOk)
      lines.push(
        `For ${p} you may instead send the complete file with {"path": "${p}", "content": "..."}.`,
      );
  }
  lines.push(
    'Reply again with ONLY the JSON object in the required shape, containing every edit (including the ones that were fine).',
  );
  return lines.join('\n');
}

/** Direct-API runner. See the module comment. */
export class ApiAgentRunner implements AgentRunner {
  readonly kind = 'api';
  readonly #o: ApiRunnerOptions;
  readonly #clients = new Map<string, ModelClient>();

  constructor(options: ApiRunnerOptions) {
    this.#o = options;
  }

  #client(ref: string): ModelClient {
    let c = this.#clients.get(ref);
    if (c === undefined) {
      c = this.#o.clientFor(ref);
      this.#clients.set(ref, c);
    }
    return c;
  }

  async run(input: AgentTaskInput, signal: AbortSignal): Promise<unknown> {
    const now = this.#o.now ?? (() => performance.now());
    const started = now();
    const ref = input.assignment?.model ?? null;
    const root = input.workspace?.root;
    const result = (
      status: AgentResult['status'],
      summary: string,
      findings: Finding[],
      tokens: { input: number; output: number; cost: number | null },
    ): AgentResult => ({
      taskId: input.task.id,
      attempt: input.attempt,
      status,
      summary: summary.slice(0, 2000),
      findings: findings.slice(0, 50),
      patch: null,
      evidence: [],
      usage: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        durationMs: Math.max(0, now() - started),
        costUsd: tokens.cost,
        model: ref,
      },
    });
    const zero = { input: 0, output: 0, cost: null };
    if (ref === null) return result('failed', 'no model was routed to this attempt', [], zero);
    if (root === undefined && input.task.files.write.length > 0) {
      return result('failed', 'the api runner needs a task worktree', [], zero);
    }
    const client = this.#client(ref); // A ProviderError (e.g. missing key) propagates to the supervisor.
    const format: ApiEditFormat = this.#o.editFormat ?? 'auto';
    const writeScope = input.workspace?.writeScope ?? input.task.files.write;
    const files =
      root === undefined
        ? []
        : gatherFiles(
            root,
            [...input.task.files.write, ...input.task.files.read],
            format === 'auto' ? { writable: input.task.files.write } : {},
          );
    const sentInFull = new Set<string>();
    for (const f of files) {
      if (f.content === null || root === undefined) continue;
      const checked = checkEditPath(root, f.path);
      if (checked.ok) sentInFull.add(checked.rel);
    }
    const smallSent = new Set(
      files
        .filter(
          (f) => f.content !== null && Buffer.byteLength(f.content) <= API_RUNNER_LIMITS.fileBytes,
        )
        .map((f) => f.path),
    );
    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: taskMessage(input, files) },
    ];

    let inTok = 0;
    let outTok = 0;
    let cost: number | null = 0;
    let usageKnown = true;
    const count = (u: Usage) => {
      if (u.inputTokens === null || u.outputTokens === null) usageKnown = false;
      inTok += u.inputTokens ?? 0;
      outTok += u.outputTokens ?? 0;
      const c = this.#o.priceUsage(ref, u);
      cost = cost === null || c === null ? null : cost + c;
    };
    const totals = () => ({ input: inTok, output: outTok, cost: usageKnown ? cost : null });

    type Outcome =
      | { kind: 'unusable'; error: string }
      | { kind: 'not-applied'; failures: readonly EditFailure[] }
      | {
          kind: 'planned';
          value: ApiEdits;
          writes: readonly PlannedWrite[];
          unchanged: readonly string[];
        };
    const plan = (value: ApiEdits): Outcome => {
      if (value.edits.length === 0 || root === undefined)
        return { kind: 'planned', value, writes: [], unchanged: [] };
      const planned = planEdits({ root, writeScope, sentInFull, ops: value.edits });
      return planned.ok
        ? { kind: 'planned', value, writes: planned.writes, unchanged: planned.unchanged }
        : { kind: 'not-applied', failures: planned.failures };
    };

    const limitMs = this.#o.tryTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS;
    const provider = ref.split('/')[0] ?? ref;
    const outcome = await withTimeLimit(
      limitMs,
      signal,
      async (callSignal, requestTimeout): Promise<Outcome> => {
        let last: Outcome = { kind: 'unusable', error: 'no reply' };
        // Two rounds per try: one repair round for an unusable reply or edits that do not apply.
        for (let round = 0; round < 2; round++) {
          const response = await client.generate(
            {
              system: format === 'whole' ? SYSTEM_WHOLE : SYSTEM_EDITS,
              messages,
              maxOutputTokens: this.#o.maxOutputTokens ?? 16_000,
              timeoutMs: requestTimeout(),
            },
            callSignal,
          );
          count(response.usage);
          const reply = parseEditsReply(response.text, format);
          if (!reply.ok) {
            last = { kind: 'unusable', error: reply.error };
            if (response.finishReason === 'length') {
              last = { kind: 'unusable', error: 'the reply was cut off at the output token limit' };
              break;
            }
            messages.push(
              { role: 'assistant', content: response.text.slice(0, 200_000) },
              {
                role: 'user',
                content: `That reply could not be used: ${reply.error}. Reply again with ONLY the JSON object in the required shape.`,
              },
            );
            continue;
          }
          last = plan(reply.value);
          if (last.kind !== 'not-applied') break;
          const failed = new Set(last.failures.map((f) => f.path));
          const wholeOk = [...failed].filter((p) => smallSent.has(p));
          messages.push(
            { role: 'assistant', content: response.text.slice(0, 200_000) },
            { role: 'user', content: repairMessage(last.failures, wholeOk, format) },
          );
        }
        return last;
      },
      () =>
        new ProviderError({
          kind: 'timeout',
          provider,
          message: `timed out after ${formatLimit(limitMs)} waiting for ${ref} (per-try limit "modelCallTimeoutMs"); the request was aborted`,
        }),
    );
    if (outcome.kind === 'unusable') {
      return result(
        'failed',
        `[api] unusable reply from ${ref}: ${outcome.error}`,
        [{ kind: 'issue', message: outcome.error.slice(0, 2000) }],
        totals(),
      );
    }
    if (outcome.kind === 'not-applied') {
      const text = formatFailures(outcome.failures);
      return result(
        'failed',
        `[api] edits from ${ref} did not apply: ${outcome.failures[0]?.message ?? 'unknown'}`,
        text.slice(0, 10).map((m) => ({ kind: 'issue', message: m.slice(0, 2000) })),
        totals(),
      );
    }

    const { value, writes, unchanged } = outcome;
    const findings: Finding[] = (value.notes ?? []).map((n) => ({
      kind: 'observation',
      message: n,
    }));
    if (value.edits.length === 0) {
      return result('succeeded', `[api] ${value.summary} (no edits)`, findings, totals());
    }
    if (root === undefined) {
      return result(
        'failed',
        '[api] the model returned edits for a read-only task',
        findings,
        totals(),
      );
    }
    signal.throwIfAborted();
    const applied = applyPlan(root, writes);
    if (!applied.ok) {
      return result(
        'failed',
        `[api] ${applied.error}${applied.restored ? '' : ' (some files could not be restored; the worktree is reset before the next attempt)'}`,
        [...findings, { kind: 'issue', message: applied.error.slice(0, 2000) }],
        totals(),
      );
    }
    const touched =
      writes.length === 0
        ? ' (edits matched the current files)'
        : ` (${describeWrites(writes)}${unchanged.length > 0 ? `; unchanged ${unchanged.join(', ')}` : ''})`;
    return result('succeeded', `[api] ${value.summary}${touched}`, findings, totals());
  }
}
