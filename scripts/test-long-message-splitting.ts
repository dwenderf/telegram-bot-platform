// Test suite for Long-Message Splitting
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-long-message-splitting.ts

import assert from 'assert';
import {
  splitFormattedMessage,
  sendFormattedMessage,
  TelegramMessageEntity,
} from '../lib/telegram';

async function main() {
  console.log('--- Starting Long-Message Splitting Test Suite ---');

  // =========================================================================
  // Test 1: No-op under limit
  // =========================================================================
  console.log('Test 1: Verifying no-op under limit...');
  const text1 = 'Hello, this is a short message.';
  const entities1: TelegramMessageEntity[] = [
    { type: 'bold', offset: 0, length: 5 },
  ];
  const chunks1 = splitFormattedMessage(text1, entities1, 100);
  assert.strictEqual(chunks1.length, 1);
  assert.strictEqual(chunks1[0].text, text1);
  assert.deepStrictEqual(chunks1[0].entities, entities1);
  console.log('✅ Test 1 Passed.');

  // =========================================================================
  // Test 2: N-way split
  // =========================================================================
  console.log('Test 2: Verifying N-way split...');
  // 35 characters. Limit 10. Should split into multiple chunks.
  const text2 = 'LineOne\n\nLineTwo\n\nLineThree\n\nLineFour';
  const chunks2 = splitFormattedMessage(text2, [], 10);
  
  // Verify limit holds
  for (const chunk of chunks2) {
    assert(chunk.text.length <= 10, `Chunk length ${chunk.text.length} must be <= 10`);
  }
  // Verify concatenation reproduces original exactly (whitespace preservation)
  const concatenated = chunks2.map(c => c.text).join('');
  assert.strictEqual(concatenated, text2, 'Concatenation must match original exactly');
  assert(chunks2.length >= 3, 'Must split into 3 or more chunks');
  console.log('✅ Test 2 Passed.');

  // =========================================================================
  // Test 3: Boundary preference
  // =========================================================================
  console.log('Test 3: Verifying boundary preference...');
  // "A\n\nB\nC D"
  // Limit 8: cut before "C D"
  // Indices:
  // 0: A
  // 1: \n
  // 2: \n
  // 3: B
  // 4: \n
  // 5: C
  // 6:  
  // 7: D
  // Slice(0, 8) gets "A\n\nB\nC D"
  // lastIndexOf('\n\n') inside slice is at 1 -> end = 1 + 2 = 3 ("A\n\n")
  const text3 = 'A\n\nB\nC D';
  const chunks3 = splitFormattedMessage(text3, [], 4);
  assert.strictEqual(chunks3[0].text, 'A\n\n');
  assert.strictEqual(chunks3[1].text, 'B\n');
  assert.strictEqual(chunks3[2].text, 'C D');
  console.log('✅ Test 3 Passed.');

  // =========================================================================
  // Test 4: Hard cut with no boundary
  // =========================================================================
  console.log('Test 4: Verifying hard cut when no boundary exists...');
  const text4 = 'abcdefghij';
  const chunks4 = splitFormattedMessage(text4, [], 3);
  assert.strictEqual(chunks4.length, 4);
  assert.strictEqual(chunks4[0].text, 'abc');
  assert.strictEqual(chunks4[1].text, 'def');
  assert.strictEqual(chunks4[2].text, 'ghi');
  assert.strictEqual(chunks4[3].text, 'j');
  console.log('✅ Test 4 Passed.');

  // =========================================================================
  // Test 5: Entity rebasing
  // =========================================================================
  console.log('Test 5: Verifying entity rebasing...');
  // Text: "1234567890 1234567890" (21 chars), split limit 11 (cut at space)
  // Entity fully inside chunk 2: "123" at offset 11, length 3
  const text5 = '1234567890 1234567890';
  const entities5: TelegramMessageEntity[] = [
    { type: 'bold', offset: 11, length: 3 }, // Bold "123" in second chunk
  ];
  const chunks5 = splitFormattedMessage(text5, entities5, 11);
  assert.strictEqual(chunks5.length, 2);
  assert.strictEqual(chunks5[0].text, '1234567890 ');
  assert.strictEqual(chunks5[1].text, '1234567890');
  // Bold entity should be rebased to offset 0 in chunk 2
  assert.strictEqual(chunks5[0].entities.length, 0);
  assert.strictEqual(chunks5[1].entities.length, 1);
  assert.deepStrictEqual(chunks5[1].entities[0], {
    type: 'bold',
    offset: 0,
    length: 3,
  });
  console.log('✅ Test 5 Passed.');

  // =========================================================================
  // Test 6: Straddling entity split
  // =========================================================================
  console.log('Test 6: Verifying straddling entity split...');
  // Text: "1234567890 12345" (16 chars), split limit 11
  // Entity straddles cut: bold "890 12" starting at offset 7, length 6
  const text6 = '1234567890 12345';
  const entities6: TelegramMessageEntity[] = [
    { type: 'bold', offset: 7, length: 6 },
  ];
  const chunks6 = splitFormattedMessage(text6, entities6, 11);
  assert.strictEqual(chunks6.length, 2);
  // Chunk 1 has part: "890 " (offset 7 to 11) -> relative offset 7, length 4
  assert.strictEqual(chunks6[0].entities.length, 1);
  assert.deepStrictEqual(chunks6[0].entities[0], {
    type: 'bold',
    offset: 7,
    length: 4,
  });
  // Chunk 2 has part: "12" (offset 11 to 13) -> relative offset 0, length 2
  assert.strictEqual(chunks6[1].entities.length, 1);
  assert.deepStrictEqual(chunks6[1].entities[0], {
    type: 'bold',
    offset: 0,
    length: 2,
  });
  console.log('✅ Test 6 Passed.');

  // =========================================================================
  // Test 7: Extras preservation
  // =========================================================================
  console.log('Test 7: Verifying extras preservation on split...');
  const text7 = '1234567890 12345';
  const entities7: TelegramMessageEntity[] = [
    { type: 'text_link', offset: 7, length: 6, url: 'https://google.com' },
    { type: 'pre', offset: 7, length: 6, language: 'typescript' },
  ];
  const chunks7 = splitFormattedMessage(text7, entities7, 11);
  assert.strictEqual(chunks7.length, 2);
  
  // Verify chunk 1 link & pre
  assert.strictEqual(chunks7[0].entities.length, 2);
  assert.strictEqual((chunks7[0].entities[0] as any).url, 'https://google.com');
  assert.strictEqual((chunks7[0].entities[1] as any).language, 'typescript');

  // Verify chunk 2 link & pre
  assert.strictEqual(chunks7[1].entities.length, 2);
  assert.strictEqual((chunks7[1].entities[0] as any).url, 'https://google.com');
  assert.strictEqual((chunks7[1].entities[1] as any).language, 'typescript');
  console.log('✅ Test 7 Passed.');

  // =========================================================================
  // Test 8: Surrogate / emoji safety (no sheard emoji)
  // =========================================================================
  console.log('Test 8: Verifying surrogate/emoji safety...');
  // "123456789😀" -> length is 11 (surrogate pair counts as 2)
  // If limit is 10, cut would fall between high/low surrogate of 😀.
  // The safety check should pull end back to 9, so 😀 moves to chunk 2.
  const text8 = '123456789😀';
  const entities8: TelegramMessageEntity[] = [
    { type: 'bold', offset: 9, length: 2 }, // bold the emoji
  ];
  const chunks8 = splitFormattedMessage(text8, entities8, 10);
  assert.strictEqual(chunks8.length, 2);
  assert.strictEqual(chunks8[0].text, '123456789');
  assert.strictEqual(chunks8[1].text, '😀');
  assert.strictEqual(chunks8[0].entities.length, 0);
  assert.strictEqual(chunks8[1].entities.length, 1);
  assert.deepStrictEqual(chunks8[1].entities[0], {
    type: 'bold',
    offset: 0,
    length: 2,
  });
  console.log('✅ Test 8 Passed.');

  // =========================================================================
  // Test 9: Transport chunked send wiring (with fetch interception)
  // =========================================================================
  console.log('Test 9: Verifying transport chunked send fetch wiring...');
  const originalFetch = global.fetch;
  const fetchCalls: { method: string; body: any }[] = [];

  global.fetch = async (url: any, options: any) => {
    const urlStr = url.toString();
    const method = urlStr.split('/').pop() || '';
    const body = options?.body ? JSON.parse(options.body) : null;
    fetchCalls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const text9 = 'LineOne\n\nLineTwo\n\nLineThree';
    const entities9: TelegramMessageEntity[] = [
      { type: 'bold', offset: 0, length: 7 },
    ];

    // Call sendFormattedMessage with limit=10 to force 3 chunks
    const results = await sendFormattedMessage(
      'mock-bot-token',
      123456,
      { text: text9, entities: entities9 },
      {
        threadId: 888,
        replyToMessageId: 999,
        interChunkDelayMs: 0, // No delay in tests
        typingBetween: true,
        limit: 10,
      }
    );

    assert.strictEqual(results.length, 3);
    assert.strictEqual(fetchCalls.length, 5, 'Must make exactly 5 fetch calls (3 sendMessage, 2 typing)');

    // Call 0: sendMessage chunk 1
    assert.strictEqual(fetchCalls[0].method, 'sendMessage');
    assert.strictEqual(fetchCalls[0].body.text, 'LineOne\n\n');
    assert.strictEqual(fetchCalls[0].body.reply_to_message_id, 999, 'Reply to message ID on first chunk');
    assert.strictEqual(fetchCalls[0].body.message_thread_id, 888);
    assert.deepStrictEqual(fetchCalls[0].body.entities, [
      { type: 'bold', offset: 0, length: 7 },
    ]);

    // Call 1: typing action
    assert.strictEqual(fetchCalls[1].method, 'sendChatAction');
    assert.strictEqual(fetchCalls[1].body.action, 'typing');
    assert.strictEqual(fetchCalls[1].body.message_thread_id, 888);

    // Call 2: sendMessage chunk 2
    assert.strictEqual(fetchCalls[2].method, 'sendMessage');
    assert.strictEqual(fetchCalls[2].body.text, 'LineTwo\n\n');
    assert.strictEqual(fetchCalls[2].body.reply_to_message_id, undefined, 'No reply to message ID on subsequent chunks');
    assert.strictEqual(fetchCalls[2].body.message_thread_id, 888);

    // Call 3: typing action
    assert.strictEqual(fetchCalls[3].method, 'sendChatAction');
    assert.strictEqual(fetchCalls[3].body.action, 'typing');
    assert.strictEqual(fetchCalls[3].body.message_thread_id, 888);

    // Call 4: sendMessage chunk 3
    assert.strictEqual(fetchCalls[4].method, 'sendMessage');
    assert.strictEqual(fetchCalls[4].body.text, 'LineThree');
    assert.strictEqual(fetchCalls[4].body.reply_to_message_id, undefined);
    assert.strictEqual(fetchCalls[4].body.message_thread_id, 888);

    console.log('✅ Test 9 Passed.');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('🎉 ALL LONG-MESSAGE SPLITTING TESTS PASSED SUCCESSFULLY! 🎉');
}

main().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
