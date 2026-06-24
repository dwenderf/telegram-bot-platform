// Re-registers the bot command menu (setMyCommands) for EVERY entity's bot.
//
// Run manually with an admin DB connection. You MUST `export` the variable so
// the npx child process inherits it (a bare assignment is only visible to the
// current shell, not to the script — you'll get "ADMIN_DATABASE_URL is required"):
//
//   export ADMIN_DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres"
//   npx tsx scripts/sync-commands.ts
//
// IMPORTANT — use the Supavisor POOLER host (aws-<n>-<region>.pooler.supabase.com),
// NOT the direct host (db.<ref>.supabase.co). The direct host fails locally with
// `getaddrinfo ENOTFOUND db.<ref>.supabase.co` (same issue as Vercel — see
// DEPLOYMENT.md A7). Username is the privileged role with the project-ref suffix
// (e.g. postgres.<ref>); the script reads ALL tenants' bot tokens, so it needs the
// privileged `postgres` role, not `bot_service`. prepare:false (set below) makes
// either pooler port work (6543 transaction or 5432 session).
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

  // prepare: false so this works on the Supavisor transaction pooler (6543) too,
  // not only the session pooler (5432). (Session mode supports prepared statements;
  // transaction mode does not. Setting it false is safe on both.)
  const sql = postgres(adminUrl, { max: 4, idle_timeout: 10, connect_timeout: 10, prepare: false });

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
