// Test suite for Privacy Transparency Notices & Privacy Policy
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-privacy-notices.ts

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import postgres from 'postgres';
import {
  shouldAnnounceFirstAdd,
  buildJoinerMentions,
  getAnnounceFirstAdd,
  NOTICE_ON_JOIN,
  renderPolicyHtml,
  escapeHtml,
} from '../lib/privacy';
import { getPrivacyPolicyUrl } from '../lib/config';

async function main() {
  console.log('--- Unit Tests: Privacy Helpers ---');

  // 1. First-add fires on added transition in supergroup/group
  console.log('Test 1: Verifying shouldAnnounceFirstAdd on added transition...');
  const validAddEvent = {
    chat: { id: -10012345, type: 'supergroup' },
    old_chat_member: { status: 'left' },
    new_chat_member: { status: 'member' },
  };
  assert.strictEqual(shouldAnnounceFirstAdd(validAddEvent), true);

  const validKickedToAdmin = {
    chat: { id: -10012346, type: 'group' },
    old_chat_member: { status: 'kicked' },
    new_chat_member: { status: 'administrator' },
  };
  assert.strictEqual(shouldAnnounceFirstAdd(validKickedToAdmin), true);
  console.log('✅ Test 1 Passed.');

  // 2. First-add is silent on non-add transitions
  console.log('Test 2: Verifying shouldAnnounceFirstAdd is silent on non-add transitions...');
  const memberToAdmin = {
    chat: { id: -10012345, type: 'supergroup' },
    old_chat_member: { status: 'member' },
    new_chat_member: { status: 'administrator' },
  };
  assert.strictEqual(shouldAnnounceFirstAdd(memberToAdmin), false);

  const adminToMember = {
    chat: { id: -10012345, type: 'supergroup' },
    old_chat_member: { status: 'administrator' },
    new_chat_member: { status: 'member' },
  };
  assert.strictEqual(shouldAnnounceFirstAdd(adminToMember), false);

  const memberToLeft = {
    chat: { id: -10012345, type: 'supergroup' },
    old_chat_member: { status: 'member' },
    new_chat_member: { status: 'left' },
  };
  assert.strictEqual(shouldAnnounceFirstAdd(memberToLeft), false);
  console.log('✅ Test 2 Passed.');

  // 3. First-add ignores private / channel
  console.log('Test 3: Verifying shouldAnnounceFirstAdd ignores private & channel chats...');
  const privateChat = {
    chat: { id: 123456, type: 'private' },
    old_chat_member: { status: 'left' },
    new_chat_member: { status: 'member' },
  };
  assert.strictEqual(shouldAnnounceFirstAdd(privateChat), false);

  const channelChat = {
    chat: { id: -1009999, type: 'channel' },
    old_chat_member: { status: 'left' },
    new_chat_member: { status: 'member' },
  };
  assert.strictEqual(shouldAnnounceFirstAdd(channelChat), false);
  console.log('✅ Test 3 Passed.');

  // 4. On-join single human
  console.log('Test 4: Verifying buildJoinerMentions for single human...');
  const singleHuman = [{ id: 42, first_name: 'Alice', is_bot: false }];
  const res1 = buildJoinerMentions(singleHuman);
  assert.strictEqual(res1.joiners.length, 1);
  assert.strictEqual(res1.mentionsHtml, '<a href="tg://user?id=42">Alice</a>');
  assert.ok(NOTICE_ON_JOIN(res1.mentionsHtml).includes('<a href="tg://user?id=42">Alice</a>'));
  console.log('✅ Test 4 Passed.');

  // 5. On-join batch humans
  console.log('Test 5: Verifying buildJoinerMentions for batch of humans...');
  const batchHumans = [
    { id: 10, first_name: 'Bob', is_bot: false },
    { id: 11, first_name: 'Carol', is_bot: false },
    { id: 12, first_name: 'Dave', is_bot: false },
  ];
  const res2 = buildJoinerMentions(batchHumans);
  assert.strictEqual(res2.joiners.length, 3);
  assert.strictEqual(
    res2.mentionsHtml,
    '<a href="tg://user?id=10">Bob</a>, <a href="tg://user?id=11">Carol</a>, <a href="tg://user?id=12">Dave</a>'
  );
  console.log('✅ Test 5 Passed.');

  // 6. On-join filters bots
  console.log('Test 6: Verifying buildJoinerMentions filters bots...');
  const botOnly = [
    { id: 99, first_name: 'SomeBot', is_bot: true },
    { id: 100, first_name: 'Leguan', is_bot: true },
  ];
  const res3 = buildJoinerMentions(botOnly);
  assert.strictEqual(res3.joiners.length, 0);
  assert.strictEqual(res3.mentionsHtml, '');

  const mixed = [
    { id: 99, first_name: 'SomeBot', is_bot: true },
    { id: 42, first_name: 'Alice', is_bot: false },
  ];
  const res4 = buildJoinerMentions(mixed);
  assert.strictEqual(res4.joiners.length, 1);
  assert.strictEqual(res4.joiners[0].id, 42);
  assert.strictEqual(res4.mentionsHtml, '<a href="tg://user?id=42">Alice</a>');
  console.log('✅ Test 6 Passed.');

  // 7. HTML escaping
  console.log('Test 7: Verifying HTML escaping for joiner names...');
  const unsafeUser = [{ id: 77, first_name: '<Scripter & Co>', is_bot: false }];
  const res5 = buildJoinerMentions(unsafeUser);
  assert.strictEqual(
    res5.mentionsHtml,
    '<a href="tg://user?id=77">&lt;Scripter &amp; Co&gt;</a>'
  );
  console.log('✅ Test 7 Passed.');

  // 8. Privacy policy rendering (strips comment, converts markdown)
  console.log('Test 8: Verifying renderPolicyHtml strips leading comment and parses markdown...');
  const mockMd = `<!--
  DRAFT — pending legal review
  Do not publish!
-->

# Privacy Policy

Welcome to Leguan.`;

  const html = await renderPolicyHtml(mockMd);
  assert.ok(!html.includes('DRAFT — pending legal review'), 'Comment block must be stripped');
  assert.ok(html.includes('<h1>Privacy Policy</h1>'), 'Markdown title must render as h1');
  assert.ok(html.includes('Welcome to Leguan.'), 'Body content must render');

  // Verify against actual repo privacy.md file
  const realPath = path.join(__dirname, '../content/legal/privacy.md');
  if (fs.existsSync(realPath)) {
    const realMd = fs.readFileSync(realPath, 'utf8');
    const realHtml = await renderPolicyHtml(realMd);
    assert.ok(!realHtml.includes('DRAFT — pending legal review'), 'Draft comment in content/legal/privacy.md must be stripped');
    assert.ok(realHtml.includes('<h1') && realHtml.includes('Privacy Policy'), 'Real policy must contain Privacy Policy header');
  }
  console.log('✅ Test 8 Passed.');

  // 9. URL Config Fallback
  console.log('Test 9: Verifying getPrivacyPolicyUrl fallback...');
  const policyUrl = getPrivacyPolicyUrl();
  assert.ok(typeof policyUrl === 'string' && policyUrl.length > 0);
  assert.ok(getAnnounceFirstAdd().includes(policyUrl));
  console.log('✅ Test 9 Passed.');

  // 10. Database Integration & Idempotency Check
  console.log('\n--- Database Integration Tests ---');
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  if (!adminUrl || !botUrl) {
    console.log('⚠️ Skipping database integration check (ADMIN_DATABASE_URL / DATABASE_URL not set).');
    console.log('\n🎉 ALL PRIVACY NOTICE UNIT TESTS PASSED SUCCESSFULLY! 🎉\n');
    return;
  }

  let sql: postgres.Sql | null = null;
  let testEntityId: string | null = null;
  const testUpdateId = '999888777666';

  try {
    sql = postgres(adminUrl);

    // Fetch an existing entity or seed a temporary one
    const entities = await sql`select id from public.entities limit 1`;
    if (entities.length === 0) {
      console.log('No existing entity found, creating test entity...');
      const [inserted] = await sql`
        insert into public.entities (slug, display_name)
        values ('test-privacy-entity', 'Test Privacy Entity')
        returning id
      `;
      testEntityId = inserted.id;
    } else {
      testEntityId = entities[0].id;
    }

    console.log('Cleaning up existing test update record if present...');
    await sql`
      delete from public.processed_updates
      where update_id = ${testUpdateId} and entity_id = ${testEntityId}::uuid
    `;

    console.log('Test 10: Testing processed_updates idempotency insert...');
    await sql`
      insert into public.processed_updates (update_id, entity_id)
      values (${testUpdateId}, ${testEntityId})
    `;

    // Attempt duplicate insert — must trigger unique constraint error
    try {
      await sql`
        insert into public.processed_updates (update_id, entity_id)
        values (${testUpdateId}, ${testEntityId})
      `;
      assert.fail('Expected unique constraint violation on duplicate processed_updates insert');
    } catch (err: any) {
      assert.strictEqual(err.code, '23505', 'Expected unique constraint violation code 23505');
      console.log('✅ Test 10 Passed (Duplicate update insert correctly rejected).');
    }
  } finally {
    if (sql && testEntityId) {
      await sql`
        delete from public.processed_updates
        where update_id = ${testUpdateId} and entity_id = ${testEntityId}::uuid
      `;
      if (testEntityId && testEntityId !== null) {
        await sql`delete from public.entities where slug = 'test-privacy-entity'`;
      }
      await sql.end();
    }
  }

  console.log('\n🎉 ALL PRIVACY TRANSPARENCY NOTICE TESTS PASSED SUCCESSFULLY! 🎉\n');
}

main().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
