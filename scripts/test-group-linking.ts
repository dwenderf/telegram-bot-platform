// Adversarial Test Suite for Phase 2 Group Linking Flow
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-group-linking.ts

process.env.ANTHROPIC_API_KEY = 'dummy-test-key';

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

import postgres from 'postgres';
import assert from 'assert';
import { POST } from '../app/api/webhooks/telegram/[entitySlug]/route';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

let mockChatMemberStatus = 'administrator';

// Mock global fetch to intercept outbound Telegram API requests
const originalFetch = global.fetch;
global.fetch = (async (url: any, options: any) => {
  const urlStr = url.toString();
  if (urlStr.includes('api.telegram.org')) {
    if (urlStr.includes('getChatMember')) {
      return new Response(JSON.stringify({ ok: true, result: { status: mockChatMemberStatus } }), { status: 200 });
    }
    if (urlStr.includes('sendMessage') || urlStr.includes('setMessageReaction')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 12345 } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return originalFetch(url, options);
}) as any;

// Helper to run query as a simulated authenticated Supabase user
async function runAsUser<T>(
  sql: postgres.Sql,
  userId: string,
  email: string,
  callback: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`set local role = 'authenticated'`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, email })}, true)`;
    await tx`set local row_security = on`;
    return await callback(tx);
  })) as T;
}

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  let sql: postgres.Sql | null = null;
  let botSql: postgres.Sql | null = null;
  let secret1Id: string | null = null;
  let secret2Id: string | null = null;

  // Test state UUIDs
  const USER_A = 'a0000000-0000-0000-0000-000000000000'; // Owner of E1
  const USER_B = 'b0000000-0000-0000-0000-000000000000'; // Owner of E2
  const VIEWER_U = 'd0000002-0000-0000-0000-000000000000'; // Viewer of E1
  const STRANGER = 'c0000000-0000-0000-0000-000000000000'; // Stranger

  const E1 = 'e1000000-0000-0000-0000-000000000000';
  const E2 = 'e2000000-0000-0000-0000-000000000000';

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('Both ADMIN_DATABASE_URL and DATABASE_URL are required to run RLS verification tests.');
    }

    sql = postgres(adminUrl, { max: 10, prepare: false });
    botSql = postgres(botUrl, { max: 5, prepare: false });

    console.log('--- Applying Migration Schema ---');
    const migrationPath = path.join(__dirname, '../supabase/migrations/20260628000000_group_linking.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await sql.unsafe(migrationSql);

    console.log('--- Setting Up Test Environment ---');

    // Clean up stale groups, link_tokens, entities, users, and Vault secrets
    await sql`delete from public.groups where entity_id in (${E1}, ${E2})`;
    await sql`delete from public.link_tokens where entity_id in (${E1}, ${E2})`;
    await sql`delete from public.entities where id in (${E1}, ${E2})`;
    await sql`delete from auth.users where id in (${USER_A}, ${USER_B}, ${VIEWER_U}, ${STRANGER})`;
    await sql`delete from vault.secrets where name in ('test_token', 'test_webhook_secret')`;

    // Create Vault secrets for webhook mapping
    const s1 = await sql<{ id: string }[]>`select vault.create_secret('mock-bot-token', 'test_token') as id`;
    const s2 = await sql<{ id: string }[]>`select vault.create_secret('mock-webhook-secret', 'test_webhook_secret') as id`;
    secret1Id = s1[0]?.id;
    secret2Id = s2[0]?.id;

    // Provision auth users
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_a@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_B}, 'owner_b@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${VIEWER_U}, 'viewer@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${STRANGER}, 'stranger@test.com', now(), 'authenticated', 'authenticated')`;

    // Create entities
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username, telegram_bot_token_id, telegram_webhook_secret_id)
              values (${E1}, 'entity-1-test', 'Entity 1', ${USER_A}, 'test_bot', ${secret1Id}, ${secret2Id})`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E2}, 'entity-2-test', 'Entity 2', ${USER_B}, 'test2_bot')`;

    // Create viewer authorization on E1
    await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
              values (${E1}, ${VIEWER_U}, 'viewer', 'active', ${USER_A})`;

    console.log('Setup completed. Running tests...\n');

    // =========================================================================
    // Test Case 1: Minting Gating
    // =========================================================================
    console.log('Test 1: Minting gating (Viewer/Editor cannot mint)...');
    try {
      await runAsUser(sql, VIEWER_U, 'viewer@test.com', async (tx) => {
        return await tx`select public.mint_link_token(${E1})`;
      });
      assert.fail('Test 1 Failed: Viewer successfully minted a link token');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 1 Failed: Expected Access Denied (42501)');
    }

    try {
      await runAsUser(sql, STRANGER, 'stranger@test.com', async (tx) => {
        return await tx`select public.mint_link_token(${E1})`;
      });
      assert.fail('Test 1 Failed: Stranger successfully minted a link token');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 1 Failed: Expected Access Denied (42501)');
    }
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test Case 2: List Gating (S4)
    // =========================================================================
    console.log('Test 2: List gating (unauthorized cannot list entity groups)...');
    try {
      await runAsUser(sql, VIEWER_U, 'viewer@test.com', async (tx) => {
        return await tx`select * from public.list_entity_groups(${E1})`;
      });
      assert.fail('Test 2 Failed: Viewer successfully listed entity groups');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 2 Failed: Expected Access Denied (42501)');
    }

    try {
      await runAsUser(sql, STRANGER, 'stranger@test.com', async (tx) => {
        return await tx`select * from public.list_entity_groups(${E1})`;
      });
      assert.fail('Test 2 Failed: Stranger successfully listed entity groups');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 2 Failed: Expected Access Denied (42501)');
    }
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test Case 3: Execute Grant Security (B1)
    // =========================================================================
    console.log('Test 3: Execute grant security (authenticated role denied consume)...');
    try {
      await runAsUser(sql, USER_A, 'owner_a@test.com', async (tx) => {
        return await tx`select * from public.consume_link_token('MOCKCODE12', ${E1}, 100001, 8888, 'Group', true)`;
      });
      assert.fail('Test 3 Failed: Authenticated web user successfully called consume_link_token');
    } catch (e: any) {
      assert.strictEqual(e.code, '42501', 'Test 3 Failed: Expected Access Denied (42501)');
    }
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test Case 4: Happy Path
    // =========================================================================
    console.log('Test 4: Happy path linking...');
    const codeE1 = await runAsUser(sql, USER_A, 'owner_a@test.com', async (tx) => {
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E1})`;
      return res[0].mint_link_token;
    });
    assert.strictEqual(codeE1.length, 10, 'Test 4 Failed: Expected 10-char Crockford base32 code');

    // Run consume as bot_service
    const linkResult = await botSql<{ entity_id: string; display_name: string }[]>`
      select * from public.consume_link_token(${codeE1}, ${E1}, 999001, 8888, 'My Test Group', true)
    `;
    assert.strictEqual(linkResult.length, 1, 'Test 4 Failed: Expected consume result');
    assert.strictEqual(linkResult[0].entity_id, E1, 'Test 4 Failed: Incorrect bound entity');
    assert.strictEqual(linkResult[0].display_name, 'Entity 1', 'Test 4 Failed: Incorrect display name returned');

    // Assert post-state
    const boundGroups = await sql`select * from public.groups where telegram_chat_id = 999001`;
    assert.strictEqual(boundGroups.length, 1, 'Test 4 Failed: Group was not bound');
    assert.strictEqual(boundGroups[0].entity_id, E1, 'Test 4 Failed: Group bound to wrong entity');
    assert.strictEqual(boundGroups[0].display_name, 'My Test Group', 'Test 4 Failed: Group display name mismatch');

    const consumedToken = await sql`select * from public.link_tokens where token_hash = encode(sha256(${codeE1}::bytea), 'hex')`;
    assert.strictEqual(consumedToken.length, 1);
    assert.ok(consumedToken[0].consumed_at, 'Test 4 Failed: Token consumed_at was not set');
    assert.strictEqual(consumedToken[0].consumed_chat_id, '999001', 'Test 4 Failed: consumed_chat_id mismatch');
    assert.strictEqual(consumedToken[0].consumed_by_tg_user_id, '8888', 'Test 4 Failed: consumed_by_tg_user_id mismatch');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test Case 5: Replay Prevention
    // =========================================================================
    console.log('Test 5: Replay prevention...');
    try {
      await botSql`select * from public.consume_link_token(${codeE1}, ${E1}, 999001, 8888, 'My Test Group', true)`;
      assert.fail('Test 5 Failed: Re-consumed the same token successfully');
    } catch (e: any) {
      assert.strictEqual(e.message, 'already_consumed', 'Test 5 Failed: Expected already_consumed exception');
    }
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test Case 6: Concurrent Race (S3)
    // =========================================================================
    console.log('Test 6: Concurrent race double-consume...');
    const raceCode = await runAsUser(sql, USER_A, 'owner_a@test.com', async (tx) => {
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E1})`;
      return res[0].mint_link_token;
    });

    const p1 = botSql`select * from public.consume_link_token(${raceCode}, ${E1}, 999002, 8888, 'Race Group', true)`;
    const p2 = botSql`select * from public.consume_link_token(${raceCode}, ${E1}, 999002, 8888, 'Race Group', true)`;

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.strictEqual(fulfilled.length, 1, 'Test 6 Failed: Expected exactly one race call to succeed');
    assert.strictEqual(rejected.length, 1, 'Test 6 Failed: Expected exactly one race call to fail');
    assert.strictEqual((rejected[0] as any).reason.message, 'already_consumed', 'Test 6 Failed: Expected failure reason to be already_consumed');

    const raceGroups = await sql`select * from public.groups where telegram_chat_id = 999002`;
    assert.strictEqual(raceGroups.length, 1, 'Test 6 Failed: Expected exactly one groups row bound');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test Case 7: Same-Entity Idempotent Rebind
    // =========================================================================
    console.log('Test 7: Same-entity idempotent rebind...');
    const rebindCode = await runAsUser(sql, USER_A, 'owner_a@test.com', async (tx) => {
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E1})`;
      return res[0].mint_link_token;
    });

    // Re-bind chat 999001 (already bound to E1 in test 4) to E1 again with a new display name
    const rebindRes = await botSql<{ entity_id: string; display_name: string }[]>`
      select * from public.consume_link_token(${rebindCode}, ${E1}, 999001, 8888, 'Refreshed Name', true)
    `;
    assert.strictEqual(rebindRes[0].entity_id, E1);
    
    // Check group display name updated
    const updatedGroup = await sql`select display_name from public.groups where telegram_chat_id = 999001`;
    assert.strictEqual(updatedGroup[0].display_name, 'Refreshed Name', 'Test 7 Failed: Idempotent rebind did not refresh display_name');
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test Case 8: Takeover Protection
    // =========================================================================
    console.log('Test 8: Takeover protection...');
    // Seed chat 999003 bound to E1
    await sql`insert into public.groups (entity_id, telegram_chat_id, display_name) values (${E1}, 999003, 'Entity 1 Chat')`;

    // Mint a code for E2
    const codeE2 = await runAsUser(sql, USER_B, 'owner_b@test.com', async (tx) => {
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E2})`;
      return res[0].mint_link_token;
    });

    // Try to bind E1's chat (999003) using E2's token (takeover attempt)
    try {
      await botSql`select * from public.consume_link_token(${codeE2}, ${E2}, 999003, 8888, 'Takeover Group', true)`;
      assert.fail('Test 8 Failed: Takeover attempt succeeded');
    } catch (e: any) {
      assert.strictEqual(e.message, 'chat_bound_elsewhere', 'Test 8 Failed: Expected chat_bound_elsewhere exception');
    }

    // Assert post-state: B's token is NOT consumed, group binding remains unchanged (points to E1)
    const tokenE2 = await sql`select consumed_at from public.link_tokens where token_hash = encode(sha256(${codeE2}::bytea), 'hex')`;
    assert.strictEqual(tokenE2[0].consumed_at, null, 'Test 8 Failed: Token was incorrectly marked as consumed');

    const groupTakeoverCheck = await sql`select entity_id from public.groups where telegram_chat_id = 999003`;
    assert.strictEqual(groupTakeoverCheck[0].entity_id, E1, 'Test 8 Failed: Group binding was corrupted or takeover occurred');
    console.log('✅ Test 8 Passed.');

    // =========================================================================
    // Test Case 9: Null-Guard Phase 3 Binding (B2)
    // =========================================================================
    console.log('Test 9: Null-guard Phase 3 binding...');
    const phase3Code = await runAsUser(sql, USER_A, 'owner_a@test.com', async (tx) => {
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E1})`;
      return res[0].mint_link_token;
    });

    const phase3Res = await botSql<{ entity_id: string; display_name: string }[]>`
      select * from public.consume_link_token(${phase3Code}, null, 999004, 8888, 'Phase 3 Group', true)
    `;
    assert.strictEqual(phase3Res[0].entity_id, E1, 'Test 9 Failed: Expected bound entity E1');

    // Assert the group was actually inserted in the DB under E1 (Critical B2 check!)
    const phase3Group = await sql`select * from public.groups where telegram_chat_id = 999004`;
    assert.strictEqual(phase3Group.length, 1, 'Test 9 Failed: Group binding was not created under null expected entity');
    assert.strictEqual(phase3Group[0].entity_id, E1, 'Test 9 Failed: Group was bound to wrong entity under null expected entity');
    console.log('✅ Test 9 Passed.');

    // =========================================================================
    // Test Case 10: Expiry Gate
    // =========================================================================
    console.log('Test 10: Expiry gate...');
    const expiredCode = await runAsUser(sql, USER_A, 'owner_a@test.com', async (tx) => {
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E1})`;
      return res[0].mint_link_token;
    });

    // Artificially expire the token in database
    await sql`update public.link_tokens set expires_at = now() - interval '1 second' where token_hash = encode(sha256(${expiredCode}::bytea), 'hex')`;

    try {
      await botSql`select * from public.consume_link_token(${expiredCode}, ${E1}, 999005, 8888, 'Expired Group', true)`;
      assert.fail('Test 10 Failed: Expired code was consumed successfully');
    } catch (e: any) {
      assert.strictEqual(e.message, 'expired', 'Test 10 Failed: Expected expired exception');
    }
    console.log('✅ Test 10 Passed.');

    // =========================================================================
    // Test Case 11: Forum Gate
    // =========================================================================
    console.log('Test 11: Forum gate...');
    const forumCode = await runAsUser(sql, USER_A, 'owner_a@test.com', async (tx) => {
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E1})`;
      return res[0].mint_link_token;
    });

    try {
      await botSql`select * from public.consume_link_token(${forumCode}, ${E1}, 999006, 8888, 'Non-Forum Group', false)`;
      assert.fail('Test 11 Failed: Non-forum chat was linked successfully');
    } catch (e: any) {
      assert.strictEqual(e.message, 'not_forum', 'Test 11 Failed: Expected not_forum exception');
    }
    console.log('✅ Test 11 Passed.');

    // =========================================================================
    // Test Case 12: Admin-Gate Webhook Handler Integration (S1)
    // =========================================================================
    console.log('Test 12: Admin-gate webhook handler integration...');
    // Mint code for E1
    const webhookCode = await runAsUser(sql, USER_A, 'owner_a@test.com', async (tx) => {
      const res = await tx<{ mint_link_token: string }[]>`select public.mint_link_token(${E1})`;
      return res[0].mint_link_token;
    });

    // Mock non-admin user
    mockChatMemberStatus = 'member';

    const req = new NextRequest('http://localhost:3000/api/webhooks/telegram/entity-1-test', {
      method: 'POST',
      headers: {
        'x-telegram-bot-api-secret-token': 'mock-webhook-secret', // not matched, but wait, E1 has no secret in vault
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 200001,
        message: {
          message_id: 1001,
          chat: { id: 999007, type: 'supergroup', is_forum: true, title: 'Web Group' },
          from: { id: 7777, username: 'nonadmin' },
          text: `/auth ${webhookCode}`,
        },
      }),
    });

    // Verify that the webhook POST function validates the x-telegram-bot-api-secret-token correctly.
    // The setup block seeded Vault secrets for E1, so 'x-telegram-bot-api-secret-token' matches the configured secret.
    const res = await POST(req, { params: Promise.resolve({ entitySlug: 'entity-1-test' }) });
    const resJson = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(resJson.msg, 'Not admin', 'Expected command to reject with Not admin');

    // Assert that:
    // 1. The token was NOT consumed
    const tokenCheck = await sql`select consumed_at from public.link_tokens where token_hash = encode(sha256(${webhookCode}::bytea), 'hex')`;
    assert.strictEqual(tokenCheck[0].consumed_at, null, 'Test 12 Failed: Token was consumed by a non-admin');

    // 2. No groups row was created for chat 999007
    const groupCheck = await sql`select * from public.groups where telegram_chat_id = 999007`;
    assert.strictEqual(groupCheck.length, 0, 'Test 12 Failed: Group row was created for a non-admin request');

    // Restore administrator status
    mockChatMemberStatus = 'administrator';
    console.log('✅ Test 12 Passed.');

    console.log('\n🎉 ALL PHASE 2 GROUP-LINKING TESTS PASSED SUCCESSFULLY! 🎉');

  } catch (error) {
    console.error('\n❌ Verification Failed:');
    console.error(error);
    process.exit(1);
  } finally {
    console.log('\n--- Cleaning Up Test Environment ---');
    if (sql) {
      try {
        await sql`delete from public.groups where entity_id in (${E1}, ${E2})`;
        await sql`delete from public.link_tokens where entity_id in (${E1}, ${E2})`;
        await sql`delete from public.entities where id in (${E1}, ${E2})`;
        await sql`delete from auth.users where id in (${USER_A}, ${USER_B}, ${VIEWER_U}, ${STRANGER})`;
        await sql`delete from vault.secrets where name in ('test_token', 'test_webhook_secret')`;
        if (secret1Id) await sql`delete from vault.secrets where id = ${secret1Id}`;
        if (secret2Id) await sql`delete from vault.secrets where id = ${secret2Id}`;
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
