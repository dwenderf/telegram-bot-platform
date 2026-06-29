-- INITIAL MIGRATION: Telegram Bot Platform Schema
-- Created At: 2026-06-18
-- Security Model: RLS isolation + Vault encrypted secrets + single bootstrap function

-- -------------------------------------------------------------
-- 1. Tables Creation
-- -------------------------------------------------------------

-- Entities (Tenants)
create table entities (
  id                          uuid primary key default gen_random_uuid(),
  slug                        text not null unique,
  display_name                text not null,
  github_owner                text not null,
  github_repo                 text not null,
  github_branch               text not null default 'main',
  context_root                text not null default 'context',
  telegram_bot_username       text not null,
  excluded_thread_ids         bigint[] not null default '{}',
  telegram_bot_token_id       uuid references vault.secrets(id) on delete set null,
  telegram_webhook_secret_id  uuid references vault.secrets(id) on delete set null,
  github_token_id             uuid references vault.secrets(id) on delete set null,
  created_at                  timestamptz not null default now()
);

-- Telegram Groups (Access Points)
create table groups (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entities(id) on delete cascade,
  telegram_chat_id bigint not null unique,
  display_name    text,
  created_at      timestamptz not null default now()
);

-- Users (Per-tenant model, RLS isolated)
create table users (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entities(id) on delete cascade,
  telegram_user_id bigint not null,
  username      text,
  display_name  text,
  created_at    timestamptz not null default now(),
  unique (entity_id, telegram_user_id)
);

-- Memberships (Join users to groups and entities)
create table memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  group_id    uuid not null references groups(id) on delete cascade,
  entity_id   uuid not null references entities(id) on delete cascade,
  role        text not null default 'member',
  updated_at  timestamptz not null default now(),
  unique (user_id, group_id)
);

-- Manifest Entries (Topic -> Context Document Routing)
create table manifest_entries (
  id                 uuid primary key default gen_random_uuid(),
  entity_id          uuid not null references entities(id) on delete cascade,
  group_id           uuid references groups(id) on delete cascade,
  telegram_thread_id bigint,
  doc_path           text not null,
  created_at         timestamptz not null default now()
);

-- Document Cache (Git -> Postgres Sync Cache)
create table doc_cache (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entities(id) on delete cascade,
  doc_path    text not null,
  content     text not null,
  git_sha     text,
  synced_at   timestamptz not null default now(),
  unique (entity_id, doc_path)
);

-- Message Log
create table message_log (
  id                 bigserial primary key,
  entity_id          uuid not null references entities(id) on delete cascade,
  group_id           uuid not null references groups(id) on delete cascade,
  telegram_chat_id   bigint not null,
  telegram_thread_id bigint,
  telegram_user_id   bigint,
  username           text,
  message_text       text,
  is_command         boolean not null default false,
  is_bot_mention     boolean not null default false,
  created_at         timestamptz not null default now()
);

-- Processed Updates (Idempotency / Deduplication)
create table processed_updates (
  update_id   bigint primary key,
  entity_id   uuid not null references entities(id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 2. Indexes
-- -------------------------------------------------------------

create index idx_groups_entity_id on groups (entity_id);
create index idx_users_entity_id on users (entity_id);
create index idx_memberships_entity_id on memberships (entity_id);
create index idx_memberships_group_id on memberships (group_id);
create index idx_manifest_entries_entity_id on manifest_entries (entity_id);
create index idx_manifest_entries_lookup on manifest_entries (entity_id, telegram_thread_id);
create index idx_doc_cache_entity_id on doc_cache (entity_id);
create index idx_message_log_entity_id on message_log (entity_id);
create index idx_message_log_lookup on message_log (group_id, telegram_thread_id, created_at desc);
create index idx_message_log_telegram_user_id on message_log (telegram_user_id);
create index idx_processed_updates_created_at on processed_updates (created_at);

-- -------------------------------------------------------------
-- 3. Row-Level Security (RLS) Setup
-- -------------------------------------------------------------

alter table entities enable row level security;
alter table groups enable row level security;
alter table users enable row level security;
alter table memberships enable row level security;
alter table manifest_entries enable row level security;
alter table doc_cache enable row level security;
alter table message_log enable row level security;
alter table processed_updates enable row level security;

-- Force RLS so it applies even to table owners (though bypassrls roles like service_role will still bypass unless connected scoped)
alter table entities force row level security;
alter table groups force row level security;
alter table users force row level security;
alter table memberships force row level security;
alter table manifest_entries force row level security;
alter table doc_cache force row level security;
alter table message_log force row level security;
alter table processed_updates force row level security;

-- -------------------------------------------------------------
-- 4. Invariant: Allowed RLS-Bypass Functions (SECURITY DEFINER)
-- The database has exactly FOUR security definer bypass functions (including get_current_bot_secret).
-- No other RLS-bypassing functions should be added without security review.
-- -------------------------------------------------------------

-- 1. resolve_entity_id_by_slug:
-- Resolves an entity slug to its UUID. Used as RLS bootstrap for Telegram webhook.
create or replace function resolve_entity_id_by_slug(p_slug text)
returns uuid as $$
  select id from public.entities where slug = p_slug;
$$ language sql security definer set search_path = public;

-- 2. resolve_entity_id_by_repo:
-- Resolves repository owner/name to its matching UUID. Used as RLS bootstrap for GitHub sync.
create or replace function resolve_entity_id_by_repo(p_owner text, p_repo text)
returns uuid as $$
  select id from public.entities where github_owner = p_owner and github_repo = p_repo;
$$ language sql security definer set search_path = public;

-- 3. get_current_entity_secret:
-- Decrypts and returns a Vault secret ONLY if it is referenced by the current session entity.
-- Prevents broad Vault access by self-checking against app.current_entity_id.
create or replace function get_current_entity_secret(p_secret_id uuid)
returns text as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where ds.id = p_secret_id
    and exists (
      select 1 from public.entities e
      where e.id = nullif(current_setting('app.current_entity_id', true), '')::uuid
        and p_secret_id in (
          e.telegram_bot_token_id,
          e.telegram_webhook_secret_id,
          e.github_token_id
        )
    );
$$ language sql security definer set search_path = public, vault;

-- RLS Helper to set current entity in session config (security invoker)
create or replace function set_current_entity(entity_id uuid)
returns void as $$
begin
  perform set_config('app.current_entity_id', entity_id::text, true);
end;
$$ language plpgsql security invoker;

-- RLS Policies (Enforcing both USING and WITH CHECK to prevent cross-tenant writes)
create policy entity_isolation on entities
  as restrictive
  using (id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

create policy group_isolation on groups
  as restrictive
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

create policy membership_isolation on memberships
  as restrictive
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

create policy manifest_entry_isolation on manifest_entries
  as restrictive
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

create policy doc_cache_isolation on doc_cache
  as restrictive
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

create policy message_log_isolation on message_log
  as restrictive
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

create policy processed_update_isolation on processed_updates
  as restrictive
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

create policy user_isolation on users
  as restrictive
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- -------------------------------------------------------------
-- 5. Role & Privileges Configuration
-- -------------------------------------------------------------

-- Note: Ensure role bot_service is created before deploying
-- We explicitly do NOT grant SELECT on vault.decrypted_secrets to prevent un-scoped access.
-- The bot_service role can ONLY retrieve secrets via get_current_entity_secret.

-- Grant execution privileges on RLS helpers and bootstrap functions
grant execute on function resolve_entity_id_by_slug(text) to bot_service;
grant execute on function resolve_entity_id_by_repo(text, text) to bot_service;
grant execute on function get_current_entity_secret(uuid) to bot_service;
grant execute on function set_current_entity(uuid) to bot_service;

-- Grant base table and sequence privileges for RLS access
grant usage on schema public to bot_service;
grant select, insert, update, delete on all tables in schema public to bot_service;
grant usage, select on all sequences in schema public to bot_service;

-- Auto-apply privileges to any future tables/sequences created in the schema
alter default privileges in schema public
  grant select, insert, update, delete on tables to bot_service;
alter default privileges in schema public
  grant usage, select on sequences to bot_service;
