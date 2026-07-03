# SPEC — Populate `model_calls.bot_id`

> **Reads against:** `lib/capabilities.ts` (`logModelCall`, `answerQuestion`, `recapConversation`) and
> `app/api/webhooks/platform/[botSlug]/route.ts` (which already resolves `botId` at the top of the
> handler via `resolveBotIdBySlug`).
> **Rigor bar:** match prior phases; assert the populated value in a test, not just "it inserted."
> **One-line scope:** thread the already-resolved platform `botId` from the webhook down through
> `answerQuestion` / `recapConversation` into the `logModelCall` parameter that already exists and is
> already inserted — so `model_calls.bot_id` stops being NULL.

> **Sequencing:** trivial, self-contained, do anytime. No migration.

---

## 0. Why

`model_calls.bot_id` is NULL on every row. In `SPEC-model-call-logging.md` that was a correct v1
"nullable seam." Phase 3 shipped the single shared platform bot (`@leguan_the_bot`, slug `leguan`) with
a backfilled `bots` row, so a real bot id now exists to point at. This wires it up.

**Scope decision (settled):** `bot_id` means **"which bot served this call"** — the platform bot that
handled the webhook. It is **not** the multi-bot-store attribution seam. Populate every row with the id
of the bot that served the call. (In a future multi-bot world this stays correct; it just becomes more
interesting.)

## 1. What the code already does (so the change is tiny)

- `logModelCall` **already** accepts `botId?: string | null` in its input interface and **already**
  inserts it: `${input.botId || null}::uuid`. **No change to `logModelCall` and no migration.**
- The only reason rows are NULL: the two callers — `answerQuestion` and `recapConversation` — never
  *pass* `botId`, because they don't receive one in their own inputs.
- The webhook handler **already** has `botId` in scope: `const botId = await resolveBotIdBySlug(botSlug)`
  near the top, before it dispatches to the answer/recap paths.

So the entire change is: add `botId` to the inputs of `answerQuestion` and `recapConversation`, forward
it into their existing `logModelCall(...)` calls, and pass the webhook's `botId` at both call sites.

## 2. The change

1. `answerQuestion` input: add `botId?: string | null`. In its `logModelCall({...})` call, add
   `botId: input.botId`.
2. `recapConversation` input: add `botId?: string | null`. In its `logModelCall({...})` call, add
   `botId: input.botId`.
3. In `route.ts`, at the two call sites (the `isBotMention` → `answerQuestion` block and the
   `isRecapCommand` → `recapConversation` block), pass `botId` (already in scope from
   `resolveBotIdBySlug`).

Nullable throughout: if `botId` is somehow null, the column stays null (no regression vs today). No
fail-fast — a model call must still succeed and log even if bot resolution somehow returned null.

## 3. What this deliberately does NOT do

- **No `logModelCall` change** — it already handles `botId`.
- **No migration** — the column already exists.
- **No multi-bot attribution semantics** — `bot_id` = the serving bot, singleton today.
- **No backfill of existing NULL rows.** Historical rows stay NULL; this only populates rows written
  after the change. (Backfilling old rows to the single platform bot is possible but not in scope —
  note as an optional one-off if ever wanted.)

## 4. Tests (extend `scripts/test-model-call-logging.ts`)

1. **`bot_id` populates.** Call `answerQuestion` (and `recapConversation`) with a known `botId`; assert
   the resulting `model_calls` row has `bot_id` equal to that id.
2. **Null-safe.** Call without `botId` (or with null); assert the row inserts with `bot_id` NULL and the
   call still succeeds (no throw). Guards the "resolution returned null must not break logging" path.

## 5. Handoff notes for Antigravity

- Three-touch change: two function-input additions in `lib/capabilities.ts` + forwarding, and two
  argument additions at the `route.ts` call sites. `botId` already exists in the webhook scope — do not
  re-resolve it.
- Do not touch `logModelCall`'s body or the migration.
- Confirm both call sites in `route.ts` (answer path and recap path) pass `botId`; missing one leaves
  that call_type's rows NULL (a partial, easy-to-miss regression).
