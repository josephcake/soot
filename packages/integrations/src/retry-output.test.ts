import { describe, expect, it } from 'vitest';
import type { CheckEvidence } from './commands.js';
import {
  failedCheckForRetry,
  headBytes,
  rejectedChangeForRetry,
  stripAnsi,
  tailBytes,
} from './retry-output.js';

const check = (over: Partial<CheckEvidence> = {}): CheckEvidence => ({
  name: 'acceptance:title',
  kind: 'acceptance',
  argv: ['node', '--test', 'acceptance/title.test.js'],
  status: 'failed',
  required: true,
  exitCode: 1,
  durationMs: 70,
  outputTail: 'not ok 1 - page title reads HELLO WORLD\n',
  reason: null,
  commit: 'abc',
  sandbox: 'none',
  ...over,
});

describe('stripAnsi', () => {
  it('removes color, cursor and OSC sequences and turns bare CRs into newlines', () => {
    const raw =
      '\u001b[31m✖ failed\u001b[39m\u001b[2K\r\u001b]8;;https://x\u0007link\u001b]8;;\u0007 done\r\n';
    expect(stripAnsi(raw)).toBe('✖ failed\nlink done\r\n');
  });
});

describe('tailBytes', () => {
  it('keeps short text whole', () => {
    expect(tailBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });

  it('keeps the last bytes and never splits a UTF-8 character', () => {
    const { text, truncated } = tailBytes('ab✖✖', 4); // ✖ is 3 bytes
    expect(truncated).toBe(true);
    expect(text).toBe('✖');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4);
  });
});

describe('failedCheckForRetry', () => {
  it('returns the first required check that did not pass', () => {
    const fc = failedCheckForRetry([
      check({ name: 'test', status: 'passed', exitCode: 0, outputTail: 'ok' }),
      check({ name: 'lint', required: false, outputTail: 'optional lint noise' }),
      check(),
    ]);
    expect(fc).toEqual({
      name: 'acceptance:title',
      status: 'failed',
      exitCode: 1,
      outputTail: 'not ok 1 - page title reads HELLO WORLD',
      truncated: false,
    });
  });

  it('returns null when every required check passed, or when turned off', () => {
    expect(failedCheckForRetry([check({ status: 'passed', exitCode: 0 })])).toBeNull();
    expect(failedCheckForRetry([check()], 0)).toBeNull();
  });

  it('caps the tail at the byte limit, keeping the end where the summary of a failure is', () => {
    const fc = failedCheckForRetry([check({ outputTail: `${'x'.repeat(10_000)}\nLAST LINE` })], 64);
    expect(fc?.truncated).toBe(true);
    expect(Buffer.byteLength(fc?.outputTail ?? '')).toBeLessThanOrEqual(64);
    expect(fc?.outputTail.endsWith('LAST LINE')).toBe(true);
  });

  it('never exceeds the schema ceiling, whatever the setting', () => {
    const fc = failedCheckForRetry([check({ outputTail: 'y'.repeat(40_000) })], 1_000_000);
    expect(Buffer.byteLength(fc?.outputTail ?? '')).toBe(16_384);
  });

  it('strips ANSI and redacts key-like strings, including ones split by escape codes', () => {
    const fc = failedCheckForRetry([
      check({
        outputTail:
          '\u001b[31mError\u001b[0m: OPENAI_API_KEY=abc123 sk-\u001b[1mabcdefghijklmnop\u001b[0m ghp_' +
          'A'.repeat(24),
      }),
    ]);
    expect(fc?.outputTail).toBe('Error: OPENAI_API_KEY=[redacted] [redacted] [redacted]');
  });

  it('uses the reason when a refused or unavailable check printed nothing', () => {
    const fc = failedCheckForRetry([
      check({ status: 'refused', exitCode: null, outputTail: '', reason: 'rm is not allowed' }),
    ]);
    expect(fc).toMatchObject({
      status: 'refused',
      exitCode: null,
      outputTail: 'rm is not allowed',
    });
  });
});

const DIFF = [
  'diff --git a/src/pages/index.html b/src/pages/index.html',
  'index 1111111..2222222 100644',
  '--- a/src/pages/index.html',
  '+++ b/src/pages/index.html',
  '@@ -5,7 +5,7 @@',
  '-    <h1 id="title">Demo</h1>',
  '+    <h1 id="title">HELLO WORLD</h1>',
  '',
].join('\n');
const SHA = 'e89bdf5896b1feb195755862d8b61d06c1964b72';
const modified = [{ path: 'src/pages/index.html', status: 'modified' as const }];

describe('headBytes', () => {
  it('keeps the first bytes without splitting a UTF-8 character', () => {
    expect(headBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
    const cut = headBytes('ab€€', 4); // € is 3 bytes: 'ab' + 2 bytes of € is not a character
    expect(cut).toEqual({ text: 'ab', truncated: true });
    expect(headBytes('ab€€', 5)).toEqual({ text: 'ab€', truncated: true });
  });
});

describe('rejectedChangeForRetry', () => {
  it('carries the files and the whole diff when it fits', () => {
    const rc = rejectedChangeForRetry(SHA, modified, DIFF);
    expect(rc).toEqual({ commit: SHA, files: modified, diff: DIFF.trimEnd(), truncated: false });
  });

  it('is null when off, when nothing was committed, or when no file changed', () => {
    expect(rejectedChangeForRetry(SHA, modified, DIFF, 0)).toBeNull();
    expect(rejectedChangeForRetry(null, modified, DIFF)).toBeNull();
    expect(rejectedChangeForRetry(SHA, [], '')).toBeNull();
  });

  it('keeps the start of a long diff, cut on a line boundary, and says so', () => {
    const long = `${DIFF}${'+line\n'.repeat(5000)}`;
    const rc = rejectedChangeForRetry(SHA, modified, long, 300);
    expect(rc?.truncated).toBe(true);
    expect(rc?.diff.startsWith('diff --git a/src/pages/index.html')).toBe(true);
    expect(Buffer.byteLength(rc?.diff ?? '')).toBeLessThanOrEqual(300);
    expect(rc?.diff.split('\n').every((l) => l === '+line' || DIFF.includes(l))).toBe(true);
  });

  it('never exceeds the 32 KiB schema ceiling', () => {
    const rc = rejectedChangeForRetry(SHA, modified, '+x\n'.repeat(40_000), 1_000_000);
    expect(Buffer.byteLength(rc?.diff ?? '')).toBeLessThanOrEqual(32_768);
  });

  it('redacts keys (also ones split by an escape code) and strips ANSI', () => {
    const rc = rejectedChangeForRetry(
      SHA,
      [{ path: '.env.example', status: 'added' }],
      '+OPENAI_API_KEY=sk-\u001b[31mabcdefghijklmnopqrstuvwxyz123456\n+token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );
    expect(rc?.diff).not.toMatch(/abcdefghijklmnop/);
    expect(rc?.diff).toContain('[redacted]');
    // eslint-disable-next-line no-control-regex
    expect(rc?.diff).not.toMatch(/\u001b/);
  });

  it('caps the file list at 50 and marks it truncated', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      path: `f${String(i)}.ts`,
      status: 'added' as const,
    }));
    const rc = rejectedChangeForRetry(SHA, many, '+x\n');
    expect(rc?.files).toHaveLength(50);
    expect(rc?.truncated).toBe(true);
  });
});
