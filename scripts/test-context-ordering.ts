import assert from 'assert';
import postgres from 'postgres';
import { buildContext, getContextManifest, answerQuestion } from '../lib/capabilities';
import { setMockCallModel } from '../lib/anthropic';

console.log('--- RUNNING CONTEXT RECENCY ORDERING & ATTRIBUTES TESTS ---');

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error('Error: ADMIN_DATABASE_URL env var is required.');
  process.exit(1);
}
const sql = postgres(adminUrl);

// Prompt interception mock
let lastCapturedPrompt = '';
setMockCallModel(async (input) => {
  lastCapturedPrompt = input.systemPrompt;
  return {
    text: 'Mocked reply.',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: input.model,
    requestId: 'req-mocked',
    stopReason: 'end_turn',
  };
});

// Test state UUIDs
const USER_A = 'a4000000-0000-0000-0000-000000000000';
const E1 = 'e4400000-0000-0000-0000-000000000000';
const GROUP_A = 'f4400000-0000-0000-0000-000000000000';
const CHAT_A = 1234567890;
const THREAD_A = '04400000-0000-0000-0000-000000000000';
const TG_THREAD_ID = 42;

// Document UUIDs
const DOC_1 = '11111111-1111-1111-1111-111111111111';
const DOC_2 = '22222222-2222-2222-2222-222222222222';
const DOC_3 = '33333333-3333-3333-3333-333333333333';
const DOC_NEW = '00000000-0000-0000-0000-000000000000'; // Lexicographically lower than all other UUIDs

// Helper to parse XML tags from contextDocs robustly
function parseDocs(contextDocs: string): { path: string; scope: string; updated: string; content: string }[] {
  const matches = [...contextDocs.matchAll(/<document\s+path="([^"]+)"\s+scope="([^"]+)"\s+updated="([^"]+)">([\s\S]*?)<\/document>/g)];
  return matches.map(m => ({
    path: m[1],
    scope: m[2],
    updated: m[3],
    content: m[4].trim(),
  }));
}

async function cleanup() {
  console.log('--- Cleaning Up Test State ---');
  await sql`delete from public.model_calls where entity_id = ${E1}`;
  await sql`delete from public.message_log where group_id = ${GROUP_A}`;
  await sql`delete from public.manifest_entries where entity_id = ${E1}`;
  await sql`delete from public.doc_cache where entity_id = ${E1}`;
  await sql`delete from public.threads where entity_id = ${E1}`;
  await sql`delete from public.groups where id = ${GROUP_A}`;
  await sql`delete from public.entities where id = ${E1}`;
  await sql`delete from auth.users where id = ${USER_A}`;
}

async function setupFixtures() {
  await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_recency_test@test.com', now(), 'authenticated', 'authenticated')`;
  await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username) values (${E1}, 'entity-test-recency', 'Recency Entity', ${USER_A}, 'recency_bot')`;
  await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Group A')`;
  await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name) values (${THREAD_A}, ${E1}, ${GROUP_A}, ${TG_THREAD_ID}, 'Topic Thread')`;
  await sql`insert into public.message_log (group_id, entity_id, telegram_chat_id, telegram_thread_id, username, message_text, is_bot_response) values (${GROUP_A}, ${E1}, ${CHAT_A}, ${TG_THREAD_ID}, 'user', 'query text', false)`;
}

async function run() {
  let passed = 0;
  let failed = 0;

  async function runTestCase(name: string, testFn: () => Promise<void>) {
    try {
      await cleanup();
      await setupFixtures();
      await testFn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`[FAIL] ${name}`);
      console.error(err);
      failed++;
    }
  }

  // =========================================================================
  // Test 1: Append-on-insert cache stability (prefix identical)
  // =========================================================================
  await runTestCase('Test 1: Append-on-insert cache stability', async () => {
    // Seed initial docs
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_1}, ${E1}, 'Content 1', 'doc1.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_2}, ${E1}, 'Content 2', 'doc2.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f1111111-1111-1111-1111-111111111111', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_1}, '2026-07-15 12:00:00+00'),
      ('f2222222-2222-2222-2222-222222222222', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_2}, '2026-07-15 12:01:00+00')`;

    const contextResult1 = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const contextDocs1 = contextResult1.contextDocs;

    // Insert new document with newer created_at, but with a low UUID (DOC_NEW: '0000...')
    // If the query sorted by doc_id (old behavior), DOC_NEW would sort first, breaking the cache prefix.
    // With CreatedAt sorting, DOC_NEW appends, preserving the prefix byte-for-byte.
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_NEW}, ${E1}, 'Content New', 'doc_new.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f0000000-0000-0000-0000-000000000000', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_NEW}, '2026-07-15 12:02:00+00')`;

    const contextResult2 = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const contextDocs2 = contextResult2.contextDocs;

    assert.ok(contextDocs2.startsWith(contextDocs1), 'Prefix must be preserved byte-identical under document insertion.');

    const parsed = parseDocs(contextDocs2);
    assert.strictEqual(parsed.length, 3);
    assert.strictEqual(parsed[2].path, 'doc_new.md');
  });

  // =========================================================================
  // Test 2: Regression proof against random UUID order sorting
  // =========================================================================
  await runTestCase('Test 2: Ordering follows created_at rather than doc_id', async () => {
    // Seed DOC_2 ('2222...') with older created_at
    // Seed DOC_1 ('1111...') with newer created_at
    // Since Postgres sorts UUIDs binary (which aligns with canonical lowercase hex lexicographical order),
    // DOC_1 ('1111...') would sort first if ordered by doc_id.
    // Under CreatedAt sorting, DOC_2 ('2222...') must sort first because its created_at is older.
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_2}, ${E1}, 'Content 2', 'doc2.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_1}, ${E1}, 'Content 1', 'doc1.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f2222222-2222-2222-2222-222222222222', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_2}, '2026-07-15 12:00:00+00'),
      ('f1111111-1111-1111-1111-111111111111', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_1}, '2026-07-15 12:01:00+00')`;

    const contextResult = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const parsed = parseDocs(contextResult.contextDocs);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed[0].path, 'doc2.md', 'Doc 2 (older created_at) must sort first.');
    assert.strictEqual(parsed[1].path, 'doc1.md', 'Doc 1 (newer created_at) must sort second.');
  });

  // =========================================================================
  // Test 3: Tiebreaker determinism (Non-hollow verification)
  // =========================================================================
  await runTestCase('Test 3: Deterministic tiebreaker using doc_id', async () => {
    // Seed two documents with identical created_at, but Doc 2 ('2222...') and Doc 1 ('1111...')
    // Lexicographically/binary, '1111...' must sort before '2222...'.
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_2}, ${E1}, 'Content 2', 'doc2.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_1}, ${E1}, 'Content 1', 'doc1.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f2222222-2222-2222-2222-222222222222', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_2}, '2026-07-15 12:00:00+00'),
      ('f1111111-1111-1111-1111-111111111111', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_1}, '2026-07-15 12:00:00+00')`;

    const contextResult = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const parsed = parseDocs(contextResult.contextDocs);
    assert.strictEqual(parsed.length, 2);
    // Lower UUID (DOC_1: '1111...') must sort first
    assert.strictEqual(parsed[0].path, 'doc1.md', 'Doc 1 (lower UUID tiebreaker) must sort first when created_at is identical.');
    assert.strictEqual(parsed[1].path, 'doc2.md', 'Doc 2 (higher UUID tiebreaker) must sort second when created_at is identical.');
  });

  // =========================================================================
  // Test 4: Bucket order preserved
  // =========================================================================
  await runTestCase('Test 4: Bucket ordering (entity -> group -> topic) is preserved', async () => {
    // Seed entity doc (newest created_at), group doc (middle), topic doc (oldest created_at)
    // Verify that the case expression keeps entity first, then group, then topic.
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_1}, ${E1}, 'Entity Doc', 'entity.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_2}, ${E1}, 'Group Doc', 'group.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_3}, ${E1}, 'Topic Doc', 'topic.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f1111111-1111-1111-1111-111111111111', ${E1}, null, null, ${DOC_1}, '2026-07-15 12:02:00+00'),
      ('f2222222-2222-2222-2222-222222222222', ${E1}, ${GROUP_A}, null, ${DOC_2}, '2026-07-15 12:01:00+00'),
      ('f3333333-3333-3333-3333-333333333333', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_3}, '2026-07-15 12:00:00+00')`;

    const contextResult = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const parsed = parseDocs(contextResult.contextDocs);
    assert.strictEqual(parsed.length, 3);
    assert.strictEqual(parsed[0].path, 'entity.md', 'Entity doc must sort first.');
    assert.strictEqual(parsed[1].path, 'group.md', 'Group doc must sort second.');
    assert.strictEqual(parsed[2].path, 'topic.md', 'Topic doc must sort third.');
  });

  // =========================================================================
  // Test 5: Scope derivation
  // =========================================================================
  await runTestCase('Test 5: Scope derivation attributes', async () => {
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_1}, ${E1}, 'Entity Doc', 'entity.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_2}, ${E1}, 'Group Doc', 'group.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_3}, ${E1}, 'Topic Doc', 'topic.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f1111111-1111-1111-1111-111111111111', ${E1}, null, null, ${DOC_1}, '2026-07-15 12:00:00+00'),
      ('f2222222-2222-2222-2222-222222222222', ${E1}, ${GROUP_A}, null, ${DOC_2}, '2026-07-15 12:00:00+00'),
      ('f3333333-3333-3333-3333-333333333333', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_3}, '2026-07-15 12:00:00+00')`;

    const contextResult = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const parsed = parseDocs(contextResult.contextDocs);
    assert.strictEqual(parsed.length, 3);
    assert.strictEqual(parsed[0].scope, 'entity', 'Entity scope derived incorrectly.');
    assert.strictEqual(parsed[1].scope, 'group', 'Group scope derived incorrectly.');
    assert.strictEqual(parsed[2].scope, 'topic', 'Topic scope derived incorrectly.');
  });

  // =========================================================================
  // Test 6: Date format (YYYY-MM-DD)
  // =========================================================================
  await runTestCase('Test 6: YYYY-MM-DD absolute date format', async () => {
    // Seed with a specific content that has a colon (e.g. 'Note: hello') to test colon check robustness
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_1}, ${E1}, 'Note: content with colon', 'doc1.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f1111111-1111-1111-1111-111111111111', ${E1}, null, null, ${DOC_1}, '2026-07-15 12:00:00+00')`;

    const contextResult = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const parsed = parseDocs(contextResult.contextDocs);
    assert.strictEqual(parsed.length, 1);

    // Assert updated attribute matches YYYY-MM-DD
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    assert.ok(dateRegex.test(parsed[0].updated), 'updated attribute must match YYYY-MM-DD.');
    assert.ok(!parsed[0].updated.includes(':'), 'Date attribute must not contain a time component.');
  });

  // =========================================================================
  // Test 7: updated tracks synced_at, not created_at, with position stability
  // =========================================================================
  await runTestCase('Test 7: updated tracks synced_at and preserves position stability', async () => {
    // Seed two docs in the same bucket:
    // Doc A with older created_at and older synced_at
    // Doc B with newer created_at and older synced_at
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_1}, ${E1}, 'Content A', 'docA.md', 'push', '2026-01-01 12:00:00+00'),
      (${DOC_2}, ${E1}, 'Content B', 'docB.md', 'push', '2026-01-01 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f1111111-1111-1111-1111-111111111111', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_1}, '2026-07-15 12:00:00+00'),
      ('f2222222-2222-2222-2222-222222222222', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_2}, '2026-07-15 12:01:00+00')`;

    const contextBefore = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const parsedBefore = parseDocs(contextBefore.contextDocs);
    assert.strictEqual(parsedBefore.length, 2);
    // Initially Doc A sorts first
    assert.strictEqual(parsedBefore[0].path, 'docA.md');
    assert.strictEqual(parsedBefore[0].updated, '2026-01-01');

    // Update Doc A synced_at to '2026-01-02' and its content
    await sql`update public.doc_cache set synced_at = '2026-01-02 12:00:00+00', content = 'New Content A' where id = ${DOC_1}`;

    const contextAfter = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const parsedAfter = parseDocs(contextAfter.contextDocs);
    assert.strictEqual(parsedAfter.length, 2);

    // Verify Doc A STILL sorts first (created_at is still older), but its updated attribute changed
    assert.strictEqual(parsedAfter[0].path, 'docA.md', 'Doc A sort position must remain stable despite synced_at change.');
    assert.strictEqual(parsedAfter[0].updated, '2026-01-02', 'updated attribute must track synced_at update.');
    assert.strictEqual(parsedAfter[0].content, 'New Content A', 'Content must be updated.');
  });

  // =========================================================================
  // Test 8: path attribute intact
  // =========================================================================
  await runTestCase('Test 8: path attribute remains display_name', async () => {
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_1}, ${E1}, 'Content 1', 'doc1.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f1111111-1111-1111-1111-111111111111', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_1}, '2026-07-15 12:00:00+00')`;

    const contextResult = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const parsed = parseDocs(contextResult.contextDocs);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].path, 'doc1.md', 'path attribute must correspond to display_name.');
  });

  // =========================================================================
  // Test 9 & 10: Grounding block presence, ordering, and coexistence
  // =========================================================================
  await runTestCase('Test 9 & 10: Grounding block presence, ordering, and coexistence', async () => {
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_1}, ${E1}, 'Content 1', 'doc1.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f1111111-1111-1111-1111-111111111111', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_1}, '2026-07-15 12:00:00+00')`;

    // Call answerQuestion with default persona
    lastCapturedPrompt = '';
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: TG_THREAD_ID,
      question: 'Hello?',
    });

    assert.ok(lastCapturedPrompt.includes('CONTEXT DOCUMENT GUIDANCE:'), 'CONTEXT_GROUNDING block must be present.');
    assert.ok(lastCapturedPrompt.includes('WEB SEARCH GUIDANCE:'), 'WEB_SEARCH_GROUNDING block must be present.');
    assert.ok(lastCapturedPrompt.includes('PROJECT CONTEXT:'), 'PROJECT CONTEXT: header must be present.');

    // Verify CONTEXT_GROUNDING is placed before WEB_SEARCH_GROUNDING
    const contextIdx = lastCapturedPrompt.indexOf('CONTEXT DOCUMENT GUIDANCE:');
    const webIdx = lastCapturedPrompt.indexOf('WEB SEARCH GUIDANCE:');
    assert.ok(contextIdx !== -1 && webIdx !== -1, 'Both blocks must exist.');
    assert.ok(contextIdx < webIdx, 'CONTEXT_GROUNDING must precede WEB_SEARCH_GROUNDING.');

    // Call answerQuestion with custom persona
    lastCapturedPrompt = '';
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: TG_THREAD_ID,
      question: 'Hello?',
      persona: 'Custom persona message'
    });

    assert.ok(lastCapturedPrompt.includes('Custom persona message'), 'Custom persona must survive prompt assembly.');
    assert.ok(lastCapturedPrompt.includes('CONTEXT DOCUMENT GUIDANCE:'), 'CONTEXT_GROUNDING block must survive custom persona.');
    assert.ok(lastCapturedPrompt.includes('WEB SEARCH GUIDANCE:'), 'WEB_SEARCH_GROUNDING block must survive custom persona.');
  });

  // =========================================================================
  // Test 11: Regression safety (Empty context)
  // =========================================================================
  await runTestCase('Test 11: Empty context fallback safety', async () => {
    const contextEmpty = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    assert.strictEqual(contextEmpty.contextDocs, 'No documentation context available for this topic.');
  });

  // =========================================================================
  // Test 12: Lockstep row selection
  // =========================================================================
  await runTestCase('Test 12: Lockstep row selection identical sets across scopes', async () => {
    // Seed documents spanning all three buckets (entity, group, topic)
    await sql`insert into public.doc_cache (id, entity_id, content, display_name, source_type, synced_at) values 
      (${DOC_1}, ${E1}, 'Content 1', 'entity.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_2}, ${E1}, 'Content 2', 'group.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_3}, ${E1}, 'Content 3', 'topic.md', 'push', '2026-07-15 12:00:00+00'),
      (${DOC_NEW}, ${E1}, 'Content Exclude', 'excluded.md', 'push', '2026-07-15 12:00:00+00')`;

    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f1111111-1111-1111-1111-111111111111', ${E1}, null, null, ${DOC_1}, '2026-07-15 12:00:00+00'),
      ('f2222222-2222-2222-2222-222222222222', ${E1}, ${GROUP_A}, null, ${DOC_2}, '2026-07-15 12:00:00+00'),
      ('f3333333-3333-3333-3333-333333333333', ${E1}, ${GROUP_A}, ${THREAD_A}, ${DOC_3}, '2026-07-15 12:00:00+00')`;

    // Thread B is for a different topic, Doc Exclude (linked to thread B) should be excluded
    const THREAD_B = '99999999-9999-9999-9999-999999999999';
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name) values 
      (${THREAD_B}, ${E1}, ${GROUP_A}, 99, 'Thread B')`;
    await sql`insert into public.manifest_entries (id, entity_id, group_id, thread_id, doc_id, created_at) values 
      ('f0000000-0000-0000-0000-000000000000', ${E1}, ${GROUP_A}, ${THREAD_B}, ${DOC_NEW}, '2026-07-15 12:00:00+00')`;

    const buildResult = await buildContext(E1, GROUP_A, TG_THREAD_ID);
    const manifestResult = await getContextManifest(E1, GROUP_A, TG_THREAD_ID);

    // Extract sorted list of display names from buildContext
    const buildNames = parseDocs(buildResult.contextDocs).map(d => d.path).sort();

    // Extract sorted list of display names from getContextManifest
    const manifestNames = [
      ...manifestResult.entityDocs,
      ...manifestResult.groupDocs,
      ...manifestResult.topicDocs
    ].map(d => d.display_name).sort();

    // Verify both sets match exactly, excluding DOC_NEW
    assert.deepStrictEqual(buildNames, manifestNames, 'buildContext and getContextManifest sets must be identical.');
    assert.deepStrictEqual(buildNames, ['entity.md', 'group.md', 'topic.md']);
    assert.ok(!buildNames.includes('excluded.md'), 'Excluded thread context must not be returned.');
  });

  // Final cleanup. Guarded so the pool always closes: if cleanup throws and
  // sql.end() is skipped, postgres.js holds the event loop open and the script
  // hangs instead of exiting. Cleanup failure is also a real failure — it leaves
  // test rows in the shared database — so it must affect the exit code.
  try {
    await cleanup();
  } catch (err) {
    console.error('Final cleanup FAILED — test rows may remain in the database:', err);
    failed++;
  } finally {
    await sql.end();
  }

  if (failed === 0) {
    console.log(`All ${passed} context ordering tests passed successfully!`);
    process.exit(0);
  } else {
    console.error(`${failed} tests failed out of ${passed + failed}.`);
    process.exit(1);
  }
}

run();
