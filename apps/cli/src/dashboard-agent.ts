import type { Logger } from '@soot/core';
import { unattendedApprovals, withApply } from './approvals.js';
import { CONFIG_FILE } from './config.js';
import { projectId, readAllowlist, resolveProject } from './dashboard-allowlist.js';
import { SootEngine, type AgentMode } from './engine.js';

/*
 * The composer's agent for `soot dashboard --agent api|mock|acp` (ADR-038, ADR-039): plans and runs prompts
 * in allowlisted folders with the same engine as `soot run`, inside the dashboard process.
 *
 * - Folders come only from `<dataDir>/dashboard.json` (written by `soot dashboard allow`); the
 *   browser sends an opaque id, resolved here.
 * - The runner is fixed when the dashboard starts. Approvals inside a run are unattended in v1:
 *   approval-needing actions are refused, never granted, except that `--apply` (chosen when the
 *   dashboard starts) lands a fully verified result on the folder's branch.
 * - Keys: only variable names and set / missing leave this module. Values are read by the
 *   provider adapters inside the engine, never here.
 *
 * The shapes below match the dashboard's `DashboardAgent` structurally; this file does not import
 * the optional dashboard package (ADR-031), and the CLI's typecheck checks the match.
 */

type Json = Readonly<Record<string, unknown>>;

interface PlannerInfo {
  readonly model: string | null;
  readonly status: 'usable' | 'unusable' | 'not-configured';
  readonly reason: string | null;
  readonly roughCostUsd: number | null;
}

export interface ComposerAgentOptions {
  readonly dataDir: string;
  readonly agent: Exclude<AgentMode, { kind: 'none' }>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: Logger;
  /** `--apply`: land a fully verified result on the folder's checked-out branch (ADR-039). */
  readonly apply?: boolean;
}

/** Assumed tokens for one planning call, for the rough cost on the submit button only. */
const ROUGH_PLAN_TOKENS = { input: 2000, output: 600 } as const;

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const harnessLabel = (id: string, command: unknown): string =>
  typeof command === 'string'
    ? `${id} (${command}; simulated-only runner)`
    : `${id}: no "harnesses.${id}" in ${CONFIG_FILE}`;

function planErrorCode(data: Record<string, unknown>): string {
  if (data.decomposerModelStatus === 'unusable') return 'decomposer_unusable';
  if (data.decompositionFailure === 'run-budget') return 'planning_over_budget';
  if (data.decompositionFailure !== undefined) return 'invalid_decomposition';
  if (data.promptSha256 !== undefined) return 'no_fixture';
  return 'planning_failed';
}

export function createComposerAgent(o: ComposerAgentOptions) {
  const landing = o.apply === true ? '; lands verified results (--apply)' : '';
  const runner =
    o.agent.kind === 'mock'
      ? { kind: 'mock' as const, label: `mock (test double)${landing}`, lands: o.apply === true }
      : o.agent.kind === 'api'
        ? {
            kind: 'api' as const,
            label: `api (routed models, called directly)${landing}`,
            lands: o.apply === true,
          }
        : {
            kind: 'acp' as const,
            label:
              o.agent.harness === undefined
                ? `acp (agent command from each project config)${landing}`
                : `${o.agent.harness} (harnesses.${o.agent.harness} adapter from each project config; tested against simulated adapters only)${landing}`,
            lands: o.apply === true,
          };

  const engineFor = (path: string) =>
    new SootEngine({
      cwd: path,
      dataDir: o.dataDir,
      agent: o.agent,
      approvals: o.apply === true ? withApply(unattendedApprovals()) : unattendedApprovals(),
      gitEnv: { ...o.env },
      agentEnv: { ...o.env },
      modelEnv: { ...o.env },
      ...(o.log === undefined ? {} : { log: o.log }),
    });

  const describe = (path: string) => {
    const engine = engineFor(path);
    const cfg = engine.config('.');
    const models = cfg.ok ? engine.modelsReport() : null;
    return { cfg, models };
  };

  const plannerOf = (
    cfgData: Record<string, unknown>,
    modelsData: Record<string, unknown> | null,
  ): PlannerInfo => {
    const d = asRecord(cfgData.decomposer);
    const model = typeof d.model === 'string' ? d.model : null;
    const status = d.status === 'usable' || d.status === 'unusable' ? d.status : 'not-configured';
    let rough: number | null = null;
    const rows = Array.isArray(modelsData?.models) ? (modelsData.models as unknown[]) : [];
    const row = asRecord(rows.map(asRecord).find((r) => r.ref === model));
    const pricing = asRecord(row.pricing);
    if (
      typeof pricing.inputPerMTokUsd === 'number' &&
      typeof pricing.outputPerMTokUsd === 'number'
    ) {
      rough =
        (ROUGH_PLAN_TOKENS.input * pricing.inputPerMTokUsd +
          ROUGH_PLAN_TOKENS.output * pricing.outputPerMTokUsd) /
        1e6;
    }
    return {
      model,
      status,
      reason: typeof d.reason === 'string' ? d.reason : null,
      roughCostUsd: rough,
    };
  };

  const projects = () =>
    readAllowlist(o.dataDir).map((p) => {
      const { cfg, models } = describe(p.path);
      const data = cfg.data as Record<string, unknown>;
      const checks = Array.isArray(data.checks)
        ? (data.checks as unknown[]).map((c) => String(asRecord(c).name))
        : [];
      const acp = asRecord(data.acpAgent);
      return {
        id: projectId(p.path),
        label: p.label,
        path: p.path,
        config: {
          ok: cfg.ok,
          policy: cfg.ok ? String(data.policy) : null,
          checks,
          error: cfg.ok ? null : cfg.text,
        },
        planner: cfg.ok
          ? plannerOf(data, models?.data ?? null)
          : { model: null, status: 'not-configured' as const, reason: null, roughCostUsd: null },
        runnerLabel:
          o.agent.kind !== 'acp'
            ? runner.label
            : o.agent.harness !== undefined
              ? harnessLabel(o.agent.harness, asRecord(data.harnesses)[o.agent.harness])
              : typeof acp.command === 'string'
                ? `acp (${acp.command})`
                : `acp: no "acpAgent" in ${CONFIG_FILE}`,
      };
    });

  return {
    runner,
    projects,
    keyStatus(id: string) {
      const p = resolveProject(o.dataDir, id);
      if (p === null) return null;
      const { cfg, models } = describe(p.path);
      const data = cfg.data as Record<string, unknown>;
      const rows = (
        Array.isArray(models?.data.models) ? (models.data.models as unknown[]) : []
      ).map(asRecord);
      const providers = (Array.isArray(data.providers) ? (data.providers as unknown[]) : []).map(
        (raw) => {
          const pr = asRecord(raw);
          const keyVar = typeof pr.apiKeyEnv === 'string' ? pr.apiKeyEnv : null;
          // Presence only: the value is not kept, compared, or returned.
          const present = keyVar !== null && (o.env[keyVar] ?? '').trim() !== '';
          return {
            id: String(pr.id),
            keyVar,
            key:
              pr.local === true || keyVar === null
                ? ('none-needed' as const)
                : present
                  ? ('set' as const)
                  : ('missing' as const),
            usedBy: rows.filter((r) => r.provider === pr.id).map((r) => String(r.ref)),
          };
        },
      );
      const pricing = asRecord(data.pricing);
      return {
        project: { id, label: p.label },
        modelsFile: typeof data.modelsFile === 'string' ? data.modelsFile : null,
        models: typeof data.models === 'number' ? data.models : 0,
        unpriced: Array.isArray(pricing.unpriced)
          ? (pricing.unpriced as unknown[]).map(String)
          : [],
        planner: cfg.ok
          ? plannerOf(data, models?.data ?? null)
          : {
              model: null,
              status: 'not-configured' as const,
              reason: cfg.text,
              roughCostUsd: null,
            },
        providers,
        runner,
      };
    },
    async plan(id: string, prompt: string, signal: AbortSignal) {
      const p = resolveProject(o.dataDir, id);
      if (p === null) {
        return {
          ok: false as const,
          code: 'unknown_project',
          message: 'That project is not in the allowlist.',
        };
      }
      const engine = engineFor(p.path);
      const planned = await engine.plan({ prompt, repo: p.path }, signal);
      if (!planned.ok) {
        return {
          ok: false as const,
          code: planErrorCode(planned.output.data),
          message: planned.output.text,
        };
      }
      const preview = JSON.parse(JSON.stringify(engine.previewPlan(planned.plan))) as Json;
      return {
        ok: true as const,
        preview,
        start: async (runSignal: AbortSignal, onRunStarted: (runId: string) => void) => {
          const out = await engine.runPlan(planned.plan, runSignal, { onRunStarted });
          const report = asRecord(out.data.report);
          return {
            ok: out.ok,
            status: typeof report.status === 'string' ? report.status : null,
            message: out.text.split('\n')[0] ?? '',
          };
        },
      };
    },
    async stop(runId: string, taskId?: string) {
      // Stop files live in the shared state dir, so any engine instance can write them.
      const out = await engineFor(o.dataDir).stop(runId, taskId);
      return { ok: out.ok, message: out.text };
    },
  };
}
