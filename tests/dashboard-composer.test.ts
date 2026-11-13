/**
 * The dashboard prompt box end to end (ADR-038), through the BUILT `soot` binary against a
 * temporary copy of examples/demo-app with the scripted mock agent. No model, key, network or
 * spend: a fake key value is planted in the environment and must never appear in a response.
 *
 * allow (CLI) → `soot dashboard --agent mock` → link (new each start) → cookie + CSRF → POST a prompt
 * (it plans and runs at once) → poll the job until the run finishes → the run is recorded.
 */
import { readFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_1, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';
import { CLI_BIN, buildWorkspace } from './helpers/workspace-build.js';

const SLOW = 120_000;
const FAKE_KEY = 'sk-ant-e2e-FAKE-VALUE-NEVER-SHOWN-0123';

beforeAll(async () => {
  await buildWorkspace();
}, 180_000);

let repo: DemoRepo | null = null;
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  repo?.dispose();
  repo = null;
});

function soot(r: DemoRepo, args: readonly string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: r.root, env: r.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function startDashboard(r: DemoRepo, args: readonly string[]) {
  const child = spawn(process.execPath, [CLI_BIN, 'dashboard', '--json', ...args], {
    cwd: r.root,
    env: { ...r.env, ANTHROPIC_API_KEY: FAKE_KEY },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  const info = await new Promise<Record<string, unknown> | null>((resolve) => {
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        // wait for the rest
      }
    });
    void exited.then(() => {
      resolve(null);
    });
  });
  return { child, info, exited, stderr: () => stderr };
}

describe('soot dashboard --agent mock: the prompt box', () => {
  it(
    'submits a prompt over HTTP with cookie + CSRF, plans and runs it at once, and the run completes',
    async () => {
      const r = (repo = createDemoRepo());
      // Folders are allowed from the CLI only.
      const allow = await soot(r, ['dashboard', 'allow', '.']);
      expect(allow.code, allow.stderr).toBe(0);
      const list = await soot(r, ['dashboard', 'list', '--json']);
      const listed = JSON.parse(list.stdout) as { projects: { id: string; path: string }[] };
      expect(listed.projects).toHaveLength(1);

      const d = await startDashboard(r, [
        '--agent',
        'mock',
        '--mock-script',
        'mock-agent.json',
        '--port',
        '0',
      ]);
      expect(d.info, d.stderr()).not.toBeNull();
      expect(d.info).toMatchObject({
        writes: true,
        runner: { kind: 'mock', label: 'mock (test double)' },
      });
      const port = d.info?.port as number;
      const base = `http://127.0.0.1:${String(port)}`;
      // Not a terminal: the link (with its token) is only in the 0600 link file (ADR-039).
      expect(String(d.info?.url)).not.toContain('token=');
      const link = readFileSync(String(d.info?.linkFile), 'utf8').trim();
      const token = new URL(link).searchParams.get('token') ?? '';
      const bodies: string[] = [];
      const read = async (res: Response) => {
        const t = await res.text();
        bodies.push(t, JSON.stringify([...res.headers]));
        return t;
      };

      // One-time link → session cookie, token gone from the address.
      const login = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
      expect(login.status).toBe(303);
      expect(login.headers.get('location')).toBe('/');
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      expect(cookie).toMatch(new RegExp(`^soot_session_${String(port)}=`));
      const get = async (p: string) =>
        JSON.parse(await read(await fetch(`${base}${p}`, { headers: { cookie } }))) as Record<
          string,
          unknown
        >;
      const session = (await get('/api/session')) as { csrf: string; writes: boolean };
      expect(session.writes).toBe(true);

      const { projects } = (await get('/api/projects')) as {
        projects: { id: string; label: string; runnerLabel: string; config: { ok: boolean } }[];
      };
      expect(projects.map((p) => [p.id, p.config.ok, p.runnerLabel])).toEqual([
        [listed.projects[0]?.id, true, 'mock (test double)'],
      ]);
      const id = projects[0]?.id ?? '';
      const keys = (await get(`/api/keys/status?project=${id}`)) as {
        providers: { id: string; keyVar: string; key: string }[];
      };
      expect(keys.providers.map((p) => [p.id, p.keyVar, p.key])).toEqual([
        ['anthropic', 'ANTHROPIC_API_KEY', 'set'],
        ['openai', 'OPENAI_API_KEY', 'missing'],
      ]);

      const headers = {
        cookie,
        origin: base,
        'content-type': 'application/json',
        'x-soot-csrf': session.csrf,
        'idempotency-key': 'e2e-key-0001',
      };
      // Without the CSRF header the same request is refused.
      const forged = await fetch(`${base}/api/prompts`, {
        method: 'POST',
        headers: { ...headers, 'x-soot-csrf': 'nope' },
        body: JSON.stringify({ project: id, prompt: TEST_1 }),
      });
      expect(forged.status).toBe(403);
      const submitted = await fetch(`${base}/api/prompts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ project: id, prompt: TEST_1 }),
      });
      expect(submitted.status).toBe(202);
      const { job } = JSON.parse(await read(submitted)) as { job: { id: string; state: string } };
      expect(job.state).toBe('planning');

      interface Job {
        state: string;
        runId: string | null;
        preview: { tasks: { taskId: string; model: string }[]; worstCaseUsd: number } | null;
        result: { status: string } | null;
      }
      let current: Job = job as unknown as Job;
      let sawRunning = false;
      for (
        let i = 0;
        i < 600 && (current.state === 'planning' || current.state === 'running');
        i++
      ) {
        await new Promise((res) => setTimeout(res, 100));
        current = ((await get(`/api/prompts/${job.id}`)) as { job: Job }).job;
        if (current.state === 'running') sawRunning = true;
      }
      expect(sawRunning).toBe(true);
      expect(current.state).toBe('done');
      // The demo's unattended approvals leave the result on the integration branch (v1).
      expect(current.result?.status).toBe('incomplete');
      expect(current.preview?.tasks.map((t) => [t.taskId, t.model])).toEqual([
        ['update-page-title', 'anthropic/claude-haiku-5-5'],
        ['update-button-color', 'anthropic/claude-haiku-5-5'],
      ]);
      expect(current.preview?.worstCaseUsd).toEqual(expect.any(Number));
      const runId = current.runId ?? '';
      const { run } = (await get(`/api/runs/${runId}`)) as {
        run: {
          prompt: string;
          tasks: { id: string; state: string }[];
          validation: { problems: string[] };
        };
      };
      expect(run.prompt).toBe(TEST_1);
      expect(run.tasks.map((t) => t.state)).toEqual(['succeeded', 'succeeded']);
      expect(run.validation.problems[0]).toMatch(/approval unavailable; result left on soot\//);
      // The idempotency key replays the same job instead of running it again.
      const replay = await fetch(`${base}/api/prompts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ project: id, prompt: TEST_1 }),
      });
      expect(replay.status).toBe(200);
      expect((JSON.parse(await read(replay)) as { job: { id: string } }).job.id).toBe(job.id);
      // `soot status` sees the same run.
      const status = await soot(r, ['status', '--json']);
      expect(
        (JSON.parse(status.stdout) as { runs: { runId: string }[] }).runs.map((x) => x.runId),
      ).toEqual([runId]);

      for (const p of ['/', '/app.js', '/api/runs', '/api/prompts'])
        await get(p).catch(() => undefined);
      const all = bodies.join('\n');
      expect(all).not.toContain(FAKE_KEY);
      expect(all).not.toContain(token);
      expect(d.stderr()).not.toContain(FAKE_KEY);

      d.child.kill('SIGINT');
      expect(await d.exited).toBe(0);
    },
    SLOW,
  );

  it(
    'refuses --config/--repo with the dashboard and mis-shaped allow commands; allow refuses non-projects',
    async () => {
      const r = (repo = createDemoRepo());
      expect((await soot(r, ['dashboard', '--config', 'x.json'])).stderr).toMatch(
        /--config and --repo do not apply/,
      );
      expect((await soot(r, ['dashboard', 'allow'])).code).toBe(1);
      expect((await soot(r, ['dashboard', 'allow', '/'])).stderr).toMatch(/no soot.config.json/);
      expect((await soot(r, ['dashboard', 'nope', 'x'])).stderr).toMatch(
        /unknown dashboard command/,
      );
      expect((await soot(r, ['dashboard', 'list', '--agent', 'acp'])).code).toBe(1);
    },
    SLOW,
  );
});
