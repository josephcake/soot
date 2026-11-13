import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/*
 * The dashboard's access link holds its session token (ADR-038). It is printed only to a
 * terminal; it is always also written here, readable by the owner only, so a dashboard whose
 * output goes to a log file can still be opened (ADR-039). Removed when the dashboard stops.
 */

export function linkFilePath(dataDir: string, port: number): string {
  return join(dataDir, `dashboard-link-${String(port)}.txt`);
}

/** Write the link atomically with mode 0600 and return the file's path. */
export function writeLinkFile(dataDir: string, port: number, url: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = linkFilePath(dataDir, port);
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${url}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

export function removeLinkFile(path: string): void {
  rmSync(path, { force: true });
}
