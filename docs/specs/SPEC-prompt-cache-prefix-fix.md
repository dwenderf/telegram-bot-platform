# SPEC — Prompt-Cache Prefix Fix (`answerQuestion` context ordering)

> **Reads against:** `lib/capabilities.ts` (`answerQuestion`, `buildContext`, `recapConversation`),
> `lib/anthropic.ts` (`callModel`), `logBotResponse` (`generation_metadata.model`), and the
> `model_calls` ledger from `SPEC-model-call-logging.md` (this fix is validated *through* that ledger —
> it's the instrument that caught the bug).
> **Rigor bar:** match prior phases; assert post-state in tests, not just "it didn't throw." Capture
> the *actual* string passed to `callModel` and assert on its bytes.
> **One-line scope:** move conversation history **out of** the cached system block so the cached prefix
> is stable per thread and prompt caching actually reads. Behavior-preserving for answers, plus a
> narrow persona wording tweak so history-dependent questions aren't refused. Rides along with a small
> config-hygiene cleanup (§2) since it touches the same files.

> **Sequencing:** build now. Small, self-contained, one primary file (`answerQuestion`). Independent of
> any pending backlog work.

---

## 0. What happened (background — read this first)

Model-call logging (`model_calls`) went live and immediately did its job: it surfaced that **prompt
caching never reads**. Across every logged `answer` call, `cache_read_tokens = 0` and
`cache_creation_tokens` is non-zero — a fresh cache *write* every time, never a *hit*.

The diagnostic detail wasn't "reads are zero," it was that the cached block **grew every call** within
the same group + thread:

| call (chronological) | `input_tokens` | `cache_creation_tokens` | `cache_read_tokens` | prior answer `output_tokens` |
|---|---|---|---|---|
| 1 | 67 | 6,922 | 0 | — |
| 2 | 56 | 7,732 | 0 | 759 |
| 3 | 40 | 8,201 | 0 | 446 |

The cached block grew by ≈ one full prior Q&A turn each call (6,922 → 7,732 is +810 ≈ the 759-token
prior answer + question; 7,732 → 8,201 is +469 ≈ the 446-token prior answer + question). A **static**
document context cannot grow. Something turn-variable was inside the cached block.

Two consecutive calls **under 2 minutes apart** (comfortably inside the ephemeral TTL) still missed —
so this is not "calls too far apart / TTL expiry." The prefix itself differs every call.

**Root cause (confirmed in source, not inferred).** `answerQuestion` builds the system prompt as:

```ts
const systemPrompt = `${basePersona}

PROJECT CONTEXT:
${contextDocs}

RECENT CONVERSATION:
${recentConversation}`;
```

`recentConversation` (the last 30 `message_log` rows, which now include the bot's own logged responses)
is concatenated **into `systemPrompt`** — the exact block `callModel` wraps with
`cache_control: { type: 'ephemeral' }`. Every new turn changes that block, so the hash changes, so the
cache never matches. Guaranteed write, never a read.

**What is NOT wrong** (ruled out by reading the code):
- `callModel` is structurally correct — one cached `system` block, `messages` separate, marker in the
  right place. `cache_creation_tokens > 0` proves the write side and the beta header work. Not backwards.
- `buildContext` is clean — it returns `contextDocs` and `recentConversation` as **two separate
  strings**; it does not itself merge them. The merge happens in `answerQuestion`.
- Retrieval is not the cause — the doc query in `buildContext` is deterministic on
  `(entityId, groupId, threadId)`; same thread pulls the same docs. `contextDocs` is genuinely stable.
  The *only* moving part is `recentConversation`.

**The lucky break:** `RECENT CONVERSATION` is the **last** section of `systemPrompt`. The variable part
is already at the tail, so `basePersona + PROJECT CONTEXT` is a clean, stable prefix. The fix is a
**lift**, not a reorder or rewrite.

---

## 1. The fix

**In `answerQuestion` only:** stop putting `recentConversation` in `systemPrompt`. Move it into the
turn-variable channel (the user message), leaving the system block as `persona + docs` — stable and
byte-identical per thread, so it caches.

### 1.1 Minimal shape (recommended — smallest blast radius)

Keep `callModel`'s signature exactly as it is (`systemPrompt` + `userMessage`). `answerQuestion` folds
history into the user message:

```ts
const systemPrompt = `${basePersona}

PROJECT CONTEXT:
${contextDocs}`;                       // <-- docs only; stable; cached

const userMessage = `RECENT CONVERSATION:
${recentConversation}

QUESTION:
${input.question}`;                    // <-- turn-variable; NOT in the cached block

const result = await callModel({ systemPrompt, userMessage, model });
```

Why this shape and not structured `user`/`assistant` turns *now*:
- It fully fixes the actual bug (caching) with a one-function, few-line diff and **zero** change to
  `callModel`, `recapConversation`, or any test mock's call shape.
- The system block becomes provably stable per thread → cache hits.
- History still reaches the model; it's just in the user turn (uncached, re-sent each call — small,
  correct, and not poisoning the doc cache).
- Modeling history as real alternating turns is nicer but carries real edge cases (multi-human group
  chat → runs of same-role messages, API alternation rules, "who spoke first"). That's a
  conversation-modeling improvement, not part of fixing caching. **Deferred to backlog (§4).**

### 1.2 Persona wording tweak (required, not optional)

Today's default persona says answer **"based ONLY on the provided context documents."** With history
formerly *inside* PROJECT CONTEXT, the model treated it as answerable source. Once history moves to the
user turn, that "ONLY context documents" instruction can cause the model to **refuse** legitimate
history-dependent questions ("what did I just ask?", "summarize what we discussed"). Adjust the wording
so the model may also draw on the recent conversation shown in the user message — e.g. permit answering
from *both* the provided context documents *and* the recent conversation, while keeping the
"if you don't know, say so" guardrail. Keep the change narrow; do not otherwise rewrite the persona.

### 1.3 Persona-ahead-of-docs — forward note (no action now)

`basePersona` sits **ahead of** `contextDocs` in the system block. That's fine today because the default
persona is a constant. **If** persona ever becomes per-call-variable (per-entity / per-bot personas —
see `VISION.md` extensibility surfaces), a varying persona ahead of the docs will poison the cached
prefix the *same way* history did. When that day comes, variable persona content must move out of the
stable prefix too. Note it; build nothing for it now.

### 1.4 Lockstep check with `getContextManifest`

`buildContext`'s doc query carries a **"Lockstep Invariant: Must match `getContextManifest` query
exactly"** comment. This fix does not touch that query, but the implementer must confirm
`getContextManifest` (or any sibling that also assembles a prompt string) is not *also* concatenating
history into a cached block on a different path. Fix one, leave the other, and they diverge. Verify
both context-assembly paths keep history out of the cached prefix.

---

## 2. Config hygiene (while we're in these files)

Three hardcoded values sit in the exact files this fix already edits. This section names them honestly
and draws a firm line between a **genuine default** (a value that is *correct* when unspecified) and a
**masked-missing-config fallback** (a stale duplicate of a decision that must be made elsewhere). The
model identifier is the latter and gets **no fallback** — it fails fast. The two numerics are the
former and keep defaults.

### 2.1 The three variables

| env var | required? | default | governs |
|---|---|---|---|
| `MODEL_IDENTIFIER` | **required — no fallback** | *(none; fail fast)* | which model is called (currently `claude-sonnet-5`) |
| `MODEL_MAX_OUTPUT_TOKENS` | optional | `2048` | `max_tokens` on the model call (`callModel`) |
| `CONTEXT_MESSAGE_HISTORY_LIMIT` | optional | `30` | history-window size in `buildContext` |

**Naming rationale (locked):**
- `MODEL_MAX_OUTPUT_TOKENS` — not bare `MAX_TOKENS`; in a system logging `input_tokens`/`output_tokens`/
  `cache_*_tokens` as columns, "max tokens" is ambiguous. This name matches the ledger's own vocabulary
  (it caps generation, i.e. `output_tokens`).
- `CONTEXT_MESSAGE_HISTORY_LIMIT` — `CONTEXT_`, not `MODEL_`: it's a context-assembly knob (governs the
  `buildContext` history query), not a model-call parameter. Grouped by what-it-governs.
- `MODEL_IDENTIFIER` — replaces `ANTHROPIC_MODEL`. De-provider-ized: the value is a model id, not an
  Anthropic-specific thing. `_IDENTIFIER` not `_ID` — in this codebase `_ID` reads as a UUID/FK, which
  this is not. **No `MODEL_PROVIDER` and no routing layer now** — one provider today; the
  `model_calls.provider` column is the existing seam, and provider routing is backlog (§4) to be
  designed against a *concrete* second provider, not speculatively.

### 2.2 `MODEL_IDENTIFIER` — required, fail fast (no fallback)

Remove the `|| 'claude-sonnet-4-6'` (and any `|| 'claude-sonnet-5'`) literal from **every** site. A
model identifier has no correct-when-unspecified value: the choice is load-bearing (cost, capability,
and every token logged), so an unset `MODEL_IDENTIFIER` is a config error, not a situation to paper over
with a stale literal. A fallback here would let the system run silently on an unintended model and log
`model_calls` rows under a model nobody chose — corrupting the exact attribution the ledger exists to
provide. Fail instead.

- **Fail-fast mechanism: a small required-config validator (§2.4), not a local throw.** Missing required
  config should fail at startup with a legible message ("MODEL_IDENTIFIER is not set"), not surface as an
  opaque provider 400 three layers into a request.

### 2.3 The two numerics — genuine defaults, robust parse

`MODEL_MAX_OUTPUT_TOKENS` and `CONTEXT_MESSAGE_HISTORY_LIMIT` default to `2048`/`30` when unspecified —
those values are correct-when-unspecified, so a default is appropriate (unlike the model id).

**Parse robustly.** Env values are strings; the parse must treat **any non-positive-integer result**
(undefined, empty string, `NaN`, `0`, negative) as "use the default," not just `undefined`. Sending
`max_tokens: NaN` to the API because someone set `MODEL_MAX_OUTPUT_TOKENS=` (empty) in Vercel is the
footgun this guards against. Parse once, clamp to a positive integer, fall back to the default otherwise.

### 2.4 Required-config validator (small, structural — single point)

Add a small validator that runs at startup / first use and asserts all **required** env vars are set,
throwing a clear, named error if any is missing. `MODEL_IDENTIFIER` is its first member. Rationale:
a single validation point (over a scatter of local `if (!x) throw` at each use) is consistent with the
project's structural-over-per-site taste (cf. the single excluded-thread gate) and means new required
vars get consistent fail-fast behavior for free. Optional vars with defaults (§2.3) are **not** members —
they don't fail, they default. Keep it minimal; this is a required-vars gate, not a config framework.

### 2.5 `.env.example` (explicit deliverable)

Update `.env.example` in the same change, and make the required/optional distinction **visible** so a
reader doesn't re-learn the "there's always a safe default" mental model this section kills:
- **Add** `MODEL_IDENTIFIER` marked **required** (comment: required, no default; app fails to start if
  unset). Example value present but commented as "example — must be set explicitly," not silently the
  real default.
- **Add** `MODEL_MAX_OUTPUT_TOKENS` and `CONTEXT_MESSAGE_HISTORY_LIMIT` with their defaults as example
  values and a "optional; defaults to N" comment each.
- **Remove** `ANTHROPIC_MODEL`. (Safe once no code reads it — see §2.6.)

### 2.6 Migrate every site — no orphans

`ANTHROPIC_MODEL` and the literal model string appear in **more than one place** — at least
`answerQuestion`'s model resolution and `logBotResponse`'s `generation_metadata.model`, plus possibly
test mocks. **Grep the repo for both `ANTHROPIC_MODEL` and the literal model strings
(`claude-sonnet-4-6`, `claude-sonnet-5`) and migrate every occurrence.** A partial migration is the
worst outcome: one path resolving `MODEL_IDENTIFIER` (fail-fast) and another still reading
`ANTHROPIC_MODEL || 'claude-sonnet-4-6'` (silent, stale). The `.env.example` removal (§2.5) is correct
**only once this migration is complete** — the two are coupled, not independent edits.

---

## 3. What this deliberately does NOT do

- **No structured `user`/`assistant` turn modeling.** History stays a flattened string in the user
  message (§1.1). Alternating-turn modeling is backlog (§4).
- **No `callModel` signature change.** It stays `systemPrompt` + `userMessage`. Widening it to accept a
  `messages` array is backlog, tied to the turn-modeling work.
- **No `MODEL_PROVIDER` / provider-routing layer.** One provider today; the `provider` column is the
  seam. Routing is designed later against a concrete second provider (§4).
- **No second cache breakpoint / incremental history caching.** Build-ahead-of-need; not now.
- **No `bot_id` population.** Related to `model_calls` fidelity but an unrelated change — separate spec
  (§6), for review hygiene (don't mix a prompt fix with a logging-attribution change in one diff).
- **No change to `buildContext`'s doc query, sort order, or `recapConversation`.**

---

## 4. Backlog items this surfaces

1. **Dynamic per-call generation params.** `MODEL_MAX_OUTPUT_TOKENS`, history-window size, and model
   should eventually be **bot-decided** (per-bot / per-call), not global env. The env vars are the
   interim step; the seam is "the bot chooses." Ties to the bots/skills extensibility surface in
   `VISION.md`.
2. **Structured conversation turns.** Reshape `recentConversation` into real `user`/`assistant` turns
   in the `messages` array (bot rows → `assistant`, human rows → `user`, collapse consecutive
   same-role runs, handle "assistant spoke first"), widening `callModel` to accept a `messages` array.
   Correctness + multi-turn quality win; edge-case heavy; not needed to fix caching.
3. **Incremental history caching** (optional, low priority). A second `cache_control` breakpoint on a
   growing history prefix — only worth it if traffic patterns show it pays. The ledger will tell us.
4. **Provider routing / multi-provider.** A `MODEL_PROVIDER` var + adapter layer (SDK selection,
   provider-specific usage-field mapping — note `cache_read_input_tokens`/`cache_creation_input_tokens`
   are Anthropic-named and won't survive a second provider — and populating `model_calls.provider` from
   it). Design against a concrete second provider, not now. `MODEL_IDENTIFIER` + the `provider` column
   are the seams that make this an addition, not a rework.
5. **`generation_metadata.model` redundancy.** `model_calls.model` records `response.model` — the model
   the API *actually served*, i.e. the source of truth. `logBotResponse`'s `generation_metadata.model`
   is a best-effort *guess* recorded before the call and can disagree (e.g. if `input.model` is ever
   set). Candidate for later removal/reconciliation; flagged for review, not fixed here.

---

## 5. Tests (`scripts/test-prompt-cache-prefix.ts`)

The unit-level assertions capture the string(s) passed to `callModel` via the `mockCallModel` seam and
assert on bytes — this is the durable regression guard and needs no live API.

1. **Docs in system, history not in system.** After an `answerQuestion` call, the captured
   `systemPrompt` **contains** the context-doc content and **does not contain** the recent-conversation
   text. (Directly asserts the bug is gone.)
2. **History reaches the model.** The captured `userMessage` **contains** the recent-conversation text
   **and** the current question. (Asserts history wasn't simply dropped.)
3. **Stable prefix across turns (the core regression guard).** Seed a thread, call `answerQuestion`,
   log a new bot/user message into `message_log` (so `recentConversation` would change), call
   `answerQuestion` again with a *different* question in the *same* thread. Assert the two captured
   `systemPrompt` values are **byte-identical**. (This is the assertion whose absence let the bug ship.)
4. **Prior answer never in the prefix.** After a turn whose answer is known, the *next* call's captured
   `systemPrompt` **does not contain** the prior answer's text. (Catches history-in-prefix even if
   reintroduced by a different route than today's.)
5. **History-dependent question is answerable (anti-stonewall).** With a mock that echoes what it
   received, assert the recent-conversation content is present in what `callModel` was given, so a
   "what did we just discuss?" question *can* be answered. (Guards the §1.2 persona tweak.)
6. **Config defaults + robust parse.** With `MODEL_MAX_OUTPUT_TOKENS` / `CONTEXT_MESSAGE_HISTORY_LIMIT`
   set to valid non-default values, assert the history query uses the configured limit and the model
   call uses the configured `max_tokens`. With them **unset**, assert defaults (30 / 2048). With them
   set to **malformed** values (empty string, non-numeric, `0`, negative), assert the code falls back to
   the default — not `NaN`, not the bad value. (Guards §2.3.)
7. **Required-config validator fails fast.** With `MODEL_IDENTIFIER` **unset**, the validator throws a
   clear, named error ("MODEL_IDENTIFIER" appears in the message); with it set, it passes. Assert the
   throw actually happens — proving fail-fast works, not assuming it. (Guards §2.2/§2.4.)
8. **No orphaned references.** A static check (grep-style assertion or test) that `ANTHROPIC_MODEL` and
   the bare literal model strings no longer appear in `lib/` runtime paths. (Guards §2.6 — catches a
   partial migration.)

**Integration (manual / gated, real API — document, don't wire into the mocked suite):**

9. **End-to-end cache hit.** Two real same-thread calls within the TTL → the second row's
   `cache_read_tokens` ≈ the first row's `cache_creation_tokens`, and the second's `cache_creation_tokens`
   ≈ 0. This is the real proof caching works; `SPEC-model-call-logging.md` test 3 only checked that
   cache *columns populate from a mock* — it never asserted a real read. Test 3 above is the mocked
   proxy for this; this item is the live confirmation to run once by hand after deploy.

---

## 6. Sibling spec (separate handoff): `bot_id` population

Not in this spec's diff. Captured here so it isn't lost: `model_calls.bot_id` is NULL on every row.
Per `SPEC-model-call-logging.md` that was a correct v1 "nullable seam" — but Phase 3 shipped the single
shared platform bot (`@leguan_the_bot`) with a backfilled `bots` row, so a real bot id now exists to
point at. **Decision to state explicitly in that spec:** populate `bot_id` with the *platform bot's id*
(meaning "which bot served this call" — the singleton today), **not** left as the multi-bot-store seam.
Low effort if the platform bot id is already resolved on the `logModelCall` path; slightly more if it
must be loaded. Write it as its own short spec on request.

---

## 7. Handoff notes for Antigravity

- **One primary file:** `lib/capabilities.ts` → `answerQuestion`. Move `recentConversation` out of
  `systemPrompt` and into `userMessage` (§1.1). Adjust the default persona per §1.2.
- **`callModel` signature unchanged.** Only its `max_tokens` becomes env-driven via
  `MODEL_MAX_OUTPUT_TOKENS` (§2.1/§2.3).
- **Config hygiene (§2) is part of this diff:** rename `ANTHROPIC_MODEL` → `MODEL_IDENTIFIER` with **no
  fallback**; add the two optional numerics with robust parse-and-default; add the required-config
  validator; grep-migrate every `ANTHROPIC_MODEL` / literal-model-string site (§2.6); update
  `.env.example` (§2.5). The `.env.example` removal of `ANTHROPIC_MODEL` is valid **only after** the
  grep migration is complete.
- **Read before you assert.** Confirm the actual current `systemPrompt` template and every model-string
  site in source before editing; the spec quotes them, but verify they haven't drifted.
- **Verify the lockstep path (§1.4)** — don't fix `buildContext`/`answerQuestion` and leave
  `getContextManifest` concatenating history into a cached block.
- **Tests assert bytes, not smoke.** Capture the real args to `callModel`; the byte-identical-prefix
  test (test 3) and the fail-fast validator test (test 7) are the point of the exercise.
- **Scope discipline:** history stays a flat string; no turn modeling, no `callModel` widening, no
  `MODEL_PROVIDER`/routing, no `bot_id` — all explicitly backlog/sibling (§3, §4, §6).

### Deploy / config sequencing (operator: David)

- **`MODEL_IDENTIFIER` can be set in Vercel now** (before the new code deploys) — nothing reads it yet,
  so setting it early is harmless and means the fail-fast prerequisite is already satisfied at deploy.
  Set it to `claude-sonnet-5` (current prod model).
- **`ANTHROPIC_MODEL` may be deleted now too** — the *currently deployed* code still has its literal
  fallback, so removing the Vercel var won't hard-fail. **One nuance:** with `ANTHROPIC_MODEL` gone, the
  *old* code falls to its hardcoded literal until the new code ships — if that literal is still
  `claude-sonnet-4-6`, prod transiently runs 4-6 rather than 5 for that window. Harmless functionally,
  but if you'd rather avoid even the transient downgrade, leave `ANTHROPIC_MODEL` set until the new code
  (which ignores it) is live, then delete. Either order is safe; this is the only wrinkle.
- **After deploy + test:** `ANTHROPIC_MODEL` is fully dead (new code never reads it). Its removal from
  Vercel/`.env.local` is a cleanup step, gated on successful test — retained only as rollback safety
  until then.
