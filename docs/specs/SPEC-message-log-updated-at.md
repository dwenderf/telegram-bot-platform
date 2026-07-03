# SPEC — `message_log.updated_at` (edit timestamp)

> **Reads against:** `lib/capabilities.ts` (`updateLoggedMessage`, `logMessage`, `logBotResponse`,
> `buildContext`, `recapConversation`) and `message_log`'s schema
> (`20260618000000_init_schema.sql` + `20260625000000_message_log_bot_responses.sql` +
> `20260703010000_edited_message_sync.sql`).
> **Rigor bar:** match prior phases; the test must assert the mechanism *fires* (insert leaves NULL,
> edit sets non-NULL) — not just that the column exists.
> **One-line scope:** add a nullable `updated_at` to `message_log` that stays NULL until a row is
> edited, so an edited message is distinguishable (and time-stamped) versus a never-edited one.

> **Sequencing:** small, self-contained fast-follow to the edited-message-sync feature. One additive
> migration + one line in `updateLoggedMessage` + a test.

---

## 0. Why

`updateLoggedMessage` rewrites `message_text` in place on an edit, but `message_log` has only
`created_at` — nothing records that a row changed or when. So an edited message is indistinguishable
from an original one, and the fact/time of the edit is lost from `message_log` (recoverable only by
cross-referencing the `edited_message` payload in `telegram_events`). Adding `updated_at` makes edits
self-evident in the row itself: it is the field that lets you see "this row was edited at T" versus
"never edited," and — when transcript text disagrees with the archived original — tells you the row was
edited rather than mis-logged.

## 1. Design decisions (settled)

- **Nullable, NULL until modified — NO default.** The *presence* of a value is the edit flag:
  `updated_at IS NULL` ⇒ never edited; `updated_at IS NOT NULL` ⇒ edited, and the value is when. This
  carries more information than a `default now()`/backfill-to-`created_at` design and reads more
  honestly (a never-edited message truly has no "updated" time). It also removes the backfill step
  entirely — existing rows are correctly NULL (never edited) with no data migration.
- **No default, no backfill.** `add column updated_at timestamptz` (nullable). Existing rows stay NULL,
  which is correct.
- **Maintained app-side in `updateLoggedMessage`, NOT by a trigger.** Deliberate: this schema has
  **no triggers** and we are keeping it that way. `updateLoggedMessage` sets `updated_at = now()` in its
  UPDATE. Consequence accepted: any *future* writer that updates a `message_log` row must remember to set
  `updated_at` itself — there is no DB-level guarantee. (If a future need makes that discipline
  untenable, revisit a `before update` trigger then; not now.)
- **`updated_at IS NULL` is the canonical "never edited" signal.** Any future reader/filter/sort on this
  column MUST be NULL-aware (e.g. `updated_at > created_at` and `updated_at > <time>` both silently
  exclude never-edited rows because NULL comparisons aren't true). State this so a future
  "recently-modified messages" query doesn't accidentally drop or include never-edited rows wrongly.

## 2. The change

### 2.1 Migration (additive, nullable, no default, no backfill)

New migration, house style matching `20260625000000_message_log_bot_responses.sql`:

```sql
alter table public.message_log add column if not exists updated_at timestamptz;
```

No index (no current query filters/sorts on it; add later if a reader needs it). No RLS change (the
message_log policy already covers new columns). No backfill.

### 2.2 `updateLoggedMessage` sets it

In `updateLoggedMessage`'s UPDATE, add `updated_at = now()` alongside `set message_text = ...`. So an
edit both rewrites the text and stamps the edit time in one statement. Nothing else calls it, so this is
the only writer that sets `updated_at` today.

## 3. What this deliberately does NOT do

- **No trigger.** App-side maintenance only; schema stays trigger-free (§1).
- **No default / no backfill.** NULL-until-modified is the design, not an omission.
- **No capture of Telegram's `edit_date`.** `updated_at` is a generic row-modification time (when *we*
  updated the row), not the user's Telegram edit timestamp. If the user's edit time is ever needed
  specifically, that's a separate nullable `edited_at` fed from `payload.edited_message.edit_date` —
  out of scope here.
- **No surfacing in context or recaps.** Verified: `buildContext` selects
  `username, message_text, created_at` and `recapConversation` selects
  `username, coalesce(summary, message_text) as body, is_bot_response` — both explicit column lists, not
  `select *` — so `updated_at` is inert to the prompt/transcript. Do not add it to those selects.
- **No index** (§2.1).
- **No change to `logMessage` / `logBotResponse`.** Inserts leave `updated_at` NULL, which is correct
  (a freshly-logged message has not been edited).

## 4. Tests (`scripts/test-message-updated-at.ts`, or fold into `test-edited-message-sync.ts`)

The point is to prove the mechanism *fires*, and the NULL design makes the assertions crisp
(NULL vs not-NULL is unambiguous — no timestamp-fuzziness):

1. **Insert leaves NULL.** After `logMessage` (with a `telegramMessageId`), the row's `updated_at` IS
   NULL.
2. **Edit sets non-NULL.** After `updateLoggedMessage` on that message, the row's `updated_at` IS NOT
   NULL (and, if asserting more, `>= created_at`).
3. **Untouched row stays NULL.** A second logged message that is never edited still has `updated_at`
   NULL after an edit to a *different* message — proving the stamp is per-row, not table-wide.
4. **(Optional) Bot rows unaffected.** A `logBotResponse` row has `updated_at` NULL (never updated),
   consistent with inserts leaving it NULL.

## 5. Handoff notes for Antigravity

- **One migration** adding `updated_at timestamptz` (nullable, no default, no backfill, no index) to
  `message_log`. Match the additive/nullable house style; note "no RLS change."
- **One line** in `updateLoggedMessage`: add `updated_at = now()` to the existing UPDATE's SET clause.
- **Do not** add a trigger, a default, a backfill, an index, or `updated_at` to any SELECT (§3).
- **Test asserts the mechanism fires** (NULL on insert, non-NULL after edit, per-row) — not just column
  existence. This is the guard that proves `updateLoggedMessage` actually stamps it.
