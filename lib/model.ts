import { AnthropicProvider } from './providers/anthropic';
import { DeepSeekProvider } from './providers/deepseek';

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
  /**
   * The output format that the provider is expected to emit (and that the capabilities
   * layer will convert to Telegram MessageEntities). This field governs BOTH the format
   * instruction injected into the system prompt AND the converter selection — they must
   * stay in lockstep.
   */
  readonly outputFormat: 'markdown' | 'html';
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
let deepseekProviderInstance: DeepSeekProvider | null = null;

function getAnthropicProvider(): AnthropicProvider {
  if (!anthropicProviderInstance) {
    anthropicProviderInstance = new AnthropicProvider();
  }
  return anthropicProviderInstance;
}

function getDeepSeekProvider(): DeepSeekProvider {
  if (!deepseekProviderInstance) {
    deepseekProviderInstance = new DeepSeekProvider();
  }
  return deepseekProviderInstance;
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
      outputFormat: 'markdown',
      callModel: mock,
    };
  }

  if (modelName && modelName.startsWith('deepseek')) {
    return getDeepSeekProvider();
  }

  return getAnthropicProvider();
}
