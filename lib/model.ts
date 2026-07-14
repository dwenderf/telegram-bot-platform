import { AnthropicProvider } from './providers/anthropic';
import { DeepSeekProvider } from './providers/deepseek';

export class DocumentUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentUnsupportedError';
  }
}

export class DocumentReadError extends Error {
  constructor(
    public reason: 'too_many_pages' | 'unreadable' | 'transient',
    message: string
  ) {
    super(message);
    this.name = 'DocumentReadError';
  }
}

export interface CallModelInput {
  systemPrompt: string;
  userMessage: string;
  model: string;
  cacheable: boolean;
  isolationScopeId: string; // required; produced only by resolveIsolationScopeId()
  document?: { data: string; mediaType: string };
  webSearch?: { maxUses: number }; // NEW, optional — attach web_search server tool
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
  webSearchRequests?: number; // NEW — surfaced from usage.server_tool_use.web_search_requests
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

/**
 * Shared helper to extract final answer text from model content blocks,
 * correctly skipping preambles or narration blocks preceding tool results.
 */
export function extractReplyText(content: any[]): string {
  if (!Array.isArray(content) || content.length === 0) return '';
  // Prefer text blocks AFTER the last server-tool result (web_search_tool_result / web_fetch_tool_result);
  // if there is no tool result, use all text blocks. Concatenate + trim.
  let startIdx = 0;
  for (let i = content.length - 1; i >= 0; i--) {
    const t = content[i]?.type;
    if (t === 'web_search_tool_result' || t === 'web_fetch_tool_result') {
      startIdx = i + 1;
      break;
    }
  }
  const slice = content.slice(startIdx);
  const texts = (slice.some((b) => b.type === 'text') ? slice : content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '');
  return texts.join('').trim();
}

