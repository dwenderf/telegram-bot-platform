# SPEC — Test-Harness Hygiene (prune, repair, typecheck, convention)

> **Reads against:** `scripts/` (all four harnesses), `tsconfig.json`, `AGENTS.md`,
> `supabase/migrations/20260629000000_bot_cutover_additive.sql`.
> **Rigor bar:** match prior phases. This spec touches **no runtime code** — `lib/` and `app/`
> are strictly out of scope. Every retained harness must run green end-to-end before this is done.
> **One-line scope:** make the ad-hoc test scripts safe against the shared database and loud when
> they rot — prune one, repair one, verify one, add a scripts typecheck target, and write down the
> convention that prevents recurrence.

---

## 0. Why

The Phase 5 adversarial review surfaced three related problems in `scripts/`:

1. **Destructive DDL aimed at the live database.** `test-manifest-normalization.ts` opens by
   running `drop table if exists public.threads cascade` plus a series of column drops/reverts
   against whatever `ADMIN_DATABASE_URL` points at. Its purpose (round-trip verifying a one-time
   migration) is complete and the "old shape" it reconstructs no longer exists anywhere — but the
   loaded footgun remains in the repo. Running it today would destroy `threads` and cascade away
   every topic-scoped manifest entry for the live tenants. This is the same hazard class we just
   excised from `test-model-call-logging.ts`, one file over.
2. **Silent rot.** `tsconfig.json` excludes `scripts/`, so `npm run build`'s "TypeScript check
   passed" never covers the harnesses. Two scripts are currently broken and nothing failed:
   `test-management-rls.ts` imports the retired per-entity route
   `app/api/webhooks/telegram/[entitySlug]/route` (deleted in Phase 3), and
   `test-manifest-normalization.ts` calls `getContextManifest` with its pre-Phase-4 two-argument
   signature. Both would crash at startup; neither produced a compile error anywhere.
   *(Validation of this item: the Item D typecheck, once implemented, immediately surfaced a
   third — `test-group-linking.ts` also imports the retired route. See §2b.)*
3. **No written convention** stopping the next harness from reintroducing either problem.

---

## 1. Item A — Prune `scripts/test-manifest-normalization.ts`

**Delete the file.** Do not fix it, gate it, or comment it out.

- Its purpose — verifying the manifest/doc-cache normalization migration round-trip, including the
  manual drop migration — was fulfilled when that migration shipped. The pre-normalization schema
  it reverts to no longer exists; the script can never meaningfully run again.
- Its startup DDL (`drop table ... cascade`, column drops on `doc_cache` and `manifest_entries`)
  is unconditionally destructive against the shared database.
- Git history preserves it if the methodology is ever needed as a reference.

**Do NOT** spend effort repairing its stale `getContextManifest(E1, 2)` call or dead schema
assumptions — that is wasted work on a file being deleted.

---

## 2. Item B — Repair `scripts/test-management-rls.ts` (keep the RLS coverage)

This harness is the **only** regression coverage for management-plane invariants that are still
enforced in production: cross-entity isolation, stranger visibility, privilege
escalation / owner protection, editor/viewer authorization mutation denial, client-supplied field
overrides, invite-by-email claiming and replay, `bot_service` role isolation, and default-deny.
Those test cases stay.

**Remove only the dead webhook portion:**

- Test Case 10 ("Webhook Golden Path & Isolation") in its entirety — it exercises the per-entity
  webhook route retired in Phase 3.
- The import of `POST` from `../app/api/webhooks/telegram/[entitySlug]/route` and the `NextRequest`
  import.
- The now-unused scaffolding that existed only for Test 10: the `setMockCallModel` stub, the
  global `fetch` mock, and the Vercel `waitUntil` request-context mock (verify none of the
  retained cases depend on them before removing — they should not).

**Do NOT** rewrite, renumber commentary, or "improve" the retained test cases. Surgical removal
only.

**Acceptance:** the script runs green end-to-end
(`node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-management-rls.ts`), and
`grep -r "webhooks/telegram" scripts/` returns nothing.

---

## 2b. Item B2 — Repair `scripts/test-group-linking.ts` (keep the linking coverage)

Discovered by the Item D typecheck after this spec was first written: this harness also imports
the retired per-entity route. **Repair, do not prune** — Test Cases 1–11 are pure SQL-level
adversarial coverage of `mint_link_token`, `consume_link_token`, and `list_entity_groups`, all
three of which remain live SECURITY DEFINER functions in production. `consume_link_token` is
exactly what the current platform route calls (via `consumeLinkToken`, with the null
expected-entity signature Test 9 covers). The replay, concurrent-race, takeover-protection,
idempotent-rebind, expiry, and forum-gate cases exist nowhere else.

**Remove only the dead webhook portion:**

- Test Case 12 ("Admin-Gate Webhook Handler Integration") in its entirety.
- The import of `POST` from `../app/api/webhooks/telegram/[entitySlug]/route` and the
  `NextRequest` import.
- The global `fetch` mock and the Vercel `waitUntil` request-context mock (verify Tests 1–11 do
  not use them — they should not; they are SQL-only).

**Keep** the startup migration re-apply: `20260628000000_group_linking.sql` was verified fully
idempotent (`add column if not exists` / `create or replace function` throughout), so it is
rule-5 compliant.

**Port Test 12's intent to the platform route (bounded exception to "no new tests").** The
non-admin `/auth` rejection is a genuine security gate: `consume_link_token` itself does NOT
check group-admin status (it is `bot_service`-gated only) — the route's `getChatMember` check is
the sole enforcement that only group admins can link a chat, and Test 12 was its only coverage
(`test-bot-cutover.ts` exercises only the admin-succeeds path). Replace Test 12 with an
equivalent case against `app/api/webhooks/platform/[botSlug]/route`, using the fixture pattern
from `test-bot-cutover.ts` Test 7 (seed a `bots` row + Vault secrets + `bot_entities` link; set
`mockChatMemberStatus = 'member'`; POST `/auth <code>`; assert the `'Not admin'` response, token
NOT consumed, and no `groups` row created). This may live either as the new Test 12 in this
harness (with the necessary bot fixtures added to setup/teardown) or as an added non-admin case
in `test-bot-cutover.ts` — implementer's choice; whichever requires the smaller diff. No other
new test authoring is licensed by this exception.

**Acceptance:** the script runs green end-to-end
(`node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-group-linking.ts`);
Test Cases 1–11 are intact and un-renumbered; the ported non-admin route-level case exists and
passes; the §2 grep audit still returns nothing.

---

## 3. Item C — Verify `scripts/test-bot-cutover.ts` (keep as-is)

This harness covers the still-live security spine (webhook-secret gate, cross-bot Vault isolation,
execute-grant denial, `/auth` binding, exclusion gate, idempotency) against the **current** platform
route. Reviewed findings:

- Its migration re-apply (`20260629000000_bot_cutover_additive.sql`) is already fully idempotent
  (`add column if not exists`, `create or replace function`) — safe against the live DB. Confirmed
  by reading the migration; no change needed there.
- Its cleanup deletes only fixture-UUID-scoped rows. Acceptable.

**Task:** run it end-to-end and confirm green. If the scripts typecheck (Item D) or the run
surfaces breakage, fix **only** what is required to make it pass — no scope expansion, no new test
cases.

---

## 4. Item D — Scripts typecheck target (make rot fail loudly)

- Add `tsconfig.scripts.json` at the repo root: `extends` the main `tsconfig.json`, `include`
  only `scripts/**/*.ts` (plus whatever ambient types the scripts need, e.g. `next-env.d.ts` if
  required), `noEmit: true`.
- Add to `package.json`: `"check:scripts": "tsc --noEmit -p tsconfig.scripts.json"`.
- **Do NOT** add `scripts/` back into the main `tsconfig.json` include — the Next.js build must
  remain unchanged. All compiler-option adjustments needed to make the scripts typecheck (module
  resolution, `__dirname` typing via `@types/node`, etc.) go in `tsconfig.scripts.json` only;
  never weaken the main config.
- If pre-existing type errors surface in the two retained harnesses, fix them minimally (they are
  real rot — that is the point of this item).

**Acceptance:** `npm run check:scripts` passes; then temporarily break an import in one script and
confirm the command fails (assert the detector actually detects); revert. `npm run build` remains
green and its output is unchanged.

---

## 5. Item E — Convention: destructive operations in test harnesses

Add the following section to `AGENTS.md` (so it binds future implementation passes), under a
heading like **"Test-harness safety rules"**:

1. Test scripts run against the shared database identified by `ADMIN_DATABASE_URL` /
   `DATABASE_URL`. Assume that database is **production**.
2. Test scripts must never `drop`, `truncate`, or revert schema on real tables. If a harness
   genuinely requires destructive DDL, it must be gated behind an explicit opt-in env flag
   (e.g. `ALLOW_DESTRUCTIVE_TEST_DDL=1`) and must fail fast with a clear message when the flag is
   absent.
3. Fail-injection via temporary constraints must use `not valid` (never validate existing rows)
   and the corresponding `drop constraint if exists` must appear at the **top of the `finally`
   block**, in addition to any in-body cleanup.
4. Row cleanup (setup and teardown) must target fixture UUIDs only — never unscoped deletes.
5. Harnesses may re-apply a migration file only if that migration is idempotent
   (`if not exists` / `create or replace` / `drop policy if exists` throughout).
6. New or modified test scripts must pass `npm run check:scripts`.
7. Harness-applied migrations bypass the Supabase migration ledger
   (`supabase_migrations.schema_migrations`): `sql.unsafe(migrationSql)` executes DDL against the
   real database without recording it, so `supabase migration list` will show the migration as
   missing on remote even though the schema exists. Migrations reach the remote database only via
   `supabase db push`, run by the operator **before** the harness's first execution — the harness
   re-apply is a convenience no-op for repeat runs, never the deployment mechanism. If a harness
   has applied a migration ahead of push, reconcile with `supabase db push` (safe because rule 5
   requires harness-applied migrations to be idempotent; the `already exists, skipping` notices
   double as an idempotency proof) and verify with `supabase migration list`.
   `supabase migration repair --status applied <version>` is the fallback only if the migration
   somehow is not idempotent.

Rules 3–5 and 7 codify what `test-model-call-logging.ts` and the Phase 5 deployment now do; they
are the reference example.

---

## 6. What this deliberately does NOT do

- **No test-framework migration** (vitest/jest/etc.) — the scripts remain standalone tsx
  harnesses. A framework is a future decision, not hygiene.
- **No CI setup.** `check:scripts` is a local command; wiring it into CI is out of scope.
- **No scratch/branch database provisioning.** The convention (Item E) is the mitigation for the
  shared-DB reality; isolated test databases are a separate future investment.
- **No changes to `lib/`, `app/`, or any migration file.**
- **No rewriting of passing harnesses** (`test-model-call-logging.ts`,
  `test-group-scoped-context.ts` are untouched except as Item D typechecking may minimally
  require).

---

## 7. Acceptance checklist (assert post-state, not "it didn't throw")

1. `scripts/test-manifest-normalization.ts` no longer exists.
2. `scripts/test-management-rls.ts` runs green end-to-end; contains no reference to
   `webhooks/telegram`; retained coverage (Test Cases 1–9, 11) is intact and un-renumbered.
3. `scripts/test-group-linking.ts` runs green end-to-end; Test Cases 1–11 intact and
   un-renumbered; the ported platform-route non-admin `/auth` case exists and passes;
   `grep -r "webhooks/telegram" scripts/` returns nothing.
4. `scripts/test-bot-cutover.ts` runs green end-to-end, unmodified or with a minimal listed diff.
5. `scripts/test-model-call-logging.ts` and `scripts/test-group-scoped-context.ts` still run green
   (regression check — Item D's config must not break them). `scripts/test-html-sanitizer.ts`
   and `scripts/sync-commands.ts` typecheck under Item D (they need no repair — the sanitizer is
   a pure unit test and the sync script is a utility with its own spec).
6. `npm run check:scripts` passes; a deliberately broken import fails it (verified, then reverted).
7. `npm run build` passes with unchanged output.
8. `AGENTS.md` contains the seven test-harness safety rules.

---

## 8. Handoff notes for Antigravity

- **Order of work:** Item D first (the typecheck will enumerate exactly what Items B and B2 must
  remove and whether Item C needs anything), then A (delete), B and B2 (surgical repairs), C
  (verify-run), E (docs). Run the full acceptance checklist last.
- **Scope discipline:** this is a hygiene pass. No feature work, no refactors of passing code, no
  runtime changes. If the typecheck surfaces something ambiguous outside `scripts/`, stop and
  report rather than fixing.
- The deleted file needs no replacement — its migration has shipped and its subject matter is
  covered structurally by FK constraints tested elsewhere.
