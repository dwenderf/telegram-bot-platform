# SPEC — Long-Message Splitting for Telegram Sends

> **Reads against:** `lib/telegram.ts` (`sendMessage`, `sendChatAction`, `callTelegramApi`,
> `TelegramMessageEntity`), `lib/capabilities.ts` (`renderModelOutput` → `{text, entities}`,
> `answerQuestion`, `recapConversation`), and the two model-output send sites in
> `app/api/webhooks/platform/[botSlug]/route.ts` (the `/recap` block §13 and the mention/answer block
> §14, both inside `waitUntil`).
>
> **Rigor bar:** golden tests on the split util with a **small configurable limit** so fixtures stay
> readable. Must prove: N-way splitting (not just 2), per-chunk entity rebasing, straddling-entity
> splitting, surrogate-pair safety, and that no chunk exceeds the limit. One transport test at the
> `fetch` boundary (real `Response`) asserting chunk count, `reply_to` on the first chunk only, and
> `message_thread_id` on all.
>
> **One-line scope:** when a rendered model answer exceeds Telegram's 4096-unit message cap, split it
> into ordered chunks that each carry correctly-rebased entities, and send them sequentially with a
> short typing-refreshed delay between chunks.
>
> **Sequencing:** pure util first (`splitFormattedMessage`), then the transport wrapper
> (`sendFormattedMessage`), then swap the two call sites. No schema, no migration. Live-bug fix.

---

## 0. Why

`sendMessage` sends `{text, entities}` in one API call. Telegram rejects any single text message longer
than **4096 UTF-16 code units** with `400 Bad Request: message is too long` (observed live on the answer
path). Model answers now occasionally exceed that, so the send must be chunked.

Two facts make this more than a `text.slice()`:

1. **Entities carry absolute offsets.** `markdownToFormattable` (via `renderModelOutput`) returns
   entities whose `offset`/`length` are absolute into the full text, in UTF-16 units — the same unit as
   Telegram and as JS `String.length`. If you slice the text and reuse the original `entities` array on a
   later chunk, every offset is wrong and any entity crossing a cut points out of range. So each chunk
   must get its **own** entity list: entities rebased to the chunk, and any entity spanning a cut **split
   in two**.
2. **Split the rendered output, not the markdown.** Re-chunking the raw markdown and re-running
   `markdownToFormattable` per piece is *more* fragile — a `**bold**` or fenced block cut across a
   boundary leaves an unclosed marker and renders literally. Splitting the already-resolved
   `{text, entities}` can never produce an unclosed state; slicing entities is deterministic.

## 1. `splitFormattedMessage` (pure util, `lib/telegram.ts`)

```
splitFormattedMessage(
  text: string,
  entities: TelegramMessageEntity[],
  limit = TELEGRAM_MAX_MESSAGE_LENGTH,   // 4096
): Array<{ text: string; entities: TelegramMessageEntity[] }>
```

Add `export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;`. Keep `limit` a parameter **specifically so tests
can pass a small value** (e.g. 10) and keep fixtures readable.

Algorithm:

- Walk `pos` from 0 to `text.length`. Each iteration:
  - `end = min(pos + limit, length)`.
  - If `end < length`, pull the cut back to a **nice boundary** within `(pos, end]`: prefer the last
    `"\n\n"`, else the last `"\n"`, else the last `" "` at or before `end`. If none exists in range,
    keep the hard `end` (a single unbroken run longer than `limit` is force-cut). Include the boundary
    whitespace at the **end of the current chunk** so the next chunk starts clean — no leading-whitespace
    special-casing needed, because entities are sliced against the actual `[pos, end)` range regardless.
  - **Surrogate safety:** never let the cut fall between a high surrogate at `end-1` and a low surrogate
    at `end`. If it does, decrement `end` by one so the whole pair moves to the next chunk. (Guarantees
    an emoji is never sheared.)
  - Slice: `chunkText = text.slice(pos, end)`. For each entity, compute
    `overlapStart = max(e.offset, pos)`, `overlapEnd = min(e.offset + e.length, end)`; if
    `overlapEnd > overlapStart`, emit `{ ...e, offset: overlapStart - pos, length: overlapEnd - overlapStart }`.
    The spread preserves type-specific extras (`url`, `language`, `custom_emoji_id`, `user`, …). Drop
    zero/negative-length results.
  - `pos = end`.
- Progress is guaranteed (`limit` ≫ 0, and the hard-cut path always advances).

Result invariants (assert in tests): every chunk's `text.length ≤ limit`; concatenating chunk texts
reproduces the original text exactly; for every emitted entity, `offset ≥ 0` and
`offset + length ≤ chunk.text.length`; the union of a split entity's pieces covers exactly the original
entity's range.

## 2. `sendFormattedMessage` (transport wrapper, `lib/telegram.ts`)

```
sendFormattedMessage(
  token: string,
  chatId: bigint | number,
  payload: { text: string; entities: TelegramMessageEntity[] },
  options: {
    threadId?: bigint | number;
    replyToMessageId?: number;
    interChunkDelayMs?: number;   // default INTER_CHUNK_DELAY_MS = 250
    typingBetween?: boolean;      // default true
  } = {},
): Promise<any[]>
```

- `const chunks = splitFormattedMessage(payload.text, payload.entities);`
- Loop `i` over chunks **sequentially** (await each; never `Promise.all` — order matters):
  - If `i > 0`:
    - If `typingBetween`, `await sendChatAction(token, chatId, 'typing', options.threadId)` (best-effort;
      swallow its errors — a failed typing action must not abort the send).
    - `await delay(interChunkDelayMs)`.
  - `await sendMessage(token, chatId, chunks[i].text, { threadId: options.threadId, entities: chunks[i].entities, replyToMessageId: i === 0 ? options.replyToMessageId : undefined })`.
- Return the array of `sendMessage` results.

Notes:
- `reply_to_message_id` goes on the **first chunk only** (it replies to the user's question);
  continuations post to the thread without a reply anchor. `message_thread_id` goes on **all** chunks.
- Add `export const INTER_CHUNK_DELAY_MS = 250;` and a tiny local `delay(ms)` helper
  (`new Promise(r => setTimeout(r, ms))`).
- **Single-chunk answers are unchanged behavior**: one `sendMessage`, with `reply_to`, no typing/delay.
  Only multi-chunk answers incur the between-chunk pauses.
- The loop runs **inside the existing `waitUntil`** at both call sites, so the added delays never hold up
  the webhook's `200` to Telegram (that response is already returned before `waitUntil` runs).

## 3. Call-site swaps (`route.ts`)

Two lines change; nothing else in those blocks moves.

- **§14 mention/answer:** replace
  `await sendMessage(bot.telegram_bot_token, message.chat.id, text, { threadId, replyToMessageId: message.message_id, entities });`
  with
  `await sendFormattedMessage(bot.telegram_bot_token, message.chat.id, { text, entities }, { threadId, replyToMessageId: message.message_id });`
- **§13 /recap:** the same swap on its `sendMessage(... { threadId, replyToMessageId: message.message_id, entities })` call.

Import `sendFormattedMessage` alongside the existing `sendMessage` import. Leave the surrounding
`setMessageReaction` / initial `sendChatAction('typing')` and the `logBotResponse` calls exactly as they
are (see §4).

## 4. What this deliberately does NOT do

- **No change to `logBotResponse`.** It keeps storing the **full** combined answer text in one row —
  splitting is a Telegram-transport concern only; the DB has no length limit and downstream reads
  (recap/context) want the whole thing.
- **No HTML/`parse_mode` splitting.** The control messages (`/whoami`, `/auth`, the `/context` summary,
  and the short `⚠️` error fallbacks) use `parse_mode: 'HTML'`, are bounded, and cannot overflow. They
  stay on plain `sendMessage`. `/context`'s large payload already goes out via `sendDocument`. Only the
  two entity-bearing model-output paths are touched.
- **No `429` / `retry_after` retry logic (deferred).** The 250 ms inter-chunk delay is the v1 mitigation
  and is sufficient for typical 2–5 chunk answers. A pathological very-long answer could still trip a
  flood limit; honoring `retry_after` on a 429 is a later hardening. If a chunk send throws mid-stream,
  earlier chunks are already delivered and the existing outer `try/catch` posts the generic error notice
  — acceptable for now. (Noted so nobody assumes atomic all-or-nothing delivery.)
- **No re-rendering of markdown per chunk.** Splitting operates on the resolved `{text, entities}` only
  (see §0.2).
- **No config surface.** `TELEGRAM_MAX_MESSAGE_LENGTH`, `INTER_CHUNK_DELAY_MS` are module constants, not
  env/DB settings, until there's a reason.

## 5. Tests (`scripts/test-long-message-splitting.ts`)

Util tests use a **small `limit`** so fixtures are legible.

1. **No-op under limit.** Short text + entities, `limit` large → exactly one chunk, entities identical to
   input.
2. **N-way split.** Text ≈ `limit * 3.5` with no long unbroken run → 4 chunks; each `text.length ≤ limit`;
   concatenation equals the original.
3. **Boundary preference.** With `\n\n`, `\n`, and space candidates present before `limit`, the cut lands
   on the last `\n\n`; assert chunk 1 ends at that boundary (not a hard mid-word cut).
4. **Hard cut with no boundary.** A single unbroken run longer than `limit` → force-split at `limit`; no
   chunk exceeds it.
5. **Entity rebasing.** An entity fully inside chunk 2 comes back with `offset` relative to chunk 2 (not
   the original absolute offset).
6. **Straddling entity split.** A `bold` entity spanning a cut → two entities, one at the tail of chunk A
   and one at the head of chunk B, whose combined coverage equals the original range; type preserved.
7. **Extras preserved.** A `text_link` (has `url`) and a `pre` (has `language`) that straddle a cut keep
   their extra fields on both pieces.
8. **Surrogate / emoji safety (the unit-assumption lock).** Place a multi-byte emoji (e.g. `😀`,
   `\uD83D\uDE00`) straddling the cut with a `bold` entity across it; assert the emoji is intact in one
   chunk (never split into lone surrogates) and the entity offsets still line up on both sides. This is
   the test that catches a UTF-16-vs-codepoint mismatch or an off-by-one.

Transport test (real `fetch` boundary, per harness rules):

9. **Chunked send wiring.** Stub `fetch` to return a real `Response` (`{ok:true, result:{}}`); call
   `sendFormattedMessage` with a payload that splits into 3 chunks and a small `limit` (inject via the
   default or a test seam). Assert: three `sendMessage` POSTs in order; `reply_to_message_id` present on
   the **first** call only; `message_thread_id` on **all** three; and two `sendChatAction('typing')`
   calls interleaved (between chunks, not before the first). Keep any fixtures self-contained; no DB
   needed.

## 6. Handoff notes for Antigravity

- **Three parts, in order:** (1) `splitFormattedMessage` + the two constants; (2) `sendFormattedMessage`
  + `delay`; (3) the two `route.ts` call-site swaps and the import.
- **Stay in UTF-16.** Offsets, lengths, `limit`, and `String.length` are all UTF-16 code units — do not
  convert to code points. The only surrogate handling is the "don't cut between a high/low surrogate
  pair" guard in §1.
- **Sequential sends only.** Never `Promise.all` the chunks; ordering is user-visible.
- **`reply_to` first chunk only; `thread_id` every chunk.** Getting this backwards double-anchors or
  loses the thread.
- **Do not touch `logBotResponse`, the HTML control-message sends, or `sendDocument`.** Only the two
  entity-bearing model-output sends change.
- **Everything runs inside the existing `waitUntil`;** do not move the sends out of it or add awaits
  before the webhook's `NextResponse.json({ ok: true })`.
- **`limit` stays a parameter** on `splitFormattedMessage` (default 4096) so tests can use a small value.

---

*End of SPEC — Long-Message Splitting for Telegram Sends*