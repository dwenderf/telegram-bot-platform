-- Wider check constraint on source_type in public.doc_cache to support /push commands.
-- Created At: 2026-07-13

alter table public.doc_cache
  drop constraint if exists doc_cache_source_type_check;

alter table public.doc_cache
  add constraint doc_cache_source_type_check
  check (source_type in ('manual', 'push'));
