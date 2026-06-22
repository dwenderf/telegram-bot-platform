-- FIX: RLS policies were created as RESTRICTIVE with no PERMISSIVE companion,
-- which denies ALL rows to bot_service (restrictive policies can only filter what
-- permissive policies grant; with no permissive policy, nothing is granted).
-- This surfaced at runtime as "Tenant config mismatch" 404s on the first real
-- request as bot_service (the SQL editor connects as postgres and bypasses RLS,
-- so it was invisible during manual setup).
--
-- Fix: drop the eight restrictive policies and recreate them as PERMISSIVE
-- (the default). The using/with-check conditions are UNCHANGED and remain correct
-- for tenant isolation — a permissive policy "row is visible only if it belongs to
-- the current session entity" grants the right rows and hides all others.
-- permissive vs restrictive is fixed at creation, so this requires drop + recreate
-- (alter policy cannot change it).
--
-- Created At: 2026-06-21

-- entities
drop policy if exists entity_isolation on entities;
create policy entity_isolation on entities
  using (id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- groups
drop policy if exists group_isolation on groups;
create policy group_isolation on groups
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- memberships
drop policy if exists membership_isolation on memberships;
create policy membership_isolation on memberships
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- manifest_entries
drop policy if exists manifest_entry_isolation on manifest_entries;
create policy manifest_entry_isolation on manifest_entries
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- doc_cache
drop policy if exists doc_cache_isolation on doc_cache;
create policy doc_cache_isolation on doc_cache
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- message_log
drop policy if exists message_log_isolation on message_log;
create policy message_log_isolation on message_log
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- processed_updates
drop policy if exists processed_update_isolation on processed_updates;
create policy processed_update_isolation on processed_updates
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- users
drop policy if exists user_isolation on users;
create policy user_isolation on users
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);
