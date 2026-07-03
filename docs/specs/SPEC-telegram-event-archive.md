# SPEC — Raw Telegram Event Archive (`telegram_events`)

> **Reads against:** `app/api/webhooks/platform/[botSlug]/route.ts` (ingest path), the init schema's
> RLS model (`20260618000000_init_schema.sql`), and `processed_updates` (the existing dedup ledger —
> this table is explicitly *not* that).
> **Rigor bar:** match prior migrations; RLS enabled + forced; assert the security posture in a test
> (the read-isolation is the crux, not an afterthought).
> **One-line scope:** an append-only, admin-read-only archive of every raw Telegram `Update` the
> platform receives, for forensic debugging and feature reconnaissance. Dumb full-payload log — no
> parsing, no attribution, no derivation on the hot path.

> **Sequencing:** build now. Self-contained: one new table + one line in the webhook ingest + a
> retention cron. Independent of the caching/model work.

---

## 0. Why (background)

The system currently has **no record of what Telegram actually sent** — only derived rows we chose to
write (`message_log`, `model_calls`) and a dedup ledger (`processed_updates`, which stores only
`update_id + entity_id + created_at` for idempotency and deliberately holds no payload). If an update
arrives and something fails before `message_log` is written, that event is gone with no forensic trail.

Two concrete motivations, **forensic-first**:

1. **Forensic debugging (primary).** When a message isn't logged or answered correctly, we can inspect
   (and potentially replay) the exact payload Telegram delivered.
2. **Feature reconnaissance (secondary, high-value).** Logging *all* update types — not just messages —
   lets us discover from real data what Telegram actually sends: join/leave events, forum-topic
   created/renamed/deleted, edits, etc. Future features (welcome message on join; prompt for topic
   context on topic creation; update/soft-delete our thread rows on topic rename/delete) can then be
   specced against **observed payloads** instead of guesses about the Telegram API shape.

**Backfill is explicitly NOT the primary motive** — this shapes retention (a longish but bounded window
is fine; we are not committing to keep raw data forever to reconstruct derived tables).

**This is not an event-sourcing rearchitecture.** `message_log` / `model_calls` remain
directly-written derived tables. This archive sits *alongside* them as an audit/forensic source the
live read path does **not** depend on. Truth split: this table = "what Telegram sent"; derived tables =
"what the system understood and did." Both legitimate, kept separate on purpose.

---

## 1. The table

```sql
create table if not exists public.telegram_events (
  id           bigserial     primary key,
  bot_slug     text          not null,            -- receiving bot, from the webhook route (NOT the payload)
  update_id    bigint,                             -- Telegram's per-bot update id, from payload; NOT unique
  update_type  text,                               -- discriminator, e.g. 'message' | 'edited_message' | 'chat_member' | ...
  payload      jsonb         not null,             -- the raw Update, verbatim
  created_at   timestamptz   not null default now()
);
```

Design notes on each non-obvious column:

- **No `entity_id`.** This is the sentence that keeps the table out of the attribution fork. Ingest does
  **not** resolve tenant. Tenant is *recoverable offline* from the payload's chat id
  (`payload -> ... -> chat -> id` joined to `groups.telegram_chat_id → entity`) if ever needed. Storing
  no derived `entity_id` keeps ingest dumb and keeps this table outside the per-entity RLS regime (§2).
- **`bot_slug`** comes from the **webhook route** (`[botSlug]`), not the payload — the raw `Update` does
  not name the bot that received it. This is the multi-bot disambiguator (§4). Slug, not `bot_id`:
  the route has the slug directly; resolving to a `bots.id` would require a lookup at ingest, which cuts
  against "keep ingest dumb." Resolve slug → id offline like everything else. Indexed.
- **`update_id` is NOT unique.** Telegram's `update_id` is a per-bot sequence, not a global event id.
  With multiple bots in a group (future), the same real-world event yields distinct rows with
  potentially colliding `update_id`s across bots. Two bots receiving the "same" message is **truth** for
  this table — log both. Dedup belongs to `processed_updates` (per-bot, keyed on its own `update_id`),
  not here. Indexed (non-unique) for correlation during debugging.
- **`update_type`** is the top-level discriminator key of the `Update` object (whichever of `message`,
  `edited_message`, `channel_post`, `my_chat_member`, `chat_member`, etc. is present). Extracted at
  ingest purely for queryability ("show me all `chat_member` updates") — this is the reconnaissance
  lever. Indexed.

**Extracted columns are for query convenience, not attribution.** `bot_slug`, `update_id`,
`update_type` are the only three derived fields; the full truth stays in `payload`. Do not add more
extracted columns — anything else is recoverable from `payload` offline.

### 1.1 Indexes

```sql
create index if not exists telegram_events_created_idx     on public.telegram_events (created_at);   -- retention scans (§3)
create index if not exists telegram_events_update_type_idx on public.telegram_events (update_type);  -- reconnaissance queries
create index if not exists telegram_events_update_id_idx   on public.telegram_events (update_id);     -- debugging correlation
create index if not exists telegram_events_bot_slug_idx    on public.telegram_events (bot_slug);      -- multi-bot disambiguation
```

---

## 2. RLS posture — the crux (deliberate exception to per-tenant isolation)

**This is the single most important part of the spec. State it as an intentional exception, not an
oversight.** Every other table in the schema is entity-scoped under `force row level security` keyed on
`app.current_entity_id`. This table has **no `entity_id`** and is written before/without entity
resolution, so it cannot live under that model. It is the **first deliberate exception** to the
"everything is entity-isolated" invariant the init schema guards.

Requirements:

- **RLS enabled and forced**, as with every table.
- **No tenant SELECT policy.** A tenant-scoped session (`bot_service` under `app.current_entity_id`)
  must **never** be able to read this table. It holds the raw firehose across *all* tenants; a tenant
  SELECT policy would leak tenant B's raw messages to tenant A's session — a cross-tenant PII breach of
  exactly the sensitive data we're logging.
- **Append is unrestricted from ingest.** `bot_service` gets `INSERT` only (no `SELECT`). The webhook
  writes; it never reads.
- **Reads are admin/service-role only**, out of band from the tenant bot path. Reading is a deliberate
  admin action, never part of request handling.

Concretely: `grant insert on public.telegram_events to bot_service;` — **no `select` grant to
`bot_service`.** RLS on with no permissive tenant policy. Admin/service-role access is via the elevated
connection used for migrations/ops, not the bot connection.

> Sensitivity rationale: this table is a **broader** PII surface than `message_log`. `message_log`
> captures only messages the bot engaged with; `telegram_events` captures **every message in every group
> the bot is in**, including messages never directed at the bot. Anyone who could read it sees the full
> raw firehose. Admin-only, no exceptions.

---

## 3. Retention (built, not just stated)

Append-only + full firehose = this becomes the highest-write, fastest-growing table in the system. A
retention policy must **exist and run**, not be aspirational. "Unbounded because we never built the
reaper" is the failure mode to avoid.

- **Mechanism: `pg_cron` scheduled job** running a **batched** delete by absolute age:
  `delete from public.telegram_events where id in (select id from public.telegram_events where created_at < now() - interval '<RETENTION>' limit 10000);`
- **Batched from the start** (limit ~10000/run). This is about smoothing vacuum/WAL load, not locking —
  deletes hit *old* rows while inserts append *new* ones (disjoint; MVCC; no insert/delete contention).
  A single unbounded delete of a large span causes an I/O + autovacuum spike; batching turns one spike
  into small ones autovacuum keeps pace with. Cheap insurance that ages well.
- **Idempotent / self-healing.** Deletion is by absolute cutoff, so a run that clears only its batch
  leaves the rest still-expired for the next run. No unbounded debt accrues as long as
  (runs/day × batch) ≥ (rows/day aging past the cutoff). That inequality is the honest trigger to raise
  frequency.
- **Cadence: daily to start.** Raise to hourly (or more) later only if the rate inequality demands it —
  unlikely at foreseeable volume. Do not build aggressive cadence now.
- **First-run catch-up is allowed to take multiple runs.** On initial enable (or after widening the
  window) there may be a large pre-existing backlog older than the cutoff. Let the daily batched cron
  grind it down over several days. **Do NOT write a one-time unbounded "catch-up" delete** — that
  reintroduces the exact I/O spike batching exists to prevent. The steady-state batched delete is the
  *only* delete path.
- **Retention window:** longish is fine (forensic, not backfill). Pick a concrete interval in the
  migration; it is easily tuned later.

**Scaling lever (noted, NOT built):** if this table ever gets genuinely large, switch retention to
**`created_at`-range partitioning** and `drop partition` for expiry — instant, bloat-free, no dead
tuples. Premature now; it's the escape hatch, named so the next person knows where to reach.

---

## 4. Async / write mechanism

- **Write synchronously with `await`** in the webhook ingest, before/at the ack. This is a
  contention-free single append; `await` is simple and strictly correct here.
- **Do NOT use a bare un-awaited promise / fire-and-forget.** On Vercel serverless, un-awaited work after
  the response is not guaranteed to run — the function can freeze/tear down immediately, silently
  dropping the insert. Silent gaps are the exact failure that defeats a forensic log. (If latency ever
  proves this synchronous append too costly — unlikely for one indexed insert — the correct tool is
  Vercel's post-response primitive, **verified by current name at build time**, not a bare promise. Not
  needed now.)
- **Best-effort, non-blocking-on-failure:** a failed archive write is caught, logged to Vercel, and does
  **not** block the ack or the rest of request handling. The log being 99.9% complete is far better than
  the ack path being coupled to it. Rationale (David): if Supabase is down the whole system is down
  anyway, so a non-blocking write buys nothing but gaps.
- **Capture ALL update types indiscriminately** — do not filter to messages. The full firehose is the
  point (reconnaissance, §0).

---

## 5. What this deliberately does NOT do

- **No `entity_id` / no tenant attribution at write time.** Recoverable offline from payload (§1).
- **No dedup.** Multiple bots → multiple legitimate rows. Dedup is `processed_updates`' job, not this
  table's (§1).
- **No event sourcing.** Derived tables are not projections of this log; the read path never depends on
  it (§0).
- **No parsing/normalization of the payload** beyond the three extracted index columns. Full truth stays
  in `payload`.
- **No tenant read access, ever.** Admin/service only (§2).
- **No partitioning** (noted as scale lever, §3).
- **None of the reconnaissance-enabled features** (welcome-on-join, topic-lifecycle handling). This table
  is the *instrument* that lets those be specced later against real data — it does not implement them.

---

## 6. Tests

Security posture is the crux, so it gets asserted, not assumed.

1. **Append works from bot context.** Under a tenant `bot_service` session, an `INSERT` into
   `telegram_events` succeeds.
2. **Tenant CANNOT read (the critical assertion).** Under a tenant `bot_service` session, a `SELECT`
   from `telegram_events` returns zero rows / is denied — proving no tenant can read the cross-tenant
   firehose. This is the test whose absence would let a PII leak ship.
3. **Cross-tenant isolation on read.** Even with rows present from multiple `bot_slug`s / tenants, a
   tenant session sees none of them.
4. **Extracted columns populate.** After ingesting a sample `Update`, assert `bot_slug` (from route),
   `update_id` (from payload), and `update_type` (top-level discriminator) are set correctly, and
   `payload` holds the verbatim object.
5. **Retention deletes only expired rows, batched.** Seed rows straddling the cutoff; run the retention
   statement; assert only `created_at < cutoff` rows are removed, at most `limit` per run, and rows
   newer than the cutoff are untouched.
6. **All update types captured.** A non-`message` update (e.g. a `chat_member` or forum-topic sample) is
   archived with the correct `update_type`, proving no message-only filter.

---

## 7. Carried to BACKLOG (surfaced here, not built here)

1. **`message_log` single-writer rule (correctness hazard for multi-bot-per-group).** Today one platform
   bot per group ⇒ one `message_log` row per message. When two bots share a group, **both** webhooks
   fire and — as code stands — both would write `message_log`, producing **duplicate rows for the same
   human message**. That corrupts `recentConversation` → doubled/nondeterministic history in the prompt
   (degrades answers; can re-break cache stability). Latent today, live the moment multi-bot-per-group
   ships. Requirement to record: *`message_log` must be written by exactly one bot per group, or
   deduplicated.* Note the contrast: `telegram_events` **wants** per-bot duplication (log what each bot
   received); `message_log` **must not** (the conversation happened once). Two tables, opposite dedup
   semantics, on purpose.
2. **"Which bot received this" as a general need.** `bot_slug` here starts addressing it; the broader
   multi-bot future will want receiving-bot attribution in more places.
3. **Reconnaissance → features.** Once real payloads are observed: welcome-on-join
   (`new_chat_members`/`chat_member`), topic-lifecycle handling (create → prompt for context; rename →
   update thread row; delete → soft-delete thread row). Spec each against observed data.

---

## 8. Handoff notes for Antigravity

- **New migration** (additive) creating `telegram_events` + indexes + RLS (enabled/forced, **no tenant
  SELECT policy**) + `grant insert` (NOT select) to `bot_service`. Match the migration house style
  (`create ... if not exists`, enable+force RLS, grants, indexes) from
  `20260702000000_model_calls_logging.sql` — but the policy is the *inverse* of that file: no permissive
  tenant policy at all.
- **One ingest edit** in `app/api/webhooks/platform/[botSlug]/route.ts`: `await` a single insert of
  `{ bot_slug (from route param), update_id, update_type, payload }` early in the handler, wrapped so a
  failure logs to Vercel and does not block the ack. Extract `update_type` as the present top-level key
  of the `Update`.
- **Retention:** `pg_cron` job with the **batched** delete (§3). Concrete `interval` and daily schedule
  in the migration. No unbounded catch-up delete.
- **Verify the Vercel post-response primitive by current name** *only if* you choose async over
  `await` — default is `await`.
- **Tests (§6)** must include the tenant-cannot-read assertion (test 2) — that is the security gate.
- **Scope discipline:** no `entity_id`, no dedup, no payload parsing beyond the three columns, no
  partitioning, no reconnaissance features. All explicitly out (§5) or backlog (§7).
