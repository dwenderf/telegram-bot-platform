import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { markdownToFormattable } from '@gramio/format/markdown';

console.log('--- RUNNING WEB SEARCH FORMATTING TESTS ---');

// Load search.json from root directory
const searchJsonPath = path.resolve(__dirname, '../search.json');
if (!fs.existsSync(searchJsonPath)) {
  console.error(`Error: search.json not found at ${searchJsonPath}`);
  process.exit(1);
}

const searchData = JSON.parse(fs.readFileSync(searchJsonPath, 'utf8'));
const textBlocks = searchData.content.filter((block: any) => block.type === 'text');
if (textBlocks.length === 0) {
  console.error('Error: No text blocks found in search.json content');
  process.exit(1);
}

// Concatenate text blocks
const fixtureText = textBlocks.map((block: any) => block.text).join('\n');

console.log('Feeding fixture text through markdownToFormattable...');
const result = markdownToFormattable(fixtureText);

let failed = 0;

// Assertions:
// 1. Markdown inline links should be converted into text_link entities
const markdownLinkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
let match;
const expectedLinks: { label: string; url: string }[] = [];
while ((match = markdownLinkRegex.exec(fixtureText)) !== null) {
  expectedLinks.push({ label: match[1], url: match[2] });
}

console.log(`Found ${expectedLinks.length} expected links in raw markdown.`);

// Filter entities to find text_links
const textLinkEntities = result.entities.filter((e: any) => e.type === 'text_link');

// Check that each expected link exists as a text_link entity matching the label and url
for (const expected of expectedLinks) {
  const matchedEntity = textLinkEntities.find((e: any) => {
    if (e.url !== expected.url) return false;
    const coveredText = result.text.substring(e.offset, e.offset + e.length);
    return coveredText === expected.label;
  });

  if (matchedEntity) {
    console.log(`[PASS] Link verified: "${expected.label}" -> ${expected.url}`);
  } else {
    console.error(`[FAIL] Expected text_link for label "${expected.label}" and URL "${expected.url}" but none matched.`);
    failed++;
  }
}

// 2. Bold entities matching expected bold texts in markdown
const expectedBolds = [
  'Google Gemini 3',
  'Release Date:',
  'Details:',
  'Source:',
  'Anthropic Claude Opus 4.5',
  'DeepSeek V3.2',
  'Note:'
];

const boldEntities = result.entities.filter((e: any) => e.type === 'bold');
for (const boldText of expectedBolds) {
  const matchedBold = boldEntities.find((e: any) => {
    const coveredText = result.text.substring(e.offset, e.offset + e.length);
    return coveredText.includes(boldText);
  });

  if (matchedBold) {
    console.log(`[PASS] Bold verified: "${boldText}"`);
  } else {
    console.error(`[FAIL] Expected bold entity covering "${boldText}"`);
    failed++;
  }
}

// 3. Headers (###) degrade sanely: no literal '#' leakage
if (result.text.includes('#')) {
  console.error('[FAIL] Literal "#" leaked into formatted text!');
  failed++;
} else {
  console.log('[PASS] No literal "#" characters leaked in formatted text.');
}

if (failed > 0) {
  console.error('\nFormatted text output:\n', result.text);
  console.error('\nEntities:\n', JSON.stringify(result.entities, null, 2));
  console.error(`\nFormatting gate FAILED with ${failed} failures.`);
  process.exit(1);
} else {
  console.log('\nFormatting gate PASSED successfully!');
  process.exit(0);
}
