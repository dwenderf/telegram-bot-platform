# SPEC — Fix Provider/Format Mismatch: `outputFormat` Drives the Prompt (not just the converter)

> **Reads against:** `lib/model.ts` (`ModelProvider.outputFormat`, `resolveProvider`),
> `lib/capabilities.ts` (`answerQuestion`, `recapConversation`, `renderModelOutput`, and the inline
> `defaultPersona` / recap `systemPrompt` format-rules blocks), and both providers
> (`lib/providers/anthropic.ts`, `lib/providers/deepseek.ts`).
> **Rigor bar:** the empirical gate that was MISSING last time — verify the assembled system prompt's
> format-rules block matches the provider's `outputFormat`, and that a Markdown-emitting model renders
> correctly end-to-end through the Markdown path. Live-verified root cause (below) drives the design.
> **One-line scope:** make the system-prompt's format-rules block **derived from the provider's
> `outputFormat`** (via a `formatRulesFor(outputFormat)` helper), so the format we *ask the model for*
> matches the format we *convert with*. Today they contradict: the prompt hardcodes HTML for every
> provider, but DeepSeek's `outputFormat` is `'markdown'`, so DeepSeek's (prompt-obeying) HTML output is
> fed to the Markdown converter and renders as literal tags.

> **Sequencing:** self-contained fix. Touches `capabilities.ts` (prompt assembly + new helper) and adds
> comments to `capabilities.ts` and `model.ts`. No migration, no dependency changes, no `sendMessage`
> change, no provider-logic change.

---

## 0. Root cause (live-verified — do not re-derive from assumption)

The entity-formatting feature added `outputFormat` per provider (Anthropic `'html'`, DeepSeek
`'markdown'`) to select the converter (`htmlToFormattable` vs `markdownToFormattable`). But the **system
prompt independently hardcodes an HTML format instruction for ALL providers** (the "OUTPUT FORMAT
RULES: Use Telegram-HTML format... `<b>`, `<i>`..." block, present in both `answerQuestion`'s
`defaultPersona` and `recapConversation`'s `systemPrompt`).

Result: a contradiction. DeepSeek (`outputFormat: 'markdown'`) is *told to emit HTML*. When it obeys
(observed live — literal `<b>...</b>` tags rendered in Telegram), its HTML is fed to
`markdownToFormattable`, which **passes HTML through as literal text** (empirically confirmed:
`markdownToFormattable('<b>x</b>')` → text `"<b>x</b>"`, entities `[]`). When DeepSeek instead emits
Markdown (its natural tendency, also observed), the Markdown converter works. So the pipeline only
worked when the model *disobeyed* the prompt — unstable and backwards.

**Empirical findings (from probing `@gramio/format`), authoritative over any assumption:**
- `markdownToFormattable` handles Markdown into entities; passes HTML through **literal** (no entities).
- `htmlToFormattable` handles HTML into entities; passes Markdown through **literal** (no entities).
- They are clean mirror images: **neither converter is robust to the other's format.** So no single
  converter "absorbs both" — the format the model emits genuinely must match the converter, which means
  it must match what the prompt asks for.

**Fix principle:** `outputFormat` becomes the **single source of truth** that drives BOTH (a) the
format-rules instruction injected into the system prompt AND (b) the converter selection (already the
case). Prompt and converter can no longer drift because both derive from the one field.

## 1. `formatRulesFor(outputFormat)` helper (`lib/capabilities.ts`)

Add a helper returning the format-rules block for a given `outputFormat`:

```ts
function formatRulesFor(outputFormat: 'markdown' | 'html'): string { ... }
```

- **`'html'`** → the CURRENT HTML rules block, verbatim (preserves Anthropic's working behavior):
  "Use Telegram-HTML format. ONLY these tags: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`,
  `<a href="...">`. Use `• ` for bullets. No `<p>`, `<ul>`, `<li>`, `<h1>`, `<div>`. Escape literal
  `<`, `>`, `&`."
- **`'markdown'`** → a **minimal** block. Deliberately terse — the model knows standard Markdown; over-
  specifying syntax invites more errors and bloats the cached prefix. Content:
  - "Use standard Markdown for formatting."
  - "Do NOT use HTML tags." ← **the load-bearing clause** — this is what suppresses the format-leak
    (DeepSeek emitting `<b>` because the old prompt asked for it). Without it, the model drifts back to
    HTML and the tags render literal.
  - Use `• ` (or `-`) for bullet points. *(Keep a bullet note, matching the HTML block's parity; bullets
    render fine as literal chars either way.)*
  - **NO escaping instructions.** Under entity-based sending there is no HTML parser, so `<`, `>`, `&`
    are ordinary characters needing no escaping. An escape instruction here would make the model emit
    literal `&lt;` / `&amp;`. Omit entirely. (This makes the Markdown block simpler than the HTML one —
    a tell that the entity model removed the escaping burden.)

## 2. Separate format rules from persona; assemble prompt from `outputFormat`

Currently the HTML rules are baked *inside* `defaultPersona`. Pull them OUT so the format contract is
always `outputFormat`-derived and cannot be contradicted by (or omitted from) a custom persona.

### 2.1 `answerQuestion`
- `defaultPersona` becomes **role/behavior only** — remove its embedded "OUTPUT FORMAT RULES" block.
- Resolve the provider first (it already does: `const provider = resolveProvider(model)`), then assemble:
  ```
  systemPrompt = `${basePersona}\n\n${formatRulesFor(provider.outputFormat)}\n\nPROJECT CONTEXT:\n${contextDocs}`
  ```
  where `basePersona = input.persona || defaultPersona` (persona WITHOUT format rules).
- **Consequence (intended):** a custom `input.persona` no longer needs to — and should not — include
  format rules; the `outputFormat`-derived block is always appended. This closes the drift hole where a
  custom persona could specify a format contradicting `outputFormat`. (Confirmed with the operator:
  only one bot today, no custom persona with embedded format rules, so no live persona is affected.)

### 2.2 `recapConversation`
- Same treatment: the recap `systemPrompt`'s summarizer text stays, but its embedded "OUTPUT FORMAT
  RULES" block is replaced by `formatRulesFor(provider.outputFormat)`. Resolve the provider before
  building the prompt (recap already calls `resolveProvider(model)` — move the format-rules assembly to
  use `provider.outputFormat`).

### 2.3 Placement matters for caching — keep format rules in the SYSTEM prompt
- Format rules go in `systemPrompt` (the stable, cacheable prefix — `answerQuestion` passes
  `cacheable: true`), NOT in `userMessage`. They are stable per provider (don't change call-to-call),
  so they belong in the cached prefix. **Do not move format rules into `userMessage`** — that would
  churn the prefix and break cache-stability. (Recap passes `cacheable: false`, so it's indifferent, but
  keep the structure identical for consistency.)

## 3. Provider `outputFormat` values — BOTH providers set to `'markdown'`

**Both `AnthropicProvider` and `DeepSeekProvider` get `outputFormat: 'markdown'`.**

- **DeepSeek** → `'markdown'` → Markdown prompt (§1) → emits Markdown → `markdownToFormattable`.
  **Fixes the observed bug.**
- **Anthropic** → changed from `'html'` to `'markdown'` → Markdown prompt → `markdownToFormattable`.

**Why both on markdown (corrected rationale):**
- The earlier "Anthropic works, don't touch it" reasoning was based on the OLD pipeline
  (`sanitizeForTelegramHtml` + `parse_mode: HTML`), which no longer runs on these paths. Under the NEW
  entity pipeline, Anthropic's HTML would flow through `htmlToFormattable` — a path that has **never run
  against real Anthropic production traffic**. So "Anthropic works on HTML" is now an *assumption*, not
  an established fact. Neither format path is production-verified; there is no proven-working path to
  preserve.
- **Markdown is the safer, simpler format.** `markdownToFormattable` degrades gracefully (malformed
  Markdown → plain text, never breaks the send — empirically confirmed). Markdown has far less
  structural surface to mishandle than HTML (no attributes, nesting rules, tag-matching, or entity
  escaping). Standardizing on the more forgiving format is a robustness win.
- **Models emit Markdown more reliably** (their default tendency — empirically confirmed), so BOTH
  providers asked for Markdown comply more consistently than either asked for HTML.
- (The marginally lighter token weight of `**` vs `<b></b>` is real but negligible — not a reason.)

**Consequence to note:** Anthropic's `htmlToFormattable` path goes **dormant in production** — its
correctness now rests on unit tests, not live traffic. That is acceptable: it is the flexibility seam
(`outputFormat` + the helper) kept for a future HTML-native provider, still unit-tested, just unused. If
a provider is ever set back to `'html'`, that path must be **live-verified at that point** (it will have
no production mileage). See §5 comments.

## 4. What this deliberately does NOT do

- **No change to `sendMessage`, the entity conversion, `renderModelOutput`, or the providers'
  `callModel`.** The converter selection via `outputFormat` already works; this fix only aligns the
  *prompt* to the same field.
- **No format-detection / auto-sniffing fallback.** Stray wrong-format tags (a model occasionally
  leaking an HTML tag under a Markdown prompt) degrade to a single literal span, not a broken message
  (empirically: mixed input renders the matching-format parts and passes the rest literal). Operator
  confirmed this is non-urgent and not anticipated to matter. Deferred; build only if measurement ever
  shows it's needed.
- **No dependency, migration, or schema change.**
- **No format-rules content beyond the minimal Markdown block and the retained HTML block** — the HTML
  block stays defined in `formatRulesFor` (for the flexibility seam) even though no provider uses it in
  production now.
- **No new doc** (backlog/vision/deployment/readme). The rationale lives as CODE COMMENTS (§5).

## 5. Rationale comments (the agreed documentation home)

The intent isn't backlog/vision/deployment/readme material — it's implementation rationale, so it lives
at the code:
- On `formatRulesFor` (and/or where the system prompt is assembled) in `capabilities.ts`: a comment
  stating that **`outputFormat` drives BOTH the prompt's format instruction AND the converter, and the
  two MUST stay in lockstep** — noting the original bug (prompt hardcoded HTML while `outputFormat` was
  markdown → HTML output fed to the markdown converter → literal tags). Note that **both providers
  currently run `'markdown'`** (safer/simpler converter + more reliable model compliance); the `'html'`
  path and rules block are retained as a flexibility seam but are **unit-tested only, not
  production-exercised** — live-verify the html path if a provider is ever set back to `'html'`.
- On `ModelProvider.outputFormat` in `model.ts`: a short comment noting the field governs **both** the
  format instruction injected into the system prompt AND the converter selection — not just the
  converter — so a future provider (or prompt editor) sees the field is authoritative and must not
  hand-tune format in prompt text.

## 6. Tests

Add/extend a harness (e.g. extend `test-telegram-entity-formatting.ts` or the model-call harness):

1. **Prompt reflects outputFormat.** With a provider/mock of `outputFormat: 'markdown'`, the assembled
   `systemPrompt` contains the Markdown rules ("Use standard Markdown", "Do NOT use HTML tags") and
   does **NOT** contain the HTML rules block. With `outputFormat: 'html'`, the reverse. (Assert on the
   `systemPrompt` the provider receives — capture via the mock's `input.systemPrompt`.)
2. **End-to-end markdown render (the regression the bug needed).** A Markdown model response
   (`**bold** and *italic*`) through the DeepSeek (`markdown`) path yields plain text + correct bold/
   italic entities (no literal `**`).
3. **HTML rules block + `htmlToFormattable` still correct at the UNIT level.** Even though no provider
   runs `'html'` in production now, assert (a) `formatRulesFor('html')` returns the HTML rules block, and
   (b) `htmlToFormattable` on a representative HTML string yields correct entities — keeping the retained
   flexibility seam verified. (Not an end-to-end/production path anymore — unit coverage only.)
4. **Format rules not in userMessage.** Assert the format-rules text is in `systemPrompt`, not
   `userMessage` (cache-stability guard).
5. **Custom persona still gets format rules.** With a custom `input.persona` that contains NO format
   rules, the assembled `systemPrompt` still includes the `outputFormat`-derived rules block (proves
   the separation in §2.1 works — format rules are always appended regardless of persona).
6. **Existing suite passes unmodified.** Note: the `resolveProvider` mock wrapper returns
   `outputFormat: 'markdown'`, so mocked tests resolve to the Markdown rules — existing assertions are
   format-agnostic (e.g. "summarizing a team chat conversation") so they still pass, but any NEW
   assertion on format-rule content must account for the mock being markdown.

## 7. Handoff notes for Antigravity

- **Add `formatRulesFor(outputFormat)`** in `capabilities.ts`: HTML block = current rules verbatim;
  Markdown block = minimal ("Use standard Markdown.", "Do NOT use HTML tags.", a bullet note, **no
  escaping instructions**).
- **Pull the format-rules block OUT of `defaultPersona`** and out of the recap `systemPrompt`; assemble
  both prompts as `persona/summarizer-text + formatRulesFor(provider.outputFormat) + context`. Resolve
  the provider before building the prompt.
- **Format rules stay in `systemPrompt`** (cacheable prefix), never `userMessage`.
- **Do NOT change** provider `outputFormat` values, `sendMessage`, `renderModelOutput`, converters,
  providers' `callModel`, or add detection.
- **Add the two rationale comments** (§5) — `capabilities.ts` (lockstep + bug story) and `model.ts`
  (field governs prompt AND converter).
- **Tests** assert the prompt reflects `outputFormat` (§6.1), markdown renders end-to-end (§6.2), html
  still works (§6.3), rules are in systemPrompt not userMessage (§6.4), and custom persona still gets
  rules (§6.5).
