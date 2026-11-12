#!/usr/bin/env node
import * as acp from '@agentclientprotocol/sdk';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { createMockAcpAgent, loadMockAcpScript } from './mock-agent.js';

/*
 * TEST DOUBLE entry point: `node mock-agent-bin.js <script.json> [log.jsonl]`. Serves the
 * scripted mock ACP agent over stdio so soot's spawn path can be tested without any vendor
 * harness.
 */

const [scriptPath, logPath] = process.argv.slice(2);
if (scriptPath === undefined) {
  process.stderr.write('usage: mock-agent-bin <script.json> [log.jsonl]\n');
  process.exit(1);
}
if (logPath !== undefined) {
  // Names only (never values): lets tests check that soot scrubbed the environment.
  appendFileSync(
    logPath,
    `${JSON.stringify({ pid: process.pid, method: 'start', cwd: process.cwd(), env: Object.keys(process.env).sort() })}\n`,
  );
}
const { app } = createMockAcpAgent(loadMockAcpScript(scriptPath), undefined, (entry) => {
  if (logPath !== undefined)
    appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
});
const connection = app.connect(
  acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);
await connection.closed;
