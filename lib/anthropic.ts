import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.warn('Warning: ANTHROPIC_API_KEY is not set in environment variables.');
}

const anthropic = new Anthropic({
  apiKey: apiKey || 'dummy-key',
});

export interface CallModelInput {
  systemPrompt: string;
  userMessage: string;
  model: string;
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

let mockCallModel: ((input: CallModelInput) => Promise<CallModelResult>) | null = null;
export function setMockCallModel(mock: typeof mockCallModel) {
  mockCallModel = mock;
}

/**
 * Interface to communicate with the Anthropic Messages API.
 * Leverages Prompt Caching (Beta) for static system prompts to minimize latency and token costs.
 */
export async function callModel(input: CallModelInput): Promise<CallModelResult> {
  if (mockCallModel) {
    return await mockCallModel(input);
  }
  try {
    // Call the Anthropic Messages API
    // We pass the system prompt as a structured block to enable ephemeral prompt caching
    const response = await anthropic.messages.create(
      {
        model: input.model,
        max_tokens: 2048,
        system: [
          {
            type: 'text',
            text: input.systemPrompt,
            // Enable prompt caching on the system prompt block
            // This is crucial because it contains static document contexts
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: input.userMessage,
          },
        ],
      },
      {
        // Headers to support prompt caching features in Anthropic API
        headers: {
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
      }
    );

    // Parse text from response content blocks
    let replyText = '';
    if (response.content && response.content.length > 0) {
      const firstBlock = response.content[0];
      if (firstBlock.type === 'text') {
        replyText = firstBlock.text;
      }
    }

    return {
      text: replyText,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_tokens: (response.usage as any).cache_read_input_tokens || 0,
        cache_creation_tokens: (response.usage as any).cache_creation_input_tokens || 0,
      },
      model: response.model,
      requestId: response.id,
      stopReason: response.stop_reason,
    };
  } catch (error: any) {
    console.error('Anthropic API call failed:', error);
    throw new Error(`Failed to generate answer from Anthropic: ${error.message}`);
  }
}
