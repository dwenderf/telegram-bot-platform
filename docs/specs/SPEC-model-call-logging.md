# SPEC — Model-Call Usage Logging (`model_calls`)

> **Reads against:** `lib/anthropic.ts` (`callModel`), `lib/capabilities.ts` (`answerQuestion`,
> `recapConversation`), the runtime RLS pattern in `20260618000000_init_schema.sql` +
> `20260701000000_manifest_normalization_additive.sql` (`threads` RLS is the template).
> **Rigor bar:** match prior phases; assert post-state in tests. No new SECURITY DEFINER functions.
> **One-line scope:** capture **actual** token usage + model metadata for **every** model call in a
> minimal `model_calls` ledger. Measurement only — **no** billing, credits, gating, aggregation, or
> external-bot APIs.

> **Sequencing:** spec now; **build AFTER Phase 4.** Independent of Phase 4 (touches the model-call
> path, not context resolution), so no code overlap.

---

## 0. Why (and why now, but built after Phase 4)

- **Prompt caching is already live.** `callModel` sends the system prompt (the static document context)
  as an `ephemeral` cache block. We currently have **zero visibility** into whether caching is working
  — cache hits vs. misses, tokens saved. Capturing `cache_read` vs `cache_creation` tokens answers the
  exact question "are certain patterns hitting cache better?" from day one.
- **Usage data is a flow, not a backfill.** Every call made without capture is data lost forever. But
  at current low traffic the *interim* loss is small and low-value (cache-pattern analysis needs
  volume), so building this *after* Phase 4 is acceptable — the meaningful data accumulates once usage
  ramps, which is after both ship.
- **Foundation for the monetization horizon** (`docs/VISION.md`): if bots later use different
  models/providers, or external bots run on the platform, per-call usage is the basis any future
  charging/credit model would need. **We build only the raw capture now** — the ledger. Everything
  downstream (billing, credits, external usage APIs, rollups) is explicitly deferred.

---

## 1. What the response already gives us (capture, don't compute)

`anthropic.messages.create(...)` returns (today, in `callModel`, currently discarded):
- `response.usage.input_tokens`, `response.usage.output_tokens`
- `response.usage.cache_read_input_tokens`, `response.usage.cache_creation_input_tokens` (present
  because caching is enabled) — **the analytically valuable pair**
- `response.model` (the *actual* model that served — may differ from requested), `response.id`,
  `response.stop_reason`

**No pre-call estimation.** Post-call `usage` is exact, free (already in the response), and includes
output + cache metrics that pre-call estimation fundamentally can't know (cache state is server-side).
Pre-call `count_tokens` is only useful for *gating* spend before a call — which is deferred with
billing. Note it as a future seam tied to gating; **do not build it.**

---

## 2. `model_calls` table (minimal ledger — one row per call)

```sql
create table public.model_calls (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references public.entities(id) on delete cascade,
  group_id              uuid references public.groups(id)  on delete set null,
  thread_id             uuid references public.threads(id) on delete set null,
  bot_id                uuid references public.bots(id)    on delete set null,   -- seam: null in v1; bot-store attribution later
  call_type             text not null,                                          -- 'answer' | 'recap' (discriminator; extend as new call sites appear)
  model                 text not null,                                          -- response.model (actual model served)
  provider              text not null default 'anthropic',                      -- seam: multi-provider later
  input_tokens          integer,                                                -- typed: primary analytical axis, always present
  output_tokens         integer,
  cache_read_tokens     integer,                                                -- the cache-performance pair
  cache_creation_tokens integer,
  metadata              jsonb,                                                   -- provider-variable rest: response.id, stop_reason, other providers' differently-named metrics
  created_at            timestamptz not null default now()
);
```

**Hybrid column rationale (resolves the "don't duplicate" concern):** the four token counts are typed
columns **on `model_calls` and nowhere else** — they are captured exactly once, in this table. Nothing
in `message_log` holds token data (we are **not** enriching `message_log.generation_metadata` with
tokens — that intermediate step is rejected). So there is no cross-table duplication: `model_calls` is
*the* ledger, permanently. Typed for the four counts (queried constantly, always present, portable
enough); JSONB for the provider-variable rest (may not exist / may be named differently across
providers).

- **`on delete set null`** for group/thread/bot (not cascade) — a usage record should **survive** the
  deletion of a group/thread/bot; the historical fact that the call happened + its cost shouldn't
  vanish because a group was later removed. (Contrast `entity_id` cascade — if an entire entity is
  purged, its usage rows go too; reasonable.) *(Decision worth confirming — see §6.)*
- **Indexes:** `(entity_id, created_at)` for per-entity usage-over-time queries; `(created_at)` for
  global. Keep minimal; add as query patterns emerge. *(At a few hundred rows, indexes are optional —
  add the `(entity_id, created_at)` one as forward-provisioning, cheap.)*

**RLS:** mirror the `threads` / `message_log` runtime pattern exactly — `enable` + `force` row level
security, `entity_id = current_setting('app.current_entity_id')` isolation policy, `grant select,
insert on model_calls to bot_service`. (Insert is what the callers need; no update/delete for the bot
at runtime.) **No new SECURITY DEFINER functions.**

---

## 3. Code changes

### 3.1 `lib/anthropic.ts` — widen `callModel`'s return (keep it a pure wrapper)
`callModel` currently returns `{ text }`, discarding `usage`. Change its return to surface usage +
model metadata **without** giving it a DB dependency (keep it a pure API wrapper; the `mockCallModel`
seam stays clean):

```ts
export interface CallModelResult {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;       // from cache_read_input_tokens (0 if absent)
    cache_creation_tokens: number;   // from cache_creation_input_tokens (0 if absent)
  };
  model: string;                     // response.model (actual)
  requestId: string | null;          // response.id
  stopReason: string | null;         // response.stop_reason
  raw?: Record<string, any>;         // optional: anything else for metadata jsonb
}
```
- Map Anthropic's `cache_read_input_tokens`/`cache_creation_input_tokens` → `cache_read_tokens`/
  `cache_creation_tokens`, defaulting to `0` when the field is absent (older responses / cache off).
- **`mockCallModel` must return the same shape** — update the mock type + all test mocks to supply a
  `usage` object (else tests break). A zero-usage default is fine for mocks.
- `callModel` still does **no DB write** — it just returns richer data.

### 3.2 `lib/capabilities.ts` — a `logModelCall` helper + call it at each site
Add a small helper (one insert), called by each model-invoking function **inside its existing
`withTenantContext`** (so the RLS `app.current_entity_id` is set and the insert passes the policy):

```ts
async function logModelCall(tx, row: {
  entityId, groupId, threadId, botId?, callType, result: CallModelResult
}): Promise<void>   // inserts one model_calls row from result.usage + result.model + metadata
```

- **`answerQuestion`**: after `callModel`, `logModelCall({ callType: 'answer', ... })` with
  `entityId/groupId/threadId` (and `botId` if/when threaded through — null for now). Note
  `answerQuestion` calls `callModel` *outside* an explicit tenant tx today (it awaits `buildContext`
  which opens its own tx, then calls the model) — **wrap the model call + log in a `withTenantContext`**
  so the insert is RLS-scoped. Confirm the current tx boundaries when implementing.
- **`recapConversation`**: same, `callType: 'recap'`, `entityId/groupId/threadId`.
- **Failure isolation:** logging must **never** break the user-facing answer. Wrap `logModelCall` so a
  logging failure is caught + console-logged, not thrown — a usage-capture hiccup must not fail an
  answer. (The model call already succeeded; losing one usage row is acceptable, failing the answer is
  not.)

> **Attribution available at each site (verified):** `answerQuestion` has
> `entityId/groupId/threadId/model/persona` (+ future `botId`); `recapConversation` has
> `entityId/groupId/threadId`. Both already run inside/near `withTenantContext`. So every call can be
> attributed to entity + group + thread + type. `bot_id` is a nullable seam (bot-store attribution
> later).

---

## 4. What this deliberately does NOT do

- **No billing, credits, pricing, or cost computation.** Tokens only; cost = tokens × rate is a future
  concern (rates vary by model/provider/time — not stored here).
- **No pre-call token estimation** (§1) — deferred gating seam.
- **No external-bot usage read/write API.** If external bots run their own models, they track their
  own usage; if they run *through* our model calls, those calls get logged here like any other. Exposing
  this table to external parties (secure read/write) is a future, deliberate decision — not now.
- **No aggregation/rollup tables, no dashboards.** Raw ledger only; query it directly for now.
- **No enrichment of `message_log`** with token data — `model_calls` is the sole home (no duplication).
- **No changes to context resolution** (that's Phase 4) or the answer logic itself.

---

## 5. Tests (`scripts/test-model-call-logging.ts`)

Mock `callModel` to return a known `usage` shape; assert the ledger row.

1. **Answer path logs a row:** an `answerQuestion` call inserts one `model_calls` row with
   `call_type='answer'`, correct `entity_id/group_id/thread_id`, the mock's token counts in the typed
   columns, and `model`/`metadata` populated.
2. **Recap path logs a row:** `recapConversation` → one row, `call_type='recap'`, correct attribution.
3. **Cache fields captured:** a mock `usage` with non-zero `cache_read`/`cache_creation` lands in the
   typed `cache_read_tokens`/`cache_creation_tokens` columns (the analytical pair).
4. **Absent cache fields → 0, not null/error:** a mock `usage` omitting cache fields yields `0` in
   those columns (the mapping defaults).
5. **RLS isolation:** a `model_calls` row is only visible/insertable under the matching
   `app.current_entity_id`; `bot_service` has insert; cross-entity read is blocked (mirror the
   `threads`/`message_log` RLS test).
6. **`on delete set null`:** deleting a `group`/`thread` sets the `model_calls` FK null but **keeps the
   row** (usage survives); deleting the `entity` cascades the rows away. (Assert the chosen behavior.)
7. **Logging failure isolation:** if the `model_calls` insert throws (simulate), the
   `answerQuestion`/`recapConversation` result is **still returned** (answer not broken) — the failure
   is swallowed + logged.

---

## 6. Open decisions to confirm before build

- **FK on-delete for group/thread/bot: `set null` (keep usage rows) vs `cascade` (purge with parent).**
  Lean `set null` — usage history should outlive a deleted group/thread. Confirm.
- **`bot_id` now or later:** include the nullable `bot_id` FK column now as a cheap seam (recommended —
  it's free and it's the bot-store attribution point), or add it when bots actually vary. Lean:
  include now, leave null.
- **Index provisioning:** add `(entity_id, created_at)` now, or wait? Lean: add it now (cheap, and the
  obvious first query axis).

---

## 7. Handoff notes for Antigravity

- **Build AFTER Phase 4.** Independent, but Phase 4 ships first.
- **`callModel` stays a pure wrapper** — widen its return to include `usage`/`model`/metadata; it does
  NO DB write. Update `mockCallModel`'s type + all existing test mocks to the new return shape (this
  will touch existing tests that mock the model — they must supply a `usage` object).
- **Callers log** via a `logModelCall` helper **inside `withTenantContext`** (RLS-scoped insert).
- **Logging never breaks the answer** — swallow + console.error on insert failure; never throw from the
  logging path.
- **`model_calls` RLS mirrors `threads`/`message_log`** (force-RLS + entity isolation + `bot_service`
  insert grant); no SECURITY DEFINER functions.
- **Hybrid columns:** four token counts typed (`input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_creation_tokens`); everything else in `metadata jsonb`. No token data anywhere else (no
  `message_log` enrichment) — `model_calls` is the sole ledger.
- **Scope discipline:** raw capture only. No billing/credits/gating/rollups/external APIs/pre-call
  estimation — all explicitly out (§4).
