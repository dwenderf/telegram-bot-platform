import assert from 'assert';
import { extractReplyText } from '../lib/model';

console.log('--- RUNNING REPLY EXTRACTION TESTS ---');

let failed = 0;

function runTest(name: string, content: any[], expected: string) {
  try {
    const result = extractReplyText(content);
    assert.strictEqual(result, expected);
    console.log(`[PASS] ${name}`);
  } catch (err: any) {
    console.error(`[FAIL] ${name}`);
    console.error(`  Expected: "${expected}"`);
    console.error(`  Got:      "${extractReplyText(content)}"`);
    console.error(err);
    failed++;
  }
}

// 1. Multi-block search shape
runTest(
  'Multi-block search shape [thinking, server_tool_use, web_search_tool_result, thinking, text]',
  [
    { type: 'thinking', thinking: 'Let me think...' },
    { type: 'server_tool_use', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', content: [] },
    { type: 'thinking', thinking: 'Now I know the answer.' },
    { type: 'text', text: 'ANSWER' }
  ],
  'ANSWER'
);

// 2. Narration-before-tool (Test #3 in spec)
runTest(
  'Narration-before-tool text block is skipped',
  [
    { type: 'text', text: 'Let me search for that...' },
    { type: 'server_tool_use', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', content: [] },
    { type: 'text', text: 'ANSWER' }
  ],
  'ANSWER'
);

// 3. Multiple trailing text blocks are concatenated + trimmed
runTest(
  'Multiple trailing text blocks are concatenated + trimmed',
  [
    { type: 'server_tool_use', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', content: [] },
    { type: 'text', text: 'PART 1 ' },
    { type: 'text', text: 'PART 2' }
  ],
  'PART 1 PART 2'
);

// 4. No-tool regression
runTest(
  'No-tool regression - single text block',
  [
    { type: 'text', text: 'HELLO' }
  ],
  'HELLO'
);

// 5. Leading thinking block skipped when no tools are present
runTest(
  'Leading thinking block skipped when no tools are present',
  [
    { type: 'thinking', thinking: 'thinking thoughts' },
    { type: 'text', text: 'HELLO' }
  ],
  'HELLO'
);

// 6. Empty content returns empty string
runTest(
  'Empty content array',
  [],
  ''
);

// 7. Non-array returns empty string
runTest(
  'Null content',
  null as any,
  ''
);

// 8. With web_fetch_tool_result
runTest(
  'With web_fetch_tool_result',
  [
    { type: 'text', text: 'Fetching URL...' },
    { type: 'server_tool_use', name: 'web_fetch', input: {} },
    { type: 'web_fetch_tool_result', content: [] },
    { type: 'text', text: 'FETCHED ANSWER' }
  ],
  'FETCHED ANSWER'
);

if (failed === 0) {
  console.log('All reply extraction tests passed successfully!');
  process.exit(0);
} else {
  console.error(`${failed} tests failed.`);
  process.exit(1);
}
