# Deployment & Setup Guide

> How to stand up the Kenntnis platform from scratch and onboard your first tenant. This is the operational runbook; for *what* the system is and *why* it's built this way, see `README.md` (overview) and `PLANNING.md` (architecture).

> **Structure:** **Part A** is one-time platform setup (do once). **Part B** is per-tenant onboarding (repeat for each entity — HYS, SymRes, etc.). The multi-tenant design means Part A is never repeated; adding a tenant is only Part B.

> **Ordering matters.** Several steps are prerequisites for later ones (the `bot_service` role must exist *before* the migration; Vault must be enabled *before* the migration; Vercel must be deployed *before* you can register webhooks). Follow the order as written.

> ⚠️ **Known gaps flagged inline as `[VERIFY]`** — a few steps depend on implementation details that should be confirmed against the current code/intended flow before relying on them. They're called out where they occur.

---

# Part A — One-Time Platform Setup

## A1. Prerequisites

Accounts/assets you need before starting:
- **Supabase** account (hosts Postgres + Vault).
- **Vercel** account (hosts the Next.js app).
- **GitHub** account (hosts per-tenant content repos; also where this platform repo lives).
- **Anthropic** API key (the model provider).
- **Domain:** `kenntnis.ai` (already registered). The platform will run on a subdomain, e.g. `api.kenntnis.ai`.

Local tooling:
- Node.js (version per `package.json` / Next 16 requirements).
- The Supabase CLI (`npm install supabase --save-dev`, run via `npx supabase`) — or use the Supabase dashboard SQL editor (see A5 caveat).

## A2. Create the Supabase project

1. Create a new Supabase project. Note the **project ref**, region, and the database password you set.
2. From **Project Settings → Database**, collect the connection details (host, port, database name). You'll build the `bot_service` connection string from these in A6.

> **Project-creation options — leave these OFF:**
> - **"Enable automatic RLS"** (the event trigger that auto-enables RLS on every new `public` table): **do not enable.** This platform's RLS is **explicit and intentional in the migration** — each table is `enable`d + `force`d with specific `USING`/`WITH CHECK` policies you can read in one file (`supabase/migrations/...`). That explicitness is what makes the security model auditable (see `SECURITY-PROPOSAL.md`). An auto-enable trigger is redundant and *risky*: it enables RLS but creates **no policies**, and a table with RLS-on-but-no-policies denies all access by default — which can produce confusing "permission denied / zero rows" failures on any future table, traceable only to an invisible project-level trigger. Keep RLS the migration's job, not a background trigger's.
> - **GitHub repo integration** (linking this repo so Supabase auto-runs migrations on push): **skip it, at least for the first deploy.** Migrations must run *after* the `bot_service` role exists (A4 → A5 ordering); an auto-apply-on-push integration could run the migration before the role exists and fail. Run migrations **manually** (A5) so you control the timing. (This is unrelated to the per-tenant *content-repo* webhooks in Part B — those are a different thing and are required.)

## A3. Verify Vault is available (usually no action needed)

The migration references `vault.secrets` and `vault.decrypted_secrets`. **On current Supabase projects Vault ships already provisioned** (the `supabase_vault` extension, pgsodium-free as of v0.3.x — verified on this project). So this step is normally **verify, not create**:

```sql
select extname, extversion from pg_extension where extname = 'supabase_vault';
select * from vault.secrets limit 1;            -- should run (0 rows is fine)
select * from vault.decrypted_secrets limit 1;  -- should run (0 rows is fine)
```

- If those queries succeed, Vault is ready — proceed to A4.
- Only if `vault.secrets` errors with "relation does not exist" do you need to enable it: `create extension if not exists supabase_vault;` (and on current projects you generally won't).
- **Note:** the Supabase dashboard's Extensions list can be confusing here — Vault's underlying crypto historically showed as `pgsodium`, and current projects are pgsodium-*free*, so don't go hunting for a `supabase_vault` toggle. The SQL check above is the reliable confirmation.

## A4. Create the `bot_service` role (BEFORE the migration)

The migration `GRANT`s privileges to `bot_service` but does **not** create the role — so it must exist first, or the migration fails on the grant statements.

**This role is security-critical.** The entire tenant-isolation model depends on the app connecting as this least-privilege, RLS-subject role — **never** the `postgres` superuser and **never** a service-role connection (both bypass RLS). See `SECURITY-PROPOSAL.md` for the rationale.

Run this in the Supabase SQL editor (the password lives only here and in the Vercel env var — never commit it):

```sql
create role bot_service with login password 'CHOOSE_A_STRONG_PASSWORD';
```

## A5. Run the schema migration

Apply `supabase/migrations/20260618000000_init_schema.sql`. This creates all tables, indexes, RLS policies (with `USING` + `WITH CHECK`), the three `SECURITY DEFINER` bootstrap functions, and `EXECUTE` grants to `bot_service`.

- **Preferred:** `npx supabase db push` (keeps the CLI migration history in sync).
- **Alternative:** paste the migration into the dashboard SQL editor and run it.
  - `[VERIFY]` Note: running migrations via the SQL editor can desync the CLI's migration history if you later adopt `supabase db push`. Pick one approach and stick with it. For a first deploy the SQL editor is fine; if you intend to use the CLI long-term, use `db push` from the start.

> Reminder: this step **will fail** if A3 (Vault) or A4 (`bot_service` role) haven't been done — both are prerequisites.

## A6. Table privileges for `bot_service` (now handled by the migration)

✅ **No action needed here** — table privileges are granted **inside the migration** (section 5, after the `grant execute` lines): `usage` on schema, `select/insert/update/delete` on all tables, sequence usage, and `alter default privileges` for future tables. So A5 already gave `bot_service` the base privileges it needs.

> Context: table privilege and row-level policy are two distinct layers — the grant lets the role *address* the tables; RLS (with `USING` + `WITH CHECK`) scopes it to its tenant. Both are required, and both are now in the migration. (Earlier drafts required a manual grant step here; that gap was closed — see BACKLOG B0.)

> Verify the grants applied (works in the SQL editor):
> ```sql
> select grantee, table_name, privilege_type
> from information_schema.role_table_grants
> where grantee = 'bot_service'
> order by table_name, privilege_type;
> ```
> Expect **32 rows** — all 8 tables (`entities`, `groups`, `users`, `memberships`, `manifest_entries`, `doc_cache`, `message_log`, `processed_updates`) × 4 privileges (SELECT/INSERT/UPDATE/DELETE). If they're present, the grants worked.
>
> **Do NOT use `set role bot_service` in the Supabase SQL editor** — it fails with `permission denied to set role "bot_service"`, because the SQL editor's role isn't a member of `bot_service`. That's an editor limitation, not a grant problem. The `information_schema` query above is the correct in-editor check. (The authoritative end-to-end test is connecting *as* `bot_service` via the app's `DATABASE_URL` — which the A7 deploy + A9 smoke test exercises.)

## A7. Deploy the app to Vercel

1. Connect the `telegram-bot-platform` GitHub repo to a new Vercel project.
2. Set the environment variables (the complete set the code reads — confirmed against the route handlers and `lib/`):

   | Variable | Value | Notes |
   |---|---|---|
   | `DATABASE_URL` | the **transaction-mode pooler** string (see below) | **Must be the `bot_service` role**, not `postgres`. Mark **Sensitive** in Vercel. |
   | `ANTHROPIC_API_KEY` | your Anthropic key | Mark Sensitive. |
   | `GITHUB_WEBHOOK_SECRET` | a strong shared secret | **Global** signing secret for the GitHub sync webhook (shared across all tenants — see B7). Generate via a password manager (a passphrase is fine — GitHub accepts any string); **save it** — you re-enter this same value into every tenant's GitHub webhook (B7). Mark Sensitive. |

   > **⚠️ `DATABASE_URL` MUST be the transaction-mode POOLER string, not the direct connection.** This bit us on the first deploy: the **direct** connection host (`db.PROJECT_REF.supabase.co:5432`) is **unreachable from Vercel** — the function crashes with `getaddrinfo ENOTFOUND db.PROJECT_REF.supabase.co` (the direct host is IPv6-oriented and serverless can't resolve/reach it). Use the **Supavisor transaction pooler** instead. Get it from **Supabase → Project Settings → Database → Connection string → "Connection pooling" / Transaction mode**. It differs from the direct string in three ways:
   > - **Host:** `aws-<n>-<region>.pooler.supabase.com` (e.g. `aws-1-us-west-2.pooler.supabase.com`), not `db.<ref>.supabase.co`
   > - **Port:** `6543` (transaction mode), not `5432`
   > - **Username:** the project ref is appended to the role — **`bot_service.PROJECT_REF`** (e.g. `bot_service.eomnjhbjrkfcpzzbcdho`), not bare `bot_service`
   >
   > The dashboard shows the pooler string with the `postgres` user — **swap `postgres` → `bot_service`** (keeping the `.PROJECT_REF` suffix) and use the **`bot_service` password** (the one from A4, in your password manager — NOT the project/postgres database password; the username and password must be for the same role). Final form:
   > ```
   > postgresql://bot_service.PROJECT_REF:BOT_SERVICE_PASSWORD@aws-<n>-<region>.pooler.supabase.com:6543/postgres
   > ```
   > (`postgres://` and `postgresql://` are identical schemes — either works; that is NOT the issue if a connection fails.)

   > **⚠️ Code requirement: `prepare: false` for the transaction pooler.** The `postgres` npm client (`lib/supabase.ts`) uses prepared statements by default, which the Supavisor **transaction** pooler (port 6543) does NOT support. After fixing the host, a successful connection will then fail *queries* with a prepared-statement error unless `lib/supabase.ts` initializes the client with `prepare: false`:
   > ```js
   > postgres(connectionString, { max: 10, idle_timeout: 20, connect_timeout: 10, prepare: false })
   > ```
   > (Alternative: use the **session** pooler on port 5432, which supports prepared statements — but transaction mode + `prepare: false` is the right choice for serverless. Confirm `prepare: false` is set before relying on the deploy.)

   > `[VERIFY]` These three are the only env vars the current code reads (`lib/supabase.ts` → `DATABASE_URL`; `lib/anthropic.ts` → `ANTHROPIC_API_KEY`; the GitHub sync route → `GITHUB_WEBHOOK_SECRET`). The unused `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are intentionally NOT used (see `.env.example`). Confirm no other env var has been introduced before relying on this list.

3. Deploy. Note the production URL Vercel assigns.

## A8. Point the domain at Vercel

1. In Vercel, add a custom domain for the platform — recommended: a subdomain like **`api.kenntnis.ai`** (leaves the apex `kenntnis.ai` free for a future landing page).
2. Add the DNS records Vercel specifies (CNAME/A) at your registrar (GoDaddy).
3. Wait for DNS propagation + Vercel's TLS cert to issue. Confirm `https://api.kenntnis.ai` resolves to the app.

> All tenant webhook URLs will be built on this domain (`https://api.kenntnis.ai/api/webhooks/...`), so they stay stable and owned by you regardless of the underlying Vercel deployment.

## A9. Platform smoke test (curl — verified)

These three curls confirm the app is deployed, routing, authenticating, and — critically — **reaching the database**, all *before* any tenant exists. Run them against the live domain; watch the **Vercel logs** alongside (Dashboard → project → Logs) for the definitive signal.

**1. Endpoint alive (no DB):**
```bash
curl -i https://api.kenntnis.ai/api/webhooks/github/sync
```
Expect **405** (GET on a POST route) — confirms the route exists and the app is serving (not a 404).

**2. GitHub auth works (no DB):**
```bash
curl -i -X POST https://api.kenntnis.ai/api/webhooks/github/sync \
  -H "Content-Type: application/json" -d '{"test": true}'
```
Expect **401** (invalid/missing signature). Log: `Unauthorized GitHub sync attempt (invalid signature)`. A *clean* 401 (not a 500) confirms the handler runs and its HMAC check works.

**3. Database connection works (this one hits Postgres):**
```bash
curl -i -X POST https://api.kenntnis.ai/api/webhooks/telegram/nonexistent \
  -H "Content-Type: application/json" \
  -H "x-telegram-bot-api-secret-token: wrong" \
  -d '{"update_id": 1, "message": {"text": "test"}}'
```
The bogus slug `nonexistent` forces a `resolve_entity_id_by_slug` lookup — which **requires a working DB connection**. Interpreting the result:
- **404 + log `Webhook triggered for unknown tenant slug: nonexistent`** → ✅ the DB was queried, no such entity, clean rejection. **`DATABASE_URL` (pooler) is confirmed working end to end.**
- **500 + log `getaddrinfo ENOTFOUND db.PROJECT_REF.supabase.co`** → `DATABASE_URL` is still the **direct** connection; fix it to the pooler string (see A7).
- **500 + a prepared-statement error** → add `prepare: false` to `lib/supabase.ts` (see A7).

When test 3 returns a clean 404 with the "unknown tenant slug" log line, **Part A is verified complete** — platform deployed, domain live, database reachable via the pooler.

> `[VERIFY]` (nice-to-have) There's a `checkVaultSecretsHealth(entityId)` capability in `lib/capabilities.ts` with no route exposing it. A small admin/health endpoint running it per entity would let you verify an entity's Vault references resolve before going live (BACKLOG). Until then, the first real `/ask` (B9) is the per-tenant end-to-end test.

Platform setup is complete. Everything below is per-tenant.

---

# Part B — Per-Tenant Onboarding (repeat per entity)

> Example uses HYS. Repeat for SymRes, Theäta, etc. Each tenant = its own Telegram bot, its own content repo, one entity row, one or more group rows, manifest entries, and Vault secrets.

## B1. Create the Telegram bot (BotFather)

1. In Telegram, message **@BotFather** → `/newbot`. Set a name and a username (the username must end in `bot`, e.g. `kenntnis_hys_bot`).
2. Save the **bot token** BotFather gives you.
3. **Disable privacy mode:** BotFather → `/setprivacy` → select the bot → **Disable**. (Required so the bot can see group messages / @mentions, not just commands.)
4. Add the bot to the target Telegram **supergroup** (the one with Topics/forum enabled). It should be a regular member; it does not need admin.
5. Record the bot's exact **username** (bare, no `@`) — it's stored in the entity row and used for mention detection.

## B2. Generate the per-tenant secrets

You'll store three secrets for this tenant in Vault (B3):
- **Telegram bot token** (from B1).
- **Telegram webhook secret** — generate a strong random hex string, e.g. `openssl rand -hex 32 | tr -d '\n'`. (The `tr -d '\n'` matters — a trailing newline silently breaks the header comparison. Known footgun.)
- **GitHub token** — a fine-grained PAT scoped to *this tenant's content repo only* (Contents: read; add Pull requests: read/write later when write-commands ship). Per-tenant scoping keeps the platform's GitHub access tenant-isolated.

## B3. Store the secrets in Supabase Vault

Insert each secret into Vault and capture its returned `id` (UUID). Run in the SQL editor:

```sql
-- Returns the UUID of the stored secret; capture each one.
select vault.create_secret('THE_BOT_TOKEN',         'hys_telegram_bot_token');
select vault.create_secret('THE_WEBHOOK_SECRET',    'hys_telegram_webhook_secret');
select vault.create_secret('THE_GITHUB_PAT',        'hys_github_token');
```

`[VERIFY]` Confirm the exact Vault insertion API for your Supabase version (`vault.create_secret(secret, name)` is the common signature; some versions differ). Record the three returned UUIDs for B5.

> Note: `bot_service` cannot read these directly (no grant on `vault.decrypted_secrets`); it can only decrypt its own entity's secrets via `get_current_entity_secret`, and only inside an RLS session. Inserting secrets here is an admin action done as a privileged role in the SQL editor.

## B4. Prepare the content repo

1. Create (or designate) this tenant's **GitHub content repo**, e.g. `dwenderf/hys-context`. This holds the markdown docs the bot answers from.
2. Create a `context/` directory (matches the default `context_root`) with at least one general doc, e.g. `context/overview.md`.
3. Ensure the per-tenant GitHub PAT (B2) has access to this repo.

## B5. Insert the entity + group rows

These writes go to RLS-protected tables, so they must run **inside the entity's session context.** The cleanest way is to set the session and insert in one transaction. In the SQL editor:

```sql
-- Insert the entity, referencing the three Vault secret UUIDs from B3.
insert into entities (
  slug, display_name, github_owner, github_repo, github_branch, context_root,
  telegram_bot_username, excluded_thread_ids,
  telegram_bot_token_id, telegram_webhook_secret_id, github_token_id
) values (
  'hys', 'Hudson Yards Studios', 'dwenderf', 'hys-context', 'main', 'context',
  'kenntnis_hys_bot', '{}',
  'BOT_TOKEN_SECRET_UUID', 'WEBHOOK_SECRET_UUID', 'GITHUB_TOKEN_UUID'
)
returning id;
```

`[VERIFY]` **RLS on insert:** because `entities` has a `WITH CHECK` policy keyed on `app.current_entity_id`, inserting a *new* entity is a chicken-and-egg case (the id doesn't exist yet to set in the session). Confirm how Antigravity intends initial entity creation to happen — most likely it's an **admin action run as a privileged role** (the Supabase SQL editor connects as `postgres`, which bypasses RLS, so the insert works there). This is fine for manual onboarding: entity *creation* is a privileged admin operation; only the *running app* uses `bot_service`. Document this clearly so no one tries to create entities via the `bot_service` connection.

Then capture the returned `entity_id` and insert the group(s):

```sql
insert into groups (entity_id, telegram_chat_id, display_name)
values ('THE_ENTITY_ID', -1001234567890, 'HYS Board');
```

> `telegram_chat_id` is the supergroup's chat id (large negative number). Get it from the Telegram API or a quick `getUpdates` call after the bot is in the group.

## B6. Seed the manifest + initial context

1. Push the content docs to the repo's `context/` dir (B4) and merge to `main`.
2. Insert manifest entries mapping topics → docs. For v1 (entity-general + per-topic):

```sql
-- Entity-general doc (thread_id NULL = loads for every topic)
insert into manifest_entries (entity_id, telegram_thread_id, doc_path)
values ('THE_ENTITY_ID', null, 'context/overview.md');

-- (Optional) a per-topic doc: thread_id = the Telegram topic's message_thread_id
insert into manifest_entries (entity_id, telegram_thread_id, doc_path)
values ('THE_ENTITY_ID', 78, 'context/some-topic.md');
```

3. **Populate the cache.** The bot reads from `doc_cache`, not GitHub directly — so the docs must be synced into the cache. Two ways:
   - Trigger the GitHub sync (B7) by pushing/merging a commit, which populates `doc_cache` automatically; or
   - `[VERIFY]` For initial seed, you may need a manual first-sync (there's no standalone "rebuild cache" endpoint yet — BACKLOG candidate). Simplest path: set up the GitHub webhook (B7) first, then make a trivial commit to the content repo to trigger a full sync of the changed files.

## B7. Register the GitHub sync webhook

On the tenant's **content repo** (GitHub → Settings → Webhooks → Add webhook):
- **Payload URL:** `https://api.kenntnis.ai/api/webhooks/github/sync`  *(no slug — the handler resolves the entity by repo owner/name)*
- **Content type:** `application/json`
- **Secret:** the **global** `GITHUB_WEBHOOK_SECRET` from A7 (same value for every tenant — the handler verifies HMAC with this one secret, then resolves the entity from the repo).
- **Events:** Just the `push` event.

> Because the signing secret is global, all tenants' content repos use the *same* webhook secret; tenant resolution happens by repo identity, not by the secret. Keep that secret strong and protected.

## B8. Register the Telegram webhook

Point Telegram at this tenant's slug-specific endpoint, with the per-tenant webhook secret (the *plaintext* value from B2, the same one stored in Vault):

```bash
SECRET="THE_WEBHOOK_SECRET_PLAINTEXT"   # same value stored in Vault in B3
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=https://api.kenntnis.ai/api/webhooks/telegram/hys" \
  --data-urlencode "secret_token=${SECRET}"
```

> The URL ends in the entity **slug** (`/hys`). The `secret_token` is what Telegram sends in the `x-telegram-bot-api-secret-token` header; the handler compares it to the Vault-stored `telegram_webhook_secret`. They must match exactly (mind trailing newlines).
> If re-registering, `deleteWebhook?drop_pending_updates=true` first to clear any queued updates.

## B9. Test end-to-end

1. In a topic of the group, send `/help` → expect the static help reply in-thread.
2. Send `/ask <a question answerable from the seeded context>` → expect the 👀 reaction, then a typing indicator, then an HTML-formatted answer in the correct topic.
3. `@mention` the bot with a question → same as `/ask`.
4. Edit a context doc → PR → merge to `main` → confirm the GitHub sync updates `doc_cache` (the next `/ask` reflects the change).

Tenant is live. Repeat Part B for the next entity.

---

# Appendix — Quick reference

**Webhook URLs:**
- Telegram (per-tenant): `https://api.kenntnis.ai/api/webhooks/telegram/{slug}`
- GitHub sync (shared, resolves by repo): `https://api.kenntnis.ai/api/webhooks/github/sync`

**Environment variables (platform-wide):** `DATABASE_URL` (bot_service), `ANTHROPIC_API_KEY`, `GITHUB_WEBHOOK_SECRET`.

**Per-tenant secrets (in Vault):** telegram bot token, telegram webhook secret, github token.

**The three `SECURITY DEFINER` functions** (the only sanctioned RLS-bypass surfaces): `resolve_entity_id_by_slug`, `resolve_entity_id_by_repo`, `get_current_entity_secret`. See `SECURITY-PROPOSAL.md`.

**Prerequisite ordering (the parts that bite if done out of order):** Vault verified → `bot_service` role created → migration run (grants included) → app deployed (pooler `DATABASE_URL`) → domain live → webhooks registered.

---

## Open items this guide surfaced (for BACKLOG / Antigravity confirmation)

- **`prepare: false` in `lib/supabase.ts`** (A7) — required for the Supavisor transaction pooler (port 6543); without it, queries fail with prepared-statement errors once connected. Confirm it's set in the client init.
- **No cache-rebuild / seed endpoint** (B6) — initial doc-cache population relies on triggering the GitHub webhook. A standalone "rebuild entity cache from repo" admin function would make onboarding and recovery cleaner.
- **`checkVaultSecretsHealth` is not exposed via any route** (A9) — wire it to a small admin/health endpoint for pre-launch verification.
- **Entity-creation RLS path** (B5) — document/confirm that initial entity creation is a privileged admin action (SQL editor as `postgres`), since `bot_service` + `WITH CHECK` cannot bootstrap the first row of a new entity.
- **`package.json` name is still `temp-next`** — rename to the project.
- **Vault insertion API** (B3) — confirm exact `vault.create_secret(secret, name)` signature for the current Supabase version (to be verified during the first Part B onboarding).

### Resolved during first deploy (2026-06-19)
- **Table-privilege grants** — now in the migration (BACKLOG B0); A5 produces a working role in one step. Verified: 32 grant rows.
- **Migration application** — `npx supabase db push` used successfully (after `bot_service` role created first).
- **Vault** — already provisioned (v0.3.1, pgsodium-free); verify-not-create (A3).
- **`DATABASE_URL`** — must be the transaction-mode pooler string, not direct (A7); direct host fails `ENOTFOUND` from Vercel.
- **A6 sanity check** — `set role` fails in the SQL editor; use the `information_schema.role_table_grants` query.
