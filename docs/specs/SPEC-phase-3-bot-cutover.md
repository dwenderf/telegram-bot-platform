# SPEC — Phase 3: Bot-Architecture Cutover to the Platform-Bot Model (C)

> **Reads against:** `docs/V2-PLATFORM-PIVOT.md` + `-ADDENDUM.md`, `SPEC-phase-1-management-plane.md`,
> `SPEC-phase-2-group-linking.md`, `supabase/migrations/20260618000000_init_schema.sql` (runtime RLS +
> the THREE security-definer bypass functions), `20260626000000_management_plane_foundation.sql`
> (`bots`/`bot_entities`), the webhook handler `app/api/webhooks/telegram/[entitySlug]/route.ts`,
> `DEPLOYMENT.md` Part A (rewrite target).
> **Rigor bar:** match Phases 1–2 — every new surface gets adversarial tests asserting **post-state**.
> The new RLS-bypass function gets the same scrutiny the original three got.
> **One-line scope:** retire the per-entity bots; one **platform bot** serves all entities; entity is
> resolved from the **group (chat_id)**, not the URL slug; bot identity/secrets move from `entities`
> to `bots`; `/ask` is dropped in favor of **@-mention**.

> ⚠️ **This phase modifies live runtime behavior, but is now fully REVERSIBLE.** The one irreversible
> step (dropping the `entities` bot columns) has been **split out into a deferred Phase 3.1** (§9) so
> Phase 3 itself can always be rolled back: flip the retired bots active, re-point webhooks, done. Take
> the snapshot anyway (§0) — cheap insurance — but nothing in Phase 3 is un-undoable.

---

## 0. Pre-step: DB snapshot + irreversibility map

### 0.1 Mandatory pre-step (before ANY Phase 3 migration runs)
Take a **database snapshot / backup** of the live project (`eomnjhbjrkfcpzzbcdho`). On Supabase: a PITR
restore point or a manual backup. This is the cheap insurance for the irreversible steps below — the
risk in this phase is "can't get back," not "downtime." David is OK with downtime; this protects
against the *other* kind.

### 0.2 Irreversibility map (what can and cannot be undone)

| Step | Reversible? | Mitigation |
|---|---|---|
| Add `bots.slug`, new RLS-bypass fn, new route | ✅ additive | none needed |
| Re-point webhooks to the platform bot (`setWebhook`) | ✅ re-register old | keep old bot tokens |
| **Retire** old bots (`status='retired'`) | ✅ flip flag back | retire-in-place, don't delete |
| Set `p_expected_entity → null` at call site | ✅ code revert | branch |
| **DROP** `entities.telegram_bot_token_id`, `telegram_webhook_secret_id`, `telegram_bot_username` | ❌ **irreversible** | **SPLIT OUT to Phase 3.1 (§9)** — not in Phase 3 |
| **DELETE** old bots' Vault secrets | ❌ **irreversible** | **DEFERRED — Phase 3.1 (§9)** |

**Principle:** Phase 3 contains **only reversible steps**. The two irreversible steps (column drop,
Vault-secret deletion) are split into **Phase 3.1**, run only after the platform bot has proven itself
in production. So Phase 3 can be fully unwound (un-retire bots, re-point webhooks) at any point, and
the `entities` bot columns remain intact as the rollback safety net until you choose to drop them.

---

## 1. Scope

### 1.1 In scope
1. **`bots.slug`** (unique) added; the platform bot row created with a stable slug.
2. **New per-bot webhook route** `app/api/webhooks/platform/[botSlug]/route.ts` (the current
   `[entitySlug]` route is retired). One bot today; the path resolves the bot.
3. **New RLS-bypass function `get_current_bot_secret`** (the FOURTH bypass fn — see §4, security-
   reviewed) + a bot bootstrap resolver `resolve_bot_id_by_slug`, scoping Vault access to the current
   **bot** (`app.current_bot_id`) the way `get_current_entity_secret` scopes to the current entity.
4. **Resolution flip:** entry point becomes `botSlug → bot` (token/secret/username) → validate webhook
   secret → `chat_id → groups → entity` → load entity knowledge base. Slug-as-entity-entry is gone.
5. **Per-bot token/secret refactor:** every Telegram API call (`sendMessage`, `setMessageReaction`,
   `sendChatAction`, `sendDocument`, `getChatMember`) uses the **platform bot's** token; the webhook-
   secret check uses the **platform bot's** secret. (~15 call sites in the handler.)
6. **`entities` decoupling (logical, not physical in Phase 3):** the telegram bot columns
   (`telegram_bot_token_id`, `telegram_webhook_secret_id`, `telegram_bot_username`) become **dead/unused**
   — the runtime stops reading them — but they are **NOT dropped in Phase 3** (the drop is Phase 3.1,
   §9). **Keep** `github_owner/repo/branch/context_root/github_token_id` permanently (GitHub sync stays
   per-entity). `get_current_entity_secret` is **left unchanged in Phase 3** (it still references the
   telegram columns harmlessly, since they still exist); it's modified in Phase 3.1 alongside the drop.
7. **Trigger-model change:** drop `/ask`; the bot answers on **@-mention** (username resolved
   dynamically from the platform bot, not per-entity). Keep `/whoami`, `/help`, `/context`, `/recap`,
   `/auth`.
8. **`consume_link_token` call site:** pass `p_expected_entity = null` (Phase 2 test 9 proved this;
   the platform bot has no single entity — the code is authoritative).
9. **Retire-in-place** the two old per-entity bots (`status='retired'`); keep their rows + Vault
   secrets through the cutover (rollback safety).
10. **Command re-registration** on the platform bot via `setMyCommands` / `scripts/sync-commands.ts`
    (now omitting `/ask`).
11. **DEPLOYMENT.md Part A rewrite:** platform-bot creation (BotFather, manual) moves into one-time
    platform setup; per-entity bot creation (old Part B) is removed; single webhook `setWebhook` to
    `api.kenntnis.ai/api/webhooks/platform/<bot-slug>`.

### 1.2 Out of scope / deferred (named)
- **Reply-to-bot triggering** — deferred (Phase 3.5/4). Intended semantics when built: any reply to a
  platform-bot message = an expected answer, no @-mention needed. (Simpler post-cutover: only one bot
  exists, so "is this a reply to me" has one bot id to match.)
- **Group-scoped context / section-level sensitivity** — Phase 4.
- **Deleting the retired bots' Vault secrets** — deferred cleanup (§9), not this phase.
- **Multi-bot / purpose-bots / bot store** — NOT built. But the data model + routing are made
  multi-bot-*ready* (per-bot slug, per-bot secrets, `bots.persona/model/capabilities` stubs as the
  registered-backend seam). See §8.
- **Per-tenant usage metering / billing** — future monetization phase.

### 1.3 Invariants
- **GitHub sync path is untouched** — `resolve_entity_id_by_repo`, `github_token_id`, and
  `get_current_entity_secret`'s github branch all keep working. Only the *telegram* bot refs leave
  `entities`.
- **Runtime RLS model unchanged** — the per-entity `app.current_entity_id` isolation on
  `groups`/`message_log`/etc. stays exactly as-is. Phase 3 adds a *bot* context
  (`app.current_bot_id`) for secret scoping; it does not change entity isolation.
- **The "exactly N security-definer bypass functions" invariant is updated deliberately** — the init
  schema declares THREE and says none may be added without security review. Phase 3 adds
  `get_current_bot_secret` (+ `resolve_bot_id_by_slug`, a non-secret resolver like the existing slug
  resolver). This is that security review; the count and rationale must be updated in the schema's
  invariant comment.

---

## 2. The resolution flip (structural heart)

**Today** (`[entitySlug]/route.ts`):
`resolve_entity_id_by_slug(slug)` → entity (incl. its bot token/secret/username) → validate secret →
`resolveTenant(entity.id, chat.id)` → group.

**After** (`platform/[botSlug]/route.ts`):
1. `resolve_bot_id_by_slug(botSlug)` → bot id. Unknown → 404.
2. Set `app.current_bot_id`; load the bot's `telegram_username`, and via `get_current_bot_secret`,
   its `token_secret_ref` (bot token) and `webhook_secret_ref` (webhook secret).
3. **Validate webhook secret** (`x-telegram-bot-api-secret-token` == platform bot's secret). This
   gates everything and happens **before** any entity context exists — so it depends only on bot
   resolution. Forged calls rejected here.
4. Resolve the **entity from the chat**: `chat_id → groups → entity_id` (a new
   `resolve_entity_id_by_chat(chat_id)` bootstrap, SECURITY DEFINER, mirrors the slug resolver). No
   group bound → "untracked group" bail (same as today, except `/auth` and `/whoami` still run first —
   see §3).
5. Set `app.current_entity_id` = resolved entity; proceed exactly as today (context, RLS, answer)
   — but all Telegram calls use the **bot** token from step 2, not an entity token.

> **The `/auth` consume now passes `p_expected_entity = null`.** Pre-cutover, the slug's entity was
> the guard; post-cutover the platform bot serves all entities, so the code is authoritative. The
> binding logic is unchanged (Phase 2 test 9). This is the seam paying off.

---

## 3. Handler ordering under the new model

The current handler runs `/whoami` and `/auth` **above** the untracked-group bail-out (so onboarding
works before a group is bound). Preserve that: in the new model, a freshly-added platform bot in an
unbound group must still answer `/auth` (to bind) and `/whoami` (to read chat id). So:

1. Resolve bot, validate webhook secret.
2. Parse message; compute triggers. **`isMention`** uses the **platform** bot username (from the bot
   row). **Drop `isAskCommand`** — the answer path (current §8) keys on `isBotMention` alone.
3. `/whoami` (diagnostic; works unbound) — report chat id, resolved entity/group if bound, excluded
   status.
4. `/auth` (binds the group; works unbound; `getChatMember` + forum gate + `consume_link_token(...,
   p_expected_entity => null, ...)`).
5. Resolve entity from chat (`resolve_entity_id_by_chat`). Unbound → bail.
6. Excluded-thread gate (single choke point — unchanged; **kept, default-permissive**: empty
   `excluded_thread_ids` = process all). @-mention flows through it exactly as today.
7. `/help`, `/context`, `/recap`, and the **@-mention answer path** (was `/ask || mention`, now just
   mention).

> **Privacy note (verified against current code):** the excluded-thread gate already sits above the
> @-mention path, so dropping `/ask` does **not** change excluded-topic behavior — @-mention in an
> excluded topic is already declined today. No privacy delta.

---

## 4. New security-definer function `get_current_bot_secret` (THE security-review item)

Mirrors `get_current_entity_secret`, but scopes to the **bot** and resolves a **text** ref (the
`bots.*_secret_ref` columns are `text`, not `uuid` FKs — do not copy the uuid shape).

```
get_current_bot_secret(p_secret_ref text) returns text
  -- SECURITY DEFINER, search_path = public, vault
  -- returns the decrypted secret ONLY if p_secret_ref is referenced by the bot
  -- identified by app.current_bot_id (token_secret_ref or webhook_secret_ref).
```

- It must **not** allow reading arbitrary Vault secrets — the `exists` self-check against
  `bots.token_secret_ref/webhook_secret_ref` for `app.current_bot_id` is the control (exactly as
  `get_current_entity_secret` self-checks against entity columns).
- `bots.*_secret_ref` are **text Vault references** — confirm the lookup matches how the Phase 1
  backfill stored them (it stored `telegram_bot_token_id::text` — i.e. the Vault secret **uuid as
  text**). So resolution is likely `vault.decrypted_secrets where id = p_secret_ref::uuid` *and* the
  bot self-check. **Confirm the ref format against a real `bots` row before finalizing.**
- `resolve_bot_id_by_slug(text) returns uuid` and `resolve_entity_id_by_chat(bigint) returns uuid` are
  non-secret resolvers (like `resolve_entity_id_by_slug`), SECURITY DEFINER, granted to `bot_service`.
- **Grants:** `get_current_bot_secret`, `resolve_bot_id_by_slug`, `resolve_entity_id_by_chat` →
  EXECUTE to `bot_service`.
- **Update the init-schema invariant comment**: there are now FOUR bypass functions; document why.

---

## 5. Migration(s)

**Additive migration (the ONLY Phase 3 migration — fully reversible):**
- `alter table public.bots add column slug text unique;`
- Insert the platform bot row (operator step with real token/secret refs after BotFather — §7). Set the
  two old bots `status='retired'`.
- `resolve_bot_id_by_slug`, `resolve_entity_id_by_chat`, `get_current_bot_secret` (+ grants, + invariant
  comment update: THREE → FOUR bypass functions).

`get_current_entity_secret` is **untouched in Phase 3** — it keeps referencing the (still-present)
telegram columns harmlessly. It's modified only in Phase 3.1, in lockstep with the column drop.

> There is **no destructive migration in Phase 3.** The drop + function modification are Phase 3.1
> (§9), gated behind explicit operator action in `supabase/manual/` and run only after production
> confidence.

---

## 6. Files

- **[NEW]** `app/api/webhooks/platform/[botSlug]/route.ts` — the platform handler (adapted from the
  current entity handler; resolution flip + per-bot token/secret + `/ask` removed + mention via
  platform username + `consume_link_token(null)`).
- **[DELETE]** `app/api/webhooks/telegram/[entitySlug]/route.ts` — retired and **deleted** (David
  confirmed delete is acceptable; he's fine with a stray old webhook 404ing). No 410 stub.
- **[MODIFY]** `lib/capabilities.ts` — bot resolution + `get_current_bot_secret` wrapper; entity-by-chat
  resolution; `consumeLinkToken` call passes null expected-entity.
- **[MODIFY]** `lib/commands.ts` — remove `/ask` from `BOT_COMMANDS`.
- **[MODIFY]** `lib/supabase.ts` / context helpers — add `withBotContext` (sets `app.current_bot_id`)
  alongside `withTenantContext`.
- **[NEW]** `supabase/migrations/<ts>_bot_cutover_additive.sql` (the only Phase 3 migration). The
  Phase 3.1 drop is a separate `supabase/manual/phase3_1_drop_entity_bot_columns.sql` (§9).
- **[MODIFY]** `DEPLOYMENT.md` Part A (platform-bot creation + single webhook) — surgical, per the
  corruption-prone-file discipline.
- **[NEW]** `scripts/test-bot-cutover.ts` — adversarial suite (§ below).

---

## 7. Operator runbook (the cutover sequence — reversible-first)

1. **Snapshot the DB** (§0).
2. **BotFather:** create the platform bot; capture token + username; generate a webhook secret. (Plus
   a test bot.) — new DEPLOYMENT.md Part A step.
3. Store the platform bot's token + webhook secret in **Vault**; insert the `bots` row with `slug`,
   `telegram_username`, `token_secret_ref`, `webhook_secret_ref`, `status='active'`.
4. Apply the **additive** migration (`bots.slug`, resolvers, `get_current_bot_secret`).
5. Deploy the new `platform/[botSlug]` route.
6. `setWebhook` → `https://api.kenntnis.ai/api/webhooks/platform/<bot-slug>` with the secret.
7. **Add the platform bot to each existing group; remove the old per-entity bot.** Re-bind each group
   with `/auth` if needed (groups already in `groups` keep their `chat_id→entity` mapping, so binding
   persists — verify with `/whoami`).
8. **Verify** end-to-end: @-mention answers, `/context`/`/recap`/`/whoami`/`/auth` work, correct
   entity resolves per group.
9. Set `status='retired'` on the two old bots; `setMyCommands` on the platform bot (no `/ask`).
10. **Stop here for Phase 3.** The runtime now fully runs on the platform bot; the old `entities`
    telegram columns sit unused as a rollback net. Run on this model in production until confident.

### Phase 3.1 (deferred, separate — the irreversible cleanup)
11. Run the **manual** drop migration: `alter table public.entities drop column ...` the three telegram
    columns, **and** modify `get_current_entity_secret` to drop their refs (keep `github_token_id`) — in
    the same migration, function-update first so it never references dropped columns.
12. Delete the retired bots' Vault secrets.
13. Update the invariant/docs to reflect the final shape.

---

## 8. Forward-compat seams (captured, NOT built)

- **`bots.persona / model / capabilities`** are the **registered-backend seam** for a future bot store:
  "which model/persona/provider answers" becomes a per-bot (eventually per-invocation) lookup, not a
  global constant. Phase 3 resolves them to the single platform bot's defaults, but the *resolution
  path* should read them rather than hardcode, so the marketplace is "add rows," not "re-architect."
- **Per-bot routing is native** (slug + secret per bot) — N bots = N rows + N `setWebhook`s, no routing
  rewrite. @-mention is the natural addressing mechanism in a multi-bot group (it's inherently
  bot-specific), which is why the trigger-model change is forward-compatible.
- **OPEN QUESTION (logged, not decided):** command namespace in a multi-bot/bot-store world — separate
  bots with overlapping commands (Telegram `@bot` disambiguation), vs. one verb + bot-as-argument, vs.
  one platform bot dispatching to registered backends. Decide when the bot store is actually scoped.

---

## 9. Phase 3.1 — deferred irreversible cleanup (explicitly NOT Phase 3)

Run only after the platform bot has proven itself in production. Each step is irreversible; none is
urgent (the dead columns/secrets cost nothing to keep, and they ARE the Phase 3 rollback net).

- **Drop** `entities.telegram_bot_token_id`, `telegram_webhook_secret_id`, `telegram_bot_username`
  (manual migration, `supabase/manual/`). In the same migration, **modify `get_current_entity_secret`**
  to remove the two telegram refs from its `exists` check (keep `github_token_id`) — function-update
  first, then drop, so it never references a dropped column.
- **Delete** the retired bots' Vault secrets (`token_secret_ref`/`webhook_secret_ref` of the two old
  bots).
- Until this runs, Phase 3 is fully reversible: un-retire a bot, re-point its webhook, and the old
  per-entity path works again because its columns + secrets still exist.

---

## 10. Adversarial test cases (`scripts/test-bot-cutover.ts`)

Same harness style; real roles; assert post-state. Mock Telegram at the call boundary.

**Bot-secret scoping (the new security surface — highest priority)**
1. `get_current_bot_secret` returns the secret when `app.current_bot_id` is the owning bot and the ref
   matches.
2. **Negative:** with `app.current_bot_id = bot A`, requesting bot B's `*_secret_ref` returns NULL/empty
   (no cross-bot Vault read). This is the analogue of the entity-secret self-check; it's the control
   that stops one bot reading another's token.
3. `bot_service` has EXECUTE on the three new functions; an `authenticated`/`anon` caller does not (if
   applicable — they're bot-path functions).

**Resolution flip**
4. `resolve_bot_id_by_slug` maps the platform slug → bot id; unknown slug → null (404 path).
5. `resolve_entity_id_by_chat` maps a bound chat → the correct entity; unbound chat → null (untracked
   bail).
6. **Cross-entity correctness:** two groups bound to two different entities, same platform bot — a
   message in group-of-E1 resolves entity E1; in group-of-E2 resolves E2. (Proves the platform bot
   serves multiple entities correctly — the whole point of (C).)

**Webhook-secret gate**
7. A request with a wrong/missing `x-telegram-bot-api-secret-token` for the platform bot → 401, no
   processing. (Forgery rejected at the bot layer, before entity context.)

**Trigger model**
8. `/ask` is gone: a `/ask …` message is **not** treated as a question (no answer path triggered) — it
   falls through (or is treated as unknown). @-mention with the platform username **does** trigger the
   answer path.
9. Excluded-thread regression: @-mention in an excluded topic is declined (gate still above the mention
   path); @-mention in a non-excluded topic answers.

**Handler integration (mock Telegram)**
10. Full path: a bound forum group, platform bot, @-mention question → 👀 + typing + answer logged
    (`logBotResponse`) under the correct entity, using the platform bot token.
11. `/auth` under the platform bot with `p_expected_entity = null` binds a new chat to the code's
    entity (Phase 2 test 9, now via the live platform route).

**Decoupling integrity**
12. After the destructive migration: GitHub-sync path still works (`get_current_entity_secret` still
    resolves `github_token_id`); the dropped telegram columns are gone; the platform bot still answers
    (its secrets come from `bots`, not the dropped entity columns).

---

## 11. Handoff notes for Antigravity

- **Snapshot first.** The destructive migration is **manual** (`supabase/manual/`), runs LAST, only
  after the platform bot is verified. Never let `db push` drop the entity columns.
- **`get_current_bot_secret` is a new RLS-bypass function — treat it with Phase-1-level care.** The
  self-check against `bots.*_secret_ref` for `app.current_bot_id` is the security control; without it,
  one bot can read another's token. Write test 2 (cross-bot denial) first.
- **`bots.*_secret_ref` are `text`, not `uuid` FKs** — confirm the stored format (Phase 1 backfill used
  the Vault secret uuid as text) before writing the resolver.
- **Webhook-secret validation must work from bot context alone**, before entity resolution — it's the
  forgery gate.
- **Keep `get_current_entity_secret` alive** — only remove its two telegram refs; the `github_token_id`
  ref stays (GitHub sync untouched). Update the function in the same step as the column drop.
- **`/whoami` and `/auth` stay above the untracked-group bail** (onboarding must work pre-bind).
- **Retire-in-place** the old bots (status flag); do **not** delete their rows or Vault secrets in this
  phase.
- **`p_expected_entity = null`** at the `consume_link_token` call site — the Phase 2 seam.
- Update the init-schema "THREE bypass functions" invariant comment to FOUR, with rationale.
