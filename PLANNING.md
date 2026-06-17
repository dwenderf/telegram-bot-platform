# Telegram Bot Platform — Planning & Build Specification

> **Status:** v1 planning · founding document
> **License:** AGPL-3.0
> **Audience:** the engineer (or coding agent) building v1, plus future maintainers.
> This document is both the **architecture of record** (the *why* behind each decision) and a **build spec** (the *what* to build). It is deliberately opinionated: the architectural forks are already resolved so the build can proceed without re-litigating them. Where something is intentionally deferred, it is called out explicitly so the seam is left clean rather than the decision made by accident.

---

## 1. Overview & Scope

### 1.1 What this is

A **multi-tenant platform for AI assistants embedded in Telegram groups**, where each assistant answers questions grounded in a team's own documentation. Documents live in GitHub as the canonical, version-controlled source of truth; the platform caches them in Postgres for fast retrieval and serves context scoped to the topic where a question is asked. One deployment serves many independent tenants, each with its own document repository and Telegram group(s).

This is a ground-up rebuild of a working proof-of-concept. The POC was assembled in n8n (visual workflow automation) and is fully documented in `N8N-WORKFLOW.md` and `INFRASTRUCTURE.md` (in the separate `theaeta` / `theaeta-ai-bots` repos). **That POC is the behavioral spec**: every command behavior, every Telegram/Supabase/GitHub gotcha, and the prompt structure are proven there. This rebuild exists because n8n is the wrong abstraction for something we want to run as *many* configurable instances and potentially offer as a product — it forces per-instance config to live as visual structure, makes a change require manual re-application across every cloned workflow, and cannot be shipped as a configurable product. Code fixes all three.

### 1.2 v1 scope (build this)

- **One command + its equivalent:** `/ask <question>` and `@mention` of the bot (treated identically). Plus `/help` (static text).
- **Per-topic context loading:** a general (entity-level) context document always loads, plus an optional per-topic document layered on top.
- **Multi-tenant from day one:** one deployment serves multiple entities; all data is tenant-scoped and isolated.
- **GitHub→cache sync:** when an entity's docs change (PR merged to main), the Postgres cache refreshes automatically.
- **Telegram-sourced identity & permissions:** group membership = access; Telegram admin/member distinction = role.
- **Acknowledgment UX:** the responsiveness signals proven in the POC (eyes reaction on receipt, thread-scoped typing during the model call).
- **HTML-formatted answers** with the sanitization the POC requires.

### 1.3 Explicitly NOT in v1 (do not build; leave clean seams — see §9)

- Write-commands: `/draft`, `/update`, `/recap`, `/status`, `/docs`.
- `/setup` and topic auto-scaffolding (self-service onboarding).
- Any management UI or web app.
- Any public/REST API surface beyond the two webhooks (Telegram inbound, GitHub sync).
- Group-scoped context *resolution logic* (the schema supports it; v1 logic uses entity-general + per-topic only).
- Message-history-based features beyond the recent-conversation context already used by `/ask`.
- Multiple model providers (the provider is abstracted; v1 ships one implementation: Anthropic).

### 1.4 One-paragraph architecture

A **Next.js app on Vercel** (serverless) is the engine. It exposes two webhook endpoints: one receives Telegram updates, one receives GitHub push/merge events. **Supabase (Postgres)** holds all operational data — tenant config, identity, the topic→context manifest, a rebuildable cache of document content, and message logs. **GitHub** holds the canonical document content per tenant (one repo per entity). **A model-provider abstraction** (Anthropic implementation in v1) generates answers. The bot reads context fast from Postgres to answer; document edits flow only through Git (PR → merge → sync to cache). The whole system is multi-tenant: a single deployment serves many entities, every row and query scoped by `entity_id`, enforced at the database layer.

---

## 2. Architecture & Principles

These principles are load-bearing. When the spec is silent on a detail, resolve it in the direction these principles point.

### 2.1 Tenant isolation is a correctness-and-confidentiality requirement, not an optimization

A single service serves multiple entities (e.g. HYS, SymRes, Theäta). Entity A must **never** see Entity B's context, documents, config, or messages. Therefore:

- Every operational table carries `entity_id`.
- Every query filters by `entity_id`.
- **Supabase Row-Level Security (RLS) enforces tenant scoping at the database layer**, so an application-code bug that forgets a filter cannot leak across tenants. RLS is on by default for all tenant-scoped tables. (Note: this deliberately *reverses* the POC's "RLS disabled on the chat-log table" decision — that was acceptable for a single-tenant internal log; multi-tenancy is exactly the case where RLS earns its keep.)
- GitHub access is also tenant-scoped: **per-tenant GitHub credentials** (a GitHub App installation per entity, or a per-entity fine-grained PAT for v1), so the platform's access to Entity A's repo is scoped to Entity A.

### 2.2 Git is canonical for document content; the cache is rebuildable; there is a single write path

- **Document content lives in GitHub** (one repo per entity). It is the source of truth: version-controlled, diffable, PR-reviewable, and accessible outside Telegram (github.com, a future web app, etc.).
- **Postgres holds a cache** of that content for fast runtime reads (the bot fetches context on every mention; a Postgres read is far faster and more reliable than a GitHub API round-trip).
- **The only way content enters the cache is the sync-on-merge path:** edit → PR → human merges to `main` → GitHub webhook → cache upsert. The application never writes document content to Postgres from anywhere else. One write path means the cache can never diverge from Git in a way requiring reconciliation.
- **The cache is fully rebuildable from Git.** You could drop the content-cache table and repopulate it by replaying the repos, losing nothing. It is disposable infrastructure — never back it up, never fear corrupting it.

### 2.3 Operational state is canonical in Postgres

Distinct from the rebuildable content cache, some data is **genuinely canonical in Postgres** and is *not* derived from Git: tenant config, identity/membership, the topic→context manifest, and message logs. Keep these two kinds of data — *derived cache* vs *canonical operational* — conceptually separate even though they share a database. (Practically: never let a "rebuild the cache from Git" operation touch the manifest or config tables.)

### 2.4 Capabilities are front-end-agnostic; front-ends are thin

The core logic — answer a question, load context, resolve a user's role — lives in **service functions that know nothing about Telegram**. The Telegram webhook handler is *thin*: parse the update, call a capability function, format the reply. This is the single most important discipline for the product vision: it makes the future web app, public API, or additional chat platforms *new front-ends on the same engine* rather than rewrites. Draw the boundary correctly now (it costs nothing — you're writing the functions anyway) and the second interface is weeks of work, not a rebuild.

### 2.5 Identity is modeled as its own concept, sourced from Telegram in v1

Do not hard-wire "Telegram membership" as the definition of identity/permission. Model **user**, **membership**, and **role** as first-class entities. In v1 the *only provider* that populates them is Telegram (group membership → access; Telegram admin/member → role). But because identity exists as its own model, a future provider (email/OAuth login for the web app) maps to the same user model without rearchitecting. Permission checks read *your* role; today that role happens to be sourced from Telegram.

### 2.6 The model provider is abstracted

LLM calls go through an internal interface (e.g. `callModel(...)`), never directly to a vendor SDK at call sites. **v1 ships exactly one implementation: Anthropic (direct).** The abstraction exists so additional providers (OpenRouter for multi-provider routing/fallback, or other direct integrations) can be added later, selectable per-tenant by config, without touching call sites. We start Anthropic-direct deliberately: simplest, full feature access (e.g. prompt caching), one fewer dependency in the data path. The *seam* protects against lock-in; adopting other providers is a later, need-driven choice.

### 2.7 Entity owns content; groups are access points (multi-group, future-proofed)

An **entity** (e.g. HYS) owns the content — the repo, the docs, the manifest. One or more **Telegram groups** (e.g. HYS Board, HYS Founders, HYS External) are *access points* into that entity. A group belongs to exactly one entity; an entity has many groups. The repo/content/cache/manifest all key to `entity_id`, **not** to a group. This means multiple groups share one knowledge base with no document replication. The schema models this `entity (1)—(N) group` relationship now so adding groups later is inserting rows, not migrating. **v1 context-resolution logic uses only entity-general + per-topic layers**; the group layer is schema-supported but not exercised until a second group per entity exists (see §9).

### 2.8 Don't build ahead of need; leave clean seams

Every deferral in §1.3 and §9 follows this rule. Model relationships in the schema where retrofitting would be painful (cheap now, expensive later), but keep *logic* minimal. The schema is forward-looking; the behavior is exactly v1.

---

## 3. Data Model

> Postgres on Supabase. All tenant-scoped tables carry `entity_id` and have RLS enabled (§2.1). Timestamps are `timestamptz`. Use `bigint` for Telegram IDs (chat IDs are large and negative; user/message IDs are large). The DDL below is the intended shape — the implementer may adjust types/indexes/constraints as needed, but must preserve the relationships, the `entity_id` scoping, and the cache-vs-canonical separation.

### 3.1 Entities & access points

```sql
-- An entity is a tenant: owns a content repo, docs, manifest, config.
create table entities (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,           -- e.g. 'hys', 'symres', 'theaeta'
  display_name  text not null,                  -- e.g. 'Hudson Yards Studios'
  github_owner  text not null,                  -- e.g. 'dwenderf'
  github_repo   text not null,                  -- the entity's content repo
  github_branch text not null default 'main',
  context_root  text not null default 'context',-- path within repo holding context docs
  created_at    timestamptz not null default now()
);

-- A Telegram group is an access point into an entity. Many groups -> one entity.
create table groups (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entities(id) on delete cascade,
  telegram_chat_id bigint not null unique,       -- the supergroup chat id (negative)
  display_name    text,                          -- e.g. 'HYS Board'
  created_at      timestamptz not null default now()
);
create index on groups (entity_id);
```

### 3.2 Identity & permissions

```sql
-- A user, modeled independently of any provider. v1 populates via Telegram only.
create table users (
  id            uuid primary key default gen_random_uuid(),
  telegram_user_id bigint unique,                -- the only provider in v1
  username      text,                            -- telegram @username (may change/be null)
  display_name  text,
  created_at    timestamptz not null default now()
);

-- Membership join: a user has a role within a group. Sourced from Telegram in v1.
create table memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  group_id    uuid not null references groups(id) on delete cascade,
  entity_id   uuid not null references entities(id) on delete cascade, -- denormalized for RLS/scoping
  role        text not null default 'member',    -- 'member' | 'admin' (from Telegram)
  updated_at  timestamptz not null default now(),
  unique (user_id, group_id)
);
create index on memberships (entity_id);
create index on memberships (group_id);
```

> **v1 role sourcing:** roles derive from Telegram. The simplest correct approach is **on-demand**: when a privileged action is attempted, query Telegram (`getChatMember` / `getChatAdministrators`) for the user's status and treat `administrator`/`creator` as `admin`. Caching admin lists into `memberships` is a later optimization (it can go stale on promote/demote). In v1, since the only command is `/ask` (which any member may use), role enforcement is barely exercised — but model it now so write-commands later have the seam. The `memberships` table can be populated lazily (on first interaction) rather than pre-synced.

### 3.3 The manifest (topic → context routing)

```sql
-- Maps a topic (and, in future, a group) to which context document(s) apply.
-- Canonical operational data (NOT derived from Git).
create table manifest_entries (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references entities(id) on delete cascade,
  group_id           uuid references groups(id) on delete cascade,  -- NULL = applies to all groups in entity (v1 leaves NULL)
  telegram_thread_id bigint,                      -- NULL = entity-general (loaded for every topic)
  doc_path           text not null,               -- path within the repo, e.g. 'context/protocol-overview.md'
  created_at         timestamptz not null default now()
);
create index on manifest_entries (entity_id);
create index on manifest_entries (entity_id, telegram_thread_id);
```

> **v1 resolution logic (entity-general + topic only):** to build context for a question in thread T of entity E, load all `manifest_entries` where `entity_id = E` AND (`telegram_thread_id IS NULL` *(general)* OR `telegram_thread_id = T` *(this topic)*), ignoring `group_id` (treat NULL group as "all"). Concatenate the referenced docs' cached content, general first, then topic-specific. **The `group_id` column exists** so group-scoped resolution can be added later (§9) without a migration; v1 simply leaves it NULL and ignores it.

### 3.4 The content cache (rebuildable from Git)

```sql
-- Cached document content, keyed to entity. DERIVED from Git via sync-on-merge.
-- Fully rebuildable; the application never writes doc content here except via the sync path.
create table doc_cache (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entities(id) on delete cascade,
  doc_path    text not null,                      -- path within the repo
  content     text not null,                      -- decoded UTF-8 markdown
  git_sha     text,                               -- blob/commit sha for change detection
  synced_at   timestamptz not null default now(),
  unique (entity_id, doc_path)
);
create index on doc_cache (entity_id);
```

### 3.5 Message log (operational; recent-context source)

```sql
-- Logs incoming messages per group/topic. Operational, high-write, queried by recency.
-- This is the new-schema equivalent of the POC's telegram_chat_logs.
create table message_log (
  id                 bigserial primary key,
  entity_id          uuid not null references entities(id) on delete cascade,
  group_id           uuid not null references groups(id) on delete cascade,
  telegram_chat_id   bigint not null,
  telegram_thread_id bigint,                       -- NULL = General topic
  telegram_user_id   bigint,
  username           text,
  message_text       text,
  is_command         boolean not null default false,
  is_bot_mention     boolean not null default false,
  created_at         timestamptz not null default now()
);
create index on message_log (entity_id);
create index on message_log (group_id, telegram_thread_id, created_at desc);
```

> **Recent-context query** (replaces the POC's `recent_messages` RPC): given a group and thread, return the most recent N messages (default 30), newest-first, with `telegram_thread_id IS NOT DISTINCT FROM` the target thread (null-safe so the General topic matches). In code this is a parameterized query, not a stored function — but the null-safe thread match and the newest-first-then-reverse-to-chronological handling carry over from the POC exactly.

> **Bot replies are NOT logged in v1.** Only incoming user messages are logged (the bot's own answers don't re-enter context). If bot replies are ever persisted for conversational memory (§9), store a **tag-stripped/plain-text** version in a *separate* table — never the HTML — to avoid markup noise in re-ingested context. Format is a send-time concern only.

### 3.6 RLS

Enable RLS on `entities`, `groups`, `users`, `memberships`, `manifest_entries`, `doc_cache`, and `message_log`. The platform's service role connects with a key that scopes access; policies must ensure no cross-`entity_id` reads/writes are possible from application queries. (Implementer: design the policy model so the service performs all access in the context of a known `entity_id`, and cross-entity access is structurally impossible. The internal Telegram-webhook and sync flows resolve `entity_id` first, then operate only within it.)

---

## 4. Capabilities (core service functions)

> These are the **front-end-agnostic** engine. They take plain inputs and return plain outputs; they know nothing about Telegram or HTTP. The Telegram handler (§5) and any future front-end call these. Signatures are illustrative (TypeScript-ish); the implementer may refine, but must preserve the boundary (no Telegram/HTTP types leaking in).

```typescript
// Resolve which entity + group an incoming Telegram chat maps to.
resolveTenant(telegramChatId: bigint): Promise<{ entity: Entity; group: Group } | null>

// Resolve (and lazily upsert) the user + their role in this group. v1 sources role from Telegram.
resolveUser(entityId, groupId, telegramUser): Promise<{ user: User; role: 'member' | 'admin' }>

// Build the context block for a question: entity-general docs + this-topic docs (from manifest + doc_cache),
// plus recent conversation (from message_log). Returns assembled context, gracefully handling
// "no topic doc" and "no recent messages".
buildContext(entityId, groupId, threadId): Promise<{ contextDocs: string; recentConversation: string }>

// Generate an answer. Internally builds the system prompt (context + recent convo + HTML-format instructions),
// calls the model provider abstraction, returns the raw answer text.
answerQuestion(input: {
  entityId; groupId; threadId;
  question: string;          // stripped of the /ask prefix or @mention
}): Promise<{ answerText: string }>

// The model-provider seam. v1: Anthropic implementation only.
callModel(input: { systemPrompt: string; userMessage: string; model: string }): Promise<{ text: string }>

// Sanitize model output for Telegram HTML (escape bare & not part of an entity, etc.).
sanitizeForTelegramHtml(raw: string): string

// Log an incoming message (mirrors the Edge Function's insert).
logMessage(entityId, groupId, msg): Promise<void>
```

### 4.1 Prompt assembly (carry over from POC, exactly)

The system prompt is assembled as: a role/instruction preamble, an **OUTPUT FORMAT** section (Telegram-HTML rules — see §5.4), the **PROJECT CONTEXT** (concatenated cached docs: general then topic), and the **RECENT CONVERSATION** (chronological transcript). The user message is the question, stripped of the `/ask` (and optional `@botname`) prefix or the `@mention`. This is proven in `N8N-WORKFLOW.md` §3d — reuse its structure verbatim, adapting only the source of the pieces (Postgres cache instead of a GitHub fetch; Postgres query instead of the RPC).

### 4.2 Model selection

`callModel` takes a `model` string. v1 reads it from entity config (default to a current Anthropic Sonnet-tier model — right balance of quality/speed/cost for short, context-grounded answers, and it fires on every `/ask`). Keep the model id in config, not hard-coded, so it's tunable per-tenant and updatable without a code change.

---

## 5. Telegram Front-End

> **Thin.** This layer parses Telegram updates, calls §4 capabilities, and formats replies. All the hard-won Telegram behavior below is **required** and is documented in detail (with root causes) in `N8N-WORKFLOW.md` and `INFRASTRUCTURE.md` — those are the authoritative gotcha references; this section states them as requirements.

### 5.1 Inbound flow

A Telegram webhook delivers updates to a Vercel API route. For each message update:

1. **Auth:** verify the `x-telegram-bot-api-secret-token` header against the configured secret; reject otherwise (401). *(Carry over the POC's hard-won lesson: secret must be stored clean — no trailing newline.)*
2. **Resolve tenant** from `chat.id` (`resolveTenant`). If unknown chat, ignore.
3. **Log** the message (`logMessage`) unless its thread is in an excluded-topics config (e.g. #patent/#legal). *(Excluded-topics is per-entity config.)*
4. **Determine intent:** is it `/ask` (or `/ask@botname`), an `@mention` of the bot, `/help`, or other? Only `/ask`, `@mention`, and `/help` are handled in v1.
5. **Acknowledge + answer** (below).

> **Mention detection (POC gotcha):** detecting an `@mention` requires the bot's username; the check prepends `@` itself, so the configured bot username must be the **bare** username (no `@`). An empty/misconfigured bot username makes mentions silently fail while commands still work — the asymmetry is the diagnostic tell. Store the bot username per-entity (each entity has its own bot) and validate it's non-empty at startup.

### 5.2 Acknowledgment signals (responsiveness)

- **Eyes reaction on receipt:** immediately react to the incoming message with 👀 via Telegram `setMessageReaction` (generic HTTP call — no native n8n node here, but in code it's a direct Bot API call). Fires for every handled message. Uses `message_id` (the specific message), not the thread id.
- **Typing indicator before the model call:** send `sendChatAction` with `action: typing` **and `message_thread_id`** (forum groups require the thread id or typing shows at chat-root, invisible in the topic). Auto-expires (~5s) and is cleared when the bot sends its reply — no explicit stop needed.

### 5.3 The answer (the only real flow in v1)

For `/ask` and `@mention`: strip the prefix/mention → `answerQuestion(...)` → `sanitizeForTelegramHtml(...)` → send the reply.

**Send-reply requirements:**
- **Reply in-thread:** pass `message_thread_id`, using the equivalent of the POC's `|| undefined` guard so a null/General thread omits the field (passing a bad/null thread id triggers Telegram `Bad Request: message thread not found`).
- **Parse mode: HTML.**
- Chat id and thread id come from the incoming update.

### 5.4 HTML formatting (required; full rationale in `N8N-WORKFLOW.md` §3f–3g)

- The model is instructed (in the system prompt) to emit **only Telegram-supported HTML tags** (`b i u s code pre a`), to use `• ` lines for lists and `<b>` lines for headings, to avoid Markdown and unsupported tags (`<p> <ul> <li> <h1-6> <div>` etc.), and to escape literal `< > &`.
- **Why HTML, not Markdown:** MarkdownV2 requires escaping ~18 characters (a stray `.` or `(` 400-errors the whole send); legacy Markdown uses single-`*` bold while models write `**` (dialect mismatch). HTML needs only `< > &` escaped and uses unambiguous tags the model emits reliably once instructed.
- **Sanitizer (required safety net):** before sending, escape bare `&` not already part of a valid entity (`&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)` → `&amp;`). This catches the highest-probability HTML-send failure (e.g. "R&D"). Telegram's HTML is a *whitelist* — an unsupported tag 400-errors the send and the user gets nothing; the prompt's tag restrictions plus this sanitizer keep sends reliable. (Tag-stripping is deferred — add only if a real list-tag failure is observed.)
- **Static text (`/help`):** content we control; legacy Markdown is fine there (single-`*` bold), or HTML — implementer's choice, but keep `/help` simple and not model-generated.

### 5.5 `/help`

Static text listing what's available now (`/ask`, `@mention`) and what's coming. No model call. Replies in-thread. Update its text as capabilities ship.

### 5.6 Error handling

If any step fails (context build, model call, send), the user must get *some* honest signal rather than silence — at minimum, the eyes reaction should not be the only trace of a request that produced nothing. (The POC notes a 👀→❌ swap or a brief "something went wrong" reply as the pattern; v1 should at least send a short error reply in-thread on failure. Keep it simple.)

---

## 6. GitHub → Cache Sync

> The single write path for document content into the cache (§2.2).

- **A Vercel API route receives GitHub webhook events** (push / merge to the entity's default branch).
- On a relevant event: identify which entity the repo belongs to (map `repo` → `entity` via config/`entities`), determine **which files changed** (the webhook payload lists changed/added/removed files under the entity's `context_root`), and for each changed context doc, fetch its current content (GitHub API, base64 → decode UTF-8) and **upsert into `doc_cache`** (`entity_id`, `doc_path`, `content`, `git_sha`). Remove cache rows for deleted files.
- **Security:** verify the GitHub webhook signature (`X-Hub-Signature-256`) against the configured secret before processing.
- **Granularity:** sync only changed files (don't re-pull the whole repo each commit). The payload tells you what changed.
- **Rebuild path:** provide a way to fully rebuild an entity's cache from its repo (e.g. an internal admin function or script) — used on initial onboarding and as a recovery tool, consistent with "cache is rebuildable."

> **base64/UTF-8 note (POC gotcha):** GitHub returns file content base64-encoded; decode to UTF-8 properly so multibyte characters (e.g. "Theäta" with `ä`) survive. (In the POC, naive `atob` garbled this; use a correct UTF-8 decode.)

---

## 7. Model Provider Abstraction

- A single internal interface (`callModel`, §4) is the only place the codebase talks to an LLM vendor. **No vendor SDK calls at capability or handler call sites.**
- **v1 implementation: Anthropic (direct).** Use the Anthropic Messages API. System prompt in the system field; the question as the user message. Read the model id from entity config. (Reuse the proven shape from the POC: a current Sonnet-tier model, system prompt separate from the user message.)
- The interface is designed so a future **OpenRouter** implementation (or other direct providers) can be added and selected **per-tenant by config**, without changing call sites. Provider + model become config, not code.
- Rationale recap: start Anthropic-direct for simplicity, full feature access (e.g. prompt caching, relevant since the context doc re-sends every call), and one fewer dependency in the data path. The abstraction is the anti-lock-in insurance; adopting more providers is a later, need-driven choice (§9).

---

## 8. Configuration & Secrets

### 8.1 Per-entity config (in Postgres / `entities` + related, or a config table)

- GitHub: `github_owner`, `github_repo`, `github_branch`, `context_root`.
- Telegram: the entity's bot username (bare, no `@`), bot token (secret — see below), and the group chat ids (`groups`).
- Model: provider (v1: `anthropic`) + model id.
- Excluded topics (thread ids to skip logging/forwarding).

### 8.2 Secrets (Vercel env / secret store — never in the repo, never in plaintext tables)

- Telegram bot token(s) — **per entity** (each entity has its own bot). Store securely; reference by entity.
- Telegram webhook secret(s) (the `x-telegram-bot-api-secret-token` value) — per entity/bot.
- GitHub credentials — **per tenant** (GitHub App installation per entity, or per-entity fine-grained PAT for v1). Scoped so the platform can only touch that entity's repo.
- GitHub webhook signing secret.
- Anthropic API key.
- Supabase service-role key / connection string.

> **Multi-bot reality:** each entity runs its own Telegram bot (own token, own username, own webhook secret). The platform must route by incoming bot/token and resolve the entity. Design the Telegram webhook so it can serve multiple bots (e.g. distinct webhook paths per entity, or resolve entity from the chat id and look up that entity's bot credentials for outbound calls).

### 8.3 Secret hygiene (POC-learned)

- Webhook/secret values must be stored **clean** (no trailing newline) — a trailing newline silently breaks header comparison.
- Validate required secrets/config at startup (e.g. a non-empty bot username) and fail loudly, not silently. The POC's worst bug was an empty `BOT_USERNAME` that made mentions silently fail while commands worked.

---

## 9. Non-Goals & Future Hooks

Each item is intentionally out of v1. Where the schema already supports it, that's noted — the seam is left clean so the future addition is logic, not migration.

- **Write-commands (`/draft`, `/update`, `/recap`, `/status`, `/docs`).** `/draft`/`/update` produce doc changes **only via PR** (branch → commit → open PR → human merges → sync refreshes cache). Build the PR-creation logic as a **reusable capability function** (e.g. `proposeDocEdit(entity, path, content, author)`) so the future web app's "save" reuses it — same engine, different front-end. `/recap` needs no GitHub read (summarize recent conversation). `/status`/`/docs` are GitHub-list operations.
- **`/setup` and topic auto-scaffolding (v2).** Telegram emits `forum_topic_created` (name + thread id). A v1.5/`/setup` command (run in a topic, reads its own thread id — killing the manual numeric-ID pain) can scaffold a manifest entry + starter doc (via PR). v2 listens for `forum_topic_created` to do it automatically. Requires the manifest to be bot-writable (it already is — manifest is canonical in Postgres).
- **Group-scoped context resolution.** `manifest_entries.group_id` exists; v1 ignores it (entity-general + topic only). When a second group per entity appears (e.g. HYS Board vs HYS External needing different/segregated context), light up group-layer resolution (general → group → topic) and group-differentiated access. No migration needed.
- **Web app / management UI.** The product surface: view/edit docs, manage manifest/topics, onboard entities, abstract GitHub away from non-technical users. Sits on the same capability functions (especially `proposeDocEdit`) as a new front-end. The whole architecture is shaped to make this additive.
- **Public API.** A third front-end on the same engine for technical users/integrations. Front-end-agnostic capabilities make it additive.
- **Bot-reply / conversational memory.** If bot answers are persisted for the bot to "remember what it said," store **plain-text (tag-stripped)** in a separate table — never HTML (§3.5).
- **Additional model providers.** OpenRouter (multi-provider routing/fallback) or other direct integrations, behind the §7 seam, per-tenant config. v1 is Anthropic-only.
- **Role caching.** v1 checks Telegram roles on-demand. Caching admin lists into `memberships` (with a refresh strategy) is a later optimization.

---

## 10. Decisions Log / Open Questions

**Resolved decisions** (do not re-litigate without reason):
- **Build in code (not extend n8n).** Driven by replication cost, fleet-maintenance cost, and the product vision — n8n cannot be the core of a configurable/hostable product.
- **Vercel (Next.js) serverless** for the engine; **Supabase Postgres** for data; **GitHub** canonical for content; **Telegram** as v1 front-end.
- **Multi-tenant single deployment** (not per-entity isolated deployments). Easier onboarding, single maintenance surface; self-hosters who want isolation run their own instance (open-source enables that).
- **Git-canonical content + rebuildable Postgres cache + single write path (sync-on-merge).**
- **Entity owns content; groups are access points (1:N).** Repo/cache/manifest key to entity.
- **Identity modeled independently, Telegram-sourced in v1.** Member = access; admin/member = role; on-demand role check.
- **Model provider abstracted; Anthropic-only in v1.**
- **HTML replies** with the sanitizer; **AGPL-3.0** license.
- **v1 command scope:** `/ask` + `@mention` + `/help` only.

**Open questions / calls for the builder** (flagged, not yet decided — make a deliberate choice):
- **GitHub auth mechanism for v1:** per-entity fine-grained **PAT** (simplest, matches the POC) vs. a **GitHub App** installation per entity (cleaner scoping, better for the product, more setup). Recommendation: PAT for v1, GitHub App when onboarding becomes self-service.
- **Multi-bot webhook routing:** distinct webhook path per entity/bot, vs. a single endpoint that resolves entity from chat id and looks up the right bot credentials for outbound calls. Decide based on how Telegram webhook registration is managed per bot.
- **Sync granularity edge cases:** renames/moves of context files, and large multi-file merges — confirm the changed-files handling covers add/modify/remove/rename.
- **RLS policy model:** the precise policy expressions enforcing `entity_id` scoping for the service role — design so cross-entity access is structurally impossible.
- **CLA:** not needed now (sole author). **Trigger:** if outside contributions start arriving (and the business path is real), add a CLA (e.g. CLA Assistant) or an inbound=outbound + relicensing-grant clause in `CONTRIBUTING.md` *before merging* external PRs — this preserves the ability to relicense (AGPL→looser, or dual-license) later. No action until the first external PR appears.

---

## Appendix: Source references

- **`N8N-WORKFLOW.md`** (in `theaeta-ai-bots`) — the proven, node-by-node behavioral spec for the bot flow, with every Telegram/Supabase/GitHub gotcha and the exact prompt structure. **Primary translation source for §4–§6.**
- **`INFRASTRUCTURE.md`** (in `theaeta`) — the foundation (Telegram/BotFather, Supabase, Edge Function, webhook setup) and the Phase-4 troubleshooting table (webhook 401 saga, the empty-`BOT_USERNAME` mention bug, secret hygiene).
- The POC's Edge Function (`telegram-ingest`) and SQL migrations — already-coded references for the message-logging insert, the null-safe recent-messages query, and the base64/UTF-8 decode.
