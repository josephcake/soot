/**
 * The direct-API runner (ADR-039) against a fake OpenAI-compatible server: what it sends, how it
 * applies whole-file edits, how it counts usage and cost, and what it refuses. No real provider
 * or key is used.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentTaskInput } from '@soot/agent-runtime';
import { ModelRegistry, actualCostFromUsage, parseRegistryConfig } from '@soot/model-registry';
import { createModelClient } from '@soot/provider-adapters';
import { parseAgentResult, type Task } from '@soot/task-graph';
import {
  ApiAgentRunner,
  SYSTEM_EDITS,
  SYSTEM_WHOLE,
  checkEditPath,
  parseEditsReply,
} from '../apps/cli/src/api-runner.js';
import { startFakeOpenAi, type FakeOpenAi, type FakeReply } from './helpers/fake-openai.js';

const FAKE_KEY = 'fake-test-key-not-a-secret-0001';
let server: FakeOpenAi | null = null;
let root: string | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

const registryFor = (baseURL: string) =>
  new ModelRegistry(
    parseRegistryConfig({
      version: 1,
      providers: [{ id: 'fake', kind: 'openai-compatible', baseURL, apiKeyEnv: 'FAKE_KEY' }],
      models: [
        {
          provider: 'fake',
          modelId: 'coder',
          capabilities: { tools: true, structuredOutput: true },
          pricing: {
            inputPerMTokUsd: 2,
            outputPerMTokUsd: 6,
            source: 'test price',
            asOf: '2026-11-13',
          },
        },
      ],
    }),
  );

const TASK: Task = {
  id: 'cta-orange',
  title: 'Make the CTA orange',
  instructions: 'Change .cta background from blue to orange in styles.css.',
  acceptanceCriteria: ['.cta background is orange'],
  requiredCapabilities: ['code-edit'],
  complexity: 'low',
  estimate: { inputTokens: 1000, outputTokens: 200, costUsd: null },
  files: { read: [], write: ['styles.css'] },
  dependsOn: [],
};

async function setup(
  replies: (index: number) => FakeReply,
  env: Record<string, string> = { FAKE_KEY },
  opts: {
    tryTimeoutMs?: number;
    retries?: number;
    editFormat?: 'auto' | 'whole';
    task?: Partial<Task>;
    files?: Record<string, string>;
  } = {},
) {
  server = await startFakeOpenAi((_r, i) => replies(i));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'soot-api-runner-')));
  writeFileSync(join(root, 'styles.css'), '.cta {\n  background: blue;\n}\n');
  for (const [p, c] of Object.entries(opts.files ?? {})) writeFileSync(join(root, p), c);
  const registry = registryFor(server.baseURL);
  const runner = new ApiAgentRunner({
    clientFor: (ref) => {
      const model = registry.get(ref);
      const provider = registry.provider('fake');
      if (model === undefined || provider === undefined) throw new Error('no model');
      return createModelClient(provider, model, {
        env,
        retry: { maxAttempts: opts.retries ?? 1, baseDelayMs: 1 },
      });
    },
    priceUsage: (ref, usage) => {
      const m = registry.get(ref);
      const c = m === undefined ? null : actualCostFromUsage(m, usage).costUsd;
      return c === null ? null : Number(c);
    },
    tryTimeoutMs: opts.tryTimeoutMs ?? 500,
    ...(opts.editFormat === undefined ? {} : { editFormat: opts.editFormat }),
  });
  const task = { ...TASK, ...opts.task };
  const input: AgentTaskInput = {
    task,
    attempt: 1,
    dependencyResults: [],
    assignment: { model: 'fake/coder', reason: 'test', escalationLevel: 0, estimatedCostUsd: null },
    workspace: { root, writeScope: task.files.write },
  };
  return { runner, input, root };
}

const edits = (path: string, content: string) =>
  JSON.stringify({ summary: 'made it orange', edits: [{ path, content }] });

describe('ApiAgentRunner', () => {
  it('sends the task and the file, writes the returned file, and reports exact usage and cost', async () => {
    const { runner, input, root } = await setup(() => ({
      content: edits('styles.css', '.cta {\n  background: orange;\n}\n'),
      promptTokens: 1234,
      completionTokens: 321,
    }));
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('succeeded');
    expect(result.summary).toMatch(/made it orange.*wrote styles\.css/);
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toContain('orange');
    expect(result.usage).toMatchObject({
      inputTokens: 1234,
      outputTokens: 321,
      model: 'fake/coder',
    });
    expect(result.usage.costUsd).toBeCloseTo((1234 * 2 + 321 * 6) / 1e6, 12);
    const sent = server?.requests[0];
    expect(sent?.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(sent?.body.model).toBe('coder');
    const user = sent?.body.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toMatch(/^Task cta-orange: Make the CTA orange/);
    expect(user).toContain('=== styles.css ===\n.cta {\n  background: blue;');
    expect(user).toContain('Files you may change: styles.css');
    // The key never appears in what the runner returns.
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  it('asks once more after a reply that is not JSON, and sums both calls', async () => {
    const { runner, input } = await setup((i) =>
      i === 0
        ? { content: 'Sure! I changed it.', promptTokens: 100, completionTokens: 10 }
        : {
            content: '```json\n' + edits('styles.css', '.cta { background: orange; }\n') + '\n```',
            promptTokens: 150,
            completionTokens: 40,
          },
    );
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('succeeded');
    expect(server?.requests).toHaveLength(2);
    expect(server?.requests[1]?.body.messages.at(-1)?.content).toMatch(
      /could not be used: the reply contains no JSON object/,
    );
    expect(result.usage).toMatchObject({ inputTokens: 250, outputTokens: 50 });
  });

  it('fails (with usage) after two unusable replies, and writes nothing', async () => {
    const { runner, input, root } = await setup(() => ({ content: '{"summary": "x"}' }));
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/unusable reply.*schema/);
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 100 });
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toContain('blue');
  });

  it('counts reasoning tokens a provider reports outside completion_tokens (billed as output)', async () => {
    const edits = JSON.stringify({ summary: 'none needed', edits: [] });
    for (const [counted, expected] of [
      ['outside', 10 + 500],
      ['inside', 10],
    ] as const) {
      await server?.close();
      const { runner, input } = await setup(() => ({
        content: edits,
        promptTokens: 100,
        completionTokens: 10,
        reasoning: { tokens: 500, counted },
      }));
      const result = parseAgentResult(await runner.run(input, new AbortController().signal));
      expect(result.usage.outputTokens).toBe(expected);
      expect(result.usage.costUsd).toBeCloseTo((100 * 2 + expected * 6) / 1e6, 12);
    }
  });

  it('reports empty edits as success with no change (soot then records no-changes)', async () => {
    const { runner, input, root } = await setup(() => ({
      content: JSON.stringify({ summary: 'already fine', edits: [] }),
    }));
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('succeeded');
    expect(result.summary).toMatch(/no edits/);
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toContain('blue');
  });

  it.each(['../escape.txt', '/etc/passwd', '.git/config', 'a/../../x', 'C:/x'])(
    'refuses the edit path %s and writes nothing',
    async (path) => {
      const { runner, input, root } = await setup(() => ({ content: edits(path, 'x') }));
      const result = parseAgentResult(await runner.run(input, new AbortController().signal));
      expect(result.status).toBe('failed');
      expect(result.summary).toMatch(/refused edit/);
      expect(existsSync(join(root, '..', 'escape.txt'))).toBe(false);
    },
  );

  it('refuses to write through a symlink that leaves the worktree', async () => {
    const { runner, input, root } = await setup(() => ({ content: edits('out/file.txt', 'x') }));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'soot-outside-')));
    symlinkSync(outside, join(root, 'out'));
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('failed');
    expect(existsSync(join(outside, 'file.txt'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('turns a hung request into a timeout ProviderError the supervisor can act on', async () => {
    const { runner, input } = await setup(() => ({ hang: true }));
    const error = await runner.run(input, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ProviderError', kind: 'timeout', provider: 'fake' });
    expect((error as Error).message).toMatch(
      /timed out after 500 ms waiting for fake\/coder \(per-try limit "modelCallTimeoutMs"\); the request was aborted/,
    );
    await vi.waitFor(() => {
      expect(server?.aborted()).toBe(1); // the HTTP request itself was aborted, not left running
    });
  });

  it('the per-try limit is wall-clock: it covers the adapter retries of a slow model', async () => {
    // Each request would answer after 400 ms but the adapter's own 300 ms request limit fires
    // first; without a wall-clock budget, 3 adapter retries would take ~900 ms or more.
    const { runner, input } = await setup(
      () => ({ content: '{}', delayMs: 5000 }),
      { FAKE_KEY },
      { tryTimeoutMs: 300, retries: 3 },
    );
    const started = Date.now();
    await expect(runner.run(input, new AbortController().signal)).rejects.toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining('timed out after 300 ms') as unknown,
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('the per-try limit also covers the repair round', async () => {
    const { runner, input } = await setup(
      (i) =>
        i === 0
          ? { content: 'not json', promptTokens: 10, completionTokens: 5 }
          : { content: '{}', delayMs: 5000 },
      { FAKE_KEY },
      { tryTimeoutMs: 400 },
    );
    await expect(runner.run(input, new AbortController().signal)).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(server?.requests).toHaveLength(2);
  });

  it('a slow reply inside the limit is used as normal', async () => {
    const reply = JSON.stringify({
      summary: 'orange',
      edits: [{ path: 'styles.css', content: '.cta {\n  background: orange;\n}\n' }],
    });
    const { runner, input, root } = await setup(
      () => ({ content: reply, delayMs: 150 }),
      { FAKE_KEY },
      { tryTimeoutMs: 2000 },
    );
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('succeeded');
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toContain('orange');
  });

  it('cancelling the attempt is not reported as a timeout', async () => {
    const { runner, input } = await setup(
      () => ({ hang: true }),
      { FAKE_KEY },
      { tryTimeoutMs: 5000 },
    );
    const stop = new AbortController();
    setTimeout(() => {
      stop.abort();
    }, 100);
    const error = await runner.run(input, stop.signal).catch((e: unknown) => e);
    expect(error).not.toMatchObject({ kind: 'timeout' });
  });

  it('a missing key is an auth ProviderError and nothing is sent', async () => {
    const { runner, input } = await setup(() => ({ content: '{}' }), {});
    const error = await runner.run(input, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'auth' });
    expect((error as Error).message).toMatch(/FAKE_KEY is not set/);
    expect(server?.requests).toHaveLength(0);
  });

  it('a provider 429 surfaces as rate-limited', async () => {
    const { runner, input } = await setup(() => ({ status: 429, error: 'slow down' }));
    await expect(runner.run(input, new AbortController().signal)).rejects.toMatchObject({
      kind: 'rate-limited',
    });
  });
});

const replace = (path: string, old: string, n: string) =>
  JSON.stringify({ summary: 'targeted', edits: [{ op: 'replace', path, old, new: n }] });
const systemOf = (i: number) =>
  server?.requests[i]?.body.messages.find((m) => m.role === 'system')?.content ?? '';
const userOf = (i: number) =>
  server?.requests[i]?.body.messages.find((m) => m.role === 'user')?.content ?? '';

describe('ApiAgentRunner targeted edits (ADR-048)', () => {
  it('R1 applies a replace edit; the request uses the edits prompt', async () => {
    const { runner, input, root } = await setup(() => ({
      content: replace('styles.css', 'background: blue;', 'background: orange;'),
      promptTokens: 300,
      completionTokens: 30,
    }));
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('succeeded');
    expect(result.summary).toMatch(/targeted \(replaced 1 block in styles\.css\)/);
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toBe(
      '.cta {\n  background: orange;\n}\n',
    );
    expect(systemOf(0)).toBe(SYSTEM_EDITS);
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
    expect(result.usage.costUsd).toBeCloseTo((300 * 2 + 30 * 6) / 1e6, 12);
  });

  it('R2 an ambiguous edit gets one repair round that names the problem, then applies', async () => {
    const { runner, input, root } = await setup((i) =>
      i === 0
        ? { content: replace('styles.css', 'b', 'x'), promptTokens: 100, completionTokens: 10 }
        : {
            content: replace('styles.css', 'background: blue;', 'background: orange;'),
            promptTokens: 150,
            completionTokens: 20,
          },
    );
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('succeeded');
    expect(server?.requests).toHaveLength(2);
    const repair = server?.requests[1]?.body.messages.at(-1)?.content ?? '';
    expect(repair).toMatch(/could not be applied, and nothing was written/);
    expect(repair).toMatch(/\(ambiguous\): "old" text matches 2 places in styles\.css/);
    expect(result.usage).toMatchObject({ inputTokens: 250, outputTokens: 30 });
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toContain('orange');
  });

  it('R3 a not-found edit on a file sent in full can fall back to the whole file', async () => {
    const { runner, input, root } = await setup((i) =>
      i === 0
        ? { content: replace('styles.css', 'background: red;', 'background: orange;') }
        : { content: edits('styles.css', '.cta {\n  background: orange;\n}\n') },
    );
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(server?.requests[1]?.body.messages.at(-1)?.content).toMatch(
      /For styles\.css you may instead send the complete file/,
    );
    expect(result.status).toBe('succeeded');
    expect(result.summary).toMatch(/wrote styles\.css/);
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toContain('orange');
  });

  it('R4 two rounds of edits that do not apply: failed with findings, nothing written, no throw', async () => {
    const { runner, input, root } = await setup(() => ({
      content: JSON.stringify({
        summary: 's',
        edits: [
          { op: 'replace', path: 'styles.css', old: 'nope', new: 'x' },
          { op: 'create', path: 'styles.css', content: 'x' },
        ],
      }),
    }));
    const before = readFileSync(join(root, 'styles.css'));
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/^\[api\] edits from fake\/coder did not apply: /);
    expect(result.findings.map((f) => f.message).join('\n')).toMatch(/\(mixed-ops\)/);
    expect(server?.requests).toHaveLength(2);
    expect(readFileSync(join(root, 'styles.css')).equals(before)).toBe(true);
  });

  it('R5 a 100 KiB writable file is sent in full in auto mode, and not sent in whole mode', async () => {
    const big = `/* big */\n${'.x { color: red; }\n'.repeat(5600)}`;
    const task = { files: { read: [], write: ['styles.css', 'big.css'] } };
    for (const editFormat of ['auto', 'whole'] as const) {
      await server?.close();
      const { runner, input, root } = await setup(
        () => ({ content: replace('big.css', '/* big */', '/* bigger */') }),
        { FAKE_KEY },
        { editFormat, task, files: { 'big.css': big } },
      );
      const result = parseAgentResult(await runner.run(input, new AbortController().signal));
      if (editFormat === 'auto') {
        expect(userOf(0)).toMatch(
          /=== big\.css \(\d+ KiB, edit with "replace" only\) ===\n\/\* big \*\//,
        );
        expect(result.status).toBe('succeeded');
        expect(readFileSync(join(root, 'big.css'), 'utf8').startsWith('/* bigger */')).toBe(true);
      } else {
        expect(userOf(0)).toMatch(
          /=== big\.css \(not sent \(\d+ bytes, over the size limit\)\) ===/,
        );
        expect(result.status).toBe('failed'); // a replace reply is a schema error in whole mode
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('R6 whole mode sends the ADR-039 prompt verbatim and refuses replace edits', async () => {
    const { runner, input, root } = await setup(
      () => ({ content: replace('styles.css', 'blue', 'orange') }),
      { FAKE_KEY },
      { editFormat: 'whole' },
    );
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(systemOf(0)).toBe(SYSTEM_WHOLE);
    expect(SYSTEM_WHOLE).toMatch(/"content" is the whole file after your change \(not a diff\)/);
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/unusable reply.*schema/);
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toContain('blue');
  });

  it('R7 an edit outside the write lease is refused before anything is written', async () => {
    const { runner, input, root } = await setup(() => ({
      content: JSON.stringify({
        summary: 's',
        edits: [
          { op: 'replace', path: 'styles.css', old: 'blue', new: 'orange' },
          { op: 'create', path: 'other.css', content: 'x' },
        ],
      }),
    }));
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(result.status).toBe('failed');
    expect(result.summary).toMatch(/other\.css is outside this task's write lease \(styles\.css\)/);
    expect(existsSync(join(root, 'other.css'))).toBe(false);
    expect(readFileSync(join(root, 'styles.css'), 'utf8')).toContain('blue');
  });

  it('a whole-file reply cannot overwrite a file the model was not shown', async () => {
    const huge = 'y'.repeat(300 * 1024);
    const { runner, input, root } = await setup(
      () => ({ content: edits('huge.txt', 'tiny') }),
      { FAKE_KEY },
      { task: { files: { read: [], write: ['huge.txt'] } }, files: { 'huge.txt': huge } },
    );
    const result = parseAgentResult(await runner.run(input, new AbortController().signal));
    expect(userOf(0)).toMatch(/huge\.txt \(not sent .*cannot be edited by this runner\)/);
    expect(result.status).toBe('failed');
    expect(result.findings.map((f) => f.message).join('\n')).toMatch(/\(not-seen\)/);
    expect(readFileSync(join(root, 'huge.txt'), 'utf8')).toBe(huge);
  });
});

describe('parseEditsReply / checkEditPath', () => {
  it('accepts bare JSON, fenced JSON, and JSON with stray prose around it', () => {
    const body = edits('a.txt', 'x');
    for (const text of [body, '```json\n' + body + '\n```', `Here you go:\n${body}\nDone.`]) {
      expect(parseEditsReply(text)).toMatchObject({
        ok: true,
        value: { edits: [{ path: 'a.txt' }] },
      });
    }
    expect(parseEditsReply('{"summary": "s", "edits": [], "extra": 1}').ok).toBe(false);
    expect(parseEditsReply('no json here').ok).toBe(false);
  });

  it('normalizes paths inside the root and refuses the rest', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'soot-paths-')));
    mkdirSync(join(dir, 'src'));
    expect(checkEditPath(dir, 'src/./a.js')).toEqual({ ok: true, rel: 'src/a.js' });
    expect(checkEditPath(dir, 'new/dir/file.js')).toEqual({ ok: true, rel: 'new/dir/file.js' });
    for (const bad of ['', '.', '..', '../x', 'src/../../x', '/abs', 'a\\b', '.git/HEAD'])
      expect(checkEditPath(dir, bad).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
