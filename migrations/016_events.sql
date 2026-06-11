-- Durable event outbox: one row per domain event, written before queue delivery.
-- The queue message carries only the event id; this row is the source of truth.
-- status: 'pending' until the consumer processes it, then 'processed';
-- 'failed' once attempts exhaust the retry budget.

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK(actor_type IN ('user','agent','system')),
  actor_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  processed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_events_project_created
  ON events(project, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_status_created
  ON events(status, created_at);
