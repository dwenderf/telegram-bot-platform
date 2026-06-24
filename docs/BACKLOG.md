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

### Chat history: store bot responses + provenance metadata (foundation), summary-based retrieval (later)
Today only *incoming* (user) messages are logged to `message_log`; the bot's own answers are not stored, so a follow-up question can't draw on what the bot previously said. Build this in phases (deliberately separable):

- **Phase 1 — store the bot's response (cheap, do first).** On sending an answer, write a `message_log` row for the bot's outgoing message (full text). Pure upside: completes the history, and gives real data to *measure* whether follow-ups actually reference prior answers before investing in retrieval logic. No model changes.
- **Phase 2 — inline summary for long answers (UX-neutral, write-time).** Add a nullable `summary` column to `message_log`. For **long** bot responses only, have the model emit a 1–2 sentence summary **in the same generation call** that produces the answer (cheap — only the summary's output tokens; the model already has full context, so no extra round-trip / no re-sending the answer as input). User-facing reply is unchanged (details only, as today); the summary is stored, not shown. `summary` is null for user messages and short bot responses.
- **Phase 3 — summary-based retrieval (the actual context-bloat fix).** When building context for a new question, pull prior bot answers via `coalesce(summary, message_text)` — the summary when present, full text otherwise. One expression, no branching; the null-vs-filled distinction carries all the logic. This is what keeps the context window bounded without losing the gist of prior answers.
- **Provenance metadata (pairs with Phase 1/2, same write).** Add a `jsonb` column (e.g. `generation_metadata`) on bot-response rows capturing how the answer was derived: `{ model, context_doc_paths: [...], history_message_ids: [...], thread_id, token_counts?, latency_ms? }`. The bot doesn't *read* it to function; it's an observability/provenance record for diagnosing "why did it answer this way?" and the foundation for a future debug view / web-UI "explain this answer." Nearly free to capture at write-time, hard to reconstruct later — so capture now even before there's a UI to view it.

*Sequencing:* Phase 1 + the metadata column are the cheap foundation (one migration: add `summary` + `generation_metadata`; one code change: log the outgoing message). Then **watch real traffic** to see if follow-ups referencing prior answers are common before building Phase 2/3 — if they're rare, the summary machinery may not be worth it; if common, it's justified. Don't build the retrieval ahead of the evidence. *Why it matters:* better multi-turn answers + answer explainability, without unbounded context growth.

### Typing indicator persists for long answers
Telegram's `sendChatAction` ("typing…") **auto-clears after ~5 seconds** (Telegram-side behavior). When answer generation takes longer than that — common for the multi-query model path — the indicator vanishes before the answer arrives, leaving a few seconds of dead air. Fix: **re-send the typing action periodically** (every ~4s) while generating, and stop when the answer is sent (e.g. a keep-alive interval kicked off at generation start, cleared on send). Small, self-contained UX polish. *Surfaced in normal use — the gap is minor but not ideal.*

### Better user-facing error messages (low priority)
When the async answer step throws, the bot replies with a generic "Sorry, something went wrong." That's good baseline UX (the graceful path works), but it's opaque. Low-priority improvement: optionally append `error.message` (or a friendlier mapped version) so the user/operator sees *what* failed (e.g. "the model is temporarily overloaded — try again" for a 529, vs. a config error). Its own small project; distinguish transient/retryable errors (429/529, `x-should-retry: true`) — which could even auto-retry — from real failures. *Surfaced when an Anthropic 529 "overloaded" (a transient outage) produced the generic message.*

---

## Open — non-security polish

### B1 — Model id: env-var default done; per-entity override remaining
**Partially resolved.** The hardcoded `claude-3-5-sonnet-20241022` (which was deprecated and returned a 404) is now read from `process.env.ANTHROPIC_MODEL` with a `'claude-sonnet-4-6'` fallback. So the platform-wide default is now config, not code.
**Remaining:** per-entity model override — resolve as `entity.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'`. Ties into the broader **per-tenant provider config** `{ provider, model, optional api_key_ref }` flagged for `PLANNING.md` (per-entity Anthropic keys / BYOK-vs-metered billing). *Why it matters:* different tenants may want different models/tiers; also the seam for per-tenant API keys.

---

## Done

- **`/context` command — shipped & runtime-verified.** Read-only context viewer: inline status summary (Entity/Group/Topic — `✓ N document(s)` / `none set` / `not enabled`) + full content as an attached `context.md` file (sidesteps the ~4096-char limit). `getContextManifest` mirrors `buildContext`'s resolution so it can't drift from `/ask`; `sendDocument` multipart helper added. Spec: `docs/specs/SPEC-context-command.md` (+ Addendum 1 for the status-based summary). Verified end-to-end (file downloads correctly from Telegram).
- **`setMyCommands` — done.** Registered `/ask`, `/context`, `/help` in the bot command menu; now a documented step (DEPLOYMENT B7). Re-run when the command set changes (e.g. adding `/whoami`).
- **B2 — null-thread (General topic) doc resolution — fixed.** Both `getContextManifest` and `buildContext` now use `(m.telegram_thread_id is null or m.telegram_thread_id is not distinct from ${threadIdStr})` — null-safe, makes #general resolve to entity-general docs only (no reliance on `= null`), and keeps the two functions in sync. (Was: `= ${threadIdStr}`, correct only by SQL null-comparison accident.)
- Database security model (RLS + Vault + bootstrap functions + least-privilege role). See `SECURITY-PROPOSAL.md` (resolved).
- `.env.example` corrected to connect as `bot_service` (not superuser); unused `SUPABASE_SERVICE_ROLE_KEY` removed.
- **B0 — Table-privilege GRANTs for `bot_service` (resolved).** The migration `20260618000000_init_schema.sql` now grants `usage`/`select`/`insert`/`update`/`delete` on all tables, sequence usage, and `alter default privileges` for future tables to `bot_service` — appended after the `grant execute` lines in section 5. Verified: grants are at the end of the migration (after all `create table`), so they correctly cover all eight tables. A fresh `supabase db push` now produces a working role in one step. (Was: migration granted only `execute` on functions, so `bot_service` had no base table access and the app would fail with permission errors despite correct RLS.)

---
