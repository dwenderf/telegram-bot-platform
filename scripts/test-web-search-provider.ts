import assert from 'assert';
import postgres from 'postgres';
import { resolveProvider } from '../lib/model';
import { DeepSeekProvider } from '../lib/providers/deepseek';
import { AnthropicProvider } from '../lib/providers/anthropic';
import { answerQuestion, answerAboutDocument, logModelCall } from '../lib/capabilities';
import { resolveIsolationScopeId } from '../lib/isolation';

console.log('--- RUNNING WEB SEARCH PROVIDER & CAPABILITIES TESTS ---');

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error('Error: ADMIN_DATABASE_URL is not set');
  process.exit(1);
}
const sql = postgres(adminUrl);

const originalFetch = global.fetch;
let lastProviderUrl = '';
let lastProviderBody: any = null;
let fetchMockResponseContent: any[] = [{ type: 'text', text: 'Mocked reply' }];
let fetchMockUsage: any = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

global.fetch = async (url: any, options: any) => {
  const urlStr = url.toString();
  if (urlStr.includes('api.anthropic.com') || urlStr.includes('api.deepseek.com')) {
    lastProviderUrl = urlStr;
    lastProviderBody = JSON.parse(options.body);
    const messagesBody = {
      id: 'msg-mocked',
      type: 'message',
      role: 'assistant',
      model: lastProviderBody.model || 'dummy-model',
      content: fetchMockResponseContent,
      stop_reason: 'end_turn',
      usage: fetchMockUsage,
    };
    return new Response(JSON.stringify(messagesBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as any;
  }

  // Fallback
  return {
    ok: true,
    json: async () => ({ ok: true, result: {} }),
    text: async () => '{"ok":true}',
  } as any;
};

// Test state UUIDs
const USER_A = 'a3000000-0000-0000-0000-000000000009';
const E1 = 'e3300000-0000-0000-0000-000000000009';
const GROUP_A = 'f3300000-0000-0000-0000-000000000009';
const CHAT_A = 1234567899;

async function run() {
  let failed = 0;

  try {
    console.log('--- Cleaning Up Test State ---');
    await sql`delete from public.model_calls where entity_id = ${E1}`;
    await sql`delete from public.message_log where group_id = ${GROUP_A}`;
    await sql`delete from public.groups where id = ${GROUP_A}`;
    await sql`delete from public.entities where id = ${E1}`;
    await sql`delete from auth.users where id = ${USER_A}`;

    console.log('--- Seeding Test Fixtures ---');
    await sql`insert into auth.users (id, email, email_confirmed_at, aud, role) values (${USER_A}, 'owner_search_test@test.com', now(), 'authenticated', 'authenticated')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username) values (${E1}, 'entity-test-search', 'Search Entity', ${USER_A}, 'search_bot')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${GROUP_A}, ${E1}, ${CHAT_A}, 'Group A')`;
    await sql`insert into public.message_log (group_id, entity_id, telegram_chat_id, telegram_message_id, message_text, username) values (${GROUP_A}, ${E1}, ${CHAT_A}, 1001, 'hello world', 'user')`;

    const deepseek = new DeepSeekProvider();

    // Test #7: DeepSeekProvider attaches tool when requested
    console.log('Test 7: Attaching tool when requested...');
    lastProviderBody = null;
    await deepseek.callModel({
      systemPrompt: 'prompt',
      userMessage: 'msg',
      model: 'deepseek-chat',
      cacheable: true,
      isolationScopeId: 'scope',
      webSearch: { maxUses: 5 },
    });

    assert.ok(lastProviderBody.tools, 'Tools array should be present');
    assert.strictEqual(lastProviderBody.tools.length, 1);
    assert.strictEqual(lastProviderBody.tools[0].type, 'web_search_20250305');
    assert.strictEqual(lastProviderBody.tools[0].name, 'web_search');
    assert.strictEqual(lastProviderBody.tools[0].max_uses, 5);
    console.log('[PASS] Test 7');

    // Test #8: Tool absent when webSearch not set
    console.log('Test 8: No tool when absent...');
    lastProviderBody = null;
    await deepseek.callModel({
      systemPrompt: 'prompt',
      userMessage: 'msg',
      model: 'deepseek-chat',
      cacheable: true,
      isolationScopeId: 'scope',
    });
    assert.strictEqual(lastProviderBody.tools, undefined);
    console.log('[PASS] Test 8');

    // Test #9: Count surfaced
    console.log('Test 9: Surfacing search count...');
    fetchMockUsage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 3 },
    };
    const res = await deepseek.callModel({
      systemPrompt: 'prompt',
      userMessage: 'msg',
      model: 'deepseek-chat',
      cacheable: true,
      isolationScopeId: 'scope',
      webSearch: { maxUses: 5 },
    });
    assert.strictEqual(res.webSearchRequests, 3);
    console.log('[PASS] Test 9');

    // Test #10: thinking: disabled is unchanged on both search and non-search DeepSeek calls
    console.log('Test 10: thinking settings disabled unchanged...');
    assert.deepStrictEqual(lastProviderBody.thinking, { type: 'disabled' });
    
    // With search
    await deepseek.callModel({
      systemPrompt: 'prompt',
      userMessage: 'msg',
      model: 'deepseek-chat',
      cacheable: true,
      isolationScopeId: 'scope',
      webSearch: { maxUses: 5 },
    });
    assert.deepStrictEqual(lastProviderBody.thinking, { type: 'disabled' });
    console.log('[PASS] Test 10');

    // Test #11: Grounding block present & persona-independent
    console.log('Test 11: Grounding block presence (persona-independent)...');
    // Call answerQuestion with custom persona
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      question: 'query text',
      model: 'deepseek-chat',
      persona: 'Custom persona text here',
    });
    assert.ok(lastProviderBody.system[0].text.includes('Custom persona text here'), 'Should include custom persona');
    assert.ok(lastProviderBody.system[0].text.includes('WEB SEARCH GUIDANCE:'), 'Should include WEB_SEARCH_GROUNDING block');
    assert.ok(lastProviderBody.tools, 'answerQuestion must pass webSearch to provider, attaching tools');
    assert.strictEqual(lastProviderBody.tools[0].type, 'web_search_20250305');
    
    // Call with default persona
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      question: 'query text',
      model: 'deepseek-chat',
    });
    assert.ok(lastProviderBody.system[0].text.includes('You are a helpful AI assistant'), 'Should include default persona');
    assert.ok(lastProviderBody.system[0].text.includes('WEB SEARCH GUIDANCE:'), 'Should include WEB_SEARCH_GROUNDING block');
    assert.ok(lastProviderBody.tools, 'answerQuestion must pass webSearch to provider, attaching tools');
    assert.strictEqual(lastProviderBody.tools[0].type, 'web_search_20250305');
    console.log('[PASS] Test 11');

    // Test #12: Column web_search_requests written to DB
    console.log('Test 12: Column web_search_requests written...');
    // Seed usage to 4 searches
    fetchMockUsage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 4 },
    };
    await answerQuestion({
      entityId: E1,
      groupId: GROUP_A,
      threadId: null,
      question: 'query text',
      model: 'deepseek-chat',
    });
    
    // Query model_calls table to see if it logged 4 web search requests
    const modelCalls = await sql<{ web_search_requests: number; metadata: any }[]>`
      select web_search_requests, metadata from public.model_calls
      where entity_id = ${E1}
      order by created_at desc
      limit 1
    `;
    assert.strictEqual(modelCalls.length, 1);
    assert.strictEqual(modelCalls[0].web_search_requests, 4);

    const metadata = modelCalls[0].metadata;
    // Verify that the metadata does NOT contain raw API response structures (e.g. content, usage, id)
    assert.ok(!metadata.content, 'metadata must not leak raw model response content blocks');
    assert.ok(!metadata.usage, 'metadata must not leak raw model response usage metrics');
    assert.ok(!metadata.id, 'metadata must not leak raw model response ID');

    // Verify it only contains standard tracking keys
    const allowedKeys = ['isolationScopeId', 'isolationScopeType', 'requestId', 'stopReason', 'telegramThreadId'];
    for (const key of Object.keys(metadata)) {
      assert.ok(allowedKeys.includes(key), `metadata contains unsanctioned key: ${key}`);
    }
    console.log('[PASS] Test 12');

    // Test #14: Document QA path has no webSearch and is unaffected
    console.log('Test 14: Document QA does not have webSearch...');
    lastProviderBody = null;
    try {
      await answerAboutDocument({
        entityId: E1,
        groupId: GROUP_A,
        threadId: null,
        question: 'query text',
        document: {
          data: 'dummy_pdf_base64_data_here',
          mediaType: 'application/pdf',
        },
      });
    } catch (docErr) {
      // It is okay if it fails due to mocked fetch shape, but let's check what got sent to provider
    }
    assert.ok(lastProviderBody, 'Should have made a provider call');
    assert.strictEqual(lastProviderBody.tools, undefined, 'No tools should be sent on document QA path');
    // Ensure document path passes the document
    assert.ok(lastProviderBody.messages[0].content[0].type === 'document', 'Should have document block');
    console.log('[PASS] Test 14');

  } catch (err) {
    console.error('Test suite failed with error:', err);
    failed++;
  } finally {
    global.fetch = originalFetch;
    console.log('--- Cleaning Up Test State ---');
    try {
      await sql`delete from public.model_calls where entity_id = ${E1}`;
      await sql`delete from public.message_log where group_id = ${GROUP_A}`;
      await sql`delete from public.groups where id = ${GROUP_A}`;
      await sql`delete from public.entities where id = ${E1}`;
      await sql`delete from auth.users where id = ${USER_A}`;
    } catch (cleanupErr) {
      console.error('Failed to clean up:', cleanupErr);
    }
    await sql.end();
  }

  if (failed === 0) {
    console.log('All provider and capability tests passed successfully!');
    process.exit(0);
  } else {
    console.error(`${failed} tests failed.`);
    process.exit(1);
  }
}

run();
