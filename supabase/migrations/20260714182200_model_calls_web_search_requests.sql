alter table public.model_calls
  add column if not exists web_search_requests integer not null default 0;
