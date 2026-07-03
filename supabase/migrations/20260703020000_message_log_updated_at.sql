-- Migration: Add updated_at column to message_log
-- Date: 2026-07-03

-- Add nullable updated_at column with no default (Rule 5: idempotent via if not exists)
alter table public.message_log add column if not exists updated_at timestamptz;
