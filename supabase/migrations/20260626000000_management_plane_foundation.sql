-- Migration: Management Plane Foundation (Phase 1)
-- Created At: 2026-06-26

-- 1. Create Extensions
create extension if not exists citext;

-- 2. Create profiles table
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         citext not null unique,
  display_name  text,
  created_at    timestamptz not null default now()
);

-- 3. Add owner_profile_id to entities (nullable in Phase 1 for migration/backfill)
alter table public.entities
  add column owner_profile_id uuid references public.profiles(id);

-- 4. Create bots and bot_entities tables
create table public.bots (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  telegram_username    text,
  token_secret_ref     text,        -- Vault reference
  webhook_secret_ref   text,        -- Vault reference
  persona              text,        -- stub
  model                text,        -- stub
  capabilities         jsonb not null default '{}'::jsonb,   -- stub
  status               text not null default 'active',
  created_at           timestamptz not null default now()
);

create table public.bot_entities (
  bot_id     uuid references public.bots(id) on delete cascade,
  entity_id  uuid references public.entities(id) on delete cascade,
  primary key (bot_id, entity_id)
);

-- 5. Create authorizations table (using citext for invited_email to match profiles)
create table public.authorizations (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references public.entities(id) on delete cascade,
  profile_id     uuid references public.profiles(id) on delete cascade,
  invited_email  citext,
  role           text not null check (role in ('admin','editor','viewer')),
  group_id       uuid,                 -- always null in Phase 1
  status         text not null default 'active' check (status in ('active','pending')),
  granted_by     uuid not null references public.profiles(id),
  created_at     timestamptz not null default now(),
  check ( (status='active' and profile_id is not null)
       or (status='pending' and invited_email is not null and profile_id is null) ),
  unique (entity_id, profile_id),
  unique (entity_id, invited_email)
);

-- 6. Create link_tokens table
create table public.link_tokens (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text not null unique,
  issued_by     uuid not null references public.profiles(id),
  entity_id     uuid not null references public.entities(id) on delete cascade,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- 7. Enable and Force Row-Level Security (RLS)
alter table public.profiles enable row level security;
alter table public.bots enable row level security;
alter table public.bot_entities enable row level security;
alter table public.authorizations enable row level security;
alter table public.link_tokens enable row level security;

-- force row level security is NOT set to break RLS recursion cycles via helper functions

-- 8. SECURITY DEFINER Trigger Functions (search_path = '', fully-qualified references)

-- Trigger: Provision profiles + auto-claim pending invites (matches verified new.email)
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email::public.citext,
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'full_name')
  )
  on conflict (id) do update
  set email = excluded.email,
      display_name = coalesce(excluded.display_name, profiles.display_name);

  -- Invite auto-claim matches only the new user's Supabase-verified email
  if new.email_confirmed_at is not null then
    update public.authorizations
    set profile_id = new.id,
        status = 'active',
        invited_email = null
    where invited_email = new.email::public.citext
      and status = 'pending';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = '';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update on auth.users
  for each row execute procedure public.handle_new_user();

-- Trigger: Enforce entity owner setting on INSERT (no-ops if auth.uid() is null for migrations)
create or replace function public.set_entity_owner_on_insert()
returns trigger as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is not null then
    new.owner_profile_id := v_uid;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = '';

create or replace trigger on_entity_insert
  before insert on public.entities
  for each row execute procedure public.set_entity_owner_on_insert();

-- Trigger: Prevent immutable entity field modifications (no-ops if auth.uid() is null for operator transfers)
create or replace function public.prevent_entity_immutable_change()
returns trigger as $$
begin
  if auth.uid() is not null then
    if old.owner_profile_id is not null
       and new.owner_profile_id is distinct from old.owner_profile_id then
      raise exception 'owner_profile_id is immutable via the management API';
    end if;
    if new.slug is distinct from old.slug then
      raise exception 'slug is immutable via the management API';
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = '';

create or replace trigger on_entity_update
  before update on public.entities
  for each row execute procedure public.prevent_entity_immutable_change();

-- Trigger: Enforce granted_by field setting on INSERT
create or replace function public.set_authorization_defaults()
returns trigger as $$
declare
  v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is not null then
    new.granted_by := v_uid;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = '';

create or replace trigger on_authorization_insert
  before insert on public.authorizations
  for each row execute procedure public.set_authorization_defaults();

-- Trigger: If invited email is already registered in profiles, convert status to active immediately
create or replace function public.precheck_authorization_invite()
returns trigger as $$
declare
  v_profile_id uuid;
begin
  if new.status = 'pending' and new.invited_email is not null then
    -- Only auto-claim the invite on insert if the target profile belongs to a user with a verified/confirmed email
    select p.id into v_profile_id
    from public.profiles p
    join auth.users u on p.id = u.id
    where p.email = new.invited_email
      and u.email_confirmed_at is not null;

    if v_profile_id is not null then
      new.profile_id := v_profile_id;
      new.status := 'active';
      new.invited_email := null;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = '';

create or replace trigger on_authorization_before_insert
  before insert on public.authorizations
  for each row execute procedure public.precheck_authorization_invite();

-- Membership helpers. SECURITY DEFINER + owner-bypass (no force) breaks RLS recursion.
-- They key off auth.uid() internally, so they cannot be used to probe other users.

create or replace function public.has_active_auth(p_entity uuid, p_role text default null)
  returns boolean
  language sql
  security definer
  set search_path = ''
  stable
as $$
  select exists (
    select 1 from public.authorizations
    where entity_id = p_entity
      and profile_id = auth.uid()
      and status = 'active'
      and (p_role is null or role = p_role)
  );
$$;

create or replace function public.is_entity_owner(p_entity uuid)
  returns boolean
  language sql
  security definer
  set search_path = ''
  stable
as $$
  select exists (
    select 1 from public.entities
    where id = p_entity and owner_profile_id = auth.uid()
  );
$$;

-- Secure invite_user capability. SECURITY DEFINER + search_path = '' + checks caller is owner.
create or replace function public.invite_user(p_entity_id uuid, p_email text, p_role text)
returns void as $$
declare
  v_email_citext public.citext;
  v_profile_id uuid;
begin
  v_email_citext := trim(p_email)::public.citext;

  -- 1. Check if caller is authorized (must be owner of the entity)
  if not public.is_entity_owner(p_entity_id) then
    raise exception 'access denied: caller is not the owner of the entity';
  end if;

  -- 2. Check if user already has a profile WITH A CONFIRMED EMAIL
  select p.id into v_profile_id
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.email = v_email_citext
    and u.email_confirmed_at is not null;

  if v_profile_id is not null then
    insert into public.authorizations (entity_id, profile_id, role, status)
    values (p_entity_id, v_profile_id, p_role, 'active')
    on conflict (entity_id, profile_id) do update
    set role = excluded.role;
  else
    insert into public.authorizations (entity_id, invited_email, role, status)
    values (p_entity_id, v_email_citext, p_role, 'pending')
    on conflict (entity_id, invited_email) do update
    set role = excluded.role;
  end if;
end;
$$ language plpgsql security definer set search_path = '';

-- 9. Row-Level Security Policies

-- profiles policies
create policy profiles_policy on public.profiles
  using (id = auth.uid())
  with check (id = auth.uid());

-- entities policies (management select, insert, update, delete)
create policy entity_management_select on public.entities
  for select using (
    (auth.uid() is not null and owner_profile_id = auth.uid())
    or public.has_active_auth(id)
  );

create policy entity_management_insert on public.entities
  for insert with check (
    auth.uid() is not null and owner_profile_id = auth.uid()
  );

create policy entity_management_update on public.entities
  for update
  using (
    (auth.uid() is not null and owner_profile_id = auth.uid())
    or public.has_active_auth(id, 'admin')
  )
  with check (
    (auth.uid() is not null and owner_profile_id = auth.uid())
    or public.has_active_auth(id, 'admin')
  );

create policy entity_management_delete on public.entities
  for delete using (
    auth.uid() is not null and owner_profile_id = auth.uid()
  );

-- authorizations policies
create policy authorization_select on public.authorizations
  for select using (
    public.is_entity_owner(entity_id) or public.has_active_auth(entity_id)
  );

create policy authorization_insert on public.authorizations
  for insert with check (
    public.is_entity_owner(entity_id) and role in ('admin','editor','viewer')
  );

create policy authorization_update on public.authorizations
  for update
  using ( public.is_entity_owner(entity_id) )
  with check ( public.is_entity_owner(entity_id) and role in ('admin','editor','viewer') );

create policy authorization_delete on public.authorizations
  for delete using ( public.is_entity_owner(entity_id) );

-- 10. Role Isolation: Revoke privileges on new tables from bot_service
revoke all privileges on public.profiles from bot_service;
revoke all privileges on public.bots from bot_service;
revoke all privileges on public.bot_entities from bot_service;
revoke all privileges on public.authorizations from bot_service;
revoke all privileges on public.link_tokens from bot_service;
