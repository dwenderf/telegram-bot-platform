import Anthropic from '@anthropic-ai/sdk';
import { ModelProvider, CallModelInput, CallModelResult, DocumentUnsupportedError, extractReplyText } from '../model';
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
    if (input.document) {
      throw new DocumentUnsupportedError('DeepSeek provider does not support raw document ingestion.');
    }

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
      const createParams: any = {
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
        thinking: { type: 'disabled' },
      };

      if (input.webSearch) {
        createParams.tools = [
          { type: 'web_search_20250305', name: 'web_search', max_uses: input.webSearch.maxUses },
        ];
      }

      const response = await this.anthropic.messages.create(createParams);

      // DeepSeek responses might include thinking, tool use, and tool result blocks.
      // Use the shared extractReplyText helper to safely extract the final answer.
      const replyText = extractReplyText(response.content);

      const webSearchRequests = (response.usage as any).server_tool_use?.web_search_requests ?? 0;

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
        webSearchRequests,
      };
    } catch (error: any) {
      console.error('DeepSeek API call failed:', error);
      throw new Error(`Failed to generate answer from DeepSeek: ${error.message}`);
    }
  }
}
