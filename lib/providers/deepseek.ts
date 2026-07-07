import Anthropic from '@anthropic-ai/sdk';
import { ModelProvider, CallModelInput, CallModelResult } from '../model';
import { getModelMaxOutputTokens } from '../config';

export class DeepSeekProvider implements ModelProvider {
  readonly name = 'deepseek';
  readonly outputFormat = 'markdown';
  private anthropic: Anthropic;

  constructor() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        'DEEPSEEK_API_KEY environment variable is required for DeepSeekProvider. ' +
        'Please ensure this is configured when using a deepseek-* model.'
      );
    }

    this.anthropic = new Anthropic({
      apiKey,
      baseURL: 'https://api.deepseek.com/anthropic',
    });
  }

  async callModel(input: CallModelInput): Promise<CallModelResult> {
    try {
      // DeepSeek caching is automatic/prefix-based. We do NOT attach
      // cache_control to the system prompt blocks.
      const systemContent: any[] = [
        {
          type: 'text',
          text: input.systemPrompt,
        },
      ];

      // DeepSeek compat endpoint normalizes into Anthropic messages structure.
      // We hardcode thinking: disabled as reasoning tokens are billable output
      // and not required for QA/recap workloads.
      const response = await this.anthropic.messages.create(
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
          metadata: { user_id: input.isolationScopeId },
          // Cast to any since thinking API might not be present on older SDK types
          thinking: { type: 'disabled' },
        } as any
      );

      // DeepSeek responses might include thinking content blocks if misconfigured
      // or if reasoning is activated. Find the first text block rather than referencing [0].
      let replyText = '';
      if (response.content && response.content.length > 0) {
        const textBlock = response.content.find((block) => block.type === 'text');
        if (textBlock && textBlock.type === 'text') {
          replyText = textBlock.text;
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
      console.error('DeepSeek API call failed:', error);
      throw new Error(`Failed to generate answer from DeepSeek: ${error.message}`);
    }
  }
}
