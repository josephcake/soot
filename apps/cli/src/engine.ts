import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  MockAgentRunner,
  resolveSandbox,
  type AgentRunner,
  type ApprovalGate,
  type Sandbox,
  type SandboxHost,
  type RestoredOutcome,
  type Scheduler,
} from '@soot/agent-runtime';
import {
  AcpAgentRunner,
  createHarnessRunner,
  describeCommand,
  harnessRunnerLabel,
  spawnAcpAgent,
  type AcpRouteRecord,
  type HarnessId,
} from '@soot/harness-adapters';
import { SILENT_LOGGER, parseEnv, type LogLevel, type Logger } from '@soot/core';
import {
  DEFAULT_RUN_LOCK_TTL_MS,
  latestAttempt,
  openExecutionStore,
  pidAlive,
  type ConfigChange,
  type ExecutionStore,
  type LockState,
  type ModelOutcome,
  type PersistedRun,
  type PersistedVerification,
} from '@soot/context-manager';
import {
  AdaptiveSupervisor,
  escalationConfig,
  type AdaptiveEvent,
  type EscalationConfig,
} from '@soot/escalation';
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
  type CheckEvidence,
  type ConsolidatedReport,
  type TaskVerification,
  type Verdict,
  type WorkflowResume,
} from '@soot/integrations';
import { buildTaskGraph, type TaskGraph } from '@soot/task-graph';
import {
  EMPTY_REGISTRY_CONFIG,
  ModelRegistry,
  ProviderHealth,
  actualCostFromUsage,
  addAutoModels,
  addLocalModels,
  applyPriceCatalog,
  describeAutoPool,
  describeLocalPool,
  localProbeSettings,
  type LocalProbeSettings,
  type LocalRuntime,
  type LocalRuntimeProbe,
  type LocalRuntimeReport,
  loadRegistryConfigFile,
  type AutoProviderReport,
  type UnavailableReason,
  unpricedModels,
  unpricedWarning,
  type ModelEntry,
} from '@soot/model-registry';
import {
  historyFromAttempts,
  resolvePolicy,
  routeTasks,
  type RoutingDecision,
} from '@soot/model-router';
import {
  AuditLog,
  buildCostReport,
  costRecordsFromAttempts,
  renderCostReport,
  summarizeCosts,
  type PlanningCostInput,
} from '@soot/observability';
import {
  ModelDecompositionError,
  NoFixtureError,
  SPEC_FIXTURES,
  createDecomposer,
  createPromptIntake,
  type Decomposition,
  type DecompositionSource,
  type ModelDecompositionSource,
  type DecompositionFixture,
} from '@soot/planner';
import { CONFIG_FILE, insideRepo, loadProjectConfig, type LoadedConfig } from './config.js';
import {
  describeDecomposerModel,
  resolveDecomposerModel,
  type DecomposerModel,
  type ModelClientFactory,
} from './decomposer-model.js';
import { gatherRepoSketch } from './repo-sketch.js';
import { holdRun, requestStop, requestTaskStop, runningInfo, type RunControl } from './control.js';
import {
  fileHash,
  fingerprintChanges,
  planResume,
  textHash,
  type TaskResumeDecision,
} from './resume-plan.js';
import { loadMockScript } from './mock-script.js';
import { ApiAgentRunner } from './api-runner.js';
import {
  DEFAULT_MODEL_CALL_TIMEOUT_MS,
  TimeLimitError,
  formatLimit,
  withTimeLimit,
} from './time-limit.js';
import {
  createModelClient,
  hasApiKey,
  probeLocalRuntimes,
  unusedOptInKeyHints,
} from '@soot/provider-adapters';

/*
 * The soot engine behind the CLI and the MCP server: one prompt → recorded-fixture
 * decomposition → per-task routing with stored outcome history → supervised execution in
 * isolated worktrees with soot-run checks → serial integration → consolidated report.
 *
 * Honest limits (Milestone 6): decomposition uses recorded fixtures; prompts with no fixture go
 * to the optional "decomposer" model from soot.config.json only when a client can be built for
 * it (ADR-034). Agents: the direct-API runner (each task on its routed model, ADR-039), the
 * scripted mock, or a user-configured ACP agent through the generic ACP driver (ADR-027;
 * verified only with soot's own mock ACP agent). `run` refuses unless the caller explicitly
 * picks `--agent api`, `--agent mock` or `--agent acp`.
 */

export type AgentMode =
  | { readonly kind: 'none' }
  | { readonly kind: 'mock'; readonly script: string }
  /**
   * Spawn the `acpAgent` command from the project config (generic ACP driver, ADR-027), or with
   * `harness`, the `harnesses.<id>` adapter command through that harness's runner profile
   * (ADR-047; tested against simulated adapters only).
   */
  | { readonly kind: 'acp'; readonly harness?: HarnessId }
  /** Call each task's routed model directly through soot's provider adapters (ADR-039). */
  | { readonly kind: 'api' };

/**
 * Stored outcomes that may shape routing for this runner (ADR-039). Test-double (mock) outcomes
 * and rows from before the runner was recorded never shape real-model routing; mock runs still
 * see everything, so fixture demos of routing feedback keep working.
 */
export function routingOutcomes(
  outcomes: readonly ModelOutcome[],
  agent: AgentMode['kind'],
): ModelOutcome[] {
  if (agent === 'mock' || agent === 'none') return [...outcomes];
  return outcomes.filter((o) => o.runner === 'api' || o.runner === 'acp');
}

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
  /**
   * Environment the decomposer model's key variable (`apiKeyEnv`) is looked up in by the
   * adapter layer (default `process.env`). No `.env` file is read (ADR-030).
   */
  readonly modelEnv?: Readonly<Record<string, string | undefined>>;
  /** Builds the decomposer model's client. Default `createModelClient`; tests pass a mock. */
  readonly modelClientFactory?: ModelClientFactory;
  /** Day (YYYY-MM-DD) used to pick dated catalog prices (ADR-037). Default: today (UTC). */
  readonly priceDate?: string;
  /**
   * Probes local runtimes for keyless models (ADR-045). Default `probeLocalRuntimes`
   * (`GET <baseURL>/models`, short limit, no key). Tests pass one bound to a fake server.
   */
  readonly localProbe?: (runtimes: readonly LocalRuntime[]) => Promise<LocalRuntimeProbe[]>;
  /**
   * Host facts for picking the process sandbox (ADR-051). Default: this machine
   * (`process.platform`, `os.homedir()`, `dataDir`, `$PATH`, a real one-off backend probe).
   */
  readonly sandboxHost?: Partial<SandboxHost>;
  /**
   * Run lock lease (ADR-054): an owner that has not refreshed its heartbeat for this long is
   * stale. Default `DEFAULT_RUN_LOCK_TTL_MS` (2 minutes); the heartbeat runs every quarter.
   */
  readonly runLockTtlMs?: number;
}

/** The effective sandbox as `soot config`, `soot run` and reports show it (ADR-051). */
export function describeSandbox(s: Sandbox): {
  readonly mode: string;
  readonly backend: string;
  readonly isolation: boolean;
  readonly network: boolean;
  readonly required: boolean;
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
  readonly reason: string;
  readonly blocked: string | null;
} {
  return {
    mode: s.settings.mode,
    backend: s.backend,
    isolation: s.isolation,
    network: s.network,
    required: s.settings.required,
    readPaths: [...s.settings.readPaths],
    writePaths: [...s.settings.writePaths],
    reason: s.reason,
    blocked: s.blocked,
  };
}

/** A saved run's sandbox for `soot status`; "unknown" when the report predates ADR-051. */
export function savedSandboxLine(saved: JsonValue | undefined): string {
  if (saved === undefined || saved === null || typeof saved !== 'object' || Array.isArray(saved))
    return 'unknown (not recorded for this run)';
  const rec = saved as Readonly<Record<string, JsonValue>>;
  const backend = typeof rec.backend === 'string' ? rec.backend : 'unknown';
  return rec.isolation === true ? `${backend} (OS isolation)` : `${backend} (NOT isolation)`;
}

/** One line for humans: what isolates agent commands, honestly. */
export function sandboxLine(s: Sandbox): string {
  const what = s.isolation
    ? `${s.backend} (OS isolation: writes only in the task worktree and temp${s.settings.writePaths.length > 0 ? ` plus ${String(s.settings.writePaths.length)} configured path(s)` : ''}; network ${s.network ? 'allowed' : 'off'})`
    : 'none: NOT isolation (fallback: scrubbed env, worktree cwd, no shell, timeouts, process-group kill, output cap; the process runs with your rights and network)';
  return `${what}; ${s.reason}${s.blocked === null ? '' : `; BLOCKED: tasks will not run (${s.blocked})`}`;
}

/** `soot resume` (ADR-054). */
export interface ResumeRequest {
  readonly runId?: string;
  /** Resume the newest run (by creation time). */
  readonly latest?: boolean;
  /** Repository; default: the one the run started in. */
  readonly repo?: string;
  /** Resume even though the config, models, routes or agent changed (the change is recorded). */
  readonly allowConfigChange?: boolean;
  /** Re-run tasks held as blocked, budget-stopped or escalation-exhausted (the person resolved it). */
  readonly retryBlocked?: boolean;
}

/**
 * A loaded registry: the models file with soot's catalog prices filled in for unpriced models
 * (ADR-037), plus the auto pool for vendor keys that are set (ADR-043).
 */
interface PricedRegistry {
  readonly registry: ModelRegistry;
  /** Refs priced from soot's catalog (models-file models only; auto models are always). */
  readonly catalogPriced: readonly string[];
  /** Callable refs with no price at all. */
  readonly unpriced: readonly string[];
  /** One row per well-known vendor: added, no key, already configured, or off. */
  readonly auto: readonly AutoProviderReport[];
  /** Refs added from keys and from local runtimes (`origin: 'auto'`). */
  readonly autoRefs: readonly string[];
  /** One row per local runtime (ADR-045): added, not running, configured, off, ... */
  readonly local: readonly LocalRuntimeReport[];
  readonly localRefs: readonly string[];
  readonly localSettings: LocalProbeSettings;
}

/** Local probe settings for a loaded config (ADR-045). Throws on a bad URL. */
function localSettingsFor(
  cfg: LoadedConfig,
  env: Readonly<Record<string, string | undefined>>,
): LocalProbeSettings {
  return localProbeSettings({
    autoModels: cfg.config.autoModels,
    localModels: cfg.config.localModels,
    env,
  });
}

/** Cache key for one set of probed runtimes. */
const probeKey = (runtimes: readonly LocalRuntime[]) =>
  runtimes.map((r) => `${r.id}=${r.baseURL}`).join(',');

function loadPricedRegistry(
  cfg: LoadedConfig,
  env: Readonly<Record<string, string | undefined>>,
  today: string | undefined,
  probed: ReadonlyMap<string, readonly LocalRuntimeProbe[]>,
): PricedRegistry {
  const file =
    cfg.modelsPath === null ? EMPTY_REGISTRY_CONFIG : loadRegistryConfigFile(cfg.modelsPath);
  const day = today === undefined ? {} : { today };
  const { config: priced, catalogPriced } = applyPriceCatalog(file, day);
  const pool = addAutoModels(priced, {
    enabled: cfg.config.autoModels,
    // Presence only, inside the adapter layer's credential boundary (ADR-022).
    keyIsSet: (provider) => hasApiKey(provider, env),
    ...day,
  });
  const localSettings = localSettingsFor(cfg, env);
  const local = addLocalModels(pool.config, {
    settings: localSettings,
    probes: probed.get(probeKey(localSettings.runtimes)) ?? null,
    fileProviders: file.providers,
    ...day,
  });
  const autoRefs = [...pool.autoRefs, ...local.localRefs];
  return {
    registry: new ModelRegistry(local.config, { autoRefs }),
    catalogPriced,
    unpriced: unpricedModels(local.config),
    auto: pool.providers,
    autoRefs,
    local: local.runtimes,
    localRefs: local.localRefs,
    localSettings,
  };
}

/** Where the models came from, for messages: the models file and/or the detected keys. */
function modelsSource(cfg: LoadedConfig): string {
  return cfg.modelsPath ?? 'the models soot detected from your keys (no models file)';
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

/** ACP route records and the audit log, shared by a plan's runner callback and its run. */
interface PlanAcpState {
  readonly routes: AcpRouteRecord[];
  audit: AuditLog | null;
}

/**
 * A decomposed prompt, ready for `runPlan()` (ADR-038). Built by `plan()` only; the fields after
 * `agentLabel` are the engine's own working state and are not part of any API response.
 */
export interface EnginePlan {
  readonly runId: string;
  readonly repoRoot: string;
  readonly prompt: string;
  readonly graph: Decomposition['graph'];
  readonly source: DecompositionSource;
  readonly planning: PlanningCost;
  readonly fixtureId: string | null;
  readonly planLabel: string;
  readonly agentLabel: string;
  readonly cfg: LoadedConfig;
  readonly registry: ModelRegistry;
  readonly intake: ReturnType<typeof createPromptIntake>;
  readonly runner: AgentRunner;
  readonly acp: PlanAcpState;
  /** Process sandbox for checks and the ACP agent process (ADR-051). */
  readonly sandbox: Sandbox;
}

export type PlanOutcome =
  | { readonly ok: true; readonly plan: EnginePlan }
  | { readonly ok: false; readonly output: CommandOutput };

/** One task in a plan preview: the router's first choice and its estimate. */
export interface PlanPreviewTask {
  readonly taskId: string;
  readonly title: string;
  readonly complexity: string;
  readonly dependsOn: readonly string[];
  /** First-choice model, or `null` when no model is eligible (the run will report it). */
  readonly model: string | null;
  /** Planned tokens × list price; `null` when the model has no price or nothing is eligible. */
  readonly estimateUsd: number | null;
  /** Worst case for this task: every allowed attempt on the priciest acceptable model. */
  readonly worstCaseUsd: number | null;
  readonly plannedInputTokens: number;
  readonly plannedOutputTokens: number;
  readonly reason: string;
}

export interface PlanPreview {
  readonly runId: string;
  readonly planner: {
    readonly kind: 'fixture' | 'model';
    readonly model: string | null;
    readonly fixtureId: string | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    /** Spent: the planning call already happened. `null` when unpriced or unreported. */
    readonly costUsd: number | null;
    readonly priced: boolean | null;
  };
  readonly tasks: readonly PlanPreviewTask[];
  /** Sum of the known task estimates; `estimatePartial` when a task has none. */
  readonly estimateUsd: number | null;
  readonly estimatePartial: boolean;
  /**
   * Sum of the per-task worst cases, capped by what the run budget leaves after planning when a
   * budget is set.
   */
  readonly worstCaseUsd: number | null;
  readonly worstCasePartial: boolean;
  readonly worstCaseBasis: string;
  readonly policy: string;
  readonly agentLabel: string;
}

const USED_PLANS = new WeakSet<EnginePlan>();

export class SootEngine implements OrchestrationService {
  readonly #o: EngineOptions;

  /** Local runtime probes from this engine's async commands, by runtime list (ADR-045). */
  readonly #probed = new Map<string, readonly LocalRuntimeProbe[]>();

  constructor(options: EngineOptions) {
    this.#o = options;
  }

  /**
   * Probe the local runtimes the project's config and environment name (ADR-045), so the
   * next registry load includes their models. `plan`/`run` and `models` call it; call it before
   * the synchronous `config()` to see local models there. Never throws: a config error is
   * reported by the command itself, and a runtime that is not running is just not running.
   */
  async probeLocalModels(repo = '.'): Promise<void> {
    let settings: LocalProbeSettings;
    try {
      settings = localSettingsFor(
        this.#configFor(resolve(this.#o.cwd, repo)),
        this.#o.modelEnv ?? process.env,
      );
    } catch {
      return;
    }
    if (!settings.enabled) return;
    const probe = this.#o.localProbe ?? ((r) => probeLocalRuntimes(r));
    try {
      this.#probed.set(probeKey(settings.runtimes), await probe(settings.runtimes));
    } catch (error) {
      (this.#o.log ?? SILENT_LOGGER).warn(
        `soot: local model probe failed: ${(error as Error).message}`,
      );
    }
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

  #sandbox(cfg: LoadedConfig): Sandbox {
    const h = this.#o.sandboxHost ?? {};
    return resolveSandbox(cfg.sandbox, {
      platform: h.platform ?? process.platform,
      home: h.home === undefined ? homedir() : h.home,
      dataDir: h.dataDir === undefined ? resolve(this.#o.dataDir) : h.dataDir,
      path: h.path ?? process.env.PATH ?? '',
      ...(h.probe === undefined ? {} : { probe: h.probe }),
    });
  }

  #runner(
    cfg: LoadedConfig,
    registry: ModelRegistry,
    onRoute: (r: AcpRouteRecord) => void,
    sandbox: Sandbox,
    agent: AgentMode = this.#o.agent,
  ): AgentRunner | string {
    if (agent.kind === 'none') {
      return (
        'no agent runner selected: pick --agent api (each task goes to its routed model; needs ' +
        'the provider keys named in your models file), --agent mock --mock-script <file> for a ' +
        `fixture run, or --agent acp with an "acpAgent" command in ${CONFIG_FILE}.`
      );
    }
    if (agent.kind === 'api') {
      const factory = this.#o.modelClientFactory ?? createModelClient;
      const env = this.#o.modelEnv ?? process.env;
      return new ApiAgentRunner({
        clientFor: (ref) => {
          const model = registry.get(ref);
          const provider = model === undefined ? undefined : registry.provider(model.provider);
          if (model === undefined || provider === undefined)
            throw new Error(`model "${ref}" is not in ${modelsSource(cfg)}`);
          return factory(provider, model, { env });
        },
        priceUsage: (ref, usage) => {
          const model = registry.get(ref);
          if (model === undefined) return null;
          const { costUsd } = actualCostFromUsage(model, usage);
          return costUsd === null ? null : Number(costUsd);
        },
        tryTimeoutMs: cfg.config.modelCallTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS,
        editFormat: cfg.config.apiEditFormat,
      });
    }
    if (agent.kind === 'acp' && agent.harness !== undefined) {
      const spec = cfg.config.harnesses?.[agent.harness];
      if (spec === undefined) {
        return `--agent ${agent.harness} needs "harnesses": { "${agent.harness}": { "command": "/absolute/path/to/its-acp-adapter" } } in ${cfg.path}; soot never picks, installs or searches for one, and never signs in.`;
      }
      try {
        return createHarnessRunner(agent.harness, spec, {
          approvals: this.#o.approvals.mode,
          env: this.#o.agentEnv ?? process.env,
          onRoute,
          sandbox,
        });
      } catch (error) {
        return (error as Error).message;
      }
    }
    if (agent.kind === 'acp') {
      const spec = cfg.config.acpAgent;
      if (spec === undefined) {
        return `--agent acp needs an "acpAgent" command in ${cfg.path}; soot never picks or searches for one.`;
      }
      return new AcpAgentRunner({
        connect: spawnAcpAgent(spec, this.#o.agentEnv ?? process.env, { sandbox }),
        approvals: this.#o.approvals.mode,
        onRoute,
      });
    }
    return new MockAgentRunner(loadMockScript(resolve(this.#o.cwd, agent.script)));
  }

  /** The agent mode as stored with a session: a mock script path made absolute. */
  #recordableAgent(agent: AgentMode): AgentMode {
    return agent.kind === 'mock'
      ? { kind: 'mock', script: resolve(this.#o.cwd, agent.script) }
      : agent;
  }

  #lockTtl(): number {
    return this.#o.runLockTtlMs ?? DEFAULT_RUN_LOCK_TTL_MS;
  }

  #liveCheck(): (store: ExecutionStore, runId: string) => LockState {
    const ttlMs = this.#lockTtl();
    return (store, runId) => store.runLockState(runId, { ttlMs, isAlive: pidAlive });
  }

  /**
   * What a run's behaviour depends on, one hash per part (ADR-054): the project config, models
   * and fixtures files, the agent (and mock script), and the routable model refs (which also
   * change when keys or local runtimes come and go). Compared on resume.
   */
  #fingerprint(
    cfg: LoadedConfig,
    agent: AgentMode,
    registry: ModelRegistry,
  ): Record<string, string> {
    return {
      config: fileHash(cfg.path),
      models: fileHash(cfg.modelsPath),
      fixtures: fileHash(cfg.fixturesPath),
      agent:
        agent.kind === 'acp' && agent.harness !== undefined ? `acp:${agent.harness}` : agent.kind,
      mockScript: agent.kind === 'mock' ? fileHash(resolve(this.#o.cwd, agent.script)) : 'none',
      routes: textHash(
        registry
          .models()
          .map((m) => m.ref)
          .sort()
          .join('\n'),
      ),
    };
  }

  #decomposerModel(cfg: LoadedConfig, registry: ModelRegistry): DecomposerModel {
    return resolveDecomposerModel(
      cfg,
      registry,
      this.#o.modelEnv ?? process.env,
      this.#o.modelClientFactory,
    );
  }

  #agentLabel(cfg: LoadedConfig, agent: AgentMode = this.#o.agent): string {
    if (agent.kind === 'acp' && agent.harness !== undefined) {
      const spec = cfg.config.harnesses?.[agent.harness];
      if (spec !== undefined) {
        return `${harnessRunnerLabel(agent.harness, spec)}; runner profile over the generic ACP driver, tested against simulated adapters only; routed models are applied only when the adapter offers a "model" option, see ACP model routing`;
      }
    }
    if (agent.kind === 'acp' && cfg.config.acpAgent !== undefined) {
      return `acp (${describeCommand(cfg.config.acpAgent)}; generic ACP driver; routed models are applied only when the agent offers a "model" option, see ACP model routing)`;
    }
    if (agent.kind === 'mock') return 'mock-test-double (test double, no model is called)';
    if (agent.kind === 'api')
      return cfg.config.apiEditFormat === 'whole'
        ? 'api (direct model calls: each task goes to its routed model; the model returns whole-file edits; "apiEditFormat": "whole")'
        : 'api (direct model calls: each task goes to its routed model; the model returns targeted edits or whole files)';
    return agent.kind;
  }

  /** The config file, models file and fixtures file are protected when they live in the repo. */
  #protectedPaths(repoRoot: string, cfg: LoadedConfig, agent: AgentMode = this.#o.agent): string[] {
    const extra = [cfg.path, cfg.modelsPath, cfg.fixturesPath]
      .filter((p): p is string => p !== null)
      .map((p) => insideRepo(repoRoot, p))
      .filter((p): p is string => p !== null);
    if (agent.kind === 'mock') {
      const script = insideRepo(repoRoot, resolve(this.#o.cwd, agent.script));
      if (script !== null) extra.push(script);
    }
    return [...new Set([...cfg.config.protectedPaths, ...extra])];
  }

  /**
   * Plan and run one prompt: `plan()` then `runPlan()`, the same code the dashboard uses
   * (ADR-038). Behaviour and output are unchanged from before the split.
   */
  async run(request: RunRequest, signal?: AbortSignal): Promise<CommandOutput> {
    const planned = await this.plan(request, signal);
    if (!planned.ok) return planned.output;
    return this.runPlan(planned.plan, signal);
  }

  /**
   * Load the config and registry, check the runner, and decompose the prompt (fixtures first,
   * then the configured decomposer model). No store writes, worktrees, locks or agent start:
   * the only side effect is the planning call itself when a decomposer model is used.
   */
  async plan(request: RunRequest, signal?: AbortSignal): Promise<PlanOutcome> {
    const log = this.#o.log ?? SILENT_LOGGER;
    const progress = log.info;
    const repoRoot = resolve(this.#o.cwd, request.repo ?? '.');
    const runId = request.runId ?? newRunId();
    const failed = (output: CommandOutput): PlanOutcome => ({ ok: false, output });
    if (!RUN_ID.test(runId)) return failed(fail(`invalid run id: ${runId}`));
    let cfg: LoadedConfig;
    let registry: ModelRegistry;
    let priced: PricedRegistry;
    let fixtures: DecompositionFixture[];
    await this.probeLocalModels(repoRoot);
    try {
      cfg = this.#configFor(repoRoot);
      priced = loadPricedRegistry(
        cfg,
        this.#o.modelEnv ?? process.env,
        this.#o.priceDate,
        this.#probed,
      );
      registry = priced.registry;
      fixtures = loadFixtures(cfg.fixturesPath);
    } catch (error) {
      return failed(fail((error as Error).message));
    }
    // ACP (ADR-028): whether each attempt's routed model was applied by the agent.
    const acp: PlanAcpState = { routes: [], audit: null };
    const sandbox = this.#sandbox(cfg);
    const runner = this.#runner(
      cfg,
      registry,
      (r) => {
        acp.routes.push(r);
        acp.audit?.record('model-route', r.taskId, {
          attempt: r.attempt,
          routed: r.routed,
          applied: r.applied,
          agentValue: r.agentValue,
          reason: r.reason,
        });
        (r.applied ? log.info : log.warn)(
          `soot: ${r.taskId} #${String(r.attempt)} ACP model ${r.applied ? 'applied' : 'NOT applied'}: ${r.reason}`,
        );
      },
      sandbox,
    );
    if (typeof runner === 'string') return failed(fail(runner));
    (sandbox.blocked !== null || !sandbox.isolation ? log.warn : log.info)(
      `soot: sandbox: ${sandboxLine(sandbox)}`,
    );
    const agentLabel = this.#agentLabel(cfg);

    const unpricedNote = unpricedWarning(priced.unpriced);
    if (unpricedNote !== null) log.warn(`soot: ${unpricedNote}`);
    const autoAdded = priced.auto.filter((a) => a.status === 'added');
    if (autoAdded.length > 0) {
      log.info(
        `soot: auto models from ${autoAdded.map((a) => `$${a.apiKeyEnv}`).join(', ')}: ${String(priced.autoRefs.length - priced.localRefs.length)} model(s); light work goes to low-tier models, hard work to high-tier ones (see soot models)`,
      );
    }
    const localAdded = priced.local.filter((r) => r.status === 'added');
    if (localAdded.length > 0) {
      log.info(
        `soot: local models from ${localAdded.map((r) => r.label).join(', ')}: ${String(priced.localRefs.length)} model(s) at $0, tier low; light work that fits their ${String(priced.localSettings.contextWindow)}-token context goes there first (see soot models)`,
      );
    }

    const intake = createPromptIntake({
      prompt: request.prompt,
      context: gatherRepoSketch(repoRoot),
    });
    // Fixtures first; the configured decomposer model only for prompts no fixture matches, and
    // only when a client could be built (ADR-034). No client: fixture-only, no network.
    let decomposerModel = this.#decomposerModel(cfg, registry);
    // The planner call honours provider cooldowns recorded by earlier calls (issue #5, ADR-046).
    if (decomposerModel.status === 'usable') {
      const cooling = this.#cooldownOf(decomposerModel.client.provider);
      if (cooling !== null) {
        decomposerModel = { status: 'unusable', ref: decomposerModel.ref, reason: cooling };
      }
    }
    if (decomposerModel.status === 'unusable') {
      log.warn(
        `soot: decomposer model ${decomposerModel.ref} is not usable (${decomposerModel.reason}); only recorded prompts can be decomposed`,
      );
    }
    let decomposition: Decomposition;
    const planLimitMs = cfg.config.modelCallTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS;
    try {
      decomposition = await withTimeLimit(
        planLimitMs,
        signal,
        (planSignal, requestTimeout) =>
          createDecomposer({
            fixtures: [...SPEC_FIXTURES, ...fixtures],
            model: decomposerModel.status === 'usable' ? decomposerModel.client : null,
            timeoutMs: requestTimeout(),
          }).decompose(intake, planSignal),
        () =>
          new TimeLimitError(
            planLimitMs,
            `the planner model ${decomposerModel.status === 'not-configured' ? '' : decomposerModel.ref}`.trimEnd(),
          ),
      );
    } catch (error) {
      if (error instanceof TimeLimitError) {
        return failed(
          fail(
            `${error.message} (limit "modelCallTimeoutMs" in ${CONFIG_FILE}); the request was aborted and no task was run.`,
            {
              promptSha256: intake.promptSha256,
              decompositionFailure: 'timeout',
              timeoutMs: error.limitMs,
            },
          ),
        );
      }
      if (error instanceof NoFixtureError) {
        const recorded = `Recorded prompts: soot ships the build spec examples; add your own with "fixtures" in ${CONFIG_FILE}.`;
        if (decomposerModel.status === 'unusable') {
          return failed(
            fail(
              `No decomposition fixture matches this prompt, and the decomposer model ${decomposerModel.ref} configured in ${CONFIG_FILE} is not usable: ${decomposerModel.reason}. No model was called. ${recorded}`,
              {
                promptSha256: error.promptSha256,
                decomposerModel: decomposerModel.ref,
                decomposerModelStatus: 'unusable',
                decomposerModelReason: decomposerModel.reason,
              },
            ),
          );
        }
        return failed(
          fail(
            `${error.message} ${recorded} To decompose other prompts with a model from your models file, set "decomposer": {"model": "<provider/modelId>"} in ${CONFIG_FILE}.`,
            { promptSha256: error.promptSha256 },
          ),
        );
      }
      if (error instanceof ModelDecompositionError) {
        // A provider failure puts the provider in cooldown, as a task attempt would (ADR-046).
        const cooldown =
          decomposerModel.status === 'usable'
            ? this.#recordPlannerFailure(decomposerModel.client.provider, error)
            : null;
        // Reported as is: soot never falls back to a guess or a similar fixture.
        return failed(
          fail(
            [
              error.message,
              ...error.issues.map((i) => `- ${i}`),
              ...(cooldown === null
                ? []
                : [
                    `Provider ${cooldown.provider} is now in cooldown (${cooldown.reason})${cooldown.until === null ? ' for this session' : ` until ${new Date(cooldown.until).toISOString()}`}; routing and planning skip it until then.`,
                  ]),
            ].join('\n'),
            {
              promptSha256: error.promptSha256,
              decomposerModel: error.modelRef,
              decompositionFailure: error.reason,
              issues: [...error.issues],
              ...(cooldown === null ? {} : { providerCooldown: json(cooldown) }),
            },
          ),
        );
      }
      return failed(fail((error as Error).message));
    }
    const { graph } = decomposition;
    const source = decomposition.decomposer;
    const planning = planningCost(registry, source);
    // Planning spend counts against the run budget before any task starts (issue #5, ADR-046).
    if (source.kind === 'model') {
      let runBudgetUsd: number | null;
      try {
        runBudgetUsd = escalationConfig(cfg.config.escalation ?? {}).runBudgetUsd;
      } catch (error) {
        return failed(fail((error as Error).message));
      }
      const spent = planning.costUsd ?? null;
      if (runBudgetUsd !== null && spent !== null && spent > runBudgetUsd) {
        return failed(
          fail(
            `Planning alone cost $${spent.toFixed(6)} (${source.modelRef}), more than the run budget of $${String(runBudgetUsd)} ("escalation.runBudgetUsd" in ${CONFIG_FILE}). No task was started.`,
            {
              promptSha256: intake.promptSha256,
              decomposerModel: source.modelRef,
              decompositionFailure: 'run-budget',
              planningCostUsd: spent,
              runBudgetUsd,
            },
          ),
        );
      }
      if (runBudgetUsd !== null && spent === null) {
        log.warn(
          `soot: the planning call's cost is unknown (${planning.priceBasis === null || planning.priceBasis === undefined ? `${source.modelRef} has no price` : 'usage not reported'}); it is not counted against the run budget`,
        );
      }
    }
    const fixtureId = source.kind === 'fixture' ? source.fixtureId : null;
    const planLabel =
      source.kind === 'fixture'
        ? `recorded fixture "${source.fixtureId}"`
        : `model ${source.modelRef} (validated by soot; ${String(source.attempts)} model call(s))`;
    progress(
      `soot: run ${runId}: ${String(graph.tasks.length)} tasks from ${planLabel}; agent: ${agentLabel}`,
    );
    const plan: EnginePlan = {
      runId,
      repoRoot,
      prompt: request.prompt,
      graph,
      source,
      planning,
      fixtureId,
      planLabel,
      agentLabel,
      cfg,
      registry,
      intake,
      runner,
      acp,
      sandbox,
    };
    return { ok: true, plan };
  }

  /**
   * First-choice model and estimate per task (the router, with stored history and provider
   * cooldowns, exactly as the supervisor's first assignment), plus a worst case that allows every
   * attempt the escalation config permits on the priciest model the router would accept. Reads
   * the store; writes nothing.
   */
  previewPlan(plan: EnginePlan): PlanPreview {
    const store = this.#store();
    let history;
    let health: ProviderHealth;
    try {
      history = historyFromAttempts(
        routingOutcomes(store.modelOutcomes(), this.#o.agent.kind).map((o) => ({
          model: o.model,
          tier: o.tier,
          status: o.outcome === 'verified' ? ('succeeded' as const) : ('failed' as const),
        })),
      );
      health = new ProviderHealth({ store });
      const esc = escalationConfig(plan.cfg.config.escalation ?? {});
      const decisions = routeTasks(plan.graph.tasks, {
        registry: plan.registry,
        policy: plan.cfg.config.policy,
        history,
        health,
      });
      return buildPlanPreview(plan, decisions, esc);
    } finally {
      store.close();
    }
  }

  /**
   * Execute a plan from `plan()`: today's run from the run lock and `store.createRun` onward. A
   * plan runs at most once. `onRunStarted` fires once the run is recorded (so status can see it).
   */
  async runPlan(
    plan: EnginePlan,
    signal?: AbortSignal,
    hooks: { readonly onRunStarted?: (runId: string) => void } = {},
  ): Promise<CommandOutput> {
    if (USED_PLANS.has(plan)) return fail(`plan for run ${plan.runId} was already run`);
    USED_PLANS.add(plan);
    const log = this.#o.log ?? SILENT_LOGGER;
    const { runId, repoRoot, graph, source, planning, intake, cfg, registry } = plan;
    const agent = this.#recordableAgent(this.#o.agent);
    const store = this.#store();
    const canceller = new TaskCanceller(log, store, runId);
    mkdirSync(join(this.#o.dataDir, 'reports'), { recursive: true, mode: 0o700 });
    writeFileSync(this.#eventsPath(runId), '', { mode: 0o600 });
    let control: RunControl;
    try {
      control = holdRun(this.#o.dataDir, runId, signal, 200, (id) => {
        canceller.cancel(id);
      });
    } catch (error) {
      store.close();
      return fail((error as Error).message);
    }
    const planningLine = planningCostInput(source, planning);
    let session: { session: number; owner: string };
    try {
      store.createRun({ runId, intake, graph });
      if (planningLine !== null) {
        store.savePlanningCost(runId, {
          model: planningLine.model,
          inputTokens: planningLine.inputTokens,
          outputTokens: planningLine.outputTokens,
          usd: planningLine.costUsd,
          priced: planningLine.priced,
        });
      }
      const begun = store.beginSession(runId, {
        kind: 'run',
        repoRoot,
        fingerprint: this.#fingerprint(cfg, agent, registry),
        agent,
        meta: {
          fixtureId: plan.fixtureId,
          planLabel: plan.planLabel,
          decomposition: json({ ...source, ...planning }),
          planningText: source.kind === 'model' ? describePlanningCost(source, planning) : null,
        } satisfies SessionMeta,
        ttlMs: this.#lockTtl(),
      });
      if (!begun.ok) throw new Error(`run ${runId} is already held: ${begun.lock.reason}`);
      session = begun;
    } catch (error) {
      control.release();
      store.close();
      return fail(`run ${runId} failed: ${(error as Error).message}`, { runId });
    }
    return this.#execute({
      runId,
      repoRoot,
      graph,
      cfg,
      registry,
      runner: plan.runner,
      sandbox: plan.sandbox,
      agent,
      agentLabel: plan.agentLabel,
      acp: plan.acp,
      prompt: plan.prompt,
      planningLine,
      meta: {
        fixtureId: plan.fixtureId,
        planLabel: plan.planLabel,
        decomposition: json({ ...source, ...planning }),
        planningText: source.kind === 'model' ? describePlanningCost(source, planning) : null,
      },
      store,
      control,
      canceller,
      session: session.session,
      owner: session.owner,
      resume: null,
      earlierDecisions: [],
      hooks,
    });
  }

  /**
   * The shared body of `soot run` and `soot resume` (ADR-054): one code path from the audit log
   * to the saved report, so every workflow option (including the process sandbox, ADR-051)
   * applies to resumed runs exactly as to fresh ones. Releases the locks and the store.
   */
  async #execute(x: ExecContext): Promise<CommandOutput> {
    const log = this.#o.log ?? SILENT_LOGGER;
    const progress = log.info;
    const {
      runId,
      repoRoot,
      graph,
      cfg,
      registry,
      runner,
      sandbox,
      agentLabel,
      store,
      control,
      meta,
    } = x;
    const acpRoutes = x.acp.routes;
    const isAcp = x.agent.kind === 'acp';
    const eventsPath = this.#eventsPath(runId);
    // The lease: refreshed while the run lives. Losing it (another process took over after it
    // expired) aborts this run so two owners never work on it at once.
    const lost = new AbortController();
    const ttl = this.#lockTtl();
    const heartbeat = setInterval(
      () => {
        if (!store.heartbeatRunLock(runId, x.owner)) {
          log.error(`soot: run ${runId} lock was taken over by another process; stopping`);
          lost.abort();
        }
      },
      Math.max(50, Math.floor(ttl / 4)),
    );
    heartbeat.unref();
    const runSignal = AbortSignal.any([control.signal, lost.signal]);
    let finalStatus = 'error';
    try {
      const runAudit = new AuditLog({ runId, file: auditLogPath(this.#o.dataDir, runId) });
      x.acp.audit = runAudit;
      if (x.resume !== null) {
        if (x.resume.reclaimedLock !== null) {
          runAudit.record('run-lock-reclaimed', null, {
            session: x.session,
            previousOwnerPid: x.resume.reclaimedLock.holder.pid,
            previousSession: x.resume.reclaimedLock.holder.session,
            reason: x.resume.reclaimedLock.reason,
          });
        }
        runAudit.record('run-resumed', null, {
          session: x.session,
          kept: x.resume.decisions.filter((d) => d.action === 'keep').map((d) => d.taskId),
          rerun: x.resume.decisions.filter((d) => d.action === 'rerun').map((d) => d.taskId),
          held: x.resume.decisions.filter((d) => d.action === 'hold').map((d) => d.taskId),
          interrupted: [...x.resume.interrupted],
          configChanges: x.resume.changes.map((c) => c.part),
          decisions: json(x.resume.decisions),
        });
      }
      x.hooks.onRunStarted?.(runId);
      // Provider cooldowns recorded by earlier runs still apply (ADR-030).
      const health = new ProviderHealth({ store });
      for (const c of store.providerCooldowns(Date.now())) {
        progress(
          `soot: provider ${c.provider} unavailable until ${new Date(c.until).toISOString()} (${c.reason}, recorded earlier); routing skips it until then`,
        );
      }
      log.debug(
        `soot: debug: config ${cfg.path}; models ${modelsSource(cfg)}; attempt timeout ${String(cfg.config.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS)} ms${cfg.config.attemptTimeoutMs === undefined ? ' (default)' : ''}; audit ${runAudit.file ?? ''}`,
      );
      // Routing feedback (M5-07): soot-verified outcomes from earlier runs shape this run's routing.
      const outcomes = routingOutcomes(store.modelOutcomes(), x.agent.kind);
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
        // Run-budget spend is kept per attempt in soot.sqlite and reloaded on restart (ADR-030),
        // so a resumed run's budget already counts every earlier attempt (ADR-054).
        spend: store.spendLedger(runId),
        // Priced planning counts against the run budget (ADR-046); unknown is never guessed.
        ...(x.planningLine?.costUsd == null ? {} : { planningSpendUsd: x.planningLine.costUsd }),
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
        protectedPaths: this.#protectedPaths(repoRoot, cfg, x.agent),
        retryCheckOutputBytes: cfg.config.retryCheckOutputBytes,
        retryDiffBytes: cfg.config.retryDiffBytes,
        policy: cfg.policy,
        approvals: this.#o.approvals,
        supervisor,
        concurrency: cfg.config.concurrency,
        ...(cfg.config.attemptTimeoutMs === undefined
          ? {}
          : { attemptTimeoutMs: cfg.config.attemptTimeoutMs }),
        journal: store.journal(runId, x.session),
        audit: runAudit,
        signal: runSignal,
        onScheduler: (s) => {
          x.canceller.attach(s);
        },
        onRepository: (repo) => {
          store.setSessionBase(runId, x.session, repo.baseCommit);
        },
        // soot's verdicts are persisted so a later `soot resume` can integrate this work.
        onVerification: (v) => {
          store.saveVerification(runId, persistVerification(v));
        },
        ...(x.resume === null ? {} : { resume: x.resume.workflow }),
        // Routing history is credited to a model only when that model did the work: always for
        // the api runner, for ACP only where the agent applied the route; mock outcomes are kept
        // but tagged, and only mock runs read them back.
        // The runner is stored with each outcome so test-double results never shape
        // real-model routing (ADR-039).
        outcomes: {
          recordModelOutcome: (o: ModelOutcome) => {
            if (isAcp) {
              const applied = acpRoutes.some(
                (r) =>
                  r.applied &&
                  r.taskId === o.taskId &&
                  r.attempt === o.attempt &&
                  r.routed === o.model,
              );
              if (applied) store.recordModelOutcome({ ...o, runner: 'acp' });
              return;
            }
            store.recordModelOutcome({ ...o, runner: x.agent.kind });
          },
        },
        prompt: x.prompt,
        planning: x.planningLine,
        ...(this.#o.gitEnv === undefined ? {} : { gitEnv: this.#o.gitEnv }),
        // ADR-051: every soot-run check runs under the sandbox and is stored with its backend.
        sandbox,
        onCheck: (taskId, attempt, e) => {
          store.recordCommandRun({
            runId,
            taskId,
            attempt,
            stage: taskId === null ? 'final-validation' : 'task-check',
            name: e.name,
            status: e.status,
            exitCode: e.exitCode,
            sandbox: e.sandbox,
          });
        },
      });
      const { report } = result;
      let resumeDecisions: readonly ResumeDecisionRecord[] = [];
      if (x.resume !== null) {
        const dropped = new Set(result.dropped);
        resumeDecisions = x.resume.decisions.map((d) =>
          dropped.has(d.taskId)
            ? {
                ...d,
                action: 'rerun' as const,
                reason: `${d.reason}; but its verified commit is gone from the repository, so it ran again`,
              }
            : d,
        );
        store.setSessionDecisions(runId, x.session, [
          ...resumeDecisions,
          ...result.reclaimed.map((a) => ({
            worktree: a.action,
            taskId: a.taskId,
            detail: a.detail,
          })),
        ]);
      }
      const decisions = [...x.earlierDecisions, ...supervisor.events.map(eventLine)];
      finalStatus = report.status;
      store.finishSession(runId, x.session, report.status);
      const sessions = sessionSummaries(store, runId, this.#liveCheck());
      // Cost records with the router's estimate per attempt, written automatically (ADR-030).
      const costRecords = this.#costRecords(store, runId);
      const saved = {
        runId,
        fixtureId: meta.fixtureId,
        decomposition: meta.decomposition,
        agent: runner.kind,
        agentLabel,
        policy: cfg.config.policy,
        historySamples: outcomes.length,
        maxObservedConcurrency: result.run.maxObservedConcurrency,
        decisions,
        ...(isAcp ? { acpRoutes } : {}),
        stopRequested: control.stopRequested(),
        sandbox: describeSandbox(sandbox),
        // Every session of the run, oldest first: the resume history (ADR-054).
        session: x.session,
        sessions: json(sessions),
        ...(x.resume === null
          ? {}
          : {
              resume: json({
                decisions: resumeDecisions,
                configChanges: x.resume.changes,
                reclaimed: result.reclaimed,
              }),
            }),
        report,
        costRecords,
        costSummary: summarizeCosts(costRecords),
      };
      writeFileSync(this.#reportPath(runId), `${JSON.stringify(saved, null, 2)}\n`, {
        mode: 0o600,
      });
      const planSource = meta.planningText === null ? 'fixture' : 'model';
      const text = [
        `soot run ${runId} (${report.status.toUpperCase()})${x.resume === null ? '' : ` — resumed, session ${String(x.session)}`}`,
        `Plan: ${planSource === 'fixture' ? `${meta.planLabel} (no model-backed decomposition)` : meta.planLabel}; agent: ${agentLabel}; policy: ${cfg.config.policy}; routing history: ${String(outcomes.length)} stored outcomes; peak concurrency ${String(result.run.maxObservedConcurrency)}`,
        `Sandbox: ${sandboxLine(sandbox)}`,
        ...(meta.planningText === null ? [] : [`Planning call: ${meta.planningText}`]),
        ...(x.resume === null
          ? []
          : [
              'Resume:',
              ...resumeDecisions.map(
                (d) => `- ${d.taskId}: ${d.action} (was ${d.previous}): ${d.reason}`,
              ),
              ...result.reclaimed.map(
                (a) =>
                  `- worktree ${a.action}${a.taskId === null ? '' : ` ${a.taskId}`}: ${a.detail}`,
              ),
              ...(x.resume.changes.length === 0
                ? []
                : [
                    `Config changes accepted (--allow-config-change): ${x.resume.changes.map((c) => c.part).join(', ')}`,
                  ]),
            ]),
        ...(sessions.length > 1 ? ['Sessions:', ...sessions.map(sessionLine)] : []),
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
      store.finishSession(runId, x.session, finalStatus);
      return fail(`run ${runId} failed: ${(error as Error).message}`, { runId });
    } finally {
      clearInterval(heartbeat);
      store.releaseRunLock(runId, x.owner);
      control.release();
      store.close();
    }
  }

  /**
   * `soot resume <run-id>` / `--latest` (ADR-054): continue an interrupted, stopped, crashed or
   * blocked run from soot.sqlite and its branches instead of starting over. Refuses a run that a
   * live process holds, refuses config drift unless `allowConfigChange`, keeps done work, re-runs
   * unfinished tasks on fresh worktrees, keeps blocked tasks blocked unless `retryBlocked`, and
   * asks every approval again (nothing is auto-approved). A complete run is a no-op.
   */
  async resume(
    request: ResumeRequest,
    signal?: AbortSignal,
    hooks: { readonly onRunStarted?: (runId: string) => void } = {},
  ): Promise<CommandOutput> {
    const log = this.#o.log ?? SILENT_LOGGER;
    if (request.runId !== undefined && !RUN_ID.test(request.runId))
      return fail(`invalid run id: ${request.runId}`);
    const store = this.#store();
    let handedOff = false;
    try {
      const ids = store.listRunIds();
      const runId = request.runId ?? (request.latest === true ? ids.at(-1) : undefined);
      if (runId === undefined) {
        return fail(request.latest === true ? 'no runs yet' : 'resume needs a run id or --latest', {
          refused: 'no-run',
        });
      }
      if (!ids.includes(runId)) return fail(`unknown run ${runId}`, { runId, refused: 'unknown' });
      const live = store.runLockState(runId, { ttlMs: this.#lockTtl() });
      const fileLock = runningInfo(this.#o.dataDir, runId);
      if (live.state === 'live' || fileLock !== null) {
        const why =
          live.state === 'live' ? live.reason : `pid ${String(fileLock?.pid)} holds its run lock`;
        return fail(
          `run ${runId} is live in another soot process (${why}); not resumed. Stop it with "soot stop ${runId}" first, or wait for it to finish.`,
          { runId, refused: 'live' },
        );
      }
      const sessions = store.sessions(runId);
      const last = sessions.at(-1);
      const saved = this.#savedReport(runId);
      const complete =
        last !== undefined
          ? last.status === 'complete'
          : sessions.length === 0 && saved?.report.status === 'complete';
      if (complete) {
        return {
          ok: true,
          text: `Run ${runId} is already complete; nothing to resume (no task was run, nothing was changed).`,
          data: { runId, noop: true, reason: 'complete', reportStatus: 'complete' },
        };
      }
      // The agent the run used, unless the caller names one (a change is config drift).
      const recorded = (last?.agent ?? null) as AgentMode | null;
      const agent = this.#o.agent.kind !== 'none' ? this.#recordableAgent(this.#o.agent) : recorded;
      if (agent === null || agent.kind === 'none') {
        return fail(
          `run ${runId} has no recorded agent (it predates resume support); pass --agent as for soot run`,
          { runId, refused: 'no-agent' },
        );
      }
      const repoRoot =
        request.repo !== undefined
          ? resolve(this.#o.cwd, request.repo)
          : (sessions[0]?.repoRoot ?? resolve(this.#o.cwd, '.'));
      await this.probeLocalModels(repoRoot);
      let cfg: LoadedConfig;
      let registry: ModelRegistry;
      try {
        cfg = this.#configFor(repoRoot);
        registry = loadPricedRegistry(
          cfg,
          this.#o.modelEnv ?? process.env,
          this.#o.priceDate,
          this.#probed,
        ).registry;
      } catch (error) {
        return fail((error as Error).message, { runId });
      }
      const changes = fingerprintChanges(
        last?.fingerprint ?? null,
        this.#fingerprint(cfg, agent, registry),
      );
      if (changes.length > 0 && request.allowConfigChange !== true) {
        return fail(
          [
            `run ${runId} was not resumed: what it depends on changed since it ${last === undefined ? 'started' : `last ran (session ${String(last.session)})`}:`,
            ...changes.map((c) => `- ${describeChange(c)}`),
            'Restore the previous setup, or pass --allow-config-change to resume with the new one (the change is recorded).',
          ].join('\n'),
          { runId, refused: 'config-changed', changes: json(changes) },
        );
      }
      const acp: PlanAcpState = { routes: [], audit: null };
      // A resumed session resolves the sandbox from today's config and host, like `soot run`.
      const sandbox = this.#sandbox(cfg);
      const runner = this.#runner(
        cfg,
        registry,
        (r) => {
          acp.routes.push(r);
          acp.audit?.record('model-route', r.taskId, {
            attempt: r.attempt,
            routed: r.routed,
            applied: r.applied,
            agentValue: r.agentValue,
            reason: r.reason,
          });
        },
        sandbox,
        agent,
      );
      if (typeof runner === 'string') return fail(runner, { runId });
      (sandbox.blocked !== null || !sandbox.isolation ? log.warn : log.info)(
        `soot: sandbox: ${sandboxLine(sandbox)}`,
      );
      const agentLabel = this.#agentLabel(cfg, agent);
      const meta = (sessions[0]?.meta ?? null) as SessionMeta | null;
      const prompt = store.loadRun(runId).originalPrompt;

      // Take the run: the lock and a new session row in one transaction. Losing the race to
      // another `soot resume` is the same refusal as a live run.
      const canceller = new TaskCanceller(log, store, runId);
      const begun = store.beginSession(runId, {
        kind: 'resume',
        repoRoot,
        fingerprint: this.#fingerprint(cfg, agent, registry),
        agent,
        changes,
        ttlMs: this.#lockTtl(),
      });
      if (!begun.ok) {
        return fail(
          `run ${runId} is live in another soot process (${begun.lock.reason}); not resumed.`,
          { runId, refused: 'live' },
        );
      }
      let control: RunControl;
      try {
        control = holdRun(this.#o.dataDir, runId, signal, 200, (id) => {
          canceller.cancel(id);
        });
      } catch (error) {
        store.finishSession(runId, begun.session, 'error');
        store.releaseRunLock(runId, begun.owner);
        return fail((error as Error).message, { runId, refused: 'live' });
      }
      // Attempts the dead owner left `running` are closed as interrupted (stale task leases).
      const interrupted = new Set(store.recoverInterrupted(runId));
      const run = store.loadRun(runId);
      const verifications = store.verifications(runId);
      const decisions = planResume({
        run,
        verifications,
        cancelledByUser: new Set(store.taskCancellations(runId)),
        interrupted,
        retryBlocked: request.retryBlocked === true,
      });
      store.setSessionDecisions(runId, begun.session, decisions);
      for (const d of decisions) {
        log.info(`soot: resume ${runId}: ${d.taskId} ${d.action} (was ${d.previous}): ${d.reason}`);
      }
      const workflow = workflowResume(run, verifications, decisions, last?.baseCommit ?? null);
      const planning = store.planningCost(runId);
      mkdirSync(join(this.#o.dataDir, 'reports'), { recursive: true, mode: 0o700 });
      handedOff = true;
      return await this.#execute({
        runId,
        repoRoot,
        graph: buildTaskGraph(run.tasks, run.graphRevision),
        cfg,
        registry,
        runner,
        sandbox,
        agent,
        agentLabel,
        acp,
        prompt,
        planningLine: planningFromStore(planning),
        meta: meta ?? {
          fixtureId: null,
          planLabel: 'plan restored from soot.sqlite',
          decomposition: saved?.decomposition ?? null,
          planningText: null,
        },
        store,
        control,
        canceller,
        session: begun.session,
        owner: begun.owner,
        resume: {
          workflow,
          decisions,
          changes,
          interrupted,
          reclaimedLock: begun.reclaimed,
        },
        earlierDecisions: saved?.decisions ?? [],
        hooks,
      });
    } finally {
      if (!handedOff) store.close();
    }
  }

  /**
   * Why a provider may not be called now (a cooldown recorded in soot.sqlite by an earlier task
   * attempt or planner call), or `null` when it may (ADR-046).
   */
  #cooldownOf(provider: string): string | null {
    const store = this.#store();
    try {
      const status = new ProviderHealth({ store }).status(provider);
      if (status.available || status.until === null) return null;
      return `provider "${provider}" is in cooldown until ${new Date(status.until).toISOString()} (${String(status.reason)}${status.detail === null ? '' : `: ${status.detail}`}), recorded by an earlier call`;
    } finally {
      store.close();
    }
  }

  /**
   * Record a cooldown for the planner's provider when its call failed the way a task attempt's
   * would (outage, rate limit, auth, timeout). Returns what was recorded, or `null`.
   */
  #recordPlannerFailure(
    provider: string,
    error: ModelDecompositionError,
  ): { provider: string; reason: UnavailableReason; until: number | null } | null {
    const kind = error.providerError?.kind;
    const reason: UnavailableReason | undefined =
      kind === undefined ? undefined : PLANNER_COOLDOWN_REASON[kind];
    if (reason === undefined || error.reason !== 'model-call-failed') return null;
    const store = this.#store();
    try {
      const health = new ProviderHealth({ store });
      const retryAfter = error.providerError?.retryAfterMs ?? null;
      health.markUnavailable(provider, reason, {
        detail: `planner call: ${error.message}`.slice(0, 500),
        ...(retryAfter === null ? {} : { cooldownMs: retryAfter }),
      });
      const until = health.status(provider).until;
      return { provider, reason, until: until !== null && Number.isFinite(until) ? until : null };
    } finally {
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
    decomposition?: JsonValue;
    agent?: string;
    agentLabel?: string;
    sandbox?: JsonValue;
  } | null {
    const path = this.#reportPath(runId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as {
      report: ConsolidatedReport;
      decisions: string[];
      decomposition?: JsonValue;
      agent?: string;
      agentLabel?: string;
      sandbox?: JsonValue;
    };
  }

  /** A live soot process holds the run (run lock in soot.sqlite, or the control lock file). */
  #isLive(store: ExecutionStore, runId: string): boolean {
    return (
      runningInfo(this.#o.dataDir, runId) !== null ||
      this.#liveCheck()(store, runId).state === 'live'
    );
  }

  /**
   * A run nobody holds: its last session's status, or the saved report's for runs from before
   * schema v7; `interrupted` when the last session never finished (the process died).
   */
  #settledState(store: ExecutionStore, runId: string, reportStatus: string | null): string {
    const last = store.sessions(runId).at(-1);
    if (last === undefined) return reportStatus ?? 'interrupted';
    return last.status ?? 'interrupted';
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
          const state = this.#isLive(store, id)
            ? 'running'
            : this.#settledState(store, id, saved?.report.status ?? null);
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
      const running = this.#isLive(store, runId);
      const sessions = sessionSummaries(store, runId, this.#liveCheck());
      const tasks = run.tasks.map((t) => {
        const attempts = run.attempts.filter((a) => a.taskId === t.id && a.attempt > 0);
        const last = latestAttempt(run.attempts, t.id);
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
            // Run session that ran this attempt (ADR-054); null before schema v7.
            session: a.session,
          })),
        };
      });
      const state = running
        ? 'running'
        : this.#settledState(store, runId, saved?.report.status ?? null);
      const resumable = !running && state !== 'complete';
      const text = [
        `Run ${runId}: ${state}`,
        `Prompt: ${run.originalPrompt}`,
        `Sandbox: ${savedSandboxLine(saved?.sandbox)}`,
        ...tasks.map(
          (t) =>
            `- ${t.taskId} [${t.complexity}] ${t.state}, ${String(t.attempts)} attempt(s)${t.models.length > 0 ? ` (${t.models.map((m) => m ?? 'no model').join(' → ')})` : ''}${t.verdict === null ? '' : `, verdict ${t.verdict}${t.complete ? ' (complete)' : ''}`}`,
        ),
        ...(sessions.length > 0 ? ['Sessions:', ...sessions.map(sessionLine)] : []),
        ...(resumable ? [`Resume with: soot resume ${runId}`] : []),
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
          resumable,
          prompt: run.originalPrompt,
          createdAt: run.createdAt,
          // Every session (the first run, then each resume), oldest first (ADR-054).
          sessions,
          tasks,
          events: this.#events(runId),
          reportStatus: saved?.report.status ?? null,
          // How the prompt was planned (saved report), with the planning call's tokens and
          // cost for model decompositions (ADR-037); null until the run has a report.
          decomposition: saved?.decomposition ?? null,
          // The runner that ran every task (saved report); null until the run has a report.
          agent: saved?.agent ?? null,
          agentLabel: saved?.agentLabel ?? null,
          // The run's sandbox (ADR-051); null for runs saved before it was recorded (unknown).
          sandbox: saved?.sandbox ?? null,
          // Every soot-run command with the backend it ran under (soot.sqlite, ADR-051).
          commands: store.commandRuns(runId).map((c) => ({
            taskId: c.taskId,
            attempt: c.attempt,
            stage: c.stage,
            name: c.name,
            status: c.status,
            exitCode: c.exitCode,
            sandbox: c.sandbox,
          })),
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
              // Absent in reports saved before ADR-051: shown as unknown.
              sandbox: c.sandbox ?? null,
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
        planningFromStore(store.planningCost(id)),
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

  async models(): Promise<CommandOutput> {
    await this.probeLocalModels(this.#o.cwd);
    return this.modelsReport();
  }

  /** `soot models`, synchronously (the dashboard's project setup reads it too). */
  modelsReport(): CommandOutput {
    let cfg: LoadedConfig;
    let registry: ModelRegistry;
    let priced: PricedRegistry;
    try {
      cfg = this.#configFor(this.#o.cwd);
      priced = loadPricedRegistry(
        cfg,
        this.#o.modelEnv ?? process.env,
        this.#o.priceDate,
        this.#probed,
      );
      registry = priced.registry;
    } catch (error) {
      return fail((error as Error).message);
    }
    const selection = registry.select({});
    const excluded = new Map(selection.excluded.map((e) => [e.ref, e.reasons]));
    const policy = resolvePolicy(cfg.config.policy);
    const rows = registry.models().map((m: ModelEntry) => {
      return {
        ref: m.ref,
        provider: m.provider,
        kind: registry.provider(m.provider)?.kind ?? null,
        eligible: !excluded.has(m.ref),
        excludedBecause: [...(excluded.get(m.ref) ?? [])],
        pricing:
          m.pricing === null
            ? null
            : {
                inputPerMTokUsd: m.pricing.inputPerMTokUsd,
                outputPerMTokUsd: m.pricing.outputPerMTokUsd,
                cacheReadPerMTokUsd: m.pricing.cacheReadPerMTokUsd,
                source: m.pricing.source,
                asOf: m.pricing.asOf,
              },
        // Where the price came from: your config, soot's price catalog (ADR-037), or nowhere.
        priceFrom:
          m.pricing === null
            ? null
            : priced.catalogPriced.includes(m.ref)
              ? ('catalog' as const)
              : ('config' as const),
        contextWindow: m.contextWindow,
        reliabilityPrior: json(m.reliability),
        // ADR-043: `auto` = added because its vendor key is set; tier = hardest work it gets
        // while its reliability is unmeasured.
        origin: m.origin,
        tier: m.tier,
      };
    });
    const usd = (v: number | null | undefined) =>
      v === null || v === undefined ? '?' : `$${String(v)}`;
    const autoFrom = (provider: string) => {
      const runtime = priced.local.find((l) => l.id === provider && l.status === 'added');
      if (runtime !== undefined) return ` (auto: local runtime at ${runtime.baseURL}, no key)`;
      return ` (auto from $${priced.auto.find((a) => a.id === provider)?.apiKeyEnv ?? '?'})`;
    };
    const text = [
      `Models from ${modelsSource(cfg)}${priced.autoRefs.length > priced.localRefs.length && cfg.modelsPath !== null ? ' plus your keys' : ''}${priced.localRefs.length > 0 ? ' plus local runtimes' : ''} (policy ${cfg.config.policy}; thresholds low ${String(policy.thresholds.low)} / medium ${String(policy.thresholds.medium)} / high ${String(policy.thresholds.high)})`,
      ...rows.map(
        (r) =>
          `- ${r.ref} (${r.kind ?? '?'}) ${r.eligible ? 'eligible' : `excluded: ${r.excludedBecause.join(', ')}`}; price in/out per MTok ${r.pricing === null ? 'price not set' : `${usd(r.pricing.inputPerMTokUsd)}/${usd(r.pricing.outputPerMTokUsd)} (${r.priceFrom === 'catalog' ? 'soot catalog' : 'your config'}, ${r.pricing.asOf})`}; context ${r.contextWindow === null ? 'unknown' : String(r.contextWindow)}${r.tier === null ? '' : `; tier ${r.tier}`}${r.origin === 'auto' ? autoFrom(r.provider) : ''}`,
      ),
      ...(priced.autoRefs.length > 0
        ? [
            'Auto models: tiers come from list output price (low under $2.5/MTok, high from $15/MTok). While a model has no reliability data, it gets work up to its tier, cheapest first; measured history then takes over. Configure a vendor in your models file to override.',
          ]
        : []),
      `Local runtimes${priced.localSettings.enabled ? '' : ` (off: ${priced.localSettings.offReason})`}:`,
      ...describeLocalPool(priced.local),
      "Reliability comes from your config. Prices come from your config, else from soot's sourced price catalog for the vendor's own API.",
      ...(unpricedWarning(priced.unpriced) === null
        ? []
        : [unpricedWarning(priced.unpriced) ?? '']),
    ].join('\n');
    return {
      ok: true,
      text,
      data: json({
        modelsFile: cfg.modelsPath,
        policy: cfg.config.policy,
        models: rows,
        autoModels: { enabled: cfg.config.autoModels, providers: [...priced.auto] },
        localModels: { enabled: priced.localSettings.enabled, runtimes: [...priced.local] },
        unpricedModels: [...priced.unpriced],
      }) as Record<string, JsonValue>,
    };
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

  /**
   * Resolved configuration, for `soot config`. Key values are never printed, only variable
   * names; whether the decomposer model is usable is checked by building (not calling) its client.
   */
  config(repo = '.'): CommandOutput {
    const repoRoot = resolve(this.#o.cwd, repo);
    let cfg: LoadedConfig;
    let registry: ModelRegistry;
    let priced: PricedRegistry;
    try {
      cfg = this.#configFor(repoRoot);
      priced = loadPricedRegistry(
        cfg,
        this.#o.modelEnv ?? process.env,
        this.#o.priceDate,
        this.#probed,
      );
      registry = priced.registry;
    } catch (error) {
      return fail((error as Error).message, { dataDir: this.#o.dataDir });
    }
    const providers = registry.providers().map((p) => ({
      id: p.id,
      kind: p.kind,
      apiKeyEnv: p.apiKeyEnv ?? null,
      local: p.local,
    }));
    const decomposer = this.#decomposerModel(cfg, registry);
    const optInHints = unusedOptInKeyHints(registry.providers(), this.#o.modelEnv ?? process.env);
    const sandbox = this.#sandbox(cfg);
    const data = {
      configFile: cfg.path,
      dataDir: this.#o.dataDir,
      modelsFile: cfg.modelsPath,
      fixturesFile: cfg.fixturesPath,
      policy: cfg.config.policy,
      concurrency: cfg.config.concurrency,
      attemptTimeoutMs: cfg.config.attemptTimeoutMs ?? null,
      effectiveAttemptTimeoutMs: cfg.config.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      modelCallTimeoutMs: cfg.config.modelCallTimeoutMs ?? null,
      effectiveModelCallTimeoutMs: cfg.config.modelCallTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS,
      retryCheckOutputBytes: cfg.config.retryCheckOutputBytes,
      retryDiffBytes: cfg.config.retryDiffBytes,
      agent: this.#o.agent.kind,
      apiEditFormat: cfg.config.apiEditFormat,
      acpAgent: cfg.config.acpAgent === undefined ? null : json(cfg.config.acpAgent),
      harness: this.#o.agent.kind === 'acp' ? (this.#o.agent.harness ?? null) : null,
      harnesses: json(
        Object.fromEntries(
          Object.entries(cfg.config.harnesses ?? {}).map(([id, h]) => [
            id,
            h === undefined ? null : describeCommand(h),
          ]),
        ),
      ),
      decomposer: {
        model: decomposer.status === 'not-configured' ? null : decomposer.ref,
        status: decomposer.status,
        reason: decomposer.status === 'unusable' ? decomposer.reason : null,
      },
      approvals: this.#o.approvals.mode,
      checks: json(cfg.checks),
      acceptance: json(cfg.acceptance),
      protectedPaths: this.#protectedPaths(repoRoot, cfg),
      allowedExecutables: [...cfg.policy.allowedExecutables],
      sandbox: json(describeSandbox(sandbox)),
      providers: json(providers),
      models: registry.models().length,
      autoModels: { enabled: cfg.config.autoModels, providers: [...priced.auto] },
      localModels: { enabled: priced.localSettings.enabled, runtimes: [...priced.local] },
      pricing: {
        catalogPriced: [...priced.catalogPriced],
        unpriced: [...priced.unpriced],
      },
      unusedOptInKeys: optInHints,
    };
    const pricingNote = unpricedWarning(priced.unpriced);
    const text = [
      `Config: ${cfg.path}`,
      `State dir: ${this.#o.dataDir}`,
      `Models: ${modelsSource(cfg)} (${String(data.models)} models${priced.autoRefs.length > priced.localRefs.length ? `, ${String(priced.autoRefs.length - priced.localRefs.length)} auto-added from your keys` : ''}${priced.localRefs.length > 0 ? `, ${String(priced.localRefs.length)} from local runtimes` : ''})`,
      `Auto models${cfg.config.autoModels ? '' : ' (off: "autoModels": false)'} (key variables checked for presence only; values are never printed):`,
      ...describeAutoPool(priced.auto),
      `Local runtimes${priced.localSettings.enabled ? ' (keyless; probed with a short limit)' : ` (off: ${priced.localSettings.offReason})`}:`,
      ...describeLocalPool(priced.local),
      `Prices: ${String(registry.models().filter((m) => m.pricing !== null).length)} of ${String(data.models)} priced${priced.catalogPriced.length > 0 ? ` (${String(priced.catalogPriced.length)} from soot's price catalog)` : ''}${pricingNote === null ? '' : `. ${pricingNote}`}`,
      `Policy: ${cfg.config.policy}; concurrency ${String(cfg.config.concurrency)}`,
      `Attempt timeout: ${String(data.effectiveAttemptTimeoutMs)} ms${cfg.config.attemptTimeoutMs === undefined ? ' (default; set "attemptTimeoutMs" to change)' : ''}`,
      `Model call limit: ${formatLimit(data.effectiveModelCallTimeoutMs)} per --agent api try and per planner call${cfg.config.modelCallTimeoutMs === undefined ? ' (default; set "modelCallTimeoutMs" to change)' : ''}`,
      `Retry context: ${data.retryCheckOutputBytes === 0 ? 'off (a retry is told which check failed, not its output)' : `last ${String(data.retryCheckOutputBytes)} bytes of a failing check's output go to the retry (ANSI stripped, keys redacted; set "retryCheckOutputBytes", 0 = off)`}`,
      `Retry diff: ${data.retryDiffBytes === 0 ? 'off (a retry starts from the base without seeing the rejected change)' : `first ${String(data.retryDiffBytes)} bytes of the rejected attempt's diff go to the next attempt (keys redacted; set "retryDiffBytes", 0 = off)`}`,
      `Agent: ${this.#o.agent.kind === 'none' ? 'none (run refuses: pick --agent api, --agent mock, --agent acp, --agent claude-code or --agent codex)' : this.#agentLabel(cfg)}`,
      `API edit format: ${cfg.config.apiEditFormat}${cfg.config.apiEditFormat === 'auto' ? ' (targeted "replace" edits or whole files; set "apiEditFormat": "whole" for whole files only)' : ' (whole-file replies only, ADR-039)'}`,
      `ACP agent command: ${cfg.config.acpAgent === undefined ? 'not configured' : describeCommand(cfg.config.acpAgent)}`,
      `Harness runners (simulated-only, ADR-047): claude-code ${cfg.config.harnesses?.['claude-code'] === undefined ? 'not configured' : describeCommand(cfg.config.harnesses['claude-code'])}; codex ${cfg.config.harnesses?.codex === undefined ? 'not configured' : describeCommand(cfg.config.harnesses.codex)}`,
      `Decomposition: ${describeDecomposerModel(decomposer)}`,
      `Approvals: ${this.#o.approvals.mode} (soot never approves on your behalf)`,
      'Checks:',
      ...cfg.checks.map((c) => `- ${c.name} [${c.kind}]: ${c.argv.join(' ')}`),
      'Acceptance:',
      ...Object.entries(cfg.acceptance).map(
        ([id, list]) => `- ${id}: ${list.map((c) => c.name).join(', ')}`,
      ),
      `Protected paths: ${data.protectedPaths.join(', ') || 'none'}`,
      `Allowed executables: ${data.allowedExecutables.join(', ') || 'none'}`,
      `Sandbox (mode ${sandbox.settings.mode}${sandbox.settings.required ? ', required' : ''}): ${sandboxLine(sandbox)}`,
      ...(sandbox.settings.readPaths.length > 0
        ? [`  extra read paths: ${sandbox.settings.readPaths.join(', ')}`]
        : []),
      ...(sandbox.settings.writePaths.length > 0
        ? [`  extra write paths: ${sandbox.settings.writePaths.join(', ')}`]
        : []),
      'Providers (key variable names only; values are never read here):',
      ...providers.map(
        (p) =>
          `- ${p.id} (${p.kind})${p.apiKeyEnv === null ? '' : ` key: $${p.apiKeyEnv}`}${p.local ? ' local' : ''}`,
      ),
      ...optInHints,
    ].join('\n');
    return { ok: true, text, data: json(data) as Record<string, JsonValue> };
  }
}

/** Cost fields put on a saved model decomposition (ADR-037). Fixtures cost nothing and get none. */
interface PlanningCost {
  /** USD from reported usage × list price; `null` when unpriced or usage was not reported. */
  readonly costUsd?: number | null;
  /** Which list price was used: `{ ref, source, asOf }`, or `null` when the model has no price. */
  readonly priceBasis?: {
    readonly ref: string;
    readonly source: string;
    readonly asOf: string;
  } | null;
}

/** Price the planning (decomposition) call from its reported usage and the model's list price. */
export function planningCost(registry: ModelRegistry, source: DecompositionSource): PlanningCost {
  if (source.kind !== 'model') return {};
  const model = registry.get(source.modelRef);
  if (model === undefined) return { costUsd: null, priceBasis: null };
  const { costUsd, basis } = actualCostFromUsage(model, {
    inputTokens: source.usage.inputTokens,
    outputTokens: source.usage.outputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  return { costUsd: costUsd === null ? null : Number(costUsd), priceBasis: basis };
}

/** Provider error kinds that put the planner's provider in cooldown, as for task attempts. */
const PLANNER_COOLDOWN_REASON: Readonly<Record<string, UnavailableReason>> = {
  unavailable: 'outage',
  'rate-limited': 'rate-limited',
  timeout: 'timeout',
  auth: 'auth',
};

/** The cost report's planning line for a model plan; `null` for a fixture plan (ADR-046). */
export function planningCostInput(
  source: DecompositionSource,
  cost: PlanningCost,
): PlanningCostInput | null {
  if (source.kind !== 'model') return null;
  return {
    model: source.modelRef,
    inputTokens: source.usage.inputTokens,
    outputTokens: source.usage.outputTokens,
    costUsd: cost.costUsd ?? null,
    priced: cost.priceBasis !== null && cost.priceBasis !== undefined,
  };
}

function planningFromStore(
  p: {
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    usd: number | null;
    priced: boolean;
  } | null,
): PlanningCostInput | null {
  return p === null
    ? null
    : {
        model: p.model,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        costUsd: p.usd,
        priced: p.priced,
      };
}

function describePlanningCost(source: ModelDecompositionSource, cost: PlanningCost): string {
  const tokens = (n: number | null) => (n === null ? 'not reported' : String(n));
  const usd =
    cost.costUsd === null || cost.costUsd === undefined
      ? cost.priceBasis === null || cost.priceBasis === undefined
        ? 'price not set'
        : 'cost unknown (usage not reported)'
      : `$${cost.costUsd.toFixed(6)}`;
  return `${source.modelRef}, ${tokens(source.usage.inputTokens)} in / ${tokens(source.usage.outputTokens)} out, ${usd}`;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

/** The preview from routing decisions and the escalation limits (pure; tested). */
export function buildPlanPreview(
  plan: EnginePlan,
  decisions: readonly RoutingDecision[],
  esc: EscalationConfig,
): PlanPreview {
  const tasks = plan.graph.tasks.map((task, i): PlanPreviewTask => {
    const d = decisions[i];
    const selected = d?.candidates.find((c) => c.ref === d.selected) ?? null;
    // Escalation and fallback only move to models the router would accept for this task.
    const acceptable = (d?.candidates ?? []).filter((c) => c.outcome !== 'excluded');
    const prices = acceptable.map((c) => num(c.estimate.costUsd));
    const known = prices.filter((p): p is number => p !== null);
    let worst: number | null =
      acceptable.length === 0 || known.length < prices.length
        ? null
        : Math.max(...known) * esc.maxAttemptsPerTask;
    if (worst !== null && esc.taskBudgetUsd !== null) worst = Math.min(worst, esc.taskBudgetUsd);
    return {
      taskId: task.id,
      title: task.title,
      complexity: task.complexity,
      dependsOn: [...task.dependsOn],
      model: d?.selected ?? null,
      estimateUsd: selected === null ? null : num(selected.estimate.costUsd),
      worstCaseUsd: worst,
      plannedInputTokens: task.estimate.inputTokens,
      plannedOutputTokens: task.estimate.outputTokens,
      reason: d?.reason ?? 'not routed',
    };
  });
  const sum = (vals: readonly (number | null)[]) =>
    vals.some((v) => v !== null) ? vals.reduce<number>((n, v) => n + (v ?? 0), 0) : null;
  const est = tasks.map((t) => t.estimateUsd);
  const worstVals = tasks.map((t) => t.worstCaseUsd);
  let worst = sum(worstVals);
  // The run budget covers planning too (ADR-046): tasks can spend only what planning left.
  const planningSpent = plan.source.kind === 'model' ? (num(plan.planning.costUsd) ?? 0) : 0;
  if (worst !== null && esc.runBudgetUsd !== null)
    worst = Math.min(worst, Math.max(0, esc.runBudgetUsd - planningSpent));
  const src = plan.source;
  const planner: PlanPreview['planner'] =
    src.kind === 'fixture'
      ? {
          kind: 'fixture',
          model: null,
          fixtureId: src.fixtureId,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          priced: null,
        }
      : {
          kind: 'model',
          model: src.modelRef,
          fixtureId: null,
          inputTokens: src.usage.inputTokens,
          outputTokens: src.usage.outputTokens,
          costUsd: num(plan.planning.costUsd),
          priced: plan.planning.priceBasis !== null && plan.planning.priceBasis !== undefined,
        };
  return {
    runId: plan.runId,
    planner,
    tasks,
    estimateUsd: sum(est),
    estimatePartial: est.some((v) => v === null),
    worstCaseUsd: worst,
    worstCasePartial: worstVals.some((v) => v === null),
    worstCaseBasis: `up to ${String(esc.maxAttemptsPerTask)} attempts per task on the priciest model the router accepts${esc.taskBudgetUsd === null ? '' : `, capped at $${String(esc.taskBudgetUsd)} per task`}${esc.runBudgetUsd === null ? '' : `, $${String(esc.runBudgetUsd)} per run including planning`}`,
    policy: plan.cfg.config.policy,
    agentLabel: plan.agentLabel,
  };
}

/** Plan metadata stored with session 1, so a resumed run's report says how it was planned. */
interface SessionMeta {
  readonly fixtureId: string | null;
  readonly planLabel: string;
  readonly decomposition: JsonValue;
  /** "model, tokens, cost" line for model plans; `null` for fixtures. */
  readonly planningText: string | null;
}

type ResumeDecisionRecord = TaskResumeDecision;

interface ExecContext {
  readonly runId: string;
  readonly repoRoot: string;
  readonly graph: TaskGraph;
  readonly cfg: LoadedConfig;
  readonly registry: ModelRegistry;
  readonly runner: AgentRunner;
  /** Process sandbox for checks and the ACP agent (ADR-051), resolved for this session. */
  readonly sandbox: Sandbox;
  readonly agent: AgentMode;
  readonly agentLabel: string;
  readonly acp: PlanAcpState;
  readonly prompt: string;
  readonly planningLine: PlanningCostInput | null;
  readonly meta: SessionMeta;
  readonly store: ExecutionStore;
  readonly control: RunControl;
  readonly canceller: TaskCanceller;
  readonly session: number;
  readonly owner: string;
  readonly resume: {
    readonly workflow: WorkflowResume;
    readonly decisions: readonly TaskResumeDecision[];
    readonly changes: readonly ConfigChange[];
    readonly interrupted: ReadonlySet<string>;
    readonly reclaimedLock: Extract<LockState, { state: 'stale' }> | null;
  } | null;
  /** Supervisor decision lines from earlier sessions (kept in the saved report). */
  readonly earlierDecisions: readonly string[];
  readonly hooks: { readonly onRunStarted?: (runId: string) => void };
}

/**
 * `soot stop <run> --task <id>` requests: queued until the scheduler exists, and recorded in
 * soot.sqlite so a later resume keeps the task cancelled (ADR-054).
 */
class TaskCanceller {
  readonly #log: Logger;
  readonly #store: ExecutionStore;
  readonly #runId: string;
  #scheduler: Scheduler | null = null;
  readonly #pending: string[] = [];

  constructor(log: Logger, store: ExecutionStore, runId: string) {
    this.#log = log;
    this.#store = store;
    this.#runId = runId;
  }

  attach(scheduler: Scheduler): void {
    this.#scheduler = scheduler;
    for (const id of this.#pending.splice(0)) this.cancel(id);
  }

  cancel(taskId: string): void {
    if (this.#scheduler === null) {
      this.#pending.push(taskId);
      return;
    }
    try {
      this.#scheduler.cancel(taskId);
      this.#store.recordTaskCancellation(this.#runId, taskId);
      this.#log.info(`soot: ${taskId} cancelled by request`);
    } catch (error) {
      this.#log.warn(`soot: cannot cancel ${taskId}: ${(error as Error).message}`);
    }
  }
}

/** A verdict as stored in soot.sqlite: check output tails (untrusted text) are left out. */
function persistVerification(v: TaskVerification): PersistedVerification {
  return {
    taskId: v.taskId,
    attempt: v.attempt,
    model: v.model,
    verdict: v.verdict,
    reason: v.reason,
    branch: v.branch,
    base: v.base,
    commit: v.commit,
    files: v.files.map((f) => ({ path: f.path, status: f.status })),
    checks: v.checks.map((c) => ({
      name: c.name,
      kind: c.kind,
      argv: [...c.argv],
      status: c.status,
      required: c.required,
      exitCode: c.exitCode,
      durationMs: c.durationMs,
      reason: c.reason,
      commit: c.commit,
    })),
  };
}

/** A stored verdict back as the task runner's own record (no worktree: it was removed). */
function restoredVerification(v: PersistedVerification): TaskVerification {
  return {
    taskId: v.taskId,
    attempt: v.attempt,
    model: v.model,
    verdict: v.verdict as Verdict,
    reason: `${v.reason} (verified in an earlier session)`,
    worktree: null,
    branch: v.branch,
    base: v.base,
    commit: v.commit,
    files: v.files.map((f) => ({ path: f.path, status: f.status as 'added' })),
    outOfScope: [],
    checks: v.checks.map((c) => ({ ...c, outputTail: '' }) as unknown as CheckEvidence),
    claims: { status: 'succeeded', evidence: [], patchFiles: [] },
  };
}

/** The workflow's resume input from the per-task decisions. */
function workflowResume(
  run: PersistedRun,
  verifications: readonly PersistedVerification[],
  decisions: readonly TaskResumeDecision[],
  baseCommit: string | null,
): WorkflowResume {
  const completed = new Map<string, NonNullable<ReturnType<PersistedRun['completed']['get']>>>();
  const kept = new Map<string, TaskVerification>();
  const restored = new Map<string, RestoredOutcome>();
  const rerun = new Set<string>();
  const records = new Map(run.attemptRecords);
  for (const d of decisions) {
    const last = latestAttempt(run.attempts, d.taskId);
    if (d.action === 'keep') {
      const result = run.completed.get(d.taskId);
      const v = verifications.find((x) => x.taskId === d.taskId && x.attempt === last?.attempt);
      if (result !== undefined && v !== undefined) {
        completed.set(d.taskId, result);
        kept.set(d.taskId, restoredVerification(v));
        continue;
      }
      rerun.add(d.taskId);
    } else if (d.action === 'hold') {
      restored.set(d.taskId, {
        state: d.hold === 'cancelled-by-user' ? 'cancelled' : 'failed',
        attempt: d.attempt,
        result: last?.result ?? null,
        error: `held on resume (${d.hold ?? 'held'}): ${last?.error ?? d.reason}`,
      });
    } else {
      rerun.add(d.taskId);
      // A task that runs again after its decisions had ended (a final "fail" review, then
      // --retry-blocked, possibly followed by another crash) starts its decisions afresh: the
      // supervisor would otherwise replay that "fail" as "stop" without asking anything.
      // Attempt numbers and the spend ledger still continue, so budgets keep counting every
      // earlier attempt. A history that ended in "retry" is kept (retry and escalation
      // limits continue across the crash).
      const reviewed = records.get(d.taskId);
      if (reviewed !== undefined && reviewed.at(-1)?.review?.action !== 'retry') {
        records.delete(d.taskId);
      }
    }
  }
  return {
    baseCommit,
    completed,
    verifications: kept,
    restored,
    rerun,
    previousAttempts: run.attemptCounts,
    previousAttemptRecords: records,
  };
}

/** One row per session for status and reports (`crashed`: unfinished and no live owner). */
export interface SessionSummary {
  readonly session: number;
  readonly kind: string;
  readonly state: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly pid: number;
  readonly baseCommit: string | null;
  readonly kept: number;
  readonly rerun: number;
  readonly held: number;
  readonly configChanges: readonly string[];
}

function sessionSummaries(
  store: ExecutionStore,
  runId: string,
  live: (store: ExecutionStore, runId: string) => LockState,
): SessionSummary[] {
  const sessions = store.sessions(runId);
  const lock = live(store, runId);
  return sessions.map((s) => {
    const decided = s.decisions.filter(
      (d): d is TaskResumeDecision => typeof d === 'object' && d !== null && 'action' in d,
    );
    const owned = lock.state === 'live' && lock.holder.session === s.session;
    return {
      session: s.session,
      kind: s.kind,
      state: s.status ?? (owned ? 'running' : 'crashed'),
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      pid: s.pid,
      baseCommit: s.baseCommit,
      kept: decided.filter((d) => d.action === 'keep').length,
      rerun: decided.filter((d) => d.action === 'rerun').length,
      held: decided.filter((d) => d.action === 'hold').length,
      configChanges: s.changes.map((c) => c.part),
    };
  });
}

function sessionLine(s: SessionSummary): string {
  return `- #${String(s.session)} ${s.kind} ${s.state} ${s.startedAt}${s.kind === 'resume' ? ` (kept ${String(s.kept)}, re-ran ${String(s.rerun)}, held ${String(s.held)}${s.configChanges.length === 0 ? '' : `; config changed: ${s.configChanges.join(', ')}`})` : ''}`;
}

function describeChange(c: ConfigChange): string {
  const short = (v: string | null) =>
    v === null ? 'none' : /^[0-9a-f]{64}$/.test(v) ? v.slice(0, 12) : v;
  if (c.before === null && c.part === 'fingerprint') return c.after ?? 'not recorded';
  return `${c.part}: ${short(c.before)} → ${short(c.after)}`;
}
