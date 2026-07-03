-- Migration: Edited Message Sync Column & Index
-- Date: 2026-07-03

-- Add nullable telegram_message_id column (Rule 5: idempotent via if not exists)
alter table public.message_log add column if not exists telegram_message_id bigint;

-- Add partial index for fast edit lookup
create index if not exists message_log_chat_msg_id_partial_idx
on public.message_log (telegram_chat_id, telegram_message_id)
where telegram_message_id is not null;
