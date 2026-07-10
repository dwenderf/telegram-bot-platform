# SPEC — Ephemeral Document Q&A (reply-to-document + mention)

> **Reads against:** `lib/model.ts` (`CallModelInput` — currently text-only: `userMessage: string`),
> `lib/providers/anthropic.ts` + `lib/providers/deepseek.ts` (both set `content: input.userMessage`),
> `lib/capabilities.ts` (`answerQuestion`, `logModelCall` — writes `metadata = tx.json({ ...result.raw, … })`,
> and `result.raw` is never populated, so no request content is logged today), `lib/telegram.ts`
> (`callTelegramApi`, `sendMessage`/`sendFormattedMessage`), and the §14 mention/answer block in
> `app/api/webhooks/platform/[botSlug]/route.ts`.
>
> **Rigor bar:** match prior phases. Prove the retrieval helper (getFile → download → base64, with the
> 20 MB cap enforced), the provider document-block construction, every gate, the classifiable-rejection
> backstop, and — load-bearing — the **nothing-stored** invariant (no document bytes in `model_calls`,
> `doc_cache`, or `manifest_entries`). Wire the route test at the `fetch` boundary with real `Response`s.
>
> **One-line scope:** let a group member reply to an uploaded **PDF** and mention the bot with a
> question; the bot fetches the file and hands it to the **Anthropic** model as a document block —
> routing to Anthropic automatically even when the bot's default model is DeepSeek — answers, and
> **stores nothing** (the file is never persisted; only the answer is logged, like any answer).
>
> **Sequencing:** provider-abstraction extension first (it's the enabling change), then the retrieval
> helper, then the isolated `answerAboutDocument` function, then the route gates. **No schema, no migration.**

---

## 0. Why, and the ephemeral guarantee

You already do this by hand: drop a PDF in the chat, summarize it elsewhere, paste the summary into
context. This collapses the *read* half into one in-chat step — reply to the PDF, mention the bot, ask.
The *persist* half (turning a good summary into durable context) is a **separate** feature (`/push`) and
is explicitly out of scope here (§6).

The design commitment is that the raw document is **ephemeral**: fetched, sent to the model, discarded.
Concretely (§5): the bytes never touch `model_calls.metadata`, `doc_cache`, or `manifest_entries`; the
only persistence is the bot's **answer** in `message_log` (the same treatment every answer gets), and the
incoming `telegram_events` archive holds only the document *reference* (`file_id`, `file_name`,
`mime_type`, `file_size`) that Telegram already put in the update — never the content. This keeps the
feature entirely out of the retention/PII surface, which is the reason we chose ephemeral over ingest.

## 1. Retrieval helper (`lib/telegram.ts`)

The webhook gives a `file_id` reference, not bytes. Fetch is two steps: `getFile` → download.

```
getTelegramFilePath(token, fileId): Promise<{ file_path: string; file_size: number }>
downloadTelegramFile(token, fileId, maxBytes = TELEGRAM_MAX_DOWNLOAD_BYTES):
  Promise<{ data: string /* base64 */; byteLength: number }>
```

- Add `export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;` (Telegram's hard getFile cap — see §8).
- `getTelegramFilePath` calls `callTelegramApi(token, 'getFile', { file_id })`; the response includes
  `file_path` and `file_size`.
- `downloadTelegramFile` then fetches
  `https://api.telegram.org/file/bot${token}/${file_path}` (note the `/file/` segment — different base
  path from the API), reads the body, and base64-encodes it.
- **Cap the download**: reject (throw a typed/size error) if `getFile.file_size > maxBytes` *and* cap the
  actual read so a mislabeled size can't buffer unbounded memory.
- **Never log the download URL or `file_path`** — the URL embeds the bot token. (Same discipline as
  everywhere else that touches the token.)
- The `file_path` link is valid ≥1 hour; since we fetch immediately and don't store it, expiry is a
  non-issue. Do **not** persist `file_path`.

## 2. Provider-abstraction extension (`lib/model.ts`, both providers)

The abstraction is text-only today. Add an **optional** document to `CallModelInput`:

```ts
export interface CallModelInput {
  systemPrompt: string;
  userMessage: string;
  model: string;
  cacheable: boolean;
  isolationScopeId: string;
  document?: { data: string /* base64 */; mediaType: string };  // NEW, optional
}
```

- **`AnthropicProvider`** — when `input.document` is present, build the user content as a **blocks
  array** (document first, then text), else keep the current string:
  ```ts
  content: input.document
    ? [
        { type: 'document', source: { type: 'base64', media_type: input.document.mediaType, data: input.document.data } },
        { type: 'text', text: input.userMessage },
      ]
    : input.userMessage
  ```
  No beta header needed — base64 document blocks are GA (§8). Do **not** attach `cache_control` to the
  document block (ephemeral one-shot). The existing system-prompt caching (`cacheable`) is unchanged.
- **`DeepSeekProvider`** — if `input.document` is present, **throw a clear, classifiable error**
  (e.g. `DocumentUnsupportedError`) rather than silently dropping it. This is pure defense-in-depth:
  `answerAboutDocument` (§3) selects an Anthropic model *before* a provider is chosen, so DeepSeek should
  never be called with a document — but if it ever is, fail loud and specific, never a garbled API error.
- **Do not add the document to `CallModelResult.raw` or anything that flows into `logModelCall`** (§5).

## 3. `answerAboutDocument` — a dedicated, isolated read (`lib/capabilities.ts`, `lib/config.ts`)

Reading a freshly-uploaded document is a **different operation** from a normal answer: it should see the
document and the user's question and *nothing else* — no manifest, no recent conversation. So this gets its
own function rather than overloading `answerQuestion` (which stays completely untouched and does not gain a
document param).

```
answerAboutDocument(input: {
  entityId; groupId; threadId;
  question: string;                 // the user's mention text
  document: { data: string; mediaType: string };
  botId?;
}): Promise<{ text: string; entities: TelegramMessageEntity[] }>
```

What it does, and how it differs from `answerQuestion`:

- **No `buildContext`.** No project manifest, no recent-conversation transcript. The document is the
  payload; project context would only bias and inflate the read. This also cuts tokens materially (no
  manifest stacked on top of an already-large PDF).
- **`cacheable: false`.** Once the large stable prefix (the manifest) is gone there is nothing worth
  caching, and it's a one-shot call. (The document block is never cached regardless.)
- **Doc-focused persona**, e.g. *"Read the attached document and answer the user's question about it. If
  they haven't asked something specific, give a clear, well-organized overview."* System prompt is just
  persona + `formatRulesFor(...)` — no `PROJECT CONTEXT` block.
- **User message** is the document block plus the question, defaulting to *"Provide a clear overview of this
  document."* when `question` is empty/just a bare mention.
- **Capability routing lives here** (it only ever applies to doc reads):
  ```ts
  let model = getModelIdentifier();
  if (resolveProvider(model).name !== 'anthropic') model = ANTHROPIC_DOCUMENT_MODEL;
  ```
  Handing `resolveProvider` a `claude-*` id lands on Anthropic with no new plumbing; `logModelCall` records
  the model actually used, so a DeepSeek-default bot's doc call correctly shows `provider='anthropic'`.
- `isolationScopeId` still resolves from `groupId`; `logModelCall` still runs (use `call_type: 'answer'` —
  a distinct `'document'` type would need an enum migration, deferred); `renderModelOutput` as usual.
- The shared tail (`provider.callModel` → `logModelCall` → `renderModelOutput`) may be factored into a
  small helper reused by both `answerQuestion` and `answerAboutDocument` to avoid duplication.

**Why isolation is safe UX (the two-phase flow):** the returned summary is logged by `logBotResponse` into
`message_log`, and `buildContext`'s recent-conversation query already includes bot responses — so the
summary immediately becomes part of the thread's history. A follow-up like "how does this relate to our
terms?" is a normal mention through the **context-aware** `answerQuestion`, which now sees *both* the
summary and the project/thread context. Isolated read first, contextual follow-ups after, summary as the
bridge — no extra wiring.

**Config constant.** `ANTHROPIC_DOCUMENT_MODEL` lives in `lib/config.ts` as a hardcoded constant (not an
env var — it's a *capability fact*, documents require Anthropic, not an operator preference):
```ts
// Model for document reads (Anthropic-only capability). Not an operator preference —
// hardcoded, not an env var. Update here on deprecation; flagged in the README.
export const ANTHROPIC_DOCUMENT_MODEL = 'claude-sonnet-5';
```
Sonnet-class balances capability and cost for large-PDF summarization; confirm the current API id when
setting it. **`ANTHROPIC_API_KEY` is a hard dependency** for doc reads regardless of `MODEL_IDENTIFIER`
(already set; if ever absent, prefer a clear "document reading isn't configured" message over a raw 401).

**Edge, deferred:** a *relational* question asked while still replying to the document ("how does this fit
our project?") won't have project context under this isolated read. The two-phase flow covers it (ask it as
a follow-up mention). Accepted as the v1 boundary rather than building intent-detection to decide when to
include context.

## 4. Route integration + layered gates (`route.ts`, §14 mention/answer block)

When the mention/answer block fires, check `message.reply_to_message?.document`. If absent → today's
normal answer flow, unchanged. If present, run the pre-download checks first (cheap, from the payload,
each producing a **specific** friendly reply on failure), then fetch and answer:

1. **MIME pre-check** — `document.mime_type === 'application/pdf'`. Else: "I can only read PDF documents
   right now." (`.docx` and images are out of scope — §6.) Cheap, pre-download, from the payload.
2. **Size gate** — `document.file_size <= TELEGRAM_MAX_DOWNLOAD_BYTES`. Else: "That file is too large for
   me to read (max 20 MB)." Cheap, pre-download.
3. **Fetch + answer** — `downloadTelegramFile` → `answerAboutDocument({ …, question: <mention text>, document: { data, mediaType: 'application/pdf' } })`
   → send via `sendFormattedMessage` (already handles long/split answers). **No provider gate here**: the
   route does *not* refuse DeepSeek-default bots — `answerAboutDocument` selects Anthropic internally (§3),
   so every mime/size-valid request is serviceable and the download always proceeds.
4. **Rejection backstop** — if the Anthropic call fails, **classify**: a permanent
   `invalid_request_error` (notably the page cap — "A maximum of 100 PDF pages may be provided.", or an
   unsupported/corrupt file) maps to a **specific** message ("That PDF has too many pages for me to read —
   the limit is 100 pages."); anything else (429/5xx/network) is treated as **transient** and gets the
   existing generic "something went wrong, try again" reply. This requires the Anthropic provider to
   surface enough structure to distinguish permanent from transient (status + error type), rather than
   collapsing everything into one opaque string — call that out to the implementer.

Behavior notes:
- On any pre-download failure (1–2) or a permanent rejection (4), send the specific message and **stop** — do
  **not** fall through to a doc-less answer (the user is clearly asking about the file; answering without
  it would confuse).
- If a reply-to has a document and a mention, treat it as a document question and include the doc — we
  can't reliably infer "the mention is unrelated to the file they replied to," and including it is the
  sensible default.
- This stays **mention-driven**; there is no new command for the ephemeral read (a fixed `/summarize`
  would be less flexible than "ask whatever you want"). The `/push` command is a separate spec.

## 5. The nothing-stored invariant (make it a test, not a hope)

Three sinks, three guarantees:
- **`model_calls.metadata`** — must not contain the document. Today safe because `logModelCall` spreads
  `result.raw` (always empty) and adds only ids/usage. The constraint: the document path must not populate
  `result.raw`, and must not pass the document/userMessage into `logModelCall`. Assert in a test that after
  a document answer, no `model_calls` row's `metadata` contains the base64 blob.
- **`doc_cache` / `manifest_entries`** — untouched by this feature (that's `/push`). Assert no new rows.
- **`message_log`** — the bot's **answer** is logged via `logBotResponse` (intended; it's the bot's
  output, like any answer, and is governed by normal retention). The raw document is **not** logged. If an
  answer happens to quote document text, that quoted text lives in the answer like any other answer — that
  is acceptable and expected, and is not "storing the document."
- **`telegram_events`** — holds the incoming update, which contains the document **reference** Telegram
  sent (`file_id`, etc.), never the bytes. No change; noted for completeness.

## 6. What this deliberately does NOT do

- **No `/push`, no ingest-to-context, no persistence of summaries.** That's the documented fast-follow
  (its own spec): group-admin-gated in-chat push to topic/group, entity-level via the web dashboard,
  summary-text only, plus the open `doc_cache`/`manifest_entries` provenance-fit question (whether they
  accept a manually-authored, non-GitHub entry) to verify there.
- **PDF only.** `.docx` (you have them in traffic) is **not** natively ingestible and would need a
  conversion step — out of scope; the MIME gate rejects it cleanly. Images/`photo` messages are natively
  supported by the model via image blocks and are a *natural* extension of the same provider change, but
  `photo` has a different payload shape (size array, no `mime_type`) — deferred to keep v1 tight.
- **No Files API / beta upload.** Base64 inline is sufficient under the 20 MB cap and needs no beta header.
- **No multi-turn document caching.** Each reply-and-ask re-fetches and re-sends (re-paying tokens); the
  `file_id` is reusable so the *user* doesn't re-upload, but the bot doesn't cache the doc across turns.
  Persistent multi-turn doc Q&A is the ingest feature, deferred.
- **No local text extraction / OCR.** We hand the PDF to the model (which handles text and scanned/visual
  pages natively); we do not shell out to a PDF parser.

## 7. Tests (`scripts/test-document-qa.ts`)

Capability/provider layer (no route):
1. **Anthropic document block shape.** Call `AnthropicProvider.callModel` with a `document`; intercept the
   SDK/`fetch` and assert the outgoing user content is `[document(base64, media_type application/pdf), text]`
   in that order, and that no beta header is attached.
2. **Anthropic text unchanged.** Without a `document`, content is still the plain string (regression).
3. **DeepSeek rejects documents.** `DeepSeekProvider.callModel` with a `document` throws the classifiable
   `DocumentUnsupportedError`; without one, unchanged.
4. **Download helper.** Mock `fetch` for `getFile` (returns `file_path`, `file_size`) then the file
   download (returns bytes); assert correct base64 and that a `file_size > 20 MB` is rejected without
   attempting the download.
5. **Isolated read.** Call `answerAboutDocument` (mock `callModel`); assert the system prompt contains **no**
   `PROJECT CONTEXT` block and no recent-conversation transcript (isolation), `cacheable: false` is passed,
   and an empty/bare-mention question falls back to the default overview prompt. Confirms `buildContext` is
   **not** invoked on this path.

Route layer (real `Response` at the `fetch` boundary — mock Telegram `getFile`/download, the model call,
and `sendMessage`):
6. **MIME gate.** Reply-to a `.docx` document + mention → the "PDF only" message; no getFile call.
7. **Size gate.** Reply-to a 25 MB PDF + mention → the "too large" message; no getFile call.
8. **Capability routing.** DeepSeek-default bot, reply-to a valid PDF + mention → the request is **routed
   to Anthropic** (not refused): assert the model call used an Anthropic model / `provider='anthropic'`,
   and an answer was sent. (Confirms the §3 override fires for a DeepSeek default.)
9. **Happy path.** Reply-to a valid PDF + mention → `answerAboutDocument` runs, model called **with a
   document block**, answer sent.
10. **Backstop classification.** Model returns a 400 `invalid_request_error` "A maximum of 100 PDF pages"
    → specific page-limit message; model returns a 500 → generic transient message.
11. **Nothing-stored invariant.** After the happy path (9), assert: no `model_calls.metadata` contains the
    base64 blob, and no new `doc_cache` / `manifest_entries` rows were created. Clean up any seeded rows in
    a `finally`; no `DROP`.

## 8. Handoff notes for Antigravity (verified facts, so pin them)

- **Telegram**: `getFile` → download at `https://api.telegram.org/file/bot<token>/<file_path>`; cloud cap
  is **20 MB** for downloads (above that needs a self-hosted Bot API server — not in scope). Link valid
  ≥1 h; we fetch immediately and never store it. The URL embeds the token — never log it.
- **Anthropic PDF (verified against current docs)**: native via a `document` block
  `source:{type:'base64', media_type:'application/pdf', data}`, works on current models, **no beta header**
  for base64. Payload cap **32 MB**, hard **100-page** cap. A 20 MB PDF base64-encodes to ~26.7 MB — under
  32 MB — so the Telegram cap is the binding one and any downloadable PDF fits. The 100-page rejection is a
  **classifiable 400** (`invalid_request_error`, message "A maximum of 100 PDF pages may be provided.") —
  that's what the §4 backstop keys on.
- **DeepSeek**: our provider is text-only; document reading is **routed** to Anthropic per request (§3),
  not refused. (This is about our integration, not a claim about DeepSeek's platform — its V4 API does
  images but not raw PDFs, and our path goes through the Anthropic-compat endpoint anyway.)
- **`ANTHROPIC_DOCUMENT_MODEL`**: hardcoded constant in `lib/config.ts` (default `claude-sonnet-5` — confirm
  the current API id). Add a line near the top of the **README** flagging it as an important hardcoded
  value to update on model deprecation. Document reading requires `ANTHROPIC_API_KEY` to be set.
- **`answerAboutDocument` is a dedicated function**, not a branch inside `answerQuestion` (which stays
  untouched). It is **isolated**: no `buildContext`, `cacheable: false`, doc-focused persona, question-or-
  default-overview. The Anthropic routing lives inside it. The two-phase UX (summary logged → follow-ups
  are context-aware) needs no extra code — `logBotResponse` + `buildContext`'s existing bot-response
  inclusion handle it.
- **Build order**: `CallModelInput.document` + both providers → `ANTHROPIC_DOCUMENT_MODEL` constant →
  `answerAboutDocument` (isolated, non-cacheable, routing) → `downloadTelegramFile` → route pre-download
  checks. No schema, no migration.
- **Do not** regress the nothing-stored invariant (§5): keep the document out of `result.raw` /
  `logModelCall`; touch neither `doc_cache` nor `manifest_entries`.

---

*End of SPEC — Ephemeral Document Q&A*