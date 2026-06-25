# V2 Platform Pivot — Kickoff Brief

> **Purpose:** seed a fresh working session for the pivot from *operator-run controlled-tenant tool* → *self-service multi-tenant product*. This brief frames the one strategic decision that gates everything else (bot architecture), captures where the code stands today, folds in design already on file, and draws the scope line. It is a **decision brief, not a build spec** — the new chat should resolve the open fork (§4), then expand the chosen path into specs with the same rigor as `SECURITY-PROPOSAL.md`.
>
> **Read before starting:** `PLANNING.md` (esp. §8–§9), `MANAGEMENT-PROPOSAL.md` (whole — most of the auth/onboarding design is already drafted there), `SECURITY-PROPOSAL.md` (the runtime RLS model this must coexist with), `BACKLOG.md`.
>
> **First action, before any new build:** commit the current working tree (last session left a large uncommitted batch — storage Phase 1, `/recap`, the excluded-thread gate, doc repairs). Start the pivot from a clean checkpoint, ideally split by concern.

---

## 1. The decision, and why now

The platform works as a multi-tenant tool that **the operator runs for their own teams** (HYS live; SymRes, Theäta onboarding). Every new tenant is a manual, SQL-heavy runbook (`DEPLOYMENT.md` Parts A/B/C) performed by the operator. The pivot: **let teams onboard themselves** — real web authentication, self-service entity creation, and a group-linking flow — turning the runbook into a product.

Why now: (a) context in the build chat is saturated (already compacted once) — a strategic pivot deserves a clean room; (b) true auth was always a needed milestone (`MANAGEMENT-PROPOSAL.md` exists precisely for this); (c) the self-service goal forces a bot-architecture decision (§4) that is cheaper to make *before* more per-entity-bot code accrues.

**Commercial viability is unproven and that's fine** — the technical foundation for self-service is worth building regardless, and the decisions below are reversible-ish if modeled correctly (the `bots` table, §5).

---

## 2. Where the code is now (v1 state — the foundation to build on)

- **Runtime:** Next.js on Vercel (serverless) + Supabase Postgres (operational data + Vault for secrets) + Anthropic (model) + Telegram (v1 front-end). AGPL-3.0.
- **Tenant isolation (works, verified):** RLS on all tenant tables keyed on a transaction-local `app.current_entity_id`; `bot_service` least-privilege role; 3 `SECURITY DEFINER` bootstrap functions (`resolve_entity_id_by_slug`, `resolve_entity_id_by_repo` [dormant], `get_current_entity_secret`). See `SECURITY-PROPOSAL.md`.
- **Content model:** documents live **directly in `doc_cache`** (no GitHub in the v1 path; GitHub-sync code retained as a dormant future adapter). Topic→context via `manifest_entries` (entity-general + per-topic; group-scope column exists, unused).
- **Commands shipped & verified:** `/ask`, `@mention`, `/help`, `/context`, `/whoami`, `/recap`. Excluded-thread gate (single positional gate, declines only when addressed). Chat-history **Phase 1** live (bot responses logged; `summary` + `generation_metadata` columns ready, null).
- **Bot architecture today:** **one Telegram bot per entity** (own token, own username, own webhook secret in Vault; webhook routed by URL slug `/api/webhooks/telegram/[entitySlug]`). Group resolved by `chat_id`; untracked-group bail is the allowlist gate.
- **Identity:** there is **no web/user identity layer yet.** Runtime "identity" is Telegram-sourced only (membership = access). Onboarding authority is the operator with SQL-editor (postgres) access.

---

## 3. The pivot in one line

**Add a management plane** — web authentication (Supabase Auth), self-service entity creation, and a Telegram group-linking flow — **plus resolve the bot-architecture fork.** The management plane is largely designed already in `MANAGEMENT-PROPOSAL.md` (promote it from *draft* → *build*). The bot-architecture fork (§4) is the genuinely new decision and the headline of this brief.

---

## 4. ⭐ HEADLINE DECISION: bot architecture (resolve this first)

The BotFather constraint — **you cannot create a Telegram bot via API; a human must talk to BotFather** — does *not* force a single bot. It only forces "the one human step is creating/pasting a bot." There are **three** models; (A) is today, (B) is PLANNING's documented decision, (C) is the new candidate:

| | **(A) Per-entity, operator-made** | **(B) Per-entity, BYO-bot** (PLANNING §9) | **(C) Platform-owned bot(s) + `/auth`** |
|---|---|---|---|
| Onboarding step | Operator runs full runbook | Tenant does `/newbot`, **pastes token**; platform automates the rest | **Add our bot, run `/auth`** — no BotFather at all |
| Self-service? | No | Yes | Yes (lowest friction) |
| Tenant bot identity/branding | Per-tenant | **Per-tenant (their name, their account)** | Shared generic bot (unless multiple platform bots) |
| Telegram per-bot rate limits (~30/s) | Sharded per tenant | **Sharded per tenant** | **Concentrated** on the shared bot (scale risk + DoS surface — see §4.1; mitigate by sharding across platform bots) |
| Bot custody / trust | Tenant or operator | **Tenant's account** | Platform custodial |
| Enables test/purpose/ecosystem bots | No | No | **Yes** — bots become platform-owned, first-class |
| Schema impact | none (today) | small | bot fields move off `entities` → `bots` table |

**DECISION (2026-06-25): (C).** Model **`bots` as a first-class table** (§5), start with **one platform bot + one test bot** (the test bot is nearly free under C and immediately useful), and **keep (B) BYO-bot as a documented future tier** should branding/scale ever demand it. (This reverses PLANNING §8.2/§9 — add a superseded-pointer there.) Rationale: (C) removes the most onboarding friction (even "create a bot at BotFather" is a barrier for non-technical users), and it is the *only* model that enables the test/purpose-bot/ecosystem direction. The `bots` table keeps (B) reachable later, so this is not a one-way door.

**The two counter-arguments, resolved:**
- **Branding** — *reframed as a feature, not a cost.* A single recognizable platform bot that users recommend to each other ("add @KenntnisBot to your group") is a distribution channel. Per-tenant branding is not a day-one product expectation; if it ever becomes one, the `bots` table makes BYO-bot (B) an additive tier.
- **Rate limits / DoS** — real but bounded and manageable; see §4.1.

### 4.1 Rate limits & DoS posture (the (C) tradeoff, made concrete)

The concern with a shared platform bot: all tenants funnel through one bot, so (a) Telegram's per-bot send limits are shared, and (b) it looks like a single DoS target. Both are bounded:

- **The auth/linking model is the primary DoS control.** The expensive path (the Anthropic call) sits *below* the untracked-group bail — only messages from **linked** groups ever trigger a model call, and linking requires a Telegram group admin (§6). So the attack surface is not "anyone on Telegram"; it's "someone already admitted to a registered customer group." That is a small, tractable problem, not an open floodgate.
- **Telegram's send limits** (~30 msg/s across chats, ~20/min to one group — *approximate, verify*) throttle **outbound reply spam** automatically — but they do **not** bound inbound-triggered **compute cost** (Vercel invocations + Anthropic calls fire before any reply). So send-limits are not the compute-cost defense.
- **Per-user / per-group throttling in the handler** is the lever for compute cost: count requests per `telegram_user_id` (or chat) in a short window and back off abusers. `message_log` already holds this data → it's a later add, not a re-architecture.
- **Bot-sharding is the scale escape hatch.** If one platform bot saturates, route different tenants to different platform bots — a routing change, not a rewrite, *because* `bots` is first-class (§5). This is the concrete answer to "what if 30/s isn't enough."

None of this is v1 scope; all are cheap seams the (C) + `bots`-table design already enables. Capture per-user throttling in BACKLOG as the first lever to reach for if abuse appears.

---

## 5. The unifying schema insight: `bots` as first-class

Regardless of A/B/C, the cheap, future-proofing move is to **decouple bot-identity from tenant-identity**: a `bots` table rather than bot columns on `entities`. This is the seam that keeps every future open at near-zero cost now.

A "bot" generalizes to: `{ identity (token ref), persona (system prompt), capabilities (which commands/tools), model, which entities it serves }`. Today there is exactly **one** hardcoded persona (`answerQuestion`). The ecosystem vision (adversarial bot, design bot, test bot) is simply that tuple becoming **configurable and multi-row** — "one bot per *function*, each multi-tenant," not "one bot total" and not "one per tenant."

**Discipline (apply the project's own rule to the exciting idea):** build the **table seam now** (cheap, reversible-preserving); do **not** build the persona/capability config system in v1 — `PLANNING.md` §9 already says personas layer on top of future write-commands, not before them. The open *ecosystem* (third-party bots/skills) is a **north star only** — it informs this one schema decision and drives **zero** v1 scope (it's a governance/security/sandboxing problem for much later). The one piece worth pulling forward is the **test bot**, which is immediate dev value and nearly free under model (C).

---

## 6. Management plane — already largely designed (`MANAGEMENT-PROPOSAL.md`)

The auth/onboarding design is mostly on file; the pivot promotes it from draft to build. Key pieces (summarized — read the proposal for the full reasoning + the security test-case requirements):

- **Two identity planes:** runtime (Telegram users ↔ entities, exists) and **management (web users via Supabase Auth ↔ entities, new)**. Telegram is the bridge.
- **Auth:** Supabase Auth (email magic link + passkeys). Solved infra; the hard part is authorization, not authentication.
- **The `/auth` (= MANAGEMENT-PROPOSAL's `/link`) claim-code flow** — this *is* the operator's `/auth` idea, already designed: web app mints a short-lived single-use code for the logged-in user → user runs `/auth <code>` in the group → the bot, seeing **both** the Telegram identity and the web-issued code at once, writes the binding. No Telegram secret involved; proves web-account control *and* real group membership simultaneously; supports one web user managing multiple entities.
- **Authorization model:** one `authorizations` table with a **nullable `group_id`** (null = entity-wide, set = group-scoped), role ∈ {admin, editor, viewer}. **Telegram's admin list is the source of truth** (`getChatAdministrators` at link time). **Entity-wide rights are granted, not auto-derived** from single-group admin status.
- **Owner vs admins (refinement — see §6.1).** An entity has exactly **one owner** (its creator, modeled as a *distinguished pointer*) plus **N granted admins**. "Owner" is **not** merely the first admin row — it's structurally distinct, so an admin can't remove the creator or delete/transfer the entity (an "admin coup"). Details + open sub-questions in §6.1.

**What self-service newly surfaces (the genuinely new hard part):** **group-admin authorization at link time.** In a group, *anyone* can type `/auth` — you must gate the *binding* on the requester being a Telegram group admin, or a random member could bind the group to their own entity. The per-entity-bot/operator model sidestepped this entirely (onboarding was SQL-gated). This is where adversarial review must focus (privilege escalation, cross-entity access, claim-code replay/expiry).

**Precision — gate the _link_, not the _add_.** We cannot control *who adds the bot* to a group (that's Telegram's domain, often a group-permission the owner sets). And we don't need to: **an unlinked group hits the untracked-group bail — the bot is inert until bound.** The privileged, admin-gated step is the **`/auth` binding**, enforced by checking Telegram's own admin list (`getChatAdministrators`) at link time. So "only admins" applies to *linking a group to an entity*, not to dropping the (harmless, inert) bot into a chat.

### 6.1 Owner & admins (entity authority model)

The brief originally flattened "owner" into "first admin." That hides a failure mode: if everyone is just `admin`, any admin could remove the others (including the creator) or delete the entity. Real products separate **owner** from **admin**:

- **Owner** — the entity's creator; ultimate authority. Owner-only actions: **delete entity, transfer ownership**, and (later) **billing**. Exactly one per entity; cannot be removed by an admin.
- **Admins** — granted by the **owner** (v1). Can manage content/config/members; **cannot** delete the entity or remove/override the owner. **Must authenticate** (web identity) — see the auth note below.
- **Editors / viewers** — as in `MANAGEMENT-PROPOSAL.md` (viewer = read-only web access; a richer `/context`).

**Recommended modeling (lock the shape now, in the spec):** make **owner a distinguished pointer** — `entities.owner_profile_id` (not-null FK to `profiles`) — **not** just the highest-role row in `authorizations`. Keep `authorizations` for the admin/editor/viewer layer. Why distinguished: "exactly one owner" is enforced structurally (FK + not-null, no partial-unique-index gymnastics), ownership **transfer is a single column update**, and the owner can't be deleted out of existence by an admin. Mirrors GitHub orgs / Stripe. The entity creator is set as `owner_profile_id` at creation; operator bootstraps existing entities (HYS/SymRes/Theäta) via SQL during migration.

**Day-one scope vs deferred (decided 2026-06-25):**
- **v1: the owner grants admins** (owner-only granter). Admins-granting-*other*-admins is a plausible later enhancement, **deferred** — a single granter (the owner) is simplest and sufficient for v1.
- **Admins must authenticate — web auth is the entry condition to the management plane, not an extra hoop.** An admin *is* a web-authenticated identity by construction: an `authorizations` row references a Supabase Auth profile, so there is no unauthenticated admin. (The bot *runtime* is unaffected — any group member can use the bot; web identity exists only for *managing* an entity.)
- **Granting a not-yet-signed-up person → invite-by-email (recommended).** Because a grant must reference a profile, the owner can't grant a bare email/handle that never authenticated. Preferred v1 UX: owner enters an email → a **pending grant** is created → it activates on that person's first authentication (Supabase Auth supports invites). The alternative (grant-only-existing-profiles, requiring the person to sign up first out-of-band) is clunkier. Decide in the spec; invite-by-email preferred.
- **Ownership transfer (+ owner-gone recovery)** — **deferred to a later version.** Day one, `owner_profile_id` is set at creation and is not reassignable through the UI; an **operator SQL update is the escape hatch** until the transfer flow is built. Confirmed not needed day one.
- **Entity-wide vs group-scoped admin granting** — left open but low-priority; resolve alongside group-scoped authorization itself (already deferred, §9).

**Two distinct bindings (so the auth question doesn't conflate them):**
- **group ↔ entity** — established by the `/auth` claim-code flow, gated on Telegram *group-admin* status; the owner bootstrapping which Telegram groups belong to their entity.
- **web-user ↔ entity ↔ role** — established by the *owner granting* a role to an authenticated web user.
Both funnel through web auth. Telegram-admin status does **not** auto-confer entity-admin — it's an input the owner may consider, not an automatic promotion (consistent with `MANAGEMENT-PROPOSAL.md` §5.3, "entity-wide rights are granted, not auto-derived").

---

## 7. Data-model delta (additive; existing tenant tables + runtime RLS unchanged)

**Add:**
- `profiles` — web users, tied to Supabase Auth (`auth.users`).
- `bots` — **first-class bot identity** (token ref → Vault, persona/model/capabilities columns may start minimal/stubbed, which entities it serves). One row in v1.
- `authorizations` — web-user ↔ entity ↔ role, nullable `group_id` (per `MANAGEMENT-PROPOSAL.md` §5.2).
- `link_tokens` (or similar) — short-lived single-use codes for the `/auth` handshake (bound to issuing web user; consume-on-use; ~2–5 min expiry).

**Change on `entities`:**
- **Add `owner_profile_id`** (not-null FK → `profiles`) — the distinguished entity owner (§6.1).
- **Remove the per-bot fields** (`telegram_bot_token_id`, `telegram_webhook_secret_id`, `telegram_bot_username`) — under the decided (C) path they move to the `bots` table / platform level. A simplification. *(Under (B) they would have stayed; (C) was chosen — §4.)*

**Two RLS models will coexist:** the existing **runtime** model (`app.current_entity_id`, bot path) and a **new management** model (which authenticated web user may act on which entity/group). Design the management RLS with the same adversarial rigor as `SECURITY-PROPOSAL.md`; they are *separate* surfaces.

---

## 8. Migration from current state

- **HYS is live on its own per-entity bot**; SymRes/Theäta in progress.
- **If (C):** stand up the platform bot (+ test bot); re-point HYS's group(s) to it (the handler already resolves by `chat_id`, so routing barely changes — `chat_id→entity` becomes primary); retire the per-entity bot/webhook; backfill `bots` + `authorizations` rows; assign first entity-admins via SQL (operator bootstrap). Sequence: **add auth/authz tables first (additive, safe), then make the bot-arch change.**
- **If (B):** lighter — keep existing bots; add the auth/authz/`/auth` layer on top.
- Either way, the `DEPLOYMENT.md` runbook becomes the *spec for the automated onboarding flow* — it's the manual version of what the management plane will do programmatically.

---

## 9. Scope line — what is NOT in v1 of the pivot

Hold the project's "don't build ahead of need" discipline:

- **Open bot ecosystem (third-party bots/skills)** — north star only; informs the `bots` table, nothing else.
- **Persona/capability config system** — deferred (`PLANNING.md` §9); layers on future write-commands.
- **Group-scoped authorization** — start with entity-admin + viewer; add group-scoping only when a real multi-group customer needs it (`MANAGEMENT-PROPOSAL.md` §7).
- **Write-commands, `/draft`, `/setup` auto-scaffolding, public API** — all later (`PLANNING.md` §9).
- **Billing / commercial model** — not technical; defer (but it may inform hosted-vs-self-host tiering).
- **Encryption-at-rest Type A.5, data-protection hardening** — pre-public-launch (`PLANNING.md` §9); Type A + TOS/Privacy + self-host offer is the stance.

**v1 of the pivot ≈** Supabase Auth + minimal web shell + self-service entity creation + the `/auth` group-linking flow + the chosen bot architecture + minimal authz (entity-admin + viewer) + a per-entity health check (the natural home for the unexposed `checkVaultSecretsHealth`).

---

## 10. Open questions to resolve at kickoff

**Resolved (2026-06-25, this brief):** bot-architecture fork (§4) → **(C)** with `bots` first-class; branding reframed as a feature; owner modeled as a **distinguished pointer** (§6.1); **owner grants admins (v1)**, admins-grant-admins deferred; **admins must authenticate** (web auth = management-plane entry), grants via **invite-by-email**; **ownership transfer deferred** (operator-SQL stopgap); rate-limit/DoS posture set (§4.1, all deferred seams).

**Still open:**
1. **Hosted-only first, or self-host in parallel?** (`PLANNING.md` §9 frames hosted vs self-hosted as the privacy/trust answer.)
2. **Is there a design-partner tenant** beyond the operator's own teams — a real first customer to build against?
3. **Auth surface:** magic link + passkeys both at launch, or magic link first?

---

## 11. First concrete steps once the fork is decided

1. Commit the current batch (clean checkpoint).
2. Promote `MANAGEMENT-PROPOSAL.md` from draft → full build spec **with security test cases** (privilege escalation, cross-entity access, claim-code replay/expiry, group-admin gating) — and absorb the **owner/admin authority model (§6.1)**, which supersedes its flat "first admin = creator" framing.
3. Migration: add `profiles`, `bots`, `authorizations`, `link_tokens` (additive first).
4. Stand up Supabase Auth + a minimal web app shell (entity creation → first-admin).
5. Build the `/auth` claim-code flow (bot side + web side), with the group-admin gate.
6. Execute the bot-architecture change (per the fork).
7. **Adversarial security review of the management RLS + `/auth` flow**, same rigor as the runtime RLS model.

---

*This brief is the bridge from the v1 build chat to the v2 pivot chat. The new chat should open by resolving §4, then proceed to §11.*
