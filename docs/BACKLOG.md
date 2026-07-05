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

### Chat history: bot-response storage (Phase 1 DONE), summary + summary-based retrieval (Phases 2/3 deferred)
Today only *incoming* (user) messages are logged to `message_log`; the bot's own answers are not stored, so a follow-up question can't draw on what the bot previously said. Build this in phases (deliberately separable):

- **Phase 1 — store the bot's response (cheap, do first). ✅ DONE & verified** (see Done section). The bot's outgoing answers are now logged, and the `summary` + `generation_metadata` columns were added in the same migration (sitting null/ready for Phases 2/3). This completes the history and gives real data to *measure* whether follow-ups actually reference prior answers before investing in retrieval logic.
- **Phase 2 — inline summary for long answers (UX-neutral, write-time).** Add a nullable `summary` column to `message_log`. For **long** bot responses only, have the model emit a 1–2 sentence summary **in the same generation call** that produces the answer (cheap — only the summary's output tokens; the model already has full context, so no extra round-trip / no re-sending the answer as input). User-facing reply is unchanged (details only, as today); the summary is stored, not shown. `summary` is null for user messages and short bot responses.
- **Phase 3 — summary-based retrieval (the actual context-bloat fix).** When building context for a new question, pull prior bot answers via `coalesce(summary, message_text)` — the summary when present, full text otherwise. One expression, no branching; the null-vs-filled distinction carries all the logic. This is what keeps the context window bounded without losing the gist of prior answers.
- **Provenance metadata (pairs with Phase 1/2, same write).** Add a `jsonb` column (e.g. `generation_metadata`) on bot-response rows capturing how the answer was derived: `{ model, context_doc_paths: [...], history_message_ids: [...], thread_id, token_counts?, latency_ms? }`. The bot doesn't *read* it to function; it's an observability/provenance record for diagnosing "why did it answer this way?" and the foundation for a future debug view / web-UI "explain this answer." Nearly free to capture at write-time, hard to reconstruct later — so capture now even before there's a UI to view it.

*Sequencing:* Phase 1 + the metadata column are the cheap foundation (one migration: add `summary` + `generation_metadata`; one code change: log the outgoing message). Then **watch real traffic** to see if follow-ups referencing prior answers are common before building Phase 2/3 — if they're rare, the summary machinery may not be worth it; if common, it's justified. Don't build the retrieval ahead of the evidence. *Why it matters:* better multi-turn answers + answer explainability, without unbounded context growth.

### Typing indicator persists for long answers
Telegram's `sendChatAction` ("typing…") **auto-clears after ~5 seconds** (Telegram-side behavior). When answer generation takes longer than that — common for the multi-query model path — the indicator vanishes before the answer arrives, leaving a few seconds of dead air. Fix: **re-send the typing action periodically** (every ~4s) while generating, and stop when the answer is sent (e.g. a keep-alive interval kicked off at generation start, cleared on send). Small, self-contained UX polish. *Surfaced in normal use — the gap is minor but not ideal.*

### Proactive "no context yet" notice for new topics (base-UX polish)
When a new forum topic is created in a bound group, the bot could **detect it** (Telegram emits a
`forum_topic_created` service message; alternatively a cron job polls for unseen `message_thread_id`s)
and **proactively post a short note** — e.g. "No context has been set for this topic yet; answers here
will use the group/entity context. An admin can add topic-specific docs in the dashboard." Turns a
silent gap (a topic with no docs, where users may not realize why answers are generic) into a visible,
actionable nudge.
- **Pairs with Phase 4** (group/topic context resolution): once layered resolution exists, "this topic
  has no topic-layer context" becomes a meaningful, detectable state worth surfacing.
- **Related to `PLANNING.md` §9** `forum_topic_created` / `/setup` scaffolding: same event detection,
  but this is the *notification* cousin (nudge the humans) vs. the *auto-scaffold* cousin (create a
  manifest entry + starter doc). Could share the event-listener plumbing.
- **Category:** base-platform UX polish — make the *existing* product feel finished before stacking
  new layers on top. **Not yet** — just captured. *Why it matters:* reduces "why is the bot giving
  generic answers here?" confusion; a small touch that makes the product feel attentive.

### Sync Telegram display names (groups + topics) + `threads.display_name`
The stored display names drift from Telegram's actual names. Two related gaps:
- **`groups.display_name` goes stale** when a group is renamed in Telegram — nothing updates the stored
  value. (Telegram emits a `new_chat_title` service message on group rename.)
- **`threads` has no `display_name` column at all** — topic names aren't stored. Add a nullable
  `display_name` to `threads` (the normalization anticipated this: "room for future metadata"). Topic
  names arrive via `forum_topic_created` (name at creation) and `forum_topic_edited` (name change).

**The feature:** a webhook listener for these three service-message update types that keeps
`groups.display_name` / `threads.display_name` in sync going forward. The handler currently ignores
service-message update types — this adds handling for them.
- **Two parts, distinct:** (1) the **ongoing listener** keeps names fresh from now on; (2) a **one-time
  backfill** of the currently-stale `groups.display_name` values — the listener won't fix already-stale
  names unless the group is renamed again. *(The one-time backfill is trivial — 4 groups — and is done
  manually in the Supabase table editor; only the ongoing listener is a build.)*
- **Shares plumbing with the "proactive no-context notice"** item above — `forum_topic_created` is the
  same event both features listen for (one nudges the humans, this one records the name; both want the
  service-message listener). Build the listener once, hang both behaviors off it.
- **Category:** base-platform UX polish. **Not yet** — captured. *Why it matters:* stale group/topic
  names are a small but visible "this feels unmaintained" signal; and `threads.display_name` is the
  natural home for topic names that `/context`, a future content UI, and the proactive-notice feature
  all want.

### Content UI: warn on duplicate `display_name` (when the content-management UI is built)
`doc_cache` deliberately has **no** DB uniqueness on `(entity_id, display_name)` — duplicate doc names
are a legitimate case (e.g. two groups each with an "Onboarding" doc), and identity is `doc_cache.id`,
so nothing breaks. But a duplicate name is *usually* a mistake. When the content-management UI exists,
it should **warn** (soft "you already have a doc called that — continue?"), not hard-fail. This is the
UI-level guardrail that replaces the DB constraint we intentionally didn't add. *Why it matters:*
catches accidental dupes without forbidding legitimate ones — enforce integrity at the DB, UX at the UI.

### Better user-facing error messages (low priority)
When the async answer step throws, the bot replies with a generic "Sorry, something went wrong." That's good baseline UX (the graceful path works), but it's opaque. Low-priority improvement: optionally append `error.message` (or a friendlier mapped version) so the user/operator sees *what* failed (e.g. "the model is temporarily overloaded — try again" for a 529, vs. a config error). Its own small project; distinguish transient/retryable errors (429/529, `x-should-retry: true`) — which could even auto-retry — from real failures. *Surfaced when an Anthropic 529 "overloaded" (a transient outage) produced the generic message.*

---

## Open — platform direction (user-signal-backed)

> These are larger than the polish items above and point toward the open-platform direction in
> `docs/VISION.md`. They're recorded here (not just in VISION) because each has a **concrete first
> increment** and a **real user signal** — making them buildable adjacent steps, not just horizon.
> Discipline: build the *specific* increment when it's justified, not the grand version.

### P1 — Reference content connector: GitHub first (then Notion)
v1 content lives directly in `doc_cache`, pushed via SQL (DEPLOYMENT B2). The store is abstracted so
alternate **sync-sources** can populate the same cache without touching the answer path. We build a
**reference connector** ourselves — day-one utility *and* a worked example others extend later (see
`docs/VISION.md` → Sphere of focus).
- **GitHub first** (not Notion): the GitHub-sync framework already partly exists (dormant adapter
  code), and a git repo is a far simpler document source than Notion's block model. Pull/sync repo
  content into `doc_cache`, keeping it fresh on push.
- **First increment:** one-direction GitHub→`doc_cache` sync for a single entity (webhook on push, or
  manual trigger), reusing the retained sync code. Not a generic connector framework — one real
  source, proving the ingestion boundary (`P3`).
- **Notion: later.** Same pattern, second connector — has its own user signal (the Notion user,
  2026-06-29) but is deferred behind GitHub on grounds of build simplicity. When built, it validates
  that the ingestion boundary truly generalizes beyond git.
- **Dependency/seam:** ingestion should go through a clean function/API boundary (`P3`), which is also
  what a future third-party connector targets. See `docs/VISION.md` Surface 1.
- *Why it matters:* day-one content utility for non-SQL users; the first reference implementation that
  seeds the connector ecosystem; reuses existing GitHub-sync investment.

### P2 — Private / permissioned custom bots (bot-store MVP)
The `bots` table is first-class and decoupled from entities, with `persona` / `model` / `capabilities`
stub columns and a dormant `bot_entities` authorization table. Together these support a **private,
permissioned specialized bot** — a user brings a bot with their own skills/persona (and possibly own
model source), gated via whitelist to authorized entities/groups. **No commerce, no public listing**
— this is the bot-store *infrastructure* without the marketplace on top.
- **First increment:** register one specialized bot (own `bots` row, own slug/token/webhook, a
  persona/skill config) and gate its use to a whitelist via `bot_entities`. Curated/manual onboarding
  (operator creates the bot) is fine and appropriate at low volume — the human gate is a feature.
- **Seams already planted:** `bots.persona/model/capabilities` (the registered-backend seam);
  `bot_entities` (the whitelist mechanism). Per-bot routing is already native (Phase 3).
- **Invariant:** consumer onboarding (add bot, `/auth`, done) stays self-service; only the *submitter*
  path is manual/curated.
- **User signal (2026-06-29):** a collaborator wants his own AI skills usable by him and the people he
  works with — explicitly *not* to sell, just to use privately with a permissioned group. *Why it
  matters:* a real, scoped first customer for the bot-store foundation, de-risking it before any
  marketplace. See `docs/VISION.md` Surface 2.

### P4 — External/third-party bot model authentication (do when a real external-bot integration exists)
The `ModelProvider` abstraction (`docs/specs/SPEC-model-provider-abstraction.md`) establishes the
enabling principle: **a provider owns its authentication at construction; `CallModelInput` describes
only the request (prompt, model, `cacheable`) and never carries credentials.** That principle must be
protected as provider auth grows beyond our own static keys.
- **Two auth models, categorically different.** (1) *Static credentials we hold* — our own bots, our
  own Anthropic/DeepSeek keys, known at construction (what the v1 provider does today, reading an env
  var). (2) *Delegated/dynamic auth* — an external bot in the open ecosystem (`P2`, `docs/VISION.md`
  Surface 2) authenticating against **its own** provider account, via a flow that mints a scoped,
  short-lived credential rather than a static string we store.
- **The forward-compatible mental model (bank this, don't build it):** a provider is **constructed from
  a config record whose credential source can vary** — today "the `ANTHROPIC_API_KEY` env var"; later a
  **Vault handle** (the pattern already exists: per-tenant Telegram/GitHub secrets resolve via
  `get_current_entity_secret` — a per-bot model credential would resolve the same way) or a **token
  from the bot creator's API**. This keeps the future case an *extension*, not a rewrite. Ties to the
  per-tenant `{ provider, model, optional api_key_ref }` config flagged in `B1` / `PLANNING.md`.
- **The "creator returns a callable" pattern — right shape, two corrections.** A creator/registry
  service handing back a ready-to-use provider (rather than a raw key) is good design: the credential
  stays on the creator's side, so we can't leak/log/store it (a capability-object trust boundary). But
  across a network boundary you **cannot receive a live interface-conforming object** — only data. So:
  (a) the creator returns a **scoped, short-lived handle** (endpoint + expiring token) and **we
  construct a local `RemoteProvider implements ModelProvider`** around it that makes the actual call —
  "conforms to the interface" is real, but *we* build it locally, not over the wire. (b) The returned
  reference is **untrusted third-party input** (same suspicion as the webhook payload boundary): an
  attacker-supplied endpoint your server then calls with credentials in scope is an **SSRF/request-
  forgery surface**. The `RemoteProvider` must treat the handle as untrusted — allow-listed domains,
  validated shape, scoped token, timeouts, no pointing your server at arbitrary hosts.
- **Guardrail to never violate:** credentials/endpoints must never enter `CallModelInput`. Auth stays
  at provider construction; the request contract stays credential-free.
- **Do NOT build ahead of a concrete external-bot integration** — the right shape for delegated auth
  (BYO-account vs. metered-under-our-quota, OAuth vs. key-passthrough vs. token-minting, who bears cost
  and trust) depends on questions the ecosystem hasn't answered yet. The v1 interface is compatible with
  all of these, which is the point: waiting costs nothing. *Why it matters:* it's the auth foundation
  the bot-store (`P2`) needs, and getting the "provider owns auth, input stays credential-free" boundary
  right now (already true) keeps every future variant a clean addition.

### P3 — Clean content-ingestion boundary (forward-compat seam — do when content-management is built)
Not a feature on its own, but a **constraint** on the content-management work (the `/manage`
Documents/Context tab that will replace DEPLOYMENT B2's manual SQL): whatever writes to `doc_cache`
should go through a well-defined function/API boundary, **not** ad-hoc SQL scattered across call
sites. That boundary is the single door that (a) the web UI writes through, (b) a Notion/Git
sync-source (`P1`) writes through, and (c) a future third-party connector would target. *Why it
matters:* it's nearly free to get right while building the content UI, and expensive to retrofit; it's
the enabling seam for the whole open-connector direction (`docs/VISION.md` Surface 3). **Do not build
ahead of the content UI** — just build the content UI *through* a clean boundary when that work
happens.

> **Enforce entity-consistency at write time (the boundary's one real safety check).** Today, cross-
> entity isolation on doc resolution is enforced *only at read time* — `buildContext`/`getContextManifest`
> filter `where m.entity_id = ${entityId}`, so a `manifest_entries` row pointing at another entity's
> `doc_id` simply doesn't resolve (verified live: it produces "no doc," never a cross-tenant leak — the
> safe failure mode). But **nothing prevents *writing* such a row** — there's no FK/constraint saying a
> manifest row's `doc_id` must belong to the manifest's `entity_id`. In the **web UI** this is a
> non-issue (a user only ever sees their own entity's docs to link). The real exposure is the
> **API / external-write path** (a connector or external caller sending `entity_id` + `doc_id`
> directly): a caller could link another entity's doc — by mistake, or as a cross-tenant probe. The
> read filter still blocks the *read*, but the write should be rejected at the boundary so the caller
> gets a clear "that document isn't yours" error rather than silently creating a dead mapping. **So when
> the ingestion boundary is built, it must validate that `doc_id`'s entity matches the target
> `entity_id` before writing.** The safety currently lives in the resolver; the write API must not
> assume it — it must add its own check. (Defense-in-depth option, if ever wanted: a DB-level
> constraint enforcing manifest↔doc entity-consistency — but the write-boundary check is the primary,
> sufficient guard.)

---

## Open — non-security polish

### B1 — Model id: env-var default done; per-entity override remaining
**Partially resolved.** The hardcoded `claude-3-5-sonnet-20241022` (which was deprecated and returned a 404) is now read from `process.env.ANTHROPIC_MODEL` with a `'claude-sonnet-4-6'` fallback. So the platform-wide default is now config, not code.
**Remaining:** per-entity model override — resolve as `entity.model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'`. Ties into the broader **per-tenant provider config** `{ provider, model, optional api_key_ref }` flagged for `PLANNING.md` (per-entity Anthropic keys / BYOK-vs-metered billing). *Why it matters:* different tenants may want different models/tiers; also the seam for per-tenant API keys.

### B8 — Normalize `AnthropicProvider` key handling to match `DeepSeekProvider` (lazy + fail-fast)
The two providers handle their API key **inconsistently**, an artifact of when each was written (Anthropic predates the provider-abstraction refactor; DeepSeek was written fresh to the better pattern):
- **`DeepSeekProvider`** reads `DEEPSEEK_API_KEY` **inside its constructor** (lazy — only when the provider is actually resolved) and **fails fast** with a thrown error if it's missing. Clean: the key is required exactly when a `deepseek-*` model is used, and a missing key produces a clear error at the point of use.
- **`AnthropicProvider`** (`lib/providers/anthropic.ts`) reads `ANTHROPIC_API_KEY` at **module top-level** (eager — runs on *import*, even in a DeepSeek-only deployment, because `model.ts` imports the class), only **`console.warn`s** when missing, and constructs the client with **`apiKey || 'dummy-key'`**. So a missing Anthropic key silently degrades to a non-functional dummy client instead of failing — and if the resolver ever falls back to Anthropic (unset/misconfigured `MODEL_IDENTIFIER`, or a `claude-*` string), every call fails at the API with a confusing auth error whose root cause (missing config) is not obvious.

**The change:** make `AnthropicProvider` mirror `DeepSeekProvider` — move the `ANTHROPIC_API_KEY` read **into the constructor** (lazy), **throw** on missing key (matching DeepSeek's message style), and **drop the `|| 'dummy-key'`** fallback. Then both keys are genuinely conditional-on-use and both fail fast, and `.env.example` can honestly mark **both** as "required only when using that provider's models." This is the same fail-fast-on-required-config principle as the `MODEL_IDENTIFIER` no-fallback decision.
- **Wrinkle to verify in the spec (not assume):** the test harnesses set a dummy `ANTHROPIC_API_KEY` at module top *because* of the current eager read. Under lazy+fail-fast construction, tests that route to the real Anthropic provider must still set a dummy key before construction — they already do, so it's compatible, but confirm no harness relies on the warn-and-dummy path. Tests that mock at the `setGlobalMock` boundary never construct the real provider, so they're unaffected.
- **`.env.example` follow-on:** once this ships, mark `ANTHROPIC_API_KEY` conditional (mirroring how `DEEPSEEK_API_KEY` is already documented). **Do NOT mark it optional before this change** — today the code reads it eagerly and the doc would misrepresent the actual behavior.
- **Category:** provider config-hygiene (pairs with `B1`). Deferred deliberately: it's orthogonal to the DeepSeek feature (which just passed its regression suite), so folding it in would mean re-touching an Anthropic path that's currently green. *Why it matters:* consistent, fail-fast provider config; removes a silent-dummy-key footgun; lets `.env.example` tell the truth about both keys.

---

## Decided — intentionally NOT changing (don't re-litigate)

### `/recap` includes prior recaps in its transcript — deliberate, leave as-is
`/recap` logs its own output as a bot response (`generation_metadata.kind = 'recap'`), so a later `/recap` in the same thread will include earlier recaps in the messages it summarizes. This was considered and **kept on purpose** — do not add a filter to exclude prior recaps. Reasons:
- **You can't stop people from posting anyway.** Two users running `/recap` back-to-back, or any other "clutter," is inherent to an open group chat; recaps aren't special. Filtering them is solving a cosmetic problem the medium has regardless.
- **Different-N makes filtering lossy.** If an earlier `/recap 20` is in the thread and someone runs `/recap 50`, that second recap legitimately wants the earlier one in scope — a teammate's recap *is* part of what happened in the thread. Excluding it drops real conversational content.
- **Self-corrects under Phase 2.** Because `recapConversation` reads `coalesce(summary, message_text)`, once recaps carry a stored `summary` (Phase 2), a recap-of-a-recap feeds the *compact* version automatically — the token-bloat worry largely resolves for free, without any filtering code.
- **Cost:** a `kind = 'recap'` exclusion is one WHERE clause, but it adds branching, makes the feature slightly worse (lossy, above), and buys little. Net negative.

If real usage ever shows recaps-of-recaps are genuinely problematic, the one-line lever exists (`and (generation_metadata->>'kind' is distinct from 'recap')` in `recapConversation`'s query) — but the default is to leave it.

---

## Done

- **`/recap [N]` command — shipped & runtime-verified.** Summarizes the last N messages **in the current topic/thread** (default 20, clamp to max 100, invalid/missing → default with a gentle note). Same 👀-reaction → typing → `waitUntil`-async → reply pattern as `/ask`. `recapConversation` (in `lib/capabilities.ts`) reads `coalesce(summary, message_text)` with the `telegram_thread_id is not distinct from` thread filter (matches `buildContext` exactly), `desc + limit` then reversed to chronological, friendly empty-thread message (no model call). Dispatched **after** the untracked-group bail + excluded-thread gate (a recap of an unregistered/excluded thread is meaningless). The recap logs itself via `logBotResponse` (`kind: 'recap'`). Added to `lib/commands.ts` (source of truth) + `/help` + DEPLOYMENT B7/B8. Spec: `docs/specs/SPEC-recap-command.md`. *Reviewed adversarially + tested live.*
- **Chat-history Phase 1 — store bot responses + provenance columns — shipped & verified.** Migration `20260625000000_message_log_bot_responses.sql` adds `is_bot_response` (bool, default false), `summary` (nullable text), `generation_metadata` (jsonb) to `message_log`, plus a partial index on bot responses. `logBotResponse` logs the bot's `/ask`/`@mention` answers (stores the un-sanitized `answerText`, bot username in `username`, `telegram_user_id` null, metadata `{model, thread_id}`); non-fatal try/catch; only after a successful send. Verified live: `is_bot_response` true for bot rows / false for user msgs, `summary` null, metadata populated. Spec: `docs/specs/SPEC-message-history-storage.md`. **Phases 2 (inline summary for long answers) + 3 (summary-based retrieval) remain deferred — measure first** (the columns sit ready, free). See the near-term entry below.
- **Excluded-thread gate — shipped.** A single positional gate in the webhook handler (section 5d, after `/whoami` + the untracked bail, before logging + all command dispatch): if the thread is in `entity.excluded_thread_ids`, the bot does NOT log and does NOT dispatch any command; it declines once ("⛔️ I'm not configured to operate in this topic") **only when addressed** (`isCommand || isBotMention`), and stays silent on plain chatter. One gate covers every current and future command — no per-command exclusion check to maintain. `/whoami` runs above the gate (works everywhere, for diagnostics) and now reports `Topic status: excluded/active`.
- **`/context` command — shipped & runtime-verified.** Read-only context viewer: inline status summary (Entity/Group/Topic — `✓ N document(s)` / `none set` / `not enabled`) + full content as an attached `context.md` file (sidesteps the ~4096-char limit). `getContextManifest` mirrors `buildContext`'s resolution so it can't drift from `/ask`; `sendDocument` multipart helper added. Spec: `docs/specs/SPEC-context-command.md` (+ Addendum 1 for the status-based summary). Verified end-to-end (file downloads correctly from Telegram).
- **`setMyCommands` — done.** Registered `/ask`, `/context`, `/help` in the bot command menu; now a documented step (DEPLOYMENT B7). Re-run when the command set changes (e.g. adding `/whoami`).
- **B2 — null-thread (General topic) doc resolution — fixed.** Both `getContextManifest` and `buildContext` now use `(m.telegram_thread_id is null or m.telegram_thread_id is not distinct from ${threadIdStr})` — null-safe, makes #general resolve to entity-general docs only (no reliance on `= null`), and keeps the two functions in sync. (Was: `= ${threadIdStr}`, correct only by SQL null-comparison accident.)
- Database security model (RLS + Vault + bootstrap functions + least-privilege role). See `SECURITY-PROPOSAL.md` (resolved).
- `.env.example` corrected to connect as `bot_service` (not superuser); unused `SUPABASE_SERVICE_ROLE_KEY` removed.
- **B0 — Table-privilege GRANTs for `bot_service` (resolved).** The migration `20260618000000_init_schema.sql` now grants `usage`/`select`/`insert`/`update`/`delete` on all tables, sequence usage, and `alter default privileges` for future tables to `bot_service` — appended after the `grant execute` lines in section 5. Verified: grants are at the end of the migration (after all `create table`), so they correctly cover all eight tables. A fresh `supabase db push` now produces a working role in one step. (Was: migration granted only `execute` on functions, so `bot_service` had no base table access and the app would fail with permission errors despite correct RLS.)

---
