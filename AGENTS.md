<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Test-harness safety rules

1. Test scripts run against the shared database identified by `ADMIN_DATABASE_URL` / `DATABASE_URL`. Assume that database is **production**.
2. Test scripts must never `drop`, `truncate`, or revert schema on real tables. If a harness genuinely requires destructive DDL, it must be gated behind an explicit opt-in env flag (e.g. `ALLOW_DESTRUCTIVE_TEST_DDL=1`) and must fail fast with a clear message when the flag is absent.
3. Fail-injection via temporary constraints must use `not valid` (never validate existing rows) and the corresponding `drop constraint if exists` must appear at the **top of the `finally` block**, in addition to any in-body cleanup.
4. Row cleanup (setup and teardown) must target fixture UUIDs only — never unscoped deletes.
5. Harnesses may re-apply a migration file only if that migration is idempotent (`if not exists` / `create or replace` / `drop policy if exists` throughout).
6. New or modified test scripts must pass `npm run check:scripts`.
7. Harness-applied migrations bypass the Supabase migration ledger (`supabase_migrations.schema_migrations`): `sql.unsafe(migrationSql)` executes DDL against the real database without recording it, so `supabase migration list` will show the migration as missing on remote even though the schema exists. Migrations reach the remote database only via `supabase db push`, run by the operator **before** the harness's first execution — the harness re-apply is a convenience no-op for repeat runs, never the deployment mechanism. If a harness has applied a migration ahead of push, reconcile with `supabase db push` (safe because rule 5 requires harness-applied migrations to be idempotent; the `already exists, skipping` notices double as an idempotency proof) and verify with `supabase migration list`. `supabase migration repair --status applied <version>` is the fallback only if the migration somehow is not idempotent.
