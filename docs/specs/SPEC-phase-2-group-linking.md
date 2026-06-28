# SPEC — Phase 2: `/auth` Group-Linking Flow

> **Reads against:** `docs/V2-PLATFORM-PIVOT.md` + `docs/V2-PLATFORM-PIVOT-ADDENDUM.md`,
> `docs/specs/SPEC-phase-1-management-plane.md`, `docs/SECURITY-PROPOSAL.md`, `DEPLOYMENT.md`
> (Part B/C — the manual `groups` insert this flow replaces).
> **Rigor bar:** match `SPEC-phase-1-management-plane.md` — every new surface gets adversarial tests
> asserting **post-state**, not just "something threw."
> **One-line scope:** let an entity owner/admin **self-service link a Telegram group to their entity**
> via a short-lived claim code, replacing the manual `groups` SQL insert — with a two-factor gate
> (possessing the code proves *entity* control; being a Telegram group admin proves *group* control).

---

## 0. Phase map (where Phase 2 sits)

| Phase | Name | Status |
|---|---|---|
| 1 | Management-plane foundation | ✅ done (merged on `phase-1-management-plane`) |
| **2** | **`/auth` group-linking — THIS SPEC** | scoping |
| 3 | Bot-architecture cutover to (C) | future |
| 4 | Group-scoped context + section-level sensitivity | future |

**Correction to the Phase 1 phase-map line:** Phase 2 was tagged "touches live runtime: reads only."
That is wrong — Phase 2 **writes `groups` rows** (that's the whole point: binding a chat to an
entity). What it does *not* do is modify the existing message-handling logic or the per-slug webhook
routing. So: **new write path (the `/auth` handler creates `groups` bindings); existing runtime
message handling untouched.**

**Forward-compat with Phase 3 is a first-class design constraint.** Today the runtime uses per-entity
bots and per-slug webhooks, so the entity is known from the webhook slug. After the (C) cutover, one
platform bot serves many groups and the entity is **not** known from the webhook — it's determined
*by the code*. The binding logic in this spec is therefore designed to be driven by the **code's
entity**, with the current-architecture slug as a *guard*, so that Phase 3 removes the guard without
touching the binding logic. (See §4.2 `p_expected_entity`.)

---

## 1. Scope

### 1.1 In scope
1. **`mint_link_token` RPC** (web side): an authenticated owner/admin generates a short-lived,
   single-use claim code for one of their entities. Raw code returned once; only a hash is stored.
2. **`consume_link_token` RPC** (bot side): atomically validate + consume a code and **bind the chat
   to the entity** (create/My update the `groups` row). Replay-, expiry-, and race-safe.
3. **Bot-side `/auth <code>` command handler**: the group-admin gate (Telegram `getChatAdministrators`),
   the forum-group precondition, and the call into `consume_link_token`.
4. **Web-side "Connect a Telegram group" UI** on the entity page: a button that mints a code and shows
   the user exactly what to run in their group, with the TTL.
5. **`/auth` registered** in `lib/commands.ts` + the command menu (`setMyCommands`).
6. Additive `link_tokens` **audit columns** (§3).

### 1.2 Out of scope (deferred to named phases / unchanged)
- **Bot-architecture cutover, platform bot, per-slug→single-webhook** — Phase 3. Phase 2 runs against
  the *current* per-entity bots.
- **Group-scoped context** — Phase 4. Linking a group does **not** yet scope its knowledge.
- **Deep-link / `startgroup` UX** (auto-add bot + pass token via `https://t.me/<bot>?startgroup=…`) —
  a Phase 3+ enhancement (it's cleanest once there's one platform bot to add). v1 is the typed code.
- **Unlinking / re-assigning an existing group** via the UI — operator-SQL stopgap for now (a `groups`
  delete/update). Only *create* is self-service in Phase 2.
- **Public self-service signup** — gated at the Supabase layer (signups off; see §2). Phase 2 builds
  no access-control machinery.
- **Usage tracking / billing / per-tenant spend limits** — future monetization phase.
- The **manual `groups` SQL insert** (DEPLOYMENT.md Part B/C) is **not removed** — `/auth` is the
  self-service alternative; both coexist.

### 1.3 Invariants
- Existing **message-handling runtime is unmodified** — `/auth` is a *new* command branch; it does not
  change how `/ask`, `@mention`, `/recap`, etc. are processed.
- The **runtime `groups` RLS and the runtime bootstrap functions are not modified.** The new write goes
  through a `SECURITY DEFINER` RPC that satisfies the existing `groups` RLS (see §4.2 — the
  force-RLS interaction is the subtle part).
- **Raw claim codes are never stored** — only a hash at rest. The raw code exists transiently in the
  mint response and in the user's `/auth` message.
- `link_tokens` stays **default-deny at the table** (no direct RLS policies); the only access paths are
  the two authorization-checked `SECURITY DEFINER` RPCs.

---

## 2. Preconditions & gating decisions

**Preconditions:**
- Phase 1 merged: `profiles`, `authorizations`, the `is_entity_owner` / `has_active_auth` helpers, and
  the dormant `link_tokens` table all exist.
- **Supabase "allow new signups" is OFF** (operator access gate). Phase 2 assumes only allowlisted
  owners exist; it does not re-implement this.

**Gating decisions (recommended — confirm or override before build):**
1. **Code delivery = typed `/auth <code>`** (not deep-link). Works identically pre- and post-(C);
   deep-link deferred (§1.2).
2. **TTL = 10 minutes**, single-use. Long enough to switch apps and paste; short enough to bound the
   replay window. *(Brief floated 2–5 min; 10 is the friendlier default. Confirm.)*
3. **Code format = 10-char Crockford base32** (no ambiguous `0/O/1/I/L`), ~50 bits, server-generated,
   SHA-256-hashed at rest. Single-use + short TTL + the group-admin gate make online guessing a
   non-threat. *(Confirm length.)*
4. **Re-bind policy:** binding a chat already linked to the **same** entity → idempotent success
   (refresh `display_name`). Binding a chat linked to a **different** entity → **reject** (no silent
   takeover); the token is **not** consumed on rejection. *(Confirm.)*
5. **Forum-group precondition enforced at link time:** `/auth` rejects a non-forum group (the
   per-topic context model requires Topics). Catches the DEPLOYMENT.md B1a footgun at bind time.
6. **"List linked groups" in the web UI = included** (promoted from secondary). It's how the operator
   *verifies this phase* — seeing "<group> — linked just now" right after `/auth` is the visual proof
   the binding worked end-to-end. Read-only, via a `SECURITY DEFINER` function that checks
   owner/admin and does **not** modify the runtime `groups` RLS (§6).

---

## 3. Data model (additive only)

No new tables. `link_tokens` (created dormant in Phase 1) gets **additive audit columns**:

```sql
alter table public.link_tokens
  add column consumed_chat_id      bigint,   -- the Telegram chat this code bound (audit)
  add column consumed_by_tg_user_id bigint;  -- the Telegram user who ran /auth (audit)
```

Recap of the existing `link_tokens` shape (Phase 1): `id, token_hash (unique), issued_by, entity_id,
expires_at, consumed_at, created_at`. Phase 2 uses all of it; the two columns above are for audit/debug
only.

> **Verify:** `groups.telegram_chat_id` has a **unique constraint** (the consume upsert relies on
> `on conflict (telegram_chat_id)`, and chat→group must be 1:1 for runtime resolution anyway). If it
> isn't unique, Phase 2 adds the constraint (additive). Confirm against the init schema.

---

## 4. The two RPCs

Both are `SECURITY DEFINER`, `set search_path = ''`, fully schema-qualified — same discipline as the
Phase 1 functions. Both perform their **own authorization check** internally and do not trust the
caller.

### 4.1 `mint_link_token(p_entity uuid) returns text` — web side

- **Caller:** the authenticated web user (anon key + JWT).
- **Authz:** raise unless `public.is_entity_owner(p_entity)` **or**
  `public.has_active_auth(p_entity, 'admin')`. (Owner or admin may mint; editor/viewer may not.)
- **Body:** generate a random 10-char Crockford-base32 code; compute `token_hash = sha256(code)`;
  insert `link_tokens (entity_id, token_hash, issued_by, expires_at)` with
  `issued_by = auth.uid()`, `expires_at = now() + interval '10 minutes'`; **return the raw code**.
- The raw code is returned to the caller **once** and never stored. `EXECUTE` granted to
  `authenticated`.

### 4.2 `consume_link_token(p_code text, p_expected_entity uuid, p_chat_id bigint, p_tg_user_id bigint, p_chat_title text, p_is_forum boolean) returns uuid` — bot side

- **Caller:** the bot runtime (`bot_service`). `EXECUTE` granted to `bot_service`; this is the **only**
  `link_tokens` privilege `bot_service` gets.
- **Returns:** the bound `entity_id` on success; raises a typed exception on each failure mode (so the
  handler can map to a user-facing message).
- **Body (all atomic, one transaction):**
  1. **Forum gate:** if `p_is_forum` is false → raise `not_forum`. (Belt to the handler's own check.)
  2. `select … from public.link_tokens where token_hash = sha256(p_code) **for update**` — lock the
     row. If none → raise `invalid_code`.
  3. If `consumed_at is not null` → raise `already_consumed` (replay).
  4. If `expires_at <= now()` → raise `expired`.
  5. **Entity guard (the Phase-3-forward-compat seam):** if `p_expected_entity is not null` **and**
     `token.entity_id <> p_expected_entity` → raise `entity_mismatch`. *(Current architecture passes
     the slug's entity here, enforcing "you can only bind a group to the entity whose bot is in it."
     Phase 3 passes `null` — one platform bot, the code's entity is authoritative — and this guard
     becomes a no-op. **No binding-logic change at cutover.**)*
  6. **Re-bind policy:** look up `groups` by `p_chat_id`. If it exists and its `entity_id <>
     token.entity_id` → raise `chat_bound_elsewhere` (**do not consume**, do not bind). If it exists
     and matches → proceed (idempotent refresh). If absent → proceed (create).
  7. **Bind:** upsert the `groups` row (`telegram_chat_id = p_chat_id`, `entity_id =
     token.entity_id`, `display_name = p_chat_title`). **Because `groups` is force-RLS'd, the definer
     (owner) is still subject to RLS** — so the function must set the entity context transaction-locally
     before the write: `perform set_config('app.current_entity_id', token.entity_id::text, true)` so the
     upsert satisfies the runtime `groups` policy (`entity_id = app.current_entity_id`). This is the
     subtle interaction; see §8 test C.
  8. **Consume:** set `consumed_at = now()`, `consumed_chat_id = p_chat_id`,
     `consumed_by_tg_user_id = p_tg_user_id`.
  9. Return `token.entity_id`.

> **Why consume + bind in one function:** the two must be atomic — a code consumed without a binding
> (or a binding without consuming the code) is a bug. One transaction, one lock, one outcome.

---

## 5. Bot-side `/auth` handler flow

Added as a **new command branch** in the existing webhook handler. Runs in the current per-entity-bot
architecture: the update arrives at `/api/webhooks/telegram/{slug}`, so the **receiving entity (X)** is
known from the slug, and the **bot token** for Telegram API calls is X's (the same token the handler
already uses to reply).

> **`/auth` is consume-only — minting is console-first.** A user must already hold a code, which is
> generated in the dashboard (§6). This ordering is a *security property*, not just UX: the pre-minted
> code is the proof that the person linking the group also controls the entity. There is no
> code-less linking path.

0. **React with 👀** on receipt of any `/auth` message (acknowledge, consistent with `/ask`), before
   processing.
1. **Bare `/auth` (no code):** reply with a short **informational** message — what `/auth` does, plus
   where to get a code. **Not admin-gated** (it leaks nothing; gating it would just confuse a
   non-admin). URL is **env-driven** (read the same base URL the app uses, e.g. `NEXT_PUBLIC_APP_URL`
   → `app.leguan.ai`) — **no hardcoded domain, and no entity-specific deep link** (the person may not
   be logged in or authorized, and the bare URL is the Phase-3-forward-compatible choice since the
   platform bot won't know the entity). Example: *"To link this group, generate a one-time code in the
   dashboard, then send `/auth <code>` here. Get a code at app.leguan.ai — only a group admin can
   complete linking."* Stop.
2. Resolve receiving entity **X** from the slug (current path; unchanged).
3. **Group-admin gate:** call Telegram `getChatAdministrators(chat_id)` (or `getChatMember`) with X's
   bot token; confirm `message.from.id` is an `administrator` or `creator`. If not → reply
   *"Only a group admin can link this group."*, stop. **Do not call consume.**
4. **Forum check:** from the update's `chat.is_forum` (and/or the admin-call result), confirm the chat
   is a forum/Topics group. If not → reply the Topics-required message, stop.
5. Call `consume_link_token(code, p_expected_entity = X, chat_id, from.id, chat.title, chat.is_forum)`.
6. Map the result:
   - success (returns entity id) → reply naming the entity: *"✅ This group is now linked to **<entity
     display name>**."* (resolve the display name from the returned entity id).
   - `invalid_code` / `expired` → *"That link code is invalid or expired. Generate a new one in the
     dashboard."*
   - `already_consumed` → *"That code was already used. Generate a new one."*
   - `entity_mismatch` → *"That code is for a different workspace's bot."* (current-arch guard)
   - `chat_bound_elsewhere` → *"This group is already linked to another workspace. Unlink it first."*
   - `not_forum` → the Topics-required message.

**Notes:**
- `/auth` is processed **regardless of the excluded-thread gate** (it's a management command; mirror
  how `/whoami` is handled). Place its branch before/independent of the exclusion gate.
- The admin check happens **before** consume, so a non-admin running a leaked code does **not** burn
  it — it survives for the real admin. (Probing a code without admin rights achieves nothing.)
- Never echo the code back in replies or logs.

---

## 6. Web-side UI (entity page)

On the entity detail page, a **"Connect a Telegram group"** panel (owner/admin only — gate the control
on the same role check the page already uses):

1. **"Generate link code"** button → calls `mint_link_token(entityId)` → displays the returned raw
   code prominently with instructions: *"In your Telegram group, send `/auth <code>` — expires in 10
   minutes."*
2. **Tap-to-copy** on the code element:
   - The **whole code box is the tap target** (large area — most users mint on the phone they'll paste
     into Telegram on). A small copy icon in the corner signals it's tappable (discoverability) while
     the whole box is clickable.
   - On tap → copy the **full `/auth <code>` command string** (not the bare code), so the user can
     paste-and-send in Telegram with no manual typing of `/auth ` (which reintroduces the typo risk
     tap-to-copy removes). The display still *shows* the code legibly.
   - On **successful** copy → transient "Copied" toast near the tap point, auto-dismiss ~1.5s. Fire
     the toast **only on success** — never a silent no-op that claims "Copied" when nothing was.
   - `navigator.clipboard.writeText` needs a secure context (HTTPS / localhost — both satisfied). If
     it's ever blocked, the code remains visible to select manually (graceful fallback, no false
     toast).
3. The code is shown **once** (not retrievable later — only the hash is stored). Re-generating makes a
   new code; old un-consumed codes simply expire.
4. **Linked groups list (included — §2.6):** show the entity's currently-linked groups (display name +
   when linked) via a read-only `SECURITY DEFINER` function `list_entity_groups(p_entity)` that checks
   `is_entity_owner`/`has_active_auth` and returns `groups` rows **only for entities the caller
   owns/admins** — **without** adding a management policy to the runtime `groups` table. This is the
   operator's end-to-end verification surface for the phase.

No raw codes, tokens, or secrets ever rendered beyond the one-time mint code.

---

## 7. RLS / authorization

- **`link_tokens` stays default-deny** (no direct policies, as set in Phase 1). All access is via the
  two RPCs.
- `mint_link_token`: `EXECUTE` to `authenticated` (internal owner/admin check).
- `consume_link_token`: `EXECUTE` to `bot_service` (and **not** to `authenticated`/`anon`).
- `list_entity_groups` (if included): `EXECUTE` to `authenticated` (internal owner/admin check).
- No change to `groups` RLS, no change to runtime bootstrap functions, no change to the Phase 1
  policies.
- `issued_by` is set to `auth.uid()` inside `mint_link_token` (server-set, not caller-supplied);
  `consumed_*` set inside `consume_link_token`.

---

## 8. Adversarial test cases (definition of "secure enough to ship")

Same harness style as Phase 1 (`scripts/test-…rls.ts`): set up via privileged client, exercise via the
real role, assert **post-state**. Telegram API calls (`getChatAdministrators`) are **mocked** at the
boundary (see Phase 1 test-10 lesson — mock the SDK/call, not `fetch`).

**Minting / authorization**
1. A **viewer/editor** (not owner/admin) calling `mint_link_token` for an entity → raises; **no**
   `link_tokens` row created (post-state count = 0).
2. A user calling `mint_link_token` for an entity they have **no** authorization on → raises; no row.
3. `issued_by` on the created token equals the caller's `auth.uid()` regardless of anything supplied.

**Replay / expiry / race (the core)**
4. **Replay:** consume a valid code once (success); consume the **same** code again → `already_consumed`;
   post-state: still exactly **one** `groups` row, token `consumed_at` unchanged.
5. **Expiry:** a token past `expires_at` → `expired`; no `groups` row created.
6. **Race:** two concurrent `consume_link_token` calls with the same code → exactly **one** succeeds,
   the other raises; exactly one `groups` binding results (the `for update` lock holds).
7. **Forgery/guess:** a random/non-existent code → `invalid_code`; no row. (Codes are hashed at rest —
   confirm the table stores only `token_hash`, never the raw code: assert no column contains the raw
   value.)

**The two-factor gate**
8. **Non-admin:** a Telegram user who is **not** a group admin runs `/auth <valid code>` → handler
   rejects at the admin gate; `consume_link_token` is **never called**; token remains **unconsumed**
   (post-state: `consumed_at` is null) and no `groups` row created.
9. **Admin without code:** a group admin with no valid code cannot bind (no code → nothing to consume).
   (Covered by 7; assert the binding requires a live token.)

**Entity / cross-binding guards**
10. **Entity mismatch (current arch):** a code minted for entity **Y** consumed with
    `p_expected_entity = X` (X ≠ Y) → `entity_mismatch`; **not consumed**; no binding.
11. **Phase-3 forward-compat:** the **same** code with `p_expected_entity = null` → binds to **Y**
    (the code's entity), proving the guard is the only thing gating cross-entity and that Phase 3
    (null guard) works. *(This test documents the cutover behavior; it must pass now.)*
12. **Takeover prevention:** a chat already bound to entity **A**, then `/auth <code-for-B>` →
    `chat_bound_elsewhere`; **B's token not consumed**; the `groups` row still points at **A**
    (assert `entity_id = A`).

**Binding correctness**
13. **Happy path:** valid code + admin + forum group → `groups` row created with the **token's**
    entity_id and the chat title; token consumed with `consumed_chat_id`/`consumed_by_tg_user_id` set.
14. **Forum gate:** a non-forum chat → `not_forum`; no binding.
15. **RLS-satisfied write (the subtle one):** confirm the `groups` upsert inside the definer function
    succeeds **despite `groups` being force-RLS'd** — i.e. the function correctly sets
    `app.current_entity_id` to the bound entity before writing, and the written row's `entity_id`
    equals that value. (Assert a binding is actually created, not silently filtered to zero rows.)

**Runtime isolation (regression)**
16. The new command branch does not alter existing handling: `/ask`/`@mention`/`/recap` against a
    seeded entity still work (golden-path regression), and `bot_service` still has **no** privilege on
    `link_tokens` except `EXECUTE` on `consume_link_token` (no direct table access).

---

## 9. Acceptance criteria (Definition of Done)

- [ ] Additive `link_tokens` audit columns migrated; `groups.telegram_chat_id` uniqueness confirmed.
- [ ] `mint_link_token` / `consume_link_token` (and `list_entity_groups` if included) created,
      `SECURITY DEFINER`, `search_path=''`, with correct `EXECUTE` grants and internal authz.
- [ ] `/auth` handler branch added; admin gate + forum gate + consume wired; `/auth` in
      `lib/commands.ts` and pushed via `setMyCommands`.
- [ ] Web "Connect a group" panel mints + displays a code (owner/admin only).
- [ ] All §8 tests pass against a live DB with no recursion / no force-RLS write failure.
- [ ] **Invariants §1.3 verified:** runtime message handling unchanged; runtime `groups` RLS and
      bootstrap functions unmodified; `link_tokens` default-deny intact; raw codes never stored.
- [ ] End-to-end on a real Telegram group: mint in dashboard → `/auth <code>` as a group admin →
      group binds → a subsequent `/ask` answers (proving the binding feeds the runtime).

---

## 10. Handoff notes for Antigravity

- **Do not modify** the runtime message-handling path, the runtime `groups` RLS, or the runtime
  bootstrap `SECURITY DEFINER` functions. `/auth` is an **additive** command branch + two new RPCs.
- **Forward-compat is mandatory:** the binding is driven by the **token's** entity; `p_expected_entity`
  is the *only* thing tying it to the current per-slug architecture, and it must be **nullable** so
  Phase 3 passes `null` with no other change. Do not hardcode the slug's entity as the binding source.
- **The force-RLS-on-`groups` interaction (§4.2 step 7 / §8 test 15) is the most likely silent
  failure.** A definer function owned by `postgres` does **not** bypass a force-RLS'd table — set
  `app.current_entity_id` (transaction-local) to the bound entity before the `groups` upsert, or the
  write is filtered to zero rows and the bind silently no-ops. Write test 15 first.
- **Atomicity:** consume + bind in one transaction with `for update` on the token row. A consumed token
  with no binding, or a binding with an unconsumed token, is a bug.
- **Never** log or echo raw codes. Store only `sha256(code)`.
- Mock Telegram `getChatAdministrators` at the call boundary in tests (not `fetch`) — see the Phase 1
  test-10 lesson.
- Adversarial review by the operator follows; write the §8 tests as you build.
