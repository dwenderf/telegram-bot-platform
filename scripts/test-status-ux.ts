// Test suite for Status-Message UX for All Model Calls
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-status-ux.ts

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
let runWithStatus: any;

process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';
process.env.TEST_KEEPALIVE_INTERVAL = '50';

async function main() {
  console.log('--- Starting Status-Message UX Test Suite ---');

  // Load modules dynamically to ensure global.fetch override is active
  const routeMod = await import('../app/api/webhooks/platform/[botSlug]/route.js');
  POST = routeMod.POST;

  const telegramMod = await import('../lib/telegram.js');
  runWithStatus = telegramMod.runWithStatus;

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
  const BOT_TOKEN_A = 'dummy-bot-token-status-ux';
  const BOT_USERNAME_A = 'status_ux_test_bot';
  const WEBHOOK_SECRET_A = 'super-secret-status-ux-webhook';

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
      values (${USER_A}, 'test-status-ux@example.com')
    `;

    await sql`
      insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
      values (${E1}, 'entity-status-ux-test', 'Status UX Entity', ${USER_A}, ${BOT_USERNAME_A})
    `;

    await sql`
      insert into public.groups (id, entity_id, telegram_chat_id, display_name)
      values (${GROUP_A}, ${E1}, ${CHAT_ID_A.toString()}, 'Status UX Group')
    `;

    await sql`
      insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status, model)
      values (${BOT_A}, 'Status UX Bot', ${BOT_USERNAME_A}, ${BOT_USERNAME_A}, ${secretA1}, ${secretA2}, 'active', 'claude-sonnet-5')
    `;

    await sql`
      insert into public.bot_entities (bot_id, entity_id)
      values (${BOT_A}, ${E1})
    `;

    console.log('Test fixtures seeded.');

    // =========================================================================
    // Part 1: Direct Unit Tests for runWithStatus
    // =========================================================================
    console.log('Direct Unit Tests: Testing success and error paths on runWithStatus directly...');

    // 1. Success case
    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 1111 } },
    });
    const successResult = await runWithStatus({
      token: BOT_TOKEN_A,
      chatId: CHAT_ID_A,
      initialStatus: 'Working...',
      work: async () => ({ text: 'Direct success answer', entities: [] }),
      mapError: () => 'Error',
    });
    assert.deepStrictEqual(successResult, { text: 'Direct success answer', entities: [] });
    
    const edits = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    assert(edits.find((c) => c.body.message_id === 1111 && c.body.text === 'Direct success answer'));

    // 2. Succeeded work with intermediate updateStatus
    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 2222 } },
    });
    await runWithStatus({
      token: BOT_TOKEN_A,
      chatId: CHAT_ID_A,
      initialStatus: 'Working...',
      work: async (updateStatus: (text: string) => Promise<void>) => {
        await updateStatus('Intermediate update text');
        return { text: 'Final answer text', entities: [] };
      },
      mapError: () => 'Error',
    });
    const edits2 = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    assert(edits2.find((c) => c.body.message_id === 2222 && c.body.text === 'Intermediate update text'));
    assert(edits2.find((c) => c.body.message_id === 2222 && c.body.text === 'Final answer text'));

    // 3. Throwing work & Keep-alive cleanup verification
    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 3333 } },
    });

    const throwResult = await runWithStatus({
      token: BOT_TOKEN_A,
      chatId: CHAT_ID_A,
      initialStatus: 'Working...',
      work: async () => {
        throw new Error('Simulation of transient model error');
      },
      mapError: () => 'Plain text error response',
    });

    assert.strictEqual(throwResult, null);

    // Wait 200ms to verify that the keep-alive interval was stopped (only 1 typing indicator sent)
    await new Promise((r) => setTimeout(r, 200));

    const typingCalls = fetchCalls.filter((c) => c.url.includes('sendChatAction') && c.body.action === 'typing');
    assert.strictEqual(typingCalls.length, 1, 'Keepalive interval must be stopped on throw/error path (only the initial 1 call should exist)');

    const edits3 = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    assert(edits3.find((c) => c.body.message_id === 3333 && c.body.text === 'Plain text error response'));
    console.log('✅ Part 1 Passed.');

    // =========================================================================
    // Part 2: Integration Route Tests driving runWithStatus
    // =========================================================================

    // 1. Question Path (single chunk in-place edit)
    console.log('Integration Tests: Verifying Question Path status flow...');
    const questionPayload = {
      update_id: 40001,
      message: {
        message_id: 50001,
        chat: { id: CHAT_ID_A, type: 'supergroup', is_forum: true },
        from: { id: 9999, first_name: 'Test', username: 'tester' },
        date: 1700000000,
        text: `@${BOT_USERNAME_A} Hello, what is the answer?`,
      },
    };

    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 5555 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'This is the question answer.' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const request1 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(questionPayload),
      }
    );

    const response1 = await POST(request1, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response1.status, 200);
    await new Promise((r) => setTimeout(r, 3500));

    const sendCalls1 = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    const editCalls1 = fetchCalls.filter((c) => c.url.includes('editMessageText'));

    // Asserts
    const initialStatusSend = sendCalls1.find((c) => c.body.text && c.body.text.includes('Pulling together the context'));
    assert(initialStatusSend, 'Should send the Question status copy');

    const answerEdit = editCalls1.find((c) => c.body.message_id === 5555 && c.body.text.includes('This is the question answer.'));
    assert(answerEdit, 'Should edit the status message to show the final answer');

    const separateAnswerSend = sendCalls1.find((c) => c.body.text && c.body.text.includes('This is the question answer.'));
    assert(!separateAnswerSend, 'Should reuse the status message (no extra sendMessage for the answer)');
    console.log('✅ Question Path Passed.');

    // 2. Recap Path Status Flow
    console.log('Integration Tests: Verifying Recap Path status flow...');
    const recapPayload = {
      update_id: 40002,
      message: {
        message_id: 50002,
        chat: { id: CHAT_ID_A, type: 'supergroup', is_forum: true },
        from: { id: 9999, first_name: 'Test', username: 'tester' },
        date: 1700000000,
        text: `/recap 10`,
      },
    };

    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 6666 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'This is the conversation recap.' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const request2 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(recapPayload),
      }
    );

    const response2 = await POST(request2, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response2.status, 200);
    await new Promise((r) => setTimeout(r, 3500));

    const sendCalls2 = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    const editCalls2 = fetchCalls.filter((c) => c.url.includes('editMessageText'));

    const recapStatusSend = sendCalls2.find((c) => c.body.text && c.body.text.includes('putting your recap together'));
    assert(recapStatusSend, 'Should send the Recap status copy');

    const recapEdit = editCalls2.find((c) => c.body.message_id === 6666 && c.body.text.includes('This is the conversation recap.'));
    assert(recapEdit, 'Should edit the status message to show the final recap');
    console.log('✅ Recap Path Passed.');

    // 3. Multi-chunk Question Path
    console.log('Integration Tests: Verifying Multi-chunk Question Path (status deleted, split sent)...');
    const payload3 = {
      ...questionPayload,
      update_id: 40003,
      message: {
        ...questionPayload.message,
        message_id: 50003,
      },
    };

    const longText = 'B'.repeat(4500);

    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 7777 } },
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: longText }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const request3 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload3),
      }
    );

    await POST(request3, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 3500));

    const deleteCalls3 = fetchCalls.filter((c) => c.url.includes('deleteMessage'));
    assert(deleteCalls3.find((c) => c.body.message_id === 7777), 'Status message must be deleted');

    const sendCalls3 = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    // 1 status send + 2 chunks send = 3 sends
    assert.strictEqual(sendCalls3.length, 3, 'Should delete status and issue multiple sendMessages');
    console.log('✅ Multi-chunk Path Passed.');

    // 4. Error Question Path (HTML tag check)
    console.log('Integration Tests: Verifying Error Question Path edits status to plain-text (no HTML tags)...');
    const payload4 = {
      ...questionPayload,
      update_id: 40004,
      message: {
        ...questionPayload.message,
        message_id: 50004,
      },
    };

    setupFetchMock({
      'sendMessage': { ok: true, result: { message_id: 8888 } },
      'messages': new Response(
        JSON.stringify({ error: { message: 'Internal error' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      ),
    });

    const request4 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload4),
      }
    );

    await POST(request4, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 3500));

    const editCalls4 = fetchCalls.filter((c) => c.url.includes('editMessageText'));
    const errorEdit = editCalls4.find((c) => c.body.message_id === 8888 && c.body.text.includes('Sorry, something went wrong'));
    assert(errorEdit, 'Should edit status to report error');
    assert(!errorEdit.body.text.includes('<'), 'Error message must contain no raw HTML tags');
    console.log('✅ Error Path Passed.');

    // 5. Null-status Tolerance
    console.log('Integration Tests: Verifying Null-status tolerance...');
    const payload5 = {
      ...questionPayload,
      update_id: 40005,
      message: {
        ...questionPayload.message,
        message_id: 50005,
      },
    };

    // Fail the status sendMessage call
    setupFetchMock({
      'sendMessage': new Response('{"ok":false}', { status: 400 }),
      'messages': {
        id: 'msg_ok',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Fallback response text.' }],
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
        body: JSON.stringify(payload5),
      }
    );

    await POST(request5, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 3500));

    const sendCalls5 = fetchCalls.filter((c) => c.url.includes('sendMessage'));
    const fallbackAnswerSend = sendCalls5.find((c) => c.body.text && c.body.text.includes('Fallback response text.'));
    assert(fallbackAnswerSend, 'Should successfully send final answer via sendMessage when statusId is null');
    console.log('✅ Null-status Tolerance Passed.');

    // 6. Keep-alive temporal behaviors
    console.log('Integration Tests: Verifying keep-alive indicator lifecycle...');
    // We verify keepalive stops after completion.
    await new Promise((r) => setTimeout(r, 1000));
    fetchCalls = [];
    await new Promise((r) => setTimeout(r, 1000));
    const danglingTypingCalls = fetchCalls.filter((c) => c.url.includes('sendChatAction') && c.body.action === 'typing');
    assert.strictEqual(danglingTypingCalls.length, 0, 'No keep-alive typing calls should persist after workflow completions');
    console.log('✅ Keep-alive Lifecycle Passed.');

    console.log('🎉 ALL STATUS UX TESTS PASSED SUCCESSFULLY! 🎉');

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
