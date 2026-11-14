#!/usr/bin/env node
// Savings benchmark (GitHub issue #3, build spec §17 Test 5). Runs a fixed task set on throwaway
// copies of examples/bench-app two ways and records real tokens, cost, wall time and pass/fail:
//
//   routed    soot's own routing over the auto models from the keys that are set (ADR-043)
//   baseline  every task on the single most expensive of those models (highest list output price)
//
// It CALLS REAL MODELS AND SPENDS MONEY with your keys, so it never runs in CI and refuses to
// start without --live. Key values are never read here: soot checks presence itself.
//
//   pnpm run build
//   node scripts/benchmark.mjs --live [--reps 1] [--max-usd 1] [--out bench-results.json]
//
// Each run gets a fresh repo copy and a fresh soot data dir, so no routing history carries over.
// Pass/fail is decided here, after the run, by the bench app's own acceptance tests on the
// working tree soot landed (`--apply`); soot's verdict is recorded next to it.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'examples/bench-app');
const sootBin = join(root, 'apps/cli/dist/bin.js');

/** The fixed task set: each prompt is decomposed by a recorded fixture, so both arms run the same tasks. */
export const PROMPTS = [
  'Change the page title and heading to HELLO WORLD and update the primary button to purple.',
  'Rename the --brand CSS variable to --accent in the theme.',
  'Fix the paging bug in paginate().',
  'Add a slugify helper.',
  'Add a strict parseDuration helper.',
  'Add a per-key token-bucket rate limiter.',
];

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    reps: { type: 'string', default: '1' },
    'max-usd': { type: 'string', default: '1' },
    out: { type: 'string', default: 'bench-results.json' },
    arms: { type: 'string', default: 'routed,baseline' },
    keep: { type: 'boolean', default: false },
    // Comma-separated 1-based prompt numbers, for smoke runs; the benchmark itself uses all.
    only: { type: 'string' },
  },
});

if (!values.live) {
  console.error('benchmark: calls real models and spends money; pass --live to run it.');
  process.exit(1);
}
if (process.env.CI !== undefined) {
  console.error('benchmark: refusing to run in CI.');
  process.exit(1);
}

const reps = Number(values.reps);
const prompts =
  values.only === undefined ? PROMPTS : values.only.split(',').map((n) => PROMPTS[Number(n) - 1]);
const maxUsd = Number(values['max-usd']);
const arms = values.arms.split(',');
const acceptance = JSON.parse(readFileSync(join(appDir, 'soot.config.json'), 'utf8')).acceptance;
const fixtures = JSON.parse(readFileSync(join(appDir, 'fixtures.json'), 'utf8'));
const { KNOWN_PROVIDERS } = await import(join(root, 'packages/model-registry/dist/index.js'));
const { SPEC_FIXTURES } = await import(join(root, 'packages/planner/dist/index.js'));

const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const taskIdsFor = (prompt) =>
  [...fixtures, ...SPEC_FIXTURES]
    .find((f) => norm(f.prompt) === norm(prompt))
    .tasks.map((t) => t.id);

const sh = (cmd, args, cwd, extra = {}) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });

const git = (cwd, ...args) => {
  const r = sh(
    'git',
    ['-c', 'user.name=bench', '-c', 'user.email=bench@soot.local', ...args],
    cwd,
    {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

/** A fresh repo copy with its own data dir. */
function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'soot-bench-'));
  const repo = join(dir, 'repo');
  cpSync(appDir, repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'bench app');
  return { dir, repo, data: join(dir, 'data') };
}

/** The auto pool soot builds from the keys that are set, read back through `soot models`. */
function autoPool() {
  const { dir, repo, data } = freshRepo();
  const r = sh('node', [sootBin, 'models', '--json', '--data-dir', data], repo);
  rmSync(dir, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`soot models failed: ${r.stderr}`);
  return JSON.parse(r.stdout).models.filter((m) => m.origin === 'auto' && m.eligible);
}

/** Baseline: the one model with the highest list output price (input price breaks ties). */
function baselineModel(pool) {
  return [...pool].sort(
    (a, b) =>
      b.pricing.outputPerMTokUsd - a.pricing.outputPerMTokUsd ||
      b.pricing.inputPerMTokUsd - a.pricing.inputPerMTokUsd,
  )[0];
}

/** Turn a repo copy into the baseline arm: a models file with only `model`, auto pool off. */
function makeBaseline(repo, model) {
  const known = KNOWN_PROVIDERS.find((k) => k.provider.id === model.provider);
  const modelId = model.ref.slice(model.provider.length + 1);
  const models = {
    version: 1,
    providers: [known.provider],
    models: [
      {
        provider: model.provider,
        modelId,
        capabilities: { tools: true, structuredOutput: true },
        pricing: model.pricing,
        // Qualifies for every complexity while its reliability is unmeasured, like an auto model.
        tier: 'high',
      },
    ],
  };
  writeFileSync(join(repo, 'models.baseline.json'), `${JSON.stringify(models, null, 2)}\n`);
  const cfgPath = join(repo, 'soot.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(
    cfgPath,
    `${JSON.stringify({ ...cfg, models: 'models.baseline.json', autoModels: false }, null, 2)}\n`,
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'baseline arm');
}

function runOnce(arm, prompt, baseline) {
  const { dir, repo, data } = freshRepo();
  if (arm === 'baseline') makeBaseline(repo, baseline);
  const t0 = performance.now();
  const r = sh(
    'node',
    [sootBin, 'run', prompt, '--agent', 'api', '--apply', '--json', '--data-dir', data],
    repo,
    {
      env: { ...process.env, SOOT_LOG_LEVEL: 'silent' },
    },
  );
  const wallMs = Math.round(performance.now() - t0);
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // recorded as a failed run below
  }
  const taskIds = taskIdsFor(prompt);
  const checks = taskIds.flatMap((id) => acceptance[id] ?? []);
  const accept = checks.map((c) => {
    const res = sh(c.argv[0], c.argv.slice(1), repo);
    return { name: c.name, passed: res.status === 0 };
  });
  const project = sh('node', ['--test', 'tests/**/*.test.js'], repo).status === 0;
  const totals = out?.report?.cost?.totals?.actual ?? null;
  const verdicts = new Map((out?.report?.tasks ?? []).map((t) => [t.taskId, t]));
  const tasks = (out?.report?.cost?.tasks ?? []).map((t) => ({
    taskId: t.taskId,
    verdict: verdicts.get(t.taskId)?.verdict ?? null,
    reason: verdicts.get(t.taskId)?.reason ?? null,
    modelPath: t.modelPath,
    attempts: t.attempts.length,
    inputTokens: t.actual.inputTokens,
    outputTokens: t.actual.outputTokens,
    usd: t.actual.usd,
  }));
  const result = {
    arm,
    prompt,
    exitCode: r.status,
    sootStatus: out?.report?.status ?? 'no-json',
    passed: accept.length > 0 && accept.every((a) => a.passed) && project,
    acceptance: accept,
    projectTests: project,
    wallMs,
    attempts: totals?.attempts ?? null,
    inputTokens: totals?.inputTokens ?? null,
    outputTokens: totals?.outputTokens ?? null,
    usd: totals?.usd ?? null,
    unpricedAttempts: totals?.unpricedAttempts ?? null,
    unreportedAttempts: totals?.unreportedAttempts ?? null,
    tasks,
    decisions: out?.decisions ?? [],
    error: out === null ? (r.stderr || '').slice(-400) : null,
  };
  if (!values.keep) rmSync(dir, { recursive: true, force: true });
  else result.dir = dir;
  return result;
}

const pool = autoPool();
if (pool.length === 0) {
  console.error('benchmark: no auto models (no known vendor key is set).');
  process.exit(1);
}
const baseline = baselineModel(pool);
console.error(`pool: ${pool.map((m) => m.ref).join(', ')}; baseline: ${baseline.ref}`);

const results = [];
let spent = 0;
outer: for (let rep = 1; rep <= reps; rep++) {
  for (const prompt of prompts) {
    // Alternate which arm goes first so neither always runs on a warmer API.
    const order = (rep + PROMPTS.indexOf(prompt)) % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of order) {
      if (spent >= maxUsd) {
        console.error(
          `benchmark: stopping, spend $${spent.toFixed(4)} reached --max-usd ${maxUsd}`,
        );
        break outer;
      }
      const res = { rep, ...runOnce(arm, prompt, baseline) };
      spent += res.usd ?? 0;
      results.push(res);
      console.error(
        `rep ${rep} ${arm.padEnd(8)} ${res.passed ? 'PASS' : 'FAIL'} $${(res.usd ?? NaN).toFixed(5)} ` +
          `${res.wallMs}ms attempts=${res.attempts} ${prompt}`,
      );
    }
  }
}

const summary = Object.fromEntries(
  arms.map((arm) => {
    const rs = results.filter((r) => r.arm === arm);
    const sum = (k) => rs.reduce((s, r) => s + (r[k] ?? 0), 0);
    return [
      arm,
      {
        runs: rs.length,
        passed: rs.filter((r) => r.passed).length,
        usd: sum('usd'),
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        attempts: sum('attempts'),
        wallMs: sum('wallMs'),
        unknownCostRuns: rs.filter(
          (r) => r.usd === null || r.unpricedAttempts || r.unreportedAttempts,
        ).length,
      },
    ];
  }),
);

const report = {
  date: new Date().toISOString(),
  node: process.version,
  pool: pool.map((m) => ({ ref: m.ref, tier: m.tier, pricing: m.pricing })),
  baseline: baseline.ref,
  prompts,
  reps,
  spentUsd: spent,
  summary,
  results,
};
writeFileSync(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);
console.error(JSON.stringify(summary, null, 2));
console.error(`wrote ${values.out}; total spend $${spent.toFixed(4)}`);
