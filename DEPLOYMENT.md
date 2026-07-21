# Deployment & Setup Guide

> How to stand up the Kenntnis platform from scratch and onboard your first tenant. This is the operational runbook; for *what* the system is and *why* it's built this way, see `README.md` (overview) and [`docs/PLANNING.md`](./docs/PLANNING.md) (architecture). Other design docs live in [`docs/`](./docs/) (`SECURITY-PROPOSAL.md`, `MANAGEMENT-PROPOSAL.md`, `BACKLOG.md`) and feature specs in `docs/specs/`.

> **Structure — two flows:**
> - **Part A** — one-time **platform** setup (do once, ever): the app, the database, and the single
>   **platform bot** (one bot serving all entities).
> - **Part B** — onboard a **new entity** (new tenant): create the entity, give it content, and bind
>   one or more groups to it via `/auth`. No per-entity bot, secrets, or webhook — those belong to the
>   platform. Repeat per entity (HYS, SymRes, Theäta…); repeat the `/auth` step per group.
>
> The multi-tenant design means Part A is never repeated; a new tenant is Part B; an additional group
> under an existing tenant is just another `/auth` (Part B, B3). (There is no separate "add a group"
> flow — the former Part C is now a single self-service step.)

> **Ordering matters.** Several steps are prerequisites for later ones (the `bot_service` role must exist *before* the migration; Vault must be enabled *before* the migration; the platform bot's `bots` row must exist *before* its webhook resolves; Vercel must be deployed *before* you can register the webhook). Follow the order as written.

> ⚠️ **Known gaps flagged inline as `[VERIFY]`** — a few steps depend on implementation details that should be confirmed against the current code/intended flow before relying on them. They're called out where they occur.

---

# Part A — One-Time Platform Setup

> **Worked example — concrete values used throughout this guide.** Where steps show a specific value,
> it's *this* deployment's real value, called out here once so it's clearly an example, not a required
> string. Substitute your own when deploying fresh.
>
> | Thing | This deployment | What it is |
> |---|---|---|
> | Platform bot username | `leguan_the_bot` | the Telegram @handle users mention (`bots.telegram_username`) |
> | Platform bot display name | `Leguan the Bot` | human-facing name in BotFather |
> | Platform bot **slug** | `leguan` | stable internal routing key (`bots.slug`); the `<bot-slug>` in the webhook path. **Independent of the username** — renaming the bot never changes the slug. |
> | Runtime domain | `api.kenntnis.ai` | where the single platform webhook lives |
> | Dashboard domain | `app.leguan.ai` | the management UI (product domain) |
> | Webhook URL | `https://api.kenntnis.ai/api/webhooks/platform/leguan` | one webhook for the whole platform |
>
> **Architecture note (post-Phase-3):** there is **one platform bot** serving **all** entities. A bot
> is a first-class row in the `bots` table, fully decoupled from entities; the entity an incoming
> message belongs to is resolved from the **group** (`chat_id → groups → entity`), not from the URL.
> This replaced the earlier per-entity-bot model (each tenant ran its own bot, resolved by a URL slug).
> The per-entity model is gone; this guide describes the platform-bot reality only.

## A1. Prerequisites

Accounts/assets you need before starting:
- **Supabase** account (hosts Postgres + Vault).
- **Vercel** account (hosts the Next.js app).
- **GitHub** account (hosts per-tenant content repos; also where this platform repo lives).
- **Anthropic** API key (the model provider).
- **Domains:** two, reflecting the infra-vs-product split:
  - **`kenntnis.ai`** (holding company / infrastructure) — the bot/webhook **runtime** runs on a subdomain, `api.kenntnis.ai`; preview deployments use `*.preview.kenntnis.ai`.
  - **`leguan.ai`** (product) — the human-facing **management dashboard** runs on `app.leguan.ai`. Product branding is env-driven (`NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_APP_URL`), so this domain is config, not hardcoded — see A7 and A8b.

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

## A5b. Raw Telegram Event Archive & Retention

The Raw Telegram Event Archive writes raw updates directly to the `telegram_events` table before tenant resolution. This table is an append-only forensic log.

### A5b.1 Enable `pg_cron` Extension
Retention of raw Telegram events requires the `pg_cron` extension to run the daily cleanup job.

1. Go to the Supabase Dashboard -> **Database** -> **Extensions**.
2. Search for `pg_cron` and click the toggle to enable it (or run `create extension if not exists pg_cron;` in the SQL editor as the `postgres` superuser).

### A5b.2 Schedule Retention Cleanup
To prevent disk exhaustion, schedule the daily batched delete to reap rows older than 30 days. Paste and execute this SQL query inside the Supabase SQL editor:

```sql
select cron.schedule(
  'telegram-events-retention',
  '0 0 * * *',
  $$ delete from public.telegram_events
     where id in (
       select id from public.telegram_events
       where created_at < now() - interval '30 days'
       limit 10000
     ) $$
);
```

- **Tunable settings**: The age threshold (`'30 days'`) and batch limit (`10000`) are tunable operational parameters pasted directly in this SQL, not read at runtime.
- **Throughput ceiling**: The ceiling is `batch limit * runs/day` (10,000 rows/day on a daily schedule). If sustained daily volume approaches this, increase the schedule frequency (e.g. hourly) or transition to partitioning by `created_at` (backlog).

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

## A6b. Create the platform bot (BotFather → Vault → `bots` row)

The platform runs on **one** bot serving all entities. Create it once here. (Bot *creation* is
pre-deploy; the **webhook registration** and **command menu** come after the app is live — A8c.)

> **Why manual:** BotFather has **no API for creating bots** — bot creation is inherently a manual,
> human-gated step. This is also why the platform uses a shared bot rather than one bot per tenant.

### A6b.1 — Create the bot in BotFather
1. Message **@BotFather** → `/newbot`.
2. **Display name** (free-form, changeable later): e.g. `Leguan the Bot`.
3. **Username** (must end in `bot`; 5–32 chars; globally unique; **hard to change later — this is the
   sticky one**): e.g. `leguan_the_bot`. If taken, pick a fallback (`@LeguanAIBot`, etc.).
4. Save the **bot token** BotFather returns — it's the bot's full credentials. Treat it like a
   password (store in a password manager; it goes into Vault next, never committed).
5. **`/setprivacy` → select the bot → Disable.** Privacy mode OFF is required so the bot receives
   *all* group messages (not just commands/mentions) — needed for `/recap` and conversation logging.
   Privacy applies only to groups joined *after* the change, so set it before adding the bot anywhere.
6. **`/setjoingroups` → Enable** (so the bot can be added to groups).

### A6b.2 — Generate a webhook secret
A random high-entropy string Telegram will send with every webhook call so the handler can verify the
request is genuinely from Telegram:
```bash
openssl rand -hex 32
```
Save it alongside the token (you'll need it again at A8c for `setWebhook`). It's a secret.

### A6b.3 — Store both secrets in Vault
In the Supabase SQL editor, create two Vault secrets and **capture the returned UUIDs**. (Arg order:
`vault.create_secret(secret_value, secret_name)` — **real value first, label second**; swapping them
puts the real secret in the non-encrypted `name` column. See *Managing & Rotating Secrets*.)
```sql
select vault.create_secret('<PASTE_BOT_TOKEN>',     'leguan_the_bot_token')   as token_id;
select vault.create_secret('<PASTE_WEBHOOK_SECRET>', 'leguan_the_bot_webhook') as webhook_id;
```
> Names must be unique in `vault.secrets` (partial unique index on `name`). Capture both UUIDs — they
> go into the `bots` row next. **Clear this SQL from the editor after running** (it contains the
> plaintext token).

### A6b.4 — Insert the `bots` row
The secret refs are stored as **text** (the Vault UUID as text) — this is intentional (kept `text`,
not a `uuid` FK, so future bots can reference non-Vault credential sources; see the bot-store
direction in `docs/VISION.md`).
```sql
insert into public.bots (name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status)
values (
  '<DISPLAY_NAME>',            -- e.g. Leguan the Bot
  '<BOT_SLUG>',               -- stable internal routing key (the webhook path segment), e.g. leguan
  '<BOT_USERNAME>',           -- the @handle (no @), e.g. leguan_the_bot
  '<TOKEN_SECRET_UUID>',      -- from A6b.3
  '<WEBHOOK_SECRET_UUID>',    -- from A6b.3
  'active'
);
```
> `persona`, `model`, `capabilities` stay null/default — the bot uses the platform default model
> (`ANTHROPIC_MODEL`). Those columns are the registered-backend seam for future specialized bots
> (`docs/VISION.md`, Surface 2). **`bot_entities` is not populated** — the runtime resolves entity via
> `chat_id → groups`, not `bot_entities` (which is a dormant authorization seam for future
> permissioned bots).

> **Verify:**
> ```sql
> select slug, telegram_username, status from public.bots;
> ```
> Expect one `active` row with slug `leguan`. (On a from-scratch deploy this is the only bot.)

## A7. Deploy the app to Vercel

1. Connect the `telegram-bot-platform` GitHub repo to a new Vercel project.
2. Set the environment variables (the complete set the code reads — confirmed against the route handlers and `lib/`):

   | Variable | Value | Sensitive? | Notes |
   |---|---|---|---|
   | `DATABASE_URL` | the **transaction-mode pooler** string (see below) | **Yes** | **Must be the `bot_service` role**, not `postgres`. |
   | `ANTHROPIC_API_KEY` | your Anthropic key | **Yes** | The model provider key. |
   | `DEEPSEEK_API_KEY` | your DeepSeek key | **Yes** | **Optional** — required only when using a DeepSeek model (e.g. `deepseek-v4-flash`). |
   | `MODEL_IDENTIFIER` | a current model id, e.g. `claude-sonnet-4-6` or `deepseek-v4-flash` | No | Platform-wide default model (the code checks `MODEL_IDENTIFIER` / `ANTHROPIC_MODEL`). |
   | `GITHUB_WEBHOOK_SECRET` | a strong shared secret | **Yes** | **Only needed if the optional GitHub sync-source is enabled** (not used in v1). Global HMAC secret; generate via password manager. |
   | `NEXT_PUBLIC_SUPABASE_URL` | your Supabase project URL | No | Public by design; required for client-side Auth & DB queries. |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | your Supabase publishable key (`sb_publishable_...`) | No | Public by design (browser-exposed, RLS-enforced); required for client-side Auth & DB. |
   | `NEXT_PUBLIC_APP_NAME` | the brand-config product name | No | Custom branding; defaults to `'Agent Platform'`. |
   | `NEXT_PUBLIC_APP_URL` | base URL of the **management dashboard** (per-environment) | No | Drives the magic-link redirect (`emailRedirectTo`). Prod = product domain (e.g. `https://app.leguan.ai`); local = `http://localhost:3000`; preview = leave **unset** (falls back to `window.location.origin`). **Not** the `api.` runtime domain. Full config in A8b. |

   > **The Sensitive column is the bright line:** every `NEXT_PUBLIC_*` var is public *by design*
   > (inlined into the browser bundle), so marking it Sensitive is a category error — and worse,
   > Vercel makes Sensitive vars write-only, which breaks the build-time inlining `NEXT_PUBLIC_*`
   > requires. The server-only secrets (`DATABASE_URL` with the `bot_service` password,
   > `ANTHROPIC_API_KEY`, `GITHUB_WEBHOOK_SECRET`) are the ones to mark Sensitive. The `service_role`
   > key is **never** used in this app; `ADMIN_DATABASE_URL` (the `postgres` superuser string for local
   > test/sync scripts) is **never** set in Vercel.

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

> The **management dashboard** runs on a *separate* domain (the product domain) — see **A8b** for that domain plus the Supabase Auth URL configuration it requires.

## A8b. Management dashboard domain + Supabase Auth URLs

The **management dashboard** (the `/manage` web shell from the Phase 1 management plane; see `docs/specs/SPEC-phase-1-management-plane.md`) is human-facing, so it lives on the **product** domain, separate from the `api.` runtime. This split keeps infrastructure on `kenntnis.ai` and the product surface on `leguan.ai`.

**Vercel domains** (all on the same Vercel project):
- **Production dashboard:** add **`app.leguan.ai`** (CNAME per Vercel's instructions), and set `NEXT_PUBLIC_APP_URL=https://app.leguan.ai` in Vercel's **Production** environment.
- **Preview:** previews are ephemeral — leave `NEXT_PUBLIC_APP_URL` **unset** for the Preview environment so the login page falls back to `window.location.origin` (each preview uses its own URL). Optionally add a wildcard `*.preview.kenntnis.ai` for stable preview hostnames; otherwise the default `*.vercel.app` URLs work.
- **Local:** `.env.local` sets `NEXT_PUBLIC_APP_URL=http://localhost:3000`.

**Supabase → Authentication → URL Configuration** — this is the config that makes magic-link auth work; getting it wrong produces a silent "failed to fetch" on send, or a bounced redirect after the click:

- **Site URL** — a **single** origin, **no wildcard** (the field rejects them). Set it to the canonical production dashboard: `https://app.leguan.ai`. It is only the *default* redirect when a flow doesn't specify one (and the email-template variable); the app always passes an explicit `emailRedirectTo`, so it's mostly a fallback.
- **Redirect URLs** — the **allowlist** of permitted post-auth redirects; **wildcards allowed**, and this is what actually governs each environment. Include every environment, each with a `/**` suffix (so `/manage/dashboard` and future paths match):
  - `http://localhost:3000/**` — local dev (must be present, or local auth breaks)
  - `https://app.leguan.ai/**` — production
  - `https://*.preview.kenntnis.ai/**` — custom preview wildcard (if used)
  - `https://*-<your-vercel-scope>.vercel.app/**` — default Vercel preview URLs

> **Site URL vs Redirect URLs — the distinction that bites:** setting the Site URL to production does **not** disable localhost. Localhost keeps working because it's in the *Redirect URLs* allowlist and the app targets it explicitly via `NEXT_PUBLIC_APP_URL`. Site URL = single default; Redirect URLs = the multi-entry, wildcard-capable allowlist that governs what's permitted. Put localhost in **Redirect URLs**, not Site URL.

> **Auth key reminder:** the browser client uses the **publishable** key (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `sb_publishable_...`) — Supabase's current replacement for the legacy `anon` JWT key. It is public by design (browser-exposed), resolves to the same `anon` Postgres role, and is enforced entirely by RLS — so it is **not** marked Sensitive in Vercel. The `service_role` key is never used in this app (see the A7 note). `ADMIN_DATABASE_URL` (the `postgres` superuser string used by the local test/sync scripts) is **never** set in Vercel.

## A8c. Register the platform webhook + command menu (post-deploy)

These two steps need the app **live** (A7 deploy + A8 domain), so they come after deployment — but
they complete the platform bot created in A6b. One webhook, one command menu, for the **whole**
platform (not per entity).

### A8c.1 — Set the webhook
Point Telegram at the platform bot's slug-specific endpoint, with the webhook secret (the *plaintext*
value from A6b.2, the same one stored in Vault).

```bash
# --- Fill in these three, then run the whole block ---
BOT_TOKEN="<PLATFORM_BOT_TOKEN>"   # from BotFather (A6b.1)
SLUG="<BOT_SLUG>"                   # the bot slug from A6b.4, e.g. leguan
SECRET="<PLAINTEXT_WEBHOOK_SECRET>" # the plaintext webhook secret from A6b.2
                                   # (same value stored in Vault as the webhook secret)

curl "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://api.kenntnis.ai/api/webhooks/platform/${SLUG}" \
  --data-urlencode "secret_token=${SECRET}"
```

> **Use `--data-urlencode` (POST body), not a query string.** The `secret_token` is a secret; putting
> it in the URL query string leaks it into logs. `--data-urlencode` sends both params in the POST
> body. Expect `{"ok":true,"result":true,"description":"Webhook was set"}`.
>
> The URL ends in the bot **slug** (`/platform/leguan`) — the *bot's* stable routing key, **not** an
> entity slug. Telegram sends the `secret_token` back in the `x-telegram-bot-api-secret-token` header
> on every call; the handler compares it to the Vault-stored webhook secret (mind trailing newlines).

### A8c.2 — Verify webhook health (before touching any group)
```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
```
Confirm: `url` is exactly `https://api.kenntnis.ai/api/webhooks/platform/<slug>`, `pending_update_count`
is small, and there is **no** `last_error_message`. A clean result here is the green light — a webhook
that "set" successfully can still be failing to deliver, and this is where that shows.

### A8c.3 — Register the command menu (`setMyCommands`)
The slash commands handled by the webhook are parsed server-side, so they *work* regardless; this only
populates the `/` **autocomplete menu**. Register them on the **platform bot**.

```bash
curl "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"whoami","description":"Show this chat ids (setup/diagnostics)"},
    {"command":"help","description":"Show what the bot can do"},
    {"command":"context","description":"See what docs the bot answers from here"},
    {"command":"recap","description":"Summarize the last messages in this topic"},
    {"command":"auth","description":"Link this group to a workspace"}
  ]}'
```

> Expect `{"ok":true,"result":true}`. Note **`/ask` is intentionally absent** — the bot answers on
> **@mention**, not a slash command (Phase 3 trigger-model change). The canonical list lives in
> `lib/commands.ts`.
>
> `scripts/sync-commands.ts` is the canonical tool to synchronize the command list across all active
> platform bots defined in the `bots` table. If registering slash commands for a single new platform
> bot during manual setup, the `curl` sequence above can be run directly (sourcing the command list from
> `lib/commands.ts`). To bulk-sync all active platform bots after a command-list change in `lib/commands.ts`,
> run the script instead (see A8c.3 above).

## A8d. Privacy policy page + in-chat notice configuration

The platform bot posts short in-chat **transparency notices** (once when it is added to a group, and when a member joins) that link to a public **privacy policy**. See `docs/specs/SPEC-privacy-notices.md`. Four one-time items make the link resolve and put the policy on the bot's profile. (The notice-sending code and the `/privacy` route ship with the app in A7; these steps configure them.)

### A8d.1 — Publish the policy page
The policy lives in-repo at `content/legal/privacy.md` and is served by the app at `/privacy` (built + deployed in A7). Before going live:
- **Fill every `[BRACKETED]` placeholder** in `content/legal/privacy.md` (legal entity name + registered address, contact email, dates, children's age) and **have counsel review it** — it ships as a *draft* (a leading HTML comment flags this; that comment does not render).
- Confirm it renders on the runtime domain immediately: `https://api.kenntnis.ai/privacy`.

### A8d.2 — Point the canonical URL at it (apex `leguan.ai`)
The one Vercel project serves every attached domain, so `/privacy` is already live on all of them. For the canonical public URL `https://leguan.ai/privacy`:
1. Add the apex domain **`leguan.ai`** to the Vercel project (Domains) and add the DNS records Vercel specifies at your registrar.
2. Confirm `https://leguan.ai/privacy` resolves.

### A8d.3 — Set `PRIVACY_POLICY_URL` (optional — it defaults)
`lib/config.ts` defaults this to `https://leguan.ai/privacy`, so you only set it to **override** (e.g. a staging URL). It is **config, not a secret** (no `NEXT_PUBLIC_` prefix; server-side only). If overriding, set it in Vercel's Production (and Preview, if different) env and redeploy.

### A8d.4 — Set the bot's profile fields in BotFather
`@BotFather` → `Edit @leguan_the_bot info`:
- **Edit Privacy Policy** → `https://leguan.ai/privacy` (must match `PRIVACY_POLICY_URL`).
- **Edit About** (≤120 chars — shows on the profile card group members see):
  ```
  AI assistant for group Q&A and chat recaps, grounded in your team's docs. Logs messages — see the Privacy Policy.
  ```
- **Edit Description** (≤512 chars — shows in an empty private chat before Start):
  ```
  Leguan adds an AI assistant to your Telegram group. Mention it with a question to get answers from your team's saved documents, use /recap to summarize recent messages, and /push to save a message as lasting context.

  To power these features, Leguan logs group messages and may send them to AI model providers to generate answers — used only for these features. See the Privacy Policy below for how your data is handled and your choices.
  ```

> Only **About** and **Privacy Policy** surface on the profile card a group member sees by tapping the bot; **Description** only appears in an empty private chat before Start — so keep nothing load-bearing solely in Description.

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
curl -i -X POST https://api.kenntnis.ai/api/webhooks/platform/nonexistent \
  -H "Content-Type: application/json" \
  -H "x-telegram-bot-api-secret-token: wrong" \
  -d '{"update_id": 1, "message": {"text": "test"}}'
```
The bogus bot slug `nonexistent` forces a `resolve_bot_id_by_slug` lookup — which **requires a
working DB connection**. Interpreting the result:
- **404 + log `Webhook triggered for unknown bot slug: nonexistent`** → ✅ the DB was queried, no such
  bot, clean rejection. **`DATABASE_URL` (pooler) is confirmed working end to end.** (The bad slug is
  rejected *before* the secret is ever checked, so the wrong `secret_token` here is irrelevant — the
  bot doesn't exist to authenticate against.)
- **500 + log `getaddrinfo ENOTFOUND db.PROJECT_REF.supabase.co`** → `DATABASE_URL` is still the
  **direct** connection; fix it to the pooler string (see A7).
- **500 + a prepared-statement error** → add `prepare: false` to `lib/supabase.ts` (see A7).

When test 3 returns a clean 404 with the "unknown bot slug" log line, **Part A is verified complete**
— platform deployed, domain live, database reachable via the pooler, and the platform bot resolvable.

> `[VERIFY]` (nice-to-have) There's a `checkVaultSecretsHealth(entityId)` capability in `lib/capabilities.ts` with no route exposing it. A small admin/health endpoint running it per entity would let you verify an entity's Vault references resolve before going live (BACKLOG). Until then, the first real `@mention` answer (B4) is the per-entity end-to-end test.

Platform setup is complete. Everything below is per-entity (Part B), done once per tenant.

---

# Part B — Onboard a New Entity (new tenant)

> Onboard a **new entity** (tenant) onto the existing platform bot. **No per-entity bot, secrets, or
> webhook** — those belong to the platform (Part A, done once). Onboarding an entity is now three
> things: **create the entity**, **give it content**, and **bind a group** to it via `/auth`.
>
> **Current onboarding surfaces (a hybrid, by honest design):**
> - **Create entity** — web dashboard (`/manage`), or SQL (B1 below).
> - **Seed content** — SQL upsert into `doc_cache` (B2 below). *Interim* — see the signpost there.
> - **Bind a group** — `/auth` in Telegram, fully self-service (B3 below).
>
> **v1 content model:** content lives **directly in the `doc_cache` table** — no GitHub in the v1
> path. The store is abstracted; sync-sources (GitHub/Drive/Notion/…) can populate the same cache
> later (see `docs/VISION.md`, Surface 1). The GitHub-sync code exists but is dormant in v1.
>
> **Adding *another* group to an entity that already exists** is not a separate flow anymore — it's
> just **`/auth` again** in the new group (B3). There is no Part C.

## B1. Create the entity

**Preferred — the dashboard.** In `/manage` (the management plane, `app.leguan.ai`), create the
entity: set its `display_name`, `slug`, and the bot username it answers to. The dashboard performs the
privileged insert for you (it runs as a privileged role server-side). This is the self-service path
and the intended long-term one.

**Alternative — SQL.** If you're bootstrapping before the UI is convenient, insert directly in the
SQL editor (which connects as `postgres` and **bypasses RLS** — the correct path for entity creation,
since `bot_service` deliberately can't bootstrap a brand-new entity's first row).

```sql
-- Replace every <...> placeholder before running.
-- No bot/secret columns here anymore — bot identity lives in the platform `bots` row (Part A).
-- github_* columns are nullable (migration 20260624000000_relax_github_columns.sql) and omitted in v1.
insert into entities (slug, display_name, excluded_thread_ids)
values (
  '<your_slug>',                -- routing/identifier key: lowercase, URL-safe, stable, e.g. hys
  '<your_entity_display_name>', -- human-facing name, e.g. Hudson Yards Studios
  '{}'                          -- excluded_thread_ids: empty array is fine
)
returning id;
```

> **About the `slug`** — still a stable identifier, though post-Phase-3 it is **no longer a webhook
> routing key** (the webhook routes on the *bot* slug, not the entity slug). It stays unique
> (schema-enforced), lowercase/URL-safe, and stable (used in labels, `/manage` URLs, and as the
> entity's human-readable handle). The `display_name` can change freely; the slug shouldn't.
>
> **Why SQL bypasses RLS here:** the editor connects as `postgres` (superuser), bypassing the
> `WITH CHECK` policy — which is why entity *creation* works here even though `bot_service` couldn't.
> Entity creation is a privileged admin action; only the running app uses `bot_service`. (The
> dashboard does this same privileged insert programmatically.)

## B2. Seed content into the cache + manifest

> **⚠️ Interim step — moving to the dashboard.** Direct SQL is the *current* way to give an entity
> content; it is the manual stand-in for a **content-management UI** that doesn't exist yet (planned:
> a "Documents"/"Context" tab in `/manage`, mirroring the Linked Groups pattern — see Open Items and
> `docs/VISION.md`, Surface 1). When that ships, this SQL becomes the advanced/fallback path. Treat
> the SQL below as the *current reality*, not the intended permanent flow.

The bot answers from `doc_cache`. In v1 you push content **directly** into it (no GitHub sync). Run
in the SQL editor as `postgres`.

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
insert into doc_cache (entity_id, display_name, content)
values (
  '<entity-id>',
  '<document-display-name>',
  $KENNTNIS_DOC$
<<< PASTE CONTENT BELOW THIS LINE — do not touch the $KENNTNIS_DOC$ markers >>>

# Hudson Yards Studios — Overview

Replace this whole block with your real content. A few solid paragraphs the bot
should be able to answer from. Apostrophes are fine here — e.g. "we're a media
company", "the studio's mission" — no escaping needed.

<<< PASTE CONTENT ABOVE THIS LINE >>>
  $KENNTNIS_DOC$
);

-- 2. Map it as an ENTITY-GENERAL doc (loads for every topic): telegram_thread_id = null.
--    (Run once — manifest_entries has no unique constraint on these columns, so
--    re-running would create duplicates.)
insert into manifest_entries (entity_id, group_id, doc_id)
values ('<entity-id>', null, '<doc-id-from-B2.1>');
```
> **Why the `$KENNTNIS_DOC$` wrapper (and the #1 SQL-editor footgun):** in the Supabase SQL editor, an **apostrophe in your content** (we're, company's, etc.) will **break the statement** *unless* the content is dollar-quoted — a stray `'` is otherwise read as the *start* of a SQL string, and everything after it misparses (the editor often greys it out as if commented). Dollar-quoting (`$KENNTNIS_DOC$...$KENNTNIS_DOC$`) makes everything between the markers a literal, so apostrophes/quotes need **no** escaping. **Two rules:** (1) paste your content **only between** the markers, and (2) **don't disturb the `$KENNTNIS_DOC$` markers themselves** — if one gets altered or deleted, dollar-quoting collapses and apostrophes break again. The distinctive tag (`$KENNTNIS_DOC$` vs a bare `$$`) is chosen so real content can't accidentally contain it.

- **`doc_path` is just a logical identifier in v1** — despite the name, it is *not* a file path (the GitHub-era path meaning is gone). Use a short, **descriptive label** for what the doc is (e.g. `entity-context-overview`, `pricing-faq`, `board-onboarding`) rather than a path-like `context/overview.md` — the descriptive form is clearer in `/context` listings and in the cache. The only hard rule: it must **match exactly** between the `doc_cache` row and its `manifest_entries` row (they join on `entity_id` + `doc_path`), and be unique per entity (it's the cache's key).
- **Per-topic docs (optional):** for a topic-specific doc, push another `doc_cache` row and add a `manifest_entries` row with `telegram_thread_id = <the topic's message_thread_id>`. *(v1 resolution uses entity-general + per-topic; per-**group** scoping via `group_id` is not yet built — see `PLANNING.md` §9.)*
- **Re-seeding / editing content** later: just re-run the `doc_cache` upsert with new content (the `on conflict` updates it). This is the manual content-management path until the UI or a sync-source is added.

## B3. Bind a group via `/auth` (self-service)

This is the step that connects a Telegram group to the entity. It's fully self-service — **no SQL, no
per-group secrets, no webhook** — using the platform bot already set up in Part A. Repeat it for every
group the entity should serve (there is no separate "add another group" flow).

**Preconditions (the `/auth` handler enforces both):**
- The group must be a **forum group with Topics enabled** (the handler checks `chat.is_forum` and
  rejects otherwise — see the Topics note below). The rejection does **not** consume the code, so you
  can enable Topics and retry the same code.
- The person running `/auth` must be a **group admin** (verified via `getChatMember`).

**Steps:**
1. **Create/prepare the Telegram group with Topics enabled.** Settings → Topics → on (path varies by
   client). Enabling Topics upgrades a plain group to a supergroup and gives it the `-100…` chat id —
   the per-topic context model depends on `message_thread_id`, which only forum groups have.
2. **Add the platform bot** (`@leguan_the_bot`) to the group. Type the full username — a bot may not
   appear in `@`-autocomplete until Telegram caches it.
3. **Mint a code** in the dashboard: `/manage` → the entity → **Linked Groups** → generate a link
   code (tap-to-copy gives you the full `/auth <code>` string; codes are short-lived, ~10 min TTL).
4. **Run `/auth <code>`** in the group (any topic). On success the bot reacts 👀, then replies
   **"✅ This group is now linked to <entity>."**
5. **Verify** two ways: the dashboard's **Linked Groups** list shows the new group, and `/whoami` in
   the group now resolves the correct **Entity**.

> **What `/auth` does under the hood:** proves entity control (the code, minted by an owner/admin in
> the dashboard) + group control (Telegram admin check), then binds `chat_id → entity` in `groups`.
> The platform bot serves all entities, so the bind is what tells the runtime which entity a group's
> messages belong to (`chat_id → groups → entity`). See `docs/specs/SPEC-phase-2-group-linking.md`.
>
> ⚠️ **Topics changes the chat_id — enable it FIRST.** Enabling Topics on a plain group migrates it
> to a new `-100…` supergroup id. Since `/auth` binds whatever the current chat_id is, always enable
> Topics *before* running `/auth`, or you'll bind a stale id. (If you ever enable Topics *after*
> binding, the stored id goes stale and the bot silently stops resolving the group — re-run `/auth`,
> or operator-SQL the new id into the `groups` row.)

## B4. Test end-to-end

1. In a topic of the group, send `/help` → the static help reply (lists `/context`, `/recap`,
   `/whoami`, `/auth`, and `@mention`; **no `/ask`** — answering is @mention-based now).
2. **`@mention` the bot** with a question answerable from the seeded content (`@leguan_the_bot
   <question>`) → expect the 👀 reaction, a typing indicator, then an HTML-formatted answer in the
   correct topic. **(This is the milestone: the bot answering, grounded in your cached content.)**
3. Send `/context` → an inline summary of which docs load here, then a `context.md` attachment with
   the full content. (In a topic with no docs, the summary shows "none" and no file is sent.)
4. Send `/whoami` → the chat id, topic/thread id, your user id, and the resolved entity/group.
5. Send `/recap` → the 👀 reaction, then a recap of the last messages in this topic (default 20). Try
   `/recap 5`, `/recap 999` (clamps to max, notes it), `/recap banana` (falls back to default). A
   recap reflects both user questions and the bot's prior answers.
6. Send a plain (non-command) message → confirm a `message_log` row appears (validates privacy mode
   is off and message-logging works).
7. **Update content:** re-run the B2 `doc_cache` upsert with edited content → the next `@mention`
   answer reflects the change (confirms the cache is the live source).

> **If an `@mention` replies "Sorry, something went wrong":** that's the graceful error path — the
> pipeline worked but the async answer step threw. Check the Vercel logs. A common first-run cause is
> a **deprecated model id**: `Anthropic API call failed: 404 ... "model: <id>"` means `ANTHROPIC_MODEL`
> (or the code default) points at a retired model. Fix by setting `ANTHROPIC_MODEL` to a current id
> (e.g. `claude-sonnet-4-6`) and redeploying. (Model ids get deprecated over time; this is why it's an
> env var.) The platform bot's `bots.model` is null in v1, so it falls back to `ANTHROPIC_MODEL`.

The entity is live. Repeat **B3** (`/auth`) to bind additional groups to it; repeat all of Part B for
the next entity.

---

# Managing & Rotating Secrets

> Operational reference for the secret *lifecycle* — finding a secret you didn't record, and rotating
> one (a bot token may be regenerated in BotFather; the webhook secret or any secret may need rotating
> if compromised). **Post-Phase-3, the Telegram secrets are per-*bot*, not per-entity** — the platform
> bot's token + webhook secret live on its `bots` row (`token_secret_ref`, `webhook_secret_ref`).
> Entities no longer carry Telegram bot secrets. (A per-entity GitHub PAT still exists only if the
> optional GitHub sync-source is enabled — that stays on `entities.github_token_id`.)

## Finding a secret's UUID (you don't need to have written it down)

The secret UUIDs aren't floating loose — the **`bots` row stores them** (as text), so the bots table is
your index into Vault for Telegram secrets. To get a bot's secret UUIDs:

```sql
select slug, telegram_username, token_secret_ref, webhook_secret_ref
from public.bots
where slug = 'leguan';
```

Or list Vault secrets directly by the human-readable **label** you set in A6b.3:

```sql
-- a specific bot's secrets (label-based, e.g. the leguan bot):
select id, name, created_at from vault.secrets
where name like 'leguan_the_bot_%' order by name;

-- or everything, newest first:
select id, name, created_at from vault.secrets order by created_at desc;
```

(`name` is uniquely indexed, so each label maps to exactly one secret.) Between these two you can
always recover a UUID — via the `bots` row that references it, or by its label in `vault.secrets`.

> *(For an optional GitHub PAT, the reference is still `entities.github_token_id`:
> `select slug, github_token_id from entities where slug = 'hys';` — null unless GitHub sync is on.)*

## Rotating a secret (in place — keeps the same UUID)

The clean rotation path updates the secret's **value in place**, keeping the same UUID. Because the
`bots` row already points at that UUID, **nothing else has to change** — the reference now holds the
new value, and the app picks it up on its next call (it reads the current value via
`get_current_bot_secret`).

```sql
-- 1. Find the UUID (via the bots row or vault.secrets, above).
-- 2. Update the secret's value in place:
select vault.update_secret(
  'THE_SECRET_UUID',   -- e.g. bots.token_secret_ref
  'THE_NEW_VALUE'      -- the new token / secret
);
```

`[VERIFY]` Confirm the exact `vault.update_secret(...)` signature for your Supabase version (commonly `update_secret(id, new_secret [, new_name [, new_description]])`). The concept holds regardless: update in place, UUID unchanged, the `bots` reference still valid.

> **Telegram webhook secret rotation has an extra step:** if you rotate the webhook secret, you must
> *also* re-run `setWebhook` (A8c.1) with the new plaintext value, since Telegram stores its own copy
> and sends it in the header. (The bot token has no such external copy — only the Vault value matters.)

> **Bot token regenerated in BotFather?** If you `/revoke` or regenerate a bot's token in BotFather,
> BotFather issues a **new** token and the old one stops working — so the Vault value is now stale.
> Fetch the current token from BotFather (`/token` always shows it) and `vault.update_secret(
> <bots.token_secret_ref>, '<new token>')`. (This is exactly what reviving a *retired* bot requires.)

> **Alternative — new secret + re-point the bot (new UUID).** If you prefer a fresh secret (new
> name/UUID): `vault.create_secret('NEW_VALUE','new_name')` → capture the new UUID →
> `update public.bots set token_secret_ref = 'NEW_UUID' where slug = 'leguan';` → (optionally delete
> the old secret). More steps; the in-place update above is preferred for routine rotation. Both are
> privileged admin actions (run in the SQL editor as `postgres`).

> **GitHub PAT (only if the optional GitHub sync-source is enabled):** a fine-grained PAT expires, and
> an expired token silently stops doc-sync (the bot keeps answering from cache but goes stale).
> Rotation is the same in-place pattern: generate a new PAT → `vault.update_secret(
> <entities.github_token_id>, '<new_pat>')`. Not applicable to the v1 direct-cache path.

---

# Appendix — Quick reference

**Domains:**
- Bot/webhook **runtime** (infra): `api.kenntnis.ai` — and `*.preview.kenntnis.ai` for previews.
- Management **dashboard** (product): `app.leguan.ai` — `NEXT_PUBLIC_APP_URL` per environment; preview falls back to deployment origin.
- Supabase Auth: Site URL = `https://app.leguan.ai` (single, no wildcard); Redirect URLs allowlist holds localhost + prod + preview globs, each with `/**`. See A8b.

**Webhook URLs:**
- Telegram (single **platform** webhook): `https://api.kenntnis.ai/api/webhooks/platform/{bot-slug}` — e.g. `.../platform/leguan`. One webhook for the whole platform; routes on the **bot** slug.
- GitHub sync (optional, not used in v1): `https://api.kenntnis.ai/api/webhooks/github/sync` — resolves by repo; only relevant if the GitHub sync-source is enabled later.

**Environment variables (platform-wide):** `DATABASE_URL` (bot_service, **pooler** string), `ANTHROPIC_API_KEY`. `GITHUB_WEBHOOK_SECRET` is only needed if the optional GitHub sync-source is enabled (not used in v1).

**Admin script env var:** `ADMIN_DATABASE_URL` (privileged `postgres` role, **pooler** host) — used only by `scripts/sync-commands.ts`, run locally. Must be `export`ed. Never deployed.

**Per-bot secrets (in Vault):** the platform bot's telegram bot token + telegram webhook secret, referenced by `bots.token_secret_ref` / `bots.webhook_secret_ref` (UUID-as-text). (A per-entity GitHub token on `entities.github_token_id` exists only if the optional GitHub sync-source is enabled.)

**Content (v1):** lives directly in `doc_cache`, pushed via SQL (B2) — *interim*, moving to a `/manage` content tab. No GitHub in the v1 path; the store is abstracted so sync-sources (GitHub/Drive/Notion/etc.) can populate the cache later — see `docs/VISION.md`.

**The four `SECURITY DEFINER` RLS-bypass functions** (the only sanctioned bypass surfaces): `resolve_entity_id_by_slug`, `resolve_entity_id_by_repo` (GitHub sync, dormant in v1), `get_current_entity_secret` (entity-scoped secret access — `github_token_id`, plus the now-unused telegram refs until Phase 3.1 drops them), and `get_current_bot_secret` (Phase 3 — scopes Vault access to the current bot's token/webhook secret). Plus two non-secret bootstrap resolvers granted to `bot_service`: `resolve_bot_id_by_slug` and `resolve_entity_id_by_chat`. See `SECURITY-PROPOSAL.md` and `docs/specs/SPEC-phase-3-bot-cutover.md`.

**Prerequisite ordering (the parts that bite if done out of order):** Vault verified → `bot_service` role created → migration run (grants included) → platform bot created (`bots` row) → app deployed (pooler `DATABASE_URL`) → domain live → platform webhook registered (A8c).

---

## Open items this guide surfaced (for BACKLOG / Antigravity confirmation)

- **`prepare: false` in `lib/supabase.ts`** (A7) — ✅ confirmed set; required for the Supavisor transaction pooler.
- **`scripts/sync-commands.ts` is updated** (A8c) — ✅ repointed to iterate active platform bots (`bots` table) and decrypt tokens via `get_current_bot_secret`. Bulk-syncs all active bots from the shared command list in `lib/commands.ts`.
- **Phase 3.1 deferred cleanup** — once the platform bot is trusted in production: drop the now-unused `entities.telegram_bot_token_id` / `telegram_webhook_secret_id` / `telegram_bot_username` columns + modify `get_current_entity_secret` to drop their refs (keep `github_token_id`); delete the retired bots' Vault secrets; `/deletebot` the old bots in BotFather. Manual migration in `supabase/manual/`; snapshot the `entities` table first (a manual `pg_dump`/`select` suffices — data already mirrored into `bots`). See `docs/specs/SPEC-phase-3-bot-cutover.md` §9.
- **Content management in the dashboard** (B2) — v1 content is pushed via manual SQL upserts (the *interim* path). Planned: a "Documents"/"Context" tab in `/manage` (mirroring the Linked Groups pattern) that writes to `doc_cache` through a clean function/API boundary — which is also the seam a future sync-source/connector would target (see `docs/VISION.md`, Surface 1). Until then, B2's SQL is the content path.
- **`github_*` columns relaxed to nullable** (B1) — ✅ done (migration `20260624000000_relax_github_columns.sql`). The entity insert omits the nullable `github_*` columns in v1. (Future: a `sync_sources` refactor could move GitHub config out of `entities` when the content-store abstraction is formalized.) **Coordinated code change done:** the `Entity` TS interface in `lib/capabilities.ts` marks the `github_*` fields as `string | null`; the GitHub sync route has a config-completeness guard.
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

---

## Model Provider Operations

### Switching the Active Model/Provider (Configuration Action)
Swapping the model identifier or default provider is handled entirely via environment variable changes:
1. Update `MODEL_IDENTIFIER` (or `ANTHROPIC_MODEL`) in Vercel to the desired model ID:
   - For Anthropic: e.g. `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`.
   - For DeepSeek: e.g. `deepseek-v4-flash`, `deepseek-v4-pro`.
2. If swapping to a `deepseek-*` model, verify `DEEPSEEK_API_KEY` is set in Vercel.
3. Redeploy the application. The dynamic provider resolver (`resolveProvider`) routes matching model requests based on prefix.

### Adding a New Provider (Code Action)
Adding a brand-new provider requires extending code, not just changing configuration:
1. Create a new provider file under `lib/providers/` implementing the `ModelProvider` interface.
2. Register the routing logic (e.g. prefix match) inside `resolveProvider` in `lib/model.ts`.
3. Add the credential key to `.env.example`, the validator in `lib/config.ts` (if applicable), and document it in `DEPLOYMENT.md`.

### Data Governance Policy
> [!IMPORTANT]
> Setting `MODEL_IDENTIFIER` to a `deepseek-*` model routes all conversation context (user messages, system prompt contexts, and documents) to the DeepSeek API endpoint. Operators must verify DeepSeek's current terms, privacy posture, and location compliance before deploying a DeepSeek model configuration in production.

