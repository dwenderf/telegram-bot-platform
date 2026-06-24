-- Add bot-response logging support to message_log:
--   is_bot_response  — marks a row as the bot's own outgoing answer (vs a user message)
--   summary          — optional short summary of a LONG bot response (Phase 2; null for now
--                      and for all user messages / short responses)
--   generation_metadata — provenance for a bot response: how it was produced
--                      ({model, context_doc_paths, history_message_ids, thread_id,
--                        token_counts?, latency_ms?}). null for user messages.
--
-- All additive + nullable (is_bot_response has a default), so existing inserts and
-- rows are unaffected. No RLS change (message_log policy already covers new columns).
-- Created At: 2026-06-25

alter table message_log
  add column is_bot_response   boolean not null default false,
  add column summary           text,
  add column generation_metadata jsonb;

-- Optional: a partial index to fetch a thread's bot responses quickly (small, harmless).
-- /recap and history retrieval filter by group_id+thread+created_at (already indexed by
-- idx_message_log_lookup); this just speeds bot-only scans if ever needed.
create index idx_message_log_bot_responses
  on message_log (group_id, telegram_thread_id, created_at desc)
  where is_bot_response = true;
