# Deployment & Setup Guide

> How to stand up the Kenntnis platform from scratch and onboard your first tenant. This is the operational runbook; for *what* the system is and *why* it's built this way, see `README.md` (overview) and [`docs/PLANNING.md`](./docs/PLANNING.md) (architecture). Other design docs live in [`docs/`](./docs/) (`SECURITY-PROPOSAL.md`, `MANAGEMENT-PROPOSAL.md`, `BACKLOG.md`) and feature specs in `docs/specs/`.

> **Structure — three flows:**
> - **Part A** — one-time **platform** setup (do once, ever).
> - **Part B** — onboard a **new entity** (new tenant): creates the entity + its first group + its bot + secrets + content (pushed directly into the cache) + the Telegram webhook. Repeat per entity (HYS, SymRes, Theäta…).
> - **Part C** — add **another group to an existing entity** (e.g. a second HYS group). Lightweight: reuses the entity's existing bot, content, and webhook — just a new Telegram group + one `groups` row. No new entity/bot/content/webhook.
>
> The multi-tenant design means Part A is never repeated; a new tenant is Part B; an additional group under an existing tenant is Part C.

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

> **⚠️ RLS policies must be PERMISSIVE, not RESTRICTIVE.** A second migration (`20260621000000_fix_rls_permissive.sql`) corrects an early bug where all eight policies were created `as restrictive`. **Restrictive policies can only *filter* what permissive policies grant** — with no permissive policy, they grant nothing, so `bot_service` gets **zero rows on every table**. This is invisible during setup (the SQL editor connects as `postgres` and bypasses RLS) and only surfaces at runtime as a **`{"error":"Tenant config mismatch"}` 404** on the first real request as `bot_service`. `db push` applies both migrations. **Verify after pushing:**
> ```sql
> select tablename, policyname, permissive from pg_policies
> where schemaname = 'public' order by tablename;
> ```
> All eight must show **`PERMISSIVE`**. (A permissive policy `using (... = app.current_entity_id)` is still fully tenant-isolating — it grants only the session entity's rows and hides all others. Permissive vs restrictive is fixed at creation, so the fix is drop + recreate.)

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
   | `ANTHROPIC_MODEL` | a current model id, e.g. `claude-sonnet-4-6` | Platform-wide default model. **Not** sensitive. |
   | `GITHUB_WEBHOOK_SECRET` | a strong shared secret | **Only needed if the optional GitHub sync-source is enabled** (not used in v1). If used: global HMAC secret, generate via password manager, save it. Mark Sensitive. |
   | `NEXT_PUBLIC_SUPABASE_URL` | your Supabase project URL | Public, required for client-side Auth & DB queries. |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | your Supabase publishable public key | Public, required for client-side Auth & DB queries. `key sb_publishable_...` |
   | `NEXT_PUBLIC_APP_NAME` | the brand-config product name | Custom branding, defaults to `'Agent Platform'`. |
   | `NEXT_PUBLIC_APP_URL` | the base URL of the Next.js app | Base URL for magic-link redirect endpoints, e.g. `https://api.yourdomain.com`. |

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

   > `[VERIFY]` The current code reads `DATABASE_URL`, `ANTHROPIC_API_KEY`, `GITHUB_WEBHOOK_SECRET`, and the client-exposed variables `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_NAME`, and `NEXT_PUBLIC_APP_URL` for brand management and OTP redirects. Confirm no other env vars are expected.

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

# Part B — Onboard a New Entity (new tenant)

> Use this flow to onboard a **brand-new entity** (tenant). It creates the entity, its **first** group, its bot, secrets, and its content (pushed directly into the cache). Example uses HYS (first group: "HYS Internal"). Repeat the whole flow per *new* entity (SymRes, Theäta, …).
>
> **v1 content model:** content lives **directly in the `doc_cache` table** — there is **no GitHub** in the v1 path. (The store is abstracted; GitHub/Drive/other sources can plug in later as optional sync-sources that populate the same cache — see `PLANNING.md`. The GitHub-sync code exists but is not used in v1.)
>
> **Adding a *second* group to an entity that already exists** (e.g. "HYS Board" alongside "HYS Internal") is **not** this flow — it's the much shorter **Part C**, which reuses the entity's existing bot, content, and webhook.

## B1. Create the Telegram group + bot

### B1a. Create the group — with **Topics enabled** (required)

1. In Telegram, create a new group, then **convert/upgrade it to a supergroup** if it isn't one already (adding members or enabling Topics generally triggers this automatically).
2. **Enable Topics (forum mode) — this is a hard requirement, not optional.** Group **Settings → Topics → toggle on** (the exact path varies by client; on mobile it's under *Edit → Topics*). The entire context-routing model depends on Topics: the bot routes context and replies by `message_thread_id`, logs messages per topic, and supports per-topic context docs. **Without Topics enabled, topic-scoped features don't work** and there are no thread ids to map manifest entries to. Enable it before doing anything else with the group.

> Why it's load-bearing: every message in a forum group carries a `message_thread_id` (except the *General* topic, which is null). The platform keys context resolution, message logging, and replies to that thread id (see `docs/PLANNING.md` §2.7 / §3.3). A non-forum group has no thread ids, so the per-topic model collapses.
>
> ⚠️ **Enable Topics FIRST — before adding the bot or recording the chat_id (it changes the chat_id).** Enabling Topics on a plain group **upgrades it to a supergroup, which migrates it to a NEW `telegram_chat_id`** (it gains the `-100…` supergroup prefix — e.g. `-5577480409` becomes `-1001234567890`). If you enable Topics *first* (as ordered here), you'll only ever capture the final `-100…` id in B4, and there's no problem. **But if Topics is enabled AFTER you've already inserted the `groups` row** (or after the bot was working), the stored `telegram_chat_id` is now **stale** — Telegram delivers messages under the new id, the handler finds no matching `groups` row, and the bot **silently stops responding** (it logs the message as an *untracked chat id*). Fix: update the row to the new id — `update groups set telegram_chat_id = <new -100… id> where id = '<group row id>';` (get the new id the same way as B4: send a message and read the “untracked chat ID” Vercel log line). This footgun is the reason for the ordering.

### B1b. Create the bot (BotFather)

1. In Telegram, message **@BotFather** → `/newbot`. Set a name (the human-facing **display name**, free-form) and a **username** (must end in `bot`/`Bot` — case-insensitive; Latin letters/digits/underscores; 5–32 chars; globally unique). E.g. display name "HYS Assistant", username `kenntnis_hys_bot`.
2. Save the **bot token** BotFather gives you.
3. **Disable privacy mode — required:** BotFather → `/setprivacy` → select the bot → **Disable**. With privacy ON (the default), the bot only receives commands/mentions/replies, **not ordinary group messages** — so the recent-conversation feature silently degrades (the bot answers but can't reflect the live discussion). **Ordering gotcha:** privacy mode only applies to groups the bot joins *after* the setting is changed. So disable privacy **before** adding the bot to the group; if the bot is already in the group, **remove and re-add it**.
4. Add the bot to the **Topics-enabled supergroup from B1a**, as a regular member (no admin needed). **Autocomplete gotcha:** a freshly-created bot often isn't cached yet, so it may not appear when you type `@` — **type the full username** explicitly.
5. Record the bot's exact **username** (bare, no `@`) — it's stored in the entity row and used for mention detection (matching is case-insensitive).
6. **Confirm privacy is off:** after the webhook is set (B6), send a plain (non-command) message in a topic — it should produce a `message_log` row (and, before the group is tracked, an “untracked chat ID” log line). If only *commands/mentions* ever reach the bot and plain messages don't, privacy is still on — re-disable it and re-add the bot.

## B2. Generate the per-tenant secrets

v1 stores **two** secrets for this tenant in Vault (B3):
- **Telegram bot token** (from B1).
- **Telegram webhook secret** — generate a strong random hex string, e.g. `openssl rand -hex 32 | tr -d '\n'`. (The `tr -d '\n'` matters — a trailing newline silently breaks the header comparison. Known footgun.)

*(No GitHub PAT in v1 — content is pushed directly into the cache in B5, so there is no GitHub token to create, scope, or rotate. The `github_token_id` column stays null.)*

## B3. Store the secrets in Supabase Vault

> **Decide your entity `slug` now** (e.g. `hys`) — you'll use it in the secret **labels** here *and* in the entity row in B4. It must be lowercase, URL-safe, and stable (full rules in B4). Picking it now keeps the secret names self-documenting.

Insert each secret into Vault and capture its returned `id` (UUID). The call signature is **`vault.create_secret(secret, secret_name)`** — `secret` = the real value, `secret_name` = the label. Run these in the SQL editor **one at a time**, capturing each returned UUID. **Replace BOTH placeholders in each statement** (the `<...>` markers) before running; nothing here is runnable as-is.

**Secret 1 — the bot token** (the value from BotFather, B1b):
```sql
select vault.create_secret(
  '<PASTE_REAL_BOT_TOKEN>',          -- secret: the real token, e.g. 123456:ABC-...
  'telegram_bot_token_<slug>'        -- secret_name: replace <slug>, e.g. telegram_bot_token_hys
);
```

**Secret 2 — the webhook secret** (the random hex from B2):
```sql
select vault.create_secret(
  '<PASTE_REAL_WEBHOOK_SECRET>',     -- secret: the real 64-char hex from B2
  'telegram_webhook_secret_<slug>'   -- secret_name: replace <slug>, e.g. telegram_webhook_secret_hys
);
```

Capture both returned UUIDs — you'll reference them in B4 as `telegram_bot_token_id` and `telegram_webhook_secret_id` respectively.

> **Why slug-based labels (not generic names like `WEBHOOK_SECRET`):** `vault.secrets.name` has a **partial unique index** (`secrets_name_idx` — unique where name is not null), so **names must be unique** — you literally can't create a second secret named `WEBHOOK_SECRET`. Per-entity labels (`..._hys`, `..._symres`) are unique by construction *and* self-documenting: `select name from vault.secrets` tells you which entity owns each secret at a glance. (Only the `id` UUID is referenced by the entity row; the label is purely for human lookup — but with multiple entities, a good label is what saves you.)

> ⚠️ **DO NOT SWAP THE ARGUMENTS.** This is the single easiest mistake to make here, and it fails *silently* until the first `/ask`. If you put the **label** first and the **real secret** second, the bot's webhook auth will reject every message (the handler compares the stored *value* — which would be your label — against what Telegram sends), and worse, **your real secret ends up sitting in plaintext in the `name` column** (the `name` is NOT encrypted; only the value is). First arg = real secret, second arg = label. Always.

> ✅ **Verify immediately** that value and name landed in the right columns (catches the swap before it bites):
> ```sql
> select name, decrypted_secret, length(decrypted_secret) as len
> from vault.decrypted_secrets
> order by created_at desc limit 2;
> ```
> `decrypted_secret` should be the **real secret** (e.g. the webhook secret is a 64-char hex → `len` 64); `name` should be your **label** (`telegram_..._hys`). If they're reversed (`decrypted_secret` shows your label and `name` shows the real secret), fix with `vault.update_secret(id, '<real value>', '<label>')` — see *Managing & Rotating Secrets*.

> ✅ **Verified (first onboarding):** `vault.create_secret(secret, name)` works as written and returns the secret's UUID. Record the two UUIDs for B4.

> Note: `bot_service` cannot read these directly (no grant on `vault.decrypted_secrets`); it can only decrypt its own entity's secrets via `get_current_entity_secret`, and only inside an RLS session. Inserting secrets here is an admin action done as a privileged role in the SQL editor.

## B4. Insert the entity + group rows

Run in the SQL editor (which connects as `postgres` and **bypasses RLS** — this is the correct path for entity creation; see the note below).

```sql
-- Insert the entity, referencing the two Vault secret UUIDs from B3.
-- Replace every <...> placeholder before running; nothing here is runnable as-is.
-- v1 omits all github_* columns: they're nullable (migration
-- 20260624000000_relax_github_columns.sql) and unused in the v1 direct-to-cache
-- path. They only matter if the optional GitHub sync-source is enabled later.
insert into entities (
  slug, display_name,
  telegram_bot_username, excluded_thread_ids,
  telegram_bot_token_id, telegram_webhook_secret_id
) values (
  '<your_slug>',                 -- routing key: lowercase/URL-safe/stable, e.g. hys
  '<your_entity_display_name>',  -- human-facing name, e.g. Hudson Yards Studios
  '<your_bot_username>',         -- bare bot username (no @), e.g. kenntnis_hys_bot
  '{}',                          -- excluded_thread_ids: empty array is fine
  '<BOT_TOKEN_SECRET_UUID>',     -- UUID from B3 Secret 1
  '<WEBHOOK_SECRET_UUID>'        -- UUID from B3 Secret 2
)
returning id;
```

> *(`github_owner`, `github_repo`, `github_branch`, `context_root`, and `github_token_id` are all nullable and left null in v1. Earlier drafts required nominal placeholder values here because the columns were `NOT NULL`; migration `20260624000000_relax_github_columns.sql` relaxed them, so you can omit them entirely.)*

> ✅ **Verified (first onboarding):** the entity insert succeeds in the SQL editor and returns the `id`. Because the editor connects as `postgres` (superuser), it bypasses the `WITH CHECK` RLS policy — which is why entity *creation* works here even though `bot_service` couldn't bootstrap a brand-new entity's first row. **Entity creation is a privileged admin action; only the running app uses `bot_service`.** (Future: an admin function/UI will do this insert programmatically as a privileged role — see `PLANNING.md` §9.)

> **About the `slug`** (`'hys'` above) — it's the **routing key**, not just a label, so it has real requirements:
> - **Unique** — enforced by the schema (`slug ... unique`). It's the URL Telegram delivers to (`/api/webhooks/telegram/{slug}`) and what `resolve_entity_id_by_slug` maps to a single entity. A duplicate insert is rejected outright by the constraint.
> - **URL-safe** — it goes directly into a URL path, so use **lowercase letters, digits, and hyphens only** (e.g. `hys`, `symres`, `hys-studios`). No spaces, uppercase, or special characters.
> - **Stable** — it's baked into the registered Telegram webhook URL (B6), so changing it later means re-registering the webhook. Choose it deliberately at creation (short, clear, permanent). The `display_name` (`'Hudson Yards Studios'`) is the human-facing label and *can* change freely; the slug is the technical identifier and shouldn't.

Then capture the returned `entity_id` and insert the **first** group (e.g. "HYS Internal"):

```sql
insert into groups (entity_id, telegram_chat_id, display_name)
values (
  '<entity_id_from_above>',   -- the id returned by the entity insert
  <your_group_chat_id>,       -- the -100... supergroup id (see below); a number, not quoted
  '<your_group_display_name>' -- e.g. HYS Internal
);
```

> **Getting `telegram_chat_id` — the bot tells you (no third-party bot needed).** The chat id is a large negative number (supergroups look like `-1001234567890`). Let *your own* bot report it — two ways, both safe:
>
> **✅ Preferred — `/whoami` (works even before the group is registered):**
> 1. Set this entity's webhook (run the **B6** `setWebhook` block; confirm `"Webhook was set"`). The bot has to be receiving updates to answer.
> 2. In the group, send **`/whoami`**. The bot replies in-chat with the **Chat ID**, the current **Topic (thread) ID**, your user id, and the resolved Entity (Group shows `unregistered` until you do the insert below — that's expected).
> 3. Copy the **Chat ID** from the reply into the group insert above (it already includes the `-100…` prefix; don't add anything). `/whoami` also gives you a topic's `message_thread_id` directly — handy for per-topic manifest entries in B5.
>
> **✅ Fallback — the "untracked chat ID" log:** if `/whoami` isn't registered yet (very first onboarding, before B7), send any message in the group and read the chat id from the Vercel log line `Message received from untracked chat ID: -1001234567890`. Same value, just via the logs instead of in-chat.
>
> ⚠️ **Do NOT use third-party "get-ID" utility bots** (e.g. `@RawDataBot` and lookalikes). Adding one puts an **unknown third party inside your group, reading its messages**, and Telegram bot usernames are **dangerously confusable** — it's easy to add a malicious lookalike (e.g. `@raw_data_botbot` instead of `@RawDataBot`) that silently harvests the group. Both methods above use *only your own* bot and expose nothing. There is no good reason to add an outside bot just to read a chat id.

## B5. Bootstrap content into the cache + manifest

The bot answers from `doc_cache`. In v1 you push content **directly** into it (no GitHub sync). Run in the SQL editor as `postgres`.

```sql
-- 1. Push a context doc directly into the cache.
--    doc_cache.content is NOT NULL — real content required (no empty docs, or the
--    bot will have nothing to answer from).
--
--    The content is wrapped in dollar-quoting:  $KENNTNIS_DOC$ ... $KENNTNIS_DOC$
--    *** Paste your content ONLY between the two $KENNTNIS_DOC$ markers. ***
--    Inside those markers, apostrophes and quotes need NO escaping — that is the
--    whole point of dollar-quoting (a stray apostrophe like "we're" would
--    otherwise be read as a string delimiter and break the statement). Do NOT
--    alter the two $KENNTNIS_DOC$ markers themselves. (The distinctive tag is
--    chosen so your real content can't accidentally contain it.)
--    on conflict makes the statement re-runnable (updates existing content).
insert into doc_cache (entity_id, doc_path, content, git_sha)
values (
  'THE_ENTITY_ID',
  'entity-context-overview',
  $KENNTNIS_DOC$
<<< PASTE CONTENT BELOW THIS LINE — do not touch the $KENNTNIS_DOC$ markers >>>

# Hudson Yards Studios — Overview

Replace this whole block with your real content. A few solid paragraphs the bot
should be able to answer from. Apostrophes are fine here — e.g. "we're a media
company", "the studio's mission" — no escaping needed.

<<< PASTE CONTENT ABOVE THIS LINE >>>
  $KENNTNIS_DOC$,
  null    -- git_sha nullable; null for directly-pushed (non-Git) content
)
on conflict (entity_id, doc_path)
do update set content = excluded.content, synced_at = now();

-- 2. Map it as an ENTITY-GENERAL doc (loads for every topic): telegram_thread_id = null.
--    (Run once — manifest_entries has no unique constraint on these columns, so
--    re-running would create duplicates.)
insert into manifest_entries (entity_id, group_id, telegram_thread_id, doc_path)
values ('THE_ENTITY_ID', null, null, 'entity-context-overview');
```

> **Why the `$KENNTNIS_DOC$` wrapper (and the #1 SQL-editor footgun):** in the Supabase SQL editor, an **apostrophe in your content** (we're, company's, etc.) will **break the statement** *unless* the content is dollar-quoted — a stray `'` is otherwise read as the *start* of a SQL string, and everything after it misparses (the editor often greys it out as if commented). Dollar-quoting (`$KENNTNIS_DOC$...$KENNTNIS_DOC$`) makes everything between the markers a literal, so apostrophes/quotes need **no** escaping. **Two rules:** (1) paste your content **only between** the markers, and (2) **don't disturb the `$KENNTNIS_DOC$` markers themselves** — if one gets altered or deleted, dollar-quoting collapses and apostrophes break again. The distinctive tag (`$KENNTNIS_DOC$` vs a bare `$$`) is chosen so real content can't accidentally contain it.

- **`doc_path` is just a logical identifier in v1** — despite the name, it is *not* a file path (the GitHub-era path meaning is gone). Use a short, **descriptive label** for what the doc is (e.g. `entity-context-overview`, `pricing-faq`, `board-onboarding`) rather than a path-like `context/overview.md` — the descriptive form is clearer in `/context` listings and in the cache. The only hard rule: it must **match exactly** between the `doc_cache` row and its `manifest_entries` row (they join on `entity_id` + `doc_path`), and be unique per entity (it's the cache's key).
- **Per-topic docs (optional):** for a topic-specific doc, push another `doc_cache` row and add a `manifest_entries` row with `telegram_thread_id = <the topic's message_thread_id>`. *(v1 resolution uses entity-general + per-topic; per-**group** scoping via `group_id` is not yet built — see `PLANNING.md` §9.)*
- **Re-seeding / editing content** later: just re-run the `doc_cache` upsert with new content (the `on conflict` updates it). This is the manual content-management path until a UI or a sync-source is added.

## B6. Register the Telegram webhook

Point Telegram at this tenant's slug-specific endpoint, with the per-tenant webhook secret (the *plaintext* value from B2, the same one stored in Vault):

```bash
# --- Fill in these three, then run the whole block ---
BOT_TOKEN="123456:ABC-RealBotTokenFromBotFather"  # from BotFather (B1b)
SLUG="<your_entity_slug>"                          # this entity's slug (B4), e.g. hys
SECRET="YOUR_PLAINTEXT_WEBHOOK_SECRET"             # the plaintext webhook secret from B2
                                                  # (same value stored in Vault as
                                                  # telegram_webhook_secret_<slug> in B3;
                                                  # mind trailing newlines)

curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://api.kenntnis.ai/api/webhooks/telegram/${SLUG}" \
  --data-urlencode "secret_token=${SECRET}"
```

> The URL ends in the entity **slug** (`/hys`). The `secret_token` is what Telegram sends in the `x-telegram-bot-api-secret-token` header; the handler compares it to the Vault-stored `telegram_webhook_secret`. They must match exactly (mind trailing newlines).
> If re-registering, `deleteWebhook?drop_pending_updates=true` first to clear any queued updates.

## B7. Register the bot's command menu (`setMyCommands`)

Register the slash commands so they appear in Telegram's `/` autocomplete menu and the "Menu" button. (Functionally, typing `/ask` works even without this — the handler parses the text — but registering gives users discoverability.)

The canonical command list is defined once in `lib/commands.ts` — edit there to change the menu, then re-run Option A to push it to all bots.

### Option A: Bulk sync all entities (recommended)
Run the sync script to register/update the command menu for **every** bot in the database. It uses an admin/privileged connection to read and decrypt each bot token via the RLS tenant context:

```bash
# Use the POOLER host (not db.<ref>.supabase.co — that fails with ENOTFOUND, see A7).
# You MUST `export` (a bare assignment isn't inherited by the npx child process).
export ADMIN_DATABASE_URL="postgresql://postgres.<ref>:<postgres_password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres"
npx tsx scripts/sync-commands.ts
```

> The script reads **all** entities' bot tokens, so it needs the privileged `postgres` role (with the `.<ref>` suffix), **not** `bot_service`. It sets `prepare: false`, so either pooler port works (6543 transaction or 5432 session). Per-entity success/failure is reported; non-zero exit if any fail.

### Option B: Manual single-bot registration
For a one-time registration of a single bot during onboarding (before the script is set up), a manual `curl` also works:

```bash
BOT_TOKEN="123456:ABC-RealBotTokenFromBotFather"  # from BotFather (B1b)

curl "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"ask","description":"Ask a question grounded in the team docs"},
    {"command":"context","description":"See what docs the bot answers from here"},
    {"command":"recap","description":"Summarize the last messages in this topic"},
    {"command":"whoami","description":"Show this chat ids (setup/diagnostics)"},
    {"command":"help","description":"Show what the bot can do"}
  ]}'
```

> Expect `{"ok":true,"result":true}`. The menu is **per-bot**, so this is a one-time step per entity (each entity has its own bot). Re-run the bulk sync (Option A) whenever the command set changes. Keep this list in sync with `lib/commands.ts` and the commands the handler actually implements (currently `/ask`, `/context`, `/recap`, `/whoami`, `/help`; `@mention` is not a slash command so it isn't listed). **`lib/commands.ts` is the source of truth — Option A reads it automatically, so you only edit that one file; this manual curl is the fallback and must be kept in sync by hand.**
>
> *(Future: the onboarding UI will call `setMyCommands` automatically right after storing the bot token — it's one of the "everything after the token is automatable" steps; see `PLANNING.md` §9.)*

## B8. Test end-to-end

1. In a topic of the group, send `/help` → expect the static help reply in-thread (it lists `/ask`, `/context`, `/recap`, `/whoami`, `@mention`, `/help`).
2. Send `/ask <a question answerable from the seeded content>` → expect the 👀 reaction, then a typing indicator, then an HTML-formatted answer in the correct topic. **(This is the milestone: the bot answering, grounded in your cached content. It also exercises the multi-query path where `prepare: false` earns its keep.)**
3. `@mention` the bot with a question → same as `/ask`.
4. Send `/context` → expect an inline summary of which docs load here, followed by a `context.md` file attachment with the full content. (In a topic with no docs, the summary shows "none" and no file is sent.)
5. Send `/whoami` → expect the chat id, topic/thread id, your user id, and the resolved entity/group echoed in-thread.
6. Send `/recap` → expect the 👀 reaction, then a recap of the last messages in this topic (default 20). Try `/recap 5` (recaps 5), `/recap 999` (clamps to the max, notes it), and `/recap banana` (falls back to default, notes it). A recap reflects BOTH user questions and the bot's prior answers (confirms bot-response logging from the message-history storage is feeding it).
7. Send a plain (non-command) message → confirm a `message_log` row appears (validates privacy mode is off and message-logging works).
8. **Update content:** re-run the B5 `doc_cache` upsert with edited content → the next `/ask` reflects the change (confirms the cache is the live source).

> **If `/ask` replies "Sorry, something went wrong":** that's the graceful error path — the pipeline worked but the async answer step threw. Check the Vercel logs. A common first-run cause is a **deprecated model id**: `Anthropic API call failed: 404 ... "model: <id>"` means `ANTHROPIC_MODEL` (or the code default) points at a retired model. Fix by setting `ANTHROPIC_MODEL` to a current id (e.g. `claude-sonnet-4-6`) and redeploying — no other change needed. (Model ids get deprecated over time; this is why it's an env var.)

Tenant is live. Repeat Part B for the next *entity*; use **Part C** to add another *group* to this entity.

---

# Part C — Add a Group to an Existing Entity

> For when an entity already exists (onboarded via Part B) and you want to add **another Telegram group** under it — e.g. "HYS Board" alongside "HYS Internal". Because Telegram has **no per-topic user permissions**, separating audiences requires separate *groups*; the platform's `entity (1)—(N) group` model handles this by attaching multiple groups to one entity. This flow is short: **the same bot, content, webhook, and entity are reused** — you're only adding a Telegram group and one database row.

> **Why no new bot/content/webhook:** the entity already has its bot (whose single webhook points at the entity slug) and its content (in `doc_cache`). The Telegram handler resolves the *group* from the incoming `chat_id` and the *entity* from the slug, so one bot in multiple groups routes correctly. (Decision: **one bot per entity, serving all its groups** — see `PLANNING.md` §9.)

## C1. Create the new Telegram group

1. Create the new supergroup with **Topics (forum mode) enabled** — **required**, same as B1a. The platform routes context, logs messages, and supports per-topic docs by `message_thread_id`, which only exists in forum groups; a non-forum group breaks the per-topic model. (See B1a for the why and the enable path.)
2. **Add the entity's existing bot** to it (the same bot from Part B — already created, privacy already disabled). When adding, **type the bot's full username** — a bot may not appear in `@`-autocomplete if Telegram hasn't cached it yet.
3. **Send a message in the group.** Since the bot is already webhooked but this group isn't in the DB yet, the handler can't route it — and it **logs the chat id for you** (see C2). (Privacy mode, a per-bot BotFather setting, already applies in this new group; you'll confirm it logs in C4.)

## C2. Insert the group row (the core of this flow)

Get the new group's `telegram_chat_id`, then insert **one row** referencing the **existing** entity.

> **Getting the chat id — run `/whoami` in the new group (or read the log).** With the entity's webhook already set, just send **`/whoami`** in the new group; the bot replies with the **Chat ID** (Group will show `unregistered` until you do the insert below). Alternatively, after C1 step 3 (any message sent in the new group), the bot logs the unrouteable message in the **Vercel logs** as:
> ```
> Message received from untracked chat ID: -5577480409
> ```
> Either gives you the `telegram_chat_id` — no utility bot or `getUpdates` needed. (`getUpdates` won't work here anyway, because this entity's webhook is already set.)

```sql
insert into groups (entity_id, telegram_chat_id, display_name)
values ('THE_EXISTING_ENTITY_ID', <new_group_chat_id>, 'HYS Board');
```

> `<new_group_chat_id>` is the exact number from `/whoami` or the log (it already includes its own sign/prefix — e.g. `-5577480409` — do **not** prepend anything).

That's it for wiring — no Vault secrets, no repo, no webhook, no entity. The existing bot's webhook already routes messages from this group (the handler resolves the group by `chat_id`).

## C3. (Optional) Scope context per group

If the two groups should see **different** content (e.g. HYS Board must not see internal-only docs), that requires **group-scoped context resolution**, which is **not built in v1** (see `PLANNING.md` §9). The `manifest_entries.group_id` column exists for this, but v1's resolution logic ignores it — so **until group-scoping is built, all groups under the entity share the same (entity-general + per-topic) context.**

- **If shared content is fine** (both groups see the same HYS knowledge): nothing to do — the existing manifest applies to the new group automatically.
- **If you need separation now:** group-scoped resolution must be built first; that is the concrete feature this multi-audience use case drives.

## C4. Test

In a topic of the new group, send `/ask <a question answerable from the entity's context>` → expect the 👀 reaction, typing, then an answer in-thread. (No webhook setup was needed — the existing bot already delivers here.) Confirm a plain message also logs to `message_log` (validates privacy mode is effective in this group).

The new group is live under the existing entity.

---

# Managing & Rotating Secrets

> Operational reference for the secret *lifecycle* after onboarding — finding a secret you didn't record, and rotating one (bot tokens may be regenerated; the webhook secret or any secret may need rotating if compromised). Applies to all entities. **v1 has two secrets per entity** (bot token, webhook secret); a GitHub PAT only exists if you later enable the optional GitHub sync-source.

## Finding a secret's UUID (you don't need to have written it down)

The secret UUIDs aren't floating loose — the **entity row stores them**, so the entity table is your index into Vault. To get an entity's secret UUIDs:

```sql
select slug, telegram_bot_token_id, telegram_webhook_secret_id, github_token_id
from entities
where slug = 'hys';
```

(`github_token_id` is null in v1.) Or list Vault secrets directly by the human-readable **label** you set in B3 — with the slug-based scheme (`telegram_bot_token_<slug>`, `telegram_webhook_secret_<slug>`) you can find a specific entity's secrets by name:

```sql
-- all of one entity's secrets (slug-based labels):
select id, name, created_at from vault.secrets
where name like '%\_hys' order by name;

-- or everything, newest first:
select id, name, created_at from vault.secrets order by created_at desc;
```

(Recall `name` is uniquely indexed, so each label maps to exactly one secret.) Between these two, you can always recover a UUID — via the entity that references it, or by its label in `vault.secrets`.

## Rotating a secret (in place — keeps the same UUID)

The clean rotation path updates the secret's **value in place**, keeping the same UUID. Because the entity row already points at that UUID, **nothing else has to change** — the entity keeps its reference, which now holds the new value, and the app picks it up on its next call (it reads the current value via `get_current_entity_secret`).

```sql
-- 1. Find the UUID (via the entity row or vault.secrets, above).
-- 2. Update the secret's value in place:
select vault.update_secret(
  'THE_SECRET_UUID',   -- e.g. entities.telegram_bot_token_id
  'THE_NEW_VALUE'      -- the new token / secret
);
```

`[VERIFY]` Confirm the exact `vault.update_secret(...)` signature for your Supabase version (commonly `update_secret(id, new_secret [, new_name [, new_description]])`). The concept holds regardless: update in place, UUID unchanged, entity reference still valid.

> **Telegram webhook secret rotation has an extra step:** if you rotate the `telegram_webhook_secret`, you must *also* re-run `setWebhook` (B6) with the new plaintext value, since Telegram stores its own copy and sends it in the header. (The bot token has no such external copy — only the Vault value matters.)

> **Alternative — new secret + re-point the entity (new UUID).** If you prefer a fresh secret (new name/UUID): `vault.create_secret('NEW_VALUE','new_name')` → capture the new UUID → `update entities set telegram_bot_token_id = 'NEW_UUID' where slug = 'hys';` → (optionally delete the old secret). More steps; the in-place update above is preferred for routine rotation. Both the create and the `update entities` are privileged admin actions (run in the SQL editor as `postgres`).

> **GitHub PAT (only if the optional GitHub sync-source is enabled):** a fine-grained PAT expires, and an expired token silently stops doc-sync (the bot keeps answering from cache but goes stale). Rotation is the same in-place pattern: generate a new PAT → `vault.update_secret(<entities.github_token_id>, '<new_pat>')`. Not applicable to the v1 direct-cache path.

---

# Appendix — Quick reference

**Webhook URLs:**
- Telegram (per-tenant): `https://api.kenntnis.ai/api/webhooks/telegram/{slug}`
- GitHub sync (optional, not used in v1): `https://api.kenntnis.ai/api/webhooks/github/sync` — resolves by repo; only relevant if the GitHub sync-source is enabled later.

**Environment variables (platform-wide):** `DATABASE_URL` (bot_service, **pooler** string), `ANTHROPIC_API_KEY`. `GITHUB_WEBHOOK_SECRET` is only needed if the optional GitHub sync-source is enabled (not used in v1).

**Admin script env var:** `ADMIN_DATABASE_URL` (privileged `postgres` role, **pooler** host) — used only by `scripts/sync-commands.ts`, run locally. Must be `export`ed. Never deployed.

**Per-tenant secrets (in Vault), v1:** telegram bot token, telegram webhook secret. (A GitHub token is added only if the optional GitHub sync-source is enabled.)

**Content (v1):** lives directly in `doc_cache`, pushed via SQL (B5). No GitHub in the v1 path; the store is abstracted so sync-sources (GitHub/Drive/etc.) can populate the cache later — see `PLANNING.md`.

**The three `SECURITY DEFINER` functions** (the only sanctioned RLS-bypass surfaces): `resolve_entity_id_by_slug`, `resolve_entity_id_by_repo` (used only by the GitHub sync, dormant in v1), `get_current_entity_secret`. See `SECURITY-PROPOSAL.md`.

**Prerequisite ordering (the parts that bite if done out of order):** Vault verified → `bot_service` role created → migration run (grants included) → app deployed (pooler `DATABASE_URL`) → domain live → Telegram webhook registered (per tenant).

---

## Open items this guide surfaced (for BACKLOG / Antigravity confirmation)

- **`prepare: false` in `lib/supabase.ts`** (A7) — ✅ confirmed set; required for the Supavisor transaction pooler.
- **`github_*` columns relaxed to nullable** (B4) — ✅ done (migration `20260624000000_relax_github_columns.sql`). The entity insert no longer supplies nominal `github_owner/repo/branch/context_root` values; they're nullable and omitted in v1. (Future: a `sync_sources` refactor could move GitHub config out of `entities` entirely when the content-store abstraction is formalized — still a `PLANNING.md`/BACKLOG item.) **Coordinated code change done:** the `Entity` TS interface in `lib/capabilities.ts` marks `github_owner/repo/branch/context_root` and `github_token` as `string | null`; the GitHub sync route has a config-completeness guard.
- **No cache-rebuild / bulk-seed endpoint** (B5) — v1 content is pushed via manual SQL upserts. A small admin endpoint (or eventual UI) to manage `doc_cache` content would replace the manual SQL; this is the v1 content-management path for now.
- **`checkVaultSecretsHealth` is not exposed via any route** (A9) — wire it to a small admin/health endpoint for pre-launch verification (also a natural home for a privacy-mode check via `getMe`).
- **`package.json` name is still `temp-next`** — rename to the project.
- **`vault.update_secret(...)` signature** (Managing & Rotating Secrets) — confirm exact signature for the current Supabase version (to be verified on first rotation).

### Resolved during first deploy / first onboarding (2026-06-19–24)
- **Table-privilege grants** — now in the migration (BACKLOG B0); A5 produces a working role in one step. Verified: 32 grant rows.
- **Migration application** — `npx supabase db push` used successfully (after `bot_service` role created first).
- **Vault** — already provisioned (v0.3.1, pgsodium-free); verify-not-create (A3).
- **`DATABASE_URL`** — must be the transaction-mode pooler string, not direct (A7); direct host fails `ENOTFOUND` from Vercel. `prepare: false` required and set.
- **A6 sanity check** — `set role` fails in the SQL editor; use the `information_schema.role_table_grants` query.
- **`vault.create_secret(secret, name)`** — works as written; returns the UUID (B3).
- **Entity insert as `postgres`** — succeeds via SQL editor (bypasses RLS `WITH CHECK`); confirms entity creation is a privileged admin action (B4).
- **Chat-id retrieval method** — settled on `/whoami` (the bot reports its own ids in-chat, works pre-registration) as the preferred method, with the "untracked chat ID" Vercel log line as the fallback. `getUpdates` was used early but only works *before* a webhook is set; third-party get-ID bots were rejected as dangerous (confusable usernames; an outside bot reading the group). See B4.
- **GitHub dropped from v1 path** — content is direct-to-`doc_cache`; GitHub-sync code retained as a future optional sync-source (see `PLANNING.md`).
- **RLS policies were RESTRICTIVE → fixed to PERMISSIVE** (migration `20260621000000_fix_rls_permissive.sql`). Restrictive-only = deny-all for `bot_service`; surfaced as "Tenant config mismatch" 404 on the first real request. Invisible in the SQL editor (postgres bypasses RLS). See A5 note.
- **Vault secret value/name SWAP** — on first onboarding all three secrets were inserted with `create_secret` args reversed (real value in `name`, placeholder in value). Caused 401 webhook-auth failures + plaintext secrets in `name`. B3 rewritten with explicit arg-order warning + immediate verify query.
- **B5 content apostrophes break the SQL editor** — a stray apostrophe in pasted content is read as a string delimiter and breaks the statement. B5 hardened with distinctive `$KENNTNIS_DOC$` dollar-quoting + explicit paste markers.
- **Deprecated model id** — hardcoded `claude-3-5-sonnet-20241022` returned 404 "model not found" (surfaced as the bot's "something went wrong" reply). Moved to `ANTHROPIC_MODEL` env var defaulting to `claude-sonnet-4-6` (B7 note, A7 env table).
- **`/whoami` + command sync** — `/whoami` command added (echoes chat/thread/user ids + resolved entity/group; works in unregistered groups). `setMyCommands` now driven by `lib/commands.ts` (single source of truth) + `scripts/sync-commands.ts` (bulk-registers all bots; needs `export ADMIN_DATABASE_URL` with the **pooler** host).
