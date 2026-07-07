# SPEC — Group-scoped `isolationScopeId` (provider `user_id` isolation)

> **Reads against:** `lib/model.ts` (`CallModelInput`, `ModelProvider`, `resolveProvider`, mock seam),
> `lib/providers/anthropic.ts` and `lib/providers/deepseek.ts` (request construction), `lib/capabilities.ts`
> (`answerQuestion`, `recapConversation`, `logModelCall`), `lib/config.ts` (env access pattern),
> `app/api/webhooks/platform/[botSlug]/route.ts` (guarantees a resolved group before either caller runs),
> and `.env.example`.
> **Rigor bar:** the two load-bearing assertions must be non-hollow — prove the value actually reaches
> each SDK call's request body, and prove the cached `system` block stays byte-identical. A test that only
> checks the resolver's return value does not count. The existing suite does NOT pass unmodified: literals
> must gain the new required field, and harnesses calling the capabilities must provision `APP_HMAC_PEPPER`
> (fail-fast in the hot path) — see §6.9 / Addendum B.
> **One-line scope:** attach a per-**group** opaque id (`HMAC-SHA256(APP_HMAC_PEPPER, "isolation-scope:" + groupId)`
> hex) to every model call, mapped uniformly to both providers' `metadata.user_id`, produced by one
> fail-fast resolver, and recorded in `model_calls.metadata` for diagnostics.
> **Sequencing:** self-contained; build after the provider abstraction + DeepSeek provider (both shipped).
> No migration. No backfill. Forward-only.

---

## 0. Why + how the design was pinned

Today every model call carries no `user_id`, so all traffic lands in each provider's shared "empty
user_id" bucket. This attaches a per-group identifier so abuse/content-safety attribution and (on
DeepSeek) KVCache partitioning are scoped to **one group** rather than the whole platform account.

**Verified provider behavior (the design rests on these):**

1. **DeepSeek's Anthropic-compat endpoint takes the id as `metadata: {"user_id": "..."}`** — same shape
   as Anthropic. Value constraint: `[a-zA-Z0-9\-_]+`, max length 512, no PII. Documented functions:
   content-safety isolation, KVCache isolation ("for privacy management"), scheduling isolation. Nuance:
   for **regular** API accounts, all `user_id`s are *combined* for concurrency, so per-tenant *concurrency*
   isolation only activates on expanded quota; **content-safety and KVCache isolation are always on**.
   (Source: DeepSeek "Rate Limit & Isolation" doc; live-verified — see §6.7.)
2. **Anthropic** prompt cache is isolated by organization/workspace and is content-addressed (a hit
   requires a byte-identical prefix up to the `cache_control` block). **`metadata.user_id` does NOT
   participate in the cache key** — it is abuse/trust-and-safety scoping only. (Source: Anthropic
   prompt-caching docs, verified 2026.)

**Consequences baked into this spec:**

- The mapping to `metadata.user_id` is **uniform** across both current providers — one field, two identical
  attachments.
- `metadata` is a **top-level sibling** of `system`/`messages`, outside the cached prefix, so attaching it
  must not change any cache key. This is a **test requirement** (§6.2), not an assumption.
- **Group is the correct scope.** It is the real document-isolation boundary in this schema (entity-general
  + group-scoped + topic-scoped docs; e.g. HYS-Internal / HYS-Capital / HYS-Board see different docs). A
  content-safety trip in one group must not shut down its sibling groups.

**Honest framing of the benefit (so the rationale isn't oversold):** present-tense value is abuse/
content-safety attribution + DeepSeek KVCache hygiene. The broader cache-leak protection is **insurance**
against a future where user-controlled text enters the cached prefix (an entity-level shared breakpoint, or
caching conversation history). It is not closing a presently-exploitable hole: today the cached prefix
(`persona + format rules + RLS-group-scoped docs`, assembled server-side in `answerQuestion`) contains no
attacker-controlled bytes — the only such input, `question`, lands in the uncached suffix. Build the seam
now; it costs almost nothing and it de-risks a plausible future change.

**Live-verify caveat (per the DeepSeek-provider precedent).** `SPEC-deepseek-provider.md` established that
the compat endpoint diverges from DeepSeek's published (native-API) docs and that live responses win over
doc text. The `metadata.user_id` claim above is from the rate-limit doc, which mostly describes the native
API. Therefore, before/with implementation, **live-verify that a request to
`https://api.deepseek.com/anthropic/v1/messages` carrying `metadata.user_id` succeeds (does not 400 on an
unknown field).** That the id is *honored* for isolation is not externally observable and is accepted on
the doc's word; that it is *accepted without error* is a hard must-verify, because a rejection would break
every DeepSeek call. See §6.7. (Done — 200 OK, `metadata` accepted; recorded in the plan-review evidence.)

## 1. Locked decisions (invariants — implementation must not deviate)

1. Field name **`isolationScopeId`** — neutral (not "user_id"), because it is a group scope, not a human.
2. Scope **group**. Resolver hashes `groupId`. **Requires a group — no entity or DM fallback.** Every model
   call today is group-scoped; the webhook bails before `answerQuestion`/`recapConversation` if the group
   did not resolve.
3. Primitive **HMAC-SHA256**, key = `APP_HMAC_PEPPER`, hashed message = `"isolation-scope:" + groupId`
   (domain tag `'isolation-scope'` joined to the message by a shared `pepperedHmac(domain, message)` helper
   that owns the `:` separator — see §2), output lowercase hex (64 chars). Deterministic; no per-call salt.
   (HMAC, not `sha256(pepper + groupId)`: the pepper is a secret key, so HMAC is the correct keyed-hash
   primitive and it removes concatenation-ambiguity / length-extension concerns. The domain separation is
   mandatory — see decision 10.)
4. **Fail-fast, single producer.** One resolver is the only producer of the id. It **throws — never returns
   null/empty** — if the pepper is missing OR `groupId` is missing. The pepper has **no silent default and
   no degrade-to-bare-hash** path.
5. `isolationScopeId` is a **required `string`** on `CallModelInput` (same status as `cacheable: boolean`).
   No `?? null` coalescing anywhere downstream — by construction there is nothing to coalesce.
6. Resolver is called **before `provider.callModel`** in both call sites, so a failure aborts the operation
   before anything reaches the provider.
7. Providers attach `metadata: { user_id: input.isolationScopeId }` verbatim, no coalescing.
8. Logging: record `isolationScopeId` and `isolationScopeType: "group"` in the existing
   `model_calls.metadata` JSON. **No new column, no migration, no backfill.**
9. Untouched: `CallModelResult`, the global mock seam in `resolveProvider`. The existing suite is **not**
   expected to pass fully unmodified: (a) tests constructing a `CallModelInput` literal directly must gain
   the required field, and (b) any harness that calls `answerQuestion`/`recapConversation` must provision
   `APP_HMAC_PEPPER` in-process, because the fail-fast resolver now throws in the hot path (unlike the
   passive `cacheable` field). See §6.8–6.9.
10. **Shared app-wide pepper, domain-separated per use.** `APP_HMAC_PEPPER` is a single application secret
    intended to key multiple HMAC domains over time (isolation scope IDs now; `message_log`
    `telegram_user_id` / `username` PII obfuscation later — that hasher itself is out of scope here, see §8).
    Domain separation is enforced **structurally** by the shared `pepperedHmac(domain, message)` primitive
    (§2), which owns the `:` join so no caller re-implements the separator (and no space-after-colon drift
    is possible). Each domain passes a distinct fixed tag (`'isolation-scope'` here; `'tg-user'` later) so
    outputs are provably independent across domains and identical raw inputs in different domains never
    collide. Rotating the pepper resets **all** domains at once.

## 2. New file: `lib/isolation.ts`

Single-purpose module. It defines one shared HMAC primitive that owns the pepper read, the fail-fast, the
algorithm, and the domain-separator join — and a thin per-domain wrapper on top.

Why a primitive + wrapper rather than a bare per-function constant: the invariant "same pepper, same
algorithm, same separator" must hold across future uses written later, by a different author. Expressing it
**once** removes the copy-paste-and-drift failure mode — a second hasher that forgot the separator, added a
stray space, or read a slightly different env var would silently produce *correlatable* hashes, defeating
the very isolation the domain separation exists to provide, with nothing throwing. Letting the primitive own
the `:` join (instead of baking the colon into each domain constant) is what makes the separator
byte-identical across domains: no caller re-honors a convention.

Why not an interface: the call sites are concrete and static (`answerQuestion` wants the scope id; the
future `message_log` writer wants the tg-id hash) — nothing ever holds an abstract "hasher" and dispatches
at runtime, so an interface would be indirection with no consumer, and it would bury the domain tag behind a
class name instead of surfacing it as a grep-able argument at each call site.

Scope discipline: build **only** the isolation wrapper now, and keep `pepperedHmac` **module-private**. When
the `message_log` PII hasher lands (its own spec), that spec adds its own wrapper and promotes `pepperedHmac`
to a shared module. Do not add a second wrapper or promote the primitive ahead of that spec. We commit to
the *shape* now, not a second consumer.

```ts
import { createHmac } from 'crypto';

/**
 * Records which scope contract produced a model_calls row. Static "group" today
 * ("requires a group for now"). When the DM / purpose-bot future changes the resolver
 * contract to allow another scope, this tag lets historical rows stay self-describing
 * instead of being inferred from row age.
 */
export const ISOLATION_SCOPE_TYPE = 'group' as const;

/**
 * Shared peppered-HMAC primitive — the single place that reads APP_HMAC_PEPPER, applies
 * the algorithm, and joins the domain tag to the message with a fixed ':' separator.
 *
 * Module-private for now: resolveIsolationScopeId below is the only caller. When the
 * message_log PII hasher lands (its own spec), promote this to a shared module then — do
 * NOT add a second wrapper here ahead of that spec.
 *
 * Fail-fast: throws if the pepper is unset. Never returns an unpeppered hash.
 *
 * Domain separation via `${domain}:${message}` is injective ONLY because `domain` values
 * are fixed internal constants that never contain a ':'. NEVER pass a user-controlled
 * string as `domain` (that would need length-prefixing to stay unambiguous); `message`
 * may be arbitrary, as it is the trailing field.
 */
function pepperedHmac(domain: string, message: string): string {
  const pepper = process.env.APP_HMAC_PEPPER;
  if (!pepper) {
    throw new Error('APP_HMAC_PEPPER is not set; refusing to hash.');
  }
  return createHmac('sha256', pepper).update(`${domain}:${message}`).digest('hex');
}

/**
 * Produce the opaque per-group identifier passed to providers as metadata.user_id.
 *
 * Domain tag 'isolation-scope' — the primitive appends the ':' separator, so the tag
 * carries no colon. Do NOT change the tag string: it is baked into every historical hash;
 * changing it silently orphans every previously-issued id (new cache partitions, new
 * content-safety identities, and logged ids that no longer match live output).
 *
 * Throws (via the primitive on missing pepper, or the guard on missing groupId) — never
 * returns null/empty. A missing pepper or groupId is a misconfiguration we refuse to paper
 * over by sending an unscoped (empty-user_id) call; the throw aborts before any provider
 * request goes out.
 *
 * Output: 64-char lowercase hex. Satisfies DeepSeek's user_id constraint
 * ([a-zA-Z0-9\-_]+, length <= 512) and Anthropic's opaque-id / no-PII guidance.
 */
export function resolveIsolationScopeId(groupId: string): string {
  if (!groupId) {
    throw new Error(
      'resolveIsolationScopeId: groupId is required (isolation is group-scoped).'
    );
  }
  return pepperedHmac('isolation-scope', groupId);
}
```

Do **not** surface the pepper through `lib/config.ts` (existing config getters are non-throwing; the
fail-fast must be co-located with the primitive).

## 3. `lib/model.ts` — add the required field

In `CallModelInput`, add:

```ts
isolationScopeId: string; // required; produced only by resolveIsolationScopeId()
```

No change to `resolveProvider` or the mock wrapper. The mock's `callModel` receives the full input
(including `isolationScopeId`) automatically — mock-based tests may read `input.isolationScopeId`, but that
is **not** a substitute for §6.1 (which must prove the value reaches the real SDK boundary).

## 4. Providers — uniform `metadata.user_id` mapping

### 4.1 `lib/providers/anthropic.ts`
In the `anthropic.messages.create(...)` **first argument** (request body, alongside `model` / `max_tokens`
/ `system` / `messages`), add:

```ts
metadata: { user_id: input.isolationScopeId },
```

Top-level sibling only — **never** inside `system` or `messages`. Leave the `{ headers }` second argument
and all `cache_control` logic exactly as they are.

### 4.2 `lib/providers/deepseek.ts`
In the `this.anthropic.messages.create({...} as any)` object (alongside `model` / `max_tokens` / `system` /
`messages` / `thinking`), add:

```ts
metadata: { user_id: input.isolationScopeId },
```

Same placement rule. Leave `thinking: { type: 'disabled' }` and the `as any` cast as they are.

## 5. `lib/capabilities.ts` — resolve, thread, and log

Import:

```ts
import { resolveIsolationScopeId, ISOLATION_SCOPE_TYPE } from './isolation';
```

### 5.1 `answerQuestion`
Compute the id at the **top of the function body, before `buildContext`**, so a misconfiguration fails fast
and cheap (before DB work and before any provider call):

```ts
const isolationScopeId = resolveIsolationScopeId(input.groupId);
```

Pass it into `callModel` (which already passes `cacheable: true`) and into the existing `logModelCall({...})`
call (new field `isolationScopeId`).

### 5.2 `recapConversation`
Identical pattern: compute `const isolationScopeId = resolveIsolationScopeId(input.groupId);` at the top of
the body (before building the transcript), pass it into `callModel` (which passes `cacheable: false`) and
into `logModelCall({...})`. **Do not** change recap's model selection (`getModelIdentifier()` vs
`bot.model`) — out of scope here.

### 5.3 `logModelCall`
Add the required param `isolationScopeId: string;` to the `input` type. Then **fix the metadata spread
order** — spread `result.raw` **first**, then the controlled keys, so controlled provenance always wins
regardless of what a provider returns in `raw`:

```ts
${tx.json({
  ...input.result.raw,
  isolationScopeId: input.isolationScopeId,
  isolationScopeType: ISOLATION_SCOPE_TYPE,
  requestId: input.result.requestId,
  stopReason: input.result.stopReason,
  telegramThreadId: threadIdStr ? parseInt(threadIdStr, 10) : null,
})}
```

Current code spreads `...input.result.raw` **last** — that ordering lets a provider payload clobber
controlled keys. This reversal is **in scope and required** (it's why `isolationScopeId` can be trusted for
diagnosis). `raw` is `undefined` today, so this is defensive, but the diagnostic field's whole job is to be
authoritative.

## 6. Tests

Harness rules (`AGENTS.md`): unit-level, no live-DB DDL, no destructive operations. Logging tests stub
`withTenantContext`/`tx`; they do **not** hit the live database. **Assertions must be non-hollow** — a test
that only checks the resolver's return, or only that a function was called, does not satisfy §6.1 or §6.2.

1. **Provider request body carries `metadata.user_id` (both providers) — via fetch-boundary interception.**
   Do this at the `fetch` boundary, **not** through `setMockCallModel`: when a mock is set, `resolveProvider`
   returns a wrapper whose `callModel` *is* the mock, so the real provider and its `messages.create` never
   run and any assertion there is hollow. Instead, with **no active mock** (`setMockCallModel(null)`), drive
   the real provider (through `answerQuestion`, so the real resolver runs and the wire must carry the
   *resolved* hash) and intercept `global.fetch`. The interception MUST:
   - **Route by host** — requests to `api.anthropic.com` / `api.deepseek.com` are captured (record the
     parsed `JSON.parse(options.body)`); all other hosts (Telegram) fall through to the existing mock
     behavior, or the `sendMessage` tests (e.g. Test 8) break.
   - **Return a real `Response`** — `new Response(JSON.stringify(messagesBody), { status: 200, headers: { 'content-type': 'application/json' } })`, where `messagesBody` is a valid Messages shape (`id`, `type`,
     `role`, `model`, `content: [{ type: 'text', text }]`, `stop_reason`, `usage`). The Anthropic SDK (used
     by BOTH providers) reads `response.status` and `response.headers.get(...)`; the minimal
     `{ ok, json, text }` shape the Telegram mock uses throws `headers.get is not a function`, lands in the
     provider's catch, and tempts a fallback to the hollow `setMockCallModel` assertion. Do not copy it.
   Then assert the captured body's `metadata.user_id` **strictly equals** the resolved hash, for **both**
   the Anthropic and DeepSeek paths.
2. **Cache prefix integrity (Anthropic).** From the same captured request body (§6.1), assert `metadata` is
   a **top-level sibling** key of the `create()` argument and appears **nowhere** inside `body.system` or
   `body.messages`. (Operationalizes "does not perturb the cache key" without a golden baseline. The
   byte-identical-`systemPrompt`-across-turns property is independently guarded by
   `test-prompt-cache-prefix.ts` Test 3, which this change leaves untouched — `metadata` is added at the
   provider layer, never in `systemPrompt`.)
3. **Resolver determinism, separation & golden vector.** Same `(pepper, groupId)` → identical output across
   calls; two different `groupId`s → different outputs; output matches `/^[a-f0-9]{64}$/` (⇒ satisfies
   `[a-zA-Z0-9\-_]+` and ≤ 512). **Plus a golden-vector assertion:** for a fixed pepper and a fixed
   `groupId`, `resolveIsolationScopeId` equals a **precomputed hex constant**. This is the *only* assertion
   that pins the exact hashed input — the domain tag AND the `:` separator (space or no space) — against a
   known value; the determinism checks above only prove self-consistency and would pass even if the tag or
   separator were wrong. Compute the constant once and hardcode it, e.g.
   `node -e "console.log(require('crypto').createHmac('sha256','<fixed-pepper>').update('isolation-scope:<fixed-uuid>').digest('hex'))"`.
   If a future edit changes the tag or the separator, this test fails loudly instead of silently orphaning
   every previously-issued id.
4. **Resolver fail-fast.** Throws when `APP_HMAC_PEPPER` is unset/empty (throw originates in `pepperedHmac`);
   throws when `groupId` is empty/missing (throw originates in the wrapper guard).
5. **Abort-before-provider.** In `answerQuestion` and `recapConversation`, when the resolver throws (pepper
   unset), assert `provider.callModel` and `logModelCall` are **never invoked** and the error propagates.
   Proves the guard runs before anything reaches the wire. Because the resolver sits above `buildContext`,
   this test needs **no seeded fixtures and must not touch the DB** — if it stands up entities/groups to
   run, the resolver was placed after `buildContext` instead of before it. The test must **save / delete /
   restore** `process.env.APP_HMAC_PEPPER` locally (try/finally) so unsetting it does not leak into other
   tests.
6. **Logging + spread order.** `logModelCall` writes `metadata.isolationScopeId` equal to the resolved id
   and `metadata.isolationScopeType === "group"`. Additionally, given a `result.raw` containing colliding
   keys (e.g. `raw: { isolationScopeId: 'X', requestId: 'Y' }`), assert the **controlled** values win —
   exercising the spread-first ordering, not assuming it.
7. **DeepSeek compat accepts `metadata` (live check).** A live call to the compat endpoint carrying
   `metadata.user_id` returns 2xx (no unknown-field rejection). Manual/scripted live check like the ones
   that pinned `SPEC-deepseek-provider.md`, not a unit test — record the observed result in the
   implementation report. (Already run: `POST …/anthropic/v1/messages` with `metadata.user_id` → 200 OK.)
8. **Compile / required-field.** Build passes with the field required. Every existing test constructing a
   `CallModelInput` literal directly is updated to include `isolationScopeId`; **list each one touched** in
   the implementation report (same migration as `cacheable`). Audited literal sites: `lib/capabilities.ts`
   and `scripts/test-deepseek-provider.ts` only — the other harnesses (e.g. `test-prompt-cache-prefix.ts`)
   capture inputs through the mock and construct no literal.
9. **Test-env pepper provisioning.** Every harness that reaches `answerQuestion`/`recapConversation` must
   set `process.env.APP_HMAC_PEPPER` in its setup block (hermetic, like the existing dummy API keys), and
   `.env.local` must carry it too (the suites run with `--env-file=.env.local`, which backstops any harness
   not individually patched). Known callers to patch: `test-telegram-entity-formatting.ts`,
   `test-prompt-cache-prefix.ts`, `test-model-call-logging.ts`, `test-group-scoped-context.ts`,
   `test-platform-bot-security.ts`, `test-edited-message-sync.ts`, `test-deepseek-provider.ts`.

## 7. Config + env

- New env var **`APP_HMAC_PEPPER`**, read in `lib/isolation.ts`; the app fails fast if unset. Named
  generically on purpose: it is a **shared application HMAC secret**, not isolation-specific — a future
  `message_log` PII hasher (`telegram_user_id` / `username`) will reuse the same secret under its own
  domain tag (§1.10). Each domain prefixes its message; the secret itself is one value.
- Add to `.env.example` (placeholder + comment stating the app fails fast when unset) and `.env.local` (real
  value — David sets it).
- Value: high-entropy random string (≥ 32 bytes). **Stable — rotate rarely.** Rotating resets **all** HMAC
  domains at once — every group's KVCache partition and content-safety identity, and (once built) every
  hashed PII value — and makes previously-logged `isolationScopeId` values non-re-derivable from
  `group_id`, which is exactly why the value is logged (§5.3). The resolver's throw is the enforcement
  point (consistent with `DeepSeekProvider` throwing on a missing key at construction).

## 8. What this deliberately does NOT do

- **No per-human user isolation.** Rejected: sacrifices DeepSeek KVCache reuse (everyone in a group sees
  identical docs) and does not contain intra-tenant abuse — that is the app-side per-user throttle's job,
  not the provider `user_id`'s. `isolationScopeId` contains **inter-tenant** blast radius; the throttle
  contains **intra-tenant / per-human**. Different layers.
- **No `message_log` PII hasher.** The `APP_HMAC_PEPPER` naming, the domain-separation contract (§1.10), and
  the shared `pepperedHmac` primitive *shape* (§2) are settled now to avoid a future rename/refactor, but
  hashing `telegram_user_id` / `username` in `message_log` is a separate, later feature with its own spec.
  That spec adds its own wrapper (its own domain tag, e.g. `'tg-user'`) and, at that point, promotes
  `pepperedHmac` from module-private to a shared module. Do **not** add that wrapper or promote the
  primitive now.
- **No entity/DM fallback scope.** Deferred ("requires a group for now"). Revisit when DMs / purpose-bots
  without a group appear; a dual-tier resolver would fragment one tenant's cache/rate-limit identity across
  paths. `isolationScopeType` exists to make that future migration legible.
- **No billing / token accounting.** Separate; rolls up via `model_calls.entity_id` (providers offer no
  per-`user_id` balances). When built, meter on a per-`(provider, model)` price table over the separate
  `input`/`output`/`cache_read`/`cache_creation` token columns — never a blended token count (cache
  read/write multipliers differ, and DeepSeek's `cache_creation_tokens` is always 0).
- **No app-side per-user throttle, no bot-sharding.** Separate deferred seams.
- **No Gemini `labels` mapping.** No Gemini provider exists yet; the neutral field is provider-agnostic, so
  a future Gemini provider maps `isolationScopeId` → `labels`.
- **No `CallModelResult` change, no mock-seam change, no `model_calls` schema/migration/backfill.**

## 9. Handoff notes for Antigravity

- One new file (`lib/isolation.ts`); edits to `lib/model.ts` (one field), both providers (one line each),
  and `lib/capabilities.ts` (resolve at top of both callers, thread into `callModel` + `logModelCall`,
  spread-order fix + two metadata keys). Plus `.env.example`.
- The resolver is the **single producer** — nothing else may synthesize a `user_id`, and there is no
  fallback value. If it can't produce an id, the call must not go out.
- The two failure modes most likely to pass a shallow test while being wrong: (a) the resolver value never
  actually reaches `metadata.user_id` on the SDK call, and (b) `metadata` silently busts the Anthropic cache
  by landing inside the cached block. §6.1 and §6.2 exist specifically to catch these — implement them as
  **fetch-boundary** request-body assertions (real `Response`, host-routed, no active mock), not
  return-value or `setMockCallModel` assertions. See Addendum B.
- Keep the domain separation structural: `pepperedHmac(domain, message)` is the only place that reads the
  pepper and applies the `:` join; `resolveIsolationScopeId` is a thin wrapper passing `'isolation-scope'`.
  The golden-vector test (§6.3) is what pins the exact construction — do not skip it. See Addendum C.
- **Live-verify** the DeepSeek compat endpoint accepts `metadata.user_id` (§6.7) before treating this as
  done; per `SPEC-deepseek-provider.md`, live behavior wins over the doc. (Already confirmed: 200 OK.)
- Do not touch recap's model selection, `CallModelResult`, the mock seam, or the `model_calls` schema.

---

## Addenda (change log)

Changes after the initial spec, recorded here so the evolution is traceable rather than silently folded in.

### Addendum A — `APP_HMAC_PEPPER` naming + domain separation (2026-07-07)
Applied to: header (Rigor bar, one-line scope), §1.3, §1.10 (new), §2 resolver, §6.4, §6.9, §7, §8.

The pepper env var was renamed `ISOLATION_SCOPE_PEPPER` → **`APP_HMAC_PEPPER`** after deciding the secret
should be shared across future HMAC uses — specifically obfuscating `message_log` `telegram_user_id` /
`username` so a database-level attacker can't map messages to senders. Binding the name to the first use
would have repeated the vestigial-naming trap of `entities.telegram_bot_username`. Consequence baked in:
because one secret now keys multiple domains, every use MUST domain-separate its HMAC input with a fixed
prefix (`"isolation-scope:"` here) so identical raw values in different domains cannot collide to the same
hash. The resolver therefore hashes `"isolation-scope:" + groupId`, not bare `groupId`. Rotating the pepper
resets all domains at once. The `message_log` PII hasher itself remains out of scope (§8); only the naming
and the domain-separation contract are settled now.

### Addendum B — Test infrastructure for the non-hollow assertions (2026-07-07)
Applied to: §6.1, §6.2, §6.5, §6.8–6.9, §9, header (Rigor bar), §1.9; and (post-implementation)
`lib/providers/anthropic.ts`.

Surfaced while reviewing Antigravity's implementation plan against the real harness. The headline test
(§6.1) cannot use `setMockCallModel` — that seam short-circuits at `callModel`, so `messages.create` never
runs and any assertion there is hollow. It must intercept `global.fetch` with **no active mock**, and the
interception MUST return a real `Response` object (`status` + `headers.get` + `json`), not the minimal
`{ ok, json, text }` shape the existing Telegram mock uses — the Anthropic SDK (both providers) reads
`response.headers.get(...)` and will otherwise throw into the provider's catch, tempting a fallback to the
hollow mock. The fetch mock must also route by host so `sendMessage` tests keep their behavior. Also
recorded: the fail-fast resolver throws in the hot path, so every harness reaching
`answerQuestion`/`recapConversation` must provision `APP_HMAC_PEPPER` (§6.9); the earlier "suite passes
unmodified" expectation (§1.9, Rigor bar) was corrected accordingly.

**Post-implementation deviation (surfaced during adversarial review of the built code).** To make the
§6.1 fetch-boundary test possible, the shipped implementation changed `lib/providers/anthropic.ts` from a
module-level `const anthropic = new Anthropic(...)` to a lazily-constructed singleton
(`getAnthropicInstance()`). This was necessary and not anticipated by the spec: the Anthropic SDK binds
`fetch` at client construction, so a module-level client built at import time captures the real `fetch`
before a test can install its `global.fetch` override — leaving the wire assertion unable to intercept the
request. Deferring construction to first `callModel` means the client is built after the override is in
place. The change is behavior-preserving: same cached singleton and same `dummy-key` fallback; only the
missing-`ANTHROPIC_API_KEY` warning moves from import time to first call. `lib/providers/deepseek.ts` did
**not** need the same treatment — its SDK client is built in the `DeepSeekProvider` constructor, and the
provider itself is instantiated lazily via the `model.ts` singleton, which already runs after the override.
Verified correct in adversarial review of the shipped code.

### Addendum C — Shared `pepperedHmac` primitive + wrapper factoring (2026-07-07)
Applied to: §1.3, §1.10, §2 (resolver rewrite), §6.3 (golden vector), §6.4, §8, §9.

Refactor of §2's resolver, prompted by the separator-drift risk (a future author baking a different colon /
space / var into a copied hasher, silently). Instead of inlining the domain prefix as a per-function string
literal, the module now defines a **module-private `pepperedHmac(domain, message)`** primitive that owns the
pepper read, the fail-fast, the HMAC algorithm, and the `:` separator; `resolveIsolationScopeId` is a thin
wrapper supplying the `'isolation-scope'` tag plus its own `groupId` guard. **Behavior is unchanged** — the
hashed message is still `"isolation-scope:" + groupId`, so produced hashes are byte-identical to the prior
spec; this is purely structural. The point is to make the "same pepper, same algorithm, same separator"
invariant hold in one place ahead of the future `message_log` hasher, which will add its own wrapper and
promote the primitive to a shared module in *its* spec (§8) — not now. Rejected the fuller "hasher
interface" alternative: the call sites are concrete and static (no runtime dispatch), so an interface would
be indirection with no consumer and would bury the domain tag behind a class name rather than surfacing it
as a grep-able argument. Also added a **golden-vector test** (§6.3): the one assertion that actually catches
a tag/separator mistake, which the determinism checks do not.
