// Test suite for Raw Telegram Event Archive
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-telegram-event-archive.ts

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  let sql: postgres.Sql | null = null;
  let botSql: postgres.Sql | null = null;

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('ADMIN_DATABASE_URL and DATABASE_URL env vars must be set');
    }

    sql = postgres(adminUrl);
    botSql = postgres(botUrl);

    console.log('--- Applying Migration 20260703000000_telegram_event_archive.sql ---');
    const migrationPath = path.join(__dirname, '../supabase/migrations/20260703000000_telegram_event_archive.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');
    await sql.unsafe(migrationSql);

    console.log('--- Cleaning Up Stale Test State ---');
    await sql`delete from public.telegram_events where bot_slug like 'test_slug%'`;

    // =========================================================================
    // Check 1: Append works from bot_service context
    // =========================================================================
    console.log('Test 1: Verifying append works from bot_service context...');
    const testPayload1 = { update_id: 12345, message: { text: 'hello bot', chat: { id: 999 } } };
    
    await botSql`
      insert into public.telegram_events (bot_slug, update_id, update_type, payload)
      values ('test_slug_1', 12345, 'message', ${botSql.json(testPayload1)})
    `;
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Check 2: Tenant/bot_service CANNOT read (cross-tenant read block / crux)
    // =========================================================================
    console.log('Test 2: Verifying bot_service cannot read (SELECT is denied)...');
    // Ensure rows exist in the table (we just inserted one as botSql, and let's add one as admin)
    await sql`
      insert into public.telegram_events (bot_slug, update_id, update_type, payload)
      values ('test_slug_2', 67890, 'chat_member', ${sql.json({ update_id: 67890, chat_member: { status: 'left' } })})
    `;

    try {
      await botSql`select * from public.telegram_events`;
      assert.fail('Security failure: bot_service was permitted to SELECT from telegram_events');
    } catch (err: any) {
      // 42501 is the PostgreSQL error code for INSUFFICIENT PRIVILEGE (permission denied)
      assert.strictEqual(err.code, '42501', 'Expected permission denied error (code 42501)');
      console.log('✅ Test 2 Passed (SELECT successfully denied).');
    }

    // =========================================================================
    // Check 3: Extracted columns populate correctly
    // =========================================================================
    console.log('Test 3: Verifying extracted columns populate correctly...');
    const rows = await sql`
      select * from public.telegram_events 
      where bot_slug = 'test_slug_1' 
      order by id desc limit 1
    `;
    assert.strictEqual(rows.length, 1);
    const row = rows[0];
    assert.strictEqual(row.bot_slug, 'test_slug_1');
    assert.strictEqual(row.update_id, '12345'); // BigInt is returned as string by driver
    assert.strictEqual(row.update_type, 'message');
    assert.deepStrictEqual(row.payload, testPayload1);
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Check 4: Retention deletes only expired rows, batched (both halves asserted)
    // =========================================================================
    console.log('Test 4: Verifying retention deletes only expired rows, batched...');
    // Seed rows straddling the cutoff (30 days ago)
    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    
    const expiredDate = new Date(cutoffDate.getTime() - 24 * 60 * 60 * 1000); // 31 days ago
    const activeDate = new Date(cutoffDate.getTime() + 24 * 60 * 60 * 1000); // 29 days ago

    // Insert 2 expired and 1 active row
    const [rowExp1] = await sql`
      insert into public.telegram_events (bot_slug, update_id, update_type, payload, created_at)
      values ('test_slug_ret', 101, 'message', '{"msg": "expired 1"}'::jsonb, ${expiredDate})
      returning id
    `;
    const [rowExp2] = await sql`
      insert into public.telegram_events (bot_slug, update_id, update_type, payload, created_at)
      values ('test_slug_ret', 102, 'message', '{"msg": "expired 2"}'::jsonb, ${expiredDate})
      returning id
    `;
    const [rowActive] = await sql`
      insert into public.telegram_events (bot_slug, update_id, update_type, payload, created_at)
      values ('test_slug_ret', 103, 'message', '{"msg": "active"}'::jsonb, ${activeDate})
      returning id
    `;

    // Run batched retention query with limit 1 (only 1 expired should be deleted)
    await sql`
      delete from public.telegram_events
      where id in (
        select id from public.telegram_events
        where created_at < now() - interval '30 days'
          and bot_slug = 'test_slug_ret'
        limit 1
      )
    `;

    const remainingRows = await sql`
      select id, payload from public.telegram_events 
      where bot_slug = 'test_slug_ret' 
      order by id asc
    `;

    // Assert batch limit: exactly 2 rows remain (1 expired, 1 active)
    assert.strictEqual(remainingRows.length, 2, 'Expected exactly 2 rows to remain after limit 1 delete');
    const remainingIds = remainingRows.map((r: any) => r.id);
    assert.ok(remainingIds.includes(rowActive.id), 'Active row must survive');
    
    // Perform cleanup for the remaining expired rows (no batch limit)
    await sql`
      delete from public.telegram_events
      where id in (
        select id from public.telegram_events
        where created_at < now() - interval '30 days'
          and bot_slug = 'test_slug_ret'
      )
    `;

    const finalRows = await sql`
      select id from public.telegram_events 
      where bot_slug = 'test_slug_ret'
    `;
    // Only the active row should remain now
    assert.strictEqual(finalRows.length, 1, 'Expected only the active row to remain');
    assert.strictEqual(finalRows[0].id, rowActive.id, 'Active row was deleted when it should have survived');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Check 5: Non-message updates are successfully archived (no whitelist)
    // =========================================================================
    console.log('Test 5: Verifying non-message updates are successfully archived...');
    const chatMemberPayload = {
      update_id: 99999,
      chat_member: {
        chat: { id: -100123 },
        new_chat_member: { user: { id: 555, username: 'test_user' }, status: 'member' }
      }
    };

    await sql`
      insert into public.telegram_events (bot_slug, update_id, update_type, payload)
      values ('test_slug_non_msg', 99999, 'chat_member', ${sql.json(chatMemberPayload)})
    `;

    const nonMsgRows = await sql`
      select * from public.telegram_events 
      where bot_slug = 'test_slug_non_msg'
    `;
    assert.strictEqual(nonMsgRows.length, 1);
    assert.strictEqual(nonMsgRows[0].update_type, 'chat_member');
    assert.deepStrictEqual(nonMsgRows[0].payload, chatMemberPayload);
    console.log('✅ Test 5 Passed.');

    console.log('\n🎉 ALL Raw Telegram Event Archive TESTS PASSED SUCCESSFULLY! 🎉\n');
  } finally {
    console.log('--- Cleaning Up Test State ---');
    if (sql) {
      await sql`delete from public.telegram_events where bot_slug like 'test_slug%'`;
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
