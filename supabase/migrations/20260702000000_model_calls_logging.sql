-- Migration: 20260702000000_model_calls_logging.sql
-- Create model_calls table for usage tracking

create table if not exists public.model_calls (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references public.entities(id) on delete cascade,
  group_id              uuid references public.groups(id)  on delete set null,
  thread_id             uuid references public.threads(id) on delete set null,
  bot_id                uuid references public.bots(id)    on delete set null,
  call_type             text not null,                                          -- 'answer' | 'recap'
  model                 text not null,                                          -- actual model served
  provider              text not null default 'anthropic',
  input_tokens          integer,
  output_tokens         integer,
  cache_read_tokens     integer,
  cache_creation_tokens integer,
  metadata              jsonb,
  created_at            timestamptz not null default now()
);

-- Enable RLS and force it
alter table public.model_calls enable row level security;
alter table public.model_calls force row level security;

-- Policy (similar to threads/message_log)
drop policy if exists model_call_isolation on public.model_calls;
create policy model_call_isolation on public.model_calls
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- Grant privileges for bot_service role
grant select, insert on public.model_calls to bot_service;

-- Provision index
create index if not exists model_calls_entity_created_idx on public.model_calls (entity_id, created_at);
create index if not exists model_calls_created_idx on public.model_calls (created_at);
