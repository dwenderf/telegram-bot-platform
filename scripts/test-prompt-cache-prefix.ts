// Adversarial Test Suite for Prompt-Cache Prefix Fix
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-prompt-cache-prefix.ts

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { setMockCallModel, CallModelInput, CallModelResult } from '../lib/anthropic';
import { answerQuestion } from '../lib/capabilities';
import { validateConfig, getModelIdentifier } from '../lib/config';

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  let sql: postgres.Sql | null = null;
  let botSql: postgres.Sql | null = null;

  const USER_A = 'aa300000-0000-0000-0000-000000000000';
  const E1 = 'eb300000-0000-0000-0000-000000000001';
  const GROUP_A = 'fb300000-0000-0000-0000-000000000000';
  const CHAT_A = -100333444555;
  const DOC_ID_1 = 'dc100000-0000-0000-0000-000000000001';
  const DOC_ID_2 = 'dc100000-0000-0000-0000-000000000002';

  const capturedCalls: CallModelInput[] = [];
  let nextMockText = 'Mock answer text';
  let mockMaxTokensUsed: number | null = null;

  // Setup Anthropic model mock to capture prompts
  setMockCallModel(async (input) => {
    capturedCalls.push(input);
    const config = require('../lib/config');
    mockMaxTokensUsed = config.getModelMaxOutputTokens();
    return {
      text: nextMockText,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: input.model,
      requestId: 'req-cache-123',
      stopReason: 'end_turn',
    };
  });

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('ADMIN_DATABASE_URL and DATABASE_URL env vars must be set');
    }

    sql = postgres(adminUrl);
    botSql = postgres(botUrl);

    console.log('--- Cleaning Up Stale Test State ---');
    await sql`delete from public.manifest_entries where entity_id = ${E1}`;
    await sql`delete from public.doc_cache where entity_id = ${E1}`;
    await sql`delete from public.message_log where entity_id = ${E1}`;
    await sql`delete from public.threads where entity_id = ${E1}`;
    await sql`delete from public.groups where entity_id = ${E1}`;
    await sql`delete from public.entities where id = ${E1}`;
    await sql`delete from auth.users where id = ${USER_A}`;

    console.log('--- Seeding Test Fixtures ---');
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_prompt_cache@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username) values (${E1}, 'entity-prompt-cache-e1', 'Prompt Cache Entity 1', ${USER_A}, 'cache_bot')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Group A')`;
    await sql`insert into public.threads (entity_id, group_id, telegram_thread_id) values (${E1}, ${GROUP_A}, 42)`;

    // Seed doc context
    await sql`insert into public.doc_cache (id, entity_id, display_name, content) values
  (${DOC_ID_1}, ${E1}, 'test-a.md', 'Mock grounded doc content: KenntnisBot is awesome.'),
  (${DOC_ID_2}, ${E1}, 'test-b.md', 'Second doc content: platform bot is leguan.')`;
    await sql`insert into public.manifest_entries (entity_id, group_id, doc_id) values
  (${E1}, ${GROUP_A}, ${DOC_ID_1}),
  (${E1}, ${GROUP_A}, ${DOC_ID_2})`;

    // Seed initial message_log
    await sql`insert into public.message_log (entity_id, group_id, telegram_chat_id, telegram_thread_id, username, message_text, is_bot_response)
              values (${E1}, ${GROUP_A}, ${CHAT_A}, 42, 'Tester', 'message 1', false)`;

    // Save original env values
    const originalModelIdentifier = process.env.MODEL_IDENTIFIER;
    const originalMaxTokens = process.env.MODEL_MAX_OUTPUT_TOKENS;
    const originalHistoryLimit = process.env.CONTEXT_MESSAGE_HISTORY_LIMIT;

    // Ensure we start with standard values
    process.env.MODEL_IDENTIFIER = 'claude-sonnet-5';
    delete process.env.MODEL_MAX_OUTPUT_TOKENS;
    delete process.env.CONTEXT_MESSAGE_HISTORY_LIMIT;

    // =========================================================================
    // Test 1: Docs in system, history not in system
    // =========================================================================
    console.log('Test 1: Verifying docs in systemPrompt, history not in systemPrompt...');
    capturedCalls.length = 0;
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'What is the capital of France?',
    });

    assert.strictEqual(capturedCalls.length, 1);
    const call1 = capturedCalls[0];
    assert.ok(call1.systemPrompt.includes('Mock grounded doc content: KenntnisBot is awesome.'), 'systemPrompt should contain doc context');
    assert.ok(!call1.systemPrompt.includes('message 1'), 'systemPrompt should NOT contain history');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: History reaches the model
    // =========================================================================
    console.log('Test 2: Verifying history reaches the model in userMessage...');
    assert.ok(call1.userMessage.includes('Tester: message 1'), 'userMessage should contain history');
    assert.ok(call1.userMessage.includes('What is the capital of France?'), 'userMessage should contain current question');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: Stable prefix across turns (regression guard)
    // =========================================================================
    console.log('Test 3: Verifying stable prefix across turns...');
    // Add a new message to the log to change recentConversation
    await sql`insert into public.message_log (entity_id, group_id, telegram_chat_id, telegram_thread_id, username, message_text, is_bot_response)
              values (${E1}, ${GROUP_A}, ${CHAT_A}, 42, 'Tester', 'message 2', false)`;

    capturedCalls.length = 0;
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'What is the capital of Germany?',
    });

    assert.strictEqual(capturedCalls.length, 1);
    const call2 = capturedCalls[0];

    // Assert system prompts are byte-identical
    assert.strictEqual(call1.systemPrompt, call2.systemPrompt, 'Test 3 Failed: systemPrompt changed between turns');
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Prior answer never in the prefix
    // =========================================================================
    console.log('Test 4: Verifying prior answer is never in systemPrompt prefix...');
    assert.ok(!call2.systemPrompt.includes(nextMockText), 'systemPrompt should not contain prior answer text');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: History-dependent question is answerable
    // =========================================================================
    console.log('Test 5: Verifying history-dependent question receives context...');
    assert.ok(call2.userMessage.includes('message 2'), 'userMessage should contain latest message 2 history');
    assert.ok(call2.userMessage.includes('German'), 'German question is in userMessage');
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: Config defaults + robust parse
    // =========================================================================
    console.log('Test 6: Verifying config defaults & robust parse...');

    // 6a: Custom clean configuration values
    process.env.MODEL_MAX_OUTPUT_TOKENS = '1234';
    process.env.CONTEXT_MESSAGE_HISTORY_LIMIT = '1';
    capturedCalls.length = 0;
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'Testing custom values',
    });
    assert.strictEqual(capturedCalls.length, 1);
    assert.strictEqual(mockMaxTokensUsed, 1234, 'Expected custom model max tokens to be used');
    // History limit is 1, so only 'message 2' should be in the userMessage (message 1 is omitted)
    assert.ok(capturedCalls[0].userMessage.includes('message 2'));
    assert.ok(!capturedCalls[0].userMessage.includes('message 1'));

    // 6b: Malformed values (must fall back to defaults: 2048 / 30)
    process.env.MODEL_MAX_OUTPUT_TOKENS = 'abc';
    process.env.CONTEXT_MESSAGE_HISTORY_LIMIT = '-5';
    capturedCalls.length = 0;
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'Testing malformed values',
    });
    assert.strictEqual(capturedCalls.length, 1);
    assert.strictEqual(mockMaxTokensUsed, 2048, 'Expected fallback to max tokens default 2048');
    // History limit falls back to 30, so both messages should be present
    assert.ok(capturedCalls[0].userMessage.includes('message 1'));
    assert.ok(capturedCalls[0].userMessage.includes('message 2'));

    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: Required-config validator fails fast
    // =========================================================================
    console.log('Test 7: Verifying required-config validator fails fast...');
    // Temporarily delete MODEL_IDENTIFIER
    delete process.env.MODEL_IDENTIFIER;

    // Clear validation status
    const configModule = require('../lib/config');
    // Reset private validation flag by reloading/re-requiring config or deleting cached require
    delete require.cache[require.resolve('../lib/config')];
    const reloadedConfig = require('../lib/config');

    assert.throws(
      () => {
        reloadedConfig.getModelIdentifier();
      },
      (err: any) => {
        return err.message.includes('MODEL_IDENTIFIER');
      },
      'Expected validator to throw error containing MODEL_IDENTIFIER'
    );

    // Restore it
    process.env.MODEL_IDENTIFIER = 'claude-sonnet-5';
    delete require.cache[require.resolve('../lib/config')];
    const reloadedConfig2 = require('../lib/config');
    assert.strictEqual(reloadedConfig2.getModelIdentifier(), 'claude-sonnet-5');
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: No orphaned references
    // =========================================================================
    console.log('Test 8: Verifying no orphaned references in runtime files...');
    const searchDirs = ['lib', 'app'];
    const orphanedTokens = ['process.env.ANTHROPIC_MODEL', "'claude-sonnet-4-6'"];

    for (const dir of searchDirs) {
      const dirPath = path.join(__dirname, '..', dir);
      if (!fs.existsSync(dirPath)) continue;

      const files = getFilesRecursive(dirPath);
      for (const file of files) {
        if (file.endsWith('.d.ts') || file.endsWith('.test.ts') || file.includes('test-prompt-cache-prefix')) {
          continue;
        }
        const content = fs.readFileSync(file, 'utf8');
        for (const token of orphanedTokens) {
          if (content.includes(token)) {
            assert.fail(`Test 8 Failed: Found orphaned reference "${token}" in file: ${file}`);
          }
        }
      }
    }
    console.log('✅ Test 8 Passed.');

    // Restore original env variables
    if (originalModelIdentifier) process.env.MODEL_IDENTIFIER = originalModelIdentifier;
    else delete process.env.MODEL_IDENTIFIER;

    if (originalMaxTokens) process.env.MODEL_MAX_OUTPUT_TOKENS = originalMaxTokens;
    else delete process.env.MODEL_MAX_OUTPUT_TOKENS;

    if (originalHistoryLimit) process.env.CONTEXT_MESSAGE_HISTORY_LIMIT = originalHistoryLimit;
    else delete process.env.CONTEXT_MESSAGE_HISTORY_LIMIT;

    console.log('\n🎉 ALL PROMPT CACHE PREFIX HARNESS TESTS PASSED SUCCESSFULLY! 🎉');

  } catch (error) {
    console.error('\n❌ Verification Failed:');
    console.error(error);
    process.exit(1);
  } finally {
    console.log('\n--- Cleaning Up Test State ---');
    if (sql) {
      try {
        await sql`delete from public.manifest_entries where entity_id = ${E1}`;
        await sql`delete from public.doc_cache where entity_id = ${E1}`;
        await sql`delete from public.message_log where entity_id = ${E1}`;
        await sql`delete from public.threads where entity_id = ${E1}`;
        await sql`delete from public.groups where entity_id = ${E1}`;
        await sql`delete from public.entities where id = ${E1}`;
        await sql`delete from auth.users where id = ${USER_A}`;
      } catch (cleanupErr) {
        console.warn('Teardown cleanup warning:', cleanupErr);
      }
    }
    if (sql) await sql.end();
    if (botSql) await botSql.end();
  }
}

function getFilesRecursive(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFilesRecursive(filePath));
    } else {
      results.push(filePath);
    }
  });
  return results;
}

main();
