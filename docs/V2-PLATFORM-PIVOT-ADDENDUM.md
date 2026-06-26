# V2 Platform Pivot — Addendum (Session 2 Deltas)

> **Purpose:** capture the decisions made in the second planning session and bind them to the
> sections of `V2-PLATFORM-PIVOT.md` they amend. This is a **delta document** — each entry says
> which brief section it changes and how. Merge into the brief or keep alongside it; either way the
> brief should not be read without these deltas.
>
> **Status of the headline fork (§4):** unchanged — model **(C)**, platform-owned bot(s), `bots`
> first-class. This session *reinforces* that choice (see Δ1) and does not reopen it.

---

## Δ0. New: target customer (ICP) — resolves open question §10.2

The brief left the customer open ("is there a design-partner tenant…"). Session 2 fixes the ICP:

- **Beachhead:** Telegram-native, international, **web3-skewing** communities and teams. They already
  live in Telegram; the bot is a feature inside the place they work, not a new app to adopt.
- **Broader plain:** small-to-medium orgs for whom **Slack is overkill** — per-seat enterprise
  pricing and admin overhead are disproportionate to a 5–20 person shop, especially outside the US.
- **Why defensible:** the platform and the customer are both terrain Anthropic is structurally
  uninterested in (see Δ1). The web3 slice additionally unlocks crypto payment rails (Δ4).

This ICP is now the lens for prioritisation; "build for Telegram-native non-enterprise teams" beats
"build for everyone."

---

## Δ1. New: competitive context — Claude Tag (Slack), launched 2026-06-23

Anthropic shipped **Claude Tag** — a shared, persistent `@Claude` teammate inside Slack channels
(multiplayer single identity, channel-scoped memory, admin-set tool/data access, **activity logs**,
**per-channel/org token spend limits**). It is gated behind **Claude Enterprise/Team** seats and its
expansion roadmap points at **enterprise workplace platforms (Teams next), not Telegram**.

Implications for this project:

- **Validation, not threat (for our ICP).** Anthropic, building the same category greenfield, chose
  **one shared platform-owned identity** — i.e. our model (C). The §4.1 "branding-as-distribution"
  argument is the same bet Anthropic just made publicly. Stop second-guessing the fork.
- **Free reference design for the management plane.** Their admin surface — per-scope permissions,
  activity logs, token spend limits per scope — is the de-facto "table stakes" list. Two items move
  from "deferred seam" toward "expected": **activity logs** and **spend limits**. Keep them deferred
  for the *build* (still post-v1) but design the schema so they're cheap to add, and treat them as
  known launch expectations rather than novelties.
- **Where we are genuinely different:** Telegram vs Slack/enterprise; **curated knowledge-base
  grounding** (`manifest_entries` → `doc_cache`) vs ambient channel-reading; and **membership-gated
  knowledge tiers** riding on the existing token-gating ecosystem (Δ2/Δ3).

---

## Δ2. Amends §9 + §7: promote **group-scoped context (read path)** into v1

The brief deferred all group-scoping. Session 2 **splits the two things called "group scope"** and
promotes only the first:

- **Group-scoped *context* (PROMOTED to v1):** which documents the bot draws on, per group. This is
  the **already-present but unused `group-scope` column on `manifest_entries`**. The read path —
  resolve context by `group_id` — is nearly free because the handler already resolves by `chat_id`.
- **Group-scoped *authorization* (STAYS deferred, per §9):** which web admin may manage which group.
  Unchanged. Do not pull this forward.

**Shape to lock (so the spec can't drift):**
- Resolution is by `group_id` off the existing `manifest_entries` column.
- `null` group_id = entity-wide (preserves today's behaviour; single-group entities untouched).
- **Confidentiality is enforced by *inclusion at retrieval*, never by instructing the model.**
- Rationale for promotion: it is the **headline differentiator** vs Claude Tag, and the structure
  already exists, so the change is additive and small. The management *UI* for assigning docs to
  groups rides on the entity-context UI the pivot owes anyway.

**This is a deliberate edit to the §9 scope line**, made because the ICP (Δ0) makes membership-gated
knowledge tiers central rather than an edge case (e.g. public group → general docs; token-holders
group → premium docs; core group → internal docs — gating handled externally by Collab.Land /
Guild.xyz; knowledge-scoping handled by us).

**Build sequencing:** group-scoped context is **Phase 4** (depends on the group↔entity binding that
Phase 2 establishes). See `docs/specs/SPEC-phase-1-management-plane.md` §0 for the phase map.

---

## Δ3. New (refines Δ2): **section-level sensitivity** via withhold-before-assembly

A document may contain both public and restricted spans. Mark restricted spans with metadata; the
**application filters spans at assembly time** based on the requesting group's scope, so restricted
text never enters the prompt for an unauthorised group.

**The bright line (non-negotiable in the spec):**
- ✅ **Enforce on the input-assembly side.** The tag drives whether a span is *placed in the prompt
  at all*. Unauthorised → the span is omitted before the model is called. Injection-proof because the
  data is not present.
- ❌ **Never enforce on the output side.** Do **not** ship tagged text into the window and rely on the
  model to "not reveal" it — that loses to injection/coaxing/translation/summarisation.
- ❌ **Never rely on output filtering / redaction** of generated text — that is probabilistic DLP, not
  a boundary.

**Implementation guardrails:**
1. Tags are **retrieval metadata keyed on `group_id`**, evaluated at chunk-selection, **default-deny
   on ambiguous scope**.
2. **Strip the tags before assembly** — the model must not see even the markers (residual markers add
   noise and *advertise* that withheld content exists).
3. The access check happens at **selection, never generation**. Never place two groups' tiers in one
   prompt and trust the model to keep them apart.

**Cost flagged honestly:** this adds a small surface to the ingestion/authoring pipeline (someone or
an auto-classifier applies the tags; editing them becomes part of the context-management UI). Cheap,
but real — not free. **Phase 4.**

---

## Δ4. New: **monetization framing** (amends §9, which deferred billing as "not technical")

Still **deferred for v1 build** — but these are *framing* decisions worth fixing now because they are
cheap to get right early and expensive to unwind later.

- **Sell the product, not tokens.** "Bulk-buy API tokens at a discount and resell" is the prohibited
  resale/service-bureau pattern under Anthropic's Commercial Terms (and the subscription-arbitrage
  variant was actively enforced in early 2026). We are a **value-add product** (knowledge-base
  grounding, multi-tenant RLS, multi-group entity model, onboarding), not a thin proxy. Pay per-token
  as **COGS**, price on value. Aggregate spend earns volume pricing as a normal customer; a formal
  reseller agreement is a later, negotiated, scale-gated path — not self-serve.
- **Stay non-custodial (architecture decided now).** KYC/AML obligations trigger on **what you do
  with funds** (custody / transmit / convert), **not on volume**. Keep processors who already hold the
  licenses as the regulated party: **Stripe as merchant of record** for cards; a **licensed crypto
  PSP** for stablecoins. The moment we self-custody stablecoins or run our own fiat↔crypto conversion,
  we become the regulated entity at any size. *(Not legal advice — confirm with counsel before taking
  a dollar; the point is the architectural fork is cheap to get right up front.)*
- **Closed-loop, single-purpose prepaid credits** are the model — redeemable only for our services,
  non-transferable, never cashable-out. The load-bearing property is *closed-loop + single-purpose*,
  **not** "non-refundable." (Note: truly non-refundable / expiring balances can collide with consumer
  law in the EU, Brazil's CDC, and parts of the US — separate problem from custody.)
- **Prepaid balances/top-ups kill the fixed-fee drag.** A $10 charge eats ~5.9% to Stripe's
  $0.30 + ~2.9%, mostly the flat $0.30. Let users top up (e.g. $50) and draw down, so the fixed fee is
  amortised. Helps *both* rails.
- **Rails split by cohort:** stablecoins for the web3 cohort (chargeback-free is a feature for them);
  **cards/Stripe** for everyone else (chargeback *protection* is a feature for them). Honest flip
  side of crypto: irreversibility means we own every fat-finger/wrong-chain support case.
- **Chains: multi-chain, not single.** **BASE** (cheap) + **Ethereum** (most widely used) as the EVM
  pair; do not lock to one. Gas is *variable*, not cheap — budget for gas-war spikes, and note
  ERC-20 (USDT/USDC) transfers cost more gas than a bare-ETH transfer.
- **Billing needs a verified email** → reinforces the **magic-link-first** auth decision (Phase 1 §2):
  receipts, billing statements, and credit-balance notices all require a verified address.

---

## Δ5. New: **provider-agnostic inference seam** (v1-cheap) + Bittensor/Chutes (north-star)

- **v1 note (cheap, mostly already true):** keep inference behind a **single swappable seam** (the
  `answerQuestion` chokepoint). Because we assemble and push full context every call, the backend is
  not load-bearing for our value — this is good engineering and cheap insurance. The **Fable
  suspension** is the cautionary tale: anyone built on a single provider's specific model got
  deplatformed by directive overnight.
- **North-star partnership:** **Bittensor / Chutes** for inference is worth exploring (warm
  connection; ecosystem courting builders; potentially much cheaper COGS for the $10-top-up cohort).
  **Evaluate empirically** on **quality, latency, and privacy** before depending on it. Likely
  landing: a **hybrid that routes by sensitivity and difficulty** (frontier for sensitive/hard, cheap
  decentralized for public/cost-sensitive), not an all-in switch. The same group-scope/sensitivity
  work (Δ2/Δ3) is what lets us route *sensitive* tiers away from permissionless compute.
- **Not v1 build.** Seam now; integration later.

---

## Δ6. Parked threads (carried forward with their flags)

- **TON / Telegram `@wallet`** as a stablecoin rail — most ICP-native option (pay without leaving
  Telegram; USDT is native on TON). **Folds into the chain/rails discussion (Δ4).** Flag to carry in:
  **check Telegram's Stars / Bot Payments (IAP) policy** — selling digital credits inside a bot may
  trip Telegram's in-app-purchase rules; whether `@wallet`/external-TON sidesteps that is exactly the
  kind of thing that bites post-launch.
- **Inclusive-vs-exclusive scoping detail (Δ2/Δ3)** — agreed to design in more depth later; the
  cross-group leak test (Δ7) keeps us honest in the interim.

---

## Δ7. New adversarial test class (adds to §11.7 review scope)

**Cross-group context leakage.** In addition to the existing cross-entity / privilege-escalation /
claim-code-replay tests:

- The context resolver returns **nothing** outside the requesting group's scope.
- Prompt injection / coaxing / "ignore the sensitivity markers" cannot cross the boundary.
- Sensitivity tags are **stripped pre-assembly**; no markers reach the model.
- **Default-deny** on ambiguous scope.

---

## Open decisions still to resolve

1. **Default scope of an unassigned doc (gates Δ2/Δ3 design, a Phase-4 concern):**
   entity-wide-by-default (friendlier, matches today) **vs** default-deny (safer for "keep sensitive
   data out of the wrong group"). Cannot cleanly have both. *Parked.*
2. **Auth surface — RESOLVED (2026-06-25):** magic-link-first; passkeys are an additive fast-follow
   (Phase 1.5). A verified email is also a **billing prerequisite** (transactional email / credit
   balances, Δ4), so magic-link-first unblocks monetization, not just auth.
3. **Hosted-only first, or self-host in parallel?** (unchanged from §10.1) — still open.
