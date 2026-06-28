-- Phase 2: /auth Group-Linking Flow Migrations

-- 1. Add audit columns to link_tokens
alter table public.link_tokens
  add column if not exists consumed_chat_id      bigint,
  add column if not exists consumed_by_tg_user_id bigint;

-- 2. Create mint_link_token function
create or replace function public.mint_link_token(p_entity uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_hash text;
begin
  -- Authz check: Must be owner or active admin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  -- Generate a cryptographically secure random 10-char Crockford base32 code
  select string_agg(
    substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
           (get_byte(b, i) & 31) + 1, 1), '')
  into v_code
  from (select extensions.gen_random_bytes(10) as b) g,
       generate_series(0, 9) as i;

  -- Compute the SHA-256 hash of the code
  v_hash := encode(sha256(v_code::bytea), 'hex');

  -- Insert the token into database
  insert into public.link_tokens (entity_id, token_hash, issued_by, expires_at)
  values (p_entity, v_hash, auth.uid(), now() + interval '10 minutes');

  return v_code;
end;
$$;

-- Grant execution to authenticated users
grant execute on function public.mint_link_token(uuid) to authenticated;


-- 3. Create consume_link_token function
create or replace function public.consume_link_token(
  p_code text,
  p_expected_entity uuid,
  p_chat_id bigint,
  p_tg_user_id bigint,
  p_chat_title text,
  p_is_forum boolean
)
returns table(entity_id uuid, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token record;
  v_existing_entity_id uuid;
  v_display_name text;
begin
  -- 1. Forum check
  if not p_is_forum then
    raise exception 'not_forum';
  end if;

  -- 2. Temporarily disable row_security to perform RLS-bypassing check on groups and tokens
  perform set_config('row_security', 'off', true);

  -- 3. Select and lock the matching token
  select *
  into v_token
  from public.link_tokens
  where token_hash = encode(sha256(p_code::bytea), 'hex')
  for update;

  if not found then
    perform set_config('row_security', 'on', true);
    raise exception 'invalid_code';
  end if;

  -- 4. Expiry / Consumption checks
  if v_token.consumed_at is not null then
    perform set_config('row_security', 'on', true);
    raise exception 'already_consumed';
  end if;

  if v_token.expires_at <= now() then
    perform set_config('row_security', 'on', true);
    raise exception 'expired';
  end if;

  -- 5. Expected entity guard
  if p_expected_entity is not null and v_token.entity_id <> p_expected_entity then
    perform set_config('row_security', 'on', true);
    raise exception 'entity_mismatch';
  end if;

  -- 6. Re-bind check
  select g.entity_id
  into v_existing_entity_id
  from public.groups g
  where g.telegram_chat_id = p_chat_id;

  -- Restore row_security to enforce RLS on subsequent write operations
  perform set_config('row_security', 'on', true);

  if v_existing_entity_id is not null and v_existing_entity_id <> v_token.entity_id then
    raise exception 'chat_bound_elsewhere';
  end if;

  -- 7. Set current entity context transaction-locally so the write satisfies the groups RLS
  perform set_config('app.current_entity_id', v_token.entity_id::text, true);

  -- 8. Bind the group (create or update)
  insert into public.groups (entity_id, telegram_chat_id, display_name)
  values (v_token.entity_id, p_chat_id, p_chat_title)
  on conflict (telegram_chat_id) do update set
    display_name = excluded.display_name;

  -- 9. Consume the token
  update public.link_tokens
  set consumed_at = now(),
      consumed_chat_id = p_chat_id,
      consumed_by_tg_user_id = p_tg_user_id
  where id = v_token.id;

  -- 10. Fetch the display name of the bound entity
  select e.display_name
  into v_display_name
  from public.entities e
  where e.id = v_token.entity_id;

  return query select v_token.entity_id, v_display_name;
end;
$$;

-- Critical Security Gates: Revoke execute from public/anon/authenticated and limit strictly to bot_service
revoke execute on function public.consume_link_token(text, uuid, bigint, bigint, text, boolean) from public;
revoke execute on function public.consume_link_token(text, uuid, bigint, bigint, text, boolean) from authenticated;
revoke execute on function public.consume_link_token(text, uuid, bigint, bigint, text, boolean) from anon;
grant execute on function public.consume_link_token(text, uuid, bigint, bigint, text, boolean) to bot_service;


-- 4. Create list_entity_groups function
create or replace function public.list_entity_groups(p_entity uuid)
returns table (
  id uuid,
  entity_id uuid,
  telegram_chat_id bigint,
  display_name text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Authz check: Must be owner or active admin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  -- Set current entity transaction-locally to bypass read RLS for groups
  perform set_config('app.current_entity_id', p_entity::text, true);

  return query
  select g.id, g.entity_id, g.telegram_chat_id, g.display_name, g.created_at
  from public.groups g
  where g.entity_id = p_entity
  order by g.created_at desc;
end;
$$;

-- Grant execution to authenticated users
grant execute on function public.list_entity_groups(uuid) to authenticated;
