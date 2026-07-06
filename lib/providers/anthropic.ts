import Anthropic from '@anthropic-ai/sdk';
import { ModelProvider, CallModelInput, CallModelResult } from '../model';
import { getModelMaxOutputTokens } from '../config';

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.warn('Warning: ANTHROPIC_API_KEY is not set in environment variables.');
}

const anthropic = new Anthropic({
  apiKey: apiKey || 'dummy-key',
});

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly outputFormat = 'markdown';

  async callModel(input: CallModelInput): Promise<CallModelResult> {
    try {
      const systemContent: any[] = [
        {
          type: 'text',
          text: input.systemPrompt,
        },
      ];

      // Enable prompt caching only if cacheable is true
      if (input.cacheable) {
        systemContent[0].cache_control = { type: 'ephemeral' };
      }

      const headers: Record<string, string> = {};
      if (input.cacheable) {
        headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
      }

      const response = await anthropic.messages.create(
        {
          model: input.model,
          max_tokens: getModelMaxOutputTokens(),
          system: systemContent,
          messages: [
            {
              role: 'user',
              content: input.userMessage,
            },
          ],
        },
        {
          headers,
        }
      );

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
}
