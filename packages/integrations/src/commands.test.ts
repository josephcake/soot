import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCommand, runCheck, scrubbedEnv } from './commands.js';
import { NODE, POLICY } from './test-fixtures.js';

describe('command controls (M5-08)', () => {
  it('allows only allowlisted programs and refuses destructive ones', () => {
    expect(checkCommand([NODE, '--test'], POLICY)).toEqual({ allowed: true });
    expect(checkCommand(['/usr/bin/python3', 'x.py'], POLICY)).toMatchObject({ allowed: false });
    for (const argv of [
      ['rm', '-rf', '.'],
      ['/bin/sh', '-c', 'ls'],
      ['sudo', 'node'],
      ['git', 'push', '--force'],
      ['git', 'reset', '--hard'],
      ['git'],
    ]) {
      const policy = { allowedExecutables: [...POLICY.allowedExecutables, argv[0] ?? ''] };
      expect(checkCommand(argv, policy).allowed).toBe(false);
    }
    expect(checkCommand(['git', 'diff', '--stat'], { allowedExecutables: ['git'] })).toEqual({
      allowed: true,
    });
  });

  it('runs without a shell, with a scrubbed environment, and records real exit codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soot-cmd-'));
    try {
      process.env.FAKE_PROVIDER_API_KEY = 'sk-test-must-not-leak-1234567890';
      const env = scrubbedEnv();
      expect(Object.keys(env).some((k) => k.includes('KEY'))).toBe(false);
      const printEnv = await runCheck(
        {
          name: 'env',
          kind: 'acceptance',
          argv: [
            NODE,
            '-e',
            'console.log(JSON.stringify(process.env)); console.log("token sk-abcdefghijklmnop")',
          ],
        },
        { cwd: dir, policy: POLICY, commit: null },
      );
      expect(printEnv.status).toBe('passed');
      expect(printEnv.outputTail).not.toContain('sk-test-must-not-leak');
      expect(printEnv.outputTail).not.toContain('FAKE_PROVIDER_API_KEY');
      expect(printEnv.outputTail).toContain('token [redacted]');
      const fail = await runCheck(
        { name: 'f', kind: 'test', argv: [NODE, '-e', 'process.exit(3)'] },
        { cwd: dir, policy: POLICY, commit: null },
      );
      expect(fail).toMatchObject({ status: 'failed', exitCode: 3 });
      const metachar = await runCheck(
        { name: 'm', kind: 'test', argv: [NODE, '-e', 'process.exit(0)', '; rm -rf /'] },
        { cwd: dir, policy: POLICY, commit: null },
      );
      expect(metachar.status).toBe('passed'); // the "; rm -rf /" is just an argument; no shell
      const slow = await runCheck(
        {
          name: 's',
          kind: 'test',
          argv: [NODE, '-e', 'setTimeout(() => {}, 10000)'],
          timeoutMs: 100,
        },
        { cwd: dir, policy: POLICY, commit: null },
      );
      expect(slow.status).toBe('timed-out');
      const missing = await runCheck(
        { name: 'x', kind: 'lint', argv: ['/nonexistent/eslint'] },
        { cwd: dir, policy: { allowedExecutables: ['/nonexistent/eslint'] }, commit: null },
      );
      expect(missing.status).toBe('unavailable');
      const refused = await runCheck(
        { name: 'rm', kind: 'test', argv: ['rm', '-rf', dir] },
        { cwd: dir, policy: { allowedExecutables: ['rm'] }, commit: null },
      );
      expect(refused).toMatchObject({ status: 'refused', exitCode: null });
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
