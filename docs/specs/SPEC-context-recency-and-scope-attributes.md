# SPEC — Context Recency Ordering & Scope/Date Attributes

> **Reads against:** `lib/capabilities.ts` — `buildContext` (selects `m.thread_id, m.group_id,
> c.display_name, c.content`; orders by a layer `CASE` then `m.doc_id`; emits
> `<document path="${doc.display_name}">…</document>`), `getContextManifest` (same row selection,
> orders `by c.display_name` for display; carries the paired Lockstep Invariant comment),
> `answerQuestion` (assembles `basePersona + formatRulesFor(...) + WEB_SEARCH_GROUNDING +
> "PROJECT CONTEXT:" + contextDocs`), and `WEB_SEARCH_GROUNDING` (existing precedent for a
> persona-independent grounding block). Schema: `manifest_entries.created_at` (timestamptz not null
> default now(), **never updated** — `pushContext` re-push touches `doc_cache` only),
> `doc_cache.synced_at` (timestamptz not null default now(), **bumped on content change** by
> `pushContext`), `doc_cache.id` (`uuid default gen_random_uuid()` — **UUIDv4, random**).
>
> **Rigor bar:** the load-bearing claim in this spec is a **cache** claim, not a prompt claim, and it
> must be proven mechanically: inserting a new doc into a scope must leave the system-prompt bytes
> **before** the insertion point byte-identical. A test that merely asserts "docs come out in date
> order" does not prove this and is a hollow test. Assert on the **assembled `contextDocs` string**,
> not on row order. The second claim — that ordering is deterministic across identical calls — needs a
> tiebreaker test, because `created_at` collides under batch insert.
>
> **One-line scope:** within each existing entity → group → topic bucket, order context documents by
> `manifest_entries.created_at` (append-only) instead of random UUID, and emit `scope` + `updated`
> attributes on each `<document>` tag so the model can resolve conflicts by recency **within** a
> bucket and by specificity **across** buckets. Bucket order is unchanged. `/recap`, document QA,
> `/push`, `/context` untouched.
>
> **Sequencing:** (1) ordering change + append-stability test; (2) attribute emission; (3) grounding
> block + wiring; (4) lockstep comment repair. **No migration. No schema change. No destructive DDL.**
> Every column this spec needs already exists.

---

## 0. Why the current ordering is wrong

`buildContext` orders by:

```sql
order by
  case
    when m.group_id is null and m.thread_id is null then 0  -- entity
    when m.thread_id is null then 1                          -- group
    else 2                                                    -- topic
  end,
  m.doc_id
```

`doc_cache.id` is `gen_random_uuid()` — **UUIDv4, random**. The in-code rationale says this ordering
"guarantee[s] byte-stable prompts for caching." That is true for a **fixed set** of documents and is
optimizing the wrong invariant.

Prompt caching does not need byte-stability for a fixed set. It needs **prefix stability under
insertion**. Those are different properties, and random-UUID ordering has the first and lacks the
second:

- **Order by random UUID:** a new `/push` lands at a uniformly random position within its bucket. On
  average it sorts ahead of ~half the existing docs in that bucket, shifting every byte after it and
  invalidating the cache prefix from that point to the end of the system prompt.
- **Order by `created_at` ascending:** a new doc **always appends at the end of its bucket**. Every
  byte before it is untouched. The prefix survives up to the new doc.

`/push` makes topic scope insert-heavy by design, so this is not a theoretical cost. **Recency
ordering is strictly better for the cache than what is there now** — it is not a concession traded
against caching. Any implementation plan that frames it as such has misread this spec.

**Secondary consequence, not the motivation:** ordering also becomes meaningful rather than arbitrary.
But ordering alone conveys nothing to the model (§2) — the model does not infer "later in the prompt =
newer." The cache is the reason to change the `order by`. The attributes are the reason the model
behaves differently.

## 1. Ordering change (`lib/capabilities.ts`, `buildContext`)

```sql
order by
  case
    when m.group_id is null and m.thread_id is null then 0  -- entity
    when m.thread_id is null then 1                          -- group
    else 2                                                    -- topic
  end,
  m.created_at,
  m.doc_id
```

Three decisions, each load-bearing:

- **Bucket `CASE` is unchanged.** entity → group → topic stays. Recency operates *within* buckets only.
- **`m.created_at`, not `c.synced_at`.** `synced_at` is bumped on content change (`pushContext` sets
  `synced_at = now()` on re-push). Ordering by it would yank a re-pushed doc to the end of its bucket
  and reshuffle everything after it — **reintroducing exactly the cache thrash this change exists to
  remove**. `manifest_entries.created_at` records when the doc was linked into *this* scope, is
  `not null default now()`, and is never updated by any code path. Immutable per link. This is the
  distinction the spec turns on: **`created_at` is the right thing to sort by; `synced_at` is the
  right thing to display (§2).** Do not collapse them.
- **`m.doc_id` retained as tiebreaker.** `created_at` collides under batch insert (a GitHub sync
  inserting many manifest rows in one transaction gets near-identical or identical timestamps). Ties
  would order non-deterministically → cache thrash on every call. The UUID tiebreaker restores total
  determinism. It is now a tiebreaker, not the sort key.

**No `doc_cache.created_at` exists** (the normalization drop removed `doc_path`/`git_sha`; `created_at`
was never on the table). Do not add one. `manifest_entries.created_at` is the correct column and it is
already there.

**Expected no-op for existing tenants.** Manifest rows seeded in one batch share a `created_at`, so the
`doc_id` tiebreaker does all the work and their ordering is unchanged from today. This is correct and
expected: no regression, and new pushes now append. Do not "fix" it.

## 2. Attributes (`lib/capabilities.ts`, `buildContext`)

Today:

```ts
`<document path="${doc.display_name}">\n${doc.content}\n</document>`
```

The query already selects `m.thread_id` and `m.group_id` **and then never uses them**. The
entity/group/topic hierarchy — the core of the Phase 4 architecture — is currently **invisible to the
model**. It exists only as a sort order, which conveys nothing. Fix that and add the date:

```ts
`<document path="${d.display_name}" scope="${scope}" updated="${updated}">\n${d.content}\n</document>`
```

- **`scope`** — `"entity" | "group" | "topic"`, derived from the same predicate as the `CASE`:
  `group_id is null && thread_id is null` → `entity`; `thread_id is null` → `group`; else `topic`.
  **Plain bucket label only.** No topic name, no doc identity beyond the existing `path`. A qualified
  form (`scope="topic:vendor-negotiations"`) was considered and **rejected**: it leaks topic names into
  prompts for docs shared across scopes, and the model needs the bucket, not the label.
- **`updated`** — `c.synced_at`, formatted **`YYYY-MM-DD`**, absolute. Add `c.synced_at` to the SELECT
  list.
  - **Date granularity, not timestamp.** Minimises churn; the model has no use for seconds.
  - **Absolute, never relative.** A relative rendering ("3 days ago") rewrites nightly and torches the
    cache prefix for every tenant every day. This is a hard rule.
  - **Cache cost of the attribute is zero.** If a doc's `synced_at` moved, its `content` changed, so the
    prefix was already breaking at that doc. The attribute adds no new invalidation.

**Position and attribute will disagree, and that is correct.** A doc positioned earlier in a bucket may
carry a newer `updated` than one after it (re-push bumps `synced_at` but not `created_at`). Position is
a cache artifact with no semantics; the attribute is the semantics. Do not "fix" this by aligning them
— aligning them means ordering by `synced_at`, which is §1's rejected option.

## 3. Grounding block (`lib/capabilities.ts`, `answerQuestion`)

Add a block **beside** `WEB_SEARCH_GROUNDING`, following its established pattern exactly.

**It must be persona-independent.** `bot.persona` replaces `defaultPersona` wholesale, so this cannot
live inside `defaultPersona` or it silently vanishes for any tenant with a custom persona. Same
reasoning, same failure mode, and same fix as `WEB_SEARCH_GROUNDING` — this is precedent, not
invention.

```ts
const CONTEXT_GROUNDING = `CONTEXT DOCUMENT GUIDANCE:
- Each document is tagged with a scope (entity | group | topic) and the date its content was last updated.
- Scope is specificity: entity documents are organization-wide, group documents apply to this group, topic documents apply to this topic only. When documents at different scopes both apply, the narrower scope is the more specific instruction for this conversation.
- Within the same scope, when two documents conflict, prefer the one with the more recent updated date.
- If a broader-scope document is clearly newer and states a change that contradicts a narrower one, do not silently pick a side — answer with the most likely intent and briefly note the conflict.
- Do not infer recency from a document's position. Use the updated attribute.`;
```

System prompt becomes:

```
basePersona
formatRulesFor(provider.outputFormat)
CONTEXT_GROUNDING
WEB_SEARCH_GROUNDING
PROJECT CONTEXT:
<documents>
```

`CONTEXT_GROUNDING` is placed **before** `WEB_SEARCH_GROUNDING` so the doc-vs-doc rule reads before the
doc-vs-web rule, which already says *"If a context document conflicts with clearly newer information
from search, answer from the newer information and briefly note the discrepancy."* The two are
deliberately parallel: **this spec generalises that existing rule from doc-vs-web to doc-vs-doc, with a
scope qualifier.** Preserve the "briefly note the discrepancy" clause — it does double duty as the
cheapest available signal for the future cleanup/supersession feature (§5), surfaced by the product
instead of by a crawler.

**Known residual ambiguity — do not attempt to resolve it in code.** Narrower-scope-wins and
newer-wins genuinely conflict when a *broader* doc is *newer* and represents a policy change (a July
entity-wide policy vs. a January topic-specific exception). There is no rule that is correct in all
cases, because the data does not carry supersession intent — that is §5's problem, not this spec's. The
fourth bullet handles it by instructing the model to surface the conflict rather than silently
adjudicate. This is the intended behavior, not a gap to close.

## 4. Lockstep comment repair (`lib/capabilities.ts`, both functions)

`buildContext` and `getContextManifest` each carry:

> *Lockstep Invariant (Row Selection only): Must match … WHERE/joins exactly. Ordering differs:
> getContextManifest sorts alphabetically for display, while buildContext sorts by layer + doc_id to
> guarantee byte-stable prompts for caching.*

- **The invariant still holds.** Row selection (WHERE / joins) is unchanged. Adding `c.synced_at` to
  the SELECT list is not a row-selection change. `getContextManifest` keeps `order by c.display_name`.
- **The rationale sentence is now false** and must be rewritten in **both** comments: `buildContext`
  sorts by bucket + `created_at` + `doc_id` **so that new documents append rather than insert, keeping
  the cache prefix stable**. Leaving the stale rationale in place is a review finding, not a nit — it
  is the sentence that caused the original mis-optimization and it will cause it again.

## 5. What this deliberately does NOT do

- **No supersession.** This is conflict *resolution* (prefer newer within a bucket), not removal. Old
  docs stay in the prompt. Explicitly out of scope and deferred.
- **No `/forget`, no manifest management surface, no removal path of any kind.** Pushed context remains
  monotonically growing — `pushContext` creates on new source, updates in place on same
  `(origin_chat_id, origin_message_id)`, and nothing deletes. This is a real and acknowledged gap; it
  gets its own spec and touches the retention-policy work. **This spec does not mitigate it and must
  not be reviewed as though it does.**
- **No staleness detection / cleanup feature.** Deferred (see §3 note on the conflict-flag signal).
- **No change to `/context` output.** `getContextManifest` and `buildContextDocument` in the route keep
  their current display grouping and alphabetical ordering. Surfacing dates in the human-readable dump
  is a reasonable follow-on and is not this change.
- **No `doc_cache.created_at` column.** Not needed; `manifest_entries.created_at` is the correct
  column and already exists.
- **No migration.** Nothing in this spec requires DDL.
- **No change to `answerAboutDocument`, `recapConversation`, or `pushContext`.** `buildContext` is
  called by `answerQuestion` **only** — verify this before starting; it is the entire blast radius.
- **No `synced_at` write guard in `pushContext`, deliberately.** Its in-place update branch sets
  `synced_at = now()` unconditionally, so re-pushing byte-identical text advances the date without a
  content change. **Accepted, not overlooked.** The primary reason is ownership, not probability:
  `/push` is admin-gated (`administrator || creator`) precisely because the semantics of a push are
  delegated to the person making it — an admin re-pushing a document is responsible for knowing what
  they are pushing and what it means. Secondarily, the blast radius is small: worst case a gratuitously
  re-pushed doc shows a falsely-recent `updated` and beats a genuinely newer conflicting doc in the
  same bucket — a real wrong answer, but it requires an unchanged re-push AND a same-bucket conflict
  AND a question that hits it, and the cache cost is a single prefix break, once, not recurring churn.
  The guard is cheap (~4 lines of SQL) but the need is not here; it is in the **connector** writers,
  which have no admin in the loop and do not exist yet (§7). Building it now to serve a future caller
  is building ahead of need.
- **No content-level dedup.** Identical content arriving from a *different* source message — copy-paste,
  forward, or `/push group` after `/push topic` (different `thread_id` → no origin match → fresh LLM
  name → second doc) — produces genuine duplicates under distinct names. The origin-match key is
  `(origin_chat_id, origin_message_id)`, i.e. message identity, not content identity. Real gap;
  needs different guards entirely; belongs with supersession, not here.
- **No `bucket` reordering.** entity → group → topic is affirmed as correct and stays.
- **No rename of `synced_at`.** The column means "when this content last changed," which the name
  describes poorly — a reader (or the implementer of the next connector) will read "synced_at" as "when
  we last ran a sync" and write `now()` unconditionally. A rename to `content_updated_at` would be
  honest but costs an additive-then-drop migration pair for a naming improvement alone. Deferred
  deliberately; §7 carries the warning instead.

## 6. Tests

Ordering + cache stability (`scripts/test-context-ordering.ts`, or fold into
`test-group-scoped-context.ts`):

1. **Append-on-insert (the load-bearing test).** Seed a topic scope with N docs, call `buildContext`,
   capture `contextDocs`. Insert one new doc (fresh `manifest_entries.created_at`). Call again. Assert
   the **new string starts with the old string** (prefix-identical, byte-for-byte) and the new doc is
   appended. Assert on the assembled `contextDocs` string, **not** on row order — row order does not
   prove the cache claim.
2. **Regression proof of the old behavior.** Same fixture ordered by `doc_id`: demonstrate the prefix
   is **not** preserved on insert (or, if flaky by construction, assert the new ordering across a seeded
   set whose `doc_id` order differs from `created_at` order — the point is to prove the two orderings
   are actually different for this fixture, so the test isn't vacuously passing).
3. **Tiebreaker determinism.** Two manifest rows with **identical** `created_at` (explicit insert, not
   `now()` twice) → `buildContext` returns byte-identical `contextDocs` across repeated calls.
4. **Bucket order preserved.** Mixed entity/group/topic fixture where `created_at` ordering would
   invert buckets if the `CASE` were dropped → assert entity docs all precede group docs precede topic
   docs regardless of dates.

Attributes:

5. **Scope derivation.** Entity doc → `scope="entity"`; group doc → `scope="group"`; topic doc →
   `scope="topic"`. Assert against the emitted tag string.
6. **Date format.** `updated` matches `/^\d{4}-\d{2}-\d{2}$/`. Assert **no** time component and **no**
   relative phrasing anywhere in the tag.
7. **`updated` tracks `synced_at`, not `created_at`.** Seed a doc, capture the tag; update its
   `content` + `synced_at`; assert `updated` moved **and** the doc's position in the bucket did **not**.
   This pins the §1/§2 split in a single assertion.
8. **`path` unchanged.** `display_name` still emitted as `path` (no rename).

Grounding:

9. **Persona-independence.** `answerQuestion` with `defaultPersona` **and** with a custom
   `bot.persona` → system prompt contains the `CONTEXT DOCUMENT GUIDANCE` block in **both** cases.
   (Direct analogue of the existing `WEB_SEARCH_GROUNDING` test.)
10. **Block ordering + coexistence.** `CONTEXT_GROUNDING` appears before `WEB_SEARCH_GROUNDING`, both
    present, `formatRulesFor` output intact, `PROJECT CONTEXT:` still present.

Regression:

11. **Empty context.** No manifest rows → `contextDocs` still falls back to
    `'No documentation context available for this topic.'` (no stray tags, no crash on date formatting
    of an empty set).
12. **Lockstep row selection.** `getContextManifest` and `buildContext` still return the same doc set
    for the same `(entityId, groupId, threadId)`. Guards §4's claim that the invariant survives.

Clean up seeded rows in `finally`. No `DROP`. (AGENTS.md test safety rules.)

## 7. Handoff notes for Antigravity (pin these)

- **The `order by` change is a cache optimization, not a tradeoff against caching.** If the
  implementation plan describes recency ordering as costing cache stability, it has inverted the
  spec — see §0. Ordering by random UUID is the **worst** reasonable choice for insert-heavy scopes;
  `created_at` ascending is the best, because insertion appends instead of splicing.
- **`m.created_at` sorts. `c.synced_at` displays.** Two different columns doing two different jobs.
  Do not order by `synced_at` (re-push would reshuffle → thrash). Do not display `created_at` (it does
  not track content currency). This is the single most likely thing to get wrong.
- **`manifest_entries.created_at` is immutable** — `pushContext` re-push updates `doc_cache.content`,
  `.source`, `.synced_at` and never touches the manifest row. Verify in `pushContext` before relying
  on it; the whole append-stability property depends on it.
- **`synced_at` is prompt-visible after this spec.** It is written by exactly one path today —
  `pushContext`'s in-place update, which sets it unconditionally. That inaccuracy is **knowingly
  accepted** (§5); do **not** add a content guard as part of this work, and do not flag its absence as
  a defect in the walkthrough. It is recorded as a deliberate deferral.
- **The column name lies and will mislead the next writer.** `synced_at` means "when this content last
  changed," not "when we last ran a sync." Not renamed (§5); this note is the mitigation.
- **`doc_cache.id` is `gen_random_uuid()` (v4, random)** — confirmed in
  `20260618000000_init_schema.sql`. It is a tiebreaker now, not a sort key. Do not remove it; ties on
  `created_at` are real (batch insert) and untied ordering is non-deterministic.
- **`doc_cache` has no `created_at`.** Current columns: `id`, `entity_id`, `content`, `synced_at`,
  `display_name`, `source_type`, `source`. `doc_path` and `git_sha` were dropped in
  `20260713000000_manifest_normalization_drop.sql`. Do not add a column.
- **Absolute `YYYY-MM-DD` only.** Relative dates rewrite the prompt nightly and destroy every tenant's
  cache prefix daily. Non-negotiable.
- **Grounding block goes beside `formatRulesFor`/`WEB_SEARCH_GROUNDING`, never inside
  `defaultPersona`** — `bot.persona` replaces the default wholesale.
- **Blast radius: `buildContext` has exactly one caller, `answerQuestion`.** Confirm before starting.
  Do not touch `answerAboutDocument`, `recapConversation`, `pushContext`, or the route.
- **One-time cache invalidation on deploy is expected.** Adding attributes rewrites every system prompt
  once, across all tenants — a single cache-creation spike on first deploy, then steady state. Call it
  out in the walkthrough; it is not a regression and should not be "fixed."
- **Update the Lockstep Invariant comment in BOTH `buildContext` and `getContextManifest`** (§4). The
  invariant holds; its stated rationale does not. Leaving it stale is a review finding.
- **No migration; no `supabase db push`.** Nothing here needs DDL (AGENTS.md Rule 8 applies regardless).
- **Future-facing note (do not build):** when the GitHub connector returns, **its** writer is where the
  content guard is needed — bump `synced_at` only on actual content change, guarded at the write, not
  merely at the trigger. A push-to-main webhook narrows *which* docs are considered but does not make
  the guard optional: force-pushes, branch resets, rebases, and any backfill or re-sync all re-present
  unchanged content to the writer. A connector setting `synced_at = now()` per sync would churn the
  `updated` attribute daily across every seeded doc and reset every tenant's cache prefix once a day —
  which is the recurring, high-impact version of the inaccuracy §5 accepts for `/push`. Recorded here
  because this spec is what makes `synced_at` prompt-visible and therefore load-bearing.

---

*End of SPEC — Context Recency Ordering & Scope/Date Attributes*
