-- Manual Script: Operator Backfill for Phase 1
-- Run this AFTER the operator signs up and before enforcing NOT NULL on owner_profile_id.

-- 1. Owner backfill: Set the operator/owner profile ID for existing entities.
-- REPLACE '<OWNER_PROFILE_UUID>' with the actual profile ID of the signed-up operator.
update public.entities set owner_profile_id = '<OWNER_PROFILE_UUID>'
  where slug in ('hys','symres','theata') and owner_profile_id is null;

-- 2. Bots & bot_entities mirror of current per-entity bots (1 bot per entity in v1)
with new_bots as (
  insert into public.bots (name, telegram_username, token_secret_ref, webhook_secret_ref, status)
  select e.display_name,
         e.telegram_bot_username,
         e.telegram_bot_token_id::text,
         e.telegram_webhook_secret_id::text,
         'active'
  from public.entities e
  where e.telegram_bot_username is not null
  returning id, telegram_username
)
insert into public.bot_entities (bot_id, entity_id)
select nb.id, e.id
from new_bots nb
join public.entities e on e.telegram_bot_username = nb.telegram_username;
