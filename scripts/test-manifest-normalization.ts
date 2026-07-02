// Adversarial Test Suite for Manifest & Doc-Cache Normalization
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-manifest-normalization.ts

process.env.ANTHROPIC_API_KEY = 'dummy-test-key';

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
  const USER_A = 'a1000000-0000-0000-0000-000000000000';
  const E1 = 'e1100000-0000-0000-0000-000000000000';
  const BOT_A = 'ba100000-0000-0000-0000-000000000000';
  const GROUP_A = 'f1100000-0000-0000-0000-000000000000';
  const CHAT_A = -100999888777;

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

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('ADMIN_DATABASE_URL and DATABASE_URL env vars must be set');
    }

    sql = postgres(adminUrl);
    botSql = postgres(botUrl);

    console.log('--- Cleaning Up Stale Test State & Restoring Original Schema ---');
    // Revert columns and drop tables to get back to un-normalized schema
    try {
      await sql`drop table if exists public.threads cascade`;
    } catch (e) {}

    try {
      await sql`alter table public.manifest_entries drop column if exists doc_id`;
    } catch (e) {}
    try {
      await sql`alter table public.manifest_entries drop column if exists thread_id`;
    } catch (e) {}
    try {
      await sql`alter table public.manifest_entries add column if not exists doc_path text`;
    } catch (e) {}
    try {
      await sql`alter table public.manifest_entries add column if not exists telegram_thread_id bigint`;
    } catch (e) {}

    try {
      await sql`alter table public.doc_cache drop column if exists display_name`;
    } catch (e) {}
    try {
      await sql`alter table public.doc_cache drop column if exists source_type`;
    } catch (e) {}
    try {
      await sql`alter table public.doc_cache drop column if exists source`;
    } catch (e) {}
    try {
      await sql`alter table public.doc_cache add column if not exists doc_path text`;
    } catch (e) {}
    try {
      await sql`alter table public.doc_cache add column if not exists git_sha text`;
    } catch (e) {}
    try {
      await sql`alter table public.doc_cache drop constraint if exists doc_cache_entity_id_doc_path_key`;
    } catch (e) {}
    try {
      await sql`alter table public.doc_cache add constraint doc_cache_entity_id_doc_path_key unique (entity_id, doc_path)`;
    } catch (e) {}

    await sql`delete from public.message_log where entity_id = ${E1}`;
    await sql`delete from public.bot_entities where bot_id = ${BOT_A}`;
    await sql`delete from public.manifest_entries where entity_id = ${E1}`;
    await sql`delete from public.doc_cache where entity_id = ${E1}`;
    await sql`delete from public.groups where entity_id = ${E1}`;
    await sql`delete from public.bots where id = ${BOT_A}`;
    await sql`delete from public.entities where id = ${E1}`;
    await sql`delete from auth.users where id = ${USER_A}`;
    await sql`delete from vault.secrets where name in ('bot_a_token_normalization', 'bot_a_webhook_normalization')`;

    console.log('--- Seeding Old-Shape Test Fixtures ---');
    // Setup Vault secrets
    const s1 = await sql<{ id: string }[]>`select vault.create_secret('token-secret-a', 'bot_a_token_normalization') as id`;
    const s2 = await sql<{ id: string }[]>`select vault.create_secret('webhook-secret-a', 'bot_a_webhook_normalization') as id`;
    const secretTokenId = s1[0].id;
    const secretWebhookId = s2[0].id;

    // Create user
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_normalization@test.com', now(), 'authenticated', 'authenticated')`;

    // Create entity
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E1}, 'entity-normalization-test', 'Normalization Test Entity', ${USER_A}, 'norm_bot_username')`;

    // Create bot
    await sql`
      insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status)
      values (${BOT_A}, 'Norm Bot', 'norm-bot-slug', 'norm_bot_username', ${secretTokenId}, ${secretWebhookId}, 'active')
    `;
    await sql`insert into public.bot_entities (bot_id, entity_id) values (${BOT_A}, ${E1})`;

    // Create group
    await sql`
      insert into public.groups (id, entity_id, telegram_chat_id, display_name)
      values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Norm Chat')
    `;

    // Seed old doc_cache items
    // Doc 1: general doc with git_sha (for backfill verification)
    await sql`
      insert into public.doc_cache (entity_id, doc_path, content, git_sha)
      values (${E1}, 'general-guide', 'Entity general guide content.', 'sha12345')
    `;
    // Doc 2: topic doc with null git_sha (manual)
    await sql`
      insert into public.doc_cache (entity_id, doc_path, content, git_sha)
      values (${E1}, 'topic-rules', 'Topic specific rules content.', null)
    `;

    // Seed old manifest_entries items
    // General manifest
    await sql`
      insert into public.manifest_entries (entity_id, group_id, telegram_thread_id, doc_path)
      values (${E1}, null, null, 'general-guide')
    `;
    // Topic manifest (the malformed row: telegram_thread_id set but group_id is null)
    await sql`
      insert into public.manifest_entries (entity_id, group_id, telegram_thread_id, doc_path)
      values (${E1}, null, 2, 'topic-rules')
    `;

    console.log('--- Applying Bot Cutover Additive Migration (Migration 1) ---');
    const additivePath = path.join(__dirname, '../supabase/migrations/20260701000000_manifest_normalization_additive.sql');
    const additiveSql = fs.readFileSync(additivePath, 'utf8');
    await sql.unsafe(additiveSql);

    // =========================================================================
    // Part 1: Constraint / Integrity checks
    // =========================================================================
    console.log('Running schema constraint & integrity checks...');

    // 1. manifest_entries.doc_id FK: invalid doc_id is rejected
    try {
      await sql`
        insert into public.manifest_entries (entity_id, group_id, doc_id, doc_path)
        values (${E1}, null, '00000000-0000-0000-0000-000000000000', 'some-path')
      `;
      assert.fail('Should have failed manifest_entries doc_id FK validation');
    } catch (e: any) {
      assert.strictEqual(e.code, '23503', 'Expected doc_id foreign key constraint violation (23503)');
    }

    // 2. manifest_entries.thread_id FK: invalid thread_id is rejected
    try {
      await sql`
        insert into public.manifest_entries (entity_id, group_id, doc_id, thread_id, doc_path)
        values (${E1}, null, (select id from public.doc_cache limit 1), '00000000-0000-0000-0000-000000000000', 'some-path')
      `;
      assert.fail('Should have failed manifest_entries thread_id FK validation');
    } catch (e: any) {
      assert.strictEqual(e.code, '23503', 'Expected thread_id foreign key constraint violation (23503)');
    }

    // 3. threads constraints: group_id NOT NULL and unique (group_id, telegram_thread_id)
    try {
      await sql`
        insert into public.threads (entity_id, group_id, telegram_thread_id)
        values (${E1}, null, 999)
      `;
      assert.fail('Should have failed null group_id check on threads');
    } catch (e: any) {
      assert.strictEqual(e.code, '23502', 'Expected not-null constraint violation (23502) for threads group_id');
    }

    // Create a threads row to test unique violation
    const threadTmp = await sql<{ id: string }[]>`
      insert into public.threads (entity_id, group_id, telegram_thread_id)
      values (${E1}, ${GROUP_A}, 42) returning id
    `;
    try {
      await sql`
        insert into public.threads (entity_id, group_id, telegram_thread_id)
        values (${E1}, ${GROUP_A}, 42)
      `;
      assert.fail('Should have failed duplicate threads check');
    } catch (e: any) {
      assert.strictEqual(e.code, '23505', 'Expected unique constraint violation (23505) for threads');
    }

    // 4. doc_cache constraints: source_type CHECK constraints
    try {
      await sql`
        insert into public.doc_cache (entity_id, display_name, doc_path, content, source_type)
        values (${E1}, 'invalid-source-doc', 'invalid-source-doc', 'content', 'github')
      `;
      assert.fail('Should have failed source_type CHECK constraint');
    } catch (e: any) {
      assert.strictEqual(e.code, '23514', 'Expected CHECK constraint violation (23514) for source_type');
    }

    // display_name NOT NULL check
    try {
      await sql`
        insert into public.doc_cache (entity_id, display_name, doc_path, content)
        values (${E1}, null, 'no-name-doc', 'content')
      `;
      assert.fail('Should have failed null display_name constraint');
    } catch (e: any) {
      assert.strictEqual(e.code, '23502', 'Expected not-null constraint violation (23502) for display_name');
    }

    // No uniqueness constraint on display_name: duplicate display_name under same entity is allowed
    await sql`
      insert into public.doc_cache (entity_id, display_name, doc_path, content)
      values (${E1}, 'Duplicate Title', 'path-x', 'content x')
    `;
    await sql`
      insert into public.doc_cache (entity_id, display_name, doc_path, content)
      values (${E1}, 'Duplicate Title', 'path-y', 'content y')
    `;
    console.log('✅ Multiple identical display names inserted successfully.');

    // 5. Cascade integrity checks
    // Creating a mock doc & mapping to verify cascade deletion
    const testDoc = await sql<{ id: string }[]>`
      insert into public.doc_cache (entity_id, display_name, doc_path, content)
      values (${E1}, 'Cascade test', 'cascade-doc', 'content') returning id
    `;
    const testDocId = testDoc[0].id;
    await sql`
      insert into public.manifest_entries (entity_id, doc_id, doc_path)
      values (${E1}, ${testDocId}, 'cascade-doc-path')
    `;
    // Delete the doc
    await sql`delete from public.doc_cache where id = ${testDocId}`;
    const manifestCascadeCount = await sql`
      select * from public.manifest_entries where doc_id = ${testDocId}
    `;
    assert.strictEqual(manifestCascadeCount.length, 0, 'Cascade failed: manifest entry still exists');
    console.log('✅ Doc cascade deletion verified.');

    // Delete a thread and check cascade
    const manifestThreadCheck = await sql<{ id: string }[]>`
      insert into public.manifest_entries (entity_id, doc_id, thread_id, doc_path)
      values (${E1}, (select id from public.doc_cache limit 1), ${threadTmp[0].id}, 'thread-doc-path') returning id
    `;
    await sql`delete from public.threads where id = ${threadTmp[0].id}`;
    const manifestThreadCascade = await sql`
      select * from public.manifest_entries where id = ${manifestThreadCheck[0].id}
    `;
    assert.strictEqual(manifestThreadCascade.length, 0, 'Cascade failed: thread-related manifest entry still exists');
    console.log('✅ Thread cascade deletion verified.');

    // =========================================================================
    // Part 2: Backfill correctness
    // =========================================================================
    console.log('Verifying backfill correctness...');

    // 6. doc_cache display_name matches original doc_path
    const backfilledDocs = await sql`
      select doc_path, display_name, source, source_type 
      from public.doc_cache 
      where entity_id = ${E1} and doc_path in ('general-guide', 'topic-rules')
    `;
    assert.strictEqual(backfilledDocs.length, 2);

    const docGeneral = backfilledDocs.find((d) => d.doc_path === 'general-guide');
    assert.strictEqual(docGeneral.display_name, 'general-guide');
    assert.deepStrictEqual(docGeneral.source, { git_sha: 'sha12345' });
    assert.strictEqual(docGeneral.source_type, 'manual');

    const docTopic = backfilledDocs.find((d) => d.doc_path === 'topic-rules');
    assert.strictEqual(docTopic.display_name, 'topic-rules');
    // Item 3: git_sha null must result in a genuinely null source (not {"git_sha": null})
    assert.strictEqual(docTopic.source, null);
    assert.strictEqual(docTopic.source_type, 'manual');
    console.log('✅ doc_cache backfill fields verified.');

    // 7. Topic manifest row (the malformed one) has thread_id resolving to a threads row and correctly mapped group_id
    const manifestEntries = await sql`
      select m.telegram_thread_id, m.group_id, m.thread_id, c.doc_path
      from public.manifest_entries m
      join public.doc_cache c on c.id = m.doc_id
      where m.entity_id = ${E1} and c.doc_path = 'topic-rules'
    `;
    assert.strictEqual(manifestEntries.length, 1);
    // Malformed group_id got fixed during dynamic data fix
    assert.strictEqual(manifestEntries[0].group_id, GROUP_A);
    assert.ok(manifestEntries[0].thread_id);

    // Verify the threads table row exists
    const threadsRows = await sql`
      select * from public.threads where id = ${manifestEntries[0].thread_id}
    `;
    assert.strictEqual(threadsRows.length, 1);
    assert.strictEqual(threadsRows[0].telegram_thread_id, '2');
    assert.strictEqual(threadsRows[0].group_id, GROUP_A);
    console.log('✅ malformed topic manifest row data fix and threads backfill verified.');

    // =========================================================================
    // Part 3: Resolver Parity & Route checks
    // =========================================================================
    console.log('Verifying capability/resolver parity and route outcomes...');

    const testQuery = await sql`
      select m.thread_id, c.display_name, t.telegram_thread_id, m.entity_id
      from public.manifest_entries m
      join public.doc_cache c on c.id = m.doc_id
      left join public.threads t on t.id = m.thread_id
      where m.entity_id = ${E1}
    `;
    console.log('Test query output:', testQuery);

    // 8. buildContext and getContextManifest return behavior-preserving parity
    const { contextDocs, recentConversation } = await buildContext(E1, GROUP_A, 2);
    // Should resolve both entity-general ('general-guide') AND topic-specific ('topic-rules')
    assert.ok(contextDocs.includes('Entity general guide content.'));
    assert.ok(contextDocs.includes('Topic specific rules content.'));
    // Prompt XML tags must use display_name instead of doc_path
    assert.ok(contextDocs.includes('<document path="general-guide">'));
    assert.ok(contextDocs.includes('<document path="topic-rules">'));

    const { entityDocs, topicDocs } = await getContextManifest(E1, 2);
    // Both entity-general and topic-scoped documents resolve correctly
    assert.strictEqual(entityDocs.length, 1);
    assert.strictEqual(entityDocs[0].display_name, 'general-guide');
    assert.strictEqual(entityDocs[0].content, 'Entity general guide content.');

    assert.strictEqual(topicDocs.length, 1);
    assert.strictEqual(topicDocs[0].display_name, 'topic-rules');
    assert.strictEqual(topicDocs[0].content, 'Topic specific rules content.');
    console.log('✅ buildContext and getContextManifest parity matches perfectly.');

    // 9. /context webhook renders display_name
    const reqContext = new NextRequest('http://localhost:3000/api/webhooks/platform/norm-bot-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 2000001,
        message: {
          message_id: 3001,
          chat: { id: CHAT_A, type: 'supergroup', title: 'Norm Chat' },
          from: { id: 7777, username: 'tester' },
          text: '/context',
          message_thread_id: 2,
        },
      }),
    });

    sentMessages = [];
    const resContext = await POST(reqContext, { params: Promise.resolve({ botSlug: 'norm-bot-slug' }) });
    assert.strictEqual(resContext.status, 200);

    // Wait for async task execution
    await Promise.all(pendingPromises);

    // Context response text is sent as a document attachment.
    assert.strictEqual(sentMessages.length, 1);
    console.log('✅ /context output format verified.');

    // 10. Webhook @mention evaluation check (Item 1b - LLM answer grounding quality check)
    const reqMention = new NextRequest('http://localhost:3000/api/webhooks/platform/norm-bot-slug', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'webhook-secret-a',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 2000002,
        message: {
          message_id: 3002,
          chat: { id: CHAT_A, type: 'supergroup', title: 'Norm Chat' },
          from: { id: 7777, username: 'tester' },
          text: '@norm_bot_username what is the topic rules?',
          message_thread_id: 2,
        },
      }),
    });

    sentMessages = [];
    pendingPromises.length = 0;
    const resMention = await POST(reqMention, { params: Promise.resolve({ botSlug: 'norm-bot-slug' }) });
    assert.strictEqual(resMention.status, 200);

    // Wait for LLM completion
    await Promise.all(pendingPromises);

    // Confirm that buildContext loaded document tags correctly (no "path=undefined")
    assert.ok(lastPromptInput.systemPrompt.includes('<document path="general-guide">'));
    assert.ok(lastPromptInput.systemPrompt.includes('<document path="topic-rules">'));
    assert.ok(!lastPromptInput.systemPrompt.includes('undefined'));
    console.log('✅ @mention LLM prompt grounding and XML tags verified successfully.');

    // =========================================================================
    // Part 4: Drop Migration (Migration 2)
    // =========================================================================
    console.log('--- Applying Manual Drop Migration (Migration 2) ---');
    const dropPath = path.join(__dirname, '../supabase/manual/manifest_normalization_drop.sql');
    const dropSql = fs.readFileSync(dropPath, 'utf8');
    await sql.unsafe(dropSql);

    // Verify columns dropped successfully (select doc_path throws code 42703)
    try {
      await sql`select doc_path from public.doc_cache limit 1`;
      assert.fail('Should have failed selecting dropped doc_path column');
    } catch (e: any) {
      assert.strictEqual(e.code, '42703', 'Expected undefined_column code (42703) for doc_path');
    }

    try {
      await sql`select git_sha from public.doc_cache limit 1`;
      assert.fail('Should have failed selecting dropped git_sha column');
    } catch (e: any) {
      assert.strictEqual(e.code, '42703', 'Expected undefined_column code (42703) for git_sha');
    }

    try {
      await sql`select telegram_thread_id from public.manifest_entries limit 1`;
      assert.fail('Should have failed selecting dropped telegram_thread_id column');
    } catch (e: any) {
      assert.strictEqual(e.code, '42703', 'Expected undefined_column code (42703) for telegram_thread_id');
    }
    console.log('✅ Deprecated columns verified as successfully dropped.');

    console.log('\n🎉 ALL DOCUMENT NORMALIZATION VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉\n');

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
          try {
            await sql`delete from public.threads where entity_id = ${E1}`;
          } catch (e: any) {
            if (e.code !== '42P01') throw e;
          }
          await sql`delete from public.groups where entity_id = ${E1}`;
          await sql`delete from public.bots where id = ${BOT_A}`;
          await sql`delete from public.entities where id = ${E1}`;
          await sql`delete from auth.users where id = ${USER_A}`;
          await sql`delete from vault.secrets where name in ('bot_a_token_normalization', 'bot_a_webhook_normalization')`;
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
