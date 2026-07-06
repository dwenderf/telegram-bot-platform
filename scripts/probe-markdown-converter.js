"use strict";
// scripts/probe-markdown-converter.ts
// Throwaway probe to see how markdownToFormattable handles HTML, mixed, and markdown input.
// Run: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/probe-markdown-converter.ts
Object.defineProperty(exports, "__esModule", { value: true });
var markdown_1 = require("@gramio/format/markdown");
var html_1 = require("@gramio/format/html");
function show(label, input, fn) {
    var _a;
    console.log('\n' + '='.repeat(70));
    console.log(label);
    console.log('-'.repeat(70));
    console.log('INPUT:', JSON.stringify(input));
    try {
        var result = fn(input);
        console.log('TEXT :', JSON.stringify(result.text));
        console.log('ENTITIES:', JSON.stringify(result.entities, null, 2));
    }
    catch (err) {
        console.log('THREW:', (_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : err);
    }
}
// Case 1: PURE HTML — exactly the shape DeepSeek emitted in the broken screenshot.
var pureHtml = 'The design decisions are built around the <b>insurance certificate (ACORD) workflow</b>. ' +
    'This is the <b>technical pattern</b> you described.';
// Case 2: MIXED markdown + html in one string (the realistic "wobbly model" case).
var mixed = '**bold via markdown** and <b>bold via html</b>, plus *italic* and <i>html italic</i>.';
// Case 3: PURE markdown (what we hope the model emits under a markdown prompt).
var pureMarkdown = '**bold** and *italic*, a `code` span, a [link](https://example.com), and\n\n# A Heading';
// Case 4: HTML with an <a href> link (common in answers) + a code tag.
var htmlLink = 'See <a href="https://example.com">the docs</a> and run <code>npm install</code>.';
// Case 5: markdown with an emoji BEFORE a formatted span (UTF-16 offset check).
var emojiMarkdown = '😊 hello **world** and more';
console.log('\n########## markdownToFormattable ##########');
show('1. PURE HTML  → markdownToFormattable', pureHtml, markdown_1.markdownToFormattable);
show('2. MIXED md+html → markdownToFormattable', mixed, markdown_1.markdownToFormattable);
show('3. PURE MARKDOWN → markdownToFormattable', pureMarkdown, markdown_1.markdownToFormattable);
show('4. HTML link+code → markdownToFormattable', htmlLink, markdown_1.markdownToFormattable);
show('5. EMOJI + markdown → markdownToFormattable', emojiMarkdown, markdown_1.markdownToFormattable);
// For contrast: how htmlToFormattable handles the same pure-HTML input (should be clean),
// and how it handles pure markdown (should pass ** through as literal).
console.log('\n\n########## htmlToFormattable (contrast) ##########');
show('1. PURE HTML  → htmlToFormattable', pureHtml, html_1.htmlToFormattable);
show('3. PURE MARKDOWN → htmlToFormattable', pureMarkdown, html_1.htmlToFormattable);
