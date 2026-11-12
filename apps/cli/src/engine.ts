import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  MockAgentRunner,
  type AgentRunner,
  type ApprovalGate,
  type Scheduler,
} from '@soot/agent-runtime';
import {
  AcpAgentRunner,
  describeCommand,
  spawnAcpAgent,
  type AcpRouteRecord,
} from '@soot/harness-adapters';
import { SILENT_LOGGER, parseEnv, type LogLevel, type Logger } from '@soot/core';
import { openExecutionStore, type ExecutionStore, type ModelOutcome } from '@soot/context-manager';
import { AdaptiveSupervisor, type AdaptiveEvent } from '@soot/escalation';
import type {
  CommandOutput,
  JsonValue,
  OrchestrationService,
  RunRequest,
} from '@soot/harness-adapters';
import {
  auditLogPath,
  renderConsolidatedReport,
  runCodebaseWorkflow,
  type ConsolidatedReport,
} from '@soot/integrations';
import {
  ModelRegistry,
  ProviderHealth,
  loadRegistryConfigFile,
  type ModelEntry,
} from '@soot/model-registry';
import { historyFromAttempts, resolvePolicy } from '@soot/model-router';
import {
  AuditLog,
  buildCostReport,
  costRecordsFromAttempts,
  renderCostReport,
  summarizeCosts,
} from '@soot/observability';
import {
  FixtureDecomposer,
  NoFixtureError,
  SPEC_FIXTURES,
  createPromptIntake,
  type DecompositionFixture,
} from '@soot/planner';
import { CONFIG_FILE, insideRepo, loadProjectConfig, type LoadedConfig } from './config.js';
import { holdRun, requestStop, requestTaskStop, runningInfo } from './control.js';
import { loadMockScript } from './mock-script.js';

/*
 * The soot engine behind the CLI and the MCP server: one prompt → recorded-fixture
 * decomposition → per-task routing with stored outcome history → supervised execution in
 * isolated worktrees with soot-run checks → serial integration → consolidated report.
 *
 * Honest limits (Milestone 6): decomposition is fixture-only. Agents: the scripted mock, or a
 * user-configured ACP agent through the generic ACP driver (ADR-027; verified only with soot's
 * own mock ACP agent). No model runner exists (M2-07 Blocked), so `run` refuses unless the
 * caller explicitly picks `--agent mock` or `--agent acp`.
 */

export type AgentMode =
  | { readonly kind: 'none' }
  | { readonly kind: 'mock'; readonly script: string }
  /** Spawn the `acpAgent` command from the project config (generic ACP driver, ADR-027). */
  | { readonly kind: 'acp' };

export interface EngineOptions {
  /** Working directory for relative paths (repo, config, mock script). */
  readonly cwd: string;
  /** soot state directory (`SOOT_DATA_DIR`). */
  readonly dataDir: string;
  /** Explicit config path; default `<repo>/soot.config.json`. */
  readonly configPath?: string;
  readonly agent: AgentMode;
  readonly approvals: ApprovalGate;
  /** Environment for git (identity and config come from the user's environment). */
  readonly gitEnv?: NodeJS.ProcessEnv;
  /** Environment an ACP agent's scrubbed env is taken from (default `process.env`). */
  readonly agentEnv?: NodeJS.ProcessEnv;
  /** Leveled log lines (stderr in the CLI, filtered by `SOOT_LOG_LEVEL`). Default: silent. */
  readonly log?: Logger;
}

/** Where the state directory came from, for `debug` lines. */
export type DataDirSource = '--data-dir' | 'SOOT_DATA_DIR' | 'default (~/.soot)';

export interface EngineRuntime {
  readonly dataDir: string;
  readonly dataDirSource: DataDirSource;
  readonly logLevel: LogLevel;
}

/**
 * The engine's runtime settings from `SOOT_*` variables (`parseEnv`), as used by the CLI and
 * `soot mcp`. `--data-dir` wins over `SOOT_DATA_DIR`. No `.env` file is read.
 */
export function runtimeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  dataDirFlag?: string,
): EngineRuntime {
  const parsed = parseEnv(env, { cwd });
  if (dataDirFlag !== undefined) {
    return {
      dataDir: resolve(cwd, dataDirFlag),
      dataDirSource: '--data-dir',
      logLevel: parsed.logLevel,
    };
  }
  const fromEnv = (env.SOOT_DATA_DIR?.trim() ?? '') !== '';
  return {
    dataDir: parsed.dataDir,
    dataDirSource: fromEnv ? 'SOOT_DATA_DIR' : 'default (~/.soot)',
    logLevel: parsed.logLevel,
  };
}

const fail = (text: string, data: Record<string, JsonValue> = {}): CommandOutput => ({
  ok: false,
  text,
  data: { error: text, ...data },
});

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `run-${stamp}-${randomBytes(2).toString('hex')}`;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function eventLine(e: AdaptiveEvent): string {
  return `- ${e.taskId} #${String(e.attempt)} ${e.type}${e.model === null ? '' : ` ${e.model}`}: ${e.reason}`;
}

function loadFixtures(path: string | null): DecompositionFixture[] {
  if (path === null) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array of fixtures`);
  return raw as DecompositionFixture[];
}

export class SootEngine implements OrchestrationService {
  readonly #o: EngineOptions;

  constructor(options: EngineOptions) {
    this.#o = options;
  }

  #configFor(repoRoot: string): LoadedConfig {
    return loadProjectConfig(
      this.#o.configPath === undefined
        ? join(repoRoot, CONFIG_FILE)
        : resolve(this.#o.cwd, this.#o.configPath),
    );
  }

  #store(): ExecutionStore {
    return openExecutionStore({ dataDir: this.#o.dataDir });
  }

  #eventsPath(runId: string): string {
    return join(this.#o.dataDir, 'reports', `${runId}.events.jsonl`);
  }

  #events(runId: string): JsonValue[] {
    const path = this.#eventsPath(runId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as JsonValue);
  }

  #reportPath(runId: string): string {
    return join(this.#o.dataDir, 'reports', `${runId}.json`);
  }

  #runner(cfg: LoadedConfig, onRoute: (r: AcpRouteRecord) => void): AgentRunner | string {
    const { agent } = this.#o;
    if (agent.kind === 'none') {
      return (
        'no agent runner selected: real model execution needs provider keys (M2-07, blocked). Use ' +
        '--agent mock --mock-script <file> for a fixture run, or --agent acp with an "acpAgent" ' +
        `command in ${CONFIG_FILE}.`
      );
    }
    if (agent.kind === 'acp') {
      const spec = cfg.config.acpAgent;
      if (spec === undefined) {
        return `--agent acp needs an "acpAgent" command in ${cfg.path}; soot never picks or searches for one.`;
      }
      return new AcpAgentRunner({
        connect: spawnAcpAgent(spec, this.#o.agentEnv ?? process.env),
        approvals: this.#o.approvals.mode,
        onRoute,
      });
    }
    return new MockAgentRunner(loadMockScript(resolve(this.#o.cwd, agent.script)));
  }

  #agentLabel(cfg: LoadedConfig): string {
    const { agent } = this.#o;
    if (agent.kind === 'acp' && cfg.config.acpAgent !== undefined) {
      return `acp (${describeCommand(cfg.config.acpAgent)}; generic ACP driver; routed models are applied only when the agent offers a "model" option, see ACP model routing)`;
    }
    if (agent.kind === 'mock') return 'mock-test-double (test double, no model is called)';
    return agent.kind;
  }

  /** The config file, models file and fixtures file are protected when they live in the repo. */
  #protectedPaths(repoRoot: string, cfg: LoadedConfig): string[] {
    const extra = [cfg.path, cfg.modelsPath, cfg.fixturesPath]
      .filter((p): p is string => p !== null)
      .map((p) => insideRepo(repoRoot, p))
      .filter((p): p is string => p !== null);
    if (this.#o.agent.kind === 'mock') {
      const script = insideRepo(repoRoot, resolve(this.#o.cwd, this.#o.agent.script));
      if (script !== null) extra.push(script);
    }
    return [...new Set([...cfg.config.protectedPaths, ...extra])];
  }

  async run(request: RunRequest, signal?: AbortSignal): Promise<CommandOutput> {
    const log = this.#o.log ?? SILENT_LOGGER;
    const progress = log.info;
    const repoRoot = resolve(this.#o.cwd, request.repo ?? '.');
    const runId = request.runId ?? newRunId();
    if (!RUN_ID.test(runId)) return fail(`invalid run id: ${runId}`);
    let cfg: LoadedConfig;
    let registry: ModelRegistry;
    let fixtures: DecompositionFixture[];
    try {
      cfg = this.#configFor(repoRoot);
      registry = new ModelRegistry(loadRegistryConfigFile(cfg.modelsPath));
      fixtures = loadFixtures(cfg.fixturesPath);
    } catch (error) {
      return fail((error as Error).message);
    }
    // ACP (ADR-028): whether each attempt's routed model was applied by the agent.
    const acpRoutes: AcpRouteRecord[] = [];
    let audit: AuditLog | null = null;
    const runner = this.#runner(cfg, (r) => {
      acpRoutes.push(r);
      audit?.record('model-route', r.taskId, {
        attempt: r.attempt,
        routed: r.routed,
        applied: r.applied,
        agentValue: r.agentValue,
        reason: r.reason,
      });
      (r.applied ? log.info : log.warn)(
        `soot: ${r.taskId} #${String(r.attempt)} ACP model ${r.applied ? 'applied' : 'NOT applied'}: ${r.reason}`,
      );
    });
    if (typeof runner === 'string') return fail(runner);
    const agentLabel = this.#agentLabel(cfg);
    const isAcp = this.#o.agent.kind === 'acp';

    const intake = createPromptIntake({ prompt: request.prompt });
    let decomposition;
    try {
      decomposition = await new FixtureDecomposer([...SPEC_FIXTURES, ...fixtures]).decompose(
        intake,
      );
    } catch (error) {
      if (error instanceof NoFixtureError) {
        return fail(
          `${error.message} Recorded prompts: soot ships the build spec examples; add your own with "fixtures" in ${CONFIG_FILE}.`,
          { promptSha256: error.promptSha256 },
        );
      }
      return fail((error as Error).message);
    }
    const { graph } = decomposition;
    progress(
      `soot: run ${runId}: ${String(graph.tasks.length)} tasks from recorded fixture "${decomposition.decomposer.fixtureId}"; agent: ${agentLabel}`,
    );

    const store = this.#store();
    let control;
    // Task cancellation requests (`soot stop <run> --task <id>`) arriving before or during the run.
    let scheduler: Scheduler | null = null;
    const pendingTaskStops: string[] = [];
    const cancelTask = (taskId: string) => {
      if (scheduler === null) {
        pendingTaskStops.push(taskId);
        return;
      }
      try {
        scheduler.cancel(taskId);
        progress(`soot: ${taskId} cancelled by request`);
      } catch (error) {
        log.warn(`soot: cannot cancel ${taskId}: ${(error as Error).message}`);
      }
    };
    mkdirSync(join(this.#o.dataDir, 'reports'), { recursive: true, mode: 0o700 });
    const eventsPath = this.#eventsPath(runId);
    writeFileSync(eventsPath, '', { mode: 0o600 });
    try {
      control = holdRun(this.#o.dataDir, runId, signal, 200, cancelTask);
    } catch (error) {
      store.close();
      return fail((error as Error).message);
    }
    try {
      store.createRun({ runId, intake, graph });
      audit = new AuditLog({ runId, file: auditLogPath(this.#o.dataDir, runId) });
      const runAudit = audit;
      // Provider cooldowns recorded by earlier runs still apply (ADR-030).
      const health = new ProviderHealth({ store });
      for (const c of store.providerCooldowns(Date.now())) {
        progress(
          `soot: provider ${c.provider} unavailable until ${new Date(c.until).toISOString()} (${c.reason}, recorded earlier); routing skips it until then`,
        );
      }
      log.debug(
        `soot: debug: config ${cfg.path}; models ${cfg.modelsPath}; attempt timeout ${String(cfg.config.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS)} ms${cfg.config.attemptTimeoutMs === undefined ? ' (default)' : ''}; audit ${runAudit.file ?? ''}`,
      );
      // Routing feedback (M5-07): soot-verified outcomes from earlier runs shape this run's routing.
      const outcomes = store.modelOutcomes();
      const history = historyFromAttempts(
        outcomes.map((o) => ({
          model: o.model,
          tier: o.tier,
          status: o.outcome === 'verified' ? ('succeeded' as const) : ('failed' as const),
        })),
      );
      const supervisor = new AdaptiveSupervisor({
        registry,
        policy: cfg.config.policy,
        history,
        runId,
        health,
        // Run-budget spend is kept per attempt in soot.sqlite and reloaded on restart (ADR-030).
        spend: store.spendLedger(runId),
        ...(cfg.config.escalation === undefined ? {} : { config: cfg.config.escalation }),
        onEvent: (e) => {
          progress(`soot: ${eventLine(e).slice(2)}`);
          runAudit.record('routing-decision', e.taskId, {
            attempt: e.attempt,
            decision: e.type,
            model: e.model,
            reason: e.reason,
            triggers: json(e.triggers),
          });
          // Live event log for `soot status <run>` (and IDE views) while the run is going.
          appendFileSync(eventsPath, `${JSON.stringify(e)}\n`);
        },
      });
      const result = await runCodebaseWorkflow({
        repoRoot,
        dataDir: this.#o.dataDir,
        runId,
        graph,
        runner,
        checks: cfg.checks,
        acceptance: cfg.acceptance,
        protectedPaths: this.#protectedPaths(repoRoot, cfg),
        policy: cfg.policy,
        approvals: this.#o.approvals,
        supervisor,
        concurrency: cfg.config.concurrency,
        ...(cfg.config.attemptTimeoutMs === undefined
          ? {}
          : { attemptTimeoutMs: cfg.config.attemptTimeoutMs }),
        journal: store.journal(runId),
        audit: runAudit,
        signal: control.signal,
        onScheduler: (s) => {
          scheduler = s;
          for (const id of pendingTaskStops.splice(0)) cancelTask(id);
        },
        // Routing history is credited to a model only when that model did the work: always for
        // the mock (routed model is its label), for ACP only where the agent applied the route.
        outcomes: isAcp
          ? {
              recordModelOutcome: (o: ModelOutcome) => {
                const applied = acpRoutes.some(
                  (r) =>
                    r.applied &&
                    r.taskId === o.taskId &&
                    r.attempt === o.attempt &&
                    r.routed === o.model,
                );
                if (applied) store.recordModelOutcome(o);
              },
            }
          : store,
        prompt: request.prompt,
        ...(this.#o.gitEnv === undefined ? {} : { gitEnv: this.#o.gitEnv }),
      });
      const { report } = result;
      const decisions = supervisor.events.map(eventLine);
      // Cost records with the router's estimate per attempt, written automatically (ADR-030).
      const costRecords = this.#costRecords(store, runId);
      const saved = {
        runId,
        fixtureId: decomposition.decomposer.fixtureId,
        agent: runner.kind,
        agentLabel,
        policy: cfg.config.policy,
        historySamples: outcomes.length,
        maxObservedConcurrency: result.run.maxObservedConcurrency,
        decisions,
        ...(isAcp ? { acpRoutes } : {}),
        stopRequested: control.stopRequested(),
        report,
        costRecords,
        costSummary: summarizeCosts(costRecords),
      };
      writeFileSync(this.#reportPath(runId), `${JSON.stringify(saved, null, 2)}\n`, {
        mode: 0o600,
      });
      const text = [
        `soot run ${runId} (${report.status.toUpperCase()})`,
        `Plan: recorded fixture "${decomposition.decomposer.fixtureId}" (no model-backed decomposition); agent: ${agentLabel}; policy: ${cfg.config.policy}; routing history: ${String(outcomes.length)} stored outcomes; peak concurrency ${String(result.run.maxObservedConcurrency)}`,
        'Decisions:',
        ...decisions,
        ...(isAcp
          ? [
              'ACP model routing:',
              ...acpRoutes.map(
                (r) =>
                  `- ${r.taskId} #${String(r.attempt)}: ${r.applied ? 'applied' : 'NOT applied'}: ${r.reason}`,
              ),
            ]
          : []),
        '',
        renderConsolidatedReport(report),
        '',
        `Report: ${this.#reportPath(runId)}`,
        `Audit log: ${result.audit.file ?? '(memory only)'}`,
      ].join('\n');
      return {
        ok: true,
        text,
        data: json({
          ...saved,
          reportPath: this.#reportPath(runId),
          auditLog: result.audit.file,
        }) as Record<string, JsonValue>,
      };
    } catch (error) {
      return fail(`run ${runId} failed: ${(error as Error).message}`, { runId });
    } finally {
      control.release();
      store.close();
    }
  }

  /** Cost records rebuilt from the run's persisted attempts (routed estimates + reported actuals). */
  #costRecords(store: ExecutionStore, runId: string) {
    const run = store.loadRun(runId);
    return costRecordsFromAttempts(
      run.tasks,
      run.attempts.map((a) => ({
        taskId: a.taskId,
        attempt: a.attempt,
        assignment: a.assignment,
        result: a.result,
      })),
    );
  }

  #savedReport(runId: string): {
    report: ConsolidatedReport;
    decisions: string[];
    agent?: string;
    agentLabel?: string;
  } | null {
    const path = this.#reportPath(runId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as {
      report: ConsolidatedReport;
      decisions: string[];
      agent?: string;
      agentLabel?: string;
    };
  }

  status(runId?: string): Promise<CommandOutput> {
    const store = this.#store();
    try {
      const ids = store.listRunIds();
      if (runId === undefined) {
        if (ids.length === 0)
          return Promise.resolve({ ok: true, text: 'No runs yet.', data: { runs: [] } });
        const runs = ids.map((id) => {
          const run = store.loadRun(id);
          const saved = this.#savedReport(id);
          const state =
            runningInfo(this.#o.dataDir, id) !== null
              ? 'running'
              : (saved?.report.status ?? 'interrupted');
          return {
            runId: id,
            createdAt: run.createdAt,
            state,
            tasks: run.tasks.length,
            prompt: run.originalPrompt,
          };
        });
        const text = [
          'Runs (oldest first):',
          ...runs.map(
            (r) =>
              `- ${r.runId} ${r.state} ${String(r.tasks)} tasks ${r.createdAt}: ${r.prompt.length > 70 ? `${r.prompt.slice(0, 67)}...` : r.prompt}`,
          ),
        ].join('\n');
        return Promise.resolve({ ok: true, text, data: { runs } });
      }
      if (!ids.includes(runId)) return Promise.resolve(fail(`unknown run ${runId}`));
      const run = store.loadRun(runId);
      const saved = this.#savedReport(runId);
      const running = runningInfo(this.#o.dataDir, runId) !== null;
      const tasks = run.tasks.map((t) => {
        const attempts = run.attempts.filter((a) => a.taskId === t.id && a.attempt > 0);
        const last = run.attempts.filter((a) => a.taskId === t.id).at(-1);
        const verdict = saved?.report.tasks.find((r) => r.taskId === t.id);
        return {
          taskId: t.id,
          // The planner's text for this part of the prompt (validated task, not agent output).
          title: t.title,
          instructions: t.instructions,
          complexity: t.complexity,
          dependsOn: [...t.dependsOn],
          state: last?.state ?? 'pending',
          attempts: attempts.length,
          models: attempts.map((a) => a.assignment?.model ?? null),
          verdict: verdict?.verdict ?? null,
          complete: verdict?.complete ?? false,
          reason: verdict?.reason ?? null,
          // soot-run checks on the task's diff (saved report); empty until the run has a report.
          checks: (verdict?.checks ?? []).map((c) => ({ ...c })),
          attemptDetails: attempts.map((a) => ({
            attempt: a.attempt,
            state: a.state,
            model: a.assignment?.model ?? null,
            escalationLevel: a.assignment?.escalationLevel ?? null,
            estimatedCostUsd: a.assignment?.estimatedCostUsd ?? null,
            actualCostUsd: a.result?.usage.costUsd ?? null,
            failure: a.failure?.kind ?? null,
            error: a.error,
            startedAt: a.startedAt,
            finishedAt: a.finishedAt,
          })),
        };
      });
      const state = running ? 'running' : (saved?.report.status ?? 'interrupted');
      const text = [
        `Run ${runId}: ${state}`,
        `Prompt: ${run.originalPrompt}`,
        ...tasks.map(
          (t) =>
            `- ${t.taskId} [${t.complexity}] ${t.state}, ${String(t.attempts)} attempt(s)${t.models.length > 0 ? ` (${t.models.map((m) => m ?? 'no model').join(' → ')})` : ''}${t.verdict === null ? '' : `, verdict ${t.verdict}${t.complete ? ' (complete)' : ''}`}`,
        ),
        ...(saved === null
          ? []
          : ['', ...(saved.decisions.length > 0 ? ['Decisions:', ...saved.decisions] : [])]),
      ].join('\n');
      return Promise.resolve({
        ok: true,
        text,
        data: json({
          runId,
          state,
          running,
          prompt: run.originalPrompt,
          createdAt: run.createdAt,
          tasks,
          events: this.#events(runId),
          reportStatus: saved?.report.status ?? null,
          // The runner that ran every task (saved report); null until the run has a report.
          agent: saved?.agent ?? null,
          agentLabel: saved?.agentLabel ?? null,
          // Run-level final validation from the saved report (output tails left out); null
          // until the run has a report or when no final validation ran.
          finalValidation:
            saved?.report.finalValidation?.map((c) => ({
              name: c.name,
              kind: c.kind,
              status: c.status,
              required: c.required,
              exitCode: c.exitCode,
              durationMs: c.durationMs,
            })) ?? null,
          problems: saved === null ? [] : [...saved.report.problems],
        }) as Record<string, JsonValue>,
      });
    } finally {
      store.close();
    }
  }

  cost(runId?: string): Promise<CommandOutput> {
    const store = this.#store();
    try {
      const ids = store.listRunIds();
      const id = runId ?? ids.at(-1);
      if (id === undefined) return Promise.resolve(fail('no runs yet'));
      if (!ids.includes(id)) return Promise.resolve(fail(`unknown run ${id}`));
      // Rebuilt from persisted attempts, so it also works while a run is in progress.
      const run = store.loadRun(id);
      const report = buildCostReport(
        run.tasks.map((t) => ({
          taskId: t.id,
          plannedInputTokens: t.estimate.inputTokens,
          plannedOutputTokens: t.estimate.outputTokens,
          attempts: run.attempts
            .filter((a) => a.taskId === t.id && a.attempt > 0)
            .map((a) => ({
              attempt: a.attempt,
              model: a.assignment?.model ?? null,
              estimatedUsd: a.assignment?.estimatedCostUsd ?? null,
              result: a.result === null ? null : { status: a.result.status, usage: a.result.usage },
            })),
        })),
      );
      const costRecords = this.#costRecords(store, id);
      const summary = summarizeCosts(costRecords);
      const routed = summary.routed;
      return Promise.resolve({
        ok: true,
        text: `Run ${id}\n${renderCostReport(report)}\nRouted estimates: ${String(routed.attempts)} attempts, ${routed.costUsd === null ? `unknown (${String(routed.unpricedAttempts)} unpriced)` : `$${routed.costUsd.toFixed(6)}`}${routed.routeNotApplied > 0 ? `; route not applied on ${String(routed.routeNotApplied)}` : ''}\n(Actuals are what runners reported; mock runs report fictional amounts.)`,
        data: json({ runId: id, cost: report, costRecords, costSummary: summary }) as Record<
          string,
          JsonValue
        >,
      });
    } finally {
      store.close();
    }
  }

  models(): Promise<CommandOutput> {
    let cfg: LoadedConfig;
    let registry: ModelRegistry;
    try {
      cfg = this.#configFor(this.#o.cwd);
      registry = new ModelRegistry(loadRegistryConfigFile(cfg.modelsPath));
    } catch (error) {
      return Promise.resolve(fail((error as Error).message));
    }
    const selection = registry.select({});
    const excluded = new Map(selection.excluded.map((e) => [e.ref, e.reasons]));
    const policy = resolvePolicy(cfg.config.policy);
    const rows = registry.models().map((m: ModelEntry) => {
      const restriction = registry.restriction(m.provider);
      return {
        ref: m.ref,
        provider: m.provider,
        kind: registry.provider(m.provider)?.kind ?? null,
        eligible: !excluded.has(m.ref),
        excludedBecause: [...(excluded.get(m.ref) ?? [])],
        restriction: restriction === null ? null : json(restriction),
        pricing:
          m.pricing === null
            ? null
            : {
                inputPerMTokUsd: m.pricing.inputPerMTokUsd,
                outputPerMTokUsd: m.pricing.outputPerMTokUsd,
                source: m.pricing.source,
                asOf: m.pricing.asOf,
              },
        contextWindow: m.contextWindow,
        reliabilityPrior: json(m.reliability),
      };
    });
    const usd = (v: number | null | undefined) =>
      v === null || v === undefined ? '?' : `$${String(v)}`;
    const text = [
      `Models from ${cfg.modelsPath} (policy ${cfg.config.policy}; thresholds low ${String(policy.thresholds.low)} / medium ${String(policy.thresholds.medium)} / high ${String(policy.thresholds.high)})`,
      ...rows.map(
        (r) =>
          `- ${r.ref} (${r.kind ?? '?'}) ${r.eligible ? 'eligible' : `excluded: ${r.excludedBecause.join(', ')}`}; price in/out per MTok ${usd(r.pricing?.inputPerMTokUsd)}/${usd(r.pricing?.outputPerMTokUsd)}; context ${r.contextWindow === null ? 'unknown' : String(r.contextWindow)}`,
      ),
      'Prices and reliability come from your config (with their sources); soot ships none.',
    ].join('\n');
    return Promise.resolve({
      ok: true,
      text,
      data: json({ modelsFile: cfg.modelsPath, policy: cfg.config.policy, models: rows }) as Record<
        string,
        JsonValue
      >,
    });
  }

  stop(runId: string, taskId?: string): Promise<CommandOutput> {
    if (!RUN_ID.test(runId)) return Promise.resolve(fail(`invalid run id: ${runId}`));
    if (taskId !== undefined) {
      let sent: boolean;
      try {
        sent = requestTaskStop(this.#o.dataDir, runId, taskId);
      } catch (error) {
        return Promise.resolve(fail((error as Error).message));
      }
      if (!sent) return Promise.resolve(fail(`run ${runId} is not running`, { runId }));
      return Promise.resolve({
        ok: true,
        text: `Cancel requested for task ${taskId} in ${runId}; its dependents are skipped, other tasks continue.`,
        data: { runId, taskId, stopRequested: true },
      });
    }
    if (!requestStop(this.#o.dataDir, runId)) {
      return Promise.resolve(fail(`run ${runId} is not running`, { runId }));
    }
    return Promise.resolve({
      ok: true,
      text: `Stop requested for ${runId}; running agents are aborted and nothing more is merged.`,
      data: { runId, stopRequested: true },
    });
  }

  /** Resolved configuration, for `soot config`. Key values are never read, only variable names. */
  config(repo = '.'): CommandOutput {
    const repoRoot = resolve(this.#o.cwd, repo);
    let cfg: LoadedConfig;
    let registry: ModelRegistry;
    try {
      cfg = this.#configFor(repoRoot);
      registry = new ModelRegistry(loadRegistryConfigFile(cfg.modelsPath));
    } catch (error) {
      return fail((error as Error).message, { dataDir: this.#o.dataDir });
    }
    const providers = registry.providers().map((p) => ({
      id: p.id,
      kind: p.kind,
      apiKeyEnv: p.apiKeyEnv ?? null,
      local: p.local,
    }));
    const data = {
      configFile: cfg.path,
      dataDir: this.#o.dataDir,
      modelsFile: cfg.modelsPath,
      fixturesFile: cfg.fixturesPath,
      policy: cfg.config.policy,
      concurrency: cfg.config.concurrency,
      attemptTimeoutMs: cfg.config.attemptTimeoutMs ?? null,
      effectiveAttemptTimeoutMs: cfg.config.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      agent: this.#o.agent.kind,
      acpAgent: cfg.config.acpAgent === undefined ? null : json(cfg.config.acpAgent),
      approvals: this.#o.approvals.mode,
      checks: json(cfg.checks),
      acceptance: json(cfg.acceptance),
      protectedPaths: this.#protectedPaths(repoRoot, cfg),
      allowedExecutables: [...cfg.policy.allowedExecutables],
      providers: json(providers),
      models: registry.models().length,
    };
    const text = [
      `Config: ${cfg.path}`,
      `State dir: ${this.#o.dataDir}`,
      `Models: ${cfg.modelsPath} (${String(data.models)} models)`,
      `Policy: ${cfg.config.policy}; concurrency ${String(cfg.config.concurrency)}`,
      `Attempt timeout: ${String(data.effectiveAttemptTimeoutMs)} ms${cfg.config.attemptTimeoutMs === undefined ? ' (default; set "attemptTimeoutMs" to change)' : ''}`,
      `Agent: ${this.#o.agent.kind === 'none' ? 'none (run refuses: pick --agent mock or --agent acp)' : this.#agentLabel(cfg)}`,
      `ACP agent command: ${cfg.config.acpAgent === undefined ? 'not configured' : describeCommand(cfg.config.acpAgent)}`,
      `Approvals: ${this.#o.approvals.mode} (soot never approves on your behalf)`,
      'Checks:',
      ...cfg.checks.map((c) => `- ${c.name} [${c.kind}]: ${c.argv.join(' ')}`),
      'Acceptance:',
      ...Object.entries(cfg.acceptance).map(
        ([id, list]) => `- ${id}: ${list.map((c) => c.name).join(', ')}`,
      ),
      `Protected paths: ${data.protectedPaths.join(', ') || 'none'}`,
      `Allowed executables: ${data.allowedExecutables.join(', ') || 'none'}`,
      'Providers (key variable names only; values are never read here):',
      ...providers.map(
        (p) =>
          `- ${p.id} (${p.kind})${p.apiKeyEnv === null ? '' : ` key: $${p.apiKeyEnv}`}${p.local ? ' local' : ''}`,
      ),
    ].join('\n');
    return { ok: true, text, data: json(data) as Record<string, JsonValue> };
  }
}
