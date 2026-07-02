// Adversarial Test Suite for Phase 3 Bot Cutover
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-bot-cutover.ts

process.env.ANTHROPIC_API_KEY = 'dummy-test-key';

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { POST } from '../app/api/webhooks/platform/[botSlug]/route';
import { NextRequest } from 'next/server';
import { setMockCallModel } from '../lib/anthropic';

// Stub model call directly
setMockCallModel(async () => {
  return {
    text: 'This is a mock answer grounded in test docs.',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'claude-3-5-sonnet-20241022',
    requestId: 'req-123',
    stopReason: 'end_turn',
  };
});

let mockChatMemberStatus = 'administrator';
let sentMessages: any[] = [];
let sentReactions: any[] = [];

// Mock global fetch to intercept outbound Telegram API requests
const originalFetch = global.fetch;
global.fetch = (async (url: any, options: any) => {
  const urlStr = url.toString();
  if (urlStr.includes('api.telegram.org')) {
    if (urlStr.includes('getChatMember')) {
      return new Response(JSON.stringify({ ok: true, result: { status: mockChatMemberStatus } }), { status: 200 });
    }
    if (urlStr.includes('sendMessage')) {
      sentMessages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 12345 } }), { status: 200 });
    }
    if (urlStr.includes('setMessageReaction')) {
      sentReactions.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return originalFetch(url, options);
}) as any;

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  let sql: postgres.Sql | null = null;
  let botSql: postgres.Sql | null = null;

  // Test state UUIDs
  const USER_A = 'a0000000-0000-0000-0000-000000000000'; // Owner of E1
  const USER_B = 'b0000000-0000-0000-0000-000000000000'; // Owner of E2
  const STRANGER = 'c0000000-0000-0000-0000-000000000000'; // Stranger

  const E1 = 'e1000000-0000-0000-0000-000000000000';
  const E2 = 'e2000000-0000-0000-0000-000000000000';

  const BOT_A = 'ba000000-0000-0000-0000-000000000000';
  const BOT_B = 'bb000000-0000-0000-0000-000000000000';

  let secretA1: string | null = null;
  let secretA2: string | null = null;
  let secretB1: string | null = null;

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('Both ADMIN_DATABASE_URL and DATABASE_URL are required to run RLS verification tests.');
    }

    sql = postgres(adminUrl, { max: 10, prepare: false });
    botSql = postgres(botUrl, { max: 5, prepare: false });

    console.log('--- Applying Bot Cutover Additive Migration ---');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/20260629000000_bot_cutover_additive.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await sql.unsafe(migrationSql);

    console.log('--- Setting Up Test Environment ---');

    // Clean up stale rows & Vault secrets by name/reference
    await sql`delete from public.message_log where entity_id in (${E1}, ${E2})`;
    await sql`delete from public.bot_entities where bot_id in (${BOT_A}, ${BOT_B})`;
    await sql`delete from public.groups where entity_id in (${E1}, ${E2})`;
    await sql`delete from public.bots where id in (${BOT_A}, ${BOT_B})`;
    await sql`delete from public.entities where id in (${E1}, ${E2})`;
    await sql`delete from auth.users where id in (${USER_A}, ${USER_B}, ${STRANGER})`;
    await sql`delete from vault.secrets where name in ('bot_a_token', 'bot_a_webhook', 'bot_b_token')`;

    // Create Vault secrets for platform bots (B2)
    const sA1 = await sql<{ id: string }[]>`select vault.create_secret('token-secret-for-bot-a', 'bot_a_token') as id`;
    const sA2 = await sql<{ id: string }[]>`select vault.create_secret('webhook-secret-for-bot-a', 'bot_a_webhook') as id`;
    const sB1 = await sql<{ id: string }[]>`select vault.create_secret('token-secret-for-bot-b', 'bot_b_token') as id`;

    secretA1 = sA1[0]?.id;
    secretA2 = sA2[0]?.id;
    secretB1 = sB1[0]?.id;

    // Provision auth users
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_a@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_B}, 'owner_b@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${STRANGER}, 'stranger@test.com', now(), 'authenticated', 'authenticated')`;

    // Create entities
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E1}, 'entity-1-test', 'Entity 1', ${USER_A}, 'test_bot')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E2}, 'entity-2-test', 'Entity 2', ${USER_B}, 'test2_bot')`;

    // Create platform bots using Vault secrets UUID-as-text (B2)
    await sql`insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status)
              values (${BOT_A}, 'Platform Bot A', 'bot-a-slug', 'bot_a_username', ${secretA1}, ${secretA2}, 'active')`;
    await sql`insert into public.bots (id, name, slug, telegram_username, token_secret_ref, status)
              values (${BOT_B}, 'Platform Bot B', 'bot-b-slug', 'bot_b_username', ${secretB1}, 'active')`;

    // Link bots to entities
    await sql`insert into public.bot_entities (bot_id, entity_id) values (${BOT_A}, ${E1})`;
    await sql`insert into public.bot_entities (bot_id, entity_id) values (${BOT_A}, ${E2})`;

    // Bind E1 to chat 888001, E2 to chat 888002
    await sql`insert into public.groups (entity_id, telegram_chat_id, display_name) values (${E1}, 888001, 'Group 1')`;
    await sql`insert into public.groups (entity_id, telegram_chat_id, display_name) values (${E2}, 888002, 'Group 2')`;

    console.log('Setup completed. Running SQL-level security tests...\n');

    // =========================================================================
    // Security Test Case 1: Bot-Secret Decryption Own Secret (B2)
    // =========================================================================
    console.log('Test 1: Bot-secret decryption (decrypt own secret)...');
    const decryptedOwn = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_bot_id', ${BOT_A}, true)`;
      const res = await tx<{ get_current_bot_secret: string }[]>`
        select public.get_current_bot_secret(${secretA1})
      `;
      return res[0].get_current_bot_secret;
    });
    assert.strictEqual(decryptedOwn, 'token-secret-for-bot-a', 'Test 1 Failed: Decrypted token secret mismatch');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Security Test Case 2: Cross-Bot Read Prevention (Test 2 / B1)
    // =========================================================================
    console.log('Test 2: Cross-bot read prevention (A context cannot read B secret)...');
    const decryptedCross = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_bot_id', ${BOT_A}, true)`;
      const res = await tx<{ get_current_bot_secret: string }[]>`
        select public.get_current_bot_secret(${secretB1})
      `;
      return res[0].get_current_bot_secret;
    });
    assert.strictEqual(decryptedCross, null, 'Test 2 Failed: Bot A was able to read Bot B\'s secret');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Security Test Case 3: Defensive Cast mapping check (B1)
    // =========================================================================
    console.log('Test 3: Defensive Cast check on non-uuid strings...');
    const decryptedNonUuid = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_bot_id', ${BOT_A}, true)`;
      const res = await tx<{ get_current_bot_secret: string }[]>`
        select public.get_current_bot_secret('plain-text-credential-ref')
      `;
      return res[0].get_current_bot_secret;
    });
    assert.strictEqual(decryptedNonUuid, null, 'Test 3 Failed: Non-uuid ref did not return null');
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Security Test Case 4: resolve_entity_id_by_chat context-less resolution (S2)
    // =========================================================================
    console.log('Test 4: resolve_entity_id_by_chat runs with no entity context set...');
    // Connect as botSql (bot_service)
    const resolvedE1 = await botSql<{ resolve_entity_id_by_chat: string }[]>`
      select public.resolve_entity_id_by_chat(888001)
    `;
    assert.strictEqual(resolvedE1[0].resolve_entity_id_by_chat, E1, 'Test 4 Failed: Could not resolve entity for chat 888001');

    const resolvedE2 = await botSql<{ resolve_entity_id_by_chat: string }[]>`
      select public.resolve_entity_id_by_chat(888002)
    `;
    assert.strictEqual(resolvedE2[0].resolve_entity_id_by_chat, E2, 'Test 4 Failed: Could not resolve entity for chat 888002');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Security Test Case 5: Execute Grant Security (B1/S2)
    // =========================================================================
    console.log('Test 5: Execute grant security (authenticated role denied)...');
    try {
      await sql.begin(async (tx) => {
        await tx`set local role = 'authenticated'`;
        await tx`select public.get_current_bot_secret(${secretA1})`;
      });
      assert.fail('Test 5 Failed: Authenticated web user successfully called get_current_bot_secret');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 5 Failed: Expected execute deny (42501) for get_current_bot_secret');
    }

    try {
      await sql.begin(async (tx) => {
        await tx`set local role = 'authenticated'`;
        await tx`select public.resolve_entity_id_by_chat(888001)`;
      });
      assert.fail('Test 5 Failed: Authenticated web user successfully called resolve_entity_id_by_chat');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 5 Failed: Expected execute deny (42501) for resolve_entity_id_by_chat');
    }

    try {
      await sql.begin(async (tx) => {
        await tx`set local role = 'authenticated'`;
        await tx`select * from public.get_bot_config(${BOT_A})`;
      });
      assert.fail('Test 5 Failed: Authenticated web user successfully called get_bot_config');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 5 Failed: Expected execute deny (42501) for get_bot_config');
    }
    console.log('✅ Test 5 Passed.');

    console.log('\n🛡️ SECURITY-SPINE DB TESTS COMPLETED AND PASSED! 🛡️\n');

    // =========================================================================
    // Webhook/Handler Level Integration Tests
    // =========================================================================
    console.log('Running Webhook/Handler Level Integration Tests...');

    // Mock Vercel request context to capture waitUntil promises
    const pendingPromises: Promise<any>[] = [];
    globalThis[Symbol.for("@vercel/request-context") as any] = {
      get() {
        return {
          waitUntil(promise: Promise<any>) {
            pendingPromises.push(promise);
          }
        };
      }
    };

    // Test Case 6: Webhook-secret gate runs before entity resolution (S1)
    console.log('Test 6: Webhook-secret gate runs before entity resolution...');
    const req6 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000001,
        message: {
          message_id: 2001,
          chat: { id: 888001, type: 'supergroup', is_forum: true, title: 'Chat 1' },
          from: { id: 7777, username: 'tester' },
          text: '@bot_a_username hello test 6',
        },
      }),
    });

    const res6 = await POST(req6, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    assert.strictEqual(res6.status, 401, 'Test 6 Failed: Expected 401 status for forged secret token');

    // Assert that no message was logged and no groups row touched
    const logs6 = await sql`select * from public.message_log where telegram_chat_id = '888001' and message_text like '%test 6%'`;
    assert.strictEqual(logs6.length, 0, 'Test 6 Failed: Message logged despite authentication failure');
    console.log('✅ Test 6 Passed.');

    // Test Case 7: /auth binds from an unbound chat (S3)
    console.log('Test 7: /auth binds from an unbound chat (onboarding case with realistic supergroup ID)...');
    // First, verify chat -1001928374829 has no groups row
    const groupPre7 = await sql`select * from public.groups where telegram_chat_id = -1001928374829`;
    assert.strictEqual(groupPre7.length, 0, 'Test 7 Setup Error: Chat -1001928374829 is already bound');

    // Mint a code for E1
    const codeE1 = await sql.begin(async (tx) => {
      await tx`set local role = 'authenticated'`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_A, email: 'owner_a@test.com' })}, true)`;
      await tx`set local row_security = on`;
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E1})`;
      return res[0].mint_link_token;
    });

    mockChatMemberStatus = 'administrator';

    const req7 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-for-bot-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000002,
        message: {
          message_id: 2002,
          chat: { id: -1001928374829, type: 'supergroup', is_forum: true, title: 'Chat 3' },
          from: { id: 7777, username: 'tester' },
          text: `/auth ${codeE1}`,
        },
      }),
    });

    const res7 = await POST(req7, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    const res7Json = await res7.json();
    assert.strictEqual(res7.status, 200);
    assert.strictEqual(res7Json.msg, 'Auth command processed');

    // Assert that the group was created and bound to E1
    const groupPost7 = await sql`select * from public.groups where telegram_chat_id = -1001928374829`;
    assert.strictEqual(groupPost7.length, 1, 'Test 7 Failed: Group binding was not created');
    assert.strictEqual(groupPost7[0].entity_id, E1, 'Test 7 Failed: Bound to wrong entity');

    // S3 Follow-up: Resolve and answer E2E in this realistic supergroup chat_id (-1001928374829)
    sentMessages = [];
    pendingPromises.length = 0;

    const req7_2 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-for-bot-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000008,
        message: {
          message_id: 2008,
          chat: { id: -1001928374829, type: 'supergroup', is_forum: true, title: 'Chat 3' },
          from: { id: 7777, username: 'tester' },
          text: '@bot_a_username hello supergroup',
        },
      }),
    });

    const res7_2 = await POST(req7_2, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    assert.strictEqual(res7_2.status, 200);

    // Wait for the background answer resolution
    await Promise.all(pendingPromises);

    // Assert that response was sent to the large negative supergroup chat_id
    assert.strictEqual(sentMessages.length, 1, 'Test 7 Follow-up Failed: Bot reply not sent');
    assert.strictEqual(sentMessages[0].chat_id.toString(), '-1001928374829', 'Test 7 Follow-up Failed: Wrong chat_id in reply');

    // Assert it was logged under the correct entity E1
    const logE1_supergroup = await sql`
      select entity_id, telegram_chat_id 
      from public.message_log 
      where telegram_chat_id = '-1001928374829' and is_bot_response = true
    `;
    assert.strictEqual(logE1_supergroup.length, 1, 'Test 7 Follow-up Failed: Bot response not logged');
    assert.strictEqual(logE1_supergroup[0].entity_id, E1, 'Test 7 Follow-up Failed: Wrong entity_id in log');

    console.log('✅ Test 7 Passed.');

    // Test Case 8: Cross-entity correctness (Minor)
    console.log('Test 8: Cross-entity correctness (same platform bot resolves different entities)...');
    sentMessages = [];
    pendingPromises.length = 0;

    // Send mention in chat 888001 (E1)
    const req8_1 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-for-bot-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000003,
        message: {
          message_id: 2003,
          chat: { id: 888001, type: 'supergroup', is_forum: true, title: 'Chat 1' },
          from: { id: 7777, username: 'tester' },
          text: '@bot_a_username hello E1',
        },
      }),
    });

    const res8_1 = await POST(req8_1, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    assert.strictEqual(res8_1.status, 200);

    // Send mention in chat 888002 (E2)
    const req8_2 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-for-bot-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000004,
        message: {
          message_id: 2004,
          chat: { id: 888002, type: 'supergroup', is_forum: true, title: 'Chat 2' },
          from: { id: 7777, username: 'tester' },
          text: '@bot_a_username hello E2',
        },
      }),
    });

    const res8_2 = await POST(req8_2, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    assert.strictEqual(res8_2.status, 200);

    // Wait for async answer resolution
    await Promise.all(pendingPromises);

    // Assert that answers are logged under correct entities in message_log
    const logE1 = await sql`select * from public.message_log where telegram_chat_id = 888001 and is_bot_response = true`;
    const logE2 = await sql`select * from public.message_log where telegram_chat_id = 888002 and is_bot_response = true`;
    assert.ok(logE1.length >= 1, 'Test 8 Failed: Bot response not logged for E1');
    assert.ok(logE2.length >= 1, 'Test 8 Failed: Bot response not logged for E2');
    assert.strictEqual(logE1[0].entity_id, E1, 'Test 8 Failed: E1 response logged under wrong entity');
    assert.strictEqual(logE2[0].entity_id, E2, 'Test 8 Failed: E2 response logged under wrong entity');
    console.log('✅ Test 8 Passed.');

    // Test Case 9: Trigger model change
    console.log('Test 9: Trigger model change (/ask command ignored)...');
    sentMessages = [];
    pendingPromises.length = 0;

    const req9 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-for-bot-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000005,
        message: {
          message_id: 2005,
          chat: { id: 888001, type: 'supergroup', is_forum: true, title: 'Chat 1' },
          from: { id: 7777, username: 'tester' },
          text: '/ask what is this?',
        },
      }),
    });

    const res9 = await POST(req9, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    assert.strictEqual(res9.status, 200);

    // Wait for any async tasks
    await Promise.all(pendingPromises);

    // Confirm no message reaction or response sent
    assert.strictEqual(sentMessages.length, 0, 'Test 9 Failed: Sent message reply for /ask command');

    // Verify /ask was logged as normal chat message (not command, not bot response) (B2)
    const askLogs = await sql`
      select is_command, is_bot_response, is_bot_mention 
      from public.message_log 
      where telegram_chat_id = '888001' and message_text = '/ask what is this?'
    `;
    assert.strictEqual(askLogs.length, 1, 'Test 9 Failed: /ask message was not logged');
    assert.strictEqual(askLogs[0].is_command, false, 'Test 9 Failed: /ask logged as command');
    assert.strictEqual(askLogs[0].is_bot_response, false, 'Test 9 Failed: /ask logged as bot response');
    assert.strictEqual(askLogs[0].is_bot_mention, false, 'Test 9 Failed: /ask logged as bot mention');
    console.log('✅ Test 9 Passed.');

    // Test Case 10: Topic exclusion gate
    console.log('Test 10: Topic exclusion gate...');
    sentMessages = [];
    pendingPromises.length = 0;

    await sql`update public.entities set excluded_thread_ids = array[1234] where id = ${E1}`;

    const req10 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-for-bot-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000006,
        message: {
          message_id: 2006,
          message_thread_id: 1234,
          chat: { id: 888001, type: 'supergroup', is_forum: true, title: 'Chat 1' },
          from: { id: 7777, username: 'tester' },
          text: '@bot_a_username excluded topic?',
        },
      }),
    });

    const res10 = await POST(req10, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    assert.strictEqual(res10.status, 200);

    // Wait for any async task (though excluded should bail immediately)
    await Promise.all(pendingPromises);

    // Confirm that the bot returned the exclusion decline notice
    assert.strictEqual(sentMessages.length, 1, 'Test 10 Failed: Expected exactly 1 decline notice');
    assert.ok(sentMessages[0].text.includes('not configured to operate'), 'Test 10 Failed: Incorrect decline notice text');
    console.log('✅ Test 10 Passed.');

    // Test Case 11: processed_updates idempotency (Minor)
    console.log('Test 11: processed_updates idempotency (duplicate updates rejected)...');
    sentMessages = [];
    pendingPromises.length = 0;

    const req11_1 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-for-bot-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000007,
        message: {
          message_id: 2007,
          chat: { id: 888001, type: 'supergroup', is_forum: true, title: 'Chat 1' },
          from: { id: 7777, username: 'tester' },
          text: '@bot_a_username recap',
        },
      }),
    });

    const res11_1 = await POST(req11_1, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    assert.strictEqual(res11_1.status, 200);

    // Fire duplicate update (instantiate fresh request since body can only be read once)
    const req11_2 = new NextRequest('http://localhost:3000/api/webhooks/platform/bot-a-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-for-bot-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1000007,
        message: {
          message_id: 2007,
          chat: { id: 888001, type: 'supergroup', is_forum: true, title: 'Chat 1' },
          from: { id: 7777, username: 'tester' },
          text: '@bot_a_username recap',
        },
      }),
    });

    const res11_2 = await POST(req11_2, { params: Promise.resolve({ botSlug: 'bot-a-slug' }) });
    const res11_2Json = await res11_2.json();
    assert.strictEqual(res11_2.status, 200);
    assert.strictEqual(res11_2Json.msg, 'Duplicate ignored', 'Test 11 Failed: Duplicate update was not rejected');
    console.log('✅ Test 11 Passed.');

    // Test Case 12: Model/persona plumbing is a no-op (S4)
    console.log('Test 12: Model/persona plumbing is a no-op when null...');
    // We already invoked Bot A above. Bot A has null persona and model in the database.
    // Let's assert that model fallback to default is logged correctly in generationMetadata
    const defaultModelRow = await sql`
      select generation_metadata from public.message_log 
      where telegram_chat_id = 888001 and is_bot_response = true
      order by created_at desc limit 1
    `;
    assert.strictEqual(
      defaultModelRow[0].generation_metadata?.model,
      process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      'Test 12 Failed: Expected fallback model Claude Sonnet default'
    );
    console.log('✅ Test 12 Passed.');

    console.log('\n🎉 ALL BOT CUTOVER HARNESS TESTS PASSED SUCCESSFULLY! 🎉');

  } catch (error) {
    console.error('\n❌ Verification Failed:');
    console.error(error);
    process.exit(1);
  } finally {
    console.log('\n--- Cleaning Up Test Environment ---');
    if (sql) {
      try {
        await sql`delete from public.message_log where entity_id in (${E1}, ${E2})`;
        await sql`delete from public.bot_entities where bot_id in (${BOT_A}, ${BOT_B})`;
        await sql`delete from public.groups where entity_id in (${E1}, ${E2})`;
        await sql`delete from public.bots where id in (${BOT_A}, ${BOT_B})`;
        await sql`delete from public.entities where id in (${E1}, ${E2})`;
        await sql`delete from auth.users where id in (${USER_A}, ${USER_B}, ${STRANGER})`;
        if (secretA1) await sql`delete from vault.secrets where id = ${secretA1}`;
        if (secretA2) await sql`delete from vault.secrets where id = ${secretA2}`;
        if (secretB1) await sql`delete from vault.secrets where id = ${secretB1}`;
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
