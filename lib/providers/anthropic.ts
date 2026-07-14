import Anthropic from '@anthropic-ai/sdk';
import { ModelProvider, CallModelInput, CallModelResult, extractReplyText } from '../model';
import { getModelMaxOutputTokens } from '../config';


let anthropicInstance: Anthropic | null = null;
function getAnthropicInstance(): Anthropic {
  if (!anthropicInstance) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('Warning: ANTHROPIC_API_KEY is not set in environment variables.');
    }
    anthropicInstance = new Anthropic({
      apiKey: apiKey || 'dummy-key',
    });
  }
  return anthropicInstance;
}

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

      const response = await getAnthropicInstance().messages.create(
        {
          model: input.model,
          max_tokens: getModelMaxOutputTokens(),
          system: systemContent,
          messages: [
            {
              role: 'user',
              content: input.document
                ? [
                    {
                      type: 'document',
                      source: {
                        type: 'base64',
                        media_type: input.document.mediaType as 'application/pdf',
                        data: input.document.data,
                      },
                    },
                    {
                      type: 'text',
                      text: input.userMessage,
                    },
                  ]
                : input.userMessage,
            },
          ],
          metadata: { user_id: input.isolationScopeId },
        },
        {
          headers,
        }
      );

      // Use the shared extractReplyText helper to safely extract the final answer.
      const replyText = extractReplyText(response.content);

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
      throw error;
    }
  }
}
