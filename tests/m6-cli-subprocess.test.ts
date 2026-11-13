/**
 * Milestone 6, real processes: the BUILT `soot` binary as a user or a host harness would run
 * it. `soot stop` cancels a run in another process; `soot mcp` serves MCP on stdio to the
 * official MCP TypeScript SDK client, which drives a full fixture run. Fixture-backed: the
 * agent is the scripted mock, so no model or provider is called.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MOCK, TEST_1, cli, createDemoRepo, type DemoRepo } from './helpers/demo-repo.js';
import { CLI_BIN, buildWorkspace } from './helpers/workspace-build.js';

beforeAll(async () => {
  await buildWorkspace();
}, 180_000);

let repo: DemoRepo | null = null;
afterEach(() => {
  repo?.dispose();
  repo = null;
});

const SLOW = 60_000;

describe('soot binary', () => {
  it(
    '`soot stop` from another process cancels a running run cleanly',
    async () => {
      const r = (repo = createDemoRepo());
      // Both tasks take a minute unless aborted (the mock honours abort).
      const script = JSON.parse(r.read('mock-agent.json')) as {
        tasks: Record<string, Record<string, unknown>>;
      };
      for (const t of Object.values(script.tasks)) t.delayMs = 60_000;
      writeFileSync(join(r.top, 'slow.json'), JSON.stringify(script));
      const child = spawn(
        process.execPath,
        [
          CLI_BIN,
          'run',
          TEST_1,
          '--agent',
          'mock',
          '--mock-script',
          '../slow.json',
          '--run-id',
          'long',
          '--json',
        ],
        { cwd: r.root, env: r.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
      // Wait until the run holds its lock and both agents are running.
      const lock = join(r.dataDir, 'control', 'long.lock');
      const deadline = Date.now() + 20_000;
      for (;;) {
        const status = await cli(r, ['status', 'long', '--json']);
        if (status.code === 0) {
          const s = JSON.parse(status.stdout) as { state: string; tasks: { state: string }[] };
          if (s.state === 'running' && s.tasks.every((t) => t.state === 'running')) break;
        }
        if (Date.now() > deadline) throw new Error('run did not start');
        await new Promise((res) => setTimeout(res, 100));
      }
      expect(existsSync(lock)).toBe(true);
      const started = Date.now();
      const stop = await cli(r, ['stop', 'long']);
      expect(stop.code).toBe(0);
      expect(stop.stdout).toMatch(/Stop requested for long/);
      expect(await exited).toBe(3); // cancelled
      expect(Date.now() - started).toBeLessThan(10_000);
      const out = JSON.parse(stdout) as { stopRequested: boolean; report: { status: string } };
      expect(out).toMatchObject({ stopRequested: true, report: { status: 'cancelled' } });
      expect(existsSync(lock)).toBe(false);
      expect(r.git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
      expect(r.git('status', '--porcelain')).toBe('');
      expect((await cli(r, ['status', 'long'])).stdout).toMatch(/Run long: cancelled/);
    },
    SLOW,
  );

  it(
    '`soot mcp` serves the official MCP SDK client over stdio; soot_run returns the consolidated report',
    async () => {
      const r = (repo = createDemoRepo());
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CLI_BIN, 'mcp', ...MOCK],
        cwd: r.root,
        env: r.env,
        stderr: 'pipe',
      });
      const client = new Client({ name: 'soot-m6-test-host', version: '0.0.0' });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'soot_cost',
          'soot_models',
          'soot_run',
          'soot_status',
          'soot_stop',
        ]);
        const head = r.git('rev-parse', 'HEAD');
        const res = await client.callTool({
          name: 'soot_run',
          arguments: { prompt: TEST_1, runId: 'mcp1' },
        });
        expect(res.isError).toBe(false);
        const text = (res.content as { type: string; text: string }[])[0]?.text ?? '';
        expect(text).toMatch(/soot run mcp1 \(INCOMPLETE\)/);
        expect(text).toMatch(/\[x\] update-page-title — verified, merged/);
        expect(text).toMatch(
          /Working tree: not updated \(approval unavailable; result left on soot\/mcp1\/integration\)/,
        );
        const data = res.structuredContent as {
          report: { status: string; tasks: { verdict: string }[] };
        };
        expect(data.report.tasks.map((t) => t.verdict)).toEqual(['verified', 'verified']);
        // Unattended over MCP: the user's tree is untouched, the result waits on a branch.
        expect(r.git('rev-parse', 'HEAD')).toBe(head);
        expect(r.git('show', 'soot/mcp1/integration:src/pages/index.html')).toContain(
          'HELLO WORLD',
        );

        const status = await client.callTool({ name: 'soot_status', arguments: { runId: 'mcp1' } });
        expect((status.content as { text: string }[])[0]?.text).toMatch(/Run mcp1: incomplete/);
        const cost = await client.callTool({ name: 'soot_cost', arguments: {} });
        expect((cost.content as { text: string }[])[0]?.text).toMatch(
          /Total actual: \$0\.001630 over 2 attempts/,
        );
        const models = await client.callTool({ name: 'soot_models', arguments: {} });
        expect((models.content as { text: string }[])[0]?.text).toMatch(/openai\/gpt-6.1-terra/);
        const stop = await client.callTool({ name: 'soot_stop', arguments: { runId: 'mcp1' } });
        expect(stop.isError).toBe(true);
      } finally {
        await client.close();
      }
      expect(readFileSync(join(r.dataDir, 'audit', 'mcp1.jsonl'), 'utf8')).toMatch(
        /"approval-answered"/,
      );
    },
    SLOW,
  );

  it('prints its version and usage', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI_BIN, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (code) => {
          resolve({ code, out });
        });
      });
    expect(await run(['--version'])).toEqual({ code: 0, out: '0.0.0\n' });
    expect((await run(['--help'])).out).toMatch(/soot install-skill/);
  });
});
