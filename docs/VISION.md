# VISION — North-Star Direction (NOT a roadmap)

> **What this is:** a place to capture where the platform *could* go — the larger shape the
> architecture is quietly pointing toward. **What this is NOT:** a plan, a backlog, or a commitment.
>
> **How to use it:** when a near-term design decision comes up, check it against this doc with one
> question — *"does this foreclose a direction we want to keep open?"* If no, proceed; if yes, find
> the cheap seam that keeps the door open. This doc gates against **foreclosure**. It does not pull
> work forward. The discipline that built Phases 1–3 holds: **build the seam, defer the complexity
> until the seam is actually needed.** A compelling vision is the most dangerous source of scope creep;
> this doc is allowed to be ambitious precisely *because* it is firewalled from the build plan.
>
> Concrete, buildable, user-signal-backed items live in `BACKLOG.md`. Active work lives in
> `docs/specs/`. This doc is the compass, not the map.

---

## The shape: a content + capability platform with an open integration layer

The system began as "a Telegram bot that answers questions grounded in a team's documents." The
architecture has been built — deliberately — so it can become something larger: **a platform where
the content sources, the answering capabilities, and the integration plumbing are all extensible,
increasingly by third parties rather than only by us.**

The moat shifts accordingly: from *"our bot is good"* to *"our ecosystem is where the best
connectors and skills live."* That is the same logic as an app store — the platform's value is the
ecosystem it hosts, not any single first-party feature.

### Sphere of focus: what *we* build vs. what the ecosystem builds (refined 2026-06-30)

The boundary is **soft, not hard** — and the realistic early posture matters:

- **Our core sphere = infrastructure + interface + docs.** The durable platform investment is (a) the
  **base platform** (the bot, context resolution, the management plane), (b) the **web interface** for
  direct, beginner-friendly content/management (the easiest on-ramp — manually edit context in the
  UI), and (c) the **MCP/API integration layer + solid documentation** (Surface 3) that makes the
  whole thing extensible. This is where effort concentrates.
- **Connectors are *for* others — but we seed the first ones.** "Others build connectors" is **not**
  something to expect early; an ecosystem doesn't materialize on day one. So near-term **we build basic
  reference connectors ourselves** to (1) give users day-one utility and (2) serve as worked examples
  others improve on later. The connector is utility-now *and* the reference implementation. Over time,
  as the interface matures, connector-building shifts outward — but we prime the pump.
- **First connector = GitHub.** Chosen over Notion because the GitHub-sync framework already partly
  exists (dormant adapter code) and a git repo is a far simpler document source to reason about than
  Notion's block model. GitHub is both the easier build and the cleaner reference example.
- **Implication for priorities:** the *interface* (Surface 3) and the *web content UI* are core and
  near-term; *connectors* (Surface 1, incl. Notion) are "build a reference one to unblock users, but
  the long tail is ecosystem work." This nudges the platform/interface ahead of any individual
  connector in importance — the connector is a means to validate and seed the interface, not the
  destination.

Three distinct extensibility surfaces, each with its own seam already partly in place:

### Surface 1 — Content sources (connectors)
*"Where does an entity's knowledge come from?"*

- **Today:** content is pushed directly into `doc_cache` via SQL (DEPLOYMENT.md Part B). The store is
  abstracted — `doc_cache` is a cache/store the answer path reads, decoupled from where content
  originates.
- **Direction:** sources plug in and **dynamically sync** into the same cache — GitHub, Google Drive,
  **Notion**, others. The answer path never changes; only ingestion does.
- **The open turn:** we don't have to build every connector. If there's a clean **ingestion
  interface**, third parties build connectors (someone builds Notion, someone builds Git) that sync
  their source into the cache. We provide the plumbing + the cache; connectors are an ecosystem.
- **Seam already planted:** the store abstraction (cache decoupled from source); the dormant GitHub
  sync code as a reference sync-source.
- **User signal:** a prospective user (2026-06-29) keeps his content in **Notion** and has struggled
  to get comparable tools working because of it — validating both the abstraction and the specific
  near-term value of a Notion sync-source.

### Surface 2 — Bots / skills (the bot store)
*"What can answer, and with what capabilities?"*

- **Today:** one platform bot (`@leguan_the_bot`), default model/persona. The `bots` table is
  first-class and decoupled from entities, with `persona` / `model` / `capabilities` stub columns.
- **Direction:** specialized bots with their own skills, model sources, and personas — addressed by
  @mention like experts ("ask the researcher, ask the adversary"). Each is a `bots` row; @mention is
  the natural per-bot addressing in a multi-bot group.
- **Two phases, distinct (refined 2026-06-29):**
  1. **Private / permissioned custom bots — the bot-store MVP.** A user brings a bot with their own
     skills (and possibly their own model source / document source), gated to a **whitelist** of
     authorized users/groups. **No commerce, no public listing, no submission review at scale.** Just
     "register a bot config + gate access." This is the *simpler, earlier* product and it has a real
     user (see below).
  2. **Public marketplace — later.** Listing, discovery, monetization layered on top of the same
     `bots` foundation. The private version is the infrastructure; the marketplace is a commerce +
     discovery layer added on top of a thing that already works privately.
- **Seams already planted:** `bots.persona/model/capabilities` (the registered-backend seam);
  **`bot_entities`** (the deliberately-unused authorization seam — *this is the whitelist mechanism*
  for permissioned private bots).
- **User signal:** a collaborator (2026-06-29) wants his own AI skills usable by him and the people he
  works with — explicitly *not* to sell, but to use privately with a permissioned group. Maps cleanly
  onto the `bots` config columns + `bot_entities` gating — three pre-planted seams converging on one
  real external need.
- **Onboarding invariant (load-bearing):** the **consumer** path (add bot, `/auth`, done) stays fully
  self-service forever. The **submitter** path (register a specialized bot) is curated/manual by
  design at low volume — the human gate is a feature (quality + trust + credential review), borne by
  the submitter, never the consumer.
- **The mechanism that makes this genuinely open — the `ModelProvider` boundary + `RemoteProvider`.**
  The model-call path is being abstracted behind a `ModelProvider` interface
  (`docs/specs/SPEC-model-provider-abstraction.md`): a provider owns its own auth and behavior, while
  the request contract (`CallModelInput`) carries only *what to ask* — prompt, model, a `cacheable`
  claim — never credentials. The powerful consequence for the bot store: an external bot's capability
  can run **entirely on the submitter's own endpoint**, behind a `RemoteProvider` we construct locally
  around a scoped, short-lived token they mint. From our side it is *still just a `ModelProvider`* — we
  send a request, get a result, log usage. **We never see, host, or need to understand what runs on
  their side.** They can layer arbitrary skills — their own model, RAG, tool-using agents, proprietary
  logic — behind that boundary, and it plugs in without our involvement. *This is the difference
  between a curated plugin system (we must vet/host every skill — we are the bottleneck) and an actual
  open ecosystem (others extend the platform through a boundary we control but do not peer behind).*
  It is the mechanical reason Surface 2 can become open rather than internal.
- **The same boundary is where trust discipline concentrates (opacity cuts both ways).** Precisely
  because we can't see what runs on their side, the boundary must be treated as untrusted, with the
  same rigor as the webhook payload boundary: the endpoint we call is an **SSRF surface** (allow-list,
  validate, scope, time-out — never let it point our server at arbitrary hosts); the content it
  *returns* is untrusted and flows back to real users, so it is **data, not instructions**; and *what
  we send it* — a tenant's private documents reaching a third-party endpoint — is a **data-governance
  decision**, not merely a technical one. The architecture's job is to keep this boundary crisp:
  *provider owns auth at construction, the request contract stays credential-free, the `RemoteProvider`
  treats its handle as untrusted.* Getting that shape right (it is right in the v1 interface) is what
  keeps **both** the ecosystem upside reachable **and** the downside contained. This also partly
  dissolves the "deferred custody problem" below: if a submitter mints a scoped token against *their
  own* account rather than handing us a stored key, we stop being the custodian of their credential
  for that call. Implementation-discipline record: `BACKLOG.md` `P4`.

### Surface 3 — The integration layer (MCP / APIs) — the keystone
*"How do surfaces 1 and 2 become open rather than internal?"*

- Without a public, documented interface, surfaces 1 and 2 are things **only we** can extend. With
  one, they become an **ecosystem**.
- **Direction:** expose the platform via **MCP and/or REST APIs + webhooks** so external developers
  build connectors (Surface 1) and register capabilities (Surface 2) against a common protocol. MCP is
  the emerging standard for exactly this kind of pluggable AI integration, so this rides an existing
  wave rather than inventing plumbing.
- **The only thing this asks of the *current* trajectory:** when the content-management / sync-source
  path is built (a near-term phase), keep the **ingestion boundary clean** — whatever writes to
  `doc_cache` should go through a well-defined function/API boundary, **not** ad-hoc SQL scattered
  around. That boundary is the door a future connector knocks on. Make it a real door (a
  function/endpoint), not a wall. This is the one forward-compat obligation; everything else here is
  horizon, not task.

---

## Why these three cohere (and why the architecture is sound)

Each surface is the same move: **we provide the runtime/plumbing; others provide the content.**
- We don't build the bots → we provide the bot runtime (Phase 3 platform bot).
- We don't build every connector → we provide the ingestion interface (future).
- We don't author all knowledge → we provide the cache + answer path (today).

A strong validation arrived unprompted: a real external user's needs (Notion content + private
skilled bots for a collaborator group) mapped cleanly onto **seams planted before we knew about that
user** — the store abstraction, `bots.persona/model/capabilities`, and `bot_entities`. When unforeseen
external demand lands neatly on pre-existing seams, the architecture's center is coherent.

---

## Monetization horizon (carried from the platform-pivot addendum — direction only)

- Closed-loop prepaid credits; sell the product, not resold API access (Anthropic Commercial Terms).
- Rails split by cohort (stablecoins for web3 / Stripe for the rest); BASE + Ethereum.
- Provider-agnostic inference seam (Bittensor/Chutes as a north star; evaluate empirically).
- **Deferred custody problem:** holding third-party submitters' model-source credentials makes us a
  custodian + a maker of spend decisions on others' accounts — real obligations (breach exposes
  *their* accounts; runaway spend on *their* dime; edges toward KYC/liability). Solvable, not today;
  no present forcing function (we hold our own key for our own bots now).

---

## Discipline reminders (so the vision stays a compass)

- **One interested user is a reason to build the specific adjacent thing** (a Notion sync-source; a
  permissioned private bot), **not** the grand thing (a generic third-party connector platform with a
  developer program). The gap between those scopes is where focus dies.
- **Validated-with-signal ≠ validated demand.** These directions have *interest*, not *traction*.
  Treat them accordingly.
- **The vision changes nothing about what to build next.** Phase 4 (group-scoped context) is still
  Phase 4. It only changes the *frame* (laying platform foundation, not just shipping a feature) and
  gives a foreclosure check for future forks.
- **Capture, don't chase.** The purpose of writing this down is to stop carrying it in working memory
  and to stop it from distorting near-term scope — not to start pulling it forward.
