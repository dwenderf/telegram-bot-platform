-- Manifest & Doc-Cache Normalization: Irreversible Drop Migration
-- Created At: 2026-07-01
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
