-- Relax the github_* columns on `entities` to nullable.
--
-- Context: v1 dropped GitHub from the content path (content is pushed directly
-- into doc_cache; see docs/PLANNING.md §2 revision). These columns were defined
-- NOT NULL when GitHub was the canonical content source, so v1 entity inserts had
-- to supply meaningless nominal values (a fake owner/repo/branch/context_root)
-- purely to satisfy the constraint. That's a wart and confuses onboarding.
--
-- This makes them nullable so v1 inserts can omit them. The columns are RETAINED
-- (not dropped) because the GitHub-sync code is kept as a future optional
-- sync-source; if/when that's enabled, these hold its config. (A later refactor
-- may move GitHub config into a dedicated `sync_sources` table entirely — see
-- BACKLOG — at which point these columns would be dropped.)
--
-- Nothing in the v1 read path uses these columns; only the dormant GitHub-sync
-- route (resolve_entity_id_by_repo + the sync handler) references them, and it
-- handles their absence fine (a null simply won't match a repo lookup).
--
-- Created At: 2026-06-24

alter table entities alter column github_owner   drop not null;
alter table entities alter column github_repo    drop not null;
alter table entities alter column github_branch  drop not null;
alter table entities alter column context_root   drop not null;
