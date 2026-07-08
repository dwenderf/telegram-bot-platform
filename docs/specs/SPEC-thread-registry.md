# SPEC — Thread & Group Registry (row creation + name/icon capture + group-name sync)

> **Reads against:** `lib/capabilities.ts` (`logMessage`, `resolveTenant`/group resolution,
> `resolveEntityIdByChat`), `app/api/webhooks/platform/[botSlug]/route.ts` (ingest flow: secret gate →
> `req.json()` → archive 3b → `edited_message` branch → the
> `if (!message || !message.chat || !message.text)` filter → entity/group resolution → command dispatch),
> and the `threads` table (`20260701000000_manifest_normalization_additive.sql`: `id uuid`,
> `entity_id uuid not null`, `group_id uuid not null`, `telegram_thread_id bigint not null`,
> `unique (group_id, telegram_thread_id)`) and `groups` (`20260618000000_init_schema.sql`).
>
> **Rigor bar:** match prior phases. Assert against the **real update shapes** captured in
> `telegram_events` (creation, rename, ordinary-message-with-stale-reply_to, group rename). Every active
> topic must acquire a `threads` row on first sight **without manual entry**, and a topic's name/icon must
> survive a rename (never revert to the stale reply-to echo).
>
> **One-line scope:** (1) create a `threads` row on first sight of any topic message (existence),
> (2) capture/refresh a topic's `name` + icon from the **top-level** `forum_topic_created` /
> `forum_topic_edited` service messages, and (3) update `groups.display_name` from `new_chat_title`.
>
> **Sequencing:** one additive migration (nullable columns on `threads`), then a webhook service-message
> branch + a `capabilities` helper. No breaking changes. **Prerequisite** for retention thread-summaries
> and for a manifest-management UI (both need durable thread rows; the UI needs names).

---

## 0. Why

Two independent gaps, same root cause.

**Thread rows don't exist for most conversations.** Nothing creates a `threads` row at runtime — the
webhook logs to `message_log` (which stores `telegram_thread_id` inline) and resolves users/memberships,
but never touches `threads`. Rows only appear via manifest binding or the one-time backfill in
`20260701000000`. Confirmed in practice: binding a manifest doc to a brand-new topic required manually
inserting the thread first. Any feature that hangs data off a thread — retention summaries, a manifest UI
that lists topics — needs a row to exist, so this is the load-bearing prerequisite.

**Topic names are only knowable at the moment an event flies past.** The Bot API has **no**
`getForumTopic` method — a topic's name cannot be fetched on demand; it is delivered *only* inside the
`forum_topic_created` / `forum_topic_edited` service messages. If we don't persist the name when we see
that event, it is unrecoverable until the next rename. So storing `name` on `threads` is not cosmetic —
capture-and-persist is the sole mechanism that exists.

Both are fixed here: existence via upsert-on-sight, name/icon via the service-message events.

## 1. Schema prerequisite (additive migration)

`threads` currently has no place to store a name or icon. Add three nullable columns:

- `name text` — the topic title.
- `icon_color integer` — Telegram's topic icon color (e.g. `7322096`; the fixed palette all fits in int4).
- `icon_custom_emoji_id text` — custom-emoji icon id when set.

House-style additive migration (match `20260701000000_manifest_normalization_additive.sql`):

```sql
-- Migration: 20260709000000_thread_registry_columns.sql (additive, nullable)
alter table public.threads
  add column if not exists name                 text,
  add column if not exists icon_color           integer,
  add column if not exists icon_custom_emoji_id text;
```

- Additive + nullable ⇒ existing rows unaffected, existing inserts unaffected.
- **No RLS change.** The `thread_isolation` policy already covers new columns; `bot_service` already has
  `select, insert, update, delete` on `threads`.
- **No backfill.** Historical thread names are not recoverable (no `getForumTopic`). Existing rows carry
  `name = NULL` until a rename fires or the retention/UI layer chooses to display `telegram_thread_id`.
  New names populate forward as events arrive.

## 2. The `registerThread` capability (`lib/capabilities.ts`)

One RLS-scoped helper, called from two places (§3), doing a single idempotent upsert. This is the whole
design — get this statement right and the rest is wiring.

```
registerThread(tx, {
  entityId, groupId, telegramThreadId,   // required — existence
  name?, iconColor?, iconCustomEmojiId?, // present ONLY for authoritative events
})
```

- Run **inside an existing `withTenantContext(entityId)` transaction** (`tx` passed in) so it piggybacks
  on the caller's tenant context and, for the `logMessage` caller, adds no extra round trip.
- The upsert:

```sql
insert into public.threads
  (entity_id, group_id, telegram_thread_id, name, icon_color, icon_custom_emoji_id)
values
  (${entityId}, ${groupId}, ${telegramThreadId}, ${name}, ${iconColor}, ${iconCustomEmojiId})
on conflict (group_id, telegram_thread_id) do update set
  name                 = coalesce(excluded.name, threads.name),
  icon_color           = coalesce(excluded.icon_color, threads.icon_color),
  icon_custom_emoji_id = coalesce(excluded.icon_custom_emoji_id, threads.icon_custom_emoji_id)
```

Why `coalesce(excluded.x, threads.x)` and not plain `excluded.x`: existence-only writes (ordinary
messages, §3.A) pass all three optional fields as **NULL**, and must never clobber a good name/icon back
to null. Authoritative events (§3.B) pass a real value, which overrides. Net effect:

- **Row absent** → inserted (name/icon set if this was a creation event, else null).
- **Ordinary message** (name/icon null) → row's existing name/icon preserved.
- **Rename** (new name) → name overwritten with the new one.

**Normalization the caller must apply before calling:** Telegram sends
`icon_custom_emoji_id: ""` (empty string) when a topic is reset to the default icon. Treat `""` as
`NULL` so it flows as "no update" rather than storing an empty string.

**Known cosmetic limitation (accepted, do not fix):** because of the `coalesce`, a genuine reset of the
custom emoji back to default (`""` → normalized to `NULL`) is preserved rather than cleared, so a stored
emoji id can lag a reset. This is an icon-only, purely cosmetic staleness; not worth per-field
explicit-set logic.

## 3. Wiring — two call sites

### 3.A Existence, folded into `logMessage`

`logMessage` already runs in `withTenantContext` and has `entityId`, `groupId`, and the resolved thread
id in scope. In that same transaction, when the thread id is **non-null**, call `registerThread` with
name/icon omitted (existence only).

- Covers every ordinary text message and `/whoami` (the paths that call `logMessage`).
- Self-healing: catches topics that **pre-existed the bot** or whose creation event was missed during a
  deploy — we never see their `forum_topic_created`, only ordinary messages, and this still registers them
  (with `name = NULL` until a rename supplies one).

### 3.B Name/icon + group name — a new service-message branch in `route.ts`

The name-bearing events are **text-less service messages**: `forum_topic_created`, `forum_topic_edited`,
and `new_chat_title` carry no `message.text`. The current ingest drops them at
`if (!message || !message.chat || !message.text) return NextResponse.json({ ok: true })` — they're
archived to `telegram_events` (3b) and then discarded. **Add a branch that runs after the
`edited_message` block and before that text filter.**

Detection uses **top-level** fields on `message` only:

- `message.forum_topic_created` → topic created. `{ name, icon_color, icon_custom_emoji_id? }`.
- `message.forum_topic_edited` → topic renamed/re-iconed. Fields are **optional and only-if-changed**
  (a name-only edit omits icon; an icon-only edit omits `name`). Pass through whatever is present.
- `message.new_chat_title` (string) → group renamed.

**Never read `message.reply_to_message.forum_topic_created`.** On ordinary messages the topic-root
service message is echoed there, and its `name` is the *original* creation name — it does **not** update
on rename. (Confirmed in the archive: after a topic was renamed "Joe Zolfo" → "Joseph Zolfo", a later
ordinary message still echoed "Joe Zolfo" in `reply_to`.) Only top-level created/edited events are
authoritative.

Branch behavior:

- Resolve `entityId` via `resolveEntityIdByChat(message.chat.id)`. If unbound → return ok (nothing to
  register). Resolve `group.id` within tenant context (same pattern as the rest of the route).
- **Topic created / edited:** `message.message_thread_id` is present on these; call `registerThread`
  with `name`/`iconColor`/`iconCustomEmojiId` from the event (icon empty-string normalized to null,
  §2). For `forum_topic_edited`, pass only the fields present.
- **Group renamed:** `withTenantContext(entityId)` →
  `update public.groups set display_name = ${message.new_chat_title} where telegram_chat_id = ...`.
  (`display_name` is otherwise only set at `/auth` time via `consume_link_token`; this keeps it fresh.)
- Return `{ ok: true }`. **No** Telegram reply, reaction, chat action, model call, or command dispatch —
  self-contained like the `edited_message` branch.
- **Dedup:** not required for this branch. `registerThread` is idempotent and the group-name update is
  last-write-wins, so reprocessing a duplicated service update is harmless. Do not gate it on
  `processed_updates`.

**No special Telegram configuration is needed to receive these.** `forum_topic_created`,
`forum_topic_edited`, and `new_chat_title` are **fields on the `Message` object**, delivered inside
ordinary `message` updates — unlike `chat_member`, they need no `allowed_updates` change and no admin
rights on the bot. (The archive dump confirms they already arrive today.)

## 4. What this deliberately does NOT do

- **No topic-deletion handling.** The Bot API delivers no "topic deleted" update — `forumTopicDeleted`
  exists only in the low-level MTProto/TL schema, not the Bot API the webhook speaks, and `deleteForumTopic`
  is an outbound *method*, not an inbound event. A topic deleted in Telegram leaves a harmless stale
  `threads` row; pruning stale rows is a future admin-UI concern. Do not attempt deletion detection.
- **No closed/open state.** `forum_topic_closed` / `forum_topic_reopened` *do* arrive and could later
  populate an `is_closed` flag, but that is deferred. Not captured here.
- **No General-topic row.** General-topic messages carry **no** `message_thread_id`, and
  `threads.telegram_thread_id` is `NOT NULL`, so General cannot be a registry row. Out of scope; the
  null-thread case is handled by the retention spec, not here. Do **not** invent a sentinel thread id.
- **No name backfill for historical threads.** Unrecoverable without `getForumTopic`; names fill forward.
- **No registration from media-only pre-existing topics (known narrow gap).** Existence rides
  `logMessage` (text messages) + creation/edit events. A topic that (a) pre-existed the bot **and**
  (b) only ever receives captioned media (which the route drops at the `!message.text` filter, so
  `logMessage` isn't called) won't get a row until it sees a text message or a rename. Such a topic also
  produces no `message_log` rows, so nothing downstream depends on it yet. Broadening existence to fire on
  *any* message with a `message_thread_id` (regardless of text) is a larger route change; deferred.
- **No `chat.title` self-heal.** Group name is synced from the explicit `new_chat_title` event only.
  Opportunistically comparing `chat.title` on every message is possible but deferred to keep scope tight.

## 5. Tests (`scripts/test-thread-registry.ts`)

Use the **real archived update shapes** as fixtures.

1. **Existence from an ordinary message.** Ingest a topic message (has `message_thread_id`, no prior
   row) → assert a `threads` row exists for `(group_id, telegram_thread_id)` with `name = NULL`.
2. **Existence is idempotent.** Ingest two messages in the same topic → exactly one row; no duplicate,
   no error.
3. **Creation event sets name + icon.** Ingest a top-level `forum_topic_created`
   (`{ name: "Joe Zolfo", icon_color: 7322096 }`) → row has that name and `icon_color`.
4. **Rename updates name.** After creation, ingest a top-level `forum_topic_edited`
   (`{ name: "Joseph Zolfo" }`) → row `name = "Joseph Zolfo"`; assert `icon_color` unchanged.
5. **Stale reply-to is ignored (the anti-clobber test).** After the rename, ingest an *ordinary* message
   whose `reply_to_message.forum_topic_created.name` still says the **original** "Joe Zolfo" → assert the
   row still reads "Joseph Zolfo" (existence-only write passed null; coalesce preserved the good name;
   the stale echo was never read).
6. **Icon-only edit preserves name.** Ingest `forum_topic_edited` with `icon_custom_emoji_id` set and
   **no** `name` → assert name preserved, icon updated. Then ingest one with `icon_custom_emoji_id: ""`
   → assert it is normalized to null and does not overwrite (documents the accepted cosmetic-lag limit).
7. **Group rename.** Ingest a `new_chat_title` service message → assert `groups.display_name` updated for
   that chat.
8. **General topic is a no-op.** Ingest a message with **no** `message_thread_id` → assert no `threads`
   row is created and no error is thrown.
9. **Service messages reach the branch.** Assert a text-less `forum_topic_created` /
   `forum_topic_edited` / `new_chat_title` is handled (row/name/group updated) and **not** dropped by the
   `!message.text` filter.
10. **Unbound chat is a no-op.** Ingest a topic/service message for a chat with no `groups` row → no
    write, no error, returns ok.

## 6. Handoff notes for Antigravity

- **Two-step build:** (1) additive migration adding `name`, `icon_color`, `icon_custom_emoji_id` to
  `threads` (nullable, comment block, "no RLS change"); (2) the `registerThread` capability + its two
  call sites.
- **`registerThread` is the whole design.** Single idempotent upsert with
  `coalesce(excluded.x, threads.x)` on name/icon; takes an open `tx`; runs under `withTenantContext`.
  Normalize `icon_custom_emoji_id: ""` → NULL in the caller.
- **Call site A (existence):** inside `logMessage`'s existing transaction, when the thread id is non-null,
  call `registerThread` with name/icon omitted. No new round trip.
- **Call site B (names/group):** a **new webhook branch placed after the `edited_message` block and
  before the `if (!message || !message.chat || !message.text)` filter.** Read only **top-level**
  `message.forum_topic_created` / `message.forum_topic_edited` / `message.new_chat_title`; never
  `reply_to_message.*`. Resolve tenant via `resolveEntityIdByChat`; self-contained; returns ok with no
  user-facing output; no `processed_updates` dedup needed (idempotent).
- **Do not touch the `telegram_events` archive block (3b)** or the `edited_message` branch.
- **Reassurance for the implementer:** these three service fields ride ordinary `message` updates — no
  `allowed_updates` change, no bot-admin requirement (contrast `chat_member`). They already arrive today;
  the only reason they're invisible is the `!message.text` filter.
- **Migration filename:** date-prefixed per house convention; ensure it sorts *after*
  `20260701000000_manifest_normalization_additive.sql` (which creates `threads`).

---

*End of SPEC — Thread & Group Registry*