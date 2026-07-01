# SPEC — Phase 4: Group-Scoped Context Resolution

> ✅ **SHIPPED (2026-07-01) — built, reviewed, deployed, live-verified.** This spec has been
> reconciled to match what was actually built. Two things differ from the original draft, both because
> the **manifest/doc-cache normalization** (`SPEC-manifest-doc-normalization.md`) landed *first* and
> changed the schema underneath this phase:
> - **No CHECK-constraint migration.** The original §2 added a `manifest_thread_requires_group` CHECK.
>   The normalization made the hierarchy **FK-structural** instead (`manifest_entries.thread_id` →
>   `threads` row → non-null `group_id`), so the forbidden `(group NULL, thread non-null)` combination
>   is structurally impossible — no CHECK needed. **Phase 4 shipped with zero migrations** (code-only).
> - **Resolvers query the normalized shape:** join `doc_cache` on `m.doc_id = c.id`, LEFT JOIN
>   `threads` to map `thread_id → telegram_thread_id`, select `c.display_name` (not `doc_path`). The
>   group-layer logic Phase 4 added is the `(m.group_id is null or m.group_id = ${groupId})` clause.
>
> The **design** (the three-layer additive union, the cross-group isolation fix) shipped exactly as
> specified below. Sections have been updated to the as-built mechanics; the layer model (§1) and
> scope boundaries (§6) are unchanged from the original design.

> **Built against:** `lib/capabilities.ts` (`buildContext`, `getContextManifest`), the `/context`
> handler in `app/api/webhooks/platform/[botSlug]/route.ts`, the normalized schema
> (`20260701000000_manifest_normalization_additive.sql`: `manifest_entries.doc_id`/`thread_id`/
> `group_id`, `threads`, `doc_cache.display_name`).
> **Rigor bar:** matched Phases 1–3. The two resolvers (`buildContext`, `getContextManifest`) are
> **byte-identical** in their doc query (verified in review) — they carry a lockstep-invariant comment.
> **One-line scope:** light up the **group** layer of context resolution (`entity → group → topic`),
> and thereby fix a latent cross-group topic-id collision.

---

## 0. Why this is more than an enhancement (the latent bug)

Today both resolvers filter manifest docs by **entity + thread only**, ignoring `group_id`:

```sql
where m.entity_id = ${entityId}
  and (m.telegram_thread_id is null
       or m.telegram_thread_id is not distinct from ${threadIdStr})
```

`telegram_thread_id` (a Telegram `message_thread_id`) is **only unique within a group** — Telegram
assigns thread ids per-group, starting low, so HYS-Board's topic `2` and HYS-Capital's topic `2` are
unrelated. The current entity-wide thread match means a manifest row scoped to "thread 2" would match
**every** group's topic 2. This is currently masked only because `group_id` has never been populated
(all manifest rows are entity-general, `thread_id` null). **The moment per-topic docs are used across
more than one group** — exactly what HYS's three groups (Internal / Capital / Board) will do — the
two-layer query cross-contaminates topics between groups.

So Phase 4 **closes a real correctness gap**, not just adds a feature: group-scoping is what makes
topic resolution correct in a multi-group entity. The CHECK constraint (§2) is what guarantees it.

**Driver (real, not hypothetical):** HYS now has three groups with materially different audiences —
**Board** (governance), **Capital** (fund-directed), **Internal** (operations). Board especially must
see different docs than the other two. This is the segregated-context-per-group use case the
`group_id` seam was left for.

---

## 1. The resolution model (decided)

Full hierarchy `entity (1)—<group (N)—<topic (N)`, resolved as an **additive union**, most-general to
most-specific. A manifest row's `(group_id, telegram_thread_id)` places it in a layer:

| `group_id` | `thread_id` | Layer | Loads for |
|---|---|---|---|
| NULL | NULL | **entity** | every group, every topic |
| `G` | NULL | **group** | group G, all its topics |
| `G` | `T` | **topic** | group G, topic T |
| NULL | `T` | **FORBIDDEN** | — (a thread id is meaningless without a group) |

A question in **(group G, topic T)** loads **entity + group(G) + topic(G,T)**, unioned.
A question in **#general** (null thread) loads **entity + group(G)** — the topic layer is simply empty
(falls out of the union naturally; no special-casing).
A group with no group-level docs but a populated topic still works — the group layer is just empty
(also natural). *(This is the case David raised: `(G, null)` empty, `(G, T)` populated → entity + topic
resolves fine.)*

**Merge semantics: additive/union** (load all matching docs across layers). **Override semantics**
(a more-specific doc replacing a more-general one) are explicitly **NOT** in this phase — they add
complexity for a need that hasn't appeared. Default additive; revisit only if a real override need
surfaces.

**The forbidden combination** `(group_id NULL, thread_id non-null)` is disallowed at the schema level
(§2), so the resolver never has to defend against it.

---

## 2. Schema change — NONE (as-built)

> **As shipped: Phase 4 required no migration at all.** The original draft added a
> `manifest_thread_requires_group` CHECK constraint to forbid the `(group NULL, thread non-null)`
> combination. But the manifest normalization (which landed first) made this **structural**: a
> `manifest_entries.thread_id` is an FK into `threads`, and every `threads` row has a **non-null**
> `group_id`. So a topic-scoped manifest row can only reference a thread that belongs to a group — the
> forbidden combination is impossible by FK structure, not by a CHECK. No constraint, no migration.
>
> The forbidden-combination *test* (originally §5 test 6) is likewise now a structural property; the
> shipped suite proves it via the FK behavior rather than a CHECK violation.

*(Original §2 specified a CHECK-constraint migration; superseded by the normalization's FK structure.
Retained here as a note for provenance.)*

---

## 3. Code changes (the two resolvers, in lockstep)

### 3.1 `buildContext(entityId, groupId, threadId)` — `lib/capabilities.ts`
Signature already has `groupId`. The doc query (as shipped) joins the normalized schema and adds the
group-layer clause:

```sql
select m.thread_id, m.group_id, c.display_name, c.content
from manifest_entries m
join doc_cache c on c.id = m.doc_id
left join threads t on t.id = m.thread_id
where m.entity_id = ${entityId}
  and (m.group_id is null or m.group_id = ${groupId}::uuid)
  and (m.thread_id is null or t.telegram_thread_id = ${threadIdStr}::bigint)
```
- **LEFT JOIN `threads`** is load-bearing: entity/group-general rows have `thread_id IS NULL` and won't
  match a `threads` row — an inner join would silently drop them. The `m.thread_id is null OR ...`
  structure tolerates the null side.
- The message_log (recent-conversation) query is **unchanged** — already correctly group+thread scoped.
- **Sort** is three-tier JS-side (most-general first): entity (`group_id null, thread_id null`) →
  group (`group_id set, thread_id null`) → topic (`thread_id set`). The comparator keys on `group_id`
  *and* `thread_id` (the two-tier version couldn't distinguish entity from group).

### 3.2 `getContextManifest(entityId, groupId, threadId)` — `lib/capabilities.ts`
Signature gained `groupId` (was `(entityId, threadId)` — a breaking change; its caller was updated).
- Uses the **byte-identical** doc query to `buildContext` (lockstep — verified in review).
- Returns three layers `{ entityDocs, groupDocs, topicDocs }`, split by `(group_id, thread_id)`:
  - `entityDocs` = `group_id === null && thread_id === null`
  - `groupDocs`  = `group_id !== null && thread_id === null`  ← *only `group_id` distinguishes this
    from `entityDocs`; both have null thread — the SELECT must fetch `m.group_id` to split them*
  - `topicDocs`  = `thread_id !== null`
- The stale "v1: group-layer not yet resolved" NOTE comment was replaced with a lockstep-invariant
  assertion.

### 3.3 The `/context` command handler — caller updated
In `app/api/webhooks/platform/[botSlug]/route.ts`:
- The `/context` caller passes `group.id` (the breaking signature change).
- `buildContextDocument` renders a third **`## Group context`** section; the status summary shows
  `Entity: ✓ N · Group: ✓ M · Topic: ✓ K` with real per-layer counts (the group line was previously a
  `— not enabled in this version` stub).

> **`answerQuestion` needed no change** — it calls `buildContext`, whose signature was unchanged.

---

## 4. Files (as-built)

- **[NONE]** No migration — Phase 4 shipped code-only (the FK structure from the normalization made the
  originally-planned CHECK constraint unnecessary; see §2).
- **[MODIFIED]** `lib/capabilities.ts` — `buildContext` doc query + three-tier sort; `getContextManifest`
  signature (`+groupId`), byte-identical query, three-layer return shape, lockstep comment.
- **[MODIFIED]** `app/api/webhooks/platform/[botSlug]/route.ts` — `/context` caller passes `group.id`;
  `buildContextDocument` renders the group layer.
- **[NEW]** `scripts/test-group-scoped-context.ts` — the layered-resolution + isolation test suite.

---

## 5. Adversarial test cases (`scripts/test-group-scoped-context.ts`) — as shipped

> The shipped suite maps to the setup below (identifiers illustrative). It uses the normalized schema
> (docs referenced by `doc_id`, topics via `threads` rows), and — critically — **registers the same
> thread id `5` in both G1 and G2** so the cross-group collision is actually exercised. All tests pass
> (verified in review).

Set up **one entity, two groups (G1, G2)** so cross-group isolation is provable.

**Setup:** entity E; groups G1, G2. doc_cache docs: `d_entity`, `d_g1`, `d_g2`, `d_g1_t5`, `d_g2_t5`
(note: same thread id `5` in both groups — the collision case). Manifest rows:
- `(E, null,  null)` → `d_entity`     (entity layer)
- `(E, G1,    null)` → `d_g1`         (group layer, G1)
- `(E, G2,    null)` → `d_g2`         (group layer, G2)
- `(E, G1,    5)`    → `d_g1_t5`      (topic layer, G1/T5)
- `(E, G2,    5)`    → `d_g2_t5`      (topic layer, G2/T5)

**Resolution correctness**
1. **Entity-only (G1, #general / null thread):** resolves `{d_entity, d_g1}` — entity + group, no
   topic. **Excludes** `d_g2`, `d_g1_t5`, `d_g2_t5`.
2. **Full stack (G1, topic 5):** resolves `{d_entity, d_g1, d_g1_t5}`. **Excludes** `d_g2`, `d_g2_t5`.
3. **Cross-group isolation (THE bug fix) (G2, topic 5):** resolves `{d_entity, d_g2, d_g2_t5}`.
   **Excludes `d_g1_t5`** — proves topic 5 in G2 does NOT pull G1's topic-5 doc (the collision the
   two-layer query had). This is the highest-value test.
4. **Group with empty group-layer but populated topic:** a group G3 with NO `(E, G3, null)` row but a
   `(E, G3, 7)` topic row → (G3, topic 7) resolves `{d_entity, d_g3_t7}` — entity + topic, group layer
   empty, no error. (David's case.)
5. **`buildContext` and `getContextManifest` agree:** for the same `(entity, group, thread)`, the doc
   set from `buildContext` equals the union of `getContextManifest`'s three layers. (Lockstep proof —
   the two must never drift.)

**Schema constraint**
6. **Forbidden combo rejected:** inserting a manifest row `(E, group_id => null, thread_id => 5)`
   raises a check-constraint violation (`manifest_thread_requires_group`). Valid combos
   (entity/group/topic) all insert fine.

**Regression (unchanged behavior holds)**
7. **#general still resolves entity+group only** (null thread → topic layer empty, no special-casing).
8. **message_log / recent-conversation unaffected:** `buildContext`'s conversation half is unchanged
   and still group+thread scoped (a quick assertion that it still returns the right thread's messages).

**Integration (optional, if harness supports it)**
9. End-to-end `/context` in (G1, topic 5) renders three layers (entity, group, topic) and the
   `context.md` contains `d_entity` + `d_g1` + `d_g1_t5` and not `d_g2*`.

---

## 6. What this phase deliberately does NOT do

- **No override semantics** — additive union only (§1).
- **No `group_id` on `doc_cache`** — content stays entity-scoped and shared (`unique(entity_id,
  doc_path)`); only its *manifest mapping* is layered. A doc can map to multiple layers/groups via
  multiple manifest rows on the same `doc_path`.
- **No content-management UI** — that's a separate, later piece (it will *write* these layered manifest
  rows; this phase makes them *resolve*, which is the prerequisite). See `BACKLOG.md`.
- **No new RLS / security-definer functions** — pure resolution + one CHECK constraint.
- **No change to `answerQuestion`, the model path, or `recapConversation`.**

---

## 7. Handoff notes (as-built record)

- **Both resolvers use the byte-identical three-layer doc query** — verified in review; they carry a
  lockstep-invariant comment. (Test 6 proves parity.)
- **`getContextManifest`'s signature change** (`+groupId`) was breaking; its `/context` caller was
  updated in the same change, and the group layer is rendered in the reply.
- **Test 3 (cross-group topic isolation)** uses the same thread id in two groups — the collision the
  phase fixes is actually exercised. Test 4 (pure group-layer isolation) proves the group layer
  independently of the topic layer.
- **No migration** — the FK structure from the normalization makes the forbidden combination
  structurally impossible (§2). `doc_cache` untouched.
- **Deterministic general-to-specific sort** in `buildContext` (entity → group → topic).
