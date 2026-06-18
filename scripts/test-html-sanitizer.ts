import { sanitizeForTelegramHtml } from '../lib/telegram';

const testCases = [
  {
    name: 'Standard bold and italic',
    input: 'Hello <b>World</b> and <i>Peace</i>.',
    expected: 'Hello <b>World</b> and <i>Peace</i>.',
  },
  {
    name: 'Unescaped ampersand',
    input: 'R&D department is in &amp; out.',
    expected: 'R&amp;D department is in &amp; out.',
  },
  {
    name: 'Unescaped angle brackets',
    input: 'We have x < y and y > z.',
    expected: 'We have x &lt; y and y &gt; z.',
  },
  {
    name: 'Non-whitelisted HTML tags',
    input: 'Here is a <p>paragraph</p> and <div class="test">division</div>.',
    expected: 'Here is a &lt;p&gt;paragraph&lt;/p&gt; and &lt;div class="test"&gt;division&lt;/div&gt;.',
  },
  {
    name: 'Whitelisted link tag',
    input: 'Check <a href="https://example.com">this link</a> for info.',
    expected: 'Check <a href="https://example.com">this link</a> for info.',
  },
  {
    name: 'Malformed tag',
    input: 'This is <b code that is cut off',
    expected: 'This is &lt;b code that is cut off',
  },
];

console.log('--- RUNNING HTML SANITIZER TESTS ---');
let failed = 0;
for (const tc of testCases) {
  const result = sanitizeForTelegramHtml(tc.input);
  if (result === tc.expected) {
    console.log(`[PASS] ${tc.name}`);
  } else {
    console.error(`[FAIL] ${tc.name}`);
    console.error(`  Input:    ${tc.input}`);
    console.error(`  Expected: ${tc.expected}`);
    console.error(`  Got:      ${result}`);
    failed++;
  }
}

if (failed === 0) {
  console.log('All tests passed successfully!');
  process.exit(0);
} else {
  console.error(`${failed} tests failed.`);
  process.exit(1);
}
