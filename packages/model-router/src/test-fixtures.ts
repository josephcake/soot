/*
 * Fictional providers and models for routing tests. Names, prices, and reliability priors are
 * made up for the tests; they describe no real model. Not exported from the package.
 */
import { ModelRegistry, parseRegistryConfig, type RegistryConfigInput } from '@soot/model-registry';
import type { Task } from '@soot/task-graph';

const price = (inputPerMTokUsd: number, outputPerMTokUsd: number) => ({
  inputPerMTokUsd,
  outputPerMTokUsd,
  source: 'test fixture (fictional)',
  asOf: '2026-11-12',
});
const prior = (low: number, medium: number, high: number) => ({
  low,
  medium,
  high,
  source: 'test fixture (fictional)',
});
const caps = (
  c: Partial<
    Record<'tools' | 'structuredOutput' | 'vision' | 'reasoning' | 'streaming', boolean | null>
  >,
) => ({
  tools: true,
  structuredOutput: true,
  vision: false,
  reasoning: false,
  streaming: true,
  ...c,
});

export const ROUTING_CONFIG: RegistryConfigInput = {
  version: 1,
  providers: [
    { id: 'alpha', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    { id: 'beta', kind: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    { id: 'local', kind: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', local: true },
    // Listed only: cheapest and "most reliable" on paper, never selectable or called.
    { id: 'listed', kind: 'listed-only' },
  ],
  models: [
    {
      provider: 'alpha',
      modelId: 'test-small',
      capabilities: caps({}),
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      pricing: price(0.25, 1.25),
      reliability: prior(0.9, 0.7, 0.4),
    },
    {
      provider: 'beta',
      modelId: 'test-mid',
      capabilities: caps({ vision: true }),
      contextWindow: 400_000,
      maxOutputTokens: 16_384,
      pricing: price(1, 4),
      reliability: prior(0.95, 0.88, 0.7),
    },
    {
      provider: 'alpha',
      modelId: 'test-large',
      capabilities: caps({ vision: true, reasoning: true }),
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      pricing: price(5, 25),
      reliability: prior(0.97, 0.95, 0.9),
    },
    {
      provider: 'beta',
      modelId: 'test-frontier',
      capabilities: caps({ vision: true, reasoning: true }),
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: price(15, 75),
      reliability: prior(0.98, 0.97, 0.96),
    },
    {
      provider: 'local',
      modelId: 'test-local-coder',
      capabilities: caps({ structuredOutput: null }),
      contextWindow: 32_000,
      pricing: { ...price(0, 0), source: 'local runtime: no per-token charge' },
      reliability: prior(0.8, 0.5, 0.2),
    },
    {
      provider: 'listed',
      modelId: 'test-listed',
      capabilities: caps({ vision: true, reasoning: true }),
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: price(0.1, 0.2),
      reliability: prior(0.99, 0.99, 0.99),
    },
  ],
};

/** A callable DeepSeek endpoint (ADR-035), configured like any OpenAI-compatible provider. */
export const DEEPSEEK_PROVIDER = {
  id: 'deepseek',
  kind: 'openai-compatible',
  baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
} as const;

/** ROUTING_CONFIG plus a callable DeepSeek model that is cheapest and most reliable on paper. */
export const ROUTING_CONFIG_WITH_DEEPSEEK: RegistryConfigInput = {
  ...ROUTING_CONFIG,
  providers: [...ROUTING_CONFIG.providers, DEEPSEEK_PROVIDER],
  models: [
    ...ROUTING_CONFIG.models,
    {
      provider: 'deepseek',
      modelId: 'test-ds',
      capabilities: caps({ vision: true, reasoning: true }),
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: price(0.1, 0.2),
      reliability: prior(0.99, 0.99, 0.99),
    },
  ],
};

export const routingRegistry = (config: RegistryConfigInput = ROUTING_CONFIG) =>
  new ModelRegistry(parseRegistryConfig(config));

export function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    instructions: `Do ${id}.`,
    acceptanceCriteria: [`${id} is done`],
    requiredCapabilities: ['code-edit'],
    complexity: 'low',
    estimate: { inputTokens: 2000, outputTokens: 300, costUsd: null },
    files: { read: [], write: [] },
    dependsOn: [],
    ...overrides,
  };
}
