# SPEC — Document-Read UX (caption-mention entry, typing keep-alive, mutating status message)

> **Reads against:** `lib/telegram.ts` (`callTelegramApi`, `sendMessage` returns the raw API response so
> `result.message_id` is capturable, `sendChatAction`, `splitFormattedMessage` (exported), the
> entities-XOR-parse_mode pattern), and the §14 mention/answer block in
> `app/api/webhooks/platform/[botSlug]/route.ts` (the existing reply-to-document path built by
> SPEC-ephemeral-document-qa, plus the `if (!message || !message.chat || !message.text)` bail above it).
>
> **Rigor bar:** match prior phases. The load-bearing correctness properties are: the keep-alive **always
> stops** (every exit), every status/keep-alive step is **best-effort** (a failed status update never
> aborts the read), everything **tolerates a null status id**, and the final answer **edit carries
> entities**. Route tests wire at the `fetch` boundary with real `Response`s.
>
> **One-line scope:** three folded improvements to the document read: (1) let a user upload a PDF **with an
> `@bot` mention in the caption** (one step, no reply needed); (2) a **typing keep-alive** so the indicator
> persists through the multi-second model read; (3) a **single status message** that mutates through phases
> — "downloading" → "reading" → the answer itself (or the error).
>
> **Sequencing:** new `lib/telegram.ts` helpers first (`editMessageText`, `deleteMessage`,
> `startTypingKeepalive`), then the caption-mention entry wiring, then the status-message phase machine in
> §14. No schema, no migration.

---

## 0. Why

The reply-to-document read works, but a 30-page PDF takes 10–30 s (getFile + download + Anthropic reading
every page), and the current flow fires a **single** `sendChatAction('typing')` up front. A typing action
clears after ~5 s, so the indicator vanishes long before the answer lands and the user stares at a dead
chat. Two fixes plus one entry-point improvement:

1. **Caption-mention entry** — replying-then-mentioning is two gestures; uploading a PDF with
   "@bot summarize this" in the caption is one. Same machinery underneath.
2. **Typing keep-alive** — refresh the indicator on an interval so it survives the model read.
3. **Mutating status message** — a single message that tells the user what's happening
   ("Downloading…" → "Reading…") and then *becomes* the answer (or the error), so there's exactly one
   status line, no stranded breadcrumbs.

## 1. New `lib/telegram.ts` helpers

### `editMessageText` (NEW)
Mirror `sendMessage`'s option shape and its entities-XOR-parse_mode rule.

```
editMessageText(token, chatId, messageId, text, options?: { entities?; parseMode? }): Promise<any>
```
- Body: `{ chat_id, message_id, text }`, plus **either** `entities` **or** `parse_mode` (never both — same
  mutual-exclusion as `sendMessage`). No `message_thread_id` (edit targets an existing message by id).
- Uses `callTelegramApi(token, 'editMessageText', body)`.

### `deleteMessage` (NEW)
```
deleteMessage(token, chatId, messageId): Promise<any>
```
- Body: `{ chat_id, message_id }`. `callTelegramApi(token, 'deleteMessage', body)`.

### `startTypingKeepalive` (NEW, general helper)
Fires a typing action immediately and re-fires on an interval until stopped. Every fire is best-effort.

```
startTypingKeepalive(token, chatId, threadId?, intervalMs = 4000): () => void
```
- Fire once immediately, then `setInterval` at `intervalMs` (~4 s, just under Telegram's ~5 s expiry).
- Each fire is `sendChatAction(...).catch(() => {})` — a failed refresh must never throw out of the timer
  (an unhandled rejection in a `setInterval` callback would be uncaught).
- Returns a **stop** function that `clearInterval`s. Idempotent (safe to call twice).
- **Runs inside `waitUntil`:** the interval must be cleared before the `waitUntil` promise settles, or the
  function could be held alive by a dangling timer. The §3 `finally` guarantees this.

## 2. Caption-mention entry point (`route.ts`)

Today a message with a document and a **caption** (not `text`) is dropped at
`if (!message || !message.chat || !message.text)`. Let through **only** the specific case of a document
whose caption mentions the bot — do **not** broaden handling/logging of other captioned media.

- Before the bail, compute:
  - `rawText = message.text?.trim() ?? null`
  - `rawCaption = message.caption?.trim() ?? null`
  - `captionMentionsBot = !!(message.document && rawCaption && botUsername && rawCaption.includes('@' + botUsername))`
    (move/inline `botUsername = bot.telegram_username` above the bail).
- Bail becomes: `if (!message || !message.chat || (!rawText && !captionMentionsBot)) return ok;`
- Define `effectiveText = rawText ?? rawCaption ?? ''`.
- **Command detection stays on `rawText` only** (`isHelpCommand = rawText?.startsWith('/help')`, etc.) — a
  captioned document has no `rawText`, so it can never be misread as a command.
- **Mention detection uses `effectiveText`**: `isMention = !!botUsername && effectiveText.includes('@' + botUsername)`.
- **Question extraction uses `effectiveText`**: strip the mention as today.
- **`logMessage` logs `effectiveText`** (so the caption is recorded as the user's message, like any text).
- In §14, resolve the document source to cover both entry points:
  `const targetDoc = message.document ?? message.reply_to_message?.document;`
  (prefer the directly-attached document — the caption case — over a replied-to one.)

Net: a captioned-document mention flows through the *same* pipeline (entity/group resolution,
excluded-thread check, logging, §14) as a reply mention, and reaches the identical gate → download →
`answerAboutDocument` path. The only per-entry difference is where the document and question come from.

## 3. The mutating status message + keep-alive (§14 document branch)

Gate failures happen **before** any status message (they're instant, and there's nothing to keep alive):
the MIME and size checks reply directly and `return`, exactly as now. The status message + keep-alive wrap
only the **download + model** phases.

Phase machine (document branch, after MIME/size pass):

1. **Send status**, best-effort, capture id:
   `statusId = (await sendMessage(token, chatId, '📄 Downloading your document. One moment…', { threadId, replyToMessageId: message.message_id }))?.result?.message_id ?? null;`
   Wrap in try/catch → on failure `statusId = null` (everything below tolerates null).
2. **Download**: `downloadTelegramFile(...)`. (A download failure throws → the catch in step 7 handles it.)
3. **Edit status → reading** (best-effort, null-tolerant):
   `safeEdit(statusId, '✅ Download complete. Reading it now and formulating a response…')`.
4. **Start keep-alive**: `stopKeepalive = startTypingKeepalive(token, chatId, threadId)`.
5. **Model read**: `docResult = await answerAboutDocument(...)`. **Stop the keep-alive as soon as it returns**
   (`stopKeepalive(); stopKeepalive = null;`) so typing doesn't overlap the answer send.
6. **Terminal success** — the answer *replaces* the status message when it fits, else falls back to split:
   - `const chunks = splitFormattedMessage(docResult.text, docResult.entities);`
   - **Single chunk + have statusId** → `editMessageText(statusId, docResult.text, { entities: docResult.entities })`
     — the status line *becomes* the answer. **The edit MUST pass entities** (the answer is formatted).
   - **Multi-chunk, or no statusId** → if `statusId`, `safeDelete(statusId)`; then
     `sendFormattedMessage(token, chatId, { text, entities }, { threadId, replyToMessageId: message.message_id })`.
   - Then `logBotResponse(...)` with the answer text (unchanged; metadata `kind: 'document_qa'`).
7. **Terminal error** (catch): map to short user text —
   `DocumentReadError` `too_many_pages` / `unreadable` → their specific messages; anything else (transient,
   download failure) → the generic "something went wrong" line. Deliver via the **edit path**:
   if `statusId`, `safeEdit(statusId, errorText)` (plain text); else `sendMessage(errorText)`. Errors are
   short, so they always fit an edit — no split branch needed. (This replaces the old "re-throw transient to
   the outer catch" — the document branch now owns its terminal message.)
8. **`finally`**: `if (stopKeepalive) stopKeepalive();` — the safety net that guarantees the keep-alive
   stops on **every** path (including a throw before step 5's inline stop).

Helper conventions (small local wrappers, best-effort):
- `safeEdit(id, text, entities?)` — if `id` is null, no-op; else `editMessageText(...).catch(() => {})`.
- `safeDelete(id)` — if `id` is null, no-op; else `deleteMessage(...).catch(() => {})`.

**Invariants (call these out to the implementer):**
- Keep-alive stop lives in `finally` (always). Status *edits* are per-outcome (success vs error branches),
  **not** in `finally`.
- Every status op is best-effort and null-tolerant; a failed status send/edit/delete never aborts the read
  or suppresses the answer.
- The single-chunk success edit carries entities; the "downloading"/"reading" intermediate edits are plain
  text.
- Copy is two-phase per the above; keep the wording honest ("Downloading…" then "Reading…").

## 4. What this deliberately does NOT do

- **Keep-alive is applied to the document path only.** `/recap` and normal long answers have the same
  single-shot-then-silence gap, but `startTypingKeepalive` is built as a **general** helper so they can
  adopt it later; wiring them is a trivial follow-on, out of scope here to keep the diff focused.
- **No status message for normal (non-document) answers.** The mutating-status UX is document-only, where
  the multi-phase wait actually is. Normal answers keep today's single up-front typing action.
- **No new document handling beyond caption-mention.** Bare documents (no caption mention, no reply
  mention) are still ignored; other captioned media (photos, etc.) are untouched.
- **No ack for gate failures.** MIME/size rejections stay instant direct replies with no status message.

## 5. Tests (`scripts/test-document-read-ux.ts`)

Helper layer (`fetch`-boundary, real `Response`):
1. **`editMessageText`** issues `editMessageText` with `chat_id`/`message_id`/`text`; with `entities` set,
   no `parse_mode` (mutual exclusion); with `parseMode` and no entities, `parse_mode` present.
2. **`deleteMessage`** issues `deleteMessage` with `chat_id`/`message_id`.
3. **`startTypingKeepalive`** fires ≥1 `sendChatAction('typing')` immediately; after advancing ~2 intervals
   (short `intervalMs` in the test), more fires; after `stop()`, no further fires; a failing
   `sendChatAction` does not throw out of the timer.

Route layer (mock Telegram `getFile`/download/`sendMessage`/`editMessageText`/`deleteMessage` + the model
call):
4. **Caption-mention routing.** A `message.document` + caption `@bot Summarize this` (no `reply_to`, no
   `text`) → survives the bail, `answerAboutDocument` is called with the document from `message.document`
   and question `'Summarize this'` (mention stripped).
5. **Status → answer (single chunk).** Happy path → assert: a status `sendMessage` ("Downloading…"), an
   `editMessageText` to the "reading" line, and a **final `editMessageText` carrying the answer text +
   entities** — and **no** separate `sendMessage` for the answer (it reused the status message).
6. **Status → split (multi-chunk).** Force a >4096-char answer → assert the status message is
   `deleteMessage`d and the answer goes out via `sendFormattedMessage` (multiple `sendMessage`s).
7. **Status → error.** Model returns a 400 "100 PDF pages" → assert the **status message is edited** to the
   page-limit text (not a new message).
8. **Null-status tolerance.** Make the initial status `sendMessage` reject → assert the read still completes
   and the answer is delivered via `sendFormattedMessage` (fallback), no crash.
9. **Keep-alive stops.** Assert the keep-alive interval is cleared by completion (e.g. no `typing` fires
   after the answer send in a fake-timer window), on both the success and error paths.

Clean up any seeded rows in a `finally`; no `DROP`.

## 6. Handoff notes for Antigravity

- **Three helpers first** in `lib/telegram.ts`: `editMessageText` (entities XOR parse_mode, no thread id),
  `deleteMessage`, `startTypingKeepalive` (immediate + interval, best-effort `.catch`, returns idempotent
  stop). Then the route wiring.
- **Caption entry is surgical:** only `document + caption + @bot` survives the `!message.text` bail; commands
  stay `rawText`-only; mention/question/logging use `effectiveText = rawText ?? rawCaption`; §14 doc source
  is `message.document ?? message.reply_to_message?.document`.
- **The phase machine's correctness is the four invariants in §3:** keep-alive stop in `finally` (always);
  status edits per-outcome (not in `finally`); everything null-`statusId`-tolerant and best-effort; the
  single-chunk success edit **carries entities**.
- **Reuse `splitFormattedMessage`** for the single-vs-multi decision (`chunks.length === 1`); don't
  re-implement length logic.
- **The document branch now owns its terminal message** — success edits/splits, errors edit — so it no
  longer re-throws the transient case to the outer catch. Keep the outer catch as the last-resort guard
  (e.g. if even the fallback send throws).
- No schema, no migration. `sendMessage` already returns `{ result: { message_id } }`; capture it.

---

*End of SPEC — Document-Read UX*