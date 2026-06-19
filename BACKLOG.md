# Backlog / Known Items

> Running list of known issues, deferred polish, and small follow-ups for the v1 build.
> **Larger deferred features** (write-commands, `/setup`, group-scoped context, web app, public API, etc.) live in `PLANNING.md` §9 "Non-Goals & Future Hooks" — this file is for smaller bugs/polish that surface during the build.
> **Security model** is implemented and verified — see `SECURITY-PROPOSAL.md` (resolved) for the rationale record.

---

## Open — CRITICAL / blocking deploy

### None

## Open — deployment verification (surfaced by DEPLOYMENT.md)

These are items the deployment runbook flagged as needing confirmation against the current code / intended workflow, or as missing tooling that would make setup cleaner. None block a careful manual deploy, but each is worth resolving.

### B3 — Entity creation: manual SQL now, admin function later
`entities` has a `WITH CHECK` RLS policy keyed on `app.current_entity_id`, which creates a chicken-and-egg for the *first* row of a new entity (the id doesn't exist yet to set in the session). For **v1 this is intended to be a privileged admin action**: create entities via the Supabase SQL editor, which connects as `postgres` and bypasses RLS. This is correct and fine — entity creation is rare and inherently privileged.
- **Now:** document this clearly (done in `DEPLOYMENT.md` B5) so no one tries to create entities via the `bot_service` connection and is confused when RLS blocks it.
- **Later (future feature):** build a proper admin path for tenant creation — an internal admin function / dashboard / sign-up flow that performs the privileged insert programmatically. This is the natural home for it once the management UI exists (it does, as a privileged operation, what the SQL editor does by hand today). Tracks with the web-app/management-UI direction in `PLANNING.md` §9.

### B4 — No cache-rebuild / seed endpoint
The bot reads docs from `doc_cache`, which is populated only by the GitHub sync webhook. Initial seeding therefore requires triggering the webhook (e.g. a trivial commit to the content repo). A standalone "rebuild this entity's cache from its repo" admin function would make onboarding and recovery cleaner (and reinforces the "cache is rebuildable from Git" principle in `PLANNING.md` §2.2). *Why it matters:* smoother onboarding and a recovery tool if the cache is ever cleared.

### B5 — Expose `checkVaultSecretsHealth` via a route
`lib/capabilities.ts` has `checkVaultSecretsHealth(entityId)` but no route exposes it. Wire it to a small admin/health endpoint so an entity's Vault secret references can be verified before going live (catches a missing/deleted Vault secret clearly, rather than as a confusing first-auth failure). *Why it matters:* pre-launch verification per tenant.

### B6 — Confirm version-specific setup commands
Two steps in `DEPLOYMENT.md` depend on Supabase-version specifics worth confirming on the first real deploy:
- **Vault insertion API** (B3 in DEPLOYMENT): the exact `vault.create_secret(secret, name)` signature.
- **Migration application** (A5 in DEPLOYMENT): `npx supabase db push` vs. SQL-editor; pick one to avoid CLI history desync.

### B7 — Rename `package.json` from `temp-next`
`package.json` still has the scaffold default `"name": "temp-next"`. Rename to the project (e.g. `telegram-bot-platform` or `kenntnis`). Trivial.

---

## Open — non-security polish

### B1 — Move the model id to per-tenant config (currently hardcoded)
`lib/capabilities.ts` (`answerQuestion`) hardcodes the model:
```ts
const model = 'claude-3-5-sonnet-20241022';
```
`PLANNING.md` §4.2 specifies the model id should live in **per-entity config** (so it's tunable per-tenant and updatable without a code change). Two parts:
- Move the model id into entity config (e.g. an `entities.model` column or a config table) and read it per request.
- The hardcoded value is also an **older Sonnet**; pick a current model when wiring this up.

*Why it matters:* product flexibility (different tenants may want different models/tiers) and avoids a code deploy to change models. Not urgent for a single-tenant POC, but it's a §4.2 requirement and cheap to do.

### B2 — Verify null-thread (General topic) doc resolution in `buildContext`
`lib/capabilities.ts` (`buildContext`) matches topic docs with:
```sql
where m.entity_id = ${entityId}
  and (m.telegram_thread_id is null or m.telegram_thread_id = ${threadIdStr})
```
When a question is asked in the **General topic**, `threadIdStr` is `null`. The `is null` branch still loads the entity-general docs correctly, so this is likely fine — but the `m.telegram_thread_id = ${null}` comparison won't match any topic-specific entries the way `is not distinct from` would. (The recent-messages query in the same function correctly uses `is not distinct from`.)
- **Confirm** a General-topic question resolves the intended docs.
- If General is ever meant to have its *own* topic-specific manifest entries (thread_id null but distinct from "general"), reconcile the semantics — currently "null thread" and "entity-general" are the same thing, which is probably the intended design, but worth an explicit check.

*Why it matters:* correctness of context loading in the General topic. Low risk given the `is null` branch covers the common case, but worth a deliberate confirmation.

---

## Done

- Database security model (RLS + Vault + bootstrap functions + least-privilege role). See `SECURITY-PROPOSAL.md` (resolved).
- `.env.example` corrected to connect as `bot_service` (not superuser); unused `SUPABASE_SERVICE_ROLE_KEY` removed.
- **B0 — Table-privilege GRANTs for `bot_service` (resolved).** The migration `20260618000000_init_schema.sql` now grants `usage`/`select`/`insert`/`update`/`delete` on all tables, sequence usage, and `alter default privileges` for future tables to `bot_service` — appended after the `grant execute` lines in section 5. Verified: grants are at the end of the migration (after all `create table`), so they correctly cover all eight tables. A fresh `supabase db push` now produces a working role in one step. (Was: migration granted only `execute` on functions, so `bot_service` had no base table access and the app would fail with permission errors despite correct RLS.)

---
