# SPEC — Edited-Message Sync to `message_log`

> **Reads against:** `lib/capabilities.ts` (`logMessage`, `buildContext`, `recapConversation`),
> `app/api/webhooks/platform/[botSlug]/route.ts` (ingest, entity resolution, the
> `if (!message || !message.chat || !message.text)` filter), and `message_log`'s schema
> (`20260618000000_init_schema.sql` + `20260625000000_message_log_bot_responses.sql`).
> **Rigor bar:** match prior phases; assert the post-edit stored text in a test against real update
> shapes.
> **One-line scope:** when a user edits a Telegram message, update the corresponding `message_log` row
> in place so the bot's context and recaps reflect the user's *intended* (edited) text — not the
> original.

> **Sequencing:** build after (or with) the schema prerequisite (§1). Two parts: an additive migration,
> then a webhook handler branch + a capabilities function.

---

## 0. Why

`edited_message` updates are already captured verbatim in `telegram_events` (confirmed in production),
but they never reach `message_log` — they fall out at the webhook's
`if (!message || !message.chat || !message.text)` filter because the payload key is `edited_message`,
not `message`. So today an edit is invisible to the bot: `buildContext` (answer path) and
`recapConversation` both read `message_text` from `message_log`, so they serve the *original* text. If a
user edits a message to correct or clarify it, a question or recap referencing "what X said" uses the
stale version.

Edited text is the user's intended content. Update in place (not append) so history reflects one
correct version, not two contradictory ones.

## 1. Schema prerequisite (REQUIRED — the feature is impossible without it)

**`message_log` does not store the Telegram `message_id`.** Confirmed against both migrations: columns
are `id` (bigserial), `entity_id`, `group_id`, `telegram_chat_id`, `telegram_thread_id`,
`telegram_user_id`, `username`, `message_text`, `is_command`, `is_bot_mention`, `is_bot_response`,
`summary`, `generation_metadata`, `created_at`. There is **no** Telegram `message_id`, so there is no key
to match an incoming `edited_message` against. This must be added first.

**Additive migration:**
- Add `telegram_message_id bigint` (nullable) to `message_log`.
- Add a partial index to make the edit-lookup fast and correct:
  `create index ... on message_log (telegram_chat_id, telegram_message_id) where telegram_message_id is not null;`
- Additive + nullable ⇒ existing rows unaffected, existing inserts unaffected. No RLS change (the
  message_log policy already covers new columns).

**`logMessage` must start storing it.** Add `telegramMessageId` to `logMessage`'s input and insert it.
The webhook already has `message.message_id` in scope at the `logMessage` call site (step 10). Thread it
through.

**Consequence — the feature only works for messages logged AFTER this ships.** Pre-migration rows have
`telegram_message_id = NULL`, so edits to old messages can't be matched. That's acceptable: the update
path is "match if present, ignore if not" (§2). No backfill (Telegram `message_id` for historical rows
isn't recoverable anyway).

**Bot-response rows:** `logBotResponse` rows have no inbound Telegram `message_id` — leave
`telegram_message_id` NULL for them. Edits only ever match user rows. No conflict.

## 2. The edit handler

### 2.1 Webhook branch (`route.ts`)

Add handling for `edited_message` updates. Placement matters:

- The archive block (3b) already captures `edited_message` — **do not touch it.**
- Add a branch that detects `update.edited_message` (the current code only reads `update.message`).
- It must run **after** entity/group resolution (the update-in-place is an RLS-scoped write, so it needs
  tenant context) and must **not** flow into the normal command/mention/answer pipeline — an edit is not
  a new command or question. It is a self-contained "sync the stored text and return ok" branch.
- Resolve tenant/group the same way the message path does (`resolveEntityIdByChat` → entity/group). If
  the chat is unbound, ignore the edit (nothing to sync) and return ok.
- Respect the excluded-thread gate: if the edited message is in an excluded thread, ignore it (consistent
  with not operating there).
- Call the new `updateLoggedMessage` capability (§2.2). Return `{ ok: true }`. Do **not** send any
  Telegram message, set any reaction, or trigger any model call.

### 2.2 `updateLoggedMessage` capability (`lib/capabilities.ts`)

New function, RLS-scoped via `withTenantContext`:

```
updateLoggedMessage({
  entityId, groupId,
  telegramChatId, telegramMessageId,
  newText,
})
```

- Update `message_log set message_text = ${newText}` where
  `group_id = ... and telegram_chat_id = ... and telegram_message_id = ... and is_bot_response = false`.
- **Match on `telegram_message_id` + `telegram_chat_id`** (the index from §1). Scope to
  `is_bot_response = false` so an edit can never overwrite a bot row (defense-in-depth; bot rows have
  NULL `telegram_message_id` anyway).
- **If no row matches, do nothing** (the message predates message_id logging, or was never logged, e.g.
  excluded thread). No insert, no error. This is the "ignore if not present" rule.
- Return whether a row was updated (for the test / optional logging), but the webhook ignores the return.

## 3. What this deliberately does NOT do

- **No re-answering / re-triggering.** Editing a message the bot previously answered updates the stored
  text only; it does not re-run `answerQuestion` or notify anyone. (Explicit so nobody builds
  edit-triggers-reanswer later assuming it was intended.)
- **No append / no edit history.** Update in place; the prior text is not retained in `message_log`.
  (The full edit *is* retained verbatim in `telegram_events` for forensics — that's the archive's job,
  not message_log's.)
- **No handling of message deletions.** Telegram does not deliver deletion events to bots (confirmed:
  no `deleted_message` update type), so `message_log` cannot honor deletions. Out of scope and
  un-actionable; noted as a known platform limitation (see BACKLOG).
- **No `generation_metadata` / bot-response edits.** Bots don't receive inbound edits of their own
  messages; NULL `telegram_message_id` on bot rows, untouched.
- **No backfill** of `telegram_message_id` on existing rows.

## 4. Tests (`scripts/test-edited-message-sync.ts`)

1. **message_id is stored.** After `logMessage` with a `telegramMessageId`, assert the row has it.
2. **Edit updates in place.** Log a message (id M, text "original"); call `updateLoggedMessage` for
   (chat, M, "edited"); assert the *same* row now has `message_text = 'edited'` and **no new row was
   inserted** (row count unchanged for that chat/message).
3. **Context reflects the edit.** After the edit, `buildContext` / `recapConversation` for that thread
   return the edited text, not the original. (Proves the downstream payoff — both read `message_text`.)
4. **Unmatched edit is a no-op.** Call `updateLoggedMessage` for a `telegram_message_id` that isn't in
   the table; assert nothing changes and no error is thrown (the "ignore if not present" rule; covers
   pre-migration / excluded-thread / unlogged messages).
5. **Edit cannot touch a bot row.** Seed a bot-response row (NULL `telegram_message_id`); call
   `updateLoggedMessage` in a way that must not match it; assert the bot row is unchanged (guards the
   `is_bot_response = false` scoping).

## 5. Handoff notes for Antigravity

- **Two-step build:** (1) additive migration adding `telegram_message_id` + partial index, and
  `logMessage` storing it (threaded from `message.message_id` at the step-10 call site); (2) the
  `edited_message` webhook branch + `updateLoggedMessage` capability.
- **Migration house style:** match `20260625000000_message_log_bot_responses.sql` (additive, nullable,
  comment block, note "no RLS change").
- **Webhook branch placement is load-bearing:** after entity/group resolution, before/outside the normal
  command-and-mention pipeline, self-contained, returns ok with no user-facing output. Read the current
  ingest flow (secret gate → `req.json()` → archive → message-shape filter → entity resolution →
  command dispatch) and slot the edit branch so it sees resolved tenant context but does not fall into
  command handling.
- **The match key is `telegram_chat_id` + `telegram_message_id`, scoped to `is_bot_response = false`.**
  Confirm the update is RLS-scoped (`withTenantContext`) like every other `message_log` write.
- **Do not touch the `telegram_events` archive block.** Edits are already captured there; this is only
  about syncing `message_log`.
