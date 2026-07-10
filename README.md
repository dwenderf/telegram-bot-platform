# Telegram Bot Platform

> [!WARNING]
> **Model Capability Warning**: The hardcoded document capability model (`ANTHROPIC_DOCUMENT_MODEL` = `'claude-sonnet-5'`) is defined in `lib/config.ts`. If this model is deprecated by Anthropic, it must be updated in `lib/config.ts` to prevent document Q&A failures.

A multi-tenant platform for AI assistants embedded in Telegram groups, where each assistant answers questions grounded in a team's own documentation hosted on GitHub.

Built with **Next.js 15 (App Router / Headless API)** and **Supabase (Postgres)**.

---

## 🔒 Security & Tenant Isolation Model

Tenant isolation and database security are built-in from day one. The platform uses a multi-layered security model to guarantee data confidentiality.

### 1. Row-Level Security (RLS)
Every table containing tenant-scoped data carries an `entity_id` column. PostgreSQL Row-Level Security is strictly enabled and forced (`FORCE ROW LEVEL SECURITY`) on all operational tables. The application connects using a restricted, non-superuser role (`bot_service`) subject to RLS.

### 2. RLS Bootstrapping & Tenant Isolation
Since the `bot_service` role is subject to RLS, a query to any tenant table (like `entities` or `groups`) will return `0` rows by default until the transaction session variable `app.current_entity_id` is set.

To resolve the circular bootstrapping problem and decrypt secrets securely without exposing the entire database or Vault, the database exposes exactly **three** tightly-scoped, RLS-bypassing helper functions:
* **`resolve_entity_id_by_slug(p_slug text)`**: A `security definer` function that searches `entities` and returns **only** the matching UUID `id` (and no other data).
* **`resolve_entity_id_by_repo(p_owner text, p_repo text)`**: A `security definer` function that resolves a repository owner/name to its matching UUID `id`.
* **`get_current_entity_secret(p_secret_id uuid)`**: A `security definer` function that returns the decrypted secret string from `vault.decrypted_secrets` **only** if the secret is referenced by the active session tenant (`app.current_entity_id`).

Once the Next.js app resolves the UUID, it runs all subsequent database operations inside the RLS tenant context using `withTenantContext`:
```typescript
await tx`SELECT set_config('app.current_entity_id', ${entityId}, true)`;
```
All tables are RLS-isolated using matching `USING` and `WITH CHECK` clauses, guaranteeing that the database connection can never read or write data belonging to a different tenant.

### 3. Encrypted Secrets at Rest (Supabase Vault)
Per-tenant API tokens and secrets—including `telegram_bot_token`, `telegram_webhook_secret`, and `github_token`—are encrypted at rest using **Supabase Vault**.
* The `entities` table holds references (UUIDs) to `vault.secrets` rather than storing plaintext credentials.
* At runtime, the application queries decrypted secrets using `get_current_entity_secret(...)` inside the tenant's RLS context.
* The application role `bot_service` has **no SELECT access** to the global `vault.decrypted_secrets` view, ensuring a tenant session can never decrypt another tenant's credentials.

### 4. Least-Privilege Database User (`bot_service`)
To prevent a leak of the master `postgres` superuser credential, create a restricted database user for the application as a prerequisite.

> [!NOTE]
> The database migration automatically handles all required schema, table, sequence, and helper function execution privileges. You only need to manually create the role and configure its default session context prior to running the migration:

```sql
-- 1. Create a dedicated role with login credentials
CREATE ROLE bot_service WITH LOGIN PASSWORD 'your_very_secure_password';

-- 2. Enforce RLS by default by setting the session variable to empty
ALTER ROLE bot_service SET app.current_entity_id = '';
```

---

## 🛠️ Getting Started

> **For the complete, step-by-step setup and deployment runbook — Supabase project, Vault, the `bot_service` role, the schema migration, Vercel deploy, DNS, and per-tenant onboarding (Telegram bot, secrets, content repo, webhooks) — see [`DEPLOYMENT.md`](./DEPLOYMENT.md).** The quick start below is the abbreviated local-dev path; `DEPLOYMENT.md` is the authoritative end-to-end guide.

> **Design docs** live in [`docs/`](./docs/): [`PLANNING.md`](./docs/PLANNING.md) (architecture of record + build spec), [`SECURITY-PROPOSAL.md`](./docs/SECURITY-PROPOSAL.md) (tenant-isolation/RLS model), [`MANAGEMENT-PROPOSAL.md`](./docs/MANAGEMENT-PROPOSAL.md) (future web-management plane), and [`BACKLOG.md`](./docs/BACKLOG.md). Feature build-specs live in [`docs/specs/`](./docs/specs/).

### 1. Configure Environment Variables
Copy the `.env.example` file and supply your environment details:
```bash
cp .env.example .env.local
```

### 2. Deploy Schema to Supabase
> [!IMPORTANT]
> **Prerequisite:** Before running the migration script, you must create the `bot_service` role (as shown in the role setup section above), since the migration script makes explicit privilege grants to it.

Run the initialization migration script located in [supabase/migrations/20260618000000_init_schema.sql](./supabase/migrations/20260618000000_init_schema.sql) using the Supabase SQL editor.

### 3. Running the Server

Run the Next.js development server:
```bash
npm run dev
```

Build the production server:
```bash
npm run build
npm run start
```

---

## 🌐 Webhook Endpoint Structure

* **Telegram Webhook**: `/api/webhooks/telegram/[entitySlug]`
  * Receives updates from Telegram.
  * Responds `200 OK` instantly to prevent duplicate retries.
  * Invokes the LLM pipeline asynchronously using Vercel's `waitUntil()`.
* **GitHub Sync Webhook**: `/api/webhooks/github/sync`
  * Receives commit push payloads.
  * Compares changes using the GitHub Compare API and syncs document caches in the background.
