import {
  ModelConfigSchema,
  ProviderConfigSchema,
  type ModelConfig,
  type ProviderConfig,
  type RegistryConfig,
} from './config.js';
import { modelRef } from './registry.js';

/*
 * Keyless local models (ADR-045). Local runtimes such as Ollama and LM Studio serve an
 * OpenAI-compatible API on the user's machine and need no key. The caller probes their
 * `GET /v1/models` (network lives in the adapter layer); this module is pure and turns the
 * probe results into `openai-compatible`, `local: true` providers with no `apiKeyEnv`, each
 * model priced at $0 (source "local runtime") and tiered `low`, so light work goes to them
 * first and harder work still goes to stronger models.
 *
 * The user's models file always wins: a runtime whose provider id or base URL the file already
 * configures gets nothing added. `"autoModels": false` or `"localModels": false` turns this off.
 */

/** A local runtime soot can probe. */
export interface LocalRuntime {
  /** Provider id given to the runtime's models (`ollama`, `lmstudio`, `local-<host>-<port>`). */
  readonly id: string;
  /** OpenAI-compatible base URL, ending in `/v1`. */
  readonly baseURL: string;
  /** Human label for messages. */
  readonly label: string;
}

/** The runtimes soot probes by default, on their default ports. */
export const DEFAULT_LOCAL_RUNTIMES: readonly LocalRuntime[] = Object.freeze([
  Object.freeze({
    id: 'ollama',
    baseURL: 'http://127.0.0.1:11434/v1',
    label: 'Ollama (http://127.0.0.1:11434/v1)',
  }),
  Object.freeze({
    id: 'lmstudio',
    baseURL: 'http://127.0.0.1:1234/v1',
    label: 'LM Studio (http://127.0.0.1:1234/v1)',
  }),
]);

/** Short limit for one probe: a runtime on this machine answers in milliseconds or not at all. */
export const LOCAL_PROBE_TIMEOUT_MS = 500;

/**
 * Context window assumed for a local model (tokens). Ollama and LM Studio both load models with
 * a 4096-token context unless the user raises it, and the OpenAI-compatible listing does not
 * say, so soot assumes the default and routes only tasks that fit (ADR-039 requires a stated
 * window for local endpoints). Raise it with `"localModels": {"contextWindow": N}` after
 * raising the runtime's own setting.
 */
export const LOCAL_DEFAULT_CONTEXT_WINDOW = 4096;

/** At most this many models are taken from one runtime. */
export const MAX_LOCAL_MODELS_PER_RUNTIME = 32;

/** The pricing every local model gets: free, with its provenance. */
export const LOCAL_PRICE_SOURCE = 'local runtime';

/** What one probe found. Produced by `probeLocalRuntimes` in `@soot/provider-adapters`. */
export interface LocalRuntimeProbe {
  readonly runtime: LocalRuntime;
  /** `found`: the listing answered. `unreachable`: nothing answered in time. `error`: it answered badly. */
  readonly status: 'found' | 'unreachable' | 'error';
  /** Model ids from the listing (empty unless `found`). */
  readonly modelIds: readonly string[];
  /** Short reason for `unreachable` / `error`. Never contains a key (local runtimes have none). */
  readonly reason: string;
}

export interface LocalRuntimeReport {
  readonly id: string;
  readonly label: string;
  readonly baseURL: string;
  /**
   * `added`: models added. `not-running`: nothing answered. `no-models`: answered with no chat
   * models. `error`: answered badly. `configured`: the models file already covers it.
   * `off`: local probing is turned off. `not-probed`: this command did not probe.
   */
  readonly status:
    'added' | 'not-running' | 'no-models' | 'error' | 'configured' | 'off' | 'not-probed';
  readonly models: readonly string[];
  readonly reason: string;
}

export interface LocalPoolResult {
  readonly config: RegistryConfig;
  /** Refs added from local runtimes (`origin: 'auto'` in the registry). */
  readonly localRefs: readonly string[];
  readonly runtimes: readonly LocalRuntimeReport[];
}

/** Settings that decide whether and where to probe (from soot.config.json and the environment). */
export interface LocalProbeSettings {
  readonly enabled: boolean;
  /** Why probing is off, for messages. Empty when enabled. */
  readonly offReason: string;
  readonly runtimes: readonly LocalRuntime[];
  /** Context window given to every local model (tokens). */
  readonly contextWindow: number;
}

/** Base URL compared loosely: no trailing slash, `localhost` and `[::1]` read as 127.0.0.1. */
export function normalizeBaseURL(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '[::1]') u.hostname = '127.0.0.1';
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

/**
 * A runtime for a user-supplied URL. `/v1` is appended when the path is empty. Well-known
 * default ports keep their ids; others get `local-<host>-<port>`. Throws on a non-http(s) URL.
 */
export function localRuntimeFromUrl(raw: string): LocalRuntime {
  const u = new URL(raw.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`local model URL must be http(s): ${raw}`);
  }
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/v1';
  const baseURL = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  const known = DEFAULT_LOCAL_RUNTIMES.find(
    (r) => normalizeBaseURL(r.baseURL) === normalizeBaseURL(baseURL),
  );
  if (known !== undefined) return known;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
  const id = `local-${host}-${port}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
    .slice(0, 64);
  return { id, baseURL, label: `local runtime ${baseURL}` };
}

/**
 * Resolve the probe settings. Off when `autoModels` or `localModels` is false, or when
 * `SOOT_LOCAL_MODELS` is `off`/`0`/`false`. URLs: `SOOT_LOCAL_MODEL_URLS` (comma-separated),
 * else `"localModels": {"urls": [...]}`, else the defaults.
 */
export function localProbeSettings(input: {
  readonly autoModels: boolean;
  readonly localModels:
    | boolean
    | {
        readonly urls?: readonly string[] | undefined;
        readonly contextWindow?: number | undefined;
      };
  readonly env: Readonly<Record<string, string | undefined>>;
}): LocalProbeSettings {
  const contextWindow =
    typeof input.localModels === 'object'
      ? (input.localModels.contextWindow ?? LOCAL_DEFAULT_CONTEXT_WINDOW)
      : LOCAL_DEFAULT_CONTEXT_WINDOW;
  const off = (offReason: string): LocalProbeSettings => ({
    enabled: false,
    offReason,
    runtimes: DEFAULT_LOCAL_RUNTIMES,
    contextWindow,
  });
  if (!input.autoModels) return off('autoModels is false in soot.config.json');
  if (input.localModels === false) return off('localModels is false in soot.config.json');
  const flag = input.env.SOOT_LOCAL_MODELS?.trim().toLowerCase() ?? '';
  if (flag === 'off' || flag === '0' || flag === 'false' || flag === 'no') {
    return off('SOOT_LOCAL_MODELS is off');
  }
  const envUrls = (input.env.SOOT_LOCAL_MODEL_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const urls =
    envUrls.length > 0
      ? envUrls
      : typeof input.localModels === 'object' && input.localModels.urls !== undefined
        ? [...input.localModels.urls]
        : null;
  if (urls === null) {
    return { enabled: true, offReason: '', runtimes: DEFAULT_LOCAL_RUNTIMES, contextWindow };
  }
  const runtimes: LocalRuntime[] = [];
  for (const url of urls) {
    let runtime: LocalRuntime;
    try {
      runtime = localRuntimeFromUrl(url);
    } catch {
      throw new Error(
        `${envUrls.length > 0 ? 'SOOT_LOCAL_MODEL_URLS' : 'localModels.urls'}: not an http(s) URL: ${url}`,
      );
    }
    if (!runtimes.some((r) => r.id === runtime.id)) runtimes.push(runtime);
  }
  return { enabled: true, offReason: '', runtimes, contextWindow };
}

/** Listing entries that are not chat models (embedding models). */
const NOT_CHAT = /embed/i;

/**
 * Merge local runtime models into `base` (normally the models file plus the key-based pool).
 * `fileProviders` are the providers from the user's models file, which always win. Pure.
 */
export function addLocalModels(
  base: RegistryConfig,
  input: {
    readonly settings: LocalProbeSettings;
    /** `null` when this command did not probe. */
    readonly probes: readonly LocalRuntimeProbe[] | null;
    readonly fileProviders: readonly ProviderConfig[];
    /** Day (YYYY-MM-DD) for `asOf`. Default: today (UTC). */
    readonly today?: string;
  },
): LocalPoolResult {
  const day = input.today ?? new Date().toISOString().slice(0, 10);
  const providers = [...base.providers];
  const models = [...base.models];
  const localRefs: string[] = [];
  const runtimes: LocalRuntimeReport[] = [];
  for (const runtime of input.settings.runtimes) {
    const row = (status: LocalRuntimeReport['status'], reason: string, list: string[] = []) =>
      runtimes.push({
        id: runtime.id,
        label: runtime.label,
        baseURL: runtime.baseURL,
        status,
        models: list,
        reason,
      });
    if (!input.settings.enabled) {
      row('off', input.settings.offReason);
      continue;
    }
    const covered = input.fileProviders.find(
      (p) =>
        p.id === runtime.id ||
        (p.baseURL !== undefined &&
          normalizeBaseURL(p.baseURL) === normalizeBaseURL(runtime.baseURL)),
    );
    if (covered !== undefined) {
      row(
        'configured',
        `your models file configures provider "${covered.id}" for it; soot adds nothing`,
      );
      continue;
    }
    if (providers.some((p) => p.id === runtime.id)) {
      row('configured', `provider id "${runtime.id}" is already taken; soot adds nothing`);
      continue;
    }
    const probe = input.probes?.find((p) => p.runtime.id === runtime.id);
    if (probe === undefined) {
      row('not-probed', 'not probed by this command (soot models and soot run probe)');
      continue;
    }
    if (probe.status === 'unreachable') {
      row('not-running', `nothing answered at ${runtime.baseURL}`);
      continue;
    }
    if (probe.status === 'error') {
      row('error', probe.reason);
      continue;
    }
    const provider = ProviderConfigSchema.parse({
      id: runtime.id,
      kind: 'openai-compatible',
      baseURL: runtime.baseURL,
      local: true,
    });
    const added: ModelConfig[] = [];
    const seen = new Set<string>();
    for (const modelId of probe.modelIds) {
      if (added.length >= MAX_LOCAL_MODELS_PER_RUNTIME) break;
      if (NOT_CHAT.test(modelId) || seen.has(modelId)) continue;
      const parsed = ModelConfigSchema.safeParse({
        provider: runtime.id,
        modelId,
        // soot's API runner needs both. Most current local chat models offer tool calls and
        // JSON output through these runtimes; a model that does not fails its try and the
        // escalation moves the task on (ADR-045).
        capabilities: { tools: true, structuredOutput: true },
        contextWindow: input.settings.contextWindow,
        pricing: {
          inputPerMTokUsd: 0,
          outputPerMTokUsd: 0,
          source: LOCAL_PRICE_SOURCE,
          asOf: day,
          notes: 'runs on your machine: no per-token charge',
        },
        tier: 'low',
      });
      if (!parsed.success) continue;
      seen.add(modelId);
      added.push(parsed.data);
    }
    if (added.length === 0) {
      row('no-models', `${runtime.baseURL} answered but lists no chat models`);
      continue;
    }
    providers.push(provider);
    models.push(...added);
    const refs = added.map((m) => modelRef(m.provider, m.modelId));
    localRefs.push(...refs);
    row(
      'added',
      `${runtime.label}: ${String(refs.length)} model(s), $0, tier low, context ${String(input.settings.contextWindow)}`,
      refs,
    );
  }
  return { config: { ...base, providers, models }, localRefs, runtimes };
}

/** One line per local runtime for `soot config` / `soot models`. */
export function describeLocalPool(reports: readonly LocalRuntimeReport[]): string[] {
  return reports.map((r) =>
    r.status === 'added'
      ? `- ${r.id}: ${r.reason}: ${r.models.map((m) => `${m} [low]`).join(', ')}`
      : `- ${r.id} (${r.baseURL}): ${r.status}; ${r.reason}`,
  );
}
