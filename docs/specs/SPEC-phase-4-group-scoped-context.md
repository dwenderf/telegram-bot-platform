# SPEC — Phase 4: Group-Scoped Context Resolution

> **Reads against:** `lib/capabilities.ts` (`buildContext`, `getContextManifest`), the `/context`
> command handler, `supabase/migrations/20260618000000_init_schema.sql` (`manifest_entries`),
> `PLANNING.md` §9 (the three-layer hierarchy sketch), `docs/specs/SPEC-context-command.md`.
> **Rigor bar:** match Phases 1–3. The two resolvers (`buildContext`, `getContextManifest`) MUST
> change in lockstep — they already carry a standing comment saying so. Tests assert the layered
> resolution AND the cross-group isolation that this phase fixes.
> **One-line scope:** light up the **group** layer of context resolution
> (`entity → group → topic`), which the schema already encodes (`manifest_entries.group_id`) but the
> runtime currently ignores — and in doing so, fix a latent cross-group topic-id collision.

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

## 2. Schema change (one tiny additive migration)

> This revises `PLANNING.md` §9's "no migration needed" — that's true for the *resolution logic*, but
> a CHECK constraint is needed to forbid the malformed layer and make the three-layer model provably
> clean. Additive, no data change.

**Pre-check (run first, expect 0):**
```sql
select count(*) from public.manifest_entries
where telegram_thread_id is not null and group_id is null;
```
If non-zero, those rows are the malformed combination and must be resolved (assign a group, or null
the thread) before the constraint can be added. (Expected 0 — v1 never populated `group_id`, and
entity-general rows have null `thread_id`.)

**Migration (`supabase/migrations/<ts>_manifest_group_topic_check.sql`):**
```sql
alter table public.manifest_entries
  add constraint manifest_thread_requires_group
  check (telegram_thread_id is null or group_id is not null);
```
- Additive, reversible (`drop constraint` if ever needed).
- No new RLS, no new function, no security surface — this phase adds none of the things Phase 3 did.

---

## 3. Code changes (the two resolvers, in lockstep)

### 3.1 `buildContext(entityId, groupId, threadId)` — `lib/capabilities.ts`
Signature **already has `groupId`** (currently used only for the message_log query). Change the **doc
query** to the three-layer union:

```sql
select m.group_id, m.telegram_thread_id, c.doc_path, c.content
from manifest_entries m
join doc_cache c on c.entity_id = m.entity_id and c.doc_path = m.doc_path
where m.entity_id = ${entityId}
  and (m.group_id is null or m.group_id = ${groupId})
  and (m.telegram_thread_id is null
       or m.telegram_thread_id is not distinct from ${threadIdStr})
```
- The message_log query is **unchanged** (already correctly group-scoped).
- **Sort** becomes three-tier (most-general first) for stable, sensible prompt ordering:
  entity (group null, thread null) → group (group set, thread null) → topic (group set, thread set).
  Update the existing two-way sort accordingly. (Ordering is cosmetic for an additive union, but keep
  it deterministic and general-to-specific so the prompt reads predictably and `/context` matches.)

### 3.2 `getContextManifest(entityId, threadId)` → add `groupId` — `lib/capabilities.ts`
This resolver currently **does not take `groupId`** and returns `{ entityDocs, topicDocs }`. Phase 4:
- **Change signature → `getContextManifest(entityId, groupId, threadId)`.**
- Apply the **same three-layer WHERE** as `buildContext` (they must match exactly — the standing
  comment in the code says so).
- **Extend the return shape** to three layers: `{ entityDocs, groupDocs, topicDocs }`, splitting rows
  by `(group_id, telegram_thread_id)`:
  - `entityDocs`  = `group_id IS NULL` (and thread null)
  - `groupDocs`   = `group_id = G AND thread_id IS NULL`
  - `topicDocs`   = `group_id = G AND thread_id = T`
- Remove the now-resolved "v1: group-layer not yet resolved" NOTE comment; replace with a comment
  asserting the lockstep invariant with `buildContext`.

### 3.3 The `/context` command handler — find and update its single caller
`getContextManifest`'s signature change is breaking, so its caller (the `/context` handler, likely in
the platform webhook route or a command module) **must** be updated to:
- Pass `groupId` (it already resolves the group for the message — thread it through).
- Render the **third layer**: the `/context` reply currently shows entity vs. topic; add **group**.
  Update the status summary (e.g. `Entity: ✓ N · Group: ✓ M · Topic: ✓ K / none`) and the assembled
  `context.md` so it reflects all three layers. See `SPEC-context-command.md` for the existing format;
  extend, don't restructure.

> **`answerQuestion` needs no change** — it just calls `buildContext`, whose signature is unchanged.

---

## 4. Files

- **[NEW]** `supabase/migrations/<ts>_manifest_group_topic_check.sql` — the CHECK constraint.
- **[MODIFY]** `lib/capabilities.ts` — `buildContext` doc query + sort; `getContextManifest` signature,
  query, return shape, comment.
- **[MODIFY]** the `/context` command handler (its caller) — pass `groupId`, render the group layer.
- **[MODIFY]** `docs/specs/SPEC-context-command.md` — note the third (group) layer (addendum).
- **[NEW]** `scripts/test-group-scoped-context.ts` — the layered resolution + isolation test suite.

---

## 5. Adversarial test cases (`scripts/test-group-scoped-context.ts`)

Same harness style; real roles; assert resolved doc sets by `doc_path`. Set up **one entity, two
groups (G1, G2)** so cross-group isolation is provable.

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

## 7. Handoff notes for Antigravity

- **Change BOTH resolvers in lockstep** — `buildContext` and `getContextManifest` must use the
  **identical** three-layer WHERE. The code already carries a comment demanding this; test 5 proves it.
- **`getContextManifest`'s signature change is breaking** — update its caller (the `/context` handler)
  in the same change, passing `groupId`, and render the new group layer in the reply.
- **Write test 3 (cross-group topic isolation) first** — it's the correctness gap this phase closes;
  use the **same thread id in two groups** in setup so the collision is actually exercised.
- **Pre-check before the migration** — confirm zero `(thread non-null, group null)` rows exist, then
  add the CHECK constraint (additive; in `supabase/migrations/`, not manual — it's safe and reversible).
- **Keep `doc_cache` untouched** — Phase 4 is manifest-resolution only.
- **Deterministic general-to-specific sort** in `buildContext` so the prompt and `/context` read
  predictably.
