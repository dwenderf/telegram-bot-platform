-- Manifest & Doc-Cache Normalization: Irreversible Drop Migration
-- Originally written: 2026-07-01 (as supabase/manual/manifest_normalization_drop.sql)
-- Formalized into tracked migration history: 2026-07-13
--
-- This was run manually, out-of-band, shortly after the 2026-07-01 additive migration
-- (20260701000000_manifest_normalization_additive.sql) landed and its verification gate
-- passed -- confirmed retroactively because scripts/test-group-scoped-context.ts already
-- inserts into doc_cache/manifest_entries without doc_path and passes. It was never
-- captured as a dated migration file, so `supabase/migrations/` didn't reflect reality.
-- Moved here as-is (content unchanged) to close that documentation gap. All drops below
-- use `if exists` guards, so re-running this against the already-migrated schema is a
-- safe no-op.
--
-- Run only after additive migration is applied, the code has deployed, and gate checks pass.

-- Drop old columns on manifest_entries
alter table public.manifest_entries
  drop column if exists doc_path,
  drop column if exists telegram_thread_id;

-- Drop old columns & unique constraint on doc_cache
alter table public.doc_cache
  drop constraint if exists doc_cache_entity_id_doc_path_key,
  drop column if exists doc_path,
  drop column if exists git_sha;
