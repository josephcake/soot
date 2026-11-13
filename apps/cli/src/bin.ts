#!/usr/bin/env node
import { main } from './cli.js';

const controller = new AbortController();
// Ctrl-C cancels the run cleanly (agents aborted, worktrees removed); a second one exits.
process.once('SIGINT', () => {
  controller.abort();
  process.once('SIGINT', () => process.exit(130));
});
// SIGTERM (kill, service managers) stops the same way, so the dashboard removes its link file.
process.once('SIGTERM', () => {
  controller.abort();
  process.once('SIGTERM', () => process.exit(143));
});

const code = await main(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  stdin: process.stdin,
  stdinIsTTY: process.stdin.isTTY,
  stdoutIsTTY: process.stdout.isTTY,
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
});
process.exitCode = code;
