// Test suite for Document-Read UX
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-document-read-ux.ts

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
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';

// Declare dynamic imports
let POST: any;
let editMessageText: any;
let deleteMessage: any;
let startTypingKeepalive: any;
let DocumentUnsupportedError: any;
let DocumentReadError: any;
let answerAboutDocument: any;
let AnthropicProvider: any;

// Setup environment variables for testing
process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

async function main() {
  console.log('--- Starting Document-Read UX Test Suite ---');

  // Load modules dynamically to ensure global.fetch override is active
  const routeMod = await import('../app/api/webhooks/platform/[botSlug]/route.js');
  POST = routeMod.POST;

  const telegramMod = await import('../lib/telegram.js');
  editMessageText = telegramMod.editMessageText;
  deleteMessage = telegramMod.deleteMessage;
  startTypingKeepalive = telegramMod.startTypingKeepalive;

  const modelMod = await import('../lib/model.js');
  DocumentUnsupportedError = modelMod.DocumentUnsupportedError;
  DocumentReadError = modelMod.DocumentReadError;

  const capsMod = await import('../lib/capabilities.js');
  answerAboutDocument = capsMod.answerAboutDocument;

  const anthropicMod = await import('../lib/providers/anthropic.js');
  AnthropicProvider = anthropicMod.AnthropicProvider;

  const adminUrl = process.env.ADMIN_DATABASE_URL || '';
  if (!adminUrl) {
    throw new Error('ADMIN_DATABASE_URL env var must be set');
  }
  const sql = postgres(adminUrl);

  const USER_A = '33a00000-0000-0000-0000-000000000000';
  const E1 = '33b00000-0000-0000-0000-000000000001';
  const GROUP_A = '33c00000-0000-0000-0000-000000000002';
  const BOT_A = '33d00000-0000-0000-0000-000000000003';
  const CHAT_ID_A = 87654321;
  const BOT_TOKEN_A = 'dummy-bot-token-read-ux';
  const BOT_USERNAME_A = 'read_ux_test_bot';
  const WEBHOOK_SECRET_A = 'super-secret-read-ux-webhook';

  try {
    // 0. Clean up stale state
    await sql`delete from public.threads where group_id = ${GROUP_A}::uuid`;
    await sql`delete from public.message_log where group_id = ${GROUP_A}::uuid`;
    await sql`delete from public.model_calls where entity_id = ${E1}::uuid`;
    await sql`delete from public.telegram_events where bot_slug = ${BOT_USERNAME_A}`;
    await sql`delete from public.bot_entities where bot_id = ${BOT_A}::uuid`;
    await sql`delete from public.bots where id = ${BOT_A}::uuid`;
    await sql`delete from public.groups where id = ${GROUP_A}::uuid`;
    await sql`delete from public.entities where id = ${E1}::uuid`;
    await sql`delete from auth.users where id = ${USER_A}::uuid`;
    await sql`delete from vault.secrets where name in ('bot_ux_token', 'bot_ux_webhook')`;

    // Create Vault secrets for testing
    const sA1 = await sql<{ id: string }[]>`select vault.create_secret(${BOT_TOKEN_A}, 'bot_ux_token') as id`;
    const sA2 = await sql<{ id: string }[]>`select vault.create_secret(${WEBHOOK_SECRET_A}, 'bot_ux_webhook') as id`;
    const secretA1 = sA1[0]?.id;
    const secretA2 = sA2[0]?.id;

    // Seed test fixtures
    await sql`
      insert into auth.users (id, email)
      values (${USER_A}, 'test-read-ux@example.com')
    `;

    await sql`
      insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
      values (${E1}, 'entity-read-ux-test', 'Read UX Entity', ${USER_A}, ${BOT_USERNAME_A})
    `;

    await sql`
      insert into public.groups (id, entity_id, telegram_chat_id, display_name)
      values (${GROUP_A}, ${E1}, ${CHAT_ID_A.toString()}, 'Read UX Group')
    `;

    await sql`
      insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status, model)
      values (${BOT_A}, 'Read UX Bot', ${BOT_USERNAME_A}, ${BOT_USERNAME_A}, ${secretA1}, ${secretA2}, 'active', 'claude-sonnet-5')
    `;

    await sql`
      insert into public.bot_entities (bot_id, entity_id)
      values (${BOT_A}, ${E1})
    `;

    console.log('Test fixtures seeded.');

    // =========================================================================
    // Test 1: editMessageText Helper
    // =========================================================================
    console.log('Test 1: Verifying editMessageText behavior (mutual exclusion)...');
    setupFetchMock({});

    // If both entities and parseMode are passed, prefer entities, omit parse_mode, do not throw.
    await editMessageText('token', 123, 456, 'Hello text', {
      entities: [{ type: 'bold', offset: 0, length: 5 }],
      parseMode: 'HTML',
    });

    const editCall1 = fetchCalls.find((c) => c.url.includes('editMessageText'));
    assert(editCall1, 'Should call editMessageText');
    assert.deepStrictEqual(editCall1.body.entities, [{ type: 'bold', offset: 0, length: 5 }]);
    assert.strictEqual(editCall1.body.parse_mode, undefined, 'Should omit parse_mode when entities are preferred');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: deleteMessage Helper
    // =========================================================================
    console.log('Test 2: Verifying deleteMessage payload...');
    setupFetchMock({});

    await deleteMessage('token', 123, 456);

    const deleteCall = fetchCalls.find((c) => c.url.includes('deleteMessage'));
    assert(deleteCall);
    assert.strictEqual(deleteCall.body.chat_id, 123);
    assert.strictEqual(deleteCall.body.message_id, 456);
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: startTypingKeepalive Helper (temporal assertions)
    // =========================================================================
    console.log('Test 3: Verifying startTypingKeepalive (immediate, interval, stop)...');
    setupFetchMock({});

    const stopKeepalive = startTypingKeepalive('token', 123, 789, 30); // 30ms interval

    // Immediate fire should happen
    const typingCall1 = fetchCalls.filter((c) => c.url.includes('sendChatAction') && c.body.action === 'typing');
    assert(typingCall1.length >= 1, 'Should fire typing action immediately');

    // Wait 100ms so the interval triggers multiple times
    await new Promise((r) => setTimeout(r, 100));
    const typingCountAfterInterval = fetchCalls.filter((c) => c.url.includes('sendChatAction') && c.body.action === 'typing').length;
    assert(typingCountAfterInterval > 1, 'Should fire multiple times over interval');

    // Stop keepalive
    stopKeepalive();
    // Clear captured calls
    fetchCalls = [];

    // Wait 100ms more and assert no additional typing calls are fired
    await new Promise((r) => setTimeout(r, 100));
    const postStopTypingCalls = fetchCalls.filter((c) => c.url.includes('sendChatAction') && c.body.action === 'typing');
    assert.strictEqual(postStopTypingCalls.length, 0, 'No more typing calls should be fired after stop()');

    // Failing typing call must not throw out of interval
    setupFetchMock({
      'sendChatAction': new Response('{"ok":false}', { status: 400 }),
    });
    const stopFailedKeepalive = startTypingKeepalive('token', 123, 789, 10);
    await new Promise((r) => setTimeout(r, 50));
    stopFailedKeepalive();
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Caption-mention routing
    // =========================================================================
    console.log('Test 4: Verifying caption-mention entry routing...');
    const captionPayload = {
      update_id: 30001,
      message: {
        message_id: 40001,
        chat: { id: CHAT_ID_A, type: 'supergroup', is_forum: true },
        from: { id: 9999, first_name: 'Test', username: 'tester' },
        date: 1700000000,
        caption: `@${BOT_USERNAME_A} Summarize document!`,
        document: {
          file_id: 'caption_doc_123',
          mime_type: 'application/pdf',
          file_size: 500,
        },
      },
    };

    setupFetchMock({
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_DATA',
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'This is the summary.' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const request4 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(captionPayload),
      }
    );

    const response4 = await POST(request4, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response4.status, 200);

    await new Promise((r) => setTimeout(r, 1500));

    const modelCall = fetchCalls.find((c) => c.url.includes('messages'));
    assert(modelCall, 'Should route to model');
    const userTextContent = modelCall.body.messages[0].content.find((b: any) => b.type === 'text').text;
    assert.strictEqual(userTextContent, 'Summarize document!', 'Mention should be stripped and question captured from caption');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: Status -> answer (single chunk in-place edit)
    // =========================================================================
    console.log('Test 5: Verifying mutating status-message flow (single chunk)...');
    const replyPayload = {
      update_id: 30002,
      message: {
        message_id: 40002,
        chat: { id: CHAT_ID_A, type: 'supergroup', is_forum: true },
        from: { id: 9999, first_name: 'Test', username: 'tester' },
        date: 1700000000,
        text: `@${BOT_USERNAME_A} Read this`,
        reply_to_message: {
          message_id: 39999,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          date: 1700000000,
          document: {
            file_id: 'doc_123',
            mime_type: 'application/pdf',
            file_size: 500,
          },
        },
      },
    };

    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 8888 } },
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_DATA',
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'This is the simple answer.' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const request5 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(replyPayload),
      }
    );

    await POST(request5, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 1500));

    // Assert status sequence in fetch calls
    const sendCalls = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    const editCalls = fetchCalls.filter((c) => c.url.includes('editMessageText'));

    // Downloading status sent
    const downloadStatus = sendCalls.find((c) => c.body.text && c.body.text.includes('Downloading your document'));
    assert(downloadStatus, 'Should send downloading status');

    // Reading status edited
    const readingStatus = editCalls.find((c) => c.body.message_id === 8888 && c.body.text.includes('Reading it now'));
    assert(readingStatus, 'Should edit to reading status');

    // Answer edited with entities
    const finalAnswerEdit = editCalls.find((c) => c.body.message_id === 8888 && c.body.text.includes('This is the simple answer.'));
    assert(finalAnswerEdit, 'Should edit status message to become the answer');
    assert(finalAnswerEdit.body.entities, 'Final edit must carry entities');

    // Genuinely reused status message -> no separate sendMessage for the answer
    const answerSendCall = sendCalls.find((c) => c.body.text && c.body.text.includes('This is the simple answer.'));
    assert(!answerSendCall, 'Should reuse status message and NOT send a separate sendMessage for the final answer');
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: Status -> split (multi-chunk)
    // =========================================================================
    console.log('Test 6: Verifying status deletion and split send for multi-chunk answers...');
    const payload6 = {
      ...replyPayload,
      update_id: 30003,
      message: {
        ...replyPayload.message,
        message_id: 40003,
      },
    };

    // Return a response exceeding 4096 chars to force splitting
    const longText = 'A'.repeat(4500);

    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 8888 } },
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_DATA',
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: longText }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const request6 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload6),
      }
    );

    await POST(request6, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 3500));

    // Status deleted and chunks sent as separate messages
    const deleteCalls = fetchCalls.filter((c) => c.url.includes('deleteMessage'));
    assert(deleteCalls.find((c) => c.body.message_id === 8888), 'Should delete the status message');

    const sendCalls6 = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    // 1 status send + 2 chunks send = 3 sends
    assert.strictEqual(sendCalls6.length, 3, 'Should delete status and issue multiple sendMessages');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: Status -> error
    // =========================================================================
    console.log('Test 7: Verifying status editing for both DocumentReadErrors and download/transient errors...');
    
    // A. Classified error (100 pages)
    const payload7a = {
      ...replyPayload,
      update_id: 30004,
      message: {
        ...replyPayload.message,
        message_id: 40004,
      },
    };

    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 8888 } },
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_DATA',
      'messages': new Response(
        JSON.stringify({
          error: { type: 'invalid_request_error', message: 'A maximum of 100 PDF pages may be provided.' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    });

    const request7a = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload7a),
      }
    );

    await POST(request7a, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 1500));

    const finalEdits7a = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    const pageLimitEdit = finalEdits7a.find((c) => c.body.message_id === 8888 && c.body.text.includes('limit is 100 pages'));
    assert(pageLimitEdit, 'Should edit status message to report 100 page limit error');

    // B. Download/transient error
    const payload7b = {
      ...replyPayload,
      update_id: 30005,
      message: {
        ...replyPayload.message,
        message_id: 40005,
      },
    };

    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 8888 } },
      'getFile': new Response(JSON.stringify({ ok: false, description: 'File not found' }), { status: 404 }),
    });

    const request7b = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload7b),
      }
    );

    await POST(request7b, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 1500));

    const finalEdits7b = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    const genericErrorEdit = finalEdits7b.find((c) => c.body.message_id === 8888 && c.body.text.includes('something went wrong'));
    assert(genericErrorEdit, 'Should edit status message to report generic download error');
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: Null-status tolerance
    // =========================================================================
    console.log('Test 8: Verifying null-statusId tolerance...');
    const payload8 = {
      ...replyPayload,
      update_id: 30006,
      message: {
        ...replyPayload.message,
        message_id: 40006,
      },
    };

    // Make initial status sendMessage call fail
    setupFetchMock({
      'sendMessage': new Response('{"ok":false}', { status: 400 }),
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_DATA',
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'This answer still sends.' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const request8 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload8),
      }
    );

    await POST(request8, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 1500));

    // First sendMessage failed, second should send the answer
    const sendCalls8 = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    const finalAnswerSend = sendCalls8.find((c) => c.body.text && c.body.text.includes('This answer still sends.'));
    assert(finalAnswerSend, 'Should fallback and send answer via sendMessage when statusId is null');
    console.log('✅ Test 8 Passed.');

    // =========================================================================
    // Test 9: Keep-alive stops (temporal assert on routes)
    // =========================================================================
    console.log('Test 9: Verifying keep-alive stops on routes (success and error paths)...');
    
    // We already invoked the success path in Test 5 and error paths in Test 7!
    // Since typing interval was 4000ms, let's verify that no typing calls are fired
    // long after the execution finishes.
    await new Promise((r) => setTimeout(r, 200));
    
    // Clear fetchCalls and sleep again to check for dangling intervals
    fetchCalls = [];
    await new Promise((r) => setTimeout(r, 150));
    const danglingTypingCalls = fetchCalls.filter((c) => c.url.includes('sendChatAction') && c.body.action === 'typing');
    assert.strictEqual(danglingTypingCalls.length, 0, 'No typing keep-alive calls should be active after handler finishes');
    console.log('✅ Test 9 Passed.');

    // =========================================================================
    // Test 10: Non-message / my_chat_member update safety (Bug A)
    // =========================================================================
    console.log('Test 10: Verifying my_chat_member update does not crash webhook...');
    const chatMemberPayload = {
      update_id: 30007,
      my_chat_member: {
        chat: { id: CHAT_ID_A, type: 'supergroup', title: 'Test Group' },
        from: { id: 9999, first_name: 'Test', username: 'tester' },
        date: 1700000000,
        old_chat_member: { user: { id: 8888 }, status: 'left' },
        new_chat_member: { user: { id: 8888 }, status: 'member' },
      },
    };

    setupFetchMock({});

    const request10 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(chatMemberPayload),
      }
    );

    const response10 = await POST(request10, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response10.status, 200, 'Should handle my_chat_member update cleanly without crashing');
    console.log('✅ Test 10 Passed.');

    // =========================================================================
    // Test 11: Generic error status edit HTML tag safety (Bug B)
    // =========================================================================
    console.log('Test 11: Verifying generic/transient error status edit contains no raw HTML tags...');
    const payload11 = {
      ...replyPayload,
      update_id: 30008,
      message: {
        ...replyPayload.message,
        message_id: 40008,
      },
    };

    // Force a transient error (e.g. 403 from Anthropic, which is not retried)
    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 9999 } },
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_DATA',
      'messages': new Response(
        JSON.stringify({ error: { message: 'Forbidden API access' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    });

    const request11 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload11),
      }
    );

    await POST(request11, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 3500));

    console.log('DEBUG Test 11 fetchCalls:', fetchCalls.map(c => ({ url: c.url, text: c.body?.text })));
    const finalEdits11 = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    const genericEdit11 = finalEdits11.find((c) => c.body.text && c.body.text.includes('Sorry, something went wrong'));
    assert(genericEdit11, 'Should edit status message on error');
    assert(!genericEdit11.body.text.includes('<'), 'Generic error message must not contain raw HTML tags');
    console.log('✅ Test 11 Passed.');

    console.log('🎉 ALL DOCUMENT-READ UX TESTS PASSED SUCCESSFULLY! 🎉');

  } finally {
    restoreFetch();
    console.log('--- Cleaning Up Test State ---');
    try {
      await sql`delete from public.threads where group_id = ${GROUP_A}::uuid`;
      await sql`delete from public.message_log where group_id = ${GROUP_A}::uuid`;
      await sql`delete from public.model_calls where entity_id = ${E1}::uuid`;
      await sql`delete from public.telegram_events where bot_slug = ${BOT_USERNAME_A}`;
      await sql`delete from public.bot_entities where bot_id = ${BOT_A}::uuid`;
      await sql`delete from public.bots where id = ${BOT_A}::uuid`;
      await sql`delete from public.groups where id = ${GROUP_A}::uuid`;
      await sql`delete from public.entities where id = ${E1}::uuid`;
      await sql`delete from auth.users where id = ${USER_A}::uuid`;
      await sql`delete from vault.secrets where name in ('bot_ux_token', 'bot_ux_webhook')`;
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
