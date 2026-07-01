-- Manifest & Doc-Cache Normalization: Additive Migration
-- Created At: 2026-07-01

-- 1. Modify doc_cache table to add normalised columns
alter table public.doc_cache
  add column if not exists display_name text,
  add column if not exists source_type text not null default 'manual' check (source_type in ('manual')),
  add column if not exists source jsonb;

-- Backfill display_name from doc_path
update public.doc_cache
set display_name = doc_path
where display_name is null;

-- Set display_name to NOT NULL after backfilling
alter table public.doc_cache
  alter column display_name set not null;

-- Backfill source locator JSONB from git_sha (Item 3: nullable when git_sha is null)
update public.doc_cache
set source = jsonb_build_object('git_sha', git_sha)
where source is null and git_sha is not null;


-- 2. Create threads structural runtime table
create table if not exists public.threads (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references public.entities(id) on delete cascade,
  group_id           uuid not null references public.groups(id) on delete cascade,
  telegram_thread_id bigint not null,
  created_at         timestamptz not null default now(),
  unique (group_id, telegram_thread_id)
);

-- Configure RLS on threads table (mirroring groups policy exactly)
alter table public.threads enable row level security;
alter table public.threads force row level security;

create policy thread_isolation on public.threads
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- Grant privileges to bot_service role
grant select, insert, update, delete on public.threads to bot_service;


-- 3. Data Fix: bind the single malformed manifest row (non-null topic, null group_id)
-- dynamically checks message_log or falls back to first bound group for that entity
update public.manifest_entries m
set group_id = coalesce(
  (
    select group_id from public.message_log ml
    where ml.telegram_thread_id = m.telegram_thread_id
      and ml.entity_id = m.entity_id
    limit 1
  ),
  (
    select g.id from public.groups g
    where g.entity_id = m.entity_id
    limit 1
  )
)
where m.telegram_thread_id is not null and m.group_id is null;


-- 4. threads Backfill: populate from distinct topics present in manifest_entries or message_log
insert into public.threads (entity_id, group_id, telegram_thread_id)
select distinct entity_id, group_id, telegram_thread_id
from public.manifest_entries
where telegram_thread_id is not null and group_id is not null
on conflict (group_id, telegram_thread_id) do nothing;


-- 5. Add referencing columns to manifest_entries
alter table public.manifest_entries
  add column if not exists doc_id uuid references public.doc_cache(id) on delete cascade,
  add column if not exists thread_id uuid references public.threads(id) on delete cascade;

-- Backfill doc_id by joining doc_cache on entity_id and doc_path
update public.manifest_entries m
set doc_id = c.id
from public.doc_cache c
where c.entity_id = m.entity_id and c.doc_path = m.doc_path;

-- Set doc_id to NOT NULL after backfilling
alter table public.manifest_entries
  alter column doc_id set not null;

-- Backfill thread_id by joining threads on group_id and telegram_thread_id
update public.manifest_entries m
set thread_id = t.id
from public.threads t
where t.group_id = m.group_id and t.telegram_thread_id = m.telegram_thread_id;
