import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.warn('Warning: ANTHROPIC_API_KEY is not set in environment variables.');
}

const anthropic = new Anthropic({
  apiKey: apiKey || 'dummy-key',
});

interface CallModelInput {
  systemPrompt: string;
  userMessage: string;
  model: string;
}

let mockCallModel: ((input: CallModelInput) => Promise<{ text: string }>) | null = null;
export function setMockCallModel(mock: typeof mockCallModel) {
  mockCallModel = mock;
}

/**
 * Interface to communicate with the Anthropic Messages API.
 * Leverages Prompt Caching (Beta) for static system prompts to minimize latency and token costs.
 */
export async function callModel(input: CallModelInput): Promise<{ text: string }> {
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

    return { text: replyText };
  } catch (error: any) {
    console.error('Anthropic API call failed:', error);
    throw new Error(`Failed to generate answer from Anthropic: ${error.message}`);
  }
}
