import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_SETTINGS,
  SANDBOX_EXEC,
  findProgram,
  probeBackend,
  resolveSandbox,
  unsandboxed,
  type Sandbox,
} from './sandbox.js';
import { runSandboxed } from './sandbox-process.js';

/*
 * ADR-051 process tests. The fallback (`none`) tests run everywhere and pin down what it does
 * and does NOT do. The bwrap tests are real: they run only where `bwrap` is on PATH and works
 * (the probe passes), and are skipped otherwise. The sandbox-exec tests are real too: they run
 * only on macOS.
 */

const NODE = process.execPath;
const dirs: string[] = [];
const temp = (prefix = 'soot-sbxp-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const env = { PATH: process.env.PATH ?? '' };
const run = (sandbox: Sandbox, cwd: string, code: string, extra: object = {}) =>
  runSandboxed([NODE, '-e', code], { sandbox, cwd, env, timeoutMs: 10_000, ...extra });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('fallback "none": soot protections only, never isolation', () => {
  it('pins cwd, strips credentials from env, uses no shell', async () => {
    const wt = temp();
    const r = await runSandboxed(
      [NODE, '-e', 'console.log(process.cwd(), JSON.stringify(process.env))', '; echo pwned'],
      {
        sandbox: unsandboxed(),
        cwd: wt,
        env: { ...env, OPENAI_API_KEY: 'sk-must-not-leak', GH_TOKEN: 'x', KEEP_ME: '1' },
        timeoutMs: 10_000,
      },
    );
    expect(r).toMatchObject({ kind: 'exited', exitCode: 0, backend: 'none' });
    expect(r.output).toContain(wt);
    expect(r.output).toContain('KEEP_ME');
    expect(r.output).not.toContain('sk-must-not-leak');
    expect(r.output).not.toContain('GH_TOKEN');
    expect(r.output).not.toContain('pwned');
  });

  it('kills the whole process group on timeout (grandchildren too)', async () => {
    const wt = temp();
    const pidFile = join(wt, 'grandchild.pid');
    const code = `
      const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
      setInterval(() => {}, 1000);`;
    const r = await run(unsandboxed(), wt, code, { timeoutMs: 1500 });
    expect(r.kind).toBe('timed-out');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(pid)).toBe(false);
  });

  it('caps output: the process is killed once the cap is passed; only a tail is kept', async () => {
    const wt = temp();
    const r = await run(
      unsandboxed(),
      wt,
      'const s = "x".repeat(65536); const w = () => process.stdout.write(s, w); w();',
      { maxOutputBytes: 1024 * 1024, keepChars: 1000 },
    );
    expect(r.kind).toBe('output-limit');
    expect(r.output.length).toBeLessThanOrEqual(1000);
    expect(r.outputBytes).toBeGreaterThan(1024 * 1024);
  });

  it('cancels on abort, reports a missing program, refuses when blocked', async () => {
    const wt = temp();
    const ac = new AbortController();
    const p = run(unsandboxed(), wt, 'setInterval(() => {}, 1000)', { signal: ac.signal });
    setTimeout(() => {
      ac.abort();
    }, 200);
    expect((await p).kind).toBe('cancelled');
    const missing = await runSandboxed(['/nonexistent/tool'], {
      sandbox: unsandboxed(),
      cwd: wt,
      env,
      timeoutMs: 1000,
    });
    expect(missing).toMatchObject({ kind: 'not-found', backend: null });
    const blocked = resolveSandbox(
      { ...DEFAULT_SANDBOX_SETTINGS, mode: 'none', required: true },
      { platform: 'linux', home: null, dataDir: null, path: '' },
    );
    const b = await run(blocked, wt, 'require("fs").writeFileSync("ran", "1")');
    expect(b).toMatchObject({ kind: 'blocked', backend: null });
    expect(existsSync(join(wt, 'ran'))).toBe(false);
  });

  it('LIMIT: does not stop writes outside the worktree (that is why it is not isolation)', async () => {
    const wt = temp();
    const outside = temp();
    const r = await run(
      unsandboxed(),
      wt,
      `require('fs').writeFileSync(${JSON.stringify(join(outside, 'escaped'))}, '1')`,
    );
    expect(r.kind).toBe('exited');
    expect(existsSync(join(outside, 'escaped'))).toBe(true);
  });
});

// Real bwrap: only when it is installed and works here (user namespaces allowed).
const bwrap = findProgram('bwrap', process.env.PATH);
const bwrapWorks =
  bwrap !== null && process.platform === 'linux' && probeBackend('bwrap', bwrap) === null;

describe.skipIf(!bwrapWorks)('bwrap backend (real; runs only where bwrap works)', () => {
  const setup = () => {
    const base = temp('soot-sbx-real-');
    const home = join(base, 'home');
    const dataDir = join(home, '.soot');
    const wt = join(dataDir, 'worktrees', 'r', 't');
    const outside = join(base, 'outside');
    for (const d of [wt, outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, '.secret'), 'top secret');
    writeFileSync(join(dataDir, 'soot.sqlite'), 'db');
    const sandbox = resolveSandbox(DEFAULT_SANDBOX_SETTINGS, {
      platform: 'linux',
      home,
      dataDir,
      path: process.env.PATH ?? '',
    });
    expect(sandbox).toMatchObject({ backend: 'bwrap', isolation: true, blocked: null });
    return { base, home, dataDir, wt, outside, sandbox };
  };

  it('writes only inside the worktree; outside, home and the DB are not writable', async () => {
    const { wt, outside, home, dataDir, sandbox } = setup();
    const code = `
      const fs = require('fs');
      const out = {};
      try { out.secret = fs.readFileSync(${JSON.stringify(join(home, '.secret'))}, 'utf8'); } catch (e) { out.secret = e.code; }
      const tryWrite = (k, p) => { try { fs.writeFileSync(p, 'x'); out[k] = 'written'; } catch (e) { out[k] = e.code; } };
      tryWrite('worktree', 'inside.txt');
      tryWrite('tmp', '/tmp/t.txt');
      tryWrite('outside', ${JSON.stringify(join(outside, 'escaped'))});
      tryWrite('db', ${JSON.stringify(join(dataDir, 'soot.sqlite'))});
      tryWrite('dotfile', ${JSON.stringify(join(home, '.secret'))});
      console.log(JSON.stringify(out));`;
    const r = await run(sandbox, wt, code);
    expect(r).toMatchObject({ kind: 'exited', exitCode: 0, backend: 'bwrap' });
    const out = JSON.parse(r.output.trim()) as Record<string, string>;
    expect(out.worktree).toBe('written');
    expect(out.tmp).toBe('written');
    expect(out.outside).not.toBe('written');
    expect(existsSync(join(outside, 'escaped'))).toBe(false);
    expect(readFileSync(join(dataDir, 'soot.sqlite'), 'utf8')).toBe('db');
    expect(readFileSync(join(home, '.secret'), 'utf8')).toBe('top secret');
    expect(out.secret).toBe('ENOENT'); // home is hidden (an empty tmpfs)
    expect(out.dotfile).toBe('EROFS'); // ...and read-only: the write fails
    expect(out.db).not.toBe('written');
    expect(readFileSync(join(wt, 'inside.txt'), 'utf8')).toBe('x');
  });

  it('blocks network by default (no interfaces but loopback)', async () => {
    const { wt, sandbox } = setup();
    const code = `
      const net = require('net');
      const os = require('os');
      const ifaces = Object.keys(os.networkInterfaces());
      const s = net.connect({ host: '1.1.1.1', port: 80, timeout: 3000 });
      s.on('connect', () => { console.log(JSON.stringify({ ifaces, net: 'connected' })); process.exit(0); });
      s.on('timeout', () => { console.log(JSON.stringify({ ifaces, net: 'timeout' })); process.exit(0); });
      s.on('error', (e) => { console.log(JSON.stringify({ ifaces, net: e.code })); process.exit(0); });`;
    const r = await run(sandbox, wt, code);
    expect(r.kind).toBe('exited');
    const out = JSON.parse(r.output.trim()) as { ifaces: string[]; net: string };
    expect(out.net).not.toBe('connected');
    expect(out.net).toBe('ENETUNREACH');
    expect(out.ifaces.every((i) => i === 'lo')).toBe(true);
  });

  it('kills the sandbox tree on timeout', async () => {
    const { wt, sandbox } = setup();
    const r = await run(sandbox, wt, 'setInterval(() => {}, 1000)', { timeoutMs: 800 });
    expect(r).toMatchObject({ kind: 'timed-out', backend: 'bwrap' });
  });

  it('git internals stay read-only from inside a real worktree', async () => {
    const { wt, sandbox, base } = setup();
    // A fake linked-worktree layout: .git file → gitdir → commondir.
    const common = join(base, 'repo', '.git');
    const gitDir = join(common, 'worktrees', 't');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(common, 'config'), '[core]\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`);
    const code = `
      const fs = require('fs');
      const out = {};
      try { fs.appendFileSync(${JSON.stringify(join(common, 'config'))}, 'x'); out.config = 'written'; } catch (e) { out.config = e.code; }
      try { fs.writeFileSync('.git', 'gitdir: /elsewhere'); out.dotgit = 'written'; } catch (e) { out.dotgit = e.code; }
      console.log(JSON.stringify(out));`;
    const r = await run(sandbox, wt, code);
    const out = JSON.parse(r.output.trim()) as Record<string, string>;
    expect(out.config).toBe('EROFS');
    expect(out.dotgit).toBe('EROFS');
    expect(readFileSync(join(common, 'config'), 'utf8')).toBe('[core]\n');
  });

  it('the real home directory of this machine is hidden too', async () => {
    const { wt } = setup();
    const sandbox = resolveSandbox(DEFAULT_SANDBOX_SETTINGS, {
      platform: 'linux',
      home: homedir(),
      dataDir: null,
      path: process.env.PATH ?? '',
    });
    const r = await run(
      sandbox,
      wt,
      `console.log(require('fs').readdirSync(${JSON.stringify(homedir())}).length)`,
    );
    expect(r.kind).toBe('exited');
    // wt lives under /tmp here, so home is an empty tmpfs.
    if (!wt.startsWith(homedir())) expect(r.output.trim()).toBe('0');
  });
});

// Real sandbox-exec: only on macOS, where /usr/bin/sandbox-exec exists and passes its probe.
// Hosted CI is Linux-only, so these run on contributors' Macs (`pnpm run test`).
const seatbeltWorks =
  process.platform === 'darwin' &&
  existsSync(SANDBOX_EXEC) &&
  probeBackend('sandbox-exec', SANDBOX_EXEC) === null;

describe.skipIf(!seatbeltWorks)('sandbox-exec backend (real; runs only on macOS)', () => {
  // The default layout: the worktree lives inside soot's state dir, inside home, both hidden.
  const setup = () => {
    const base = realpathSync(temp('soot-sbx-mac-'));
    const home = join(base, 'home');
    const dataDir = join(home, '.soot');
    const wt = join(dataDir, 'worktrees', 'r', 't');
    const outside = join(base, 'outside');
    for (const d of [join(wt, 'tests'), outside]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, '.secret'), 'top secret');
    writeFileSync(join(dataDir, 'soot.sqlite'), 'db');
    mkdirSync(join(dataDir, 'worktrees', 'r', 'other-task'));
    const sandbox = resolveSandbox(DEFAULT_SANDBOX_SETTINGS, {
      platform: 'darwin',
      home,
      dataDir,
      path: process.env.PATH ?? '',
    });
    expect(sandbox).toMatchObject({ backend: 'sandbox-exec', isolation: true, blocked: null });
    return { base, home, dataDir, wt, outside, sandbox };
  };

  it('runs node scripts and node --test from a worktree inside the hidden state dir', async () => {
    // Regression: Node's realpath lstat()s every parent of the script, including ~/.soot. With
    // only `(deny file-read* home)` + `(allow ... worktree)`, every check failed with EPERM.
    const { wt, sandbox } = setup();
    writeFileSync(join(wt, 'lib.js'), 'module.exports = 41;\n');
    writeFileSync(join(wt, 'main.js'), "console.log('answer', require('./lib.js') + 1);\n");
    writeFileSync(
      join(wt, 'tests', 'a.test.js'),
      "const t = require('node:test'); t.test('ok', () => {});\n",
    );
    const script = await runSandboxed([NODE, 'main.js'], {
      sandbox,
      cwd: wt,
      env,
      timeoutMs: 10_000,
    });
    expect(script).toMatchObject({ kind: 'exited', exitCode: 0, backend: 'sandbox-exec' });
    expect(script.output).toContain('answer 42');
    const tests = await runSandboxed([NODE, '--test', 'tests/a.test.js'], {
      sandbox,
      cwd: wt,
      env,
      timeoutMs: 20_000,
    });
    expect(tests.output).toMatch(/pass 1/);
    expect(tests).toMatchObject({ kind: 'exited', exitCode: 0 });
  });

  it('writes only inside the worktree and temp; home, the DB and other tasks stay closed', async () => {
    const { wt, outside, home, dataDir, sandbox } = setup();
    const code = `
      const fs = require('fs');
      const os = require('os');
      const out = {};
      const attempt = (k, f) => { try { f(); out[k] = 'ok'; } catch (e) { out[k] = e.code; } };
      attempt('secret', () => fs.readFileSync(${JSON.stringify(join(home, '.secret'))}, 'utf8'));
      attempt('listHome', () => fs.readdirSync(${JSON.stringify(home)}));
      attempt('listState', () => fs.readdirSync(${JSON.stringify(dataDir)}));
      attempt('listRun', () => fs.readdirSync(${JSON.stringify(join(dataDir, 'worktrees', 'r'))}));
      attempt('readDb', () => fs.readFileSync(${JSON.stringify(join(dataDir, 'soot.sqlite'))}));
      attempt('statState', () => fs.statSync(${JSON.stringify(dataDir)}));
      attempt('worktree', () => fs.writeFileSync('inside.txt', 'x'));
      attempt('tmp', () => fs.writeFileSync(require('path').join(os.tmpdir(), 't.txt'), 'x'));
      attempt('outside', () => fs.writeFileSync(${JSON.stringify(join(outside, 'escaped'))}, 'x'));
      attempt('db', () => fs.writeFileSync(${JSON.stringify(join(dataDir, 'soot.sqlite'))}, 'x'));
      attempt('dotfile', () => fs.writeFileSync(${JSON.stringify(join(home, '.secret'))}, 'x'));
      attempt('otherTask', () => fs.writeFileSync(${JSON.stringify(join(dataDir, 'worktrees', 'r', 'other-task', 'x'))}, 'x'));
      console.log(JSON.stringify(out));`;
    const r = await run(sandbox, wt, code);
    expect(r).toMatchObject({ kind: 'exited', exitCode: 0, backend: 'sandbox-exec' });
    const out = JSON.parse(r.output.trim()) as Record<string, string>;
    expect(out).toEqual({
      secret: 'EPERM',
      listHome: 'EPERM',
      listState: 'EPERM',
      listRun: 'EPERM',
      readDb: 'EPERM',
      statState: 'ok', // metadata only: the fix for the EPERM regression above
      worktree: 'ok',
      tmp: 'ok',
      outside: 'EPERM',
      db: 'EPERM',
      dotfile: 'EPERM',
      otherTask: 'EPERM',
    });
    expect(existsSync(join(outside, 'escaped'))).toBe(false);
    expect(readFileSync(join(dataDir, 'soot.sqlite'), 'utf8')).toBe('db');
    expect(readFileSync(join(home, '.secret'), 'utf8')).toBe('top secret');
    expect(readFileSync(join(wt, 'inside.txt'), 'utf8')).toBe('x');
  });

  it('blocks network by default, even to a server on 127.0.0.1', async () => {
    const { wt, sandbox } = setup();
    const server = createServer((s) => s.end('hi'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      const code = `
        const s = require('net').connect({ host: '127.0.0.1', port: ${String(port)}, timeout: 3000 });
        s.on('connect', () => { console.log('connected'); process.exit(0); });
        s.on('timeout', () => { console.log('timeout'); process.exit(0); });
        s.on('error', (e) => { console.log(e.code); process.exit(0); });`;
      const r = await run(sandbox, wt, code);
      expect(r.kind).toBe('exited');
      expect(r.output.trim()).not.toBe('connected');
      expect(r.output.trim()).toBe('EPERM');
    } finally {
      server.close();
    }
  });

  it('git internals stay read-only from inside a real worktree', async () => {
    const { wt, sandbox, base } = setup();
    const common = join(base, 'repo', '.git');
    const gitDir = join(common, 'worktrees', 't');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '../..\n');
    writeFileSync(join(common, 'config'), '[core]\n');
    writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`);
    const code = `
      const fs = require('fs');
      const out = {};
      try { out.read = fs.readFileSync(${JSON.stringify(join(common, 'config'))}, 'utf8'); } catch (e) { out.read = e.code; }
      try { fs.appendFileSync(${JSON.stringify(join(common, 'config'))}, 'x'); out.config = 'written'; } catch (e) { out.config = e.code; }
      try { fs.writeFileSync('.git', 'gitdir: /elsewhere'); out.dotgit = 'written'; } catch (e) { out.dotgit = e.code; }
      console.log(JSON.stringify(out));`;
    const r = await run(sandbox, wt, code);
    const out = JSON.parse(r.output.trim()) as Record<string, string>;
    expect(out).toEqual({ read: '[core]\n', config: 'EPERM', dotgit: 'EPERM' });
    expect(readFileSync(join(common, 'config'), 'utf8')).toBe('[core]\n');
  });
});
