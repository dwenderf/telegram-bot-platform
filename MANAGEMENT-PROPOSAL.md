# Management Plane — Design Proposal

> **⚠️ STATUS: DRAFT / FUTURE SUBSYSTEM — NOT YET READY TO BUILD.**
> This captures the design thinking for the web-based management plane (web authentication, entity onboarding/linking, and the authorization model). It is **not** a finished build spec and is **not** proposed for implementation yet. It will mature in stages, mirroring `SECURITY-PROPOSAL.md`'s lifecycle: **draft → proposed-for-build (with full spec + test cases) → resolved/implemented.**
>
> **v1 needs none of this.** For internal use (the operator managing their own entities), authorization is assigned manually via SQL. This document is the design to *grow into* when onboarding real customers beyond the operator — do not build it ahead of that need.
>
> **When it's time to build:** flesh this stub into a full spec (edge cases, security properties, and **test cases** — the failure modes here are security failures: privilege escalation, cross-entity access, stale/replayed claim codes), then hand it to the coding agent. Treat it with the same adversarial rigor as the RLS model in `SECURITY-PROPOSAL.md`.

---

## 1. Why a separate document

The management plane is a **subsystem**, not an increment. Unlike a slash command (which slots into the existing architecture as a feature), it introduces: a new identity plane (web users), a new auth mechanism (Supabase Auth), a binding flow (`/link`), new tables (authorization/roles), and a **security surface** governing who may change what. That class of artifact warrants its own design doc + test spec — the same reasoning that gave the RLS/tenant-isolation model its own `SECURITY-PROPOSAL.md`.

## 2. The two identity planes

The platform has two distinct identity planes, connected through Telegram:

- **Runtime plane (exists today):** Telegram users ↔ entities, via `memberships` (membership = access; role = admin/member). This governs who can *use* the bot.
- **Management plane (this proposal):** Web users (Supabase Auth) ↔ entities, via an authorization table. This governs who can *manage* an entity's content/config via the web app.

**Telegram is the bridge between them.** The bot is the one actor that can observe a Telegram identity *and* a web-issued code in the same moment (the `/link` flow, §4), so it brokers the binding between web identity and entity. The two planes have the same shape (identity ↔ entity ↔ role), one level apart.

## 3. Authentication (who are you?)

Supabase Auth — email magic link + passkeys. Standard, solved infrastructure. Produces an authenticated **web user** identity. The interesting problem is not auth; it's **authorization** (§5) — tying that web identity to the entities it may manage.

## 4. Binding: the `/link` claim-code flow (which Telegram identity is this web user?)

The mechanism that connects a web identity to a Telegram identity + entity:

1. The **web app generates a short-lived, single-use claim code** for the logged-in web user (expire in ~2–5 minutes; consume on first use; prevents replay/sharing).
2. The web app shows it: "Run `/link <CODE>` in your group."
3. The user runs **`/link <CODE>`** in the entity's Telegram group.
4. The bot receives it and now sees **both identities at once**: the Telegram user (message sender) and the web user (via the code the web app associated with the logged-in session). It writes the binding.

**Why this design (vs. pasting a credential):** the token flows web→user→Telegram, not the reverse. It proves two things simultaneously — (a) control of the web account (they got the code while logged in), and (b) real membership in the Telegram group (they ran the command there). It uses **no Telegram secret** (not the bot token) — the claim code is a throwaway. And it supports **one web user managing multiple entities** (run `/link` in each entity's group, accumulating bindings).

**`/link` is a write-command** (it creates a binding) — a good first exercise of the deferred write-command path.

## 5. Authorization (what can you do, and to what?) — the hard part

This is where entity-vs-group scope makes permissions tricky, because **an entity has N groups, content lives at the entity level, but Telegram only knows about *group* admins** (there is no Telegram "entity admin" concept).

### 5.1 The scope problem (concrete)
HYS entity has groups HYS Internal + HYS Board. Someone could admin *Board* but only be a member of *Internal*. Entity content is **shared** by both groups — so letting a single-group admin edit entity content affects a group they don't admin. Scope must be explicit.

### 5.2 Proposed authorization table
One table, with a **nullable `group_id`** to express both scopes uniformly (mirrors the manifest's `group_id` convention: null = entity-wide, set = one group):

```
authorizations:
  web_user_id   -- Supabase Auth user
  entity_id
  group_id      -- NULL = entity-wide authority; set = scoped to one group
  role          -- e.g. admin / editor / viewer
```

- `group_id = NULL, role = admin` → **entity admin** (manage shared content/config, all groups).
- `group_id = <Board>, role = admin` → **group admin for Board only** (group-scoped things; NOT shared entity content).

### 5.3 Role assignment rules
- **Anyone in the group may `/link`** → gets an `authorizations` row scoped to that group (`group_id` set).
- **Role is determined by Telegram status at link time**, using Telegram's own admin list as source of truth (the bot checks `getChatMember` / `getChatAdministrators`):
  - Group **admin** → `editor`/group-admin role (can manage group-scoped things).
  - Regular **member** → `viewer` (read-only; can see context in the web app — a richer `/context` — but not edit). *(Allowing members to link as viewers is optional but useful and low-risk.)*
- **Entity-wide rights (`group_id = NULL`) are GRANTED, not auto-derived.** Single-group admin status does **not** automatically confer entity-wide authority (that would let a one-group admin edit content affecting other groups). An *existing entity admin* must grant entity-wide rights.

### 5.4 Bootstrapping the first admin
The first entity admin has to come from somewhere:
- **v1/internal:** assigned manually via SQL (the operator).
- **Product:** whoever **onboards** (creates) the entity is its first entity admin by definition, and can then grant others.

## 6. What taming the complexity depends on
1. **One authorization table with nullable `group_id`** — expresses entity-wide vs group-scoped uniformly (don't model them as separate concepts).
2. **Telegram's admin list as source of truth** — checked at link time via the Bot API; don't reinvent an admin concept.
3. **Entity-wide rights are granted, not auto-derived** from group-admin status — prevents one-group admins affecting other groups.

## 7. Build discipline (when the time comes)
Permission systems are where products accumulate complexity and security bugs, so:
- **Build the simplest version first.** When customer #2 arrives, likely just "entity admin" + "viewer"; **skip group-scoping** until there's a real multi-group customer who needs it. Let it grow.
- **Test the boundaries.** The build spec must include test cases proving: no privilege escalation (member can't gain editor; group admin can't edit entity-wide content), no cross-entity access, claim codes are single-use and expire, and the `/link` flow can't be replayed or spoofed.
- **Adversarial review**, same as the RLS model — the failure modes are security failures.

## 8. Relationship to other docs
- `PLANNING.md` §9 — points here (high-level mention; this doc holds the design).
- `SECURITY-PROPOSAL.md` — the runtime tenant-isolation (RLS) subsystem; this is its management-plane counterpart and should be designed with the same rigor.
- Depends on / interacts with: the **web app / management UI** (the surface this authorizes), the **`/context` command** (the read-only Telegram precursor to web-app content viewing), and the deferred **write-command** path (`/link` is one).
