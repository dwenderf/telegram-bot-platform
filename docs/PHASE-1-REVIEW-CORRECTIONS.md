# Phase 1 — Review Corrections (round 1)

> Feedback on the built `20260626000000_management_plane_foundation.sql`,
> `20260626000001_enforce_owner_not_null.sql`, `scripts/test-management-rls.ts`, and the
> `/manage` shell. **No migrations have been run yet** — these must be applied to the dev DB and the
> RLS suite run *before* committing. The build passing (`tsc`, `npm run build`) validated TypeScript
> and prerendering only; it executed zero SQL. Items B1, B2, S1 below surface only on a real
> apply + test run.
>
> Order: **B = blocking** (won't run / will fail), **S = should-fix**, **M = minor/confirm**.

---

## B1 — RLS policies will throw infinite recursion (blocking)

**Problem.** `authorization_select` contains `EXISTS (SELECT 1 FROM public.authorizations a …)` — a
policy on `authorizations` that queries `authorizations`. Postgres re-applies the policy to its own
subquery → `infinite recursion detected in policy for relation "authorizations"`. It compounds across
tables: `entity_management_select` queries `authorizations`, and `authorization_select` queries
`entities`, so the two tables' policies also recurse into each other. Net effect: nearly every
authenticated non-owner SELECT (and the whole dashboard member path) throws instead of returning rows.

**Fix.** Move every *cross-table* membership check into `SECURITY DEFINER` helper functions that
bypass RLS internally, and call those from the policies. Keep *same-row* checks (e.g. an entity's own
`owner_profile_id`) inline — those don't recurse.

### B1a — Two things are required together

1. Add the helper functions (below).
2. **Change `force row level security` → plain `enable row level security`** on the five new tables.

**Why dropping `force` is necessary *and* safe here:** a `SECURITY DEFINER` function runs as its
owner (the migration role, `postgres`, which owns these tables). A table owner is exempt from RLS
**unless `force` is set** — and with `force`, the helper's internal query to `authorizations` would be
subject to RLS *again* → the recursion returns even with the helper. Dropping `force` lets the
owner-owned helper bypass RLS and breaks the cycle. It loses no security: `force` only affects the
*table owner*, and the only role that is the owner is `postgres` (the operator), whom we *intend* to
bypass RLS for backfill/admin anyway. The app connects as `authenticated` (anon key + JWT) — never as
the owner — so it is subject to RLS regardless of `force`. `bot_service` is denied by the privilege
revoke (B-unaffected). The existing runtime tables can keep `force` because their policies don't
self/mutually reference; these do.

> If you'd rather keep `force` for consistency, the alternative is to own the helpers with a
> `BYPASSRLS` role — harder to express portably in a user migration. Dropping `force` on the five new
> tables is the recommended, deterministic path.

### B1b — Helper functions (add before the policy section)

```sql
-- Membership helpers. SECURITY DEFINER + owner-bypass (no force) breaks RLS recursion.
-- They key off auth.uid() internally, so they cannot be used to probe other users.

create or replace function public.has_active_auth(p_entity uuid, p_role text default null)
  returns boolean
  language sql
  security definer
  set search_path = ''
  stable
as $$
  select exists (
    select 1 from public.authorizations
    where entity_id = p_entity
      and profile_id = auth.uid()
      and status = 'active'
      and (p_role is null or role = p_role)
  );
$$;
```

> Note: an `is_entity_owner()` helper is **not** needed — the owner check on `entities` is a same-row
> column comparison (`owner_profile_id = auth.uid()`), which never recurses. Only the cross-table
> `authorizations` lookup needs the definer helper. For policies *on* `authorizations` that must check
> entity ownership, see B1c (it queries `entities`, a different table, so inline `EXISTS` there is
> safe — `entities`' own policy does not loop back through a definer-free path once B1 is applied;
> but to be fully safe, the example below routes the owner check through a tiny helper too).

Add the owner helper as well, so the `authorizations` policies never inline-query `entities`:

```sql
create or replace function public.is_entity_owner(p_entity uuid)
  returns boolean
  language sql
  security definer
  set search_path = ''
  stable
as $$
  select exists (
    select 1 from public.entities
    where id = p_entity and owner_profile_id = auth.uid()
  );
$$;
```

(Default `PUBLIC` execute is fine for both — they only answer "does the *current* user own / have
auth on entity X", which the caller already knows. No revoke needed.)

### B1c — Replace the policy section with this

```sql
-- RLS: enable only (NOT force) on the five new tables
alter table public.profiles        enable row level security;
alter table public.bots            enable row level security;
alter table public.bot_entities    enable row level security;
alter table public.authorizations  enable row level security;
alter table public.link_tokens     enable row level security;
-- (remove the five `force row level security` lines)

-- profiles: self only (unchanged; no subquery, no recursion)
create policy profiles_policy on public.profiles
  using (id = auth.uid())
  with check (id = auth.uid());

-- entities
create policy entity_management_select on public.entities
  for select using (
    (auth.uid() is not null and owner_profile_id = auth.uid())
    or public.has_active_auth(id)
  );

create policy entity_management_insert on public.entities
  for insert with check (
    auth.uid() is not null and owner_profile_id = auth.uid()
  );

create policy entity_management_update on public.entities
  for update
  using (
    (auth.uid() is not null and owner_profile_id = auth.uid())
    or public.has_active_auth(id, 'admin')
  )
  with check (
    (auth.uid() is not null and owner_profile_id = auth.uid())
    or public.has_active_auth(id, 'admin')
  );

create policy entity_management_delete on public.entities
  for delete using (
    auth.uid() is not null and owner_profile_id = auth.uid()
  );

-- authorizations (owner-only writes; select for owner or any active member)
create policy authorization_select on public.authorizations
  for select using (
    public.is_entity_owner(entity_id) or public.has_active_auth(entity_id)
  );

create policy authorization_insert on public.authorizations
  for insert with check (
    public.is_entity_owner(entity_id) and role in ('admin','editor','viewer')
  );

create policy authorization_update on public.authorizations
  for update
  using ( public.is_entity_owner(entity_id) )
  with check ( public.is_entity_owner(entity_id) and role in ('admin','editor','viewer') );

create policy authorization_delete on public.authorizations
  for delete using ( public.is_entity_owner(entity_id) );

-- bots / bot_entities / link_tokens: no policies = default deny (operator-only). Unchanged.
```

**Verification:** after applying, the RLS suite (B2 run) must pass tests 2a, 1d, 11b without any
"infinite recursion" error in output.

---

## B2 — `db push` will fail on migration 2 (blocking, operational)

**Problem.** Both migration files live in `supabase/migrations/`, so `npx supabase db push` runs them
in timestamp order. `20260626000001` (`SET NOT NULL`) executes immediately after the first —
**before** the operator backfills owners — against the existing HYS / SymRes / Theäta rows that now
have a null `owner_profile_id`. It fails: `column "owner_profile_id" contains null values`. The
`-- NOTE` comment documents the requirement but the file's presence in the auto-applied directory
defeats it.

**Fix.** Remove `20260626000001_enforce_owner_not_null.sql` from `supabase/migrations/`. Relocate its
one statement to a **manually-applied** file the operator runs *after* backfill, e.g.
`supabase/manual/phase1_enforce_owner_not_null.sql` (or `scripts/`). It must not be picked up by
`db push`.

**Operator runbook (the required sequence):**
1. Apply migration `20260626000000` (db push or SQL editor).
2. Operator signs up via magic link at `/manage` → provisions their `profiles` row.
3. Operator runs the backfill (S2 below): set `owner_profile_id` for existing entities; optionally
   backfill `bots`/`bot_entities`.
4. Apply the relocated `phase1_enforce_owner_not_null.sql`.

---

## S1 — Validation gate before commit (process)

Apply migration 1 to the dev DB and run the suite with both connection strings set:

```bash
export ADMIN_DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-<n>-<region>.pooler.supabase.com:6543/postgres"
export DATABASE_URL="postgresql://bot_service.<ref>:<pw>@aws-<n>-<region>.pooler.supabase.com:6543/postgres"
npx tsx scripts/test-management-rls.ts
```

`DATABASE_URL` **must** be the `bot_service` role (test 9 and 10b depend on it). A clean full pass —
with no "infinite recursion" in output — is the gate. Do not commit before this passes.

---

## S2 — Backfill script missing for `bots` / `bot_entities` (should-fix / decide)

The tables are created but never populated from the existing per-entity bots. Either include the
backfill as an operator step (between runbook steps 3 and 4) or **consciously defer to Phase 3 with a
one-line note** — its purpose is de-risking Phase 3, so don't let it fall through silently.

Template (data only; not read by runtime in Phase 1):

```sql
-- owner backfill (set the real operator/owner profile id per entity)
update public.entities set owner_profile_id = '<OWNER_PROFILE_UUID>'
  where slug in ('hys','symres','theata') and owner_profile_id is null;

-- bots + bot_entities mirror of current per-entity bots (1 bot per entity in v1)
with new_bots as (
  insert into public.bots (name, telegram_username, token_secret_ref, webhook_secret_ref, status)
  select e.display_name,
         e.telegram_bot_username,
         e.telegram_bot_token_id::text,
         e.telegram_webhook_secret_id::text,
         'active'
  from public.entities e
  where e.telegram_bot_username is not null
  returning id, telegram_username
)
insert into public.bot_entities (bot_id, entity_id)
select nb.id, e.id
from new_bots nb
join public.entities e on e.telegram_bot_username = nb.telegram_username;
```

---

## S3 — `ON CONFLICT` self-reference in `handle_new_user` (should-fix, latent migration error)

`coalesce(excluded.display_name, public.profiles.display_name)` — inside `ON CONFLICT DO UPDATE`, the
existing row is referenced by the **bare** target name; schema-qualifying it (`public.profiles.…`)
can throw `missing FROM-clause entry for table "public"`. With `search_path = ''` the unqualified
`profiles.display_name` still resolves, because the ON CONFLICT target is a statement-level reference,
not a search-path lookup.

**Fix:** change `public.profiles.display_name` → `profiles.display_name` in that one line. Confirm on
apply.

---

## S4 — Tests 1d and 4 still pass on *any* thrown error (should-fix)

Both use `catch (e) { assert.ok(e.message !== '<fail string>') }`, which is true for any exception —
so a recursion error or a constraint error would green-light them just as a real RLS denial would.
That's the "something threw ≠ the right thing happened" weakness we removed from 3/5/6; it must come
out of 1d/4 too, or they'd *mask* B1. Add the post-state assertion the others have:

```ts
// 1d — User A cannot forge an authorization on E2
let denied1d = false;
try {
  await runAsUser(sql, USER_A, 'user_a@test.com', async (tx) => {
    await tx`insert into public.authorizations (entity_id, profile_id, role)
             values (${E2}, ${USER_A}, 'admin')`;
  });
} catch { denied1d = true; }
const forged = await sql`select count(*)::int as c from public.authorizations
                         where entity_id = ${E2} and profile_id = ${USER_A}`;
assert.strictEqual(forged[0].c, 0, 'Test 1d Failed: forged auth row exists on E2');

// 4 — Viewer U2 cannot create an authorization on E1
let denied4 = false;
try {
  await runAsUser(sql, VIEWER_U2, 'viewer_u2@test.com', async (tx) => {
    await tx`insert into public.authorizations (entity_id, profile_id, role)
             values (${E1}, ${STRANGER_C}, 'viewer')`;
  });
} catch { denied4 = true; }
const created = await sql`select count(*)::int as c from public.authorizations
                          where entity_id = ${E1} and profile_id = ${STRANGER_C}`;
assert.strictEqual(created[0].c, 0, 'Test 4 Failed: viewer created an auth row on E1');
```

---

## S5 — `slug` is mutable via the management API (should-fix, integrity)

`entity_management_update` lets an `admin` (not just the owner) update the entity, and nothing makes
`slug` immutable at the DB layer — only the UI disables the field. In Phase 1 the live runtime still
routes per-slug (`/api/webhooks/telegram/{slug}`), so an admin changing a slug **breaks that entity's
live bot**. `slug` is a routing key and deserves the same protection `owner_profile_id` gets. Fold it
into the existing owner-immutability trigger:

```sql
create or replace function public.prevent_entity_immutable_change()
returns trigger as $$
begin
  if auth.uid() is not null then
    if old.owner_profile_id is not null
       and new.owner_profile_id is distinct from old.owner_profile_id then
      raise exception 'owner_profile_id is immutable via the management API';
    end if;
    if new.slug is distinct from old.slug then
      raise exception 'slug is immutable via the management API';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = '';
-- replace the on_entity_update trigger to call this function
```

(Operator via SQL — `auth.uid()` null — can still change either, which is the intended escape hatch.)

---

## S6 — Invite idempotency logic lives in the React component (should-fix / design)

`handleInvite` in `app/manage/entities/[entityId]/page.tsx` does `insert` + catch-`23505`; the suite's
`inviteUser` helper does `on conflict do update`. Test 8 passes but validates a path the product
doesn't use, and the real logic isn't reusable for the eventual API/automation. Extract invite
handling into a server capability (e.g. `lib/capabilities.ts`) that both the UI and test 8 call, so
the idempotency guarantee covers shipping code.

---

## M1 — Env wiring (confirm)

`lib/supabaseClient.ts` falls back to `placeholder-url` / `placeholder-key`, which is part of why the
build passed without real env. Confirm these are added to `.env.example`, Vercel, and the
DEPLOYMENT.md **A7** env table:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_APP_NAME` (the brand-config value; default `'Agent Platform'`)

Also confirm the login page's `emailRedirectTo` is env-driven (e.g. `NEXT_PUBLIC_SITE_URL`), **not** a
hardcoded `kenntnis.ai` — a wrong redirect host is a real auth bug, and this is where the brand/base
URL must stay swappable.

---

## M2 — Team list shows raw profile UUIDs (note / defer)

`profiles` RLS (`id = auth.uid()`) correctly forbids an owner from reading a co-member's profile, so
the dashboard can only render `Profile: <uuid>` for active members, not their email. Not a security
bug (fails closed), but the owner will immediately wonder who `a0000…` is. Eventually needs a definer
function returning limited co-member info, or denormalizing the email onto `authorizations`. Fine to
defer Phase 1 — just a conscious choice, not an oversight.

---

## M3 — Health check correctly deferred (confirm)

The entity page ships only Settings + Team tabs; `checkVaultSecretsHealth` was **not** wired in. That
matches the clean management↔runtime boundary recommendation. Confirm it was an intentional deferral
rather than a dropped item.

---

## What's already correct (no action)

- `search_path = ''` on every `SECURITY DEFINER` function.
- Owner/grant triggers no-op when `auth.uid() is null` (operator backfill/transfer works).
- `invited_email` is `citext`; the invite auto-claim matches only the Supabase-verified email
  (`email_confirmed_at is not null`).
- Owner is the `entities.owner_profile_id` column only — no owner row in `authorizations`.
- `bot_service` privileges revoked on all five tables (the privilege layer, which makes test 9's
  `42501` correct independent of RLS).
- Test harness genuinely exercises RLS (`set role authenticated` + `request.jwt.claims` drops the
  superuser bypass).
- Tests 7b/7c (negative unconfirmed + positive confirmed activation) and 5a/5b (forge User B's id)
  are stronger than specced — keep them.
