import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_SETTINGS,
  findProgram,
  probeBackend,
  resolveSandbox,
} from '@soot/agent-runtime';
import { spawnAcpAgent } from './spawn.js';

/* ADR-051: the ACP agent process is spawned under the process sandbox. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const wt = () => {
  const d = mkdtempSync(join(tmpdir(), 'soot-acp-sbx-'));
  dirs.push(d);
  return d;
};
const NODE = process.execPath;
const bwrap = findProgram('bwrap', process.env.PATH);
const bwrapWorks =
  process.platform === 'linux' && bwrap !== null && probeBackend('bwrap', bwrap) === null;

describe('spawnAcpAgent under a sandbox (ADR-051)', () => {
  it('a blocked sandbox refuses to start the agent at all', () => {
    const blocked = resolveSandbox(
      { ...DEFAULT_SANDBOX_SETTINGS, required: true },
      { platform: 'win32', home: null, dataDir: null, path: '' },
    );
    const connect = spawnAcpAgent({ command: NODE, args: ['-e', ''] }, {}, { sandbox: blocked });
    expect(() => connect(wt())).toThrow(/no real sandbox/);
  });

  it('the fallback says so in the agent label', async () => {
    const endpoint = await spawnAcpAgent({ command: NODE, args: ['-e', ''] }, { PATH: '' })(wt());
    expect(endpoint.label).toContain('[no OS sandbox]');
    await endpoint.close();
  });

  it.skipIf(!bwrapWorks)('real bwrap: the agent runs isolated and its label says so', async () => {
    const sandbox = resolveSandbox(DEFAULT_SANDBOX_SETTINGS, {
      platform: 'linux',
      home: null,
      dataDir: null,
      path: process.env.PATH ?? '',
    });
    const dir = wt();
    const endpoint = await spawnAcpAgent(
      {
        command: NODE,
        args: [
          '-e',
          `try { require('fs').writeFileSync(${JSON.stringify(join(tmpdir(), 'soot-acp-escape'))}, 'x'); console.error('ESCAPED'); } catch (e) { console.error('blocked ' + e.code); }`,
        ],
      },
      { PATH: process.env.PATH ?? '' },
      { sandbox },
    )(dir);
    expect(endpoint.label).toContain('[sandbox bwrap]');
    await new Promise((r) => setTimeout(r, 500));
    await endpoint.close();
    // /tmp inside the sandbox is private: even a "successful" write never reaches the host.
    expect(existsSync(join(tmpdir(), 'soot-acp-escape'))).toBe(false);
  });
});
