-- Migration: Raw Telegram Event Archive
-- Date: 2026-07-03

create table if not exists public.telegram_events (
  id           bigserial     primary key,
  bot_slug     text          not null,
  update_id    bigint,
  update_type  text,
  payload      jsonb         not null,
  created_at   timestamptz   not null default now()
);

-- Indexes
create index if not exists telegram_events_created_idx     on public.telegram_events (created_at);
create index if not exists telegram_events_update_type_idx on public.telegram_events (update_type);
create index if not exists telegram_events_update_id_idx   on public.telegram_events (update_id);
create index if not exists telegram_events_bot_slug_idx    on public.telegram_events (bot_slug);

-- RLS setup
alter table public.telegram_events enable row level security;
alter table public.telegram_events force row level security;

-- Idempotent RLS policy setup (Rule 5)
drop policy if exists telegram_events_insert on public.telegram_events;
create policy telegram_events_insert on public.telegram_events
  for insert with check (true);

-- Revoke default table privileges from public and non-admin roles (Rule 2)
revoke all on public.telegram_events from public;
revoke all on public.telegram_events from authenticated;
revoke all on public.telegram_events from anon;
revoke all on public.telegram_events from bot_service;

-- Grant INSERT only to bot_service
grant insert on public.telegram_events to bot_service;
