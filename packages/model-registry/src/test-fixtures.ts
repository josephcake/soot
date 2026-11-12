import type { RegistryConfigInput } from './config.js';

/** Fictional providers and models for tests. Not exported from the package. */
export const TEST_CONFIG: RegistryConfigInput = {
  version: 1,
  providers: [
    { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    { id: 'openai', kind: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
    {
      id: 'local-ollama',
      kind: 'openai-compatible',
      baseURL: 'http://127.0.0.1:11434/v1',
      local: true,
    },
    { id: 'deepseek', kind: 'listed-only' },
  ],
  models: [
    {
      provider: 'anthropic',
      modelId: 'test-claude-small',
      capabilities: {
        tools: true,
        structuredOutput: true,
        vision: true,
        reasoning: false,
        streaming: true,
      },
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      pricing: {
        inputPerMTokUsd: 1,
        outputPerMTokUsd: 5,
        cacheReadPerMTokUsd: 0.1,
        source: 'user-config',
        asOf: '2026-11-12',
      },
    },
    {
      provider: 'openai',
      modelId: 'test-gpt-large',
      capabilities: {
        tools: true,
        structuredOutput: true,
        vision: null,
        reasoning: true,
        streaming: true,
      },
      contextWindow: 400_000,
      pricing: {
        inputPerMTokUsd: 2,
        outputPerMTokUsd: 8,
        source: 'https://example.invalid/pricing',
        asOf: '2026-11-01',
      },
    },
    { provider: 'local-ollama', modelId: 'test-local-coder', capabilities: { tools: false } },
    { provider: 'deepseek', modelId: 'test-deepseek-model', contextWindow: 128_000 },
  ],
};
