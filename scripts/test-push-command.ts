// Test suite for /push Command
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-push-command.ts

const originalFetch = global.fetch;
let currentMockResponses: Record<string, any> = {};
let fetchCalls: { url: string; options: any; body: any }[] = [];

global.fetch = async (url: any, options: any) => {
  const urlStr = url.toString();
  let body = null;
  try {
    body = options?.body ? JSON.parse(options.body) : null;
  } catch (e) {}
  fetchCalls.push({ url: urlStr, options, body });

  // Match response by key in URL
  for (const key of Object.keys(currentMockResponses)) {
    if (urlStr.includes(key)) {
      const responseData = currentMockResponses[key];
      if (responseData instanceof Response) {
        return responseData.clone();
      }
      return new Response(
        typeof responseData === 'string' ? responseData : JSON.stringify(responseData),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  }

  // Default mock response
  return new Response(JSON.stringify({ ok: true, result: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

function setupFetchMock(mockResponses: Record<string, any> = {}) {
  fetchCalls = [];
  currentMockResponses = mockResponses;
}

function restoreFetch() {
  currentMockResponses = {};
  fetchCalls = [];
}

import assert from 'assert';
import postgres from 'postgres';
import { NextRequest } from 'next/server';

// Declare dynamic imports
let POST: any;
let buildContext: any;
let getContextManifest: any;

process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

async function main() {
  console.log('--- Starting /push Command Test Suite ---');

  // Load modules dynamically to ensure global.fetch override is active
  const routeMod = await import('../app/api/webhooks/platform/[botSlug]/route.js');
  POST = routeMod.POST;

  const capsMod = await import('../lib/capabilities.js');
  buildContext = capsMod.buildContext;
  getContextManifest = capsMod.getContextManifest;

  const adminUrl = process.env.ADMIN_DATABASE_URL || '';
  if (!adminUrl) {
    throw new Error('ADMIN_DATABASE_URL env var must be set');
  }
  const sql = postgres(adminUrl);

  const USER_A = '44a00000-0000-0000-0000-000000000000';
  const E1 = '44b00000-0000-0000-0000-000000000001';
  const GROUP_A = '44c00000-0000-0000-0000-000000000002';
  const GROUP_B = '44c00000-0000-0000-0000-000000000003';
  const BOT_A = '44d00000-0000-0000-0000-000000000004';
  const CHAT_ID_A = 98765432;
  const CHAT_ID_B = 98765433;
  const TELEGRAM_THREAD_ID = 99999;

  const BOT_TOKEN_A = 'dummy-bot-token-push-cmd';
  const BOT_USERNAME_A = 'push_test_bot';
  const WEBHOOK_SECRET_A = 'super-secret-push-webhook';

  // Mock Vercel request context to capture waitUntil promises
  const pendingPromises: Promise<any>[] = [];
  (globalThis as any)[Symbol.for("@vercel/request-context")] = {
    get() {
      return {
        waitUntil(promise: Promise<any>) {
          pendingPromises.push(promise);
        }
      };
    }
  };

  async function flushWaitUntil() {
    await Promise.all(pendingPromises);
    pendingPromises.length = 0;
  }

  try {
    // 0. Clean up stale state
    await sql`delete from public.threads where group_id in (${GROUP_A}::uuid, ${GROUP_B}::uuid)`;
    await sql`delete from public.message_log where group_id in (${GROUP_A}::uuid, ${GROUP_B}::uuid)`;
    await sql`delete from public.model_calls where entity_id = ${E1}::uuid`;
    await sql`delete from public.telegram_events where bot_slug = ${BOT_USERNAME_A}`;
    await sql`delete from public.bot_entities where bot_id = ${BOT_A}::uuid`;
    await sql`delete from public.bots where id = ${BOT_A}::uuid`;
    await sql`delete from public.groups where id in (${GROUP_A}::uuid, ${GROUP_B}::uuid)`;
    await sql`delete from public.entities where id = ${E1}::uuid`;
    await sql`delete from auth.users where id = ${USER_A}::uuid`;
    await sql`delete from vault.secrets where name in ('bot_push_token', 'bot_push_webhook')`;

    // Create Vault secrets for testing
    const sA1 = await sql<{ id: string }[]>`select vault.create_secret(${BOT_TOKEN_A}, 'bot_push_token') as id`;
    const sA2 = await sql<{ id: string }[]>`select vault.create_secret(${WEBHOOK_SECRET_A}, 'bot_push_webhook') as id`;
    const secretA1 = sA1[0]?.id;
    const secretA2 = sA2[0]?.id;

    // Seed test fixtures
    await sql`
      insert into auth.users (id, email)
      values (${USER_A}, 'test-push@example.com')
    `;

    await sql`
      insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
      values (${E1}, 'entity-push-test', 'Push Test Entity', ${USER_A}, ${BOT_USERNAME_A})
    `;

    await sql`
      insert into public.groups (id, entity_id, telegram_chat_id, display_name)
      values 
        (${GROUP_A}, ${E1}, ${CHAT_ID_A.toString()}, 'Push Group A'),
        (${GROUP_B}, ${E1}, ${CHAT_ID_B.toString()}, 'Push Group B')
    `;

    await sql`
      insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status, model)
      values (${BOT_A}, 'Push Bot', ${BOT_USERNAME_A}, ${BOT_USERNAME_A}, ${secretA1}, ${secretA2}, 'active', 'claude-sonnet-5')
    `;

    await sql`
      insert into public.bot_entities (bot_id, entity_id)
      values (${BOT_A}, ${E1})
    `;

    // Seed threads to test collision scenarios (thread 99999 in both Group A and Group B)
    await sql`
      insert into public.threads (id, entity_id, group_id, telegram_thread_id, name)
      values 
        ('44e00000-0000-0000-0000-000000000001', ${E1}, ${GROUP_A}, ${TELEGRAM_THREAD_ID.toString()}, 'Group A Topic'),
        ('44e00000-0000-0000-0000-000000000002', ${E1}, ${GROUP_B}, ${TELEGRAM_THREAD_ID.toString()}, 'Group B Topic')
    `;

    console.log('Test fixtures seeded.');

    // =========================================================================
    // Test 1: Parsing, scope validation, and gates
    // =========================================================================
    console.log('Test 1: Verifying scope checks, reply validations, and admin gates...');

    // A. Invalid scope xyz
    setupFetchMock({});
    const req1a = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10001,
        message: {
          message_id: 20001,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push xyz',
        },
      }),
    });
    const res1a = await POST(req1a, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(res1a.status, 200);
    const sendCalls1a = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    assert(sendCalls1a[0]?.body.text.includes('Usage: reply to a message'), 'Must return usage instructions on invalid scope');

    // B. Valid scope, no reply-to target
    setupFetchMock({});
    const req1b = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10002,
        message: {
          message_id: 20002,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push group',
        },
      }),
    });
    const res1b = await POST(req1b, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(res1b.status, 200);
    const sendCalls1b = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    assert(sendCalls1b[0]?.body.text.includes('Reply to a message with'), 'Must request user to reply to a target message');

    // C. Valid scope, reply-to target is document with no text
    setupFetchMock({});
    const req1c = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10003,
        message: {
          message_id: 20003,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push group',
          reply_to_message: {
            message_id: 30003,
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            document: { file_id: 'doc123', mime_type: 'application/pdf', file_size: 500 },
          },
        },
      }),
    });
    const res1c = await POST(req1c, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(res1c.status, 200);
    const sendCalls1c = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    assert(sendCalls1c[0]?.body.text.includes("I can't push a document directly"), 'Must reject direct document pushes');

    // D. Valid scope, reply-to target is photo
    setupFetchMock({});
    const req1d = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10004,
        message: {
          message_id: 20004,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push group',
          reply_to_message: {
            message_id: 30004,
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            photo: [{ file_id: 'photo123', width: 100, height: 100 }],
          },
        },
      }),
    });
    const res1d = await POST(req1d, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(res1d.status, 200);
    const sendCalls1d = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    assert(sendCalls1d[0]?.body.text.includes('I can only push text messages'), 'Must reject media pushes');

    // E. Valid scope + valid reply, caller is non-admin
    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'member', user: { id: 9999 } } },
    });
    const req1e = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10005,
        message: {
          message_id: 20005,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push group',
          reply_to_message: {
            message_id: 30005,
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            text: 'Valid target message text',
          },
        },
      }),
    });
    const res1e = await POST(req1e, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(res1e.status, 200);
    const sendCalls1e = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    assert(sendCalls1e[0]?.body.text.includes('Only a group admin can push'), 'Must reject non-admin push command calls');

    // F. Valid scope (topic) in General thread (threadId === null)
    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'administrator', user: { id: 9999 } } },
    });
    const req1f = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10006,
        message: {
          message_id: 20006,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push topic',
          reply_to_message: {
            message_id: 30006,
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            text: 'Valid target message text',
          },
        },
      }),
    });
    await POST(req1f, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await flushWaitUntil();
    const sendCalls1f = fetchCalls.filter((c) => c.url.includes('sendMessage') || c.url.includes('editMessageText'));
    assert(sendCalls1f.find((c) => c.body.text && c.body.text.includes("There's no topic here to push to")), 'Must reject push topic when threadId is null');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: Fresh push to group scope
    // =========================================================================
    console.log('Test 2: Verifying fresh push to group scope...');
    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'administrator', user: { id: 9999 } } },
      'sendMessage': { ok: true, result: { message_id: 4444 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'group-pushed-context-slug' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const req2 = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10007,
        message: {
          message_id: 20007,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push group',
          reply_to_message: {
            message_id: 30007,
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            text: 'Content pushed to Group A',
          },
        },
      }),
    });

    await POST(req2, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await flushWaitUntil();

    // Assert DB persistence
    const docs2 = await sql`
      select c.* from public.doc_cache c
      join public.manifest_entries m on m.doc_id = c.id
      where m.group_id = ${GROUP_A}::uuid and m.thread_id is null
    `;
    assert.strictEqual(docs2.length, 1);
    assert.strictEqual(docs2[0].display_name, 'group-pushed-context-slug');
    assert.strictEqual(docs2[0].content, 'Content pushed to Group A');
    assert.strictEqual(docs2[0].source_type, 'push');
    assert.strictEqual(docs2[0].source.pushed_via, 'telegram_push');
    assert.strictEqual(docs2[0].source.origin_chat_id, CHAT_ID_A.toString());
    assert.strictEqual(docs2[0].source.origin_message_id, '30007');

    const edits2 = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    const successEdit2 = edits2.find((c) => c.body.message_id === 4444 && c.body.text.includes('Saved to this group'));
    assert(successEdit2, 'Should edit status to success confirmation message');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: Fresh push to topic scope with cross-group thread collision
    // =========================================================================
    console.log('Test 3: Verifying topic push with cross-group thread collision isolation...');

    // Push topic on GROUP_A (thread 99999)
    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'administrator', user: { id: 9999 } } },
      'sendMessage': { ok: true, result: { message_id: 5555 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'topic-slug-a' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const req3a = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10008,
        message: {
          message_id: 20008,
          message_thread_id: TELEGRAM_THREAD_ID,
          chat: { id: CHAT_ID_A, type: 'supergroup', is_forum: true },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push topic',
          reply_to_message: {
            message_id: 30008,
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            text: 'Topic context in Group A',
          },
        },
      }),
    });

    await POST(req3a, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await flushWaitUntil();

    // Push topic on GROUP_B (thread 99999)
    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'administrator', user: { id: 9999 } } },
      'sendMessage': { ok: true, result: { message_id: 6666 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'topic-slug-b' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const req3b = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10009,
        message: {
          message_id: 20009,
          message_thread_id: TELEGRAM_THREAD_ID,
          chat: { id: CHAT_ID_B, type: 'supergroup', is_forum: true },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push topic',
          reply_to_message: {
            message_id: 30009,
            chat: { id: CHAT_ID_B, type: 'supergroup' },
            date: 1700000000,
            text: 'Topic context in Group B',
          },
        },
      }),
    });

    await POST(req3b, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await flushWaitUntil();

    // Verify GROUP_A topic doc
    const docs3a = await sql`
      select c.* from public.doc_cache c
      join public.manifest_entries m on m.doc_id = c.id
      where m.group_id = ${GROUP_A}::uuid and m.thread_id = '44e00000-0000-0000-0000-000000000001'::uuid
    `;
    assert.strictEqual(docs3a.length, 1);
    assert.strictEqual(docs3a[0].display_name, 'topic-slug-a');
    assert.strictEqual(docs3a[0].content, 'Topic context in Group A');

    // Verify GROUP_B topic doc
    const docs3b = await sql`
      select c.* from public.doc_cache c
      join public.manifest_entries m on m.doc_id = c.id
      where m.group_id = ${GROUP_B}::uuid and m.thread_id = '44e00000-0000-0000-0000-000000000002'::uuid
    `;
    assert.strictEqual(docs3b.length, 1);
    assert.strictEqual(docs3b[0].display_name, 'topic-slug-b');
    assert.strictEqual(docs3b[0].content, 'Topic context in Group B');
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Re-push updates in place (no LLM call)
    // =========================================================================
    console.log('Test 4: Verifying updates-in-place on re-push...');

    // Re-push message 30008 to GROUP_A topic
    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'administrator', user: { id: 9999 } } },
      'sendMessage': { ok: true, result: { message_id: 7777 } },
    });

    const req4 = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10010,
        message: {
          message_id: 20010,
          message_thread_id: TELEGRAM_THREAD_ID,
          chat: { id: CHAT_ID_A, type: 'supergroup', is_forum: true },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push topic',
          reply_to_message: {
            message_id: 30008,
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            text: 'Topic context in Group A (Refreshed and Updated)',
          },
        },
      }),
    });

    await POST(req4, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await flushWaitUntil();

    // Verify it updated in place (same ID, same name, new content)
    const docs4 = await sql`
      select c.* from public.doc_cache c
      join public.manifest_entries m on m.doc_id = c.id
      where m.group_id = ${GROUP_A}::uuid and m.thread_id = '44e00000-0000-0000-0000-000000000001'::uuid
    `;
    assert.strictEqual(docs4.length, 1);
    assert.strictEqual(docs4[0].display_name, 'topic-slug-a');
    assert.strictEqual(docs4[0].content, 'Topic context in Group A (Refreshed and Updated)');

    const anthropicCalls = fetchCalls.filter((c) => c.url.includes('api.anthropic.com'));
    assert.strictEqual(anthropicCalls.length, 0, 'No LLM name generation should run on update-in-place path');

    const edits4 = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    assert(edits4.find((c) => c.body.message_id === 7777 && c.body.text.includes('Updated in this topic')), 'Should confirm update status');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: Re-push to a different scope creates a separate document
    // =========================================================================
    console.log('Test 5: Verifying pushing same message to a different scope...');

    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'administrator', user: { id: 9999 } } },
      'sendMessage': { ok: true, result: { message_id: 8888 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'topic-slug-a-at-group-scope' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const req5 = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10011,
        message: {
          message_id: 20011,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push group',
          reply_to_message: {
            message_id: 30008, // Same origin message ID as Test 3/4
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            text: 'Topic context in Group A',
          },
        },
      }),
    });

    await POST(req5, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await flushWaitUntil();

    // Both should exist (one at topic scope, one at group scope)
    const allGroupADocs = await sql`
      select c.* from public.doc_cache c
      join public.manifest_entries m on m.doc_id = c.id
      where m.group_id = ${GROUP_A}::uuid
    `;
    // 1 group doc from Test 2, 1 topic doc from Test 3, 1 group doc from Test 5 = 3 docs
    assert.strictEqual(allGroupADocs.length, 3);
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: Suffix collision (-2 suffix)
    // =========================================================================
    console.log('Test 6: Verifying suffix collision logic...');

    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'administrator', user: { id: 9999 } } },
      'sendMessage': { ok: true, result: { message_id: 9999 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'topic-slug-a' }], // Collides with Test 3
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const req6 = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10012,
        message: {
          message_id: 20012,
          message_thread_id: TELEGRAM_THREAD_ID,
          chat: { id: CHAT_ID_A, type: 'supergroup', is_forum: true },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push topic',
          reply_to_message: {
            message_id: 30012, // Different message
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            text: 'Colliding topic context',
          },
        },
      }),
    });

    await POST(req6, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await flushWaitUntil();

    // Verify it got saved with '-2' suffix
    const docs6 = await sql`
      select c.* from public.doc_cache c
      join public.manifest_entries m on m.doc_id = c.id
      where m.group_id = ${GROUP_A}::uuid and m.thread_id = '44e00000-0000-0000-0000-000000000001'::uuid
      order by m.created_at desc
    `;
    assert.strictEqual(docs6[0].display_name, 'topic-slug-a-2');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: Unusable name fallback formatting
    // =========================================================================
    console.log('Test 7: Verifying unusable name fallback...');

    setupFetchMock({
      'getChatMember': { ok: true, result: { status: 'administrator', user: { id: 9999 } } },
      'sendMessage': { ok: true, result: { message_id: 10001 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: '!!!' }], // Unusable slug name
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const req7 = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A, 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 10013,
        message: {
          message_id: 20013,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          from: { id: 9999, first_name: 'Tester' },
          text: '/push group',
          reply_to_message: {
            message_id: 30013,
            chat: { id: CHAT_ID_A, type: 'supergroup' },
            date: 1700000000,
            text: 'Fallback naming context',
          },
        },
      }),
    });

    await POST(req7, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await flushWaitUntil();

    const docs7 = await sql`
      select c.* from public.doc_cache c
      join public.manifest_entries m on m.doc_id = c.id
      where m.group_id = ${GROUP_A}::uuid and c.content = 'Fallback naming context'
    `;
    assert.strictEqual(docs7.length, 1);
    const expectedPrefix = 'push-group-';
    assert(docs7[0].display_name.startsWith(expectedPrefix), `Fallback name ${docs7[0].display_name} must start with ${expectedPrefix}`);
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: Resolver integration regression check
    // =========================================================================
    console.log('Test 8: Verifying buildContext incorporates pushed docs...');
    
    // Call getContextManifest for GROUP_A & thread_id TELEGRAM_THREAD_ID
    const manifest = await getContextManifest(E1, GROUP_A, TELEGRAM_THREAD_ID);
    
    const pushedDocA = manifest.topicDocs.find((d: any) => d.display_name === 'topic-slug-a');
    assert(pushedDocA, 'Must find topic-slug-a in topicDocs');
    assert.strictEqual(pushedDocA.content, 'Topic context in Group A (Refreshed and Updated)');

    const pushedDocA2 = manifest.topicDocs.find((d: any) => d.display_name === 'topic-slug-a-2');
    assert(pushedDocA2, 'Must find topic-slug-a-2 in topicDocs');

    const pushedGroupDoc = manifest.groupDocs.find((d: any) => d.display_name === 'group-pushed-context-slug');
    assert(pushedGroupDoc, 'Must find group-pushed-context-slug in groupDocs');

    // Call buildContext to verify XML representation
    const context = await buildContext(E1, GROUP_A, TELEGRAM_THREAD_ID);
    assert(context.contextDocs.includes('<document path="topic-slug-a">'), 'XML context must contain topic-slug-a');
    assert(context.contextDocs.includes('<document path="topic-slug-a-2">'), 'XML context must contain topic-slug-a-2');
    assert(context.contextDocs.includes('<document path="group-pushed-context-slug">'), 'XML context must contain group-pushed-context-slug');
    console.log('✅ Test 8 Passed.');

    console.log('🎉 ALL PUSH COMMAND TESTS PASSED SUCCESSFULLY! 🎉');

  } finally {
    restoreFetch();
    console.log('--- Cleaning Up Test State ---');
    try {
      await sql`delete from public.threads where group_id in (${GROUP_A}::uuid, ${GROUP_B}::uuid)`;
      await sql`delete from public.message_log where group_id in (${GROUP_A}::uuid, ${GROUP_B}::uuid)`;
      await sql`delete from public.model_calls where entity_id = ${E1}::uuid`;
      await sql`delete from public.telegram_events where bot_slug = ${BOT_USERNAME_A}`;
      await sql`delete from public.bot_entities where bot_id = ${BOT_A}::uuid`;
      await sql`delete from public.bots where id = ${BOT_A}::uuid`;
      await sql`delete from public.groups where id in (${GROUP_A}::uuid, ${GROUP_B}::uuid)`;
      await sql`delete from public.entities where id = ${E1}::uuid`;
      await sql`delete from auth.users where id = ${USER_A}::uuid`;
      await sql`delete from vault.secrets where name in ('bot_push_token', 'bot_push_webhook')`;
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
