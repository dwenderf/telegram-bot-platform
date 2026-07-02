# Review Findings — Prompt-Cache Prefix Fix (post-implementation)

> **Reviews:** Antigravity's implementation of `SPEC-prompt-cache-prefix-fix.md`.
> **Method:** read the actual built code (`lib/config.ts`, `lib/capabilities.ts`,
> `scripts/test-prompt-cache-prefix.ts`) — not the walkthrough. Every finding below is from source.
> **Verdict:** the targeted bug (history in the cached prefix) is **fixed, cleanly**. Config hygiene is
> **well-executed**. There is **one latent correctness gap** the test suite structurally cannot catch,
> plus two minor notes. One item to fix before sign-off; the rest are notes/backlog.

---

## Verdict at a glance

| Area | Status |
|---|---|
| History moved out of `systemPrompt` into `userMessage` | ✅ correct |
| Persona softened (context docs **and** history; keeps "don't know → say so") | ✅ correct |
| `MODEL_IDENTIFIER` required, no fallback, fail-fast validator | ✅ correct |
| Robust parse for the two numerics (empty/NaN/≤0 → default) | ✅ correct |
| Global migration off `ANTHROPIC_MODEL` / literal model string | ✅ correct (guarded by test 8) |
| **Deterministic doc ordering in `buildContext`** | ❌ **gap — fix before sign-off** |
| `input.model` passthrough vs cache stability | ⚠️ accepted risk — comment only |
| Test 8 grep scope | ⚠️ minor — note the boundary |

---

## Finding 1 — BLOCKING: `buildContext` has no deterministic doc ordering

**The fix's entire value is a byte-stable system prompt. This gap can silently un-stabilize it under
real conditions, and no current test can see it.**

`buildContext`'s doc query selects from `manifest_entries join doc_cache` with **no `ORDER BY`**. The
subsequent JS `.sort()` orders by *layer* only (entity → group → topic) and returns `0` within a layer.
So the order of two docs **in the same layer** is whatever Postgres returns — which, without an
`ORDER BY`, is not guaranteed stable across calls (it can shift with plan changes, vacuum, page
layout). If two same-layer docs swap order between calls, the concatenated `contextDocs` bytes change,
`systemPrompt` changes, and caching misses again — reintroducing the exact bug this spec fixed, by a
different mechanism (nondeterministic row order instead of history).

**Why the tests don't catch it:** `test-prompt-cache-prefix.ts` seeds **exactly one doc**. Test 3's
byte-identical assertion therefore passes trivially on the ordering axis — there's nothing to reorder.
The regression guard covers the history axis (fixed) but is blind to the doc-ordering axis (the
remaining risk). This is a false-green: green on a fixture that can't exercise the failure.

**This is also a live lockstep violation.** Both `buildContext` and `getContextManifest` carry a
"Lockstep Invariant: Must match … query exactly" comment, but `getContextManifest` has
`order by c.display_name` and `buildContext` has no `ORDER BY`. They already disagree.

### Fix

Add a deterministic `ORDER BY` to `buildContext` that fully determines concatenation order:

1. **Layer first** (preserve the existing entity → group → topic semantics — broad context before
   specific is intentional), expressed in SQL so it's authoritative, e.g.:
   ```sql
   order by
     case
       when m.group_id is null and m.thread_id is null then 0   -- entity
       when m.thread_id is null then 1                           -- group
       else 2                                                    -- topic
     end,
     m.doc_id
   ```
2. **`doc_id` as the within-layer tiebreak** (David's call, and the right one): `doc_id` is more stable
   than `display_name` — a display name can be edited/renamed while the underlying doc is unchanged,
   whereas the FK id is stable for the life of the doc. Within a layer the choice is semantically
   arbitrary anyway, so the more stable key wins.

With ordering fully determined in SQL, the JS `.sort()` becomes redundant and can be dropped (removing
a second, separate ordering surface that could drift from the SQL). Antigravity's call whether to drop
it or keep it as a defensive mirror — but the **SQL `ORDER BY` is the required part**; a stable prefix
must not depend on V8 sort-stability + Postgres's incidental row order.

### Lockstep reconciliation (decide, then state it)

`buildContext` will now order by `layer, doc_id`; `getContextManifest` orders by `display_name`. These
serve different masters: `buildContext` needs a **cache-stable** order; `getContextManifest` feeds the
human-facing `/context` command, where **alphabetical (`display_name`)** is friendlier. Two options:

- **(Recommended, low-cost)** Keep `getContextManifest` on `display_name`; **rewrite the lockstep
  comment** on both to say the invariant is about **row selection** (identical `WHERE` + joins + the
  set of docs returned), **not ordering** — ordering is per-purpose. This is the honest description of
  what the invariant actually protects, and prevents a future "fix" that force-matches the orderings
  and makes `/context` less readable.
- **(Alternative)** Align both to `layer, doc_id` so `/context` displays docs in the exact order the
  model receives them (useful if a future "explain this answer" feature wants that). Costs `/context`
  its alphabetical readability. Only worth it if that debugging affordance is wanted now.

### Test to add (so this can't regress)

Strengthen test 3: seed **≥2 docs in the same layer** (and ideally docs across layers too), then assert
(a) two consecutive same-thread calls produce **byte-identical** `systemPrompt`, and (b) the doc
concatenation order matches the expected `layer, doc_id` order. (a) locks stability; (b) locks the
ordering contract so a later query change can't silently reorder.

---

## Finding 2 — ACCEPTED RISK (comment only): `input.model` passthrough

`answerQuestion` resolves `input.model || getModelIdentifier()`. Prompt caches are keyed **per model**,
so a caller passing a per-call `input.model` that varies within a thread would defeat caching
thread-wide even with a byte-identical prefix. No current caller sets `input.model`, so this is not a
live bug.

**Decision (David):** acceptable. We use one model consistently; if a future bot chooses to switch
models, handling its own cache misses is that bot's responsibility, not this layer's concern.

**Action:** no code change. Add a one-line comment at the `input.model` resolution site noting that
model must be stable per thread or caching breaks, so the assumption is documented where someone would
reintroduce the problem. Fold "model stability" into the stated cache invariant in the backlog note for
the eventual per-bot-model work (§4.1 of the spec), not now.

---

## Finding 3 — MINOR (note the boundary): test 8 grep scope

The orphan-reference guard (test 8) recurses `lib/` and `app/` and correctly greps for both
`process.env.ANTHROPIC_MODEL` and `'claude-sonnet-4-6'`, excluding `.d.ts`, `.test.ts`, and the harness
itself. It does **not** scan `scripts/`. That's defensible (scripts aren't runtime), but it means an
orphaned `ANTHROPIC_MODEL` left in a script would pass unnoticed. No action required — just state in the
test's comment that the guard is intentionally scoped to `lib`/`app` runtime paths, so the boundary is a
documented choice rather than an oversight.

---

## Verified correct — no action (recorded for confidence)

- **Core fix.** `systemPrompt = basePersona + PROJECT CONTEXT` only; `recentConversation` is in
  `userMessage`. Exactly the spec's minimal shape. `recapConversation` also routes through
  `getModelIdentifier()`.
- **`config.ts`.** `parsePositiveInteger` handles undefined/empty/whitespace/NaN/≤0 → default;
  `validateConfig` throws a named error; `getModelIdentifier` has no fallback. Matches §2 in full.
- **Test 7 memoization defeat.** The validator memoizes via `isConfigValidated`; test 7 correctly uses
  `delete require.cache[...]` to force a fresh module and actually re-exercise the throw. This is the
  subtle step most implementations miss (a naive second call would no-op and false-pass). Done right.
- **`logModelCall` thread resolution.** It resolves the structural `threads.id` (uuid) from
  `(group_id, telegram_thread_id)` and logs both the uuid (`thread_id`) and the int
  (`metadata.telegramThreadId`). This is deliberate and correct — it explains the uuid-vs-int split
  seen in the original ledger rows.

---

## Hand-back summary for Antigravity

**Fix before sign-off (one item):**
1. Add the deterministic `ORDER BY (layer, doc_id)` to `buildContext` (Finding 1). Reconcile the
   lockstep comment per the recommended option. Strengthen test 3 to seed ≥2 same-layer docs and assert
   byte-identical prefix **and** expected order.

**Notes / comments (no functional change):**
2. One-line comment at the `input.model` site re: per-thread model stability (Finding 2).
3. One-line comment on test 8 noting the `lib`/`app` scope is intentional (Finding 3).

Everything else reviewed is correct as built.
