# SPEC — Manifest / Doc-Cache Normalization (precedes Phase 4)

> **Reads against (verified readers):** `lib/capabilities.ts` (`buildContext`, `getContextManifest`),
> `app/api/webhooks/platform/[botSlug]/route.ts` (`/context` handler + `buildContextDocument`),
> `app/api/webhooks/github/sync/route.ts` (the inactive GitHub sync route),
> `supabase/migrations/20260618000000_init_schema.sql` (`doc_cache`, `manifest_entries`).
> **Rigor bar:** match Phases 1–3. This is an all-schema refactor, so the review surface is
> **reference completeness** (every reader of dropped columns found + updated) and **backfill-before-drop
> ordering**, not security (no new RLS/definer functions).
> **One-line scope:** normalize the doc/manifest model — `manifest_entries` becomes a pure junction
> referencing `doc_cache(id)` and a new `threads` table; `doc_cache` gains a polymorphic `source`;
> the hierarchy becomes FK-structural (the Phase-4 CHECK is never needed).

> **Ordering decision:** this runs **before** Phase 4. Doing Phase 4 first would add a CHECK constraint
> this refactor immediately drops, and would force the delicate lockstep resolver change to be written
> twice (once against the old shape, once against the normalized shape). Normalizing first means the
> Phase 4 resolver change is written **once**, against the final schema. **The Phase 4 spec is HELD and
> needs light revision after this lands** (its CHECK-constraint migration is superseded here; its
> resolver queries target `doc_id`/`thread_id`). See §7.

---

## 0. Why (recap of the design, decided across 2026-06-30 discussion)

1. **`manifest_entries.doc_path` ↔ `doc_cache.doc_path` join has no referential integrity** — a
   string match on `(entity_id, doc_path)` with no FK. A manifest row can point at a nonexistent doc; a
   doc can be deleted while mapped. Fix: reference `doc_cache(id)` (the surrogate uuid PK).
2. **`telegram_thread_id` is a bare `bigint` referencing nothing** — the asymmetry that *causes* the
   Phase-4 cross-group collision (thread ids are only unique within a group, but nothing enforces a
   thread↔group relationship). Fix: a `threads` table; the manifest references `threads(id)`, which
   references `groups(id)` — making the hierarchy FK-structural.
3. **`doc_path` should become the source locator, not a join key.** Once off the manifest, `doc_path`'s
   old roles split cleanly: its *human-label* role → a dedicated **`display_name`** column; its
   *source-locator* role (with `git_sha`) → a polymorphic **`source jsonb`** + a typed **`source_type`**
   discriminator (the anchor a sync-source uses to reconcile on re-sync). Human-facing vs. machine-facing
   are kept as separate columns, not entangled. (See `docs/VISION.md` Surface 1.)
4. **The relationship is many-to-many** (a doc applies to many scopes; a scope has many docs) — so the
   junction table (`manifest_entries`) is *required*, not a wart. It stays; it just gets proper FKs.

**End state of `manifest_entries`:** a pure junction —
`(id, entity_id FK, group_id FK nullable, thread_id FK nullable, doc_id FK)` — every column a real
reference, no `doc_path`, no bare `telegram_thread_id`, no CHECK constraint.

---

## 1. `doc_cache` changes

> **Separation of concerns (decided):** `display_name` (human-facing) and `source` (machine-facing)
> are **distinct columns**, not entangled. `display_name` is the user-set/edited label that exists for
> *every* doc regardless of source and is what `/context` and the content-UI show. `source` is *purely*
> the sync locator/version whose shape is dictated by `source_type`. Putting the title inside `source`
> would (a) make a manual doc's `source` a degenerate `{title}` wrapper and (b) mix "what I call this"
> with "where it syncs from." Keep them apart.

**Add:**
- `display_name text not null` (**no default** — force the writer to supply a real name; an empty name
  is as bad as null). The human-facing title, uniform across all source types. What `/context` renders
  and the content-UI edits.
- `source_type text not null default 'manual'` with `check (source_type in ('manual'))` — the typed
  discriminator. Widen the CHECK (`'github'`, `'notion'`, …) only when each source is actually
  supported. **The DB enforces only the discriminator, NOT the JSONB shape per type** — per-type
  payload validation lives in each sync-source's code, never as a DB constraint.
- `source jsonb` (**nullable** — a manual doc may have no external source at all; null is cleaner than
  a degenerate blob). *Purely* the machine-facing locator+version, shape per `source_type`. Future
  `'github'`: `{"path": "...", "sha": "...", "branch": "..."}`. Future `'notion'`:
  `{"page_id": "...", "last_edited_time": "..."}`. Absorbs old `git_sha` (and future sync locators).

> **No `unique (entity_id, display_name)`.** Enforce at the DB only what integrity requires; a
> duplicate display name breaks nothing (identity is `id`, nothing joins on the name). Non-unique names
> are a legitimate case (two groups each with an "Onboarding" doc). Duplicate-name **warning** belongs
> at the **content-UI** level (soft "you already have a doc called that — continue?"), not a DB
> constraint that hard-fails a valid case. *(Filed as a content-UI behavior in `BACKLOG.md`.)*

**Migrate (backfill before drop) — the two old columns split cleanly by concern:**
- `display_name ← doc_path`: `update doc_cache set display_name = doc_path` (v1's `doc_path` held a
  descriptive label — the closest thing to a title — so it becomes the human name). *(Existing 3 rows
  are inconsistently named precisely because `doc_path` was doing double duty; `display_name` gives
  them a real, editable label going forward.)*
- `source ← git_sha`: null for v1 manual docs (no external source); if any row had a `git_sha`,
  `source = jsonb_build_object('git_sha', git_sha)` (defensive — v1 manual docs have null `git_sha`).
- `source_type` defaults to `'manual'` for all existing rows (correct — v1 is all direct-push).

**Drop (Migration 2 — manual, after the gate + all readers updated):**
- `doc_path` column (→ `display_name`).
- `git_sha` column (→ `source`).
- `unique (entity_id, doc_path)` constraint (goes away with `doc_path`; `id` PK is the identity now).
  **Check nothing else relies on this unique key** (the GitHub route's `on conflict (entity_id,
  doc_path)` did — but that route is deleted, §4).

> **`doc_cache.id`** already exists (`uuid primary key default gen_random_uuid()`), so it's ready to be
> the FK target — no PK change needed.

---

## 2. New `threads` table

```sql
create table public.threads (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references entities(id) on delete cascade,
  group_id           uuid not null references groups(id) on delete cascade,
  telegram_thread_id bigint not null,
  -- room for future metadata (name, created_at already below, archived, has_context…)
  created_at         timestamptz not null default now(),
  unique (group_id, telegram_thread_id)
);
```
- `group_id NOT NULL` — a thread *always* belongs to a group (this is the structural enforcement that
  replaces the Phase-4 CHECK).
- `entity_id` carried for RLS scoping consistency with the other runtime tables (and denormalized
  convenience); `unique (group_id, telegram_thread_id)` — a Telegram thread id is unique within its
  group.
- **RLS:** apply the same per-entity force-RLS + `bot_service` policy pattern as `groups`/`message_log`
  (this is a runtime table). Mirror the existing group policies exactly; no new definer functions.
- **Backfill:** populate from existing distinct `(entity_id, group_id, telegram_thread_id)` seen in
  `manifest_entries` (the rows that currently carry a non-null `telegram_thread_id`) **and** optionally
  from `message_log` distinct threads (so known topics get rows). At minimum, every
  `manifest_entries.telegram_thread_id` must have a matching `threads` row before the manifest FK is
  added. *(Note: the one existing manifest row with a non-null thread must first have its `group_id`
  populated — see §3 pre-step — so it can map to a thread row.)*

---

## 3. `manifest_entries` changes

**Pre-step (data fix — the one malformed row):** the single existing manifest row with a non-null
`telegram_thread_id` currently has `group_id = NULL` (the forbidden combo). It's a real topic doc
(intentionally set). Populate its `group_id` with the group that owns that thread (via `/whoami` →
chat id → `groups.id`) **before** the threads backfill, so it can map to a `threads` row.

**Add:**
- `doc_id uuid references doc_cache(id) on delete cascade` — backfill from the old join
  (`update manifest_entries m set doc_id = c.id from doc_cache c where c.entity_id = m.entity_id and
  c.doc_path = m.doc_path`), then set `not null`.
- `thread_id uuid references threads(id) on delete cascade` — nullable (null = entity/group layer).
  Backfill by joining the new `threads` table on `(group_id, telegram_thread_id)`.

**Drop (Migration 2 — manual, after the gate):**
- `doc_path` (replaced by `doc_id`).
- `telegram_thread_id` (replaced by `thread_id`).
- The Phase-4 `manifest_thread_requires_group` CHECK is **never added** — the hierarchy is now
  structural (a `thread_id` FK → `threads` row → non-null `group_id`). *(If Phase 4 were somehow
  applied first, drop the CHECK here.)*

**End state:** `(id, entity_id FK, group_id FK nullable, thread_id FK nullable, doc_id FK not null,
created_at)`.

> **Layer encoding after normalization:**
> - entity layer: `group_id NULL, thread_id NULL`
> - group layer:  `group_id G,    thread_id NULL`
> - topic layer:  `group_id G,    thread_id T` (and the thread row guarantees T belongs to G)
> The forbidden `(group NULL, thread non-null)` is now *structurally impossible*: `thread_id` points at
> a `threads` row that has a non-null `group_id`, and the manifest's own `group_id` should equal it.
> *(Optional integrity: a trigger or the resolver could assert `manifest.group_id = threads.group_id`;
> for v1 rely on the writer setting them consistently. Note for the content-UI: when it writes a topic
> row, set `group_id` = the thread's group.)*

---

## 4. GitHub sync route — DELETE (the build-break forcing function)

`app/api/webhooks/github/sync/route.ts` is **live-but-inactive**: it's a registered Next.js route
(compiles + deploys) but never does work in v1 (all entities have null `github_*`, so it hits its
"GitHub configuration incomplete" guard and bails). It **writes** `doc_cache (entity_id, doc_path,
content, git_sha)` with `on conflict (entity_id, doc_path)` and **deletes** by `doc_path` — so it
directly references three things this refactor drops. When the columns go, **this route stops
compiling** → build break.

**Decision: delete the route** (`app/api/webhooks/github/sync/route.ts`). Rationale:
- It's inactive; nothing is lost operationally.
- Git history preserves it as a reference.
- The **real** GitHub sync-source (BACKLOG P1, the GitHub-first reference connector) will be written
  **fresh against the new `source jsonb` schema** — refactoring inactive code against a schema it'll
  never exercise is premature (David's call: don't refactor, mark deprecated → cleanest form of that
  is delete).
- Consistent with deleting (not stubbing) the old `[entitySlug]` route in Phase 3.

**Keep `lib/github.ts`** — it's a pure GitHub API wrapper (fetch file, compare commits); it has **no
DB references** (no `doc_cache`/`doc_path`/`git_sha`), so it's untouched by the refactor and is exactly
the reusable piece the future real connector will build on.

**Do NOT touch** `entities.github_*` columns or `resolve_entity_id_by_repo` — they're not part of this
refactor (only `doc_cache`/`manifest_entries`/threads are). They stay, dormant, for the future connector.
The deleted route's *other* references (to those) simply go away with it; nothing is stranded.

---

## 5. Code changes (the readers, all verified present)

### 5.1 `lib/capabilities.ts` — `buildContext(entityId, groupId, threadId)`
- Doc query: join `doc_cache` on `m.doc_id = c.id` (not `doc_path`); select `c.display_name` (the
  human label) + `c.content`, and `m.group_id`, `m.thread_id` for layering.
- This is *also* where Phase 4's three-layer WHERE lands — but since we're normalizing first, write the
  query once against `doc_id`/`thread_id`/`group_id`. (Phase 4's group-layer logic can be folded in
  now OR kept as the follow-up; see §7 — recommend keeping the *group-scoping resolution* as Phase 4 so
  this spec stays "pure normalization," but the **join change is unavoidable here**.)

### 5.2 `lib/capabilities.ts` — `getContextManifest(...)`
- Same join change (`doc_id` → `doc_cache`).
- Return docs with `display_name` + `content` instead of `doc_path` + `content` (the caller renders
  `display_name` — see 5.3).
- Keep it lockstep-identical to `buildContext`'s doc resolution.

### 5.3 `app/api/webhooks/platform/[botSlug]/route.ts` — the `/context` handler
- `getContextManifest(...)` call + destructure updated to the new return shape.
- **`buildContextDocument(...)` renders `d.doc_path` as the section header (`### ${d.doc_path}`)** —
  change to render **`d.display_name`**. This is the one *display* coupling the grep surfaced:
  `doc_path` was doubling as the human-facing doc name in `/context`; that name now comes from the
  dedicated `display_name` column (cleaner than the old path-as-title).
- (The `/context` group-layer is already half-stubbed — `"— not enabled in this version"` — that
  stub's replacement is Phase 4 work, not this spec.)

### 5.4 DELETE `app/api/webhooks/github/sync/route.ts` (§4).

---

## 6. Migration files (SPLIT: additive first, manual drop second)

> **Two migrations, mirroring the Phase 3 / 3.1 discipline.** All adds + backfills go in a normal
> additive migration (fully reversible). All **drops** go in a **separate manual migration**
> (`supabase/manual/`) run **only after** the additive migration is applied *and* the backfills are
> verified *and* the new code is deployed. This makes it structurally impossible to drop a column before
> its backfill + readers are confirmed. Rationale for the split (vs. one migration): there are *multiple*
> backfills feeding *multiple* drops — more places for an ordering mistake — and the drops are the only
> irreversible part. **No DB backup** is taken (accepted: worst case is a brief user-facing "temporarily
> unavailable" notice; data is mirrored into the new columns before anything is dropped anyway).

### Migration 1 — additive (`supabase/migrations/<ts>_manifest_normalization_additive.sql`, reversible)
Run order **within** it:
1. `doc_cache`: add `display_name` (nullable first), `source_type` (+CHECK), `source`; backfill
   `display_name ← doc_path`, `source ← git_sha`/null, `source_type='manual'`; then `alter ... set
   display_name NOT NULL` (after backfill, so it's satisfiable).
2. `threads`: create table + RLS policies (mirror `groups`).
3. **Pre-fix** the one malformed manifest row (set its `group_id`) — data fix, additive.
4. `threads`: backfill from manifest (+ optionally message_log) distinct threads.
5. `manifest_entries`: add `doc_id` (backfill from old join, then `set not null`); add `thread_id`
   (backfill by joining `threads` on `(group_id, telegram_thread_id)`).

After Migration 1: **both shapes coexist** — old columns (`doc_path`, `git_sha`,
`telegram_thread_id`) still present and still populated, new columns/table populated alongside. The
system still runs on the old shape until the new code deploys. Fully reversible to here.

### Between the migrations (the gate)
- Deploy the new code (§5: resolvers join on `doc_id`, render `display_name`; GitHub route deleted).
- **Verify** the new shape works: `/context` renders, `@mention` answers, row-count checks
  (`doc_id`/`thread_id`/`display_name` populated where expected; zero orphans).
- Only when green, proceed to Migration 2.

### Migration 2 — manual drop (`supabase/manual/manifest_normalization_drop.sql`, irreversible)
Run by the operator after the gate. Drops the now-unused old columns:
- `manifest_entries`: drop `doc_path`, drop `telegram_thread_id`.
- `doc_cache`: drop `doc_path`, drop `git_sha`, drop `unique (entity_id, doc_path)`.
- The Phase-4 `manifest_thread_requires_group` CHECK is **never added** (hierarchy is FK-structural).
  *(If Phase 4 were somehow applied first, drop that CHECK here too.)*

> **Why `supabase/manual/` (not a normal migration):** same reason as Phase 3.1 — `db push` must not
> be able to run the irreversible drops automatically before the additive migration + code deploy +
> verification gate have happened. The operator runs Migration 2 by hand, once, after confirming green.

> **Pre-checks to run first (read-only, before Migration 1):**
> - `select id, group_id, telegram_thread_id, doc_path from manifest_entries;` (confirm the 3 rows;
>   identify the malformed one).
> - `select id, doc_path, git_sha from doc_cache;` (confirm shape before backfill; `doc_path` →
>   `display_name`, `git_sha` → `source`).
> - Confirm every `manifest_entries.doc_path` has a matching `doc_cache` row (else `doc_id` backfill
>   leaves a null → the `not null` set fails, surfacing an orphaned manifest row to fix first).
> - Confirm no `doc_cache` row has a null/empty `doc_path` (else `display_name NOT NULL` backfill
>   produces an empty name to fix first).

---

## 7. Interaction with the held Phase 4 spec

- **This spec does the schema + the join/label code change.** It does **not** implement group-scoped
  *resolution* (the three-layer union in `buildContext`/`getContextManifest`). That stays **Phase 4**.
- **After this lands, revise `SPEC-phase-4-group-scoped-context.md`:**
  - Remove its §2 CHECK-constraint migration (superseded — hierarchy is now FK-structural).
  - Its resolver changes now target `doc_id`/`thread_id`/`group_id` (this spec already moved the
    queries to that shape; Phase 4 adds the `group_id IS NULL OR group_id = G` layer logic).
  - Its test setup uses `threads` rows + `doc_id` refs instead of bare `doc_path`/`thread_id`.
  - The cross-group collision test (its test 3) is still THE test — arguably even cleaner now, since a
    topic doc is a `thread_id` FK that structurally carries its group.
- **Net:** normalization first → the lockstep resolver query is written once (here, the join/label
  shape) and extended once (Phase 4, the group layer), never rewritten.

---

## 8. Adversarial test cases (`scripts/test-manifest-normalization.ts`)

Set up an entity with docs + a group + a thread, exercising the new shape end-to-end.

**Schema / integrity**
1. `manifest_entries.doc_id` FK: inserting a manifest row with a `doc_id` not in `doc_cache` is
   rejected (FK violation). Valid `doc_id` inserts fine.
2. `manifest_entries.thread_id` FK: inserting with a `thread_id` not in `threads` is rejected. Null
   `thread_id` (entity/group layer) inserts fine.
3. `threads` requires a group: `group_id` is NOT NULL — insert without it rejected. `unique(group_id,
   telegram_thread_id)` — duplicate rejected.
4. `doc_cache.source_type` CHECK: `'manual'` inserts; an unsupported type (e.g. `'github'`) is rejected
   until the CHECK is widened. `source` accepts arbitrary JSONB or null (no shape enforcement).
   `display_name` NOT NULL: an insert omitting it is rejected. **No** uniqueness on
   `(entity_id, display_name)` — two docs with the same name under one entity insert fine (uniqueness is
   a UI-level warning, not a DB rule).
5. **Cascade integrity:** deleting a `doc_cache` row cascades/blocks its `manifest_entries` per the FK
   (`on delete cascade` → manifest rows removed). Deleting a `threads` row cascades to its manifest
   rows. (Assert the chosen behavior.)

**Backfill correctness (against a seeded old-shape fixture)**
6. After migration: every pre-existing `manifest_entries` row has a non-null `doc_id` resolving to the
   same doc its old `doc_path` named (content matches). No orphaned manifest rows.
7. The pre-existing topic manifest row (the malformed one, post group-fix) has a `thread_id` resolving
   to a `threads` row whose `group_id` matches. `doc_cache.display_name` equals the old `doc_path`.

**Resolver parity (no behavior change from normalization alone)**
8. `getContextManifest` / `buildContext` return the **same docs** (by content) for a given
   (entity, thread) as they did pre-normalization — normalization is behavior-preserving for
   resolution; only the *shape* of the query changed, not *which* docs resolve. (Group-scoping behavior
   change is Phase 4, not here.)
9. `/context` rendering: `buildContextDocument` outputs the doc **`display_name`** as the section
   header, not a `doc_path` — assert the rendered markdown contains the display name.

**Regression**
10. `answerQuestion` still grounds in the resolved docs (its `buildContext` call returns the same
    content). No change to the model path.

---

## 9. Handoff notes for Antigravity

- **This precedes Phase 4.** Do not implement group-scoped resolution here — only the schema
  normalization + the unavoidable join/label code change. Group-scoping is Phase 4 (revised after this).
- **Two migrations (Phase 3/3.1 discipline): additive first (reversible), manual drop second.** Deploy
  the new code and verify (the gate) *between* them. Run the read-only pre-checks before Migration 1.
  Never let `db push` run the drops — Migration 2 lives in `supabase/manual/`.
- **Fix the one malformed manifest row** (`group_id` null + `thread_id` non-null) in Migration 1
  before the threads backfill — it's a real topic doc; set its `group_id`.
- **Delete `app/api/webhooks/github/sync/route.ts`** (it references dropped columns → build break
  otherwise). **Keep `lib/github.ts`** (no DB refs). **Do not touch** `entities.github_*` or
  `resolve_entity_id_by_repo`.
- **The `/context` display label** now comes from `doc_cache.display_name` (a dedicated column), not
  `doc_path` — update `buildContextDocument` and the resolvers' return shape accordingly. This is the
  non-obvious reader the grep surfaced.
- **`display_name` is NOT NULL, no default** (backfilled from `doc_path`); **`source` is nullable** and
  machine-only; **no uniqueness** on `(entity_id, display_name)` — duplicate-name warning is UI-level.
- **`source_type` CHECK enforces only the discriminator**; never add DB constraints on the `source`
  JSONB shape — that's each sync-source's job.
- **RLS on `threads`** mirrors `groups`/`message_log` (force-RLS + `bot_service` policies); no new
  SECURITY DEFINER functions.
- After this lands, flag `SPEC-phase-4-group-scoped-context.md` for its §7 revision.

---

## Addendum A (2026-07-13): Migration 2 formalized into tracked history

Migration 2 (§6) was run manually shortly after this spec shipped, but only as
`supabase/manual/manifest_normalization_drop.sql` — never captured as a dated file under
`supabase/migrations/`, so the tracked migration history didn't reflect the live schema. It has
now been moved (content unchanged) to `supabase/migrations/20260713000000_manifest_normalization_drop.sql`
and should be re-applied via `npx supabase db push` so the CLI's migration ledger records it as
applied. All drops in that file use `if exists` guards, so re-running it against the
already-migrated schema is a safe no-op — this is a documentation fix, not a schema change.

`doc_cache` and `manifest_entries` are therefore already in their fully normalized end state
(§1/§3) as of this addendum: no `doc_path`, no `git_sha`, no `manifest_entries.telegram_thread_id`.
