# SPEC — Phase 1: Management-Plane Foundation

> **Reads against:** `docs/V2-PLATFORM-PIVOT.md` + `docs/V2-PLATFORM-PIVOT-ADDENDUM.md`,
> `docs/MANAGEMENT-PROPOSAL.md`, `docs/SECURITY-PROPOSAL.md`.
> **Rigor bar:** match `SECURITY-PROPOSAL.md` — every new surface gets adversarial test cases.
> **One-line scope:** stand up the management plane's **data model + web auth + entity creation +
> minimal authorization**, *additively*, with the **Telegram runtime entirely untouched.**

---

## 0. Phase map (where Phase 1 sits)

Sequenced by dependency and by isolating the one irreversible step. Each phase is an independent
Antigravity handoff and an independent adversarial review.

| Phase | Name | Risk | Touches live runtime? |
|---|---|---|---|
| **0** | Clean checkpoint (commit current tree, split by concern) | none | no |
| **1** | **Management-plane foundation — THIS SPEC** (4 tables additive, Supabase Auth, web shell, entity creation, owner/admin authz, management RLS) | low (additive only) | **no** |
| 2 | `/auth` group-linking flow (mint/consume `link_tokens`, bot+web sides, group-admin gate) | medium | reads only |
| 3 | Bot-architecture cutover to (C) (platform bot + test bot, re-point HYS, retire per-entity bots, flip runtime to read `bots`, drop per-bot fields from `entities`) | **high / irreversible-ish** | **yes — live cutover** |
| 4 | Group-scoped context + section-level sensitivity (light up `manifest_entries.group_id`, withhold-before-assembly, per-group assignment UI) | medium | yes (read path) |

**Why this order:** all additive schema lands first (safe), auth is the entry condition to everything
in the management plane, `/auth` needs that auth + the tables, and the risky live bot cutover (Phase
3) is isolated so a failure there can't entangle the foundation. Group-scoped context (Phase 4)
depends on the group↔entity binding that Phase 2 establishes.

---

## 1. Scope

### 1.1 In scope (Phase 1)
1. **Additive schema:** create `profiles`, `bots`, `authorizations`, `link_tokens`; add
   `entities.owner_profile_id`. (Defining a table ≠ using it — see §1.2.)
2. **Supabase Auth** wired up (magic link — see resolved decision §2).
3. **Minimal web shell:** sign in → create entity → see entities you own or are authorized on →
   grant/revoke admins (owner only) → invite-by-email pending grants.
4. **Authorization model:** owner (distinguished pointer) + admin/editor/viewer rows.
5. **Management RLS** — the new, separate security surface (§5), with adversarial tests (§7).
6. **Operator backfill** for existing entities (HYS / SymRes / Theäta): set `owner_profile_id`,
   create `bots` rows mirroring current per-entity bots (data only), seed first admins via SQL.

### 1.2 Explicitly OUT of scope (deferred to named phases)
- **`/auth` flow / claim codes** — Phase 2. (`link_tokens` is *created* here but has **no behaviour**.)
- **Bot-architecture change; platform/test bot; re-pointing HYS; removing per-bot fields from
  `entities`** — Phase 3. (`bots` is *created and backfilled* here but the **runtime keeps reading the
  existing `entities` per-bot fields** until Phase 3.)
- **Group-scoped context, sensitivity tags, per-group doc assignment** — Phase 4.
- **Group-scoped authorization** (admin-per-group) — deferred per brief §9. `authorizations.group_id`
  exists but is always `null` in Phase 1.
- **Ownership transfer UI** — deferred (operator-SQL stopgap per §6.1).
- **Admins-granting-admins** — deferred; owner is the sole granter in v1.
- **Billing / credits / payment rails** — deferred (Addendum Δ4).
- **Activity logs, spend limits** — deferred; design tables so they're cheap later (Δ1).
- **Passkeys** — decided: additive fast-follow (Phase 1.5), not Phase 1 (§2).

### 1.3 Invariants that MUST hold at end of Phase 1
- The **Telegram bot behaves exactly as before.** No runtime code path reads any new table. HYS,
  SymRes, Theäta keep answering on their existing per-entity bots.
- The existing **runtime RLS** (`app.current_entity_id`, `bot_service` role, the three
  `SECURITY DEFINER` bootstrap fns) is **unmodified**. The management RLS is a *separate* surface on
  *separate* tables.
- Every new table is reachable only through the management surface (authenticated web users), never
  through the `bot_service` role.

---

## 2. Resolved decision — auth surface

**Magic-link-first; passkeys are an additive fast-follow (Phase 1.5).** *(Decided 2026-06-25.)*

Rationale:
- Smaller surface; fully covers invite-by-email activation (§6.3); de-risks the first auth build.
- **A verified email is a billing prerequisite.** Magic link yields a verified address we need later
  for transactional email — purchase receipts, billing statements, closed-loop credit-balance notices
  (Addendum Δ4). So magic-link-first is not merely the lighter option; it unblocks the monetization
  path. Passkeys add no email and therefore cannot be the sole launch method.
- Passkeys (WebAuthn) layer on additively without reworking anything in this phase.

---

## 3. Data model (additive DDL)

> All new tables live in the management surface. Types are Postgres/Supabase. Names are proposals;
> lock during review. `auth.users` = Supabase Auth's user table.

### 3.1 `profiles` — web users
```
profiles (
  id            uuid PK REFERENCES auth.users(id) ON DELETE CASCADE,
  email         citext NOT NULL UNIQUE,           -- verified by Supabase Auth
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now()
)
```
- One row per authenticated web user. `id` mirrors `auth.users.id`.
- Created on first sign-in (trigger on `auth.users` insert, or upsert on first authenticated request).

### 3.2 `entities` — CHANGE (add column only; remove nothing in Phase 1)
```
ALTER TABLE entities
  ADD COLUMN owner_profile_id uuid REFERENCES profiles(id);   -- nullable in Phase 1, see §4
```
- **Do NOT remove** `telegram_bot_token_id`, `telegram_webhook_secret_id`,
  `telegram_bot_username` in Phase 1 — the runtime still uses them. They are removed in **Phase 3**.

### 3.3 `bots` — first-class bot identity (defined + backfilled, NOT yet read by runtime)
```
bots (
  id                   uuid PK DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  telegram_username    text,
  token_secret_ref     text,        -- Vault reference; NOT the token itself
  webhook_secret_ref   text,        -- Vault reference
  persona              text,        -- stub; single hardcoded persona today (answerQuestion)
  model                text,        -- stub
  capabilities         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- stub
  status               text NOT NULL DEFAULT 'active',
  created_at           timestamptz NOT NULL DEFAULT now()
)

bot_entities (                       -- which entities a bot serves (many-to-many; future-proofs (C))
  bot_id     uuid REFERENCES bots(id) ON DELETE CASCADE,
  entity_id  uuid REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (bot_id, entity_id)
)
```
- **Phase 1 backfill:** one `bots` row per existing per-entity bot, with a matching `bot_entities`
  row (1:1 today). This is **data only** — the webhook handler still routes via the `entities`
  per-bot fields. Phase 3 flips the runtime to resolve via `bots`/`bot_entities` and switches to the
  shared platform bot.
- **`bot_entities` is intentionally a join table even though today it is 1:1** — model (C) is
  one-bot-many-entities, so the join makes Phase 3 a data migration rather than a schema change.
  (Flagged for review as a deliberate "build the seam early" call.)
- Secrets are **never** stored here — only Vault references, consistent with `SECURITY-PROPOSAL.md`.

### 3.4 `authorizations` — web-user ↔ entity ↔ role
```
authorizations (
  id             uuid PK DEFAULT gen_random_uuid(),
  entity_id      uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  profile_id     uuid REFERENCES profiles(id) ON DELETE CASCADE,   -- NULL while a pending invite
  invited_email  citext,                                           -- set for pending invites
  role           text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  group_id       uuid,                 -- ALWAYS NULL in Phase 1 (group-scoped authz deferred)
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending')),
  granted_by     uuid NOT NULL REFERENCES profiles(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ( (status='active' AND profile_id IS NOT NULL)
       OR (status='pending' AND invited_email IS NOT NULL AND profile_id IS NULL) ),
  UNIQUE (entity_id, profile_id),      -- one role row per (entity, user)
  UNIQUE (entity_id, invited_email)    -- one pending invite per (entity, email)
)
```
- **`role` does NOT include `owner`.** Owner is the distinguished pointer `entities.owner_profile_id`
  (§6.1 of the brief) — structurally separate, so an admin can't become/remove owner via a row.
- `group_id` is carried for forward-compat but is always `null` in Phase 1.

### 3.5 `link_tokens` — defined, NO behaviour in Phase 1 (Phase 2 uses it)
```
link_tokens (
  id            uuid PK DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,     -- store a hash, never the raw code
  issued_by     uuid NOT NULL REFERENCES profiles(id),
  entity_id     uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,     -- ~2–5 min (Phase 2)
  consumed_at   timestamptz,              -- consume-on-use (Phase 2)
  created_at    timestamptz NOT NULL DEFAULT now()
)
```
- Phase 1 creates the table only. Mint/consume logic and the group-admin gate are **Phase 2**.

---

## 4. Migration & backfill (additive-first ordering)

Run as ordered, individually-revertible migrations. Nothing here changes runtime behaviour.

1. **Create `profiles`** + the `auth.users`→`profiles` provisioning trigger/upsert.
2. **Create `bots`, `bot_entities`, `authorizations`, `link_tokens`.**
3. **`ALTER TABLE entities ADD COLUMN owner_profile_id` (nullable).**
4. **Operator backfill (SQL, bootstrap):**
   - Create `profiles` rows for the operator + initial admins (or let them be created on first
     sign-in, then backfill).
   - Set `entities.owner_profile_id` for HYS / SymRes / Theäta.
   - Insert `bots` + `bot_entities` rows mirroring each entity's current per-entity bot (data only).
   - Insert initial `authorizations` (admin) rows as needed.
5. **Enforce ownership:** once every entity has an owner, `ALTER COLUMN owner_profile_id SET NOT NULL`.
   (Two-step nullable→backfill→not-null keeps the migration safe on existing rows — do **not**
   collapse into a single not-null `ADD COLUMN`, which fails on existing rows.)

**Rollback:** each step reverses cleanly; because no runtime path reads these tables, a Phase 1
rollback cannot affect live bot traffic.

---

## 5. Management RLS (the new security surface)

> **Separate from runtime RLS.** Runtime uses transaction-local `app.current_entity_id` under the
> `bot_service` role. Management RLS is keyed on the **authenticated web user** (`auth.uid()`) under
> Supabase's authenticated role. The `bot_service` role must have **no** privileges on these tables.

Design intent (express as explicit policies; review adversarially):

**`profiles`**
- SELECT/UPDATE: only own row (`id = auth.uid()`). No cross-user reads.

**`entities`**
- INSERT: any authenticated user; the row's `owner_profile_id` is forced to `auth.uid()` (server-set,
  not client-supplied).
- SELECT: `owner_profile_id = auth.uid()` **OR** an `active` `authorizations` row exists for
  `(entity_id, auth.uid())`.
- UPDATE (config): owner **or** `admin`. (Editors/viewers cannot mutate config in Phase 1.)
- DELETE: **owner only.**
- `owner_profile_id` is **immutable through the management API** in Phase 1 (transfer is operator-SQL;
  deferred).

**`authorizations`**
- SELECT: rows for entities the caller owns or is authorized on.
- INSERT (grant): **only the entity owner** (`entities.owner_profile_id = auth.uid()`), v1.
  - May grant `admin` / `editor` / `viewer` only — **never `owner`** (no such role value exists).
  - `granted_by` is server-set to `auth.uid()`.
- DELETE (revoke): **owner only.** An admin cannot revoke anyone (no admin-removes-admin, no
  admin-removes-owner — owner isn't even in this table).
- UPDATE (role change): owner only.

**`bots`, `bot_entities`, `link_tokens`**
- Phase 1: **operator/platform-managed only.** No tenant INSERT/UPDATE/DELETE. SELECT may be withheld
  from tenants entirely in Phase 1 (nothing in the web shell needs to read them yet).

**Cross-cutting rules**
- **Default-deny:** no policy ⇒ no access. Every table has RLS enabled.
- All entity-scoped predicates resolve through `owner_profile_id` or an `active` authorization — never
  through client-supplied IDs.
- The `bot_service` runtime role is explicitly **revoked** on all Phase 1 tables.

---

## 6. Web app shell (minimal)

Smallest surface that proves the plane. No styling ambition; correctness + the RLS boundary are the
deliverable.

1. **Sign in / sign up** — Supabase Auth magic link. First sign-in provisions a `profiles` row.
2. **My entities** — list entities where caller is owner or authorized; "Create entity".
3. **Create entity** — name/slug → inserts `entities` row with `owner_profile_id = auth.uid()`.
4. **Entity detail** — show role; **owner-only** panel: grant admin/editor/viewer (existing profile
   or **invite-by-email**), revoke, list current authorizations + pending invites.
5. **(Optional, may ride here or defer)** per-entity **health check** surfacing the currently
   unexposed `checkVaultSecretsHealth`. Small; include only if it doesn't expand the auth surface.

### 6.3 Invite-by-email pending grants
- Owner enters an email → `authorizations` row with `status='pending'`, `invited_email` set,
  `profile_id` null.
- On that email's **first verified authentication**, a server-side step (trigger or post-auth hook)
  matches `invited_email` → new `profile_id`, sets `status='active'`, clears `invited_email`.
- **Security:** activation keys on the **Supabase-verified** email only; a user cannot claim a pending
  grant for an address they don't control (magic-link proves control). Exact-match, single-use.

---

## 7. Adversarial test cases (definition of "secure enough to ship Phase 1")

Mirror `SECURITY-PROPOSAL.md` rigor. Each must be a written, runnable test.

**Cross-entity isolation**
1. User A (owner of E1) cannot SELECT/UPDATE/DELETE E2 (owned by B) — direct ID, enumeration, and via
   forged `authorizations` insert.
2. A viewer/editor/admin on E1 has **zero** visibility into E2.

**Privilege escalation**
3. An `admin` on E1 cannot: delete E1; change `owner_profile_id`; grant themselves a higher role;
   grant/revoke anyone (owner-only in v1); insert an `authorizations` row with `role='owner'` (value
   must be rejected by CHECK).
4. A non-owner cannot make any `authorizations` mutation on E1.
5. Client-supplied `owner_profile_id` / `granted_by` on insert is ignored/overridden server-side.

**Owner protection (anti-coup)**
6. No management-API path removes or demotes the owner. Owner survives any admin action.

**Invite-by-email**
7. A pending invite for `x@host` cannot be activated by anyone who hasn't verified `x@host`.
8. Replaying / re-using a pending invite does not create duplicate active grants (UNIQUE holds).

**Runtime isolation (regression)**
9. The `bot_service` role has no access to any Phase 1 table (read or write).
10. No runtime code path reads `profiles` / `bots` / `bot_entities` / `authorizations` /
    `link_tokens` / `owner_profile_id`. Live bot behaviour for HYS/SymRes/Theäta is byte-for-byte
    unchanged (golden-path regression).

**RLS default-deny**
11. With no matching policy, every table denies. RLS is enabled on all five new tables.

---

## 8. Acceptance criteria (Definition of Done)

- [ ] All five tables + `entities.owner_profile_id` migrated; `owner_profile_id` is `NOT NULL` after
      backfill.
- [ ] Existing entities backfilled (owner, `bots`/`bot_entities`, initial admins).
- [ ] Magic-link auth works; first sign-in provisions a `profiles` row.
- [ ] A new user can create an entity and is its owner; an owner can grant/revoke admins and
      invite-by-email; pending grants activate on first auth.
- [ ] All §7 adversarial tests pass.
- [ ] **Invariants §1.3 verified:** runtime RLS untouched; `bot_service` revoked on new tables; live
      bots unchanged.
- [ ] Migrations are individually revertible; documented rollback.

---

## 9. Handoff notes for Antigravity

- **Do not touch** the Telegram webhook handler, the runtime RLS, the `bot_service` role, or the
  three `SECURITY DEFINER` bootstrap functions. If a task seems to require it, **stop and flag** — it
  belongs to Phase 3.
- **Defining ≠ using:** `bots` and `link_tokens` are created (and `bots` backfilled) but have **no
  runtime/behavioural** code in Phase 1. Building `/auth` logic or bot-cutover logic here is **out of
  scope** and will be rejected in review.
- `authorizations.group_id` exists but **must always be `null`** in Phase 1.
- Owner is a **column on `entities`**, never a row in `authorizations`. Any code that treats "highest
  role" as owner is wrong.
- Secrets: only **Vault references** in `bots`; never raw tokens. Hash, never store, link-token codes
  (Phase 2).
- Adversarial review by the operator follows completion; write the §7 tests as you build, not after.
