# SPEC — Command Sync: Platform-Bot Cutover (`scripts/sync-commands.ts`)

> **Reads against:** `scripts/sync-commands.ts`, `lib/commands.ts`, `lib/telegram.ts`
> (`setMyCommands`), `supabase/migrations/20260629000000_bot_cutover_additive.sql`
> (`get_current_bot_secret`, `app.current_bot_id`), `docs/specs/SPEC-command-sync-script.md`
> (the original spec this supersedes), `DEPLOYMENT.md` (command-registration section).
> **Rigor bar:** match prior phases; this touches one maintenance script + comments/docs.
> **One-line scope:** re-point the command-sync script from the retired per-entity bot model
> (`entities` table, revoked tokens) to the platform-bot model (`bots` table, bot-scoped Vault
> decryption). No changes to the command list, the handler, or any runtime code path.

---

## 0. Why (and what is NOT wrong)

- **What is NOT wrong:** `lib/commands.ts` is current — it lists `context`, `recap`, `whoami`,
  `auth`, `help` and does not list the removed `/ask`. The `setMyCommands` helper in
  `lib/telegram.ts` is correct and reusable. **Do not modify either file.** (An earlier review
  claim that the command list had drifted was incorrect; it was checked against the old spec's
  snippet, not the module.)
- **What IS wrong:** `scripts/sync-commands.ts` was built for the pre-Phase-3 architecture. It
  iterates `entities where telegram_bot_token_id is not null` — those references point at the
  **retired per-entity bots whose tokens were revoked** in the Phase 3 cutover. Running it today
  would decrypt dead tokens and collect a Telegram 401 per entity, while never touching the
  actual platform bot(s), which live in the `bots` table behind a different decryption function
  (`get_current_bot_secret`) and a different session variable (`app.current_bot_id`).
- **Sequencing dependency:** the script reads `entities.telegram_bot_token_id`, one of the
  columns slated for the deferred **Phase 3.1 irreversible drops**. As written, it is a hidden
  consumer of columns we intend to drop. This repair must land **before** Phase 3.1 executes.
- **Why repair rather than prune:** multiple platform bots are expected (possibly before the P2
  bot-store), and "edit `lib/commands.ts`, run one script, every platform bot's menu updates" is
  the correct mechanism for that world. The repair is a small diff over an identical loop shape.

---

## 1. Change — rewrite the iteration + decryption in `scripts/sync-commands.ts`

Keep the script's overall shape (admin connection, per-item try/catch, per-item ✓/✗ reporting,
non-zero exit on any failure, `prepare: false`, the extensive connection-string comments — those
Supavisor/`export` notes are hard-won and still true). Change only what the architecture change
requires:

1. **Iterate platform bots, not entities:**
   ```sql
   select id, slug, telegram_username, token_secret_ref
   from public.bots
   where status = 'active' and token_secret_ref is not null
   order by slug
   ```
   Retired bots are deliberately skipped — their tokens are revoked; attempting them would
   produce noise failures and a spurious non-zero exit.

2. **Decrypt via the bot-scoped sanctioned path** (mirrors how the webhook resolves secrets):
   ```typescript
   const token = await sql.begin(async (tx) => {
     await tx`select set_config('app.current_bot_id', ${b.id}, true)`;
     const rows = await tx<{ token: string | null }[]>`
       select public.get_current_bot_secret(${b.token_secret_ref}) as token
     `;
     return rows[0]?.token ?? null;
   });
   ```
   (Analogous to the old script's approach-A pattern, with `app.current_entity_id` /
   `get_current_entity_secret` swapped for the bot-scoped pair. `get_current_bot_secret`'s
   defensive non-UUID handling returns null rather than throwing, which the existing
   null-check already handles.)

3. **Report by bot identity** (`b.slug` / `b.telegram_username`) instead of entity slug.

4. **Update the header comment block:** it currently says "for EVERY entity's bot" — change to
   "for every ACTIVE platform bot"; keep all the `export` / pooler-host / `prepare:false`
   guidance verbatim. Note in the header that the script must be run once after any change to
   `lib/commands.ts`.

5. **Registration call:** keep the current inline `fetch` OR switch to importing
   `setMyCommands` from `lib/telegram.ts` — implementer's choice. If importing, verify
   `lib/telegram.ts` pulls in no app-runtime assumptions that break under `npx tsx` with only
   `ADMIN_DATABASE_URL` set (it currently has no env reads at module scope, so it should be
   clean). If in doubt, keep the inline fetch; either way `BOT_COMMANDS` from `lib/commands.ts`
   remains the single source of truth.

---

## 2. Change — docs pointer

`DEPLOYMENT.md`: find the command-registration step (Part A platform setup and/or the old B7
guidance). Update its wording so that:
- Registering commands for a **single new platform bot** during setup may still use the
  documented curl, with the command JSON sourced conceptually from `lib/commands.ts`.
- **Re-syncing all platform bots after a command-list change** points at
  `scripts/sync-commands.ts`.
Read the actual current section before editing — do not assume it still matches the old spec's
B7 description. Surgical wording change only.

Also add a one-line "Superseded by SPEC-command-sync-platform-bots.md (Phase 3 cutover)" note at
the top of `docs/specs/SPEC-command-sync-script.md` so the old spec can't mislead a future reader
— its Change 1/2 (the `lib/commands.ts` module and `setMyCommands` helper) remain valid; only its
Change 3 iteration model is superseded.

---

## 3. Verification

1. `npm run check:scripts` passes (the script is inside the Item D typecheck scope).
2. **Live run is the acceptance test** (there is no meaningful way to harness-test Telegram's
   `setMyCommands` without mocking away the entire point): David runs
   `export ADMIN_DATABASE_URL=... && npx tsx scripts/sync-commands.ts` and the output shows
   exactly one line per active platform bot (currently: the leguan bot), all ✓, exit 0.
3. **Post-state assertion, not "it didn't throw":** in a linked Telegram group, typing `/`
   shows exactly `context`, `recap`, `whoami`, `auth`, `help` — and does NOT show `ask`. (If the
   menu already showed this before the run, the run is still the proof the new path works.)
4. Retired-bot exclusion: the script output contains no lines for retired bots (verify against
   `select slug, status from public.bots` if in doubt).

---

## 4. What this deliberately does NOT do

- **No changes to `lib/commands.ts`** — it is current. If the implementer believes it has
  drifted from the handler's actual commands, stop and report; do not edit it under this spec.
- **No per-bot command customization** (all platform bots get the same menu), **no deployed
  endpoint** (this remains a local, manually-run, privileged operation), **no handler
  refactoring**, **no drift-check automation** (handler-imports-BOT_COMMANDS assertion remains a
  noted future idea, not built).
- **No new tests.** The script is a maintenance utility verified by its live run.

---

## 5. Handoff notes for Antigravity

- This is a small, surgical diff: the loop body's query + decryption context + labels, the
  header comment, and two doc touches. Resist restructuring the script.
- Rule 6 of the AGENTS.md test-harness safety rules applies (`check:scripts` must pass); rules
  about destructive DDL don't apply here (the script is read-only against the DB).
- After David's live run succeeds, this spec is closed; the old
  `SPEC-command-sync-script.md` stays in the repo with its superseded note.
