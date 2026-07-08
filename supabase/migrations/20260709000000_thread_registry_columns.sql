-- Migration: 20260709000000_thread_registry_columns.sql (additive, nullable)
alter table public.threads
  add column if not exists name                 text,
  add column if not exists icon_color           integer,
  add column if not exists icon_custom_emoji_id text;
