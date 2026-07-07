// Test suite for DeepSeek Provider
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-deepseek-provider.ts

import assert from 'assert';
import Anthropic from '@anthropic-ai/sdk';
import { resolveProvider, setGlobalMock, getGlobalMock } from '../lib/model';
import { DeepSeekProvider } from '../lib/providers/deepseek';
import { AnthropicProvider } from '../lib/providers/anthropic';

// Setup environment variables for testing
process.env.DEEPSEEK_API_KEY = 'dummy-deepseek-key';
process.env.ANTHROPIC_API_KEY = 'dummy-anthropic-key';
process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

let lastCreateParams: any = null;
let lastCreateOptions: any = null;
let mockResponse: any = null;

// Backup the original create method so we can restore it at test completion.
// NOTE: We prototype-patch Anthropic.Messages.prototype globally for this process
// because callModel-level mock registry (setGlobalMock) cannot assert the exact
// request parameters (e.g. thinking:disabled, omitted cache_control) built internally.
const originalCreate = Anthropic.Messages.prototype.create;

(Anthropic.Messages.prototype as any).create = async function (params: any, options: any) {
  lastCreateParams = params;
  lastCreateOptions = options;
  return mockResponse;
};

async function main() {
  try {
    console.log('--- Starting DeepSeek Provider Test Suite ---');

  // =========================================================================
  // Test 1: Constructor Validation (Fails fast if key is missing)
  // =========================================================================
  console.log('Test 1: Constructor fails fast when DEEPSEEK_API_KEY is missing...');
  const originalKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;

  assert.throws(
    () => {
      new DeepSeekProvider();
    },
    /DEEPSEEK_API_KEY environment variable is required/,
    'Should throw a validation error if key is unset'
  );

  // Restore key
  process.env.DEEPSEEK_API_KEY = originalKey;
  console.log('✅ Test 1 Passed.');

  // =========================================================================
  // Test 2: Request Formatting & Options (Disabled thinking, no cache controls)
  // =========================================================================
  console.log('Test 2: Verifying request construction...');
  lastCreateParams = null;
  lastCreateOptions = null;
  mockResponse = {
    id: 'msg-test-2',
    model: 'deepseek-v4-flash',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Ok.' }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
  };

  const provider = new DeepSeekProvider();
  await provider.callModel({
    systemPrompt: 'System Instruction',
    userMessage: 'Hello DeepSeek',
    model: 'deepseek-v4-flash',
    cacheable: true, // Should be ignored
    isolationScopeId: 'dummy-scope-id',
  });

  // Verify thinking is disabled
  assert.deepStrictEqual(
    lastCreateParams.thinking,
    { type: 'disabled' },
    'Thinking option must be hardcoded to disabled'
  );

  // Verify input.model is forwarded verbatim
  assert.strictEqual(
    lastCreateParams.model,
    'deepseek-v4-flash',
    'Model identifier must be forwarded verbatim'
  );

  // Verify prompt caching blocks are omitted
  assert.strictEqual(
    lastCreateParams.system[0].cache_control,
    undefined,
    'Prompt caching cache_control markers must be omitted'
  );

  // Verify prompt caching header is omitted
  assert.strictEqual(
    lastCreateOptions?.headers?.['anthropic-beta'],
    undefined,
    'anthropic-beta prompt caching header must be omitted'
  );

  console.log('✅ Test 2 Passed.');

  // =========================================================================
  // Test 3: Usage Mapping (Anthropic compatible shape mapped to result)
  // =========================================================================
  console.log('Test 3: Verifying usage metrics mapping...');
  mockResponse = {
    id: 'msg-test-3',
    model: 'deepseek-v4-flash',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'Hello!' }],
    usage: {
      input_tokens: 500,
      cache_read_input_tokens: 450,
      cache_creation_input_tokens: 0,
      output_tokens: 150,
    },
  };

  const result3 = await provider.callModel({
    systemPrompt: 'System Instruction',
    userMessage: 'Test usage mapping',
    model: 'deepseek-v4-flash',
    cacheable: false,
    isolationScopeId: 'dummy-scope-id',
  });

  assert.strictEqual(result3.usage.input_tokens, 500, 'input_tokens should map correctly');
  assert.strictEqual(result3.usage.cache_read_tokens, 450, 'cache_read_tokens should map correctly');
  assert.strictEqual(result3.usage.cache_creation_tokens, 0, 'cache_creation_tokens should map correctly (expected 0)');
  assert.strictEqual(result3.usage.output_tokens, 150, 'output_tokens should map correctly');

  console.log('✅ Test 3 Passed.');

  // =========================================================================
  // Test 4: Metadata Parsing (model name and stopReason)
  // =========================================================================
  console.log('Test 4: Verifying metadata and stopReason parsing...');
  mockResponse = {
    id: 'msg-test-4',
    model: 'deepseek-v4-pro',
    stop_reason: 'max_tokens',
    content: [{ type: 'text', text: 'Unfinished response...' }],
    usage: {
      input_tokens: 100,
      output_tokens: 200,
    },
  };

  const result4 = await provider.callModel({
    systemPrompt: 'System Instruction',
    userMessage: 'Test metadata',
    model: 'deepseek-v4-pro',
    cacheable: false,
    isolationScopeId: 'dummy-scope-id',
  });

  assert.strictEqual(result4.model, 'deepseek-v4-pro', 'Result model name must match the response model verbatim');
  assert.strictEqual(result4.stopReason, 'max_tokens', 'Result stopReason must match the response stop_reason');
  assert.strictEqual(result4.requestId, 'msg-test-4', 'Result requestId must match the response id');

  console.log('✅ Test 4 Passed.');

  // =========================================================================
  // Test 5: Robust Text Block Extraction (Scan type, do not assume position)
  // =========================================================================
  console.log('Test 5: Verifying text block extraction finds text content robustly...');
  mockResponse = {
    id: 'msg-test-5',
    model: 'deepseek-v4-flash',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', text: 'Generating thoughts...' },
      { type: 'text', text: 'Real final text answer.' },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 10,
    },
  };

  const result5 = await provider.callModel({
    systemPrompt: 'System Instruction',
    userMessage: 'Test text extraction',
    model: 'deepseek-v4-flash',
    cacheable: false,
    isolationScopeId: 'dummy-scope-id',
  });

  assert.strictEqual(
    result5.text,
    'Real final text answer.',
    'Extraction should scan content type list and resolve the text block'
  );

  console.log('✅ Test 5 Passed.');

  // =========================================================================
  // Test 6: Resolver Routing (Prefix matching)
  // =========================================================================
  console.log('Test 6: Verifying resolveProvider routing by modelName prefix...');

  // deepseek-* should route to DeepSeekProvider
  const dsProvider = resolveProvider('deepseek-v4-flash');
  assert.ok(dsProvider instanceof DeepSeekProvider, 'deepseek-* models must route to DeepSeekProvider');
  assert.strictEqual(dsProvider.name, 'deepseek');

  // claude-* should route to AnthropicProvider
  const antProvider1 = resolveProvider('claude-3-5-sonnet-20241022');
  assert.ok(antProvider1 instanceof AnthropicProvider, 'claude-* models must route to AnthropicProvider');
  assert.strictEqual(antProvider1.name, 'anthropic');

  // null/undefined should route to AnthropicProvider
  const antProvider2 = resolveProvider(null);
  assert.ok(antProvider2 instanceof AnthropicProvider, 'null modelName must route to AnthropicProvider');

  const antProvider3 = resolveProvider(undefined);
  assert.ok(antProvider3 instanceof AnthropicProvider, 'undefined modelName must route to AnthropicProvider');

  console.log('✅ Test 6 Passed.');

  // =========================================================================
  // Test 7: Global Mock Priority
  // =========================================================================
  console.log('Test 7: Verifying test mock registry overrides routing...');
  const mockCall = async () => {
    return {
      text: 'Mocked output',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'mock-model',
      requestId: 'mock-id',
      stopReason: 'end_turn',
    };
  };

  setGlobalMock(mockCall);

  // Even deepseek model identifier should resolve to the mock wrapper
  const mockedProvider = resolveProvider('deepseek-v4-flash');
  assert.strictEqual(mockedProvider.name, 'anthropic', 'Mocked provider name defaults to anthropic for backward-compatibility');
  
  const mockResult = await mockedProvider.callModel({
    systemPrompt: '',
    userMessage: '',
    model: '',
    cacheable: false,
    isolationScopeId: 'dummy-scope-id',
  });
  assert.strictEqual(mockResult.text, 'Mocked output', 'Mock provider must execute the mock callback');

  // Cleanup mock
  setGlobalMock(null);
  console.log('✅ Test 7 Passed.');

    console.log('🎉 ALL DEEPSEEK PROVIDER TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    // Restore the prototype clobbering to prevent process-global test leakage
    Anthropic.Messages.prototype.create = originalCreate;
  }
}

main().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
