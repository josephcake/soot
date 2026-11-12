import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_TOOL_NAMES,
  createSootMcpServer,
  type CommandOutput,
  type OrchestrationService,
  type RunRequest,
} from './index.js';

class FakeService implements OrchestrationService {
  readonly calls: string[] = [];
  lastRun: RunRequest | null = null;
  lastSignal: AbortSignal | undefined;
  run(request: RunRequest, signal?: AbortSignal): Promise<CommandOutput> {
    this.calls.push('run');
    this.lastRun = request;
    this.lastSignal = signal;
    return Promise.resolve({
      ok: true,
      text: 'Run r1: COMPLETE',
      data: { runId: 'r1', status: 'complete' },
    });
  }
  status(runId?: string): Promise<CommandOutput> {
    this.calls.push(`status:${runId ?? '*'}`);
    return Promise.resolve({
      ok: runId !== 'missing',
      text: runId === 'missing' ? 'unknown run missing' : 'runs: r1',
      data: { runs: ['r1'] },
    });
  }
  cost(runId?: string): Promise<CommandOutput> {
    this.calls.push(`cost:${runId ?? 'latest'}`);
    return Promise.resolve({ ok: true, text: 'Total actual: $0.000000', data: { runId: 'r1' } });
  }
  models(): Promise<CommandOutput> {
    this.calls.push('models');
    return Promise.resolve({ ok: true, text: 'alpha/test-small', data: { models: [] } });
  }
  stop(runId: string, taskId?: string): Promise<CommandOutput> {
    this.calls.push(taskId === undefined ? `stop:${runId}` : `stop:${runId}:${taskId}`);
    return Promise.resolve({ ok: true, text: `stop requested for ${runId}`, data: { runId } });
  }
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function connect(service: OrchestrationService) {
  const server = createSootMcpServer(service, { version: '0.0.0-test' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'soot-test-client', version: '0.0.0' });
  await client.connect(clientSide);
  close = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

describe('soot MCP server (official SDK client, in-process transport)', () => {
  it('lists the orchestration tools with schemas and hints', async () => {
    const client = await connect(new FakeService());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    const run = tools.find((t) => t.name === 'soot_run');
    expect(run?.inputSchema.required).toEqual(['prompt']);
    expect(run?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false });
    expect(run?.description).toMatch(/Unattended/);
    expect(tools.find((t) => t.name === 'soot_status')?.annotations?.readOnlyHint).toBe(true);
  });

  it('passes the prompt through verbatim and returns text plus structured data', async () => {
    const service = new FakeService();
    const client = await connect(service);
    const prompt =
      '  Change the page title to HELLO WORLD and update the primary button to purple.  ';
    const res = await client.callTool({ name: 'soot_run', arguments: { prompt, repo: '/tmp/x' } });
    expect(service.lastRun).toEqual({ prompt, repo: '/tmp/x' });
    expect(service.lastSignal).toBeInstanceOf(AbortSignal);
    expect(res.isError).toBe(false);
    expect(res.content).toEqual([{ type: 'text', text: 'Run r1: COMPLETE' }]);
    expect(res.structuredContent).toEqual({ runId: 'r1', status: 'complete' });
  });

  it('routes every tool to the service and marks failures as tool errors', async () => {
    const service = new FakeService();
    const client = await connect(service);
    await client.callTool({ name: 'soot_status', arguments: {} });
    const missing = await client.callTool({ name: 'soot_status', arguments: { runId: 'missing' } });
    await client.callTool({ name: 'soot_cost', arguments: {} });
    await client.callTool({ name: 'soot_models', arguments: {} });
    await client.callTool({ name: 'soot_stop', arguments: { runId: 'r1' } });
    await client.callTool({ name: 'soot_stop', arguments: { runId: 'r1', taskId: 'build-ui' } });
    expect(missing.isError).toBe(true);
    expect(service.calls).toEqual([
      'status:*',
      'status:missing',
      'cost:latest',
      'models',
      'stop:r1',
      'stop:r1:build-ui',
    ]);
  });

  it('rejects invalid arguments before reaching the engine', async () => {
    const service = new FakeService();
    const client = await connect(service);
    const bad = await client.callTool({ name: 'soot_stop', arguments: { runId: '../../etc' } });
    expect(bad.isError).toBe(true);
    const badTask = await client.callTool({
      name: 'soot_stop',
      arguments: { runId: 'r1', taskId: '../x' },
    });
    expect(badTask.isError).toBe(true);
    const empty = await client.callTool({ name: 'soot_run', arguments: { prompt: '' } });
    expect(empty.isError).toBe(true);
    expect(service.calls).toEqual([]);
  });
});
