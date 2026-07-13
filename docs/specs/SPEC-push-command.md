# SPEC — `/push` Command

> **Reads against (verified readers):** `lib/capabilities.ts` (`buildContext`, `getContextManifest`,
> `logModelCall`, `registerThread`), `app/api/webhooks/platform/[botSlug]/route.ts` (`/auth`, `/context`,
> `/recap` handlers — the patterns this command follows), `lib/telegram.ts` (`getChatMember`,
> `runWithStatus`, `setMessageReaction`, `sendMessage`), `lib/commands.ts`, `lib/model.ts` /
> `lib/providers/*` (`resolveProvider`, `callModel`), `lib/isolation.ts` (`resolveIsolationScopeId`),
> current live schema of `doc_cache` / `manifest_entries` / `threads` (post
> `20260701000000_manifest_normalization_additive.sql` **and**
> `20260713000000_manifest_normalization_drop.sql` — confirmed live: no `doc_path`, no `git_sha`, no
> `manifest_entries.telegram_thread_id`).
> **Rigor bar:** match Phases 1–4 / the normalization spec. This adds a new write path into
> `doc_cache`/`manifest_entries` (previously hand-authored SQL only) plus one LLM call, so the review
> surface is **write correctness** (right scope, right upsert-vs-insert decision, no orphaned rows) and
> **admin-gating parity with `/auth`** — not new RLS/definer-function surface (none added).
> **One-line scope:** a group-admin-gated chat command that lets a reply's text be persisted into
> `doc_cache` + a `manifest_entries` binding at topic or group scope, auto-named by a small LLM call,
> with a cheap origin-identity check that turns a repeat push of the same source message into an
> in-place update instead of a duplicate.

---

## 0. Design decisions (recap of the debate that produced this spec)

- **Command surface:** `/push topic|group` — strict allowlist, aliases `t`/`g`, case-insensitive,
  trimmed. No third argument. (An earlier draft explored a required `<document_name>` argument;
  rejected in favor of LLM-generated names — see §6 — which restores the original two-token design
  with zero added typing.)
- **Scope gating:** topic and group are pushable in-chat, gated by a Telegram group-admin check
  (`getChatMember`, identical pattern to `/auth`). Entity-level is dashboard-only, not a chat command —
  the bot has no `telegram_user_id → entity-admin` mapping, only `getChatMember` for group admin, and
  entity scope crosses all groups.
- **What gets pushed:** `reply_to_message.text` only. Replying to a document tells the user to get a
  bot summary first, then push that.
- **Upsert key:** the reply target's own `(chat_id, message_id)` — already in the webhook payload, no
  DB lookup required. **Not** `message_log.id`: `logBotResponse` (the function that logs the bot's own
  document-summary replies — precisely the message type this command exists to capture) never stores
  `telegram_message_id`, so keying off `message_log` would silently fail to match on the most common
  case. Re-pushing the same origin message to the same scope updates in place; a different origin
  message with the same scope always creates a new doc (name collisions are absorbed mechanically, see
  §6, so a human-facing "name already exists" rejection never surfaces).
- **Naming:** LLM-generated, lowercase-with-dashes, 3–6 words, no user-facing length limit (six words
  will never approach the column size) but a silent defensive truncation exists as backstop against a
  misbehaving model. Displayed as-is (dashes, not prettified to spaces) — this is an admin-facing
  surface, not end-user-facing, and dashes are legible enough.
- **Cost accepted:** a genuinely-new push costs one small LLM round-trip (a few seconds). Deemed
  worth it — `/push` is a low-frequency admin action, and `runWithStatus` (already used by `/recap` and
  `@mention`) covers the UX so the user isn't staring at silence.
- **ToS/accountability:** no separate in-chat flow. The entity's onboarding ToS covers it (group admins
  push to topic/group, never entity; the entity admin retains view/delete over all pushed context —
  future dashboard work, not this spec).

---

## 1. Command detection & parsing

Add alongside the existing `isHelpCommand` / `isContextCommand` / etc. block in the webhook route:

```ts
const isPushCommand = rawText ? rawText.startsWith('/push') : false;
```

Parsing (inside the handler, not at top-level intent detection — matches `/auth`'s and `/recap`'s
in-handler arg parsing):

```ts
const pushArg = text.replace(/^\/push(?:@[a-zA-Z0-9_]+)?\s*/i, '').trim();
const normalized = pushArg.toLowerCase();
let scope: 'topic' | 'group' | null = null;
if (normalized === 'topic' || normalized === 't') scope = 'topic';
else if (normalized === 'group' || normalized === 'g') scope = 'group';
```

Anything else — empty, `entity`, extra trailing text after the scope token (`/push topic foo`),
garbage — is **not** a valid scope and gets the usage message. This is a hard allowlist, not a
free-text parse; there is no third token to consume.

**Reaction:** set the 👀 reaction (`setMessageReaction`) immediately on any `/push*` invocation,
before validating scope — matches `/auth`'s "acknowledge receipt regardless of validity" placement,
not `/recap`'s (which has no reaction until later). Gives fast feedback that the command was seen.

**Usage message** (bad/missing scope arg):
```
Usage: reply to a message with <code>/push topic</code> or <code>/push group</code> to save it as
lasting context. (Group admins only.)
```

---

## 2. Reply-to-message validation

Runs after scope parsing succeeds, before the admin check (cheap, no API/DB calls — fail fast on
malformed input before spending a `getChatMember` round-trip).

```ts
const replyTarget = message.reply_to_message;
```

| Condition | Response |
|---|---|
| No `reply_to_message` at all | `Reply to a message with <code>/push topic</code> or <code>/push group</code> to save its text as lasting context.` |
| `reply_to_message.text` present (non-empty after trim) | Proceed — this is the content. |
| `reply_to_message.document` present, no usable text | `I can't push a document directly. Mention me on it first to get a text summary, then reply to that summary with /push.` |
| Anything else (photo, sticker, voice, poll, video, …) | `I can only push text messages. Reply to a text message (or one of my text answers) with /push.` |

Note Telegram's own model already makes `.text` and `.document` mutually exclusive on a message (a
document uses `.caption`, never `.text`), so this is a clean three-way branch, not an overlapping one.

---

## 3. Admin check & sync/async split

This is the first command that combines a synchronous gate (like `/auth`) with async heavy work (like
`/recap`/`@mention`) — no existing command does both, so this is a new but consistent shape:

1. **Synchronously** (before returning the webhook's 200, no `waitUntil`): scope parsing (§1), reply
   validation (§2), then the admin check via `getChatMember` (same call/status-check as `/auth`:
   `status === 'administrator' || status === 'creator'`). On failure: `Only a group admin can push
   context here.` — no DB work has happened yet.
2. **If admin-gated checks pass:** return 200 immediately, and do everything else (§4–§8: origin check,
   possible LLM call, the write, the confirmation reply) inside `waitUntil(...)` using `runWithStatus`,
   exactly like `/recap`. This keeps the webhook response fast regardless of whether the LLM ends up
   being called.

```ts
const STATUS_PUSH = '💭 Saving this to context…';
```

---

## 4. Scope resolution

- **Group scope:** `groupId = group.id`, `resolvedThreadId = null`.
- **Topic scope:** requires `threadId !== null` (current message's `message_thread_id`). If
  `threadId === null` (General topic, or a non-forum chat — both produce `null` identically, no
  separate `is_forum` check needed): reject with
  `There's no topic here to push to — try /push group instead, or push from inside a specific topic.`
  Otherwise resolve the structural `threads.id` row:
  ```sql
  select id from public.threads
  where group_id = ${groupId}::uuid and telegram_thread_id = ${threadId}::bigint
  ```
  This row is guaranteed to already exist by the time `/push` runs: step 10 of the webhook handler
  (`logMessage` → `registerThread`) runs unconditionally for every inbound message, including the
  `/push` command message itself, before any command branch executes. No race to handle.

---

## 5. Origin-identity check (update-in-place path)

Cheap, no LLM, runs first inside the async work:

```sql
select m.id as manifest_id, c.id as doc_id
from public.manifest_entries m
join public.doc_cache c on c.id = m.doc_id
where m.entity_id = ${entityId}
  and m.group_id = ${groupId}::uuid
  and m.thread_id is not distinct from ${resolvedThreadId}::uuid
  and c.source_type = 'push'
  and c.source->>'origin_chat_id' = ${originChatId}
  and c.source->>'origin_message_id' = ${originMessageId}
limit 1
```

Where `originChatId = message.chat.id.toString()`, `originMessageId = replyTarget.message_id.toString()`.
The match is scoped to the *specific* group/thread tuple — pushing the same source message to both
`topic` and `group` are two intentionally distinct entries, not competing updates.

**If found:** update in place, skip the LLM entirely, keep the existing `display_name`.
```sql
update public.doc_cache
set content = ${content},
    source = ${tx.json({ ...refreshedSource })},
    synced_at = now()
where id = ${matchedDocId}
```
`refreshedSource` keeps `origin_chat_id`/`origin_message_id`/`pushed_via`/`scope`/`first_pushed_at`
unchanged and overwrites `pushed_by_tg_user_id`/`pushed_by_username` with whoever ran this push.

**If not found:** proceed to §6.

---

## 6. Name generation (new pushes only)

### 6.1 LLM call

Small, single-purpose, not the `answerQuestion` persona/context machinery:

```ts
const isolationScopeId = resolveIsolationScopeId(groupId);
const model = bot.model || getModelIdentifier();
const provider = resolveProvider(model);

const existingNames = /* display_names already in this exact scope, see query below */;

const systemPrompt = `You generate short slug-style names for saved context documents. Output ONLY the slug — no explanation, no punctuation besides hyphens, no quotes.
Rules:
- 3 to 6 words
- lowercase letters and numbers only, words separated by single hyphens (e.g. "vendor-contract-terms")
- capture the core topic of the text
- avoid these existing names in this scope if possible: ${existingNames.length ? existingNames.join(', ') : 'none'}`;

const result = await provider.callModel({
  systemPrompt,
  userMessage: content,
  model,
  cacheable: false,
  isolationScopeId,
});
```

Existing names query (also reused for the mechanical uniqueness check in §6.3):
```sql
select c.display_name
from public.manifest_entries m
join public.doc_cache c on c.id = m.doc_id
where m.entity_id = ${entityId}
  and m.group_id = ${groupId}::uuid
  and m.thread_id is not distinct from ${resolvedThreadId}::uuid
```

Log via the existing `logModelCall` — **note for Antigravity:** its `callType` parameter is currently
typed `'answer' | 'recap'`; widen that union to include `'push_naming'`. No DB migration needed —
`model_calls.call_type` is plain `text not null`, no CHECK constraint.

### 6.2 Sanitize + fallback

```ts
function sanitizePushSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100); // defensive only — not a user-facing limit, guards a misbehaving model
}
```

If the sanitized result is empty, use the deterministic fallback instead of failing the command:
```ts
const fallback = `push-${scope}-${yyyymmdd(new Date())}`; // e.g. push-topic-20260713
```

### 6.3 Mechanical uniqueness (never trust the LLM alone)

Regardless of which path produced the candidate name (LLM output or fallback), check it against
`existingNames` (case-insensitive) and append `-2`, `-3`, … on collision until unique. This is what
makes name collisions invisible to the user — there is no "a doc with that name already exists,
try again" rejection anywhere in this command; collisions are always resolved mechanically.

**Race note for Antigravity:** re-run this uniqueness check inside the same transaction as the final
insert (§7), not just against the pre-LLM snapshot — cheap (same query), and closes the small window
where two concurrent new pushes to the same scope could otherwise pick the same name.

---

## 7. Writes

All inside one `withTenantContext(entityId, tx => ...)` call, consistent with every other capability
in `lib/capabilities.ts`.

**New doc (no origin match found):**
```sql
insert into public.doc_cache (entity_id, display_name, content, source_type, source)
values (
  ${entityId}, ${name}, ${content}, 'push',
  ${tx.json({
    pushed_via: 'telegram_push',
    pushed_by_tg_user_id: fromId,
    pushed_by_username: fromUsername,
    origin_chat_id: originChatId,
    origin_message_id: originMessageId,
    scope,
    first_pushed_at: new Date().toISOString(),
  })}
)
returning id
```
```sql
insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id)
values (${entityId}, ${groupId}::uuid, ${resolvedThreadId}::uuid, ${newDocId}::uuid)
```

**Existing doc (origin match found):** the update in §5.

---

## 8. Status UX & confirmation

Wrap the async work in `runWithStatus` with `initialStatus: STATUS_PUSH` (§3) — this covers both the
fast update path and the slower new-push-with-LLM path uniformly, same as `/recap` already does for
its own fast/slow variance.

**Success — new doc:**
```
✅ <b>Saved to {scope label}</b>

<b>{name}</b>
{first ~100 chars of content, HTML-escaped}…
```

**Success — updated doc:**
```
🔄 <b>Updated in {scope label}</b>

<b>{name}</b>
{first ~100 chars of content, HTML-escaped}…
```

Where `{scope label}` is `this topic` or `this group`. Reply threaded (`threadId`,
`replyToMessageId: message.message_id`), `parseMode: 'HTML'`, matching every other command's reply
shape.

---

## 9. Migration

One small additive migration — widens the `doc_cache.source_type` CHECK so `/push` can write a
distinguishable origin (separate from David's hand-authored `'manual'` rows, which matters for the
retention/PII work this feeds into later — an admin "view/delete pushed context" surface needs to
filter to push-origin rows specifically).

```sql
-- supabase/migrations/<ts>_doc_cache_source_type_push.sql
alter table public.doc_cache
  drop constraint if exists doc_cache_source_type_check;

alter table public.doc_cache
  add constraint doc_cache_source_type_check
  check (source_type in ('manual', 'push'));
```
Idempotent (drop-then-recreate), no backfill needed (existing rows are all `'manual'`, unaffected).

---

## 10. Command registration

`lib/commands.ts`:
```ts
{ command: 'push', description: 'Save this reply as lasting context (admins)' },
```

`/help` text (in the webhook route's `isHelpCommand` block), one additional line:
```
• Reply to a message with <code>/push topic</code> or <code>/push group</code> to save it as lasting context (group admins only).
```

---

## 11. Does NOT do

- Entity-level pushes (dashboard-only, deliberately not a chat command — see §0).
- Pushing raw documents/files — text only; a document reply is redirected to "summarize it first."
- A user-supplied name/title argument — fully superseded by LLM-generated naming.
- Renaming or deleting a previously-pushed doc from chat. Admins can't yet retitle or remove what
  they've pushed via any interface — that's future dashboard work (view/delete over pushed context),
  not needed for this spec.
- Any in-chat ToS/confirmation flow — covered by entity onboarding ToS.
- Retention/PII deletion tooling — the natural sequel to this spec, not part of it.

---

## 12. Adversarial test cases (`scripts/test-push-command.ts`)

Seed a test entity/group/thread fixture (mirroring `test-group-scoped-context.ts`'s pattern), mock
`getChatMember` (admin/non-admin), mock the LLM call, mock Telegram sends.

**Parsing & gating**
1. `/push`, `/push entity`, `/push topic extra text`, `/push xyz` → usage message, no DB writes, no
   admin check performed (fails before reaching it).
2. Valid scope + no `reply_to_message` → the "reply to a message" prompt, no admin check performed.
3. Valid scope + reply to a document with no text → the "summarize it first" message.
4. Valid scope + reply to a photo/sticker → the generic "text messages only" message.
5. Valid scope + valid reply, non-admin caller → "Only a group admin…", zero DB writes (assert no new
   `doc_cache`/`manifest_entries` rows).
6. `/push topic` in General (`threadId === null`) → the "no topic here" message, before any DB work.

**Writes**
7. Fresh push, group scope: one new `doc_cache` row (`source_type = 'push'`, `source` fields all
   populated) + one new `manifest_entries` row (`group_id` set, `thread_id` null).
8. Fresh push, topic scope: `manifest_entries.thread_id` resolves to the correct `threads.id` for that
   exact group+telegram_thread_id (reuse the cross-group collision fixture from
   `test-group-scoped-context.ts` — two groups sharing the same numeric `telegram_thread_id` — assert
   the push lands against the correct group's thread row, not the other group's).
9. Re-push of the *same* `(chat_id, message_id)` to the *same* scope → updates the existing
   `doc_cache` row in place (same `id`, same `display_name`, new `content`/`synced_at`), no new
   `manifest_entries` row, **no LLM call made** (assert the mock naming call was not invoked).
10. Re-push of the same origin message to a *different* scope (e.g. first `topic`, then `group`) →
    creates a second, independent doc — not treated as an update.
11. Two different origin messages, LLM returns the same name for both, same scope → second write gets
    the `-2` suffix; both resolve as separate `doc_cache` rows with distinct `display_name`s.
12. LLM returns an empty/unusable string → falls back to `push-<scope>-<yyyymmdd>`; collision on that
    fallback (two same-day pushes) also gets `-2` suffixed correctly.

**Resolver parity (no regression to existing paths)**
13. After a topic-scope push, `getContextManifest`/`buildContext` for that same (entity, group,
    thread) include the new doc in `topicDocs` alongside pre-existing entity/group/topic docs — reuses
    the exact query shape from `buildContext`/`getContextManifest`, so this doubles as a regression
    check that nothing in the read path broke.

---

## 13. Handoff notes for Antigravity

- **New capability function** in `lib/capabilities.ts`: `pushContext(input: { entityId, groupId, scope,
  threadTelegramId, content, originChatId, originMessageId, pushedByTgUserId, pushedByUsername, botId })
  → Promise<{ name: string; isUpdate: boolean }>`. Wraps §4–§7. The webhook route calls this from
  inside `runWithStatus`'s `work`, then builds the §8 reply from the returned `{ name, isUpdate }`.
- **Widen `logModelCall`'s `callType` TS type** to include `'push_naming'` (code-level type change,
  not a DB migration — the column has no CHECK).
- **Do the LLM call outside any open DB transaction** — the origin-identity check (§5) and the
  existing-names read (§6.1) can share a short read-only query, but don't hold a `tx` open across the
  `provider.callModel` HTTP round-trip. Open a fresh transaction for the final write (§7), and
  re-run the uniqueness check (§6.3) inside it per the race note there.
- **Command detection placement:** add `isPushCommand` alongside the other intent-detection booleans,
  but note it's the **first command requiring a synchronous admin gate before an async `waitUntil`
  block** — no existing command combines both, so this is new shape, not copy-paste from one place.
  `/auth` is the synchronous-gate reference; `/recap` is the `runWithStatus`/`waitUntil` reference.
- **Migration file** (§9) is a normal additive migration (`supabase/migrations/`), no manual-gate
  needed — it only widens a CHECK constraint, non-destructive, safe via ordinary `npx supabase db push`.
- **This spec assumes the live schema already reflects
  `20260713000000_manifest_normalization_drop.sql`** (no `doc_path`/`git_sha`/
  `manifest_entries.telegram_thread_id`) — confirm that migration has been applied via `npx supabase db
  push` before implementation, since the insert/update statements in §5/§7 will fail against the old
  shape (they don't supply `doc_path`, which was `NOT NULL` pre-drop).
