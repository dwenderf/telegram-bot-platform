process.env.ANTHROPIC_API_KEY = 'dummy-test-key';
process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { setMockCallModel } from '../lib/anthropic';
import { logMessage, updateLoggedMessage, buildContext, recapConversation } from '../lib/capabilities';

let lastUserMessage = '';

setMockCallModel(async (input) => {
  if (input?.userMessage) {
    lastUserMessage = input.userMessage;
  }
  return {
    text: 'This is a mock response.',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'claude-3-5-sonnet-20241022',
    requestId: 'req-123',
    stopReason: 'end_turn',
  };
});

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  let sql: postgres.Sql | null = null;
  let botSql: postgres.Sql | null = null;

  // Test state UUIDs
  const USER_A = 'ab400000-0000-0000-0000-000000000000';
  const E1 = 'eb400000-0000-0000-0000-000000000001';
  const GROUP_A = 'fb400000-0000-0000-0000-000000000000';
  const CHAT_A = -100444555666;

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('ADMIN_DATABASE_URL and DATABASE_URL env vars must be set');
    }

    sql = postgres(adminUrl);
    botSql = postgres(botUrl);

    console.log('--- Applying Migration 20260703010000_edited_message_sync.sql ---');
    const migrationPath = path.join(__dirname, '../supabase/migrations/20260703010000_edited_message_sync.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await sql.unsafe(migrationSql);

    console.log('--- Applying Migration 20260703020000_message_log_updated_at.sql ---');
    const migrationPath2 = path.join(__dirname, '../supabase/migrations/20260703020000_message_log_updated_at.sql');
    const migrationSql2 = fs.readFileSync(migrationPath2, 'utf8');
    await sql.unsafe(migrationSql2);

    console.log('--- Cleaning Up Stale Test State ---');
    await sql`delete from public.message_log where entity_id = ${E1}`;
    await sql`delete from public.groups where entity_id = ${E1}`;
    await sql`delete from public.entities where id = ${E1}`;
    await sql`delete from auth.users where id = ${USER_A}`;

    console.log('--- Seeding Test Fixtures ---');
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_edit_sync@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username) values (${E1}, 'entity-edit-sync-e1', 'Edit Sync Entity 1', ${USER_A}, 'edit_sync_bot')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Group A')`;
    await sql`insert into public.threads (entity_id, group_id, telegram_thread_id) values (${E1}, ${GROUP_A}, 42)`;

    // =========================================================================
    // Test 1: message_id is successfully stored
    // =========================================================================
    console.log('Test 1: Verifying telegram_message_id is stored and updated_at is NULL on insert...');
    await logMessage({
      entityId: E1,
      groupId: GROUP_A,
      telegramChatId: CHAT_A,
      telegramThreadId: 42,
      telegramUserId: 123,
      username: 'tester',
      messageText: 'original message content',
      isCommand: false,
      isBotMention: false,
      telegramMessageId: 9001,
    });

    // Seed a second message that we will never edit
    await logMessage({
      entityId: E1,
      groupId: GROUP_A,
      telegramChatId: CHAT_A,
      telegramThreadId: 42,
      telegramUserId: 123,
      username: 'tester',
      messageText: 'untouched message content',
      isCommand: false,
      isBotMention: false,
      telegramMessageId: 9003,
    });

    const rows1 = await sql`select * from public.message_log where entity_id = ${E1} and telegram_message_id = 9001`;
    assert.strictEqual(rows1.length, 1, 'Should have stored exactly 1 row with message_id 9001');
    assert.strictEqual(rows1[0].message_text, 'original message content');
    assert.strictEqual(rows1[0].updated_at, null, 'updated_at must be NULL on insert');

    const rowsUnedited1 = await sql`select * from public.message_log where entity_id = ${E1} and telegram_message_id = 9003`;
    assert.strictEqual(rowsUnedited1[0].updated_at, null, 'updated_at of untouched message must be NULL');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: Edit updates in place
    // =========================================================================
    console.log('Test 2: Verifying updateLoggedMessage updates in-place and sets updated_at...');
    const originalRowId = rows1[0].id;

    const updated = await updateLoggedMessage({
      entityId: E1,
      groupId: GROUP_A,
      telegramChatId: CHAT_A,
      telegramMessageId: 9001,
      newText: 'edited message content',
    });
    assert.ok(updated, 'updateLoggedMessage should return true (updated rows > 0)');

    const rows2 = await sql`select * from public.message_log where entity_id = ${E1} and telegram_message_id = 9001`;
    assert.strictEqual(rows2.length, 1, 'Only one row should exist with message_id 9001');
    assert.strictEqual(rows2[0].id, originalRowId, 'The row ID must remain the same (in-place update)');
    assert.strictEqual(rows2[0].message_text, 'edited message content', 'Text must reflect the edit');
    assert.ok(rows2[0].updated_at !== null, 'updated_at must NOT be NULL after edit');

    const rowsUnedited2 = await sql`select * from public.message_log where entity_id = ${E1} and telegram_message_id = 9003`;
    assert.strictEqual(rowsUnedited2[0].updated_at, null, 'updated_at of untouched message must remain NULL');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: Context and recap reflect the edit
    // =========================================================================
    console.log('Test 3: Verifying buildContext and recapConversation reflect the edit...');
    
    // Seed a doc context so buildContext runs cleanly
    const DOC_ID = 'dc400000-0000-0000-0000-000000000000';
    await sql`insert into public.doc_cache (id, entity_id, display_name, content) values (${DOC_ID}, ${E1}, 'doc.md', 'Grounded doc content.')`;
    await sql`insert into public.manifest_entries (entity_id, group_id, doc_id) values (${E1}, ${GROUP_A}, ${DOC_ID})`;

    const context = await buildContext(E1, GROUP_A, 42);
    assert.ok(context.recentConversation.includes('tester: edited message content'), 'buildContext history must reflect the edited text');
    assert.ok(!context.recentConversation.includes('original message content'), 'buildContext history must NOT show the original text');

    const recap = await recapConversation({
      entityId: E1,
      groupId: GROUP_A,
      threadId: 42,
      limit: 5,
    });
    assert.strictEqual(recap.text, 'This is a mock response.', 'recapConversation must execute successfully and return the mocked response');
    assert.ok(lastUserMessage.includes('tester: edited message content'), 'recapConversation transcript input must reflect the edited text');
    assert.ok(!lastUserMessage.includes('original message content'), 'recapConversation transcript input must NOT show the original text');
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Unmatched edit is a no-op
    // =========================================================================
    console.log('Test 4: Verifying unmatched edit is a silent no-op...');
    const updatedUnmatched = await updateLoggedMessage({
      entityId: E1,
      groupId: GROUP_A,
      telegramChatId: CHAT_A,
      telegramMessageId: 99999, // Doesn't exist
      newText: 'some random text',
    });
    assert.strictEqual(updatedUnmatched, false, 'Should return false (no rows updated)');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: Edit cannot touch a bot row
    // =========================================================================
    console.log('Test 5: Verifying edit cannot touch a bot-response row...');
    // Seed a bot response row (telegram_message_id = 9002, is_bot_response = true)
    await sql`
      insert into public.message_log (
        entity_id, group_id, telegram_chat_id, telegram_thread_id, 
        username, message_text, is_bot_response, telegram_message_id
      ) values (
        ${E1}, ${GROUP_A}, ${CHAT_A.toString()}, '42',
        'Bot', 'Bot original content', true, 9002
      )
    `;

    // Attempt edit targeting telegram_message_id = 9002. Since the query filters on
    // telegram_message_id = ${messageIdStr} and is_bot_response = false,
    // it will never match the bot row.
    const botBefore = await sql`select * from public.message_log where entity_id = ${E1} and is_bot_response = true and telegram_message_id = 9002`;
    assert.strictEqual(botBefore.length, 1);
    
    const updatedBot = await updateLoggedMessage({
      entityId: E1,
      groupId: GROUP_A,
      telegramChatId: CHAT_A,
      telegramMessageId: 9002,
      newText: 'Attempted bot overwrite',
    });
    assert.strictEqual(updatedBot, false, 'Should return false (no rows updated because it is a bot response)');

    const botAfter = await sql`select * from public.message_log where entity_id = ${E1} and is_bot_response = true and telegram_message_id = 9002`;
    assert.strictEqual(botAfter.length, 1);
    assert.strictEqual(botAfter[0].message_text, 'Bot original content', 'Bot response text must remain unchanged');
    console.log('✅ Test 5 Passed.');

    console.log('\n🎉 ALL Edited-Message Sync TESTS PASSED SUCCESSFULLY! 🎉\n');

  } finally {
    console.log('--- Cleaning Up Test State ---');
    if (sql) {
      await sql`delete from public.manifest_entries where entity_id = ${E1}`;
      await sql`delete from public.doc_cache where entity_id = ${E1}`;
      await sql`delete from public.message_log where entity_id = ${E1}`;
      await sql`delete from public.groups where entity_id = ${E1}`;
      await sql`delete from public.entities where id = ${E1}`;
      await sql`delete from auth.users where id = ${USER_A}`;
      await sql.end();
    }
    if (botSql) {
      await botSql.end();
    }
  }
}

main().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
