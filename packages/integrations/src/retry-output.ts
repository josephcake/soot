import { redactSecrets } from '@soot/observability';
import {
  FAILED_CHECK_OUTPUT_LIMIT,
  REJECTED_CHANGE_DIFF_LIMIT,
  RESULT_LIST_LIMIT,
  type FailedCheck,
  type RejectedChange,
} from '@soot/task-graph';
import type { CheckEvidence } from './commands.js';
import type { FileChange } from './repository.js';

/*
 * What a retry or escalation sees of the check that rejected the previous attempt. Without it
 * the next attempt is told only "acceptance:title failed (exit 1)" and starts from a reset
 * worktree, so it can repeat or swap the same mistake (benchmark finding, 2026-11-14).
 */

/** Default bytes of check output passed to the next attempt. `0` turns it off. */
export const DEFAULT_RETRY_CHECK_OUTPUT_BYTES = 4096;

// CSI sequences (colors, cursor moves), OSC sequences (titles, links) and lone escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

/** Remove ANSI escape sequences and carriage-return overprints. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

/** The last `maxBytes` UTF-8 bytes of `text`, never splitting a character. */
export function tailBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let start = bytes.length - maxBytes;
  // Skip UTF-8 continuation bytes so the tail starts on a character boundary.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return { text: bytes.subarray(start).toString('utf8'), truncated: true };
}

/**
 * The first required check that did not pass, prepared for the next attempt: ANSI stripped,
 * key-like strings redacted (again, after stripping, so an escape code cannot hide one), and
 * cut to the last `maxBytes` bytes. `null` when every check passed or `maxBytes` is 0.
 */
export function failedCheckForRetry(
  checks: readonly CheckEvidence[],
  maxBytes: number = DEFAULT_RETRY_CHECK_OUTPUT_BYTES,
): FailedCheck | null {
  const limit = Math.min(Math.max(0, Math.floor(maxBytes)), FAILED_CHECK_OUTPUT_LIMIT);
  if (limit === 0) return null;
  const failing = checks.find((c) => c.required && c.status !== 'passed');
  if (failing === undefined || failing.status === 'passed') return null;
  const raw = failing.outputTail.trim() === '' ? (failing.reason ?? '') : failing.outputTail;
  const clean = redactSecrets(stripAnsi(raw)).trim();
  const { text, truncated } = tailBytes(clean, limit);
  return {
    name: failing.name,
    status: failing.status,
    exitCode: failing.exitCode,
    outputTail: text,
    truncated,
  };
}

/** Default bytes of a rejected attempt's diff passed to the next attempt. `0` turns it off. */
export const DEFAULT_RETRY_DIFF_BYTES = 8192;

/** The first `maxBytes` UTF-8 bytes of `text`, never splitting a character. */
export function headBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Back up over UTF-8 continuation bytes so the cut falls on a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * A rejected attempt's change, prepared for the next attempt: the changed files and the start
 * of the unified diff, ANSI-stripped and key-redacted, cut on a line boundary to `maxBytes`
 * bytes. The start is kept because a diff reads top-down (file headers, then hunks). `null`
 * when nothing changed or `maxBytes` is 0.
 */
export function rejectedChangeForRetry(
  commit: string | null,
  files: readonly FileChange[],
  diff: string,
  maxBytes: number = DEFAULT_RETRY_DIFF_BYTES,
): RejectedChange | null {
  const limit = Math.min(Math.max(0, Math.floor(maxBytes)), REJECTED_CHANGE_DIFF_LIMIT);
  if (limit === 0 || commit === null || files.length === 0) return null;
  const clean = redactSecrets(stripAnsi(diff));
  const cut = headBytes(clean, limit);
  let text = cut.text;
  if (cut.truncated) {
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline > 0) text = text.slice(0, lastNewline + 1);
  }
  return {
    commit,
    files: files.slice(0, RESULT_LIST_LIMIT).map((f) => ({ path: f.path, status: f.status })),
    diff: text.trimEnd(),
    truncated: cut.truncated || files.length > RESULT_LIST_LIMIT,
  };
}
