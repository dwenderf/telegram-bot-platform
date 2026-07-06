// scripts/probe-markdown-converter.ts
// Throwaway probe to see how markdownToFormattable handles HTML, mixed, and markdown input.
// Run: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/probe-markdown-converter.ts

import { markdownToFormattable } from '@gramio/format/markdown';
import { htmlToFormattable } from '@gramio/format/html';

function show(label: string, input: string, fn: (s: string) => any) {
    console.log('\n' + '='.repeat(70));
    console.log(label);
    console.log('-'.repeat(70));
    console.log('INPUT:', JSON.stringify(input));
    try {
        const result = fn(input);
        console.log('TEXT :', JSON.stringify(result.text));
        console.log('ENTITIES:', JSON.stringify(result.entities, null, 2));
    } catch (err: any) {
        console.log('THREW:', err?.message ?? err);
    }
}

// Case 1: PURE HTML — exactly the shape DeepSeek emitted in the broken screenshot.
const pureHtml =
    'The design decisions are built around the <b>insurance certificate (ACORD) workflow</b>. ' +
    'This is the <b>technical pattern</b> you described.';

// Case 2: MIXED markdown + html in one string (the realistic "wobbly model" case).
const mixed =
    '**bold via markdown** and <b>bold via html</b>, plus *italic* and <i>html italic</i>.';

// Case 3: PURE markdown (what we hope the model emits under a markdown prompt).
const pureMarkdown =
    '**bold** and *italic*, a `code` span, a [link](https://example.com), and\n\n# A Heading';

// Case 4: HTML with an <a href> link (common in answers) + a code tag.
const htmlLink =
    'See <a href="https://example.com">the docs</a> and run <code>npm install</code>.';

// Case 5: markdown with an emoji BEFORE a formatted span (UTF-16 offset check).
const emojiMarkdown = '😊 hello **world** and more';

console.log('\n########## markdownToFormattable ##########');
show('1. PURE HTML  → markdownToFormattable', pureHtml, markdownToFormattable);
show('2. MIXED md+html → markdownToFormattable', mixed, markdownToFormattable);
show('3. PURE MARKDOWN → markdownToFormattable', pureMarkdown, markdownToFormattable);
show('4. HTML link+code → markdownToFormattable', htmlLink, markdownToFormattable);
show('5. EMOJI + markdown → markdownToFormattable', emojiMarkdown, markdownToFormattable);

// For contrast: how htmlToFormattable handles the same pure-HTML input (should be clean),
// and how it handles pure markdown (should pass ** through as literal).
console.log('\n\n########## htmlToFormattable (contrast) ##########');
show('1. PURE HTML  → htmlToFormattable', pureHtml, htmlToFormattable);
show('3. PURE MARKDOWN → htmlToFormattable', pureMarkdown, htmlToFormattable);