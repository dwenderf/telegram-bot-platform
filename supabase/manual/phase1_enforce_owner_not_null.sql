-- Manual Script: Enforce owner_profile_id NOT NULL on entities
-- Run this AFTER the operator backfill script completes successfully.

alter table public.entities
  alter column owner_profile_id set not null;
