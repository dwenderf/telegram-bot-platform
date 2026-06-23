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

### B4 — No cache-rebuild / bulk-seed endpoint
v1 content is pushed directly into `doc_cache` via SQL upserts (no GitHub in v1 — see `PLANNING.md` §2 revision). A small admin endpoint (or the eventual management UI) to manage/seed `doc_cache` content would replace the manual SQL and make onboarding/recovery cleaner. *Why it matters:* smoother onboarding; a recovery tool if the cache is ever cleared; the write path the web app needs.

### B5 — Expose `checkVaultSecretsHealth` via a route
`lib/capabilities.ts` has `checkVaultSecretsHealth(entityId)` but no route exposes it. Wire it to a small admin/health endpoint so an entity's Vault secret references can be verified before going live (catches a missing/deleted Vault secret clearly, rather than as a confusing first-auth failure). *Why it matters:* pre-launch verification per tenant.

### B6 — Confirm remaining version-specific commands
- **Migration application** (A5 in DEPLOYMENT): standardize on `npx supabase db push` (used successfully) vs. SQL-editor; pick one to avoid CLI history desync. *(`vault.create_secret(secret, name)` signature — confirmed working during first onboarding; `vault.update_secret(...)` still to confirm on first rotation.)*

### B7 — Rename `package.json` from `temp-next`
`package.json` still has the scaffold default `"name": "temp-next"`. Rename to the project (e.g. `telegram-bot-platform` or `kenntnis`). Trivial.

---

## Open — near-term features

### /context command (read-only context viewer)
A `/context` slash command that shows what the bot is answering from in the current entity + topic. Two parts:
- **Inline summary:** a short manifest/index view — which docs load here (e.g. "answering from: [general] overview.md, [topic] none"). Small, always useful; surfaces content gaps.
- **Full content as attached markdown file(s):** the actual loaded context (global/group doc + any topic doc) uploaded as Telegram file(s), sidestepping the ~4096-char message limit (same "Telegram holds a file of any size" insight as the `/draft` reframe).

*Why it matters:* makes the bot's knowledge transparent (trust/debugging, spotting content gaps), and is the read-only Telegram precursor to web-app content viewing/editing. Small build, exercises the "adding a command is easy" claim, good first thing to build after the multi-group test. Read-command (no model call) — simpler than `/ask`.

### Register bot commands (`setMyCommands`)
The bot's command menu/autocomplete is empty until commands are registered (via BotFather `/setcommands` or the Bot API `setMyCommands`). Typing `/ask` works regardless (the handler parses text), but registering populates the `/` menu. Do `ask` + `help` (+ `context` once built). The Bot API path is preferable long-term (the future onboarding UI automates it). *Surfaced during first onboarding — B1 in DEPLOYMENT didn't include it.*

### Better user-facing error messages (low priority)
When the async answer step throws, the bot replies with a generic "Sorry, something went wrong." That's good baseline UX (the graceful path works), but it's opaque. Low-priority improvement: optionally append `error.message` (or a friendlier mapped version) so the user/operator sees *what* failed (e.g. "the model is temporarily overloaded — try again" for a 529, vs. a config error). Its own small project; distinguish transient/retryable errors (429/529, `x-should-retry: true`) — which could even auto-retry — from real failures. *Surfaced when an Anthropic 529 "overloaded" (a transient outage) produced the generic message.*

---

## Open — non-security polish

### B1 — Model id: env-var default done; per-entity override remaining
**Partially resolved.** The hardcoded `claude-3-5-sonnet-20241022` (which was deprecated and returned a 404) is now read from `process.env.ANTHROPIC_MODEL` with a `'claude-sonnet-4-6'` fallback. So the platform-wide default is now config, not code.
**Remaining:** per-entity model override — resolve as `entity.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'`. Ties into the broader **per-tenant provider config** `{ provider, model, optional api_key_ref }` flagged for `PLANNING.md` (per-entity Anthropic keys / BYOK-vs-metered billing). *Why it matters:* different tenants may want different models/tiers; also the seam for per-tenant API keys.

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
