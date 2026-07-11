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
  global.fetch = originalFetch;
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
let DocumentUnsupportedError: any;
let DocumentReadError: any;
let downloadTelegramFile: any;
let TELEGRAM_MAX_DOWNLOAD_BYTES: any;
let answerAboutDocument: any;
let AnthropicProvider: any;
let DeepSeekProvider: any;

// Setup environment variables for testing
process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

async function main() {
  console.log('--- Starting Ephemeral Document Q&A Test Suite ---');

  // Load modules dynamically so that Anthropic SDK captures our mocked global.fetch
  const routeMod = await import('../app/api/webhooks/platform/[botSlug]/route.js');
  POST = routeMod.POST;

  const modelMod = await import('../lib/model.js');
  DocumentUnsupportedError = modelMod.DocumentUnsupportedError;
  DocumentReadError = modelMod.DocumentReadError;

  const telegramMod = await import('../lib/telegram.js');
  downloadTelegramFile = telegramMod.downloadTelegramFile;
  TELEGRAM_MAX_DOWNLOAD_BYTES = telegramMod.TELEGRAM_MAX_DOWNLOAD_BYTES;

  const capsMod = await import('../lib/capabilities.js');
  answerAboutDocument = capsMod.answerAboutDocument;

  const anthropicMod = await import('../lib/providers/anthropic.js');
  AnthropicProvider = anthropicMod.AnthropicProvider;

  const deepseekMod = await import('../lib/providers/deepseek.js');
  DeepSeekProvider = deepseekMod.DeepSeekProvider;

  const adminUrl = process.env.ADMIN_DATABASE_URL || '';
  if (!adminUrl) {
    throw new Error('ADMIN_DATABASE_URL env var must be set');
  }
  const sql = postgres(adminUrl);

  const USER_A = '22a00000-0000-0000-0000-000000000000';
  const E1 = '22b00000-0000-0000-0000-000000000001';
  const GROUP_A = '22c00000-0000-0000-0000-000000000002';
  const BOT_A = '22d00000-0000-0000-0000-000000000003';
  const CHAT_ID_A = 87654321;
  const BOT_TOKEN_A = 'dummy-bot-token-doc-qa';
  const BOT_USERNAME_A = 'doc_qa_test_bot';
  const WEBHOOK_SECRET_A = 'super-secret-doc-qa-webhook';

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
    await sql`delete from vault.secrets where name in ('bot_qa_token', 'bot_qa_webhook')`;

    // Create Vault secrets for testing
    const sA1 = await sql<{ id: string }[]>`select vault.create_secret(${BOT_TOKEN_A}, 'bot_qa_token') as id`;
    const sA2 = await sql<{ id: string }[]>`select vault.create_secret(${WEBHOOK_SECRET_A}, 'bot_qa_webhook') as id`;
    const secretA1 = sA1[0]?.id;
    const secretA2 = sA2[0]?.id;

    // Seed test fixtures
    await sql`
      insert into auth.users (id, email)
      values (${USER_A}, 'test-doc-qa@example.com')
    `;

    await sql`
      insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
      values (${E1}, 'entity-doc-qa-test', 'Doc QA Entity', ${USER_A}, ${BOT_USERNAME_A})
    `;

    await sql`
      insert into public.groups (id, entity_id, telegram_chat_id, display_name)
      values (${GROUP_A}, ${E1}, ${CHAT_ID_A.toString()}, 'Doc QA Group')
    `;

    await sql`
      insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status, model)
      values (${BOT_A}, 'Doc QA Bot', ${BOT_USERNAME_A}, ${BOT_USERNAME_A}, ${secretA1}, ${secretA2}, 'active', 'deepseek-chat')
    `;

    await sql`
      insert into public.bot_entities (bot_id, entity_id)
      values (${BOT_A}, ${E1})
    `;

    console.log('Test fixtures seeded.');

    // =========================================================================
    // Test 1: Anthropic document block shape
    // =========================================================================
    console.log('Test 1: Verifying Anthropic document content block structure...');
    setupFetchMock({
      'messages': {
        id: 'msg_123',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Answer' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    const anthropicProvider = new AnthropicProvider();
    await anthropicProvider.callModel({
      systemPrompt: 'System',
      userMessage: 'Question text',
      model: 'claude-sonnet-5',
      cacheable: false,
      isolationScopeId: 'scope-id',
      document: { data: 'dGVzdA==', mediaType: 'application/pdf' },
    });

    const anthropicCall = fetchCalls.find((c) => c.url.includes('messages'));
    assert(anthropicCall, 'Should call Anthropic API');
    assert.deepStrictEqual(anthropicCall.body.messages, [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'dGVzdA==',
            },
          },
          {
            type: 'text',
            text: 'Question text',
          },
        ],
      },
    ]);
    assert.strictEqual(anthropicCall.options.headers['anthropic-beta'], undefined, 'No beta header for GA base64 docs');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: Anthropic text unchanged (regression check)
    // =========================================================================
    console.log('Test 2: Verifying Anthropic string content block when no document...');
    setupFetchMock({
      'messages': {
        id: 'msg_123',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Answer' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    await anthropicProvider.callModel({
      systemPrompt: 'System',
      userMessage: 'Question text only',
      model: 'claude-sonnet-5',
      cacheable: false,
      isolationScopeId: 'scope-id',
    });

    const anthropicCall2 = fetchCalls.find((c) => c.url.includes('messages'));
    assert(anthropicCall2);
    assert.strictEqual(anthropicCall2.body.messages[0].content, 'Question text only', 'Should be a simple string');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: DeepSeek rejects documents
    // =========================================================================
    console.log('Test 3: Verifying DeepSeek throws DocumentUnsupportedError...');
    const deepseekProvider = new DeepSeekProvider();
    await assert.rejects(
      async () => {
        await deepseekProvider.callModel({
          systemPrompt: 'System',
          userMessage: 'Question text',
          model: 'deepseek-chat',
          cacheable: false,
          isolationScopeId: 'scope-id',
          document: { data: 'dGVzdA==', mediaType: 'application/pdf' },
        });
      },
      (err) => err instanceof DocumentUnsupportedError
    );
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Download helper
    // =========================================================================
    console.log('Test 4: Verifying downloadTelegramFile check gates...');
    // Successful download
    setupFetchMock({
      'getFile': { ok: true, result: { file_path: 'documents/file.pdf', file_size: 100 } },
      'documents/file.pdf': 'PDF_CONTENT_BYTES',
    });

    const fileRes = await downloadTelegramFile('mock-token', 'file_id_123');
    assert.strictEqual(fileRes.data, Buffer.from('PDF_CONTENT_BYTES').toString('base64'));

    // > 20 MB size check
    setupFetchMock({
      'getFile': { ok: true, result: { file_path: 'documents/large.pdf', file_size: 30 * 1024 * 1024 } },
    });
    await assert.rejects(
      async () => {
        await downloadTelegramFile('mock-token', 'file_id_large');
      },
      /exceeds the maximum download cap/
    );
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: Isolated read
    // =========================================================================
    console.log('Test 5: Verifying answerAboutDocument prompt isolation & defaults...');
    setupFetchMock({
      'messages': {
        id: 'msg_123',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Answer' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });

    // We do not mock with tenant context, but it runs query inside logModelCall
    await answerAboutDocument({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      question: '  ', // empty/bare question
      document: { data: 'dGVzdA==', mediaType: 'application/pdf' },
    });

    const callDoc = fetchCalls.find((c) => c.url.includes('messages'));
    assert(callDoc);
    // Verifying prompt context is absent
    assert(!callDoc.body.system.includes('PROJECT CONTEXT'), 'Should not contain project context');
    assert.strictEqual(
      callDoc.body.messages[0].content.find((b: any) => b.type === 'text').text,
      'Provide a clear overview of this document.',
      'Should fall back to default overview prompt'
    );
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: Webhook Route MIME gate
    // =========================================================================
    console.log('Test 6: Verifying route level MIME gate...');
    const docxPayload = {
      update_id: 20001,
      message: {
        message_id: 30001,
        chat: { id: CHAT_ID_A, type: 'supergroup' },
        date: 1700000000,
        text: `@${BOT_USERNAME_A} What is this?`,
        reply_to_message: {
          message_id: 30000,
          date: 1700000000,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          document: {
            file_id: 'docx_file_123',
            mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            file_size: 1024,
          },
        },
      },
    };

    setupFetchMock({});
    const request6 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(docxPayload),
      }
    );

    const response6 = await POST(request6, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response6.status, 200);

    // Wait slightly for async waitUntil to evaluate
    await new Promise((r) => setTimeout(r, 250));

    const sendMessageCall = fetchCalls.find((c) => c.url.includes('sendMessage'));
    assert(sendMessageCall, 'Should reply with error');
    assert.strictEqual(sendMessageCall.body.text, 'I can only read PDF documents right now.');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: Webhook Route Size gate
    // =========================================================================
    console.log('Test 7: Verifying route level PDF size gate...');
    const largePdfPayload = {
      update_id: 20002,
      message: {
        message_id: 30002,
        chat: { id: CHAT_ID_A, type: 'supergroup' },
        date: 1700000000,
        text: `@${BOT_USERNAME_A} What is this?`,
        reply_to_message: {
          message_id: 30000,
          date: 1700000000,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          document: {
            file_id: 'large_pdf_123',
            mime_type: 'application/pdf',
            file_size: 25 * 1024 * 1024, // 25 MB
          },
        },
      },
    };

    setupFetchMock({});
    const request7 = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(largePdfPayload),
      }
    );

    const response7 = await POST(request7, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response7.status, 200);

    await new Promise((r) => setTimeout(r, 250));

    const sendMessageCall7 = fetchCalls.find((c) => c.url.includes('sendMessage'));
    assert(sendMessageCall7);
    assert.strictEqual(sendMessageCall7.body.text, 'That file is too large for me to read (max 20 MB).');
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: Capability Routing
    // =========================================================================
    console.log('Test 8: Verifying DeepSeek-default bot auto-routes to Anthropic for docs...');
    // Bot is configured with deepseek-chat. But since it's a PDF reply, we expect the model call to be claud-sonnet-5.
    const validPdfPayload = {
      update_id: 20003,
      message: {
        message_id: 30003,
        chat: { id: CHAT_ID_A, type: 'supergroup' },
        date: 1700000000,
        text: `@${BOT_USERNAME_A} Summarize this PDF please`,
        reply_to_message: {
          message_id: 30000,
          date: 1700000000,
          chat: { id: CHAT_ID_A, type: 'supergroup' },
          document: {
            file_id: 'valid_pdf_123',
            mime_type: 'application/pdf',
            file_size: 500,
          },
        },
      },
    };

    setupFetchMock({
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_BYTES_HERE',
      'messages': {
        id: 'msg_ok_123',
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'This is the PDF summary.' }],
        usage: { input_tokens: 15, output_tokens: 20 },
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
        body: JSON.stringify(validPdfPayload),
      }
    );

    const response8 = await POST(request8, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    assert.strictEqual(response8.status, 200);

    await new Promise((r) => setTimeout(r, 1500));

    const modelCall8 = fetchCalls.find((c) => c.url.includes('messages'));
    assert(modelCall8, 'Should make a model call');
    assert.strictEqual(modelCall8.body.model, 'claude-sonnet-5', 'Model must be claude-sonnet-5');
    console.log('✅ Test 8 Passed.');

    // =========================================================================
    // Test 9: Happy Path & Block Wire Invariants
    // =========================================================================
    console.log('Test 9: Verifying happy path doc QA wire block structure and question extraction...');
    // We already invoked the happy path in Test 8!
    // Let's assert the parameters of modelCall8 (Test 8/9 happy path)
    assert(modelCall8);
    // User question must be extracted (stripped of mention tag)
    const expectedQuestion = 'Summarize this PDF please';
    assert.deepStrictEqual(modelCall8.body.messages, [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: Buffer.from('PDF_BYTES_HERE').toString('base64'),
            },
          },
          {
            type: 'text',
            text: expectedQuestion,
          },
        ],
      },
    ]);

    const sendResCall = fetchCalls.find((c) => c.url.includes('sendMessage') && c.body.text && c.body.text.includes('This is the PDF summary.'));
    if (!sendResCall) {
      console.log('DEBUG: fetchCalls count:', fetchCalls.length);
      for (const call of fetchCalls) {
        console.log(`DEBUG call: URL=${call.url} BODY=${JSON.stringify(call.body)}`);
      }
    }
    assert(sendResCall, 'Should reply with summary text');
    console.log('✅ Test 9 Passed.');

    // =========================================================================
    // Test 10: Backstop classification
    // =========================================================================
    console.log('Test 10: Verifying page-limit and invalid request backstops...');
    // A. Page Limit Error 100 pages
    setupFetchMock({
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_BYTES_HERE',
      'messages': new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: 'A maximum of 100 PDF pages may be provided.',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    });

    const payload10a = {
      ...validPdfPayload,
      update_id: 20004,
      message: {
        ...validPdfPayload.message,
        message_id: 30004,
      },
    };

    const request10a = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload10a),
      }
    );

    await POST(request10a, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 250));

    const errSend1 = fetchCalls.find((c) => c.url.includes('sendMessage') && c.body.text && c.body.text.includes('limit is 100 pages'));
    assert(errSend1, 'Should output specific 100 page warning');

    // B. Invalid Request Error (Password/corrupt)
    setupFetchMock({
      'getFile': { ok: true, result: { file_path: 'documents/valid.pdf', file_size: 500 } },
      'documents/valid.pdf': 'PDF_BYTES_HERE',
      'messages': new Response(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: 'Password required or corrupt format.',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    });

    const payload10b = {
      ...validPdfPayload,
      update_id: 20005,
      message: {
        ...validPdfPayload.message,
        message_id: 30005,
      },
    };

    const request10b = new NextRequest(
      `http://localhost:3000/api/webhooks/platform/${BOT_USERNAME_A}`,
      {
        method: 'POST',
        headers: {
          'x-telegram-bot-api-secret-token': WEBHOOK_SECRET_A,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload10b),
      }
    );

    await POST(request10b, { params: Promise.resolve({ botSlug: BOT_USERNAME_A }) });
    await new Promise((r) => setTimeout(r, 250));

    const errSend2 = fetchCalls.find((c) => c.url.includes('sendMessage') && c.body.text && c.body.text.includes('password-protected or corrupt'));
    assert(errSend2, 'Should output corrupt PDF warning');
    console.log('✅ Test 10 Passed.');

    // =========================================================================
    // Test 11: Nothing-stored invariant
    // =========================================================================
    console.log('Test 11: Verifying nothing-stored DB invariant...');
    const pdfBase64 = Buffer.from('PDF_BYTES_HERE').toString('base64');

    const loggedModelCalls = await sql`
      select metadata::text from public.model_calls where entity_id = ${E1}::uuid
    `;

    assert(loggedModelCalls.length > 0, 'Should have logged at least one model call');
    for (const row of loggedModelCalls) {
      assert(!row.metadata.includes(pdfBase64), 'Model call metadata must NOT contain the PDF base64 bytes!');
    }

    // Verify cache tables are completely untouched
    const docCacheRows = await sql`
      select count(*) as count from public.doc_cache where entity_id = ${E1}::uuid
    `;
    assert.strictEqual(Number(docCacheRows[0].count), 0, 'Should have zero doc_cache rows');

    const manifestEntryRows = await sql`
      select count(*) as count from public.manifest_entries where entity_id = ${E1}::uuid
    `;
    assert.strictEqual(Number(manifestEntryRows[0].count), 0, 'Should have zero manifest_entries rows');

    console.log('✅ Test 11 Passed.');

    console.log('🎉 ALL EPHEMERAL DOCUMENT Q&A TESTS PASSED SUCCESSFULLY! 🎉');
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
      await sql`delete from vault.secrets where name in ('bot_qa_token', 'bot_qa_webhook')`;
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
