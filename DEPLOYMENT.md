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

## A3. Enable the Vault extension

The migration references `vault.secrets` and `vault.decrypted_secrets`, so **Vault must be enabled before running it.**

- In the Supabase dashboard: **Database → Extensions**, enable **`supabase_vault`** (Vault). (On most Supabase projects Vault is available; confirm it's enabled.)
- `[VERIFY]` Confirm the `vault` schema and `vault.decrypted_secrets` view exist in your project before proceeding.

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

## A6. Grant table privileges to `bot_service` (REQUIRED — not in the migration)

⚠️ **This step is essential and is NOT included in the migration.** The migration grants only `EXECUTE` on the four functions. It does **not** grant table-level `SELECT/INSERT/UPDATE/DELETE` to `bot_service`. Without these grants, RLS is configured but the role has no base privilege to touch the tables at all — the app will fail with permission errors despite a correct security model.

`[VERIFY]` Confirm whether Antigravity intends these grants to live in the migration (preferred — they should) or as a separate setup step. Until they're in the migration, run this after A5:

```sql
grant usage on schema public to bot_service;

grant select, insert, update, delete on
  entities, groups, users, memberships, manifest_entries,
  doc_cache, message_log, processed_updates
to bot_service;

-- message_log uses a bigserial PK, so its sequence needs usage
grant usage, select on all sequences in schema public to bot_service;
```

> **Recommendation (BACKLOG item):** fold these grants into the migration itself so a fresh deploy is one step and can't be forgotten. Granting on tables is correct here precisely *because* RLS still constrains which rows the role can see/write — table privilege and row policy are two different layers, and both are needed.

## A7. Deploy the app to Vercel

1. Connect the `telegram-bot-platform` GitHub repo to a new Vercel project.
2. Set the environment variables (the complete set the code reads — confirmed against the route handlers and `lib/`):

   | Variable | Value | Notes |
   |---|---|---|
   | `DATABASE_URL` | `postgres://bot_service:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres` | **Must be the `bot_service` role**, not `postgres`. Mark **Sensitive** in Vercel. |
   | `ANTHROPIC_API_KEY` | your Anthropic key | Mark Sensitive. |
   | `GITHUB_WEBHOOK_SECRET` | a strong random secret you generate | **Global** signing secret for the GitHub sync webhook (shared across all tenants — see B7). Mark Sensitive. |

   > `[VERIFY]` These three are the only env vars the current code reads (`lib/supabase.ts` → `DATABASE_URL`; `lib/anthropic.ts` → `ANTHROPIC_API_KEY`; the GitHub sync route → `GITHUB_WEBHOOK_SECRET`). The unused `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are intentionally NOT used (see `.env.example`). Confirm no other env var has been introduced before relying on this list.

3. Deploy. Note the production URL Vercel assigns.

## A8. Point the domain at Vercel

1. In Vercel, add a custom domain for the platform — recommended: a subdomain like **`api.kenntnis.ai`** (leaves the apex `kenntnis.ai` free for a future landing page).
2. Add the DNS records Vercel specifies (CNAME/A) at your registrar (GoDaddy).
3. Wait for DNS propagation + Vercel's TLS cert to issue. Confirm `https://api.kenntnis.ai` resolves to the app.

> All tenant webhook URLs will be built on this domain (`https://api.kenntnis.ai/api/webhooks/...`), so they stay stable and owned by you regardless of the underlying Vercel deployment.

## A9. Platform smoke test

- Confirm the app responds at the domain.
- `[VERIFY]` There's a `checkVaultSecretsHealth(entityId)` capability in `lib/capabilities.ts`, but no route currently exposes it. Consider adding a small admin/health endpoint that runs it per entity (BACKLOG), so you can verify an entity's Vault references resolve before going live. Until then, the first real `/ask` (B8) is the end-to-end test.

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

**Prerequisite ordering (the parts that bite if done out of order):** Vault enabled → `bot_service` role created → migration run → table grants → app deployed → domain live → webhooks registered.

---

## Open items this guide surfaced (for BACKLOG / Antigravity confirmation)

- **Table privilege grants are missing from the migration** (A6) — fold `GRANT SELECT/INSERT/UPDATE/DELETE ... TO bot_service` (and sequence usage) into the migration so a fresh deploy is complete in one step. *This is the most important gap — without it the app cannot touch the tables.*
- **No cache-rebuild / seed endpoint** (B6) — initial doc-cache population relies on triggering the GitHub webhook. A standalone "rebuild entity cache from repo" admin function would make onboarding and recovery cleaner.
- **`checkVaultSecretsHealth` is not exposed via any route** (A9) — wire it to a small admin/health endpoint for pre-launch verification.
- **Entity-creation RLS path** (B5) — document/confirm that initial entity creation is a privileged admin action (SQL editor as `postgres`), since `bot_service` + `WITH CHECK` cannot bootstrap the first row of a new entity.
- **`package.json` name is still `temp-next`** — rename to the project.
- **Vault insertion API** (B3) and **migration-application method** (A5) — confirm exact commands for the current Supabase version / intended workflow.
