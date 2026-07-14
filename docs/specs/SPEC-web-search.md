# SPEC — Web Search for Mention Answers (DeepSeek server tool)

> **Reads against:** `lib/model.ts` (`CallModelInput` — text-only today: no `tools`/search field;
> `CallModelResult` — no search-usage field), `lib/providers/deepseek.ts` (hardcodes the request body,
> `thinking: { type: 'disabled' }`, and extracts reply via `response.content.find(b => b.type === 'text')`),
> `lib/providers/anthropic.ts` (extracts reply via `response.content[0]`), `lib/capabilities.ts`
> (`answerQuestion` builds the system prompt as `basePersona + formatRulesFor(...) + PROJECT CONTEXT`,
> then `renderModelOutput` via `markdownToFormattable`; `logModelCall` writes `usage` columns + spreads
> `result.raw` into `model_calls.metadata`), and the §14 `isBotMention` "Normal answer flow" block in
> `app/api/webhooks/platform/[botSlug]/route.ts`.
>
> **Rigor bar:** match prior phases. This feature ships **three** things that each need proof: (a) a
> **pre-flight formatter gate** — a golden-vector test proving a real DeepSeek-with-search answer survives
> `markdownToFormattable` (inline `[label](url)` → `text_link` entities; headers/bold degrade sanely);
> (b) a **shared reply-text extraction fix** that is correct under the multi-block search response shape on
> **both** providers; (c) the search attachment itself (provider seam + grounding rule + logging + column).
> Prove the extraction against the real response shape `[thinking, server_tool_use, web_search_tool_result,
> thinking, text]`, not a happy-path single-text-block mock.
>
> **One-line scope:** attach DeepSeek's native `web_search` server tool to the **normal mention-answer
> path** so the bot can ground answers in current web content when the question needs it — with a
> prefer-team-docs grounding rule, inline-markdown-link provenance, a `web_search_requests` metric column,
> and a corrected reply-text extractor. **DeepSeek path only.** Document QA, `/recap`, `/push` untouched.
>
> **Sequencing:** (0) pre-flight formatter gate — must pass before feature code; (1) shared extraction fix
> (both providers); (2) `web_search_requests` column — additive migration; (3) provider search seam
> (`CallModelInput.webSearch`, DeepSeek attaches tool, surfaces count); (4) grounding rule + `answerQuestion`
> wiring; (5) route confirms search rides only the non-document mention path. **One additive migration; no
> destructive DDL.**

---

## 0. Why, and the pre-flight formatter gate

Today a user asks the bot to "look into `<url>` and compare it to our setup" and the bot answers that it
can't reach URLs — which is **correct behavior**: the model has no tool attached, so it can't browse. The
fix is not a model change; it's attaching a tool. DeepSeek's Anthropic-compatible endpoint (which we
already use) supports the `web_search` server tool: the endpoint runs the search server-side and returns
results, all inside a single `messages.create` call (verified — see §8). We are **not** building our own
fetcher (SSRF / malicious-content surface we explicitly declined to own); the provider does the network.

**The gate that must pass before any feature code (§0 is load-bearing).** DeepSeek's search answers embed
provenance as **inline markdown links in the answer prose** (`[TechCrunch](https://techcrunch.com/...)`),
and the structured `citations` field on text blocks is **`null`** (verified — §8). Our render path is
`renderModelOutput` → `markdownToFormattable`. So the entire "does search render correctly in Telegram"
question reduces to: **does `markdownToFormattable` convert the model's inline `[label](url)` (plus the
`###` headers, `**bold**`, and `-` bullets it emits) into a correct `{text, entities}` pair?** This is a
verification gate, not a code change — but if it fails, a formatter fix becomes step zero and the rest of
the spec waits on it.

Write `scripts/test-web-search-formatting.ts` **first**:
- Fixture: a **real** DeepSeek-with-search answer string (the multi-source "AI releases" / ZetaChain
  answer captured during design — paste the actual `text` block; do **not** hand-simplify it, because the
  point is to stress the real dialect: ~10 inline links, `###` headers, `**bold**`, `-`/`•` bullets).
- Feed it through `markdownToFormattable` (the exact function `renderModelOutput` calls for `markdown`).
- Assert: (a) each `[label](url)` becomes a `text_link` entity whose `url` matches and whose covered text
  is `label` (no raw `[label](url)` sludge survives into `.text`); (b) `**bold**` becomes a `bold` entity;
  (c) `###` headers degrade **sanely** — pin whatever the converter actually does (drop the `#`, or bold
  the line) as the golden expectation, and assert no literal `#` leakage that would look broken in-chat.
- This is a **golden-vector** test in the isolation-scope-id / cryptographic-primitive spirit: pin exact
  output, fail loudly on drift.

**Outcomes:** links + bold + headers all convert cleanly → happy path, no formatter work, proceed.
Raw `[label](url)` survives or headers leak `#` → a formatter fix is required **first**, as its own change,
before the search seam rides on top. Either way we know before Antigravity writes feature code.

## 1. Shared reply-text extraction fix (`lib/model.ts` + both providers)

**This is an independently-correct bug fix that search makes load-bearing.** The two providers extract the
answer differently and both are wrong under a tool-augmented response:

- `DeepSeekProvider`: `response.content.find(b => b.type === 'text')` — **first** text block.
- `AnthropicProvider`: `response.content[0]` — **first block**, text or not.

A search response has shape `[thinking, server_tool_use, web_search_tool_result, thinking, text]` (verified
— §8). The answer is the **final** text block(s), after the last tool result. `.find(first text)` gets the
answer **only by luck of ordering** — the moment the model emits a narration text block ("Let me search…")
*before* the tool call, `.find` grabs the narration and silently drops the real answer. `content[0]` breaks
outright (it's a `thinking` or preamble block). This is a **silent wrong-answer** class of bug, not a crash.

**Fix — one shared helper, both providers adopt it** (single source of truth, in your spirit; prevents the
two extractors from drifting again):

```ts
// lib/model.ts (exported, unit-tested)
export function extractReplyText(content: any[]): string {
  if (!Array.isArray(content) || content.length === 0) return '';
  // Prefer text blocks AFTER the last server-tool result (web_search_tool_result / web_fetch_tool_result);
  // if there is no tool result, use all text blocks. Concatenate + trim.
  let startIdx = 0;
  for (let i = content.length - 1; i >= 0; i--) {
    const t = content[i]?.type;
    if (t === 'web_search_tool_result' || t === 'web_fetch_tool_result') { startIdx = i + 1; break; }
  }
  const slice = content.slice(startIdx);
  const texts = (slice.some((b) => b.type === 'text') ? slice : content)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '');
  return texts.join('').trim();
}
```

- Both providers replace their bespoke extraction with `extractReplyText(response.content)`.
- **Correct even without search:** protects against a stray leading `thinking` block on any call, so it's a
  safe standalone change and can be reviewed independently.
- Note `web_fetch_tool_result` is included proactively so the v2 Anthropic path (deferred, §6) inherits the
  correct extractor for free — no behavioral cost today (DeepSeek never emits it).

## 2. `web_search_requests` column (additive migration)

Track search volume as a **first-class metric** (it is also the observability signal for whether `max_uses`
is honored and what search costs — see §3/§8). Not left in `metadata` jsonb, because this is a
metric we will actually aggregate.

Migration `supabase/migrations/<ts>_model_calls_web_search_requests.sql` (idempotent, additive only):

```sql
alter table public.model_calls
  add column if not exists web_search_requests integer not null default 0;
```

- **No backfill** — web search did not exist before this feature, so `0` is truthful for all history.
- **No destructive DDL.** Additive only; safe to re-push (guarded with `if not exists`).
- David applies via `npx supabase db push` (per project rule; Antigravity/specs never run migrations).
- Other call types (`answer` without search, `recap`, `push_naming`, `document_qa`) simply write the
  default `0`.

## 3. Provider search seam (`lib/model.ts`, `lib/providers/deepseek.ts`)

Mirror the existing `document?` capability pattern: an **optional, purpose-built** flag on
`CallModelInput` (not a generic `tools` passthrough — same reasoning as `document?` being purpose-built).

```ts
export interface CallModelInput {
  systemPrompt: string;
  userMessage: string;
  model: string;
  cacheable: boolean;
  isolationScopeId: string;
  document?: { data: string; mediaType: string };
  webSearch?: { maxUses: number };   // NEW, optional — attach web_search server tool
}

export interface CallModelResult {
  text: string;
  usage: { input_tokens; output_tokens; cache_read_tokens; cache_creation_tokens };
  model: string;
  requestId: string | null;
  stopReason: string | null;
  webSearchRequests?: number;        // NEW — surfaced from usage.server_tool_use.web_search_requests
  raw?: Record<string, any>;
}
```

**`DeepSeekProvider.callModel`** — when `input.webSearch` is present, attach the tool to the request:

```ts
tools: [
  { type: 'web_search_20250305', name: 'web_search', max_uses: input.webSearch.maxUses },
]
```

- Tool type string `web_search_20250305` is the verified-working identifier on DeepSeek's endpoint (§8).
  Do **not** send a 2026 version string — DeepSeek's endpoint only supports basic search
  (`web_search_tool_result`); dynamic-filtering versions rely on code execution, which DeepSeek marks
  Not Supported (§8), so they would at best no-op and at worst 400.
- **`thinking: { type: 'disabled' }` stays as-is.** Search responses still returned `thinking` blocks in
  testing despite this; the corrected extractor (§1) skips them. Do not remove the disabled-thinking
  setting as part of this change (blast-radius discipline — it governs recap/push/answer too).
- Surface the count: `webSearchRequests: (response.usage as any).server_tool_use?.web_search_requests ?? 0`.
  If the field is absent on a given response, default `0` (the `web_search_tool_result` block presence is
  the fallback signal, but the usage counter was present in testing — §8).
- Reply text now comes from `extractReplyText(response.content)` (§1).
- **Do not** attach `web_search` on `AnthropicProvider` in this spec — the normal answer path is DeepSeek
  in production, and Anthropic web_search carries a **$10 / 1,000 searches** surcharge plus needs the
  `content[0]` extractor already fixed (§1 handles that). Anthropic search/fetch is the deferred v2 (§6).

## 4. Grounding rule + `answerQuestion` wiring (`lib/capabilities.ts`)

**The grounding rule is the thing that keeps search from diluting the RAG value prop.** This bot answers
from team/pushed documents; unrestricted search must not start answering "what's our refund policy?" from
the open web. And DeepSeek search reliably drags in SEO'd exchange / promotional pages (measured — a
ZetaChain query pulled bitget/binance/coinbase/etc.), so the rule must also steer source weighting.

Add a **dedicated system-prompt block**, appended in `answerQuestion` **independent of `persona`** — it
must survive a custom `bot.persona` (which today replaces `defaultPersona` wholesale), so it cannot live
only inside `defaultPersona`. Put it alongside `formatRulesFor(...)` as its own block:

```ts
// new helper, e.g. groundingRulesFor() or an inline block
const WEB_SEARCH_GROUNDING = `WEB SEARCH GUIDANCE:
- Prefer the team's context documents and recent conversation above. Answer from them when they cover the question.
- Use web search when the question needs current, external, or fast-changing information the context documents do not cover (recent events, prices, releases, "what is <external thing>").
- If a context document conflicts with clearly newer information from search, answer from the newer information and briefly note the discrepancy.
- Weight primary and official sources; treat promotional, exchange-listing, or SEO "what is X" pages as lower-trust context, not authority.
- Cite sources inline as markdown links when you draw on them.`;
```

System prompt becomes: `basePersona + "\n\n" + formatRulesFor(...) + "\n\n" + WEB_SEARCH_GROUNDING + "\n\nPROJECT CONTEXT:\n" + contextDocs`.

Then pass the flag through `answerQuestion`:

```ts
const result = await provider.callModel({
  systemPrompt,
  userMessage,
  model,
  cacheable: true,
  isolationScopeId,
  webSearch: { maxUses: 5 },   // see §3 note on max_uses semantics
});
```

- **`cacheable: true` is retained.** The system prompt prefix (persona + rules + PROJECT CONTEXT) is still
  the cacheable stable prefix; DeepSeek caching is automatic/prefix-based and unaffected by the tool array.
- `logModelCall` gains `web_search_requests` from `result.webSearchRequests` (§2). `call_type` stays
  `'answer'` (no new enum value — search is a property of an answer, not a new call type).

**`max_uses` semantics (write this down so it isn't misread):** `max_uses` bounds the number of **search
iterations**, **not** the number of sources returned (one search returned ~10 sources in testing while
`web_search_requests` was `1`). Its enforcement on DeepSeek is **unverified** (DeepSeek ignored
`allowed_domains`, so it may ignore this too); it is included as a **harmless-if-ignored cost guardrail**
against a runaway multi-search turn. The real cost/observability signal is the `web_search_requests`
column (§2). Value **5** — enough for a genuine multi-entity comparison, capped against a pathological
fan-out. (Per-heavy-search cost measured ~$0.002 at DeepSeek flash input pricing, so this is a tail-bound,
not a primary cost lever.)

## 5. Route integration (`route.ts`, §14 mention/answer block)

**Minimal change; search rides only the normal (non-document) mention-answer branch.** In the
`isBotMention` handler, the existing branch is `const targetDoc = message.document ?? message.reply_to_message?.document;`
→ if `targetDoc` present, document QA (untouched); else "Normal answer flow" calling `answerQuestion`.

- **No route logic change is strictly required** if `answerQuestion` always sets `webSearch` internally.
  Preferred: `answerQuestion` owns the `webSearch: { maxUses: 5 }` default (§4), so the route stays
  byte-identical and search is simply on for every normal answer. The model's own `auto` tool-choice
  decides whether to actually search (it won't search greetings/doc-answerable questions — verified
  behavior: baseline recency question answered from training without the tool, searched with it).
- **Document path stays search-free.** `answerAboutDocument` is a different function and is not touched;
  it must not gain `webSearch`. (Document reads route to Anthropic and are isolated by design.)
- **Trigger = option 1 (always attach on normal mention-answers), confirmed.** URL-gating was considered
  and rejected: DeepSeek search ignores the specific URL and searches keywords anyway (measured), so
  URL-gating would add branching for no fidelity gain while suppressing search on URL-free "what's the
  latest X" questions.

> **Note for the follow-on reply-to-bot spec (separate, not built here):** a planned next feature makes
> *replying to a bot message* (no mention needed) also trigger an answer, injecting the replied-to text
> into context even when it has aged out of `buildContext`'s recent-message window. That spec will add its
> trigger as an additional condition where `isBotMention` is evaluated (**after** all command checks, so
> `/push`-on-a-reply still wins), and will reuse this same `answerQuestion` + `webSearch` path unchanged.
> Called out so the two specs are visibly linked; **this spec does not depend on it.**

## 6. What this deliberately does NOT do

- **No Anthropic web_search or web_fetch (deferred v2, premium tier).** On the Anthropic path,
  `web_search` supports **enforced** `allowed_domains` (domain-scoped subpage traversal), structured
  `web_search_result_location` citations, and dynamic filtering on sonnet-5; `web_fetch` reads an exact
  URL with the provider owning the fetch. These are a **complementary precision tier** (exact-page /
  domain-scoped reads), not an upgrade to this feature — and they carry the $10/1k search surcharge. They
  **depend on** the §1 extraction fix shipping first (Anthropic `content[0]` breaks under tools). Their own
  spec. Framing to preserve: DeepSeek search = breadth ("what does the world say about X"); Anthropic
  fetch/scoped-search = precision ("read *this* page / stay on *this* domain").
- **No domain scoping in v1.** DeepSeek ignores `allowed_domains` (verified — it returned off-domain
  exchange/news sources for a domain-restricted request). Do not add it expecting enforcement.
- **No 2026 web_search tool versions on DeepSeek.** Dynamic filtering / `response_inclusion` require code
  execution, which DeepSeek does not support; they cannot engage on this endpoint.
- **No reply-to-bot trigger** (separate spec, §5 note).
- **No structured-citation handling.** DeepSeek returns `citations: null`; provenance is the model's inline
  markdown links (rendered by the existing markdown converter) plus the `title`/`url` list in the
  `web_search_tool_result` block. No "Sources:" footer is built in v1 (the inline links are the provenance);
  if desired later it is assembled from the result block, not parsed out of the answer text.
- **No search on `/recap`, `/push`, `/context`, or document QA.** Search is scoped to normal
  mention-answers only.
- **No new `call_type`.** Search is a property of an `'answer'` call.

## 7. Tests

Pre-flight (blocks everything — `scripts/test-web-search-formatting.ts`):
1. **Formatter golden vector.** Real DeepSeek-with-search answer (multi-link, headers, bold, bullets)
   through `markdownToFormattable`: assert `[label](url)` → `text_link` entities (url + covered text
   correct, no raw markdown in `.text`), `**bold**` → `bold` entity, `###` headers degrade to the pinned
   expectation with no literal `#` leakage. Golden-vector style: exact output pinned.

Extraction (`scripts/test-reply-extraction.ts` or fold into provider tests):
2. **Multi-block search shape.** `extractReplyText([thinking, server_tool_use, web_search_tool_result,
   thinking, text('ANSWER')])` → `'ANSWER'`.
3. **Narration-before-tool.** `extractReplyText([text('Let me search…'), server_tool_use,
   web_search_tool_result, text('ANSWER')])` → `'ANSWER'` (proves we don't grab the narration — the exact
   case the old `.find(first text)` failed).
4. **Multiple trailing text blocks** are concatenated + trimmed.
5. **No-tool regression.** `extractReplyText([text('HELLO')])` → `'HELLO'`; leading `thinking` skipped.
6. Both providers now call `extractReplyText` (assert via a mocked response with the multi-block shape that
   each provider returns the final answer, not a preamble).

Provider seam (`scripts/test-web-search-provider.ts`, intercept the SDK/`fetch`):
7. **Tool attached when requested.** `DeepSeekProvider.callModel({ …, webSearch: { maxUses: 5 } })` →
   outgoing request `tools` contains `{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }`.
8. **No tool when absent.** Without `webSearch`, no `tools` in the request (regression).
9. **Count surfaced.** A mocked response with `usage.server_tool_use.web_search_requests = 2` →
   `result.webSearchRequests === 2`; absent → `0`.
10. **`thinking: disabled` unchanged** on both search and non-search DeepSeek calls.

Capability + logging (mock `callModel`):
11. **Grounding block present & persona-independent.** `answerQuestion` with default persona AND with a
    custom `bot.persona` → system prompt contains the WEB SEARCH GUIDANCE block in **both** cases, and the
    `webSearch` flag is passed. Assert PROJECT CONTEXT still present and format rules intact.
12. **Column written.** After an answer whose `result.webSearchRequests = 3`, the `model_calls` row has
    `web_search_requests = 3`; a non-search `answer`/`recap`/`push_naming`/`document_qa` writes `0`.
    (Clean up seeded rows in `finally`; no `DROP`.)

Route (real `Response` at the `fetch` boundary; mock model + `sendMessage`):
13. **Search rides normal answers.** Mention with a plain question → `answerQuestion` invoked with
    `webSearch` set; answer sent.
14. **Document path unaffected.** Mention replying to a PDF → document QA path (Anthropic, no `webSearch`);
    assert `answerAboutDocument` used and no `webSearch` flag anywhere on that path.

## 8. Handoff notes for Antigravity (verified facts — pin them)

- **DeepSeek endpoint supports `web_search` as a server tool** (verified live against
  `https://api.deepseek.com/anthropic`): a call with `tools: [{ type: 'web_search_20250305', name:
  'web_search', max_uses: N }]` returns content shaped `[thinking, server_tool_use, web_search_tool_result,
  thinking, text]`, `stop_reason: 'end_turn'`, in a **single** `messages.create` call (no `pause_turn`
  loop to build). `usage.server_tool_use.web_search_requests` is present (was `1` on single-search runs).
- **Citations are `null`** on DeepSeek text blocks; provenance is (a) inline markdown links in the answer
  prose and (b) the `title`/`url` array inside the `web_search_tool_result` block (each entry also carries
  an opaque `encrypted_content` — ignore it). This is why §0's formatter gate is about markdown-link
  conversion, not structured-citation handling.
- **`web_search_20250305` is the working type string** on DeepSeek. **Do not** send 2026 versions:
  DeepSeek's compat matrix marks `code_execution_tool_result` **Not Supported**, and dynamic filtering runs
  *inside* code execution — so 2026 search versions cannot engage here (best case no-op, worst case 400).
- **`allowed_domains` is NOT honored by DeepSeek** (verified: a request with `allowed_domains:
  ['zetachain.com']` returned bitget/binance/coinbase/etc.). Do not add it. Enforced domain scoping is an
  Anthropic-only capability (deferred v2).
- **`max_uses` bounds search *iterations*, not sources** (one search → ~10 sources; `web_search_requests`
  = 1). Enforcement on DeepSeek is unverified; include it as a harmless cost guardrail (`5`), and rely on
  the `web_search_requests` column for actual observability.
- **Cost:** DeepSeek web_search has **no per-search surcharge** — only token cost for the injected results
  (~5k–15k input tokens on a heavy search; ~$0.002 at flash input pricing). (Contrast: Anthropic
  web_search is $10/1k searches — relevant only to the deferred v2.)
- **Extraction fix is mandatory and independently correct.** Both providers must use `extractReplyText`
  (§1). The old `content.find(first text)` / `content[0]` are silent-wrong-answer bugs under tool
  responses. Include `web_fetch_tool_result` in the "last tool result" scan so v2 inherits it.
- **Grounding rule must be persona-independent** — appended as its own block, not inside `defaultPersona`,
  because `bot.persona` replaces the default persona wholesale.
- **Schema:** one additive, idempotent migration adding `model_calls.web_search_requests integer not null
  default 0`. No backfill, no destructive DDL. **David runs `npx supabase db push`** — the spec/Antigravity
  must not include a migration-application step, and must not run `supabase db push` (AGENTS.md Rule 8).
- **Build order:** (0) formatter gate passes → (1) `extractReplyText` + both providers adopt → (2)
  migration (David applies) → (3) `CallModelInput.webSearch` + `CallModelResult.webSearchRequests` +
  DeepSeek attaches tool/surfaces count → (4) grounding block + `answerQuestion` passes `webSearch` +
  `logModelCall` writes column → (5) route confirmation tests. Anthropic provider is **not** given
  web_search in this spec.
- **Blast radius:** do not alter `thinking: disabled`; do not touch `answerAboutDocument`, `recap`,
  `push`, or the document mention branch; keep `cacheable: true` on the normal answer path.

---

*End of SPEC — Web Search for Mention Answers*
