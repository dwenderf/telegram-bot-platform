import { AnthropicProvider } from './providers/anthropic';

export interface CallModelInput {
  systemPrompt: string;
  userMessage: string;
  model: string;
  cacheable: boolean;
}

export interface CallModelResult {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
  model: string;
  requestId: string | null;
  stopReason: string | null;
  raw?: Record<string, any>;
}

export interface ModelProvider {
  readonly name: string;
  callModel(input: CallModelInput): Promise<CallModelResult>;
}

// Global Mock Registry for test harness compatibility
let globalMock: ((input: CallModelInput) => Promise<CallModelResult>) | null = null;

export function setGlobalMock(mock: typeof globalMock) {
  globalMock = mock;
}

export function getGlobalMock() {
  return globalMock;
}

// Singleton instances
let anthropicProviderInstance: AnthropicProvider | null = null;

function getAnthropicProvider(): AnthropicProvider {
  if (!anthropicProviderInstance) {
    anthropicProviderInstance = new AnthropicProvider();
  }
  return anthropicProviderInstance;
}

/**
 * Resolves a model name to its corresponding ModelProvider.
 * If a test mock is active, it returns a wrapper provider delegating to the mock.
 */
export function resolveProvider(modelName?: string | null): ModelProvider {
  const mock = getGlobalMock();
  if (mock) {
    return {
      name: 'anthropic',
      callModel: mock,
    };
  }

  // Default to AnthropicProvider (DeepSeek routing deferred to future phase)
  return getAnthropicProvider();
}
