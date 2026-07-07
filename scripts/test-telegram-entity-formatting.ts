// Test suite for Entity-Based Telegram Formatting
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-telegram-entity-formatting.ts

import assert from 'assert';
import { resolveProvider } from '../lib/model';
import { DeepSeekProvider } from '../lib/providers/deepseek';
import { AnthropicProvider } from '../lib/providers/anthropic';
import { sendMessage } from '../lib/telegram';
import { answerQuestion, recapConversation, renderModelOutput, formatRulesFor, recapGuidelinesFor, logModelCall } from '../lib/capabilities';
import { resolveIsolationScopeId } from '../lib/isolation';
import { setMockCallModel } from '../lib/anthropic';
import { markdownToFormattable } from '@gramio/format/markdown';
import { htmlToFormattable } from '@gramio/format/html';
import postgres from 'postgres';
export type TelegramMessageEntity = ReturnType<typeof htmlToFormattable>['entities'][number];

// Setup environment variables for testing
process.env.DEEPSEEK_API_KEY = 'dummy-deepseek-key';
process.env.ANTHROPIC_API_KEY = 'dummy-anthropic-key';
process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

let lastRequestUrl = '';
let lastRequestBody: any = null;
let lastProviderUrl = '';
let lastProviderBody: any = null;

// Backup original fetch to restore it later
const originalFetch = global.fetch;

// Mock global fetch to capture sendMessage payload and provider calls
global.fetch = async (url: any, options: any) => {
  const urlStr = url.toString();
  if (urlStr.includes('api.anthropic.com') || urlStr.includes('api.deepseek.com')) {
    lastProviderUrl = urlStr;
    lastProviderBody = JSON.parse(options.body);
    const messagesBody = {
      id: 'msg-mocked',
      type: 'message',
      role: 'assistant',
      model: lastProviderBody.model || 'dummy-model',
      content: [{ type: 'text', text: 'Mocked reply' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    return new Response(JSON.stringify(messagesBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as any;
  }

  // Telegram Mock
  lastRequestUrl = urlStr;
  lastRequestBody = JSON.parse(options.body);
  return {
    ok: true,
    json: async () => ({ ok: true, result: {} }),
    text: async () => '{"ok":true}',
  } as any;
};

async function main() {
  console.log('--- Starting Telegram Entity Formatting Test Suite ---');

  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error('ADMIN_DATABASE_URL environment variable is required');
  }
  const sql = postgres(adminUrl);

  const USER_A = 'a3000000-0000-0000-0000-000000000000';
  const E1 = 'e3300000-0000-0000-0000-000000000000';
  const GROUP_A = 'f3300000-0000-0000-0000-000000000000';
  const CHAT_A = 123456789;

  try {
    console.log('--- Cleaning Up Stale Test State ---');
    await sql`delete from public.message_log where group_id = ${GROUP_A}`;
    await sql`delete from public.groups where id = ${GROUP_A}`;
    await sql`delete from public.entities where id = ${E1}`;
    await sql`delete from auth.users where id = ${USER_A}`;

    console.log('--- Seeding Test Fixtures ---');
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_formatting@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username) values (${E1}, 'entity-test-formatting', 'Formatting Entity', ${USER_A}, 'formatting_bot')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Group A')`;
    await sql`insert into public.message_log (group_id, entity_id, telegram_chat_id, telegram_message_id, message_text, username) values (${GROUP_A}, ${E1}, ${CHAT_A}, 1001, 'hello world', 'user')`;
    // =========================================================================
    // Test 1: Markdown → entities (DeepSeek path)
    // =========================================================================
    console.log('Test 1: Verifying markdown bold and italic formatting...');
    const mdResult = markdownToFormattable('**bold text** and *italic text*');
    assert.strictEqual(mdResult.text, 'bold text and italic text');
    assert.strictEqual(mdResult.entities.length, 2);
    
    // Bold entity
    assert.strictEqual(mdResult.entities[0].type, 'bold');
    assert.strictEqual(mdResult.entities[0].offset, 0);
    assert.strictEqual(mdResult.entities[0].length, 9);

    // Italic entity
    assert.strictEqual(mdResult.entities[1].type, 'italic');
    assert.strictEqual(mdResult.entities[1].offset, 14);
    assert.strictEqual(mdResult.entities[1].length, 11);
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: UTF-16 offsets with emoji (make-or-break)
    // =========================================================================
    console.log('Test 2: Verifying UTF-16 code-unit offsets with emojis...');
    // "😊" is 2 code units in UTF-16 (surrogate pair)
    const emojiResult = markdownToFormattable('😊 hello **world**');
    assert.strictEqual(emojiResult.text, '😊 hello world');
    assert.strictEqual(emojiResult.entities.length, 1);
    assert.strictEqual(emojiResult.entities[0].type, 'bold');
    // Offset must account for the emoji surrogate pair:
    // Emoji (2) + space (1) + "hello" (5) + space (1) = 9
    assert.strictEqual(emojiResult.entities[0].offset, 9);
    assert.strictEqual(emojiResult.entities[0].length, 5);
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: Headers → bold
    // =========================================================================
    console.log('Test 3: Verifying headers render as bold...');
    const hMdResult = markdownToFormattable('# Heading 1\n## Heading 2');
    assert.ok(hMdResult.entities.some((e: TelegramMessageEntity) => e.type === 'bold'), 'Markdown headers must yield bold entities');

    const hHtmlResult = htmlToFormattable('<h1>Html Header</h1>');
    assert.ok(hHtmlResult.entities.some((e: TelegramMessageEntity) => e.type === 'bold'), 'HTML headers must yield bold entities');
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Malformed markup degrades, does not throw
    // =========================================================================
    console.log('Test 4: Verifying malformed markup resilience...');
    assert.doesNotThrow(() => {
      const result = markdownToFormattable('**unclosed bold');
      assert.strictEqual(result.text, '**unclosed bold');
    });

    assert.doesNotThrow(() => {
      const result = htmlToFormattable('<b>unclosed html tag');
      assert.strictEqual(result.text, 'unclosed html tag');
    });
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: HTML → entities (Anthropic path)
    // =========================================================================
    console.log('Test 5: Verifying HTML formatting options...');
    const htmlResult = htmlToFormattable('<b>bold</b> and <i>italic</i> and <code>code</code>');
    assert.strictEqual(htmlResult.text, 'bold\n\n and \n\nitalic\n\n and \n\ncode');
    assert.strictEqual(htmlResult.entities.length, 3);
    assert.strictEqual(htmlResult.entities[0].type, 'bold');
    assert.strictEqual(htmlResult.entities[1].type, 'italic');
    assert.strictEqual(htmlResult.entities[2].type, 'code');
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: Recap note prepend & offset shift
    // =========================================================================
    console.log('Test 6: Verifying recap note prepending shifts body offsets correctly...');
    setMockCallModel(async () => {
      return {
        text: 'This is **recap** body',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'deepseek-v4-flash',
        requestId: 'req-test',
        stopReason: 'end_turn',
      };
    });

    const recapResult = await recapConversation({
      entityId: 'e3300000-0000-0000-0000-000000000000',
      groupId: 'f3300000-0000-0000-0000-000000000000',
      threadId: null,
      limit: 5,
      note: 'Recapping the last 5 messages.',
    });

    // The text should contain the note prepended
    assert.ok(recapResult.text.includes('Recapping the last 5 messages.'));
    assert.ok(recapResult.text.includes('This is recap body'));

    // Note italic format should be present in entities
    assert.ok(recapResult.entities.some((e: TelegramMessageEntity) => e.type === 'italic'), 'Prepended note must be italicized');

    // Body entities (e.g. bold "recap") should be present and shifted correctly
    const boldEntity = recapResult.entities.find((e: TelegramMessageEntity) => e.type === 'bold');
    assert.ok(boldEntity, 'Body bold text must be formatted');
    // Note (30) + newline (2) + "This is " (8) = 40 offset
    assert.strictEqual(boldEntity.offset, 40, 'Body formatting offsets must shift correctly after the note');

    // Cleanup mock
    setMockCallModel(null);
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: Format routing
    // =========================================================================
    console.log('Test 7: Verifying format routing...');
    const dsProvider = resolveProvider('deepseek-v4-flash');
    assert.strictEqual(dsProvider.outputFormat, 'markdown');

    const antProvider = resolveProvider('claude-3-5-sonnet-20241022');
    assert.strictEqual(antProvider.outputFormat, 'markdown');

    // Assert divergent formatting behavior inside capabilities layer helpers
    // Under markdown, "**world**" is parsed and formatted
    const dsAnswer = renderModelOutput('Hello **world**', 'markdown');
    assert.strictEqual(dsAnswer.text, 'Hello world');
    assert.strictEqual(dsAnswer.entities.length, 1);
    assert.strictEqual(dsAnswer.entities[0].type, 'bold');

    // Under HTML, "**world**" is plain text
    const antAnswer = renderModelOutput('Hello **world**', 'html');
    assert.strictEqual(antAnswer.text, 'Hello **world**');
    assert.strictEqual(antAnswer.entities.length, 0);

    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: SendMessage Mutual Exclusivity
    // =========================================================================
    console.log('Test 8: Verifying sendMessage mutual exclusivity guard...');
    
    // Case A: entities present -> parse_mode is dropped
    lastRequestBody = null;
    await sendMessage('token', 12345, 'Formatted text', {
      parseMode: 'HTML',
      entities: [{ type: 'bold', offset: 0, length: 9 }],
    });
    assert.strictEqual(lastRequestBody.parse_mode, undefined, 'parse_mode must be omitted when entities are present');
    assert.deepStrictEqual(lastRequestBody.entities, [{ type: 'bold', offset: 0, length: 9 }]);

    // Case B: no entities, parseMode present -> parse_mode remains
    lastRequestBody = null;
    await sendMessage('token', 12345, 'HTML text', {
      parseMode: 'HTML',
    });
    assert.strictEqual(lastRequestBody.parse_mode, 'HTML');
    assert.strictEqual(lastRequestBody.entities, undefined);

    console.log('✅ Test 8 Passed.');

    // =========================================================================
    // Test 9: Prompt reflects outputFormat (presence of correct, absence of wrong)
    // =========================================================================
    console.log('Test 9: Verifying prompt reflects outputFormat (presence and absence)...');
    
    // Markdown format rules check
    const mdRules = formatRulesFor('markdown');
    assert.ok(mdRules.includes('Use standard Markdown'), 'Markdown rules must contain markdown rules');
    assert.ok(mdRules.includes('Do NOT use HTML tags'), 'Markdown rules must forbid HTML');
    assert.ok(!mdRules.includes('Use Telegram-HTML format'), 'Markdown rules must NOT contain HTML rules');
    assert.ok(!mdRules.includes('&amp;'), 'Markdown rules must NOT contain escaping rules');

    // HTML format rules check
    const htmlRules = formatRulesFor('html');
    assert.ok(htmlRules.includes('Use Telegram-HTML format'), 'HTML rules must contain HTML rules');
    assert.ok(htmlRules.includes('&amp;'), 'HTML rules must contain escaping rules');
    assert.ok(!htmlRules.includes('Use standard Markdown'), 'HTML rules must NOT contain markdown rules');
    
    console.log('✅ Test 9 Passed.');

    // =========================================================================
    // Test 10: Recap guidelines are format-aware
    // =========================================================================
    console.log('Test 10: Verifying recap guidelines format-awareness...');
    
    const mdRecap = recapGuidelinesFor('markdown');
    assert.ok(mdRecap.includes('**summary**'), 'Markdown recap guidelines must use markdown bold');
    assert.ok(!mdRecap.includes('<b>summary</b>'), 'Markdown recap guidelines must NOT use HTML bold');

    const htmlRecap = recapGuidelinesFor('html');
    assert.ok(htmlRecap.includes('<b>summary</b>'), 'HTML recap guidelines must use HTML bold');
    assert.ok(!htmlRecap.includes('**summary**'), 'HTML recap guidelines must NOT use markdown bold');

    console.log('✅ Test 10 Passed.');

    // =========================================================================
    // Test 11: Format rules in systemPrompt, not userMessage (cache stability)
    // =========================================================================
    console.log('Test 11: Verifying rules are in systemPrompt and not userMessage...');
    
    let capturedSystemPrompt = '';
    let capturedUserMessage = '';

    setMockCallModel(async (input) => {
      capturedSystemPrompt = input.systemPrompt;
      capturedUserMessage = input.userMessage;
      return {
        text: 'Mock response',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'deepseek-v4-flash',
        requestId: 'req-cache',
        stopReason: 'end_turn',
      };
    });

    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      question: 'Cache check',
      model: 'deepseek-v4-flash',
    });

    assert.ok(capturedSystemPrompt, 'System prompt must be captured');
    assert.ok(capturedSystemPrompt.includes('OUTPUT FORMAT RULES'), 'System prompt must contain rules');
    assert.ok(!capturedUserMessage?.includes('OUTPUT FORMAT RULES'), 'User message must NOT contain rules');

    setMockCallModel(null);
    console.log('✅ Test 11 Passed.');

    // =========================================================================
    // Test 12: Custom persona still gets format rules appended
    // =========================================================================
    console.log('Test 12: Verifying custom persona gets format rules appended...');

    capturedSystemPrompt = '';
    setMockCallModel(async (input) => {
      capturedSystemPrompt = input.systemPrompt;
      return {
        text: 'Mock response',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'deepseek-v4-flash',
        requestId: 'req-persona',
        stopReason: 'end_turn',
      };
    });

    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      question: 'Persona check',
      model: 'deepseek-v4-flash',
      persona: 'Custom role description.',
    });

    assert.ok(capturedSystemPrompt);
    assert.ok(capturedSystemPrompt.startsWith('Custom role description.'), 'System prompt must start with custom persona');
    assert.ok(capturedSystemPrompt.includes('OUTPUT FORMAT RULES'), 'System prompt must still append format rules');

    setMockCallModel(null);
    console.log('✅ Test 12 Passed.');

    // =========================================================================
    // Test 13: Provider request body carries metadata.user_id (both providers)
    // =========================================================================
    console.log('Test 13: Verifying provider request body carries metadata.user_id...');

    // Clear any active mock so the real provider runs and hits fetch
    setMockCallModel(null);
    lastProviderUrl = '';
    lastProviderBody = null;

    const expectedScopeId = resolveIsolationScopeId(GROUP_A);

    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      question: 'Test isolation wire',
      model: 'deepseek-v4-flash',
    });

    assert.ok(lastProviderUrl, 'Fetch must have been intercepted');
    assert.ok(lastProviderUrl.includes('api.deepseek.com'), 'Must hit DeepSeek endpoint');
    assert.ok(lastProviderBody, 'Request body must be captured');
    assert.ok(lastProviderBody.metadata, 'metadata must be present');
    assert.strictEqual(lastProviderBody.metadata.user_id, expectedScopeId, 'metadata.user_id must match');

    // Repeat for Anthropic path
    lastProviderUrl = '';
    lastProviderBody = null;

    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      question: 'Test isolation wire anthropic',
      model: 'claude-3-5-sonnet-20241022',
    });

    assert.ok(lastProviderUrl);
    assert.ok(lastProviderUrl.includes('api.anthropic.com'));
    assert.ok(lastProviderBody);
    assert.ok(lastProviderBody.metadata);
    assert.strictEqual(lastProviderBody.metadata.user_id, expectedScopeId);

    console.log('✅ Test 13 Passed.');

    // =========================================================================
    // Test 14: Cache prefix integrity (metadata is sibling only)
    // =========================================================================
    console.log('Test 14: Verifying cache prefix integrity (metadata placement)...');

    // Assert metadata is not inside system or messages
    assert.ok(lastProviderBody.metadata, 'metadata is present at top-level');
    assert.ok(!JSON.stringify(lastProviderBody.system).includes('metadata'), 'system prompt must not contain metadata content');
    assert.ok(!JSON.stringify(lastProviderBody.messages).includes('metadata'), 'messages must not contain metadata content');

    console.log('✅ Test 14 Passed.');

    // =========================================================================
    // Test 15: Resolver determinism & separation
    // =========================================================================
    console.log('Test 15: Verifying resolver determinism and domain separation...');

    const hash1 = resolveIsolationScopeId(GROUP_A);
    const hash2 = resolveIsolationScopeId(GROUP_A);
    assert.strictEqual(hash1, hash2, 'Resolver must be deterministic');

    // Golden vector: pins the exact hashed input (tag 'isolation-scope' + ':' separator)
    // against a value computed independently of the resolver — the only assertion that
    // catches a silent tag/separator change. Determinism/format checks and Test 13 all run
    // the resolver on both sides and stay green if it drifts.
    assert.strictEqual(
      resolveIsolationScopeId(GROUP_A),
      'd56fc49115a4369feb96a034772d3ed2a13f4bcfb435663ce7f6865af8c7391e',
      'Golden vector: isolation-scope tag/separator must not drift'
    );

    const hash3 = resolveIsolationScopeId('f4400000-0000-0000-0000-000000000000');
    assert.notStrictEqual(hash1, hash3, 'Different groups must produce different hashes');

    assert.match(hash1, /^[a-f0-9]{64}$/, 'Hash must be a 64-character lowercase hex string');

    console.log('✅ Test 15 Passed.');

    // =========================================================================
    // Test 16: Resolver guards
    // =========================================================================
    console.log('Test 16: Verifying resolver guards throw on empty input...');

    assert.throws(() => {
      resolveIsolationScopeId('');
    }, /groupId is required/, 'Should throw if groupId is empty');

    // Direct test for missing pepper on the resolver
    const savedPepper16 = process.env.APP_HMAC_PEPPER;
    delete process.env.APP_HMAC_PEPPER;
    try {
      assert.throws(() => {
        resolveIsolationScopeId(GROUP_A);
      }, /APP_HMAC_PEPPER/, 'Should throw if pepper is missing');
    } finally {
      process.env.APP_HMAC_PEPPER = savedPepper16;
    }

    console.log('✅ Test 16 Passed.');

    // =========================================================================
    // Test 17: Abort-before-wire (throws on missing pepper)
    // =========================================================================
    console.log('Test 17: Verifying abort-before-wire when pepper is missing...');

    const savedPepper = process.env.APP_HMAC_PEPPER;
    delete process.env.APP_HMAC_PEPPER;

    try {
      lastProviderUrl = '';
      await answerQuestion({
        entityId: E1,
        groupId: GROUP_A,
        threadId: null,
        question: 'Should abort',
      });
      assert.fail('Should have aborted on missing pepper');
    } catch (e: any) {
      assert.ok(e.message.includes('APP_HMAC_PEPPER'), 'Error must mention APP_HMAC_PEPPER');
      assert.strictEqual(lastProviderUrl, '', 'No network requests must be made');
    } finally {
      process.env.APP_HMAC_PEPPER = savedPepper;
    }

    console.log('✅ Test 17 Passed.');

    // =========================================================================
    // Test 18: logModelCall records scope ID and type with spread priority
    // =========================================================================
    console.log('Test 18: Verifying logModelCall metadata spread priority...');

    const testResult = {
      text: 'Final response',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'deepseek-v4-flash',
      requestId: 'real-request-id',
      stopReason: 'end_turn',
      raw: {
        isolationScopeId: 'clobbered-val',
        requestId: 'clobbered-id',
        telegramThreadId: 99999,
      },
    };

    await logModelCall({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      botId: null,
      callType: 'answer',
      result: testResult,
      providerName: 'deepseek',
      isolationScopeId: expectedScopeId,
    });

    const calls = await sql`
      select metadata from public.model_calls
      where group_id = ${GROUP_A}::uuid
      order by created_at desc
      limit 1
    `;
    assert.strictEqual(calls.length, 1);
    const loggedMetadata = calls[0].metadata;

    assert.strictEqual(loggedMetadata.isolationScopeId, expectedScopeId, 'Controlled isolationScopeId must win');
    assert.strictEqual(loggedMetadata.isolationScopeType, 'group', 'Controlled isolationScopeType must win');
    assert.strictEqual(loggedMetadata.requestId, 'real-request-id', 'Controlled requestId must win');
    assert.strictEqual(loggedMetadata.telegramThreadId, null, 'Controlled telegramThreadId must win');

    console.log('✅ Test 18 Passed.');

    console.log('🎉 ALL TELEGRAM ENTITY FORMATTING TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    // Restore fetch mock
    global.fetch = originalFetch;

    console.log('--- Cleaning Up Test State ---');
    try {
      await sql`delete from public.message_log where group_id = ${GROUP_A}`;
      await sql`delete from public.groups where id = ${GROUP_A}`;
      await sql`delete from public.entities where id = ${E1}`;
      await sql`delete from auth.users where id = ${USER_A}`;
    } catch (e) {
      console.error('Failed to clean up test fixtures:', e);
    }

    await sql.end();
  }
}

main().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
