# SPEC — Model Provider Abstraction (`ModelProvider` interface)

> **Reads against:** `lib/anthropic.ts` (`callModel`, `CallModelInput`, `CallModelResult`,
> `setMockCallModel`), `lib/capabilities.ts` (`answerQuestion`, `recapConversation`, `logModelCall`,
> and the `import { callModel, CallModelResult } from './anthropic'` line), and every test that uses
> `setMockCallModel`.
> **Rigor bar:** this is a **behavior-preserving refactor**. The acceptance bar is that the **existing
> test suite passes UNMODIFIED** — a refactor that requires editing behavior tests to pass is, by
> definition, not behavior-preserving.
> **One-line scope:** extract the model call behind a `ModelProvider` interface with Anthropic as the
> sole concrete provider, so a future second provider (e.g. DeepSeek) is an addition rather than a
> rewrite — and so provider-specific concerns (caching mechanics, usage-field parsing, provider name)
> live *inside* the provider. No second provider, no routing, no DeepSeek in this spec.

> **Sequencing:** do this before adding any second provider. Pure refactor; ship independently.

---

## 0. Why

`callModel` lives in `lib/anthropic.ts` and bakes in Anthropic-specific behavior that a base-URL env var
could not abstract: the `cache_control: { type: 'ephemeral' }` marker, the
`anthropic-beta: prompt-caching-2024-07-31` header, `(response.usage as any).cache_read_input_tokens`
field access, and `ANTHROPIC_API_KEY`. Providers differ in **behavior**, not just endpoint — a second
provider requests caching differently (or automatically), reports usage in different fields, and uses
its own credentials/URL. An env var can only change the URL and *assume the rest is identical*; an
interface lets each provider own its own request-building and response-parsing. That is the correct
place for provider-specific behavior.

Two things the interface fixes **for the current single-provider codebase**, independent of any second
provider:
- `model_calls.provider` is the hardcoded literal `'anthropic'` in `logModelCall`. It should be sourced
  from the resolved provider, so it stays truthful the moment traffic ever goes elsewhere.
- Usage parsing is Anthropic-specific (`as any` casts). Making it the provider's responsibility is
  cleaner today and mandatory the day a second provider reports usage differently.

This also lands the `/recap`-should-not-cache change (previously specced standalone) as a natural part
of the neutral contract — via a `cacheable` claim (§2.2) — so it is **not** designed twice.

## 1. Structure (settled)

- **`lib/model.ts`** — the neutral contract: `ModelProvider` interface, `CallModelInput`,
  `CallModelResult`, and the provider **resolver**.
- **`lib/providers/anthropic.ts`** — the `AnthropicProvider` implementation (today's `callModel` body).
- Future providers (e.g. `lib/providers/deepseek.ts`) follow this pattern. **Not in this spec.**

## 2. The neutral contract (`lib/model.ts`)

### 2.1 Types

- `CallModelResult` — **unchanged shape** from today (`text`, `usage {input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens}`, `model`, `requestId`, `stopReason`, `raw?`). Moves here
  from `anthropic.ts`. Its *population* becomes each provider's responsibility (each provider parses its
  own usage fields into these neutral columns).
- `CallModelInput` — today's `{ systemPrompt, userMessage, model }` **plus** `cacheable: boolean`
  (§2.2). Provider-neutral: no Anthropic-specific fields.

### 2.2 `cacheable` — a claim, not a command

`cacheable: boolean` is a **factual claim by the caller about the input**: "this prompt has a reusable
prefix worth caching." It is **not** a request for a specific caching behavior. The caller states the
truth about its input; the **provider** decides what to do with that truth:
- `AnthropicProvider`: `cacheable: true` ⇒ attach `cache_control` marker (+ beta header);
  `cacheable: false` ⇒ omit the marker, send the **same** system prompt as a plain text block.
- A future provider may honor it differently or ignore it entirely (e.g. if its caching is automatic).
  The caller neither knows nor cares.

Callers:
- `answerQuestion` passes `cacheable: true` (large stable doc-context prefix — genuinely cacheable).
- `recapConversation` passes `cacheable: false` (one-off transcript, no reusable prefix — genuinely not
  cacheable). This is a *truer* statement than "disable caching for recap," and yields the same result.

**Disabling caching = omit the marker only.** The full system prompt is still sent. Never drop/empty
the system block. (Misreading this would strip recap's formatting/faithfulness instructions.)

### 2.3 `ModelProvider` interface + resolver

- `interface ModelProvider { readonly name: string; callModel(input: CallModelInput): Promise<CallModelResult>; }`
  - `name` is the provider identity (e.g. `'anthropic'`) — this is what populates `model_calls.provider`.
- **Resolver:** a function that returns a `ModelProvider`. **v1 returns `AnthropicProvider`
  unconditionally** — a one-line stub with the *shape* to later consult a model→provider lookup table,
  but **no table, no routing, no per-call/per-bot selection now.** (The lookup-table + routing is the
  deferred future that this seam enables; explicitly out — §5.)

### 2.4 Mock seam — preserve it UNCHANGED

Today `setMockCallModel(mock)` swaps the whole `callModel`. Every test relies on this. The refactor
**must keep the existing `setMockCallModel` call sites working without edits.** Cleanest: keep the mock
mechanism at the `callModel` boundary (a mock provider or a mock hook the resolver/provider honors), so
existing `setMockCallModel(...)` usage in tests compiles and behaves identically. **Do not re-architect
the mock in a way that forces test rewrites** — test churn would obscure the "unchanged tests pass"
acceptance bar.

## 3. The Anthropic provider (`lib/providers/anthropic.ts`)

- `AnthropicProvider implements ModelProvider`, `name = 'anthropic'`.
- Its `callModel` is **today's `callModel` body, behavior-identical**, except:
  - Reads `input.cacheable` to attach or omit `cache_control` (+ beta header) per §2.2. For the current
    answer path (`cacheable: true`) the request is **byte-identical** to today.
  - Parses Anthropic's usage fields (`cache_read_input_tokens`, `cache_creation_input_tokens`) into the
    neutral `CallModelResult.usage` — same parsing as today, just owned here.
- Keeps reading `ANTHROPIC_API_KEY` and the SDK default base URL. **No `MODEL_BASE_URL` env** — the URL
  is an internal detail of this provider, and there is only one provider, so there is nothing to
  externalize (§5).

## 4. Caller + ledger wiring (`lib/capabilities.ts`)

- Replace `import { callModel, CallModelResult } from './anthropic'` with imports from `./model` (types +
  resolver). Call the model via the resolved provider instead of the free `callModel`.
- `answerQuestion`: pass `cacheable: true`.
- `recapConversation`: pass `cacheable: false`.
- **`logModelCall`:** replace the hardcoded `'anthropic'` literal in the insert with the **resolved
  provider's `name`**. For the only provider today this still writes `'anthropic'` — so existing rows are
  unchanged in value, just sourced honestly. (The neatest wiring: `logModelCall` receives the provider
  name, or the result carries it. Implementer's choice, but `provider` must come from the provider, not
  a literal.)

## 5. What this deliberately does NOT do

- **No DeepSeek / no second provider.** The whole point is that everything behaves exactly as before with
  only Anthropic present.
- **No routing / no per-bot / no per-call model selection.** Resolver returns Anthropic unconditionally.
- **No model→provider lookup table** as real data. The resolver is a stub with room to grow.
- **No `MODEL_BASE_URL` env** (URL is internal to the provider; §3). No new provider env vars.
- **No behavior change to the answer path.** `cacheable: true` must reproduce today's request byte-for-
  byte (marker + header + usage parsing identical).
- **No prompt changes** (answer or recap).
- **No `model_calls` schema change.** `provider` column already exists; only its *source* changes.

## 6. Tests

**Primary acceptance bar: the entire existing suite passes UNMODIFIED** —
`test-model-call-logging.ts`, `test-prompt-cache-prefix.ts`, `test-edited-message-sync.ts`,
`test-platform-bot-security.ts`, `test-group-scoped-context.ts`, `test-group-linking.ts`,
`test-management-rls.ts`, plus `npm run check:scripts` and `npm run build`. If any existing test needed
editing to pass, the refactor changed behavior — investigate rather than edit the test. The
`setMockCallModel` seam (§2.4) is what makes this hold.

New assertions (extend `test-model-call-logging.ts` / recap coverage):
1. **Answer path still caches.** `answerQuestion` (default) produces a request with `cache_control`
   present / and (via the existing prompt-cache test) real cache hits still occur. Guards the caching
   fix we already shipped against a polarity/default regression.
2. **Recap omits the marker.** `recapConversation` sends `cacheable: false` ⇒ no `cache_control` on the
   system block ⇒ recap rows show `cache_creation_tokens = 0`, `cache_read_tokens = 0`.
3. **Recap prompt intact.** The recap call's `systemPrompt` is non-empty and still contains the
   summarizer/formatting instructions (guards "omit marker" ≠ "drop system block").
4. **`provider` derives correctly.** `model_calls.provider` is still `'anthropic'` on new rows — proving
   the value now comes from the provider's `name` and equals the prior literal (no regression).

## 7. Handoff notes for Antigravity

- **This is a refactor, not a feature.** The success criterion is "everything works exactly as before."
  Reproduce the current Anthropic request byte-for-byte on the `cacheable: true` path.
- **Move** `CallModelInput`/`CallModelResult` to `lib/model.ts`; **implement** `AnthropicProvider` in
  `lib/providers/anthropic.ts` from the current `callModel` body; **add** the `ModelProvider` interface +
  a stub resolver (returns Anthropic always) in `lib/model.ts`.
- **Preserve `setMockCallModel` unchanged** so existing tests need no edits (§2.4). This is the crux —
  if tests need rewriting, the seam was moved wrong.
- **Wire `cacheable`:** `true` in `answerQuestion`, `false` in `recapConversation`; Anthropic provider
  attaches/omits the marker accordingly.
- **`model_calls.provider`** from `provider.name`, not the `'anthropic'` literal.
- **Out of scope, do not build:** DeepSeek, routing, the lookup table, per-bot/per-call selection,
  `MODEL_BASE_URL`. Resolver is a stub.
- Update the old standalone recap-cache spec's intent is subsumed here — do not also implement a separate
  `enableCache` boolean; `cacheable` replaces it.
