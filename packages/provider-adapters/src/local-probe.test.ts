/**
 * ADR-045: probing local runtimes. Fake HTTP servers on 127.0.0.1 only; no real runtime and
 * no remote host is contacted.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { localRuntimeFromUrl } from '@soot/model-registry';
import { probeLocalRuntimes } from './local-probe.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((done) => {
          s.closeAllConnections();
          s.close(() => {
            done();
          });
        }),
    ),
  );
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
}

/** A port nothing listens on: bind, read the port, close. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done) =>
    server.close(() => {
      done();
    }),
  );
  return `http://127.0.0.1:${String(port)}/v1`;
}

describe('probeLocalRuntimes', () => {
  it('lists models with GET /v1/models and sends no authorization header', async () => {
    const seen: { url?: string; auth?: string }[] = [];
    const url = await serve((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization ?? '' });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ object: 'list', data: [{ id: 'llama3.2:3b' }, { id: 'qwen3:8b' }] }),
      );
    });
    const [probe] = await probeLocalRuntimes([localRuntimeFromUrl(url)]);
    expect(probe).toMatchObject({ status: 'found', modelIds: ['llama3.2:3b', 'qwen3:8b'] });
    expect(seen).toEqual([{ url: '/v1/models', auth: '' }]);
  });

  it('reports a closed port as unreachable, an HTTP error and non-JSON as error, all in parallel', async () => {
    const closed = await closedPort();
    const broken = await serve((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const html = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<html>not an api</html>');
    });
    const probes = await probeLocalRuntimes([closed, broken, html].map(localRuntimeFromUrl));
    expect(probes.map((p) => [p.status, p.reason])).toEqual([
      ['unreachable', 'nothing answered within 500 ms'],
      ['error', 'model listing failed with HTTP 500'],
      ['error', 'model listing was not readable JSON'],
    ]);
  });

  it('gives up on a runtime that never answers after the short limit', async () => {
    const hang = await serve(() => {
      // never responds
    });
    const started = Date.now();
    const [probe] = await probeLocalRuntimes([localRuntimeFromUrl(hang)], { timeoutMs: 150 });
    expect(probe).toMatchObject({
      status: 'unreachable',
      reason: 'nothing answered within 150 ms',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
