# SPEC — Status-Message UX for All Model Calls

> **Reads against:** the §14 document branch in `app/api/webhooks/platform/[botSlug]/route.ts` (the existing
> status machine: send status → best-effort `statusId` → `startTypingKeepalive` → terminal single-chunk
> `editMessageText` / multi-chunk `deleteMessage`+`sendFormattedMessage` / error edit, keep-alive stop in
> `finally`), plus the §13 `/recap` and §14 normal-answer branches (today: one `sendChatAction('typing')`
> up front, then `sendFormattedMessage`), and `lib/telegram.ts` (`sendMessage` returns `result.message_id`,
> `editMessageText`, `deleteMessage`, `startTypingKeepalive`, `splitFormattedMessage`, `sendFormattedMessage`).
>
> **Rigor bar:** the existing `test-document-read-ux.ts` suite must still pass after the extraction — it is
> the regression guard proving the four invariants survived. New tests cover the question/recap paths driving
> the shared helper.
>
> **One-line scope:** extract the document path's status/keep-alive machine into one shared `runWithStatus`
> helper, and drive the **question**, **recap**, and **document** paths through it — so every model call now
> shows a friendly "working on it" message that becomes the answer, with a keep-alive that survives the wait.
>
> **Sequencing:** extract `runWithStatus` (behavior-preserving for documents), then re-point the document
> branch at it, then wire the question and recap branches. No schema, no migration.

## 0. Why

Measured on real traffic: pipeline overhead (webhook → `logMessage`) is ~1 s, but the model call is ~18 s
(a normal DeepSeek answer) to ~21 s (a document read). A single `sendChatAction('typing')` clears after ~5 s
— so today's normal-answer and recap paths go silent for ~13 s of the wait, which is the dead-air originally
reported. A persistent status message plus a keep-alive (fired every ~4 s) covers the whole span. The
document path already does this; this spec generalizes it.

## 1. `runWithStatus` — the shared status machine (`lib/telegram.ts`)

Factor the document branch's machine out verbatim (same four invariants) into one helper. `work` is the
model call; `updateStatus` lets a caller edit the status mid-work (only the document path uses it).

```
runWithStatus(opts: {
  token: string;
  chatId: bigint | number;
  threadId?: bigint | number | null;
  replyToMessageId?: number;
  initialStatus: string;
  work: (updateStatus: (text: string) => Promise<void>) => Promise<{ text: string; entities: TelegramMessageEntity[] }>;
  mapError: (err: unknown) => string;   // → plain-text user message (no HTML tags — edit path has no parse_mode)
}): Promise<{ text: string; entities: TelegramMessageEntity[] } | null>
```

Behavior (identical to today's document machine):

1. Send `initialStatus`, capture `statusId = res?.result?.message_id ?? null` (best-effort; on failure
   `statusId = null`).
2. `stopKeepalive = startTypingKeepalive(token, chatId, threadId)` — starts **up front** and spans all of
   `work` (see §4 for the one behavior change this implies for documents).
3. `try { result = await work(updateStatus) }` where `updateStatus(text)` is a **best-effort, null-tolerant**
   `editMessageText(statusId, text)` (no-op if `statusId` is null).
4. On success: stop keep-alive inline (`stopKeepalive(); stopKeepalive = null`), then terminal delivery:
   - `chunks = splitFormattedMessage(result.text, result.entities)`.
   - **single chunk + `statusId`** → `editMessageText(statusId, result.text, { entities: result.entities })`
     (the status *becomes* the answer; **entities required**).
   - **else** (multi-chunk or no `statusId`) → if `statusId`, best-effort `deleteMessage`; then
     `sendFormattedMessage(...)`.
   - return `result`.
5. On throw: `errorText = mapError(err)`; if `statusId`, best-effort `editMessageText(statusId, errorText)`,
   else `sendMessage(errorText)`; return `null`.
6. `finally { if (stopKeepalive) stopKeepalive(); }` — the sole guarantee the keep-alive always stops.

Invariants (unchanged, now in one place): keep-alive stop in `finally`; terminal edits are per-outcome, not
in `finally`; every status op is best-effort and null-`statusId`-tolerant; the single-chunk success edit
carries entities; `mapError` returns **plain text** (the edit path sets no `parse_mode`).

## 2. Copy (adjustable — David's to finalize)

Friendly, first-person, present-continuous so each line is true when it appears (the status is sent just
before `buildContext`/the DB pull runs, so a completed-past "I've gathered…" would be ~1 s premature).

- **Question** `initialStatus`: `✍️ Pulling together the context and writing your response…`
- **Recap** `initialStatus`: `✍️ Reading back through the recent messages and putting your recap together…`
- **Document** `initialStatus`: `📄 Downloading your document — one moment…`
- **Document** `updateStatus` (after download): `✍️ Got it — reading through the document and writing your response…`

## 3. Wiring the three call sites (`route.ts`)

All three keep the up-front `👀` reaction (zero-latency ack) and run inside their existing `waitUntil`.
Replace the up-front `sendChatAction('typing')` with the status machine (the keep-alive subsumes it).

- **§14 normal answer:**
  ```
  const result = await runWithStatus({
    token, chatId, threadId, replyToMessageId: message.message_id,
    initialStatus: QUESTION_STATUS,
    work: async () => answerQuestion({ entityId, groupId, threadId, question, model: bot.model, persona: bot.persona, botId }),
    mapError: () => '⚠️ Sorry, something went wrong while processing your request.',
  });
  if (result) await logBotResponse({ ...normal metadata... });
  ```
- **§13 recap:** same shape, `initialStatus: RECAP_STATUS`, `work` calls `recapConversation(...)`,
  `mapError` → the recap-specific generic line; log on non-null `result`.
- **§14 document:** the MIME/size gates stay **before** `runWithStatus` (instant direct replies that
  `return`). Then:
  ```
  const result = await runWithStatus({
    token, chatId, threadId, replyToMessageId: message.message_id,
    initialStatus: DOC_DOWNLOAD_STATUS,
    work: async (updateStatus) => {
      const fileData = await downloadTelegramFile(token, targetDoc.file_id);
      await updateStatus(DOC_READING_STATUS);
      return answerAboutDocument({ entityId, groupId, threadId, question, document: { data: fileData.data, mediaType: 'application/pdf' }, botId });
    },
    mapError: (err) => err instanceof DocumentReadError
      ? (err.reason === 'too_many_pages' ? 'That PDF has too many pages for me to read — the limit is 100 pages.'
        : err.reason === 'unreadable' ? 'I was unable to read that PDF. Please ensure it is not password-protected or corrupt.'
        : '⚠️ Sorry, something went wrong while processing your request.')
      : '⚠️ Sorry, something went wrong while processing your request.',
  });
  if (result) await logBotResponse({ ...document_qa metadata... });
  ```

Each branch's outer `try/catch` (the last-resort generic send) stays as-is.

## 4. Behavior changes & non-goals

- **Keep-alive now spans the whole `work`.** For documents that means it also runs during the ~1-3 s
  download (today it starts after). Harmless — a typing indicator alongside the "Downloading…" message —
  and it's what lets one helper serve all three paths without a per-caller keep-alive-timing knob. (If exact
  current timing must be preserved, the alternative is a `startKeepalive` callback passed into `work`;
  not recommended.)
- **A status message now appears on every question and recap**, not just documents. Given the ~18 s waits
  this is the point; the single-chunk path edits it into the answer so it's replaced, not left as clutter.
- **No separate "gathering" phase for question/recap.** Context/message gathering is a sub-second DB read;
  a distinct "gathering…" edit would flash and immediately be overwritten, and it would be a *second*
  Telegram call milliseconds after the first — avoidable flood-limit pressure on a multi-tenant bot. One
  status message, one call. Documents keep two phases because the download is a *real* multi-second wait.
- **`👀` reaction stays** as the instant ack before the status message.

## 5. Tests (`scripts/test-status-ux.ts`) + regression

- **Regression:** `test-document-read-ux.ts` must still pass unchanged — proves the extraction preserved the
  document machine (single-chunk edit, multi-chunk delete+split, error edit, null-`statusId` fallback,
  keep-alive stop).
- **Question path:** mention (no doc) → assert a status `sendMessage` (the QUESTION copy), then a terminal
  `editMessageText` carrying the answer text + entities, and **no** separate answer `sendMessage`
  (single-chunk reuse).
- **Recap path:** `/recap` → status message (RECAP copy) → terminal edit into the recap.
- **Multi-chunk (question):** force a >4096-char answer → status `deleteMessage`d, answer via
  `sendFormattedMessage`.
- **Error (question):** model throws → status edited to the plain generic line (assert no raw `<`/`>`).
- **Null-status:** initial status send rejects → answer still delivered via `sendFormattedMessage`.
- **Keep-alive:** with fake timers / short interval, assert refreshes fire during `work` and stop after
  completion on both success and error paths.

## 6. Handoff notes

- **Extract first, re-point document second, wire question/recap third.** Step 1 is behavior-preserving; the
  existing document test suite gates it.
- **`runWithStatus` lives in `lib/telegram.ts`** (it orchestrates only Telegram sends + keep-alive +
  splitting; the model call is injected via `work`, keeping it provider-agnostic).
- **`mapError` must return plain text** — the edit path sets no `parse_mode`, so any `<i>`/`<b>` would render
  literally (this was a real bug in the document path; don't reintroduce it).
- **Keep the `👀` reaction and the outer `try/catch`** in each branch.
- Copy strings (§2) are constants at the top of the route (or a small `lib/status-copy.ts`); flagged as
  David-adjustable.
- No schema, no migration.

---

*End of SPEC — Status-Message UX for All Model Calls*