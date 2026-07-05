# SPEC — DeepSeek Provider (second `ModelProvider`)

> **Reads against:** `lib/model.ts` (`ModelProvider`, `CallModelInput`, `CallModelResult`,
> `resolveProvider`), `lib/providers/anthropic.ts` (the reference provider — DeepSeek mirrors its
> parsing), `lib/capabilities.ts` (`logModelCall`, callers), `lib/config.ts` (env access pattern),
> and `DEPLOYMENT.md`.
> **Rigor bar:** the provider abstraction's contract is behavior-preserving; this ADDS a provider
> without touching the Anthropic path. Existing suite passes unmodified; new tests assert DeepSeek's
> parsing + the resolver routing.
> **One-line scope:** add a `DeepSeekProvider` (second concrete `ModelProvider`) targeting DeepSeek's
> **Anthropic-compatible** endpoint, with `thinking` hardcoded off, so `MODEL_IDENTIFIER=deepseek-v4-*`
> routes traffic to DeepSeek for a large cost reduction. Prefix-match resolver; global swap; Anthropic
> stays one env-var away.

> **Sequencing:** build after the provider abstraction (already shipped). Self-contained: one new
> provider file, a resolver branch, one env var, a DEPLOYMENT.md section, tests.

---

## 0. Why + how the design was pinned

Cost: DeepSeek is materially cheaper than Anthropic (flash: ~$0.14/M input, ~$0.28/M output; pro ~3×
that) — the motivation is letting more testers use the platform without cost pain. The provider
abstraction (`SPEC-model-provider-abstraction.md`) exists precisely so this is "add a provider," not a
rewrite.

**Every behavior below was pinned by live API calls, not docs** — and the live tests corrected the docs
three times, so treat the response shapes here as authoritative over any DeepSeek doc text:

1. **DeepSeek's Anthropic-compat endpoint normalizes the response into Anthropic's shape.** A live call
   to `https://api.deepseek.com/anthropic/v1/messages` returned `usage: { input_tokens,
   cache_creation_input_tokens, cache_read_input_tokens, output_tokens }` — **Anthropic's field names**,
   NOT DeepSeek's native `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`. So the compat layer does
   the mapping for us; **DeepSeek usage parsing is identical to `AnthropicProvider`.** (An earlier plan
   to map `prompt_cache_miss_tokens → input_tokens` would have been WRONG for this endpoint — those
   native fields don't appear on the compat response. This is why we tested.)
2. **`model` and `stop_reason` come back Anthropic-shaped** — `"model":"deepseek-v4-flash"` (served
   model, truthful) and `"stop_reason":"end_turn"` (Anthropic vocabulary). Parse exactly like Anthropic.
3. **Thinking is ON by default and returns a leading `thinking` content block** — but **`{"thinking":
   {"type":"disabled"}}` in the Anthropic-format request body IS honored by the compat layer** (verified
   live: with it, the response `content` has only a `text` block and `output_tokens` dropped from ~96 to
   ~36). The compat layer passes this field through even though DeepSeek's docs list no Anthropic-format
   toggle for it.
4. **`cache_creation_input_tokens` is always 0 for DeepSeek** (automatic disk caching has no distinct
   write event). This is correct, not a bug.

---

## 1. `lib/providers/deepseek.ts` — the provider

`DeepSeekProvider implements ModelProvider`, `name = 'deepseek'`. Mirror `AnthropicProvider`'s
structure; the differences are enumerated below and each carries a code comment explaining *why*.

### 1.1 Construction / auth
- Reads `DEEPSEEK_API_KEY` (new env var). Auth at construction, per the `ModelProvider` principle;
  the request contract stays credential-free.
- Base URL `https://api.deepseek.com/anthropic`. Since it's Anthropic-compatible, use the **Anthropic
  SDK client** pointed at this `baseURL` with the DeepSeek key (same SDK the Anthropic provider uses).
  The URL is internal to this provider — **no `MODEL_BASE_URL` env var.**

### 1.2 Request construction (differences from Anthropic, each commented)
- **Hardcode `thinking: { type: 'disabled' }`** in the request. *Comment:* workload is doc-grounded
  Q&A + recaps (non-reasoning); reasoning tokens bill as output, so thinking is pure cost overhead
  here. Verified the compat layer honors this field. (Two-variant thinking/non-thinking split is
  deferred — see `VISION.md` Surface 2 and §5.)
- **Do NOT attach `cache_control` and do NOT send the `anthropic-beta` prompt-caching header.** DeepSeek
  ignores both (its caching is automatic); omit them for a clean request. *Comment:* DeepSeek caching is
  automatic/prefix-based; the `cacheable` claim is not actionable here.
- **Ignore `input.cacheable`.** *Comment:* it's a claim about the input's cacheability; DeepSeek's
  automatic caching doesn't act on a per-request marker, so the provider reads the claim and does
  nothing with it — this is the neutral-contract design working, not a gap.
- **Send native DeepSeek model IDs** (`deepseek-v4-flash` / `deepseek-v4-pro`) exactly as received in
  `input.model` — never Claude names relying on DeepSeek's `claude-*`→deepseek auto-mapping. The
  prefix-match resolver (§2) guarantees only `deepseek-*` strings reach this provider, keeping
  `response.model` truthful in the ledger.
- Same `max_tokens` handling as Anthropic (`getModelMaxOutputTokens()`), same system + messages shape.

### 1.3 Response parsing
- **Usage: identical field names to `AnthropicProvider`** — `input_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `output_tokens`, with the same `|| 0` fallbacks, mapped into the
  neutral `CallModelResult.usage` (`input_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
  `output_tokens`). *Comment:* the compat endpoint returns Anthropic-shaped usage;
  `cache_creation_tokens` will always be 0 for DeepSeek (automatic caching, no write event) — expected,
  not a bug.
- **Reply text: find the `text`-type content block; do NOT read `content[0]` positionally.** *Comment:*
  even with thinking disabled today, extracting by type is robust — if a response ever includes a
  leading `thinking` block (config change, effort setting, model that reasons anyway), positional
  `content[0]` would return empty text. Locate the block where `block.type === 'text'`.
- **`stopReason` ← `response.stop_reason`, `model` ← `response.model`** — Anthropic-shaped on the compat
  endpoint; parse as Anthropic does.
- Same error handling as `AnthropicProvider`.

---

## 2. `resolveProvider` — prefix-match routing (`lib/model.ts`)

Upgrade the stub (currently returns Anthropic unconditionally, ignoring `modelName`) to a prefix match:

- `modelName` starts with `deepseek` → `DeepSeekProvider`.
- otherwise (incl. `claude-*`, and the null/undefined default) → `AnthropicProvider`.

*Rationale:* DeepSeek models are named `deepseek-*`, Anthropic `claude-*`, so the prefix is a natural
discriminator — **and** it's a safety property: a `claude-*` string can only ever reach the real
Anthropic endpoint, structurally preventing "a Claude name silently served by DeepSeek via
auto-mapping." Mock interception stays exactly as it is (if a global mock is set, return the mock
wrapper before this branch — do not change that path).

No lookup table, no per-bot/per-call selection, no routing beyond this prefix match (§5).

---

## 3. Config + env

- **New env var `DEEPSEEK_API_KEY`**, read by `DeepSeekProvider` at construction. Add it to
  `.env.example` (commented "required only when using a DeepSeek model") and to the required-config
  validator **conditionally** — it is NOT unconditionally required (Anthropic-only deployments don't
  need it). Simplest correct approach: the DeepSeek provider fails fast at construction if
  `DEEPSEEK_API_KEY` is unset, so a deployment only needs it when `MODEL_IDENTIFIER` is a `deepseek-*`
  model. Do NOT add it to the global required-config gate (that would force it on Anthropic-only setups).
- `MODEL_IDENTIFIER` unchanged in mechanism — set it to `deepseek-v4-flash` (or `-pro`) to route to
  DeepSeek; the prefix-match resolver does the rest. **Flash-vs-pro is a pure env swap, no code change.**

---

## 4. DEPLOYMENT.md — model/provider operations

Add a section documenting the operator model, since there's now more than one provider:

- **Switching the active model/provider = config only.** Set `MODEL_IDENTIFIER` (`claude-sonnet-5`,
  `deepseek-v4-flash`, `deepseek-v4-pro`). The resolver routes by prefix. To use DeepSeek, also set
  `DEEPSEEK_API_KEY`. Reverting to Anthropic is a one-var change.
- **Adding a NEW provider = code, not config.** A new provider is a new `lib/providers/<x>.ts`
  implementing `ModelProvider` + a `resolveProvider` branch + its own key env var. Document this
  distinction explicitly so future-me doesn't expect a brand-new provider to be pure config.
- **Data-governance note (flag, not a task):** routing production traffic to DeepSeek sends tenant
  content (incl. live HYS legal/financial discussions) to DeepSeek's API. That is a deliberate
  data-handling decision — review DeepSeek's terms/privacy posture before flipping `MODEL_IDENTIFIER`
  to a DeepSeek model in production. (Test/dev calls with dummy content are unaffected.)

---

## 5. What this deliberately does NOT do

- **No thinking/effort configurability.** `thinking: disabled` is hardcoded. The thinking-on variant,
  when needed, becomes a **distinct provider/model the resolver routes to** — NOT an env knob. See
  `VISION.md` Surface 2 ("Model behavior is provider/model identity, not shared config").
- **No per-provider behavior env vars** (`DEEPSEEK_THINKING`, `DEEPSEEK_EFFORT`, …) — explicitly the
  anti-pattern (VISION).
- **No model→provider lookup table, no per-bot/per-tenant model selection, no routing beyond prefix
  match.** The `resolveProvider(modelName)` seam anticipates that future; this spec does not build it.
- **No `MODEL_BASE_URL` env** — each provider's URL is internal to it.
- **No change to `AnthropicProvider`, the neutral contract, callers' `cacheable` values, or the
  `model_calls` schema.** Adding a provider must not touch the Anthropic path.
- **No native (OpenAI-format) DeepSeek endpoint.** The Anthropic-compat endpoint is sufficient (thinking
  is controllable through it, verified). The native endpoint is not needed.

---

## 6. Tests (`scripts/test-deepseek-provider.ts`, plus resolver coverage)

DeepSeek's real API isn't hit in unit tests; assert the provider's parsing against **mock DeepSeek
compat responses** (shaped like the real ones captured live) and the resolver's routing directly.

1. **Usage maps correctly.** Given a mock compat response with `usage: { input_tokens: N,
   cache_read_input_tokens: R, cache_creation_input_tokens: 0, output_tokens: O }`, assert the
   `CallModelResult.usage` has `input_tokens=N`, `cache_read_tokens=R`, `cache_creation_tokens=0`,
   `output_tokens=O`. (Proves the Anthropic-shaped parsing; guards against a native-field regression.)
2. **`cache_creation_tokens` is 0.** Explicitly assert it — documents the expected-zero invariant so a
   future reader doesn't "fix" it.
3. **Text extraction is by type, not position.** Given a mock response whose `content` is
   `[ {type:'thinking',...}, {type:'text', text:'X'} ]`, assert the extracted reply is `'X'` (NOT empty).
   This is the guard for the leading-thinking-block bug — it must pass even though we send
   `thinking:disabled`, because extraction must be robust to a thinking block appearing.
4. **`model` / `stopReason` parse.** Assert `model` and `stopReason` come from the response fields
   (`deepseek-v4-flash`, `end_turn`).
5. **Request omits cache marker + sends thinking:disabled.** Inspect the request the provider builds
   (or mock the SDK call and capture args): assert no `cache_control` / no `anthropic-beta` header, and
   that `thinking: {type:'disabled'}` is present.
6. **Resolver routing.** `resolveProvider('deepseek-v4-flash')` → provider with `name==='deepseek'`;
   `resolveProvider('claude-sonnet-5')` and `resolveProvider(null)` → `name==='anthropic'`. And the mock
   interception still wins when a global mock is set (existing behavior unchanged).
7. **Existing suite passes unmodified** — the Anthropic path and all prior tests are untouched.

---

## 7. Handoff notes for Antigravity

- **New file `lib/providers/deepseek.ts`** mirroring `lib/providers/anthropic.ts`; the only real
  differences are: hardcode `thinking:disabled`, omit cache marker/header, ignore `cacheable`, and the
  text-block-by-type extraction. Usage/model/stop_reason parsing is the **same** as Anthropic (compat
  normalizes to Anthropic's shape — do NOT reach for DeepSeek's native `prompt_cache_*` field names;
  they do not appear on the compat endpoint).
- **`resolveProvider`**: add the `deepseek` prefix branch; leave the mock-interception path exactly as
  is; Anthropic remains the default.
- **`DEEPSEEK_API_KEY`**: new env var, provider fails fast at construction if missing, NOT in the global
  required gate (Anthropic-only deployments must not require it). Add to `.env.example`.
- **DEPLOYMENT.md**: the switch-model (config) vs. add-provider (code) distinction + the DeepSeek
  data-governance flag.
- **Every behavior here is pinned by live API responses** (§0). If an implementation detail seems to
  conflict with DeepSeek's published docs, the live-response shape wins — the compat endpoint behaves
  differently from the native API the docs mostly describe.
- **Do not** build thinking/effort config, a lookup table, routing, or touch the Anthropic path (§5).
