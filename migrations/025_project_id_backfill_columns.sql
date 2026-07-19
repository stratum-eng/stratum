-- Project-identity unification (branch feat/deletion-cascade).
--
-- Seven project-scoped tables key rows by a bare `project` NAME column. Project
-- names are only unique per-namespace (`@alice/api` and `@bob/api` collide), so
-- a future cascade-delete keyed on the name is a cross-tenant data-loss risk.
--
-- This migration ADDS a nullable, globally-unique `project_id` (the UUID from the
-- KV ProjectEntry) to each table, plus an index for the eventual delete scan. It
-- is purely additive: the `project` column and every existing read stay unchanged
-- so the change is backward-compatible. New writes dual-write `project_id`.
--
-- No data backfill happens here: the name -> id mapping lives in KV, not D1, so
-- SQL cannot resolve it. Historical rows keep `project_id` NULL; the cascade must
-- treat NULL rows as name-based (with a collision guard). See
-- scripts/backfill-project-id.ts for the one-shot backfill notes.

ALTER TABLE changes ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_changes_project_id ON changes(project_id);

ALTER TABLE events ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_events_project_id ON events(project_id);

ALTER TABLE provenance ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_provenance_project_id ON provenance(project_id);

ALTER TABLE cost_records ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_cost_records_project_id ON cost_records(project_id);

ALTER TABLE commit_metrics ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_commit_metrics_project_id ON commit_metrics(project_id);

ALTER TABLE issues ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);

ALTER TABLE webhooks ADD COLUMN project_id TEXT;
CREATE INDEX IF NOT EXISTS idx_webhooks_project_id ON webhooks(project_id);
