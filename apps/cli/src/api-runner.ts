import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentRunner, AgentTaskInput } from '@soot/agent-runtime';
import { ProviderError, type ModelClient, type Usage } from '@soot/provider-adapters';
import type { AgentResult, Finding } from '@soot/task-graph';
import { z } from 'zod';
import { DEFAULT_MODEL_CALL_TIMEOUT_MS, formatLimit, withTimeLimit } from './time-limit.js';

/*
 * Direct-API task runner (ADR-039). For each routed attempt it sends the task (instructions,
 * acceptance criteria, declared files and their current contents, what earlier attempts and
 * prerequisites reported) to the routed model through soot's provider adapters, asks for the
 * complete new contents of each file it changes as JSON, validates every path, and writes the
 * files into the task's worktree. soot then commits, verifies and merges as for any runner.
 *
 * The model never runs commands and never sees the original prompt or other tasks' transcripts
 * (build spec §7, §10). Keys stay inside @soot/provider-adapters (ADR-022).
 */

/** Per-file and total caps on what is sent, and on what a model may write. */
export const API_RUNNER_LIMITS = {
  fileBytes: 64 * 1024,
  totalBytes: 256 * 1024,
  filesPerDir: 40,
  editBytes: 512 * 1024,
  edits: 40,
} as const;

/** What the model must answer. Full file contents keep edits unambiguous. */
export const ApiEditsSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    edits: z
      .array(
        z
          .object({
            path: z.string().min(1).max(400),
            content: z.string().max(API_RUNNER_LIMITS.editBytes),
          })
          .strict(),
      )
      .max(API_RUNNER_LIMITS.edits),
    notes: z.array(z.string().min(1).max(1000)).max(20).optional(),
  })
  .strict();
export type ApiEdits = z.infer<typeof ApiEditsSchema>;

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
  readonly now?: () => number;
}

const SYSTEM = `You are a careful software engineer working inside one git worktree. You get ONE task.
Make the smallest change that meets every acceptance criterion. Only change files the task allows.
Reply with JSON only (no prose, no markdown fences), exactly this shape:
{"summary": "<one or two sentences>", "edits": [{"path": "<relative path>", "content": "<the COMPLETE new file content>"}], "notes": ["<optional caveat>"]}
Rules: paths are relative to the worktree root, use "/" separators, never start with "/" or contain "..";
"content" is the whole file after your change (not a diff); omit files you do not change; you cannot delete files
or run commands; if nothing needs to change, return "edits": [].`;

/** Extract the JSON object from a reply that may carry fences or stray prose. */
export function parseEditsReply(
  text: string,
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
  const checked = ApiEditsSchema.safeParse(parsed);
  if (!checked.success) {
    return {
      ok: false,
      error: `the JSON does not match the schema: ${checked.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    };
  }
  return { ok: true, value: checked.data };
}

/** A relative, normalized path inside `root`, or a reason it is refused. */
export function checkEditPath(
  root: string,
  path: string,
): { ok: true; rel: string } | { ok: false; reason: string } {
  if (path.includes('\0') || path.includes('\\'))
    return { ok: false, reason: 'invalid characters' };
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return { ok: false, reason: 'absolute path' };
  const parts = path.split('/');
  if (parts.some((p) => p === '..')) return { ok: false, reason: 'path escapes the worktree' };
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    return { ok: false, reason: 'path escapes the worktree' };
  if (rel.split(sep)[0] === '.git') return { ok: false, reason: 'git metadata' };
  // Refuse to write through a symlink anywhere on the way (it could point outside).
  let probe = root;
  for (const part of rel.split(sep)) {
    probe = join(probe, part);
    if (!existsSync(probe)) break;
    if (lstatSync(probe).isSymbolicLink())
      return { ok: false, reason: 'path goes through a symlink' };
  }
  const realRoot = realpathSync(root);
  let parent = dirname(target);
  while (!existsSync(parent)) parent = dirname(parent);
  const realParent = realpathSync(parent);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep))
    return { ok: false, reason: 'path escapes the worktree' };
  return { ok: true, rel: rel.split(sep).join('/') };
}

interface FileView {
  readonly path: string;
  readonly content: string | null;
  readonly note?: string;
}

/** Current contents of the task's declared files (directories expand one level of files). */
export function gatherFiles(root: string, paths: readonly string[]): FileView[] {
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
    if (size > API_RUNNER_LIMITS.fileBytes || total + size > API_RUNNER_LIMITS.totalBytes) {
      out.push({
        path: rel,
        content: null,
        note: `not sent (${String(size)} bytes, over the size limit)`,
      });
      return;
    }
    const buf = readFileSync(abs);
    if (buf.includes(0)) {
      out.push({ path: rel, content: null, note: 'binary file, not sent' });
      return;
    }
    total += size;
    out.push({ path: rel, content: buf.toString('utf8') });
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
    else lines.push('', `=== ${f.path} ===`, f.content, `=== end ${f.path} ===`);
  }
  lines.push('', 'Reply with the JSON object only.');
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
    const files =
      root === undefined
        ? []
        : gatherFiles(root, [...input.task.files.write, ...input.task.files.read]);
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

    const limitMs = this.#o.tryTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS;
    const provider = ref.split('/')[0] ?? ref;
    const parsed = await withTimeLimit(
      limitMs,
      signal,
      async (callSignal, requestTimeout) => {
        let reply: ReturnType<typeof parseEditsReply> = { ok: false, error: 'no reply' };
        for (let round = 0; round < 2; round++) {
          const response = await client.generate(
            {
              system: SYSTEM,
              messages,
              maxOutputTokens: this.#o.maxOutputTokens ?? 16_000,
              timeoutMs: requestTimeout(),
            },
            callSignal,
          );
          count(response.usage);
          reply = parseEditsReply(response.text);
          if (reply.ok) break;
          if (response.finishReason === 'length') {
            reply = { ok: false, error: 'the reply was cut off at the output token limit' };
            break;
          }
          // One repair round: show the model its own reply and the problem.
          messages.push(
            { role: 'assistant', content: response.text.slice(0, 200_000) },
            {
              role: 'user',
              content: `That reply could not be used: ${reply.error}. Reply again with ONLY the JSON object in the required shape.`,
            },
          );
        }
        return reply;
      },
      () =>
        new ProviderError({
          kind: 'timeout',
          provider,
          message: `timed out after ${formatLimit(limitMs)} waiting for ${ref} (per-try limit "modelCallTimeoutMs"); the request was aborted`,
        }),
    );
    if (!parsed.ok) {
      return result(
        'failed',
        `[api] unusable reply from ${ref}: ${parsed.error}`,
        [{ kind: 'issue', message: parsed.error.slice(0, 2000) }],
        totals(),
      );
    }

    const { value } = parsed;
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
    const planned: { rel: string; content: string }[] = [];
    for (const e of value.edits) {
      const checked = checkEditPath(root, e.path);
      if (!checked.ok) {
        return result(
          'failed',
          `[api] refused edit to "${e.path.slice(0, 200)}": ${checked.reason}`,
          [...findings, { kind: 'issue', message: `refused edit path: ${checked.reason}` }],
          totals(),
        );
      }
      planned.push({ rel: checked.rel, content: e.content });
    }
    const changed: string[] = [];
    for (const p of planned) {
      const abs = join(root, p.rel);
      if (existsSync(abs) && readFileSync(abs, 'utf8') === p.content) continue;
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, p.content);
      changed.push(p.rel);
    }
    signal.throwIfAborted();
    const touched =
      changed.length === 0
        ? ' (edits matched the current files)'
        : ` (wrote ${changed.join(', ')})`;
    return result('succeeded', `[api] ${value.summary}${touched}`, findings, totals());
  }
}
