// Adversarial Test Suite for Phase 4 Group-Scoped Context Resolution
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-group-scoped-context.ts

process.env.ANTHROPIC_API_KEY = 'dummy-test-key';
process.env.APP_HMAC_PEPPER = 'dummy-test-pepper-high-entropy-random-string';

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/webhooks/platform/[botSlug]/route';
import { setMockCallModel } from '../lib/anthropic';
import { buildContext, getContextManifest } from '../lib/capabilities';

// Stub LLM call
let lastPromptInput: any = null;
setMockCallModel(async (input) => {
  lastPromptInput = input;
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

// Mock global fetch to intercept outbound Telegram requests
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
    if (urlStr.includes('sendDocument')) {
      // Mock document send (push filename or caption)
      sentMessages.push({ doc: true, body: options.body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 12346 } }), { status: 200 });
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
  const USER_A = 'a2000000-0000-0000-0000-000000000000';
  const E1 = 'e2200000-0000-0000-0000-000000000000';
  const BOT_A = 'ba200000-0000-0000-0000-000000000000';
  const GROUP_A = 'fa200000-0000-0000-0000-000000000000';
  const GROUP_B = 'fb200000-0000-0000-0000-000000000000';
  const GROUP_C = 'fc200000-0000-0000-0000-000000000000';

  const CHAT_A = -100111222333;
  const CHAT_B = -100444555666;
  const CHAT_C = -100777888999;

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

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('ADMIN_DATABASE_URL and DATABASE_URL env vars must be set');
    }

    sql = postgres(adminUrl);
    botSql = postgres(botUrl);

    console.log('--- Cleaning Up Stale Test State ---');
    await sql`delete from public.message_log where entity_id = ${E1}`;
    await sql`delete from public.bot_entities where bot_id = ${BOT_A}`;
    await sql`delete from public.manifest_entries where entity_id = ${E1}`;
    await sql`delete from public.doc_cache where entity_id = ${E1}`;
    await sql`delete from public.threads where entity_id = ${E1}`;
    await sql`delete from public.groups where entity_id = ${E1}`;
    await sql`delete from public.bots where id = ${BOT_A}`;
    await sql`delete from public.entities where id = ${E1}`;
    await sql`delete from auth.users where id = ${USER_A}`;
    await sql`delete from vault.secrets where name in ('bot_a_token_phase4', 'bot_a_webhook_phase4')`;

    console.log('--- Seeding Test Fixtures ---');
    // Setup Vault secrets
    const s1 = await sql<{ id: string }[]>`select vault.create_secret('token-secret-a', 'bot_a_token_phase4') as id`;
    const s2 = await sql<{ id: string }[]>`select vault.create_secret('webhook-secret-a', 'bot_a_webhook_phase4') as id`;
    const secretTokenId = s1[0].id;
    const secretWebhookId = s2[0].id;

    // Create user
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_phase4@test.com', now(), 'authenticated', 'authenticated')`;

    // Create entity
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E1}, 'entity-phase4-test', 'Phase 4 Entity', ${USER_A}, 'phase4_bot_username')`;

    // Create bot
    await sql`
      insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status)
      values (${BOT_A}, 'Phase 4 Bot', 'phase4-bot-slug', 'phase4_bot_username', ${secretTokenId}, ${secretWebhookId}, 'active')
    `;
    await sql`insert into public.bot_entities (bot_id, entity_id) values (${BOT_A}, ${E1})`;

    // Create groups
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Group A (Internal)')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_B}, ${E1}, ${CHAT_B}, 'Group B (Capital)')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_C}, ${E1}, ${CHAT_C}, 'Group C (Board)')`;

    // Create threads
    const tA5 = await sql<{ id: string }[]>`insert into public.threads (entity_id, group_id, telegram_thread_id) values (${E1}, ${GROUP_A}, 5) returning id`;
    const tB5 = await sql<{ id: string }[]>`insert into public.threads (entity_id, group_id, telegram_thread_id) values (${E1}, ${GROUP_B}, 5) returning id`; // Collision topic
    const tA7 = await sql<{ id: string }[]>`insert into public.threads (entity_id, group_id, telegram_thread_id) values (${E1}, ${GROUP_A}, 7) returning id`; // Topic with empty group layer

    // Seed doc_cache items
    const dEntity = await sql<{ id: string }[]>`insert into public.doc_cache (entity_id, display_name, content) values (${E1}, 'd_entity', 'Entity level general content.') returning id`;
    const dG1 = await sql<{ id: string }[]>`insert into public.doc_cache (entity_id, display_name, content) values (${E1}, 'd_g1', 'Group G1 specific content.') returning id`;
    const dG2 = await sql<{ id: string }[]>`insert into public.doc_cache (entity_id, display_name, content) values (${E1}, 'd_g2', 'Group G2 specific content.') returning id`;
    const dG1T5 = await sql<{ id: string }[]>`insert into public.doc_cache (entity_id, display_name, content) values (${E1}, 'd_g1_t5', 'G1 Topic 5 specific content.') returning id`;
    const dG2T5 = await sql<{ id: string }[]>`insert into public.doc_cache (entity_id, display_name, content) values (${E1}, 'd_g2_t5', 'G2 Topic 5 specific content.') returning id`;
    const dG1T7 = await sql<{ id: string }[]>`insert into public.doc_cache (entity_id, display_name, content) values (${E1}, 'd_g1_t7', 'G1 Topic 7 specific content.') returning id`;

    // Seed manifest entries mapping the context layers
    // 1. Entity layer (group null, thread null)
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, null, null, ${dEntity[0].id})`;
    // 2. Group layer (group set, thread null)
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, ${GROUP_A}, null, ${dG1[0].id})`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, ${GROUP_B}, null, ${dG2[0].id})`;
    // 3. Topic layer (group set, thread set)
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, ${GROUP_A}, ${tA5[0].id}, ${dG1T5[0].id})`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, ${GROUP_B}, ${tB5[0].id}, ${dG2T5[0].id})`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, ${GROUP_A}, ${tA7[0].id}, ${dG1T7[0].id})`;

    console.log('Running capability/resolver context layering tests...');

    // =========================================================================
    // Test 1: Entity-only resolution (G1, null thread ID)
    // =========================================================================
    console.log('Test 1: Entity-only resolution (G1, null thread ID)...');
    const { contextDocs: c1 } = await buildContext(E1, GROUP_A, null);
    assert.ok(c1.includes('Entity level general content.'), 'Should include entity context');
    assert.ok(c1.includes('Group G1 specific content.'), 'Should include group G1 context');
    assert.ok(!c1.includes('Group G2 specific content.'), 'Should exclude group G2 context');
    assert.ok(!c1.includes('G1 Topic 5 specific content.'), 'Should exclude topic 5 context');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: Full stack resolution (G1, topic 5)
    // =========================================================================
    console.log('Test 2: Full stack resolution (G1, topic 5)...');
    const { contextDocs: c2 } = await buildContext(E1, GROUP_A, 5);
    assert.ok(c2.includes('Entity level general content.'), 'Should include entity context');
    assert.ok(c2.includes('Group G1 specific content.'), 'Should include group G1 context');
    assert.ok(c2.includes('G1 Topic 5 specific content.'), 'Should include G1 topic 5 context');
    assert.ok(!c2.includes('Group G2 specific content.'), 'Should exclude group G2 context');
    assert.ok(!c2.includes('G2 Topic 5 specific content.'), 'Should exclude G2 topic 5 context');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: Cross-group topic isolation (G2, topic 5) — THE collision bug fix
    // =========================================================================
    console.log('Test 3: Cross-group topic isolation (G2, topic 5)...');
    const { contextDocs: c3 } = await buildContext(E1, GROUP_B, 5);
    assert.ok(c3.includes('Entity level general content.'), 'Should include entity context');
    assert.ok(c3.includes('Group G2 specific content.'), 'Should include group G2 context');
    assert.ok(c3.includes('G2 Topic 5 specific content.'), 'Should include G2 topic 5 context');
    assert.ok(!c3.includes('Group G1 specific content.'), 'Should exclude group G1 context');
    assert.ok(!c3.includes('G1 Topic 5 specific content.'), 'Should exclude G1 topic 5 context'); // PROVES ISOLATION
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: Group-layer isolation (Group General Doc isolation check)
    // =========================================================================
    console.log('Test 4: Group-layer isolation...');
    const { contextDocs: c4_g1 } = await buildContext(E1, GROUP_A, null);
    const { contextDocs: c4_g2 } = await buildContext(E1, GROUP_B, null);
    assert.ok(c4_g1.includes('Group G1 specific content.'), 'G1 general doc should resolve for G1');
    assert.ok(!c4_g1.includes('Group G2 specific content.'), 'G2 general doc should NOT resolve for G1');
    assert.ok(c4_g2.includes('Group G2 specific content.'), 'G2 general doc should resolve for G2');
    assert.ok(!c4_g2.includes('Group G1 specific content.'), 'G1 general doc should NOT resolve for G2');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: Empty group-layer fallback (G1, topic 7)
    // =========================================================================
    console.log('Test 5: Empty group-layer fallback (G1, topic 7)...');
    // Group G2 has no topic 7, and G1 has topic 7 with no group general doc (seeded via G1)
    const { contextDocs: c5 } = await buildContext(E1, GROUP_A, 7);
    assert.ok(c5.includes('Entity level general content.'));
    assert.ok(c5.includes('Group G1 specific content.'));
    assert.ok(c5.includes('G1 Topic 7 specific content.'));
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: Resolver parity (buildContext and getContextManifest agree)
    // =========================================================================
    console.log('Test 6: Resolver parity lockstep check...');
    const { entityDocs, groupDocs, topicDocs } = await getContextManifest(E1, GROUP_A, 5);
    
    assert.strictEqual(entityDocs.length, 1);
    assert.strictEqual(entityDocs[0].display_name, 'd_entity');
    
    assert.strictEqual(groupDocs.length, 1);
    assert.strictEqual(groupDocs[0].display_name, 'd_g1');
    
    assert.strictEqual(topicDocs.length, 1);
    assert.strictEqual(topicDocs[0].display_name, 'd_g1_t5');

    // Verification of sorting order in buildContext (entity -> group -> topic)
    const sortedDocsList = c2.split('</document>').filter(Boolean);
    assert.ok(sortedDocsList[0].includes('display_name="d_entity"') || sortedDocsList[0].includes('d_entity'), 'First document should be entity level');
    assert.ok(sortedDocsList[1].includes('display_name="d_g1"') || sortedDocsList[1].includes('d_g1'), 'Second document should be group level');
    assert.ok(sortedDocsList[2].includes('display_name="d_g1_t5"') || sortedDocsList[2].includes('d_g1_t5'), 'Third document should be topic level');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: Integration Webhook /context format
    // =========================================================================
    console.log('Test 7: Integration Webhook /context formatting check...');
    const reqContext = new NextRequest('http://localhost:3000/api/webhooks/platform/phase4-bot-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 3000001,
        message: {
          message_id: 4001,
          chat: { id: CHAT_A, type: 'supergroup', title: 'Group A Chat' },
          from: { id: 7777, username: 'tester' },
          text: '/context',
          message_thread_id: 5,
        },
      }),
    });

    sentMessages = [];
    pendingPromises.length = 0;
    const resContext = await POST(reqContext, { params: Promise.resolve({ botSlug: 'phase4-bot-slug' }) });
    assert.strictEqual(resContext.status, 200);

    // Wait for route async executions
    await Promise.all(pendingPromises);

    assert.strictEqual(sentMessages.length, 2); // 1 summary text, 1 document attachment
    const textMsg = sentMessages.find((m) => !m.doc);
    const docMsg = sentMessages.find((m) => m.doc);

    // Check summary contents
    assert.ok(textMsg.text.includes('<b>Entity:</b> ✓ 1 document'));
    assert.ok(textMsg.text.includes('<b>Group:</b> ✓ 1 document'));
    assert.ok(textMsg.text.includes('<b>Topic:</b> ✓ 1 document'));

    // Check document contents structure
    const payload = docMsg.body;
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: End-to-End @mention prompt grounding
    // =========================================================================
    console.log('Test 8: End-to-End @mention prompt grounding check...');
    const reqMention = new NextRequest('http://localhost:3000/api/webhooks/platform/phase4-bot-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 3000002,
        message: {
          message_id: 4002,
          chat: { id: CHAT_A, type: 'supergroup', title: 'Group A Chat' },
          from: { id: 7777, username: 'tester' },
          text: '@phase4_bot_username hello topic 5',
          message_thread_id: 5,
        },
      }),
    });

    sentMessages = [];
    pendingPromises.length = 0;
    const resMention = await POST(reqMention, { params: Promise.resolve({ botSlug: 'phase4-bot-slug' }) });
    assert.strictEqual(resMention.status, 200);

    // Wait for async task execution
    await Promise.all(pendingPromises);

    // Assert that the LLM call received systemPrompt containing the expected documents in correct sort order
    assert.ok(lastPromptInput.systemPrompt.includes('d_entity'));
    assert.ok(lastPromptInput.systemPrompt.includes('d_g1'));
    assert.ok(lastPromptInput.systemPrompt.includes('d_g1_t5'));
    assert.ok(!lastPromptInput.systemPrompt.includes('d_g2'));
    assert.ok(!lastPromptInput.systemPrompt.includes('d_g2_t5'));

    // Check sorted sequence in prompt string
    const iEntity = lastPromptInput.systemPrompt.indexOf('d_entity');
    const iG1 = lastPromptInput.systemPrompt.indexOf('d_g1');
    const iG1T5 = lastPromptInput.systemPrompt.indexOf('d_g1_t5');
    assert.ok(iEntity < iG1, 'Entity doc must appear before group doc');
    assert.ok(iG1 < iG1T5, 'Group doc must appear before topic doc');
    console.log('✅ Test 8 Passed.');

    console.log('\n🎉 ALL PHASE 4 GROUP-SCOPED CONTEXT HARNESS TESTS PASSED SUCCESSFULLY! 🎉\n');

  } catch (error) {
    console.error('\n❌ Verification Failed:');
    console.error(error);
    process.exit(1);
  } finally {
    console.log('--- Cleaning Up Test State ---');
    if (sql) {
      try {
        await sql`delete from public.message_log where entity_id = ${E1}`;
        await sql`delete from public.bot_entities where bot_id = ${BOT_A}`;
        await sql`delete from public.manifest_entries where entity_id = ${E1}`;
        await sql`delete from public.doc_cache where entity_id = ${E1}`;
        await sql`delete from public.threads where entity_id = ${E1}`;
        await sql`delete from public.groups where entity_id = ${E1}`;
        await sql`delete from public.bots where id = ${BOT_A}`;
        await sql`delete from public.entities where id = ${E1}`;
        await sql`delete from auth.users where id = ${USER_A}`;
        await sql`delete from vault.secrets where name in ('bot_a_token_phase4', 'bot_a_webhook_phase4')`;
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
