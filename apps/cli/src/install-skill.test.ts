import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SKILL_SOURCE, SKILL_NAME, installSkill } from './index.js';

let dir = '';
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const walk = (d: string, prefix = ''): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );

describe('the universal skill', () => {
  const skill = readFileSync(join(DEFAULT_SKILL_SOURCE, 'SKILL.md'), 'utf8');

  it('follows the Agent Skills format: name matches its folder, short description', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    const name = /^name: (.+)$/m.exec(front)?.[1];
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(name).toBe(SKILL_NAME);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(front.split('\n').map((l) => l.split(':')[0])).toEqual(['name', 'description']);
  });

  it('tells the host to delegate to soot, verbatim, and never to approve for the user', () => {
    expect(skill).toMatch(/hand the prompt to soot/);
    expect(skill).toMatch(/verbatim/);
    expect(skill).toMatch(/Never approve on the user's behalf/);
    expect(skill).toMatch(/soot_run/);
    expect(skill).toMatch(/Decomposition uses \*\*recorded fixtures\*\*/);
    expect(skill).toMatch(/verified\s+with mock models only/);
  });
});

describe('installSkill (temp directories only)', () => {
  it('copies the skill into .agents, .claude and .grok skill paths and nowhere else', () => {
    dir = mkdtempSync(join(tmpdir(), 'soot-skill-'));
    const results = installSkill({ target: dir });
    expect(results.map((r) => [r.harness, r.action])).toEqual([
      ['agents', 'installed'],
      ['claude', 'installed'],
      ['grok', 'installed'],
    ]);
    expect(walk(dir).sort()).toEqual([
      '.agents/skills/universal-orchestrator/SKILL.md',
      '.claude/skills/universal-orchestrator/SKILL.md',
      '.grok/skills/universal-orchestrator/SKILL.md',
    ]);
    expect(readFileSync(join(dir, '.claude/skills/universal-orchestrator/SKILL.md'))).toEqual(
      readFileSync(join(DEFAULT_SKILL_SOURCE, 'SKILL.md')),
    );
  });

  it('is idempotent, keeps a locally changed copy unless forced, and installs selected harnesses', () => {
    dir = mkdtempSync(join(tmpdir(), 'soot-skill-'));
    installSkill({ target: dir, harnesses: ['claude'] });
    expect(existsSync(join(dir, '.agents'))).toBe(false);
    expect(installSkill({ target: dir, harnesses: ['claude'] })[0]?.action).toBe('unchanged');
    const installed = join(dir, '.claude/skills/universal-orchestrator');
    writeFileSync(join(installed, 'SKILL.md'), 'edited by the user\n');
    writeFileSync(join(installed, 'extra.md'), 'stale\n');
    expect(installSkill({ target: dir, harnesses: ['claude'] })[0]?.action).toBe(
      'skipped-different',
    );
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe('edited by the user\n');
    expect(installSkill({ target: dir, harnesses: ['claude'], force: true })[0]?.action).toBe(
      'updated',
    );
    expect(walk(installed)).toEqual(['SKILL.md']);
  });

  it('refuses a target that is not a directory, and a missing skill source', () => {
    dir = mkdtempSync(join(tmpdir(), 'soot-skill-'));
    writeFileSync(join(dir, 'file'), '');
    expect(() => installSkill({ target: join(dir, 'file') })).toThrow(/not a directory/);
    expect(() => installSkill({ target: join(dir, 'missing') })).toThrow(/not a directory/);
    expect(() => installSkill({ target: dir, source: join(dir, 'nope') })).toThrow(
      /skill source not found/,
    );
  });
});
