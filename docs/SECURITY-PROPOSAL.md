# Security Model — Revision Proposal

> **✅ STATUS: RESOLVED / IMPLEMENTED (2026-06-18).** Both Part 1 and Part 2 of this proposal have been implemented and verified against the migration (`supabase/migrations/20260618000000_init_schema.sql`), the application code (`lib/`, `app/api/webhooks/`), and the `README.md`. A final end-to-end review confirmed the model is correct, including the fix of `.env.example` to connect as the restricted `bot_service` role (not the `postgres` superuser).
> **This document is retained as the design-rationale record** — the *why* behind the security model (threat model, the explicit non-goal of defending full-env compromise, why three SECURITY DEFINER functions, why per-tenant users, why no service_role). Do not delete it; it is the institutional memory that prevents settled decisions (e.g. removing the passphrase scheme) from being accidentally relitigated or reintroduced. It is no longer an *open* proposal.

---

> **Purpose:** This document proposes replacing the current "passphrase / chicken-and-egg" RLS scheme with a simpler, correct security model. It is written to be handed to the implementing agent (Antigravity) for confirmation and implementation.
> **Status:** proposal for review — not yet implemented.
> **Context:** supersedes the security approach described in the current `README.md` (§ "Security & Tenant Isolation Model") and the RLS implementation in `supabase/migrations/20260618000000_init_schema.sql`.

---

## 1. Why we're changing it

The current implementation defends against "a leaked database connection string" using a passphrase scheme: every RLS policy requires both `app.current_entity_id` and `app.current_entity_secret` (the Telegram webhook secret) to be set, and claims that the `entities` table is self-protecting (you can't read the secret without knowing the secret).

On review, this scheme has three problems and one mismatched motivation:

1. **`security definer` defeats it.** The `verify_entity_session()` helper is declared `security definer`, so it runs with the function-owner's privileges and **bypasses RLS** when it reads the `entities` table. The "you can't read `entities` without the secret" guarantee is therefore not actually enforced — the function reads the table freely. The advertised two-layer protection collapses to one.

2. **Circular bootstrap.** A request arrives with an entity *slug* (from the URL), not the UUID or secret. To set the session passphrase the app must first read the entity row to get its secret — but reading that row requires the passphrase already be set. This circularity can only be resolved by *some* RLS-bypassing path at the front door, which undercuts the "even if the connection string leaks" guarantee.

3. **Missing `WITH CHECK`.** All policies use `USING` only. `USING` governs reads/affected rows; it does **not** constrain inserted/updated values. Without `WITH CHECK`, the application role can write rows with *another tenant's* `entity_id` — a real cross-tenant **write** gap.

4. **Mismatched motivation.** The scheme was built to defend against a leaked connection string. But the connection string lives in the same Vercel secret store as every other secret (bot tokens, GitHub tokens, Anthropic key). An attacker with that env has everything regardless of DB-layer cleverness, so "defend a leaked connection string in isolation" is a narrow, somewhat artificial threat. The **real** original worry was *accidentally committing a secret to GitHub* — which is a git-hygiene problem, not a database problem, and has standard purpose-built solutions.

**Conclusion:** the passphrase scheme adds complexity and bugs to defend a threat that's either unwinnable at the DB layer (full env compromise) or better solved elsewhere (git hygiene), while leaving a genuine multi-tenant write gap open. We replace it with simpler, correct primitives, each defending the threat it's actually suited to.

---

## 2. Threat model (explicit)

We design against these, in priority order:

1. **Cross-tenant leakage from application bugs** — a query missing a tenant filter, or a logic error, serving Tenant A's data to Tenant B. *This is the dominant, realistic multi-tenant breach.* → defended by **RLS**.
2. **A compromised/abusive tenant** reaching into another tenant's data. → defended by **RLS**.
3. **Secrets at rest in the database being read** (e.g. via some future bug or limited exposure). → defended by **encryption at rest (Supabase Vault)**.
4. **Accidental commit of a secret to GitHub** (the real original worry). → defended by **git-layer prevention** (gitignore + push protection).

We explicitly **do not** attempt to defend against **full Vercel environment compromise** at the database layer — it is unwinnable there (the connection string and all other secrets live in that same env), and pretending otherwise produces false confidence. That risk is mitigated operationally (secret hygiene, least-privilege, rotation), not by DB schemes.

---

## 3. Proposed model

Four independent, correct layers — each matched to a threat above.

### 3.1 Clean session-variable RLS (replaces the passphrase scheme)

Defends threats #1 and #2. Standard Postgres multi-tenant pattern, done correctly.

- **Keep** the least-privilege `bot_service` role (non-superuser, subject to RLS) and `FORCE ROW LEVEL SECURITY` on all tenant tables. *(The app must connect as `bot_service`, never as `postgres`/superuser and never via Supabase's `service_role` key — both bypass RLS and would nullify this entirely.)*
- **Scope every policy by `entity_id` from a session variable only** — drop the secret/passphrase entirely:
  ```sql
  -- Example, applied per tenant table:
  create policy doc_cache_isolation on doc_cache
    as restrictive
    using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
    with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);
  ```
- **Add `WITH CHECK` to every policy** (identical to `USING`), closing the cross-tenant write gap. Required on all tables the app writes: `message_log`, `processed_updates`, `doc_cache`, `memberships`, `users`, plus reads on the rest.
- **Remove `verify_entity_session()` and the secret session variable** (`app.current_entity_secret`). No `security definer` function that reads tenant data — policies reference `current_setting('app.current_entity_id')` directly, with no privilege-elevating indirection.
- **`set_current_entity()`** simplifies to setting just `app.current_entity_id` (transaction-local, `set_config(..., true)`). It no longer needs the secret. (It can remain a small helper; it does not read any table, so `security definer` is unnecessary — prefer `security invoker` / plain.)

### 3.2 Bootstrap (resolve slug → entity_id) — the one honest exception

The request carries a *slug*; the app needs the `entity_id` to set the session variable, but reading `entities` is RLS-protected. Resolve this with **one minimal, audited lookup**, not a blanket bypass:

- **Preferred:** a single tightly-scoped `security definer` function whose entire surface is `slug -> entity_id` (and nothing else — it must not return tokens or allow arbitrary reads):
  ```sql
  create or replace function resolve_entity_id_by_slug(p_slug text)
  returns uuid as $$
    select id from entities where slug = p_slug;
  $$ language sql security definer;
  -- Grant execute to bot_service; this is the ONLY RLS-bypassing surface, and it
  -- exposes only the (non-secret) entity_id for a known slug. It cannot read tokens
  -- or any other tenant data.
  ```
  The app calls this first (no session set yet), gets the `entity_id`, calls `set_current_entity(entity_id)`, and from that point every query is fully RLS-scoped. The slug→id mapping is not secret (slugs appear in webhook URLs), so exposing only the id via this one function is acceptable and reviewable.
- **Confirm with the implementer:** that this is the *only* `security definer` / RLS-bypassing path, and that it returns only `id`. Any other elevated read path is a hole.

> **Note for the implementer:** please confirm how the current handler/connection code performs the slug→entity lookup and sets the session, so this bootstrap replaces it cleanly. The above is the target; the existing code may need adjustment to match.

### 3.3 Encrypt per-tenant secrets at rest — Supabase Vault

Defends threat #3. The per-tenant secrets currently stored as plaintext `text` in `entities` — `telegram_bot_token`, `github_token`, `telegram_webhook_secret` — must not be plaintext.

- **Use Supabase Vault** to store these encrypted at rest (Vault encrypts with a key not stored in the database, and exposes a decrypted view only to authorized access).
- The `entities` table holds **references/ids into Vault** (or uses Vault's `vault.secrets` + the decrypted view), not the raw secret values.
- Net effect: even if an `entities` row is read, the tokens are ciphertext, not usable credentials. This is the *correct* version of what the passphrase scheme was reaching for — encryption instead of a bootstrapping trick.
- **Acceptable coupling:** we are comfortable coupling to Supabase Vault for this.

### 3.4 Git-layer secret prevention — the actual fix for the original fear

Defends threat #4 (accidental commit), at its source.

- **`.gitignore`** already includes `.env*` — confirmed. (Catches `.env`, `.env.local`, `.env.production`, etc.) Keep it.
- **Enable GitHub Push Protection / Secret Scanning** on the repo — natively blocks pushes containing detected secret formats. This is the backstop for the case where a secret is pasted somewhere *other* than an ignored env file.
- **(Optional) pre-commit hook** (`gitleaks` or `git-secrets`) to catch secrets locally before commit.
- **Principle:** secrets live in Vercel env / the DB (Vault) — never in committable files. If there's nothing secret in a committable file, there's nothing to accidentally commit. We assume team discipline here, with push protection as the safety net.

### 3.5 Decouple the webhook secret

- The Telegram webhook secret returns to a **single job**: validating inbound Telegram calls (the `x-telegram-bot-api-secret-token` header check). It is **no longer** a database-access credential.
- Stored in Vault (§3.3) like the other per-tenant secrets.

---

## 4. What changes, concretely

**Drop:**
- `verify_entity_session()` function.
- `app.current_entity_secret` session variable and all references to it.
- The secret-matching clause in every RLS policy.
- The README's "Passphrase Verification / Chicken-and-Egg" section.

**Add / change:**
- `WITH CHECK` on every RLS policy (matching `USING`).
- `resolve_entity_id_by_slug()` minimal bootstrap function (the sole, audited RLS-bypass, returns only `id`).
- Supabase Vault for `telegram_bot_token`, `github_token`, `telegram_webhook_secret`; `entities` references Vault rather than storing plaintext.
- `set_current_entity()` simplified to set only `app.current_entity_id`.
- README "Security" section rewritten to describe this model honestly (RLS for tenant isolation, Vault for secrets-at-rest, git-layer prevention for commits, explicit non-goal of defending full env compromise).

**Keep (already correct):**
- Least-privilege `bot_service` role.
- `FORCE ROW LEVEL SECURITY` on all tenant tables.
- Transaction-local session variable mechanism (`set_config(..., true)`) — correct for pooled connections.
- `.gitignore` `.env*`.

---

## 5. Verification checklist (for the implementer to confirm)

- [ ] The app connects **only** as `bot_service` — never `postgres`/superuser, never Supabase `service_role` (both bypass RLS). Confirm no `service_role` key in the bot's DB hot path.
- [ ] Every tenant table has RLS **enabled and forced**, with policies carrying **both `USING` and `WITH CHECK`**.
- [ ] `resolve_entity_id_by_slug()` is the **only** `security definer` / RLS-bypassing path, and returns **only** `entity_id` (no tokens, no other data).
- [ ] No remaining references to `app.current_entity_secret` or `verify_entity_session`.
- [ ] Per-tenant secrets are stored in **Vault**, not plaintext columns; the app decrypts at runtime via authorized access.
- [ ] Webhook-secret comparison still works (now sourced from Vault), and the secret is stored **clean** (no trailing newline — a known footgun that silently breaks header comparison).
- [ ] Writes (insert/update) to `message_log`, `processed_updates`, `doc_cache`, `memberships`, `users` are rejected when carrying a foreign `entity_id` (test the `WITH CHECK` actually bites).
- [ ] GitHub Push Protection enabled on the repo.
- [ ] A cross-tenant read attempt (set entity A's session, query for entity B's rows) returns **zero rows** — verify RLS bites end-to-end.

---

## 6. Open question for the implementer

- **Bootstrap confirmation:** how does the current handler/connection layer resolve slug→entity and set the session today? The proposed `resolve_entity_id_by_slug()` should replace that path; confirm there's no *other* elevated read path (e.g. a `service_role` lookup) lingering that would bypass RLS.
- **Vault integration shape:** confirm the preferred pattern for referencing Vault secrets from `entities` (Vault `vault.secrets` + decrypted view vs. storing a secret id/handle), and that `bot_service` has exactly the access it needs to decrypt its *own* tenant's secrets and no more (if Vault access can itself be tenant-scoped, even better; if not, note the residual exposure).

---

# Part 2 — Follow-up after implementation review

> **Status:** the Part 1 changes were implemented in `20260618000000_init_schema.sql` and largely landed correctly. This section covers what the post-implementation review found still needs fixing. Three items are real (one security gap, one functional+security bug, one documentation/invariant note); two are minor.
> **What's already correct (verified):** passphrase scheme fully removed; `set_current_entity` is `security invoker` and sets only the id; every tenant table has both `USING` and `WITH CHECK`; secrets moved to Vault references (`*_id uuid references vault.secrets`); `resolve_entity_id_by_slug` is minimal, returns only the id, and is `search_path`-locked. Good. The items below are what remains.

## P2.1 — (SECURITY GAP) Scope Vault access per-tenant; remove the blanket grant

**Problem.** The migration currently grants the app role read on the *entire* decrypted-secrets view:
```sql
grant select on vault.decrypted_secrets to bot_service;
```
This lets `bot_service` decrypt **every tenant's** bot tokens, GitHub tokens, and webhook secrets — there is no tenant scoping on the Vault view. An application bug or injection that reaches the view can exfiltrate *all* tenants' credentials, which is exactly the cross-tenant blast radius RLS prevents everywhere else. This is inconsistent with the care taken on the tenant tables.

**Decision: scope it strictly.** Replace the blanket grant with a single `security definer` function that returns a decrypted secret **only if it belongs to the current session entity**, and grant execute on that function instead.

```sql
-- Returns a decrypted secret ONLY if it is one of the current session entity's
-- own secret references. Self-checks against app.current_entity_id, so a caller
-- scoped to entity A cannot read entity B's secrets even via this function.
create or replace function get_current_entity_secret(p_secret_id uuid)
returns text as $
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where ds.id = p_secret_id
    and exists (
      select 1 from public.entities e
      where e.id = nullif(current_setting('app.current_entity_id', true), '')::uuid
        and p_secret_id in (
          e.telegram_bot_token_id,
          e.telegram_webhook_secret_id,
          e.github_token_id
        )
    );
$ language sql security definer set search_path = public, vault;

revoke select on vault.decrypted_secrets from bot_service;
grant execute on function get_current_entity_secret(uuid) to bot_service;
```

The app, after `set_current_entity(entity_id)`, fetches a secret via `get_current_entity_secret(entity.telegram_bot_token_id)` instead of selecting the view directly.

**Why this is low-cost to maintain:** the function is static — it never changes as tenants or tenant-counts grow. The only time it's ever edited is if a *new type* of per-entity secret column is added (rare; a one-line addition to the `in (...)` list). No per-tenant config, no operational burden.

**Note on the GitHub-sync path:** the GitHub webhook resolves entity by repo and then needs that entity's GitHub token / webhook-signing secret. After it calls `set_current_entity(entity_id)` (from the repo-resolved id), it can use the same `get_current_entity_secret(...)` — the session entity is set, so the self-check passes for that entity's own secrets. Confirm the sync handler sets the session before fetching secrets.

## P2.2 — (FUNCTIONAL + SECURITY BUG) Fix the `users` model: per-tenant users with `entity_id`

**Problem.** `users` currently has (a) **no `WITH CHECK`** on its policy (every other table got one), and (b) a `USING` policy that requires an existing `memberships` row — but the lazy-upsert flow inserts a `users` row *before* any membership exists, so the just-inserted user is invisible to the same transaction and the insert isn't policy-constrained. The membership-subquery policy is also more complex than needed.

**Decision: per-tenant user model (Option a).** A user is scoped to a single entity; the same Telegram person in two entities' groups has **two** user rows (one per entity). Users are *not* shared across entities. This is consistent with `entity_id`-on-everything, makes the policy trivial, and matches how the bot reasons (membership is always per-group-per-entity).

Changes:
1. **Add `entity_id` to `users`:**
   ```sql
   alter table users add column entity_id uuid not null references entities(id) on delete cascade;
   ```
   (In a fresh migration, just include `entity_id uuid not null references entities(id) on delete cascade` in the `create table`.)
2. **Change the uniqueness constraint** — `telegram_user_id` can no longer be globally unique (the same person exists once per entity). Replace `telegram_user_id bigint unique` with a composite:
   ```sql
   -- drop the global unique on telegram_user_id; add:
   unique (entity_id, telegram_user_id)
   ```
   **This is load-bearing:** without it, inserting the second entity's copy of a shared Telegram user violates the old global-unique constraint and the upsert fails.
3. **Replace the `users` policy** with the standard `entity_id` form, matching every other table (both `USING` and `WITH CHECK`):
   ```sql
   drop policy user_isolation on users;
   create policy user_isolation on users
     as restrictive
     using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
     with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);
   ```
4. **Add an index:** `create index idx_users_entity_id on users (entity_id);`
5. **Confirm the upsert code** sets the session entity *before* inserting/reading the user, and writes `entity_id` on insert. With the policy now keyed on `entity_id` (not membership), the orphan-on-insert problem disappears: a freshly inserted user is immediately visible within the session because it carries the matching `entity_id`.

## P2.3 — (INVARIANT / DOCS) Document the now-multiple `security definer` functions

The original Part-1 goal was "`resolve_entity_id_by_slug` is the *only* RLS-bypass path." Implementation reasonably added `resolve_entity_id_by_repo` (the GitHub sync webhook arrives with repo info, not a slug), and P2.1 adds `get_current_entity_secret`. So there are now **three** `security definer` functions. This is acceptable — each is minimal, single-purpose, and audited — but the invariant should be restated honestly so it stays controlled:

**Invariant (updated):** the database has exactly **three** `security definer` functions, and no others may be added without review. Each must be minimal and single-purpose:
- `resolve_entity_id_by_slug(text) -> uuid` — returns only an entity id for a known slug. Bootstrap for the Telegram webhook.
- `resolve_entity_id_by_repo(text, text) -> uuid` — returns only an entity id for a known owner/repo. Bootstrap for the GitHub sync webhook.
- `get_current_entity_secret(uuid) -> text` — returns one decrypted secret, **only** if it belongs to the current session entity (self-checks `app.current_entity_id`).

None of these returns arbitrary tenant data; the two resolvers return only a (non-secret) id, and the secret-fetch is session-scoped. Document this list (in the README security section and/or a comment block in the migration) so a future change doesn't casually add a fourth bypass.

## P2.4 — (MINOR) Deploy ordering: `bot_service` must exist before this migration

The migration's `grant ... to bot_service` statements fail if the role doesn't exist yet. The role creation (with its password, set from a secret — never committed) is a separate step. **Document in the deploy steps** (README) that `bot_service` must be created *before* running this migration, or split role creation into an earlier migration. Otherwise the first `db push` errors on the grants.

## P2.5 — (MINOR) Health-check Vault references

The `*_id` FKs to `vault.secrets` use `on delete set null`, so deleting a Vault secret silently nulls an entity's token reference — the bot for that entity then fails to authenticate in a possibly confusing way. Add a startup/health check (or an onboarding validation) that each entity's three secret references resolve to a live Vault secret, so a missing/deleted secret surfaces clearly rather than as a mysterious auth failure.

## Part 2 — verification checklist

- [ ] `grant select on vault.decrypted_secrets to bot_service` is **removed/revoked**; `bot_service` reaches secrets only via `get_current_entity_secret(...)`.
- [ ] `get_current_entity_secret` returns a secret for the **current** session entity but returns **nothing** when the session is set to a *different* entity (test cross-tenant: set entity A, request entity B's secret id → null/empty).
- [ ] `users` has `entity_id` (not null), the composite `unique (entity_id, telegram_user_id)`, an `entity_id` index, and the standard `entity_id`-based policy with **both `USING` and `WITH CHECK`**.
- [ ] The user-upsert path sets the session entity before insert and writes `entity_id`; a freshly inserted user is readable within the same session (orphan-on-insert resolved).
- [ ] Inserting a `users` row with a foreign `entity_id` is rejected by `WITH CHECK`.
- [ ] Exactly three `security definer` functions exist; each is minimal/single-purpose; the list is documented.
- [ ] Deploy steps state `bot_service` must exist before the schema migration runs.
- [ ] An entity with a missing/deleted Vault secret reference is caught by a health/startup check, not only at first auth failure.
