// Test suite for Thread & Group Registry
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-thread-registry.ts

import assert from 'assert';
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { withTenantContext } from '../lib/supabase';
import { POST } from '../app/api/webhooks/platform/[botSlug]/route';
import { logMessage, registerThread } from '../lib/capabilities';

// Setup environment variables for testing
process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

async function main() {
  console.log('--- Starting Thread & Group Registry Test Suite ---');

  const adminUrl = process.env.ADMIN_DATABASE_URL || '';
  if (!adminUrl) {
    throw new Error('ADMIN_DATABASE_URL env var must be set');
  }
  const sql = postgres(adminUrl);

  // Apply migration
  console.log('--- Applying Migration Schema ---');
  const migrationPath = path.join(__dirname, '../supabase/migrations/20260709000000_thread_registry_columns.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  await sql.unsafe(migrationSql);

  const USER_A = '11a00000-0000-0000-0000-000000000000';
  const E1 = '11b00000-0000-0000-0000-000000000001';
  const GROUP_A = '11c00000-0000-0000-0000-000000000002';
  const BOT_A = '11d00000-0000-0000-0000-000000000003';
  const CHAT_ID_A = 12345678;
  const BOT_TOKEN_A = 'dummy-bot-token-12345';
  const BOT_USERNAME_A = 'platform_test_registry_bot';
  const WEBHOOK_SECRET_A = 'super-secret-webhook-key-1234';

  try {
    // 0. Clean up any stale state first
    await sql`delete from public.threads where group_id = ${GROUP_A}::uuid`;
    await sql`delete from public.message_log where group_id = ${GROUP_A}::uuid`;
    await sql`delete from public.telegram_events where bot_slug = ${BOT_USERNAME_A}`;
    await sql`delete from public.bot_entities where bot_id = ${BOT_A}::uuid`;
    await sql`delete from public.bots where id = ${BOT_A}::uuid`;
    await sql`delete from public.groups where id = ${GROUP_A}::uuid`;
    await sql`delete from public.entities where id = ${E1}::uuid`;
    await sql`delete from auth.users where id = ${USER_A}::uuid`;
    await sql`delete from vault.secrets where name in ('bot_registry_token', 'bot_registry_webhook')`;

    // Create Vault secrets for platform bots
    const sA1 = await sql<{ id: string }[]>`select vault.create_secret(${BOT_TOKEN_A}, 'bot_registry_token') as id`;
    const sA2 = await sql<{ id: string }[]>`select vault.create_secret(${WEBHOOK_SECRET_A}, 'bot_registry_webhook') as id`;
    const secretA1 = sA1[0]?.id;
    const secretA2 = sA2[0]?.id;

    // Seed test fixtures
    await sql`
      insert into auth.users (id, email)
      values (${USER_A}, 'test-registry@example.com')
    `;

    await sql`
      insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
      values (${E1}, 'entity-registry-test', 'Registry Entity', ${USER_A}, ${BOT_USERNAME_A})
    `;

    await sql`
      insert into public.groups (id, entity_id, telegram_chat_id, display_name)
      values (${GROUP_A}, ${E1}, ${CHAT_ID_A.toString()}, 'Initial Group Name')
    `;

    await sql`
      insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status)
      values (${BOT_A}, 'Registry Bot', ${BOT_USERNAME_A}, ${BOT_USERNAME_A}, ${secretA1}, ${secretA2}, 'active')
    `;

    await sql`
      insert into public.bot_entities (bot_id, entity_id)
      values (${BOT_A}, ${E1})
    `;

    console.log('Test fixtures seeded.');

    // =========================================================================
    // Test 1: Existence from an ordinary message (Capability check)
    // =========================================================================
    console.log('Test 1: Verifying thread existence row creation on ordinary message...');
    await logMessage({
      entityId: E1,
      groupId: GROUP_A,
      telegramChatId: CHAT_ID_A,
      telegramThreadId: 9999,
      telegramUserId: 1111,
      username: 'user_a',
      messageText: 'Hello ordinary message',
      isCommand: false,
      isBotMention: false,
    });

    const thread1 = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id = 9999
    `;
    assert.strictEqual(thread1.length, 1);
    assert.strictEqual(thread1[0].name, null);
    assert.strictEqual(thread1[0].icon_color, null);
    assert.strictEqual(thread1[0].icon_custom_emoji_id, null);
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: Existence is idempotent (Capability check)
    // =========================================================================
    console.log('Test 2: Verifying registerThread idempotency...');
    await logMessage({
      entityId: E1,
      groupId: GROUP_A,
      telegramChatId: CHAT_ID_A,
      telegramThreadId: 9999,
      telegramUserId: 1111,
      username: 'user_a',
      messageText: 'Hello second message same thread',
      isCommand: false,
      isBotMention: false,
    });

    const threads = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id = 9999
    `;
    assert.strictEqual(threads.length, 1, 'Idempotent: exactly one row must exist');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: Creation event sets name/icon (Capability check)
    // =========================================================================
    console.log('Test 3: Verifying creation event captures name and icon...');
    await withTenantContext(E1, async (tx) => {
      await registerThread(tx, {
        entityId: E1,
        groupId: GROUP_A,
        telegramThreadId: 8888,
        name: 'New Topic Name',
        iconColor: 12345,
        iconCustomEmojiId: 'custom-emoji-123',
      });
    });

    const thread3 = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id = 8888
    `;
    assert.strictEqual(thread3.length, 1);
    assert.strictEqual(thread3[0].name, 'New Topic Name');
    assert.strictEqual(thread3[0].icon_color, 12345);
    assert.strictEqual(thread3[0].icon_custom_emoji_id, 'custom-emoji-123');
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Rename updates name (Capability check)
    // =========================================================================
    console.log('Test 4: Verifying rename updates topic name while preserving icon...');
    await withTenantContext(E1, async (tx) => {
      await registerThread(tx, {
        entityId: E1,
        groupId: GROUP_A,
        telegramThreadId: 8888,
        name: 'Renamed Topic Name',
      });
    });

    const thread4 = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id = 8888
    `;
    assert.strictEqual(thread4.length, 1);
    assert.strictEqual(thread4[0].name, 'Renamed Topic Name');
    assert.strictEqual(thread4[0].icon_color, 12345, 'icon_color must remain unchanged');
    assert.strictEqual(thread4[0].icon_custom_emoji_id, 'custom-emoji-123', 'icon_custom_emoji_id must remain unchanged');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: Stale reply-to is ignored (Capability check)
    // =========================================================================
    console.log('Test 5: Verifying stale reply-to does not clobber existing details...');
    await withTenantContext(E1, async (tx) => {
      await registerThread(tx, {
        entityId: E1,
        groupId: GROUP_A,
        telegramThreadId: 8888,
      });
    });

    const thread5 = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id = 8888
    `;
    assert.strictEqual(thread5.length, 1);
    assert.strictEqual(thread5[0].name, 'Renamed Topic Name');
    assert.strictEqual(thread5[0].icon_color, 12345);
    assert.strictEqual(thread5[0].icon_custom_emoji_id, 'custom-emoji-123');
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: Icon-only edit & empty string normalization (Capability check)
    // =========================================================================
    console.log('Test 6: Verifying icon-only edit and empty string normalization...');
    await withTenantContext(E1, async (tx) => {
      await registerThread(tx, {
        entityId: E1,
        groupId: GROUP_A,
        telegramThreadId: 8888,
        iconCustomEmojiId: 'new-emoji-777',
      });
    });

    const thread6a = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id = 8888
    `;
    assert.strictEqual(thread6a[0].name, 'Renamed Topic Name');
    assert.strictEqual(thread6a[0].icon_custom_emoji_id, 'new-emoji-777');

    // Normalization test: "" is treated as null, so it does NOT clobber the new-emoji-777 (due to coalesce)
    await withTenantContext(E1, async (tx) => {
      await registerThread(tx, {
        entityId: E1,
        groupId: GROUP_A,
        telegramThreadId: 8888,
        iconCustomEmojiId: '',
      });
    });

    const thread6b = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id = 8888
    `;
    assert.strictEqual(thread6b[0].icon_custom_emoji_id, 'new-emoji-777', 'Empty string should be normalized to null and ignored by coalesce');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 8: General topic is a no-op (Capability check)
    // =========================================================================
    console.log('Test 8: Verifying General topic is a no-op...');
    await logMessage({
      entityId: E1,
      groupId: GROUP_A,
      telegramChatId: CHAT_ID_A,
      telegramThreadId: null,
      telegramUserId: 1111,
      username: 'user_a',
      messageText: 'General topic message',
      isCommand: false,
      isBotMention: false,
    });

    const generalThreads = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id is null
    `;
    assert.strictEqual(generalThreads.length, 0);
    console.log('✅ Test 8 Passed.');

    // =========================================================================
    // Test 7: Group rename (POST Webhook route check)
    // =========================================================================
    console.log('Test 7: Verifying group rename via new_chat_title POST webhook...');
    const renamePayload = {
      update_id: 10001,
      message: {
        message_id: 20001,
        chat: {
          id: CHAT_ID_A,
          type: 'supergroup',
        },
        date: 1700000000,
        new_chat_title: 'Updated Group Name Title',
      },
    };

    const request7 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(renamePayload),
      }
    );

    const response7 = await POST(request7, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response7.status, 200);

    const updatedGroup = await sql`
      select display_name from public.groups where id = ${GROUP_A}::uuid
    `;
    assert.strictEqual(updatedGroup[0].display_name, 'Updated Group Name Title');
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 9: Service messages route integration (POST Webhook route check)
    // =========================================================================
    console.log('Test 9: Verifying webhook handler service messages route integration...');
    const createdPayload = {
      update_id: 10002,
      message: {
        message_id: 20002,
        chat: {
          id: CHAT_ID_A,
          type: 'supergroup',
        },
        message_thread_id: 7777,
        date: 1700000000,
        forum_topic_created: {
          name: 'Webhook Route Topic Name',
          icon_color: 99999,
          icon_custom_emoji_id: 'custom-emoji-webhook',
        },
      },
    };

    const request9 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(createdPayload),
      }
    );

    const response9 = await POST(request9, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response9.status, 200);

    const thread9 = await sql`
      select * from public.threads where group_id = ${GROUP_A}::uuid and telegram_thread_id = 7777
    `;
    assert.strictEqual(thread9.length, 1);
    assert.strictEqual(thread9[0].name, 'Webhook Route Topic Name');
    assert.strictEqual(thread9[0].icon_color, 99999);
    assert.strictEqual(thread9[0].icon_custom_emoji_id, 'custom-emoji-webhook');
    console.log('✅ Test 9 Passed.');

    // =========================================================================
    // Test 10: Unbound chat is a no-op (POST Webhook route check)
    // =========================================================================
    console.log('Test 10: Verifying webhook handler ignores unbound chats...');
    const unboundPayload = {
      update_id: 10003,
      message: {
        message_id: 20003,
        chat: {
          id: 99999999,
          type: 'supergroup',
        },
        message_thread_id: 6666,
        date: 1700000000,
        forum_topic_created: {
          name: 'Unbound Topic',
          icon_color: 11111,
        },
      },
    };

    const request10 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(unboundPayload),
      }
    );

    const response10 = await POST(request10, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response10.status, 200);

    const unboundThreads = await sql`
      select * from public.threads where telegram_thread_id = 6666
    `;
    assert.strictEqual(unboundThreads.length, 0, 'No thread row should be registered for unbound chats');
    console.log('✅ Test 10 Passed.');

    console.log('🎉 ALL THREAD & GROUP REGISTRY TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    console.log('--- Cleaning Up Test State ---');
    try {
      await sql`delete from public.threads where group_id = ${GROUP_A}::uuid`;
      await sql`delete from public.message_log where group_id = ${GROUP_A}::uuid`;
      await sql`delete from public.telegram_events where bot_slug = ${BOT_USERNAME_A}`;
      await sql`delete from public.bot_entities where bot_id = ${BOT_A}::uuid`;
      await sql`delete from public.bots where id = ${BOT_A}::uuid`;
      await sql`delete from public.groups where id = ${GROUP_A}::uuid`;
      await sql`delete from public.entities where id = ${E1}::uuid`;
      await sql`delete from auth.users where id = ${USER_A}::uuid`;
      await sql`delete from vault.secrets where name in ('bot_registry_token', 'bot_registry_webhook')`;
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
