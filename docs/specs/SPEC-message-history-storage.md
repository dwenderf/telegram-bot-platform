# SPEC: Phase 1 — store bot responses + summary + provenance metadata (for Antigravity)

> **Status:** ready to implement. This is the **foundation** for `/recap` and (later) summary-based context retrieval. Build this FIRST.
> **Goal:** the bot's own answers are recorded in `message_log` alongside user messages, with two extra nullable columns (`summary`, `generation_metadata`) that stay null for now but are populated by later phases. Pure additive change — no behavior change to existing flows.

---

## Why now
Today `message_log` records only **incoming user messages**. The bot's answers are not stored, so any feature that wants "the conversation so far" (e.g. `/recap`, or future multi-turn context) only sees half of it. Storing responses is cheap (one insert after each send) and unlocks those features. We add the `summary` + `generation_metadata` columns in the **same migration** so we never have to re-migrate when the later phases land — they're free to add now and sit null until used.

---

## Change 1 — Migration: `supabase/migrations/20260625000000_message_log_bot_responses.sql`

(Use the next available timestamp; `20260625000000` assumed.)

```sql
-- Add bot-response logging support to message_log:
--   is_bot_response  — marks a row as the bot's own outgoing answer (vs a user message)
--   summary          — optional short summary of a LONG bot response (Phase 2; null for now
--                      and for all user messages / short responses)
--   generation_metadata — provenance for a bot response: how it was produced
--                      ({model, context_doc_paths, history_message_ids, thread_id,
--                        token_counts?, latency_ms?}). null for user messages.
--
-- All additive + nullable (is_bot_response has a default), so existing inserts and
-- rows are unaffected. No RLS change (message_log policy already covers new columns).
-- Created At: 2026-06-25

alter table message_log
  add column is_bot_response   boolean not null default false,
  add column summary           text,
  add column generation_metadata jsonb;

-- Optional: a partial index to fetch a thread's bot responses quickly (small, harmless).
-- /recap and history retrieval filter by group_id+thread+created_at (already indexed by
-- idx_message_log_lookup); this just speeds bot-only scans if ever needed.
create index idx_message_log_bot_responses
  on message_log (group_id, telegram_thread_id, created_at desc)
  where is_bot_response = true;
```

> Apply with `npx supabase db push` (David runs it). Verify after:
> ```sql
> select column_name, data_type, is_nullable
> from information_schema.columns
> where table_name = 'message_log'
>   and column_name in ('is_bot_response','summary','generation_metadata');
> ```
> Expect three rows; `is_bot_response` not-null (default false), the other two nullable.

---

## Change 2 — `logBotResponse(...)` in `lib/capabilities.ts`

Add a sibling to the existing `logMessage`. It writes a bot-response row. Keep it separate from `logMessage` (rather than overloading it) so the call sites stay readable and the bot-specific fields are explicit.

```typescript
/**
 * Log the bot's own outgoing response to message_log (is_bot_response = true).
 * summary stays null in Phase 1 (Phase 2 will populate it for long responses).
 * generationMetadata captures provenance for debugging / future "explain this answer".
 */
export async function logBotResponse(input: {
  entityId: string;
  groupId: string;
  telegramChatId: bigint | number | string;
  telegramThreadId: bigint | number | string | null;
  botUsername: string;              // stored in `username` so recaps read naturally
  messageText: string;              // the full answer text the bot sent
  summary?: string | null;          // Phase 2; pass null/undefined for now
  generationMetadata?: Record<string, unknown> | null;
}): Promise<void> {
  const chatIdStr = input.telegramChatId.toString();
  const threadIdStr =
    input.telegramThreadId !== null && input.telegramThreadId !== undefined
      ? input.telegramThreadId.toString()
      : null;

  await withTenantContext(input.entityId, async (tx) => {
    await tx`
      insert into message_log (
        entity_id, group_id, telegram_chat_id, telegram_thread_id,
        telegram_user_id, username, message_text,
        is_command, is_bot_mention, is_bot_response,
        summary, generation_metadata
      ) values (
        ${input.entityId}, ${input.groupId}, ${chatIdStr}, ${threadIdStr},
        ${null}, ${input.botUsername}, ${input.messageText},
        ${false}, ${false}, ${true},
        ${input.summary ?? null},
        ${input.generationMetadata ? tx.json(input.generationMetadata) : null}
      )
    `;
  });
}
```

> `telegram_user_id` is left null for bot rows (the bot isn't a tracked user). `username` carries the bot's name so a recap/history read renders "KenntnisBot: ..." naturally. (`postgres` lib: use `tx.json(...)` for the jsonb param, or `${sql.json(obj)}` per the project's existing convention — match however jsonb is written elsewhere; if jsonb hasn't been written before, `tx.json()` is correct for the `postgres` npm client.)

---

## Change 3 — call `logBotResponse` after the bot sends an answer

In `app/api/webhooks/telegram/[entitySlug]/route.ts`, the `/ask` + `@mention` handler (the `waitUntil` async block) currently generates the answer and calls `sendMessage`. After a **successful** send, log it.

The current block (abridged):
```typescript
const { answerText } = await answerQuestion({ ... });
const sanitizedAnswer = sanitizeForTelegramHtml(answerText);
await sendMessage(entity.telegram_bot_token, message.chat.id, sanitizedAnswer, { ... });
```

Add the log right after the send succeeds:
```typescript
const { answerText } = await answerQuestion({ ... });
const sanitizedAnswer = sanitizeForTelegramHtml(answerText);
await sendMessage(entity.telegram_bot_token, message.chat.id, sanitizedAnswer, { ... });

// Phase 1: record the bot's response so the conversation log is complete
// (enables /recap and future multi-turn context). Non-fatal if it fails.
try {
  await logBotResponse({
    entityId: entity.id,
    groupId: group.id,
    telegramChatId: message.chat.id,
    telegramThreadId: threadId,
    botUsername: entity.telegram_bot_username,
    messageText: answerText,   // store the ORIGINAL answer, not the HTML-sanitized one
    summary: null,             // Phase 2 will fill this for long answers
    generationMetadata: {
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      thread_id: threadId,
      // context_doc_paths / history_message_ids / token_counts / latency_ms:
      // add when answerQuestion is extended to return them (Phase 2/3). Null/absent is fine now.
    },
  });
} catch (err) {
  console.error('Failed to log bot response:', err);
}
```

**Important details:**
- **Store `answerText` (the original), not `sanitizedAnswer`.** The sanitized version has HTML escaping for Telegram; the log should hold the clean text so recaps/retrieval read naturally and don't accumulate `&amp;` etc.
- **Wrap in try/catch, non-fatal.** Logging the response must never break the user-facing reply. If the insert fails, log to console and move on — the user already got their answer.
- **Only log on successful send.** Place it after `sendMessage` resolves. If `sendMessage` throws, the existing catch handles the error path and we do NOT log a response that didn't go out.
- **`generation_metadata`** starts minimal (just `model` + `thread_id`). It's a `jsonb` blob, so fields can be added later without a migration. Don't over-build it now — the column existing is the point.

> **Scope note:** Phase 1 logs **`/ask` and `@mention` answers** (the real Q&A responses). Do NOT log `/help`, `/context`, or `/whoami` replies as bot responses — those are utility/command outputs, not conversational content a recap would want. (They're already logged as the user's *command* via the existing `logMessage` is_command path; the bot's mechanical reply to them isn't conversational.) If `/recap` later wants to note "bot showed context here," that's a future refinement — keep Phase 1 to genuine answers.

---

## Test plan
1. **Migration applies** → three new columns present; `is_bot_response` defaults false.
2. **Existing flows unaffected** → a normal user message still logs exactly as before (is_bot_response = false, summary/metadata null). `/ask` still answers normally.
3. **Bot response logged** → after an `/ask`, a new `message_log` row exists with `is_bot_response = true`, `username` = the bot username, `message_text` = the answer (un-sanitized), `telegram_user_id` null, `generation_metadata` containing at least `{model, thread_id}`.
4. **Thread scoping** → the bot row carries the same `telegram_thread_id` as the question it answered (so a per-topic recap pairs them).
5. **Failure isolation** → if `logBotResponse` throws (simulate), the user still receives the answer; only a console error is logged.
6. **Send-failure path** → if `sendMessage` throws, NO bot-response row is written (we only log after a successful send).

---

## What this does NOT do (deferred)
- **No summary generation** (Phase 2). `summary` stays null. The column just exists.
- **No change to context retrieval** (Phase 3). `buildContext` still reads `message_text` only; it does NOT yet use `coalesce(summary, message_text)` or include bot responses in the `/ask` context window. (That's a deliberate separate step — Phase 1 only *stores*; whether/how `/ask` *consumes* bot responses is Phase 3, decided after measuring.)
- **No `/recap`** — that's the next spec, built on top of this.
