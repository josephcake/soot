import {
  LOCAL_PROBE_TIMEOUT_MS,
  ProviderConfigSchema,
  type LocalRuntime,
  type LocalRuntimeProbe,
} from '@soot/model-registry';
import { discoverModelIds } from './discovery.js';
import { ProviderError } from './errors.js';

/*
 * Probe local runtimes (ADR-045): `GET <baseURL>/models` on each, in parallel, with a short
 * limit and no key. Never throws: a runtime that is not running is `unreachable`.
 */

export interface LocalProbeOptions {
  /** Per-runtime limit in ms. Default `LOCAL_PROBE_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Tests pass a fetch bound to a fake server. Default `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
}

export async function probeLocalRuntimes(
  runtimes: readonly LocalRuntime[],
  options: LocalProbeOptions = {},
): Promise<LocalRuntimeProbe[]> {
  const timeoutMs = options.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS;
  return Promise.all(
    runtimes.map(async (runtime): Promise<LocalRuntimeProbe> => {
      const provider = ProviderConfigSchema.parse({
        id: runtime.id,
        kind: 'openai-compatible',
        baseURL: runtime.baseURL,
        local: true,
      });
      try {
        const modelIds = await discoverModelIds(provider, {
          // No key is ever sent to a local runtime.
          env: {},
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { runtime, status: 'found', modelIds, reason: '' };
      } catch (error) {
        if (error instanceof ProviderError && error.status !== null) {
          return {
            runtime,
            status: 'error',
            modelIds: [],
            reason: `model listing failed with HTTP ${String(error.status)}`,
          };
        }
        if (
          error instanceof ProviderError &&
          (error.kind === 'unknown' || error.kind === 'invalid-output')
        ) {
          return {
            runtime,
            status: 'error',
            modelIds: [],
            reason: 'model listing was not readable JSON',
          };
        }
        return {
          runtime,
          status: 'unreachable',
          modelIds: [],
          reason: `nothing answered within ${String(timeoutMs)} ms`,
        };
      }
    }),
  );
}
