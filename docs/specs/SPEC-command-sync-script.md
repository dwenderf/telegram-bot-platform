# SPEC: command sync script + shared command list (for Antigravity)

> [!IMPORTANT]
> **Superseded by [SPEC-command-sync-platform-bots.md](file:///Users/davidwender/Documents/GitHub/telegram-bot-platform/docs/specs/SPEC-command-sync-platform-bots.md) (Phase 3 cutover)**:
> This document remains in the repository as a historical reference. The shared command list in `lib/commands.ts` remains active, but the script iteration model has been repointed to the platform-bot table.


> **Status:** ready to implement.
> **Goal:** make the bot command menu (`setMyCommands`) (a) defined in **one** place that can't drift, and (b) **re-registrable across all entities' bots** with a single command, instead of hand-running a curl per bot.
> **Scope (deliberately minimal):** a **maintenance script** in `scripts/`, run **manually** with an **admin/privileged DB connection**. NOT a deployed endpoint (that's a future management-plane concern — see MANAGEMENT-PROPOSAL.md). Build only the script + the shared list now.

---

## Why

- Today the command set lives in 2-3 places (the handler's `text.startsWith(...)` parsing, the DEPLOYMENT.md B7 curl, and operators' memory). When a command is added (e.g. `/whoami`), the menu has to be hand-updated per bot. That's drift-prone and tedious at >1 entity.
- We have all entities and their bot tokens (in Vault), so registering commands across every bot is fully mechanical.

---

## Change 1 — Shared command-list module: `lib/commands.ts` (single source of truth)

Create a new module that defines the canonical **menu** command list once. This is the list registered with Telegram's `setMyCommands` (the `/` autocomplete menu).

```typescript
// lib/commands.ts
//
// Single source of truth for the bot's PUBLIC command menu (setMyCommands).
// The handler parses incoming text directly (text.startsWith('/ask') etc.);
// this list is specifically the menu/autocomplete registration. Keep the two
// conceptually in sync: every command a user should DISCOVER belongs here.
// (/whoami is public; @mention is not a slash command, so it is not listed.)

export interface BotCommand {
  command: string;      // without the leading slash
  description: string;  // shown in the / menu (Telegram limit ~256 chars; keep short)
}

export const BOT_COMMANDS: BotCommand[] = [
  { command: 'ask',     description: 'Ask a question grounded in the team docs' },
  { command: 'context', description: 'See what docs the bot answers from here' },
  { command: 'whoami',  description: "Show this chat's ids (setup/diagnostics)" },
  { command: 'help',    description: 'Show what the bot can do' },
];
```

**Notes:**
- Telegram orders the menu as given, though clients may present alphabetically; either way this order is fine.
- This is the *menu* list. The handler's intent-parsing (in `route.ts`) is separate by nature (it matches prefixes, handles `@mention`, etc.). We are NOT refactoring the handler's parsing in this change — but a follow-up *could* have the handler import `BOT_COMMANDS` to assert every menu command has a handler (a nice drift-check; out of scope here).

---

## Change 2 — `setMyCommands` helper in `lib/telegram.ts`

Add an exported helper so both the script (now) and any future caller use the same implementation. It goes through the existing `callTelegramApi` (JSON, which `setMyCommands` uses).

```typescript
import { BOT_COMMANDS, type BotCommand } from './commands';

/**
 * Registers the bot's command menu (setMyCommands). Pass a command list;
 * defaults to the shared BOT_COMMANDS. setMyCommands is a full replace
 * (not a merge), so this is idempotent and safe to re-run.
 */
export async function setMyCommands(
  token: string,
  commands: BotCommand[] = BOT_COMMANDS
): Promise<any> {
  return await callTelegramApi(token, 'setMyCommands', { commands });
}
```

---

## Change 3 — The maintenance script: `scripts/sync-commands.ts`

A standalone Node/TS script that:
1. Connects to Postgres with an **admin/privileged** connection (NOT the app's `bot_service` role — this script must read *every* entity's bot token, which `bot_service` cannot do across tenants).
2. Reads all entities + decrypts each bot token via Vault.
3. Calls `setMyCommands` for each, with the shared `BOT_COMMANDS`.
4. Reports per-entity success/failure; exits non-zero if any failed.

### Connection / privilege (important — read carefully)
- The script needs an **admin DB connection string**, supplied via its **own env var** (e.g. `ADMIN_DATABASE_URL`), kept **out of the app's runtime env**. Do NOT reuse the app's `DATABASE_URL` (that's the `bot_service` role, which can't read other tenants' Vault secrets).
- The admin connection is the privileged role used in the SQL editor (e.g. `postgres`) — the same privilege level used for entity creation and Vault management in DEPLOYMENT. Document that this script holds elevated privilege and is run **locally/manually**, never deployed.
- Use a direct (non-pooler) or session-pooler connection as appropriate for a short-lived local script; `prepare: false` is only needed for the transaction pooler, so a local admin connection can use defaults. (Implementer: match whatever connection form is simplest for a local one-shot script.)

### Reading tokens
Two viable approaches — **prefer A**:
- **A (preferred): decrypt via the existing function, per entity.** For each entity, set the RLS context and call `get_current_entity_secret(telegram_bot_token_id)` — i.e. reuse `withTenantContext(entityId, ...)`. This goes through the *sanctioned* decryption path (the same one the app uses) rather than reading `vault.decrypted_secrets` directly. Cleanest and most consistent.
- **B (fallback): read `vault.decrypted_secrets` directly** as the admin role, joining on `entities.telegram_bot_token_id`. Simpler query but bypasses the sanctioned function. Only use if A is awkward in a script context.

> Decision: use **A** if `withTenantContext` / the supabase client can be imported and run from a script against the admin connection without pulling in app-only assumptions. If the script needs its own lightweight `postgres` client (likely, since `lib/supabase.ts` reads the app's `DATABASE_URL`), replicate the minimal connect + `set_config('app.current_entity_id', ...)` + `get_current_entity_secret(...)` pattern against `ADMIN_DATABASE_URL`. Keep it simple.

### Script shape
```typescript
// scripts/sync-commands.ts
//
// Re-registers the bot command menu (setMyCommands) for EVERY entity's bot.
// Run manually with an admin DB connection:
//   ADMIN_DATABASE_URL=postgres://postgres:...@host:5432/postgres \
//     npx tsx scripts/sync-commands.ts
//
// Holds elevated DB privilege (reads all tenants' bot tokens). Run locally,
// never deploy. setMyCommands is a full replace, so this is idempotent.

import postgres from 'postgres';
import { BOT_COMMANDS } from '../lib/commands';

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error('ADMIN_DATABASE_URL is required (admin/privileged connection).');
    process.exit(1);
  }

  const sql = postgres(adminUrl, { max: 4, idle_timeout: 10, connect_timeout: 10 });

  try {
    // 1. All entities with a bot token reference.
    const entities = await sql<{ id: string; slug: string; telegram_bot_token_id: string }[]>`
      select id, slug, telegram_bot_token_id
      from entities
      where telegram_bot_token_id is not null
      order by slug
    `;

    if (entities.length === 0) {
      console.log('No entities with a bot token found. Nothing to do.');
      return;
    }

    let failures = 0;

    for (const e of entities) {
      try {
        // 2. Decrypt this entity's bot token via the sanctioned path,
        //    inside its RLS context (approach A).
        const token = await sql.begin(async (tx) => {
          await tx`select set_config('app.current_entity_id', ${e.id}, true)`;
          const rows = await tx<{ token: string | null }[]>`
            select get_current_entity_secret(${e.telegram_bot_token_id}) as token
          `;
          return rows[0]?.token ?? null;
        });

        if (!token) {
          console.error(`✗ ${e.slug}: could not decrypt bot token (null).`);
          failures++;
          continue;
        }

        // 3. Register the menu (full replace).
        const res = await fetch(
          `https://api.telegram.org/bot${token}/setMyCommands`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands: BOT_COMMANDS }),
          }
        );
        const json = await res.json();
        if (json.ok) {
          console.log(`✓ ${e.slug}: commands registered (${BOT_COMMANDS.length}).`);
        } else {
          console.error(`✗ ${e.slug}: Telegram rejected — ${JSON.stringify(json)}`);
          failures++;
        }
      } catch (err) {
        console.error(`✗ ${e.slug}: error —`, err);
        failures++;
      }
    }

    console.log(`\nDone. ${entities.length - failures}/${entities.length} succeeded.`);
    if (failures > 0) process.exit(1);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

**Notes for the implementer:**
- The script calls Telegram directly (inline `fetch`) rather than importing `lib/telegram.ts`'s `setMyCommands`, because `lib/telegram.ts` may pull in other app deps; a self-contained script is simpler and avoids accidental coupling. **However**, it still imports `BOT_COMMANDS` from `lib/commands.ts` — that's the single source of truth, and `lib/commands.ts` must stay dependency-light (no app/runtime imports) so it's safe to import from a script. **Keep `lib/commands.ts` a pure data module.** (If you prefer to reuse `lib/telegram.ts`'s `setMyCommands` helper and it imports cleanly in a script context, that's fine too — either way, one command list.)
- Run via `npx tsx scripts/sync-commands.ts` (add `tsx` as a dev dependency if not present) or compile per the project's setup. Confirm the project's preferred way to run a TS script.
- **Idempotent:** `setMyCommands` replaces the whole menu each call, so re-running is harmless and is exactly how you push a command-list change to all bots.

---

## Change 4 — DEPLOYMENT.md B7: point at the shared list + the script

Update B7 to note:
- The canonical command list now lives in `lib/commands.ts` (edit there to change the menu).
- For a **single new bot** during onboarding, the manual curl in B7 is still fine (one bot).
- To **re-sync all bots** after a command change, run `scripts/sync-commands.ts` instead of hand-curling each.

(Keep the manual curl in B7 for the single-onboarding case; add a short note pointing to the script for the all-bots case.)

---

## Test plan
1. **Two-entity run** (current state: HYS + Theäta) → script reports `✓ hys` and `✓ theaeta`, both registered; the `/` menu in each bot shows `/ask /context /whoami /help`.
2. **Add a command to `lib/commands.ts`, re-run** → both bots' menus update to include it (proves single-source-of-truth + bulk sync).
3. **Bad/missing `ADMIN_DATABASE_URL`** → clean error + non-zero exit, no partial work.
4. **An entity whose token won't decrypt** (simulate by pointing a test entity at a deleted secret) → that entity reports `✗` and the script exits non-zero, but other entities still succeed (per-entity isolation).
5. **`bot_service` URL rejected for this use** → confirm (conceptually) the script uses `ADMIN_DATABASE_URL`, not the app's `bot_service` `DATABASE_URL` (which couldn't read all tenants' secrets).

---

## What this deliberately does NOT do
- **Not a deployed endpoint.** No ambient admin privilege in the running app. Re-syncing commands is a manual, local, privileged operation in v1 — same posture as entity creation and Vault management. The future management plane (MANAGEMENT-PROPOSAL.md) can expose this as an authenticated admin action; this script is its reusable core.
- **Does not refactor the handler's command parsing.** The handler still matches prefixes inline. (A future drift-check could have the handler import `BOT_COMMANDS` to assert each menu command has a handler — noted, not built.)
- **No per-entity command customization.** All bots get the same menu. (If a tenant ever needs a custom menu, `setMyCommands` per-entity overrides are possible later; not now.)
