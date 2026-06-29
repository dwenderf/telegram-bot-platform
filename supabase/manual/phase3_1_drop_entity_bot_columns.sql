-- Phase 3.1: Manual Destructive Cleanup Migration (Operator Action Required)
-- Run this ONLY after confirming that the platform bot is fully operational in production.

-- 1. Modify get_current_entity_secret to remove legacy Telegram bot refs
create or replace function get_current_entity_secret(p_secret_id uuid)
returns text as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where ds.id = p_secret_id
    and exists (
      select 1 from public.entities e
      where e.id = nullif(current_setting('app.current_entity_id', true), '')::uuid
        and p_secret_id = e.github_token_id
    );
$$ language sql security definer set search_path = public, vault;

-- 2. Drop the retired Telegram bot columns from entities table
alter table public.entities
  drop column if exists telegram_bot_token_id,
  drop column if exists telegram_webhook_secret_id,
  drop column if exists telegram_bot_username;

-- Note to operator:
-- After applying this migration, you can safely delete the Vault secrets 
-- that were associated with the retired per-entity bots.
