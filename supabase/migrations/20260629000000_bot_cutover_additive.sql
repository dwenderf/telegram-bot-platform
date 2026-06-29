-- Phase 3: Bot-Architecture Cutover Additive Migration
-- Created At: 2026-06-29

-- 1. Add unique slug column to bots table
-- Convention (B1): token_secret_ref and webhook_secret_ref hold the vault.secrets.id UUIDs formatted as text.
-- Kept text rather than a uuid FK constraint to allow potential future non-Vault credential references.
alter table public.bots
  add column if not exists slug text unique;


-- 2. Create resolve_bot_id_by_slug resolver
create or replace function public.resolve_bot_id_by_slug(p_slug text)
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  select id from public.bots where slug = p_slug;
$$;

revoke execute on function public.resolve_bot_id_by_slug(text) from public;
revoke execute on function public.resolve_bot_id_by_slug(text) from authenticated;
revoke execute on function public.resolve_bot_id_by_slug(text) from anon;
grant execute on function public.resolve_bot_id_by_slug(text) to bot_service;


-- 3. Create resolve_entity_id_by_chat resolver (S2)
-- SECURITY DEFINER allows this to run as postgres and read public.groups (bypassing FORCE RLS)
-- before the tenant context is established.
create or replace function public.resolve_entity_id_by_chat(p_chat_id bigint)
returns uuid
language sql
security definer
set search_path = ''
stable
as $$
  select entity_id from public.groups where telegram_chat_id = p_chat_id;
$$;

revoke execute on function public.resolve_entity_id_by_chat(bigint) from public;
revoke execute on function public.resolve_entity_id_by_chat(bigint) from authenticated;
revoke execute on function public.resolve_entity_id_by_chat(bigint) from anon;
grant execute on function public.resolve_entity_id_by_chat(bigint) to bot_service;


-- 4. Create get_current_bot_secret RLS-bypass function (B1)
-- Decrypts and returns a Vault secret ONLY if it is referenced by the current session bot.
-- Uses a regex match to defensively handle non-uuid references without throwing exceptions.
create or replace function public.get_current_bot_secret(p_secret_ref text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_secret_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return (
      select ds.decrypted_secret
      from vault.decrypted_secrets ds
      where ds.id = p_secret_ref::uuid
        and exists (
          select 1 from public.bots b
          where b.id = nullif(current_setting('app.current_bot_id', true), '')::uuid
            and p_secret_ref in (
              b.token_secret_ref,
              b.webhook_secret_ref
            )
        )
    );
  else
    return null;
  end if;
end;
$$;

revoke execute on function public.get_current_bot_secret(text) from public;
revoke execute on function public.get_current_bot_secret(text) from authenticated;
revoke execute on function public.get_current_bot_secret(text) from anon;
grant execute on function public.get_current_bot_secret(text) to bot_service;


-- 4b. Create get_bot_config resolver
create or replace function public.get_bot_config(p_bot_id uuid)
returns table (
  id uuid,
  telegram_username text,
  status text,
  persona text,
  model text,
  telegram_bot_token text,
  telegram_webhook_secret text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Set transaction-local context for security-definer sub-calls
  perform set_config('app.current_bot_id', p_bot_id::text, true);

  return query
  select 
    b.id,
    b.telegram_username,
    b.status,
    b.persona,
    b.model,
    public.get_current_bot_secret(b.token_secret_ref),
    public.get_current_bot_secret(b.webhook_secret_ref)
  from public.bots b
  where b.id = p_bot_id;
end;
$$;

revoke execute on function public.get_bot_config(uuid) from public;
revoke execute on function public.get_bot_config(uuid) from authenticated;
revoke execute on function public.get_bot_config(uuid) from anon;
grant execute on function public.get_bot_config(uuid) to bot_service;


-- 5. Documentation update / Invariant comment refresh
-- The database now has exactly FOUR security-definer bypass functions:
--   1. resolve_entity_id_by_slug (init schema)
--   2. resolve_entity_id_by_repo (init schema)
--   3. get_current_entity_secret (init schema)
--   4. get_current_bot_secret (this migration)
-- Plus non-secret resolvers running under security-definer:
--   - resolve_bot_id_by_slug
--   - resolve_entity_id_by_chat
-- No other RLS-bypassing functions should be added without security review.
