// Test suite for Phase 5 Model-Call Usage Logging
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-model-call-logging.ts

process.env.ANTHROPIC_API_KEY = 'dummy-test-key';

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { setMockCallModel } from '../lib/anthropic';
import { answerQuestion, recapConversation } from '../lib/capabilities';

// Setup environment variables for testing
process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

// Global mock metrics we can update during tests
let mockUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};
let mockModel = 'claude-3-5-sonnet-20241022';
let mockRequestId = 'req-123';
let mockStopReason = 'end_turn';
let lastInput: any = null;

setMockCallModel(async (input) => {
  lastInput = input;
  return {
    text: 'This is a mock response.',
    usage: { ...mockUsage },
    model: mockModel,
    requestId: mockRequestId,
    stopReason: mockStopReason,
  };
});

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  let sql: postgres.Sql | null = null;
  let botSql: postgres.Sql | null = null;

  // Test state UUIDs
  const USER_A = 'a3000000-0000-0000-0000-000000000000';
  const E1 = 'e3300000-0000-0000-0000-000000000000';
  const E2 = 'e3400000-0000-0000-0000-000000000000'; // For RLS isolation checks
  const BOT_A = 'ba300000-0000-0000-0000-000000000000';
  const GROUP_A = 'fa300000-0000-0000-0000-000000000000';
  const CHAT_A = -100333444555;

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('ADMIN_DATABASE_URL and DATABASE_URL env vars must be set');
    }

    sql = postgres(adminUrl);
    botSql = postgres(botUrl);

    console.log('--- Applying Migration 20260702000000_model_calls_logging.sql ---');
    const migrationPath = path.join(__dirname, '../supabase/migrations/20260702000000_model_calls_logging.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await sql.unsafe(migrationSql);

    console.log('--- Cleaning Up Stale Test State ---');
    await sql`delete from public.model_calls where entity_id in (${E1}, ${E2})`;

    console.log('--- Seeding Test Fixtures ---');
    await sql`delete from public.message_log where entity_id in (${E1}, ${E2})`;
    await sql`delete from public.bot_entities where bot_id = ${BOT_A}`;
    await sql`delete from public.threads where entity_id in (${E1}, ${E2})`;
    await sql`delete from public.groups where entity_id in (${E1}, ${E2})`;
    await sql`delete from public.bots where id = ${BOT_A}`;
    await sql`delete from public.entities where id in (${E1}, ${E2})`;
    await sql`delete from auth.users where id = ${USER_A}`;

    // Create user, bots & entities
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_phase5@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status) values (${BOT_A}, 'Phase 5 Bot', 'phase5_bot_slug', 'phase5_bot_uname', 'token-id-a', 'secret-id-a', 'active')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username) values (${E1}, 'entity-phase5-e1', 'Phase 5 Entity 1', ${USER_A}, 'phase5_bot')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username) values (${E2}, 'entity-phase5-e2', 'Phase 5 Entity 2', ${USER_A}, 'phase5_bot_2')`;

    // Create group & thread
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Group A')`;
    const threadRow = await sql<{ id: string }[]>`insert into public.threads (entity_id, group_id, telegram_thread_id) values (${E1}, ${GROUP_A}, 42) returning id`;
    const threadUuid = threadRow[0].id;

    // Seed some message_log entries for recap
    await sql`insert into public.message_log (entity_id, group_id, telegram_chat_id, telegram_thread_id, username, message_text, is_bot_response) values (${E1}, ${GROUP_A}, ${CHAT_A}, 42, 'tester', 'Hello recap test.', false)`;

    // =========================================================================
    // Test 1: Answer path logs a row
    // =========================================================================
    console.log('Test 1: Verifying answerQuestion logs to model_calls...');
    mockUsage = { input_tokens: 150, output_tokens: 75, cache_read_tokens: 0, cache_creation_tokens: 0 };
    mockModel = 'claude-3-5-sonnet-20241022';

    const { text } = await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'Testing model usage logging',
      botId: BOT_A,
    });
    assert.strictEqual(text, 'This is a mock response.');
    assert.strictEqual(lastInput.cacheable, true, 'Answer path must pass cacheable: true');

    // Query ledger directly
    const calls1 = await sql`select * from public.model_calls where entity_id = ${E1} and bot_id = ${BOT_A}`;
    assert.strictEqual(calls1.length, 1, 'Should have inserted exactly 1 ledger row with bot_id');
    assert.strictEqual(calls1[0].call_type, 'answer');
    assert.strictEqual(calls1[0].input_tokens, 150);
    assert.strictEqual(calls1[0].output_tokens, 75);
    assert.strictEqual(calls1[0].model, 'claude-3-5-sonnet-20241022');
    assert.strictEqual(calls1[0].group_id, GROUP_A);
    assert.strictEqual(calls1[0].thread_id, threadUuid);
    assert.strictEqual(calls1[0].bot_id, BOT_A);
    assert.strictEqual(calls1[0].provider, 'anthropic', 'Provider must be resolved from provider.name');
    assert.strictEqual(calls1[0].metadata.requestId, 'req-123');
    assert.strictEqual(calls1[0].metadata.stopReason, 'end_turn');
    assert.strictEqual(calls1[0].metadata.telegramThreadId, 42);
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 1b: Null-safety check (missing botId logs NULL and succeeds)
    // =========================================================================
    console.log('Test 1b: Verifying answerQuestion is null-safe when botId is absent...');
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'Testing null-safety',
      // botId is omitted
    });

    const calls1b = await sql`select * from public.model_calls where entity_id = ${E1} and bot_id is null`;
    assert.strictEqual(calls1b.length, 1, 'Should have logged a row with NULL bot_id');
    console.log('✅ Test 1b Passed.');

    // =========================================================================
    // Test 2: Recap path logs a row
    // =========================================================================
    console.log('Test 2: Verifying recapConversation logs to model_calls...');
    mockUsage = { input_tokens: 220, output_tokens: 110, cache_read_tokens: 0, cache_creation_tokens: 0 };

    await recapConversation({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      limit: 10,
      botId: BOT_A,
    });

    const calls2 = await sql`select * from public.model_calls where entity_id = ${E1} and call_type = 'recap' and bot_id = ${BOT_A}`;
    assert.strictEqual(calls2.length, 1);
    assert.strictEqual(calls2[0].input_tokens, 220);
    assert.strictEqual(calls2[0].output_tokens, 110);
    assert.strictEqual(calls2[0].bot_id, BOT_A);
    assert.strictEqual(calls2[0].provider, 'anthropic', 'Provider must be resolved from provider.name');
    assert.strictEqual(lastInput.cacheable, false, 'Recap path must pass cacheable: false');
    assert.ok(lastInput.systemPrompt.includes('summarizing a team chat conversation'), 'Recap systemPrompt must remain fully intact');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: Prompt Caching tokens captured
    // =========================================================================
    console.log('Test 3: Verifying prompt cache metrics capture...');
    mockUsage = { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 800, cache_creation_tokens: 200 };

    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'Cache check',
    });

    const calls3 = await sql`select * from public.model_calls where entity_id = ${E1} order by created_at desc limit 1`;
    assert.strictEqual(calls3[0].cache_read_tokens, 800);
    assert.strictEqual(calls3[0].cache_creation_tokens, 200);
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Absent Cache Fields yield 0, not error
    // =========================================================================
    console.log('Test 4: Verifying missing cache fields default to 0...');
    // Simulated behavior if SDK omissions return undefined/null
    mockUsage = { input_tokens: 120, output_tokens: 60, cache_read_tokens: undefined as any, cache_creation_tokens: undefined as any };

    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'Undefined cache check',
    });

    const calls4 = await sql`select * from public.model_calls where entity_id = ${E1} order by created_at desc limit 1`;
    assert.strictEqual(calls4[0].cache_read_tokens, 0, 'Should fall back to 0');
    assert.strictEqual(calls4[0].cache_creation_tokens, 0, 'Should fall back to 0');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: Tenant RLS isolation
    // =========================================================================
    console.log('Test 5: Verifying RLS isolation on model_calls...');
    // Try querying as bot_service role with current entity set to E1
    const serviceSql = postgres(botUrl);
    
    await serviceSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E1}, true)`;
      const clientRowsE1 = await tx`select * from public.model_calls`;
      assert.ok(clientRowsE1.length > 0);
    });

    // Switch entity to E2
    await serviceSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E2}, true)`;
      const clientRowsE2 = await tx`select * from public.model_calls`;
      assert.strictEqual(clientRowsE2.length, 0, 'Entity E2 must not see Entity E1 usage records');
    });

    // Test 5b: Forged cross-entity insert under RLS (with check)
    let insertFailed = false;
    await serviceSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E1}, true)`;
      try {
        await tx`
          insert into public.model_calls (entity_id, call_type, model, provider)
          values (${E2}::uuid, 'answer', 'model', 'anthropic')
        `;
      } catch (e: any) {
        if (/violates row-level security policy/i.test(e.message)) {
          insertFailed = true;
        }
        throw e;
      }
    }).catch(() => {
      // Swallowed since the transaction rollback is expected when the query throws
    });
    assert.ok(insertFailed, 'Forged insert must violate RLS policy');

    await serviceSql.end();
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: on delete set null for groups/threads vs cascade for entities
    // =========================================================================
    console.log('Test 6: Verifying delete actions (set null vs cascade)...');
    // Clear all entries and seed a fresh row
    await sql`delete from public.model_calls where entity_id = ${E1}`;
    mockUsage = { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 };
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'Persistence check',
    });

    // Delete thread and group
    await sql`delete from public.threads where id = ${threadUuid}`;
    await sql`delete from public.groups where id = ${GROUP_A}`;

    // Confirm that the model_calls entry still exists but thread_id and group_id are set to null
    const calls6 = await sql`select * from public.model_calls where entity_id = ${E1}`;
    assert.strictEqual(calls6.length, 1);
    assert.strictEqual(calls6[0].group_id, null, 'group_id should be set null on delete');
    assert.strictEqual(calls6[0].thread_id, null, 'thread_id should be set null on delete');

    // Cascade delete: delete entity E1
    await sql`delete from public.entities where id = ${E1}`;
    const calls6_cascade = await sql`select * from public.model_calls where entity_id = ${E1}`;
    assert.strictEqual(calls6_cascade.length, 0, 'Ledger rows must be cascaded/purged when parent entity is deleted');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: Logging Failure Isolation
    // =========================================================================
    console.log('Test 7: Verifying logging failure isolation...');
    // Seed Entity E1 again for the test
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username) values (${E1}, 'entity-phase5-e1', 'Phase 5 Entity 1', ${USER_A}, 'phase5_bot')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Group A')`;

    // Apply check constraint to model_calls that fails on input_tokens < 1000 (not valid avoids validating existing rows)
    await sql`alter table public.model_calls add constraint test_fail check (input_tokens > 1000) not valid`;

    mockUsage = { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 };

    // This call will fail to log (input_tokens = 100 < 1000), but must not throw or block the return
    const res7 = await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      question: 'Constraint failure check',
    });
    assert.strictEqual(res7.text, 'This is a mock response.', 'Answer should be successfully returned despite logging error');

    // Clean up constraint in test body (also handled in finally)
    await sql`alter table public.model_calls drop constraint if exists test_fail`;
    console.log('✅ Test 7 Passed.');

    console.log('\n🎉 ALL PHASE 5 MODEL-CALL LOGGING HARNESS TESTS PASSED SUCCESSFULLY! 🎉\n');

  } catch (error) {
    console.error('\n❌ Verification Failed:');
    console.error(error);
    process.exit(1);
  } finally {
    console.log('--- Cleaning Up Test State ---');
    if (sql) {
      try {
        await sql`alter table public.model_calls drop constraint if exists test_fail`;
      } catch (e) {}
      try {
        await sql`delete from public.model_calls where entity_id in (${E1}, ${E2})`;
        await sql`delete from public.message_log where entity_id in (${E1}, ${E2})`;
        await sql`delete from public.bot_entities where bot_id = ${BOT_A}`;
        await sql`delete from public.threads where entity_id in (${E1}, ${E2})`;
        await sql`delete from public.groups where entity_id in (${E1}, ${E2})`;
        await sql`delete from public.bots where id = ${BOT_A}`;
        await sql`delete from public.entities where id in (${E1}, ${E2})`;
        await sql`delete from auth.users where id = ${USER_A}`;
        await sql`delete from vault.secrets where name in ('bot_a_token_phase5', 'bot_a_webhook_phase5')`;
        await sql.end();
      } catch (e) {
        console.warn('Cleanup failed:', e);
      }
    }
    if (botSql) {
      try {
        await botSql.end();
      } catch (e) {
        console.warn('Bot sql close failed:', e);
      }
    }
  }
}

main();
