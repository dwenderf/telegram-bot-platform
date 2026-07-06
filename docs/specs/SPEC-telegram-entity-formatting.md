# SPEC — Entity-Based Telegram Formatting (provider-agnostic output rendering)

> **Reads against:** `lib/model.ts` (`ModelProvider` interface), `lib/providers/anthropic.ts`,
> `lib/providers/deepseek.ts`, `lib/capabilities.ts` (`answerQuestion`, `recapConversation`),
> `lib/telegram.ts` (`sendMessage`, `sanitizeForTelegramHtml`), and
> `app/api/webhooks/platform/[botSlug]/route.ts` (steps 13 `/recap` and 14 mention/answer).
> **Rigor bar:** the two model-output send paths must render correctly regardless of whether the model
> emits Markdown (DeepSeek) or HTML (Anthropic). The library (`@gramio/format`) is load-bearing in
> every model-output message, so the empirical gates (§7) are must-pass, not nice-to-have.
> **One-line scope:** stop sending model output through `parse_mode: HTML`; instead each provider
> declares its `outputFormat`, the capability layer converts model text into Telegram `MessageEntity`
> objects via `@gramio/format`, and `sendMessage` sends `{text, entities}` with no `parse_mode`. This
> fixes DeepSeek's literal-`**` Markdown bug and is robust to malformed markup (degrades to plain text
> instead of a 400).

> **Sequencing:** self-contained. Touches the provider interface, both providers, the two capability
> functions, `sendMessage`, and the two model-output call sites in `route.ts`. Static/command message
> paths are explicitly untouched (§5).

---

## 0. Why + how this was pinned

**The bug:** DeepSeek-v4-flash emits **Markdown** (`**bold**`, `# headers`) rather than the
Telegram-HTML the system prompt requests. The current pipeline sends model output with
`parse_mode: 'HTML'` after `sanitizeForTelegramHtml` — but the sanitizer only *escapes* stray HTML, it
does not *convert* Markdown. So `**bold**` reaches Telegram's HTML parser as literal asterisks and
renders verbatim (confirmed in production: literal `**` in DeepSeek answers). Anthropic emitted HTML,
which is why the bug only appeared after the DeepSeek swap — Claude's obedience masked the pipeline's
lack of a conversion step.

**Why the entity model (not a Markdown→HTML converter):** Telegram supports a third formatting
mechanism besides HTML/MarkdownV2 parse modes — sending **plain `text` + a `MessageEntity[]` array**
with **no `parse_mode`**. Formatting rides as positional metadata (offset/length) alongside inert plain
text, so there is nothing for a parser to choke on. This eliminates the entire escaping/injection
problem class the sanitizer exists to manage: a stray `<`, `&`, or malformed `**` in model output can
never break the send, because the text is never parsed as markup. **Malformed markup degrades to plain
text instead of failing** (a `parse_mode` send would 400 the entire message on a syntax error). This is
the robust design for unpredictable LLM output.

**The library:** `@gramio/format` (MIT, framework-agnostic, actively maintained) provides
`markdownToFormattable` and `htmlToFormattable`, each returning `{ text, entities }` with correct
**UTF-16 code-unit offsets** (required by Telegram; the emoji-doubling gotcha). `markdownToFormattable`
requires **`marked`** as a peer dependency (a mature, industry-standard Markdown parser — the hard
parsing is delegated to it; `@gramio/format` maps its AST to Telegram entities). Both converters map
onto Telegram's whitelist and degrade gracefully; notably **both render headers (`#`/`<h1>`) as bold**,
so the two providers render headers identically.

---

## 1. `ModelProvider.outputFormat` (required)

Add a **required** field to the `ModelProvider` interface in `lib/model.ts`:

```ts
readonly outputFormat: 'markdown' | 'html';
```

- `AnthropicProvider` → `outputFormat = 'html'` (Claude emits HTML; the current pipeline expected it).
- `DeepSeekProvider` → `outputFormat = 'markdown'` (DeepSeek emits Markdown; source of the bug).

**Required, not optional/defaulted** — on purpose. It forces every future provider to explicitly
declare what it emits, so a new provider cannot be added without consciously choosing its converter.
Defaulting would risk a new provider silently getting the wrong converter. This is the same
"provider-specific behavior is provider identity, declared explicitly" principle as `cacheable` and the
thinking-mode direction (see `VISION.md` Surface 2).

The mock provider (the `resolveProvider` mock-wrapper path) must also carry an `outputFormat` so tests
that resolve through it don't break the interface contract — use `'markdown'` (or whatever the test
asserts); it just needs to satisfy the required field.

## 2. Dependencies

- Add `@gramio/format` and `marked` (peer dep of the markdown sub-module).
- Confirm the installed `@gramio/format` license is MIT (README shows MIT).
- Import sites: `markdownToFormattable` from `@gramio/format/markdown`; `htmlToFormattable` from
  `@gramio/format/html`.

## 3. Conversion in the capability layer

The conversion lives **inside** `answerQuestion` and `recapConversation` (in `lib/capabilities.ts`),
because those functions resolve the provider (`resolveProvider(model)`) and therefore know
`provider.outputFormat`. `route.ts` stays a dumb transport.

### 3.1 A shared converter helper

Add a small helper (in `lib/capabilities.ts` or a co-located module) that selects the converter by
format:

```ts
function renderModelOutput(text: string, outputFormat: 'markdown' | 'html'): { text: string; entities: MessageEntity[] } {
  const result = outputFormat === 'html'
    ? htmlToFormattable(text)
    : markdownToFormattable(text);
  return { text: result.text, entities: result.entities };
}
```

(Exact return-type wiring to `@gramio/format`'s `FormattableString` shape — read the library's actual
types; `.text` and `.entities` are the fields. Do not hand-compute offsets.)

### 3.2 `answerQuestion` returns `{ text, entities }`

- After the model call, run the answer text through `renderModelOutput(answerText, provider.outputFormat)`.
- **Change the return type** from `{ answerText }` to `{ text, entities }`.

### 3.3 `recapConversation` returns `{ text, entities }` — note handling

- The recap currently prepends a developer-authored `note` (e.g. "Recapping the last 100 messages
  (max).") as an **HTML** `<i>…</i>` fragment in `route.ts`. Under the entity model this moves **into**
  `recapConversation` and becomes **Markdown**: prepend `_${note}_\n\n` to the model's recap text,
  then run the **combined string** through the converter in a **single pass** (so all offsets — the
  italic note and the body — are computed together by the library; no manual offset math, no second
  message).
  - **Escape caveat:** the note is a developer-authored fixed string with no Markdown special chars, so
    prepending is safe today. The spec requires a comment noting that if a note ever contains Markdown
    special chars (`* _ [ ]` etc.) it must be escaped before prepending, to avoid it being parsed as
    formatting.
  - Build the note in the provider's `outputFormat` (Markdown for DeepSeek today). Recap text is model
    output in the provider's format, so the prepended note should match that format. Keep it simple:
    note-as-Markdown for the current markdown provider.
- **Change the return type** from `{ recapText }` to `{ text, entities }`.

## 4. `sendMessage` — add `entities`, keep `parseMode`

In `lib/telegram.ts`, extend `SendMessageOptions`:

```ts
interface SendMessageOptions {
  replyToMessageId?: number;
  threadId?: bigint | number;
  parseMode?: 'HTML' | 'MarkdownV2' | string;
  entities?: MessageEntity[]; // when provided, parse_mode is omitted (mutually exclusive)
}
```

- **Add a comment** on `sendMessage` / `SendMessageOptions.entities` stating: *providing `entities`
  always means `parse_mode` is omitted — the two are mutually exclusive (Telegram breaks the message if
  both are set).*
- In the body: if `options.entities` is present, set `body.entities = options.entities` and **do NOT**
  set `body.parse_mode` (even if `parseMode` was also passed). Otherwise behave exactly as today (set
  `parse_mode` if `parseMode` given; else plain).
- **Keep `parseMode` optional** — it is still needed for the static/command paths that send HTML, and
  for the plain-text paths that send neither. **Three modes coexist:** entities (model output), HTML
  (static templated messages), plain (simple notices). Do **not** remove `parseMode` or derive it from
  entities-presence in a way that forces HTML onto the plain-text callers.
- Guard: if both `entities` and `parseMode` are somehow set, entities win and `parse_mode` is omitted
  (a defensive rail matching the mutual-exclusivity comment).

## 5. `route.ts` — the two model-output call sites only

### 5.1 Step 14 (mention / answer)
- Replace `const sanitizedAnswer = sanitizeForTelegramHtml(answerText)` and the `answerQuestion`
  destructure: now `const { text, entities } = await answerQuestion({...})`.
- Send: `sendMessage(token, chatId, text, { threadId, replyToMessageId, entities })` — **no `parseMode`**.
- `logBotResponse` still logs the model's text. Use the returned `text` (the plain-text version) as
  `messageText` — it's the human-readable content; entities are presentation. (Confirm this reads
  correctly for the ledger; the plain text is the right thing to store.)

### 5.2 Step 13 (`/recap`)
- `const { text, entities } = await recapConversation({...})` (note now handled inside — §3.3).
- Remove the `route.ts`-side `prefix`/`note` HTML construction and the `sanitizeForTelegramHtml(recapText)`
  call — both move into `recapConversation`.
- Send: `sendMessage(token, chatId, text, { threadId, replyToMessageId, entities })` — **no `parseMode`**.
- `logBotResponse` logs the returned `text`.

### 5.3 Everything else is UNTOUCHED
The following send **static/developer-authored** messages (their own HTML built with `escapeHtml` on
interpolated user data, or plain text) and are **explicitly not changed**: `/whoami`, `/auth` (all
branches), `/help`, `/context` summary, the excluded-thread notice, and all error fallbacks. They keep
`parseMode: 'HTML'` (or plain) exactly as-is. `sendDocument` (the `/context` file attachment) is
**unchanged** — a file is not rendered inline, so entities are meaningless for it.

## 6. What this deliberately does NOT do

- **No change to the static/command message paths** (§5.3). Migrating those to entities is deferred
  polish (§8 backlog), not a fix — they send developer-authored text, not untrusted model output.
- **Does NOT delete `sanitizeForTelegramHtml`.** It is no longer called by the model-output paths, but
  it is retained for the backlogged static-path migration and any current static use. Leave it in place.
- **No system-prompt change.** We stop fighting the model's Markdown inclination and consume it instead;
  the persona/recap prompts are unchanged.
- **No manual offset computation.** Offsets (UTF-16) are entirely the library's responsibility. Any
  hand-rolled offset math is a defect.
- **No `sendDocument` change.**

## 7. Tests (empirical gates — the library is load-bearing)

Add `scripts/test-telegram-entity-formatting.ts` (and/or extend existing). These assert real library
behavior, not mocks of it — the point is to verify `@gramio/format` does what we need on our actual
output:

1. **Markdown → entities (DeepSeek path).** `markdownToFormattable("**bold** and *italic*")` yields
   plain text with correct bold/italic entities at correct offsets. The literal-`**` bug is gone.
2. **UTF-16 offsets with emoji (make-or-break).** Convert a string that contains an emoji **before** a
   formatted span (e.g. `"😊 hello **world**"`) and assert the bold entity's offset/length are correct
   in **UTF-16 code units** (emoji counts as 2). This is the silent-failure gate — a real DeepSeek
   answer containing an emoji must format correctly.
3. **Headers → bold.** `# Heading` (markdown) and `<h1>Heading</h1>` (html) both yield a bold entity
   over "Heading". Locks the README-confirmed behavior against regression.
4. **Malformed markup degrades, does not throw.** An unclosed `**bold` (or malformed HTML) converts to
   plain text without throwing and without producing invalid entities. (Robustness guarantee.)
5. **HTML → entities (Anthropic path).** A representative Claude-style HTML answer
   (`<b>…</b> <i>…</i> <code>…</code> <a href>`) converts correctly via `htmlToFormattable`.
6. **Recap note prepend.** A recap with a `note` prepended as `_note_` converts in one pass to text
   with an italic entity over the note and the body entities correctly offset after it.
7. **`outputFormat` routing.** `AnthropicProvider.outputFormat === 'html'`,
   `DeepSeekProvider.outputFormat === 'markdown'`; the capability helper selects the matching converter.
8. **`sendMessage` mutual exclusivity.** When `entities` is passed, the request body has `entities` and
   **no** `parse_mode`; when `parseMode` is passed without entities, it has `parse_mode` and no
   entities.
9. **Existing suite passes unmodified** — the abstraction/provider tests and all others still green.

## 8. Backlog note (add to `BACKLOG.md`)

Migrate the **static/command message paths** (`/whoami`, `/help`, `/auth`, `/context` summary, error
fallbacks) from HTML+`escapeHtml`+`parse_mode` to the entity model, for consistency and to retire
`sanitizeForTelegramHtml` entirely. **Polish, not a fix** — these send developer-authored text, so they
lack the untrusted-model-output fragility that motivated the model-output change. Deferred deliberately.

## 9. Handoff notes for Antigravity

- **Read `@gramio/format`'s actual types** for the `FormattableString` return shape (`.text`,
  `.entities`) and the `MessageEntity` type (prefer the library's / `@gramio/types` type over
  hand-rolling). Import `markdownToFormattable` from `@gramio/format/markdown`, `htmlToFormattable`
  from `@gramio/format/html`. Install `marked` (peer dep).
- **`outputFormat` is required** on `ModelProvider` — set it on both real providers and the mock
  wrapper. A missing `outputFormat` should be a type error (that's the point).
- **Conversion lives in the capability functions**, which return `{ text, entities }`. `route.ts` steps
  13/14 just forward those to `sendMessage`. Remove the two `sanitizeForTelegramHtml` calls there; move
  the recap note into `recapConversation` as prepended Markdown.
- **`sendMessage`: add `entities`, keep `parseMode`, comment the mutual exclusivity, guard both-set.**
  Do NOT remove `parseMode` (static + plain callers depend on it). Do NOT touch the static/command send
  sites or `sendDocument`.
- **Do NOT hand-compute UTF-16 offsets** — the library owns that. Test #2 (emoji) is the proof it's
  correct.
- **Do NOT change the system prompts** or delete `sanitizeForTelegramHtml`.
