-- Sync history log: one row per completed sync operation.
-- No FK to projects — orphan rows are cleaned up by a future TTL sweep.
-- Rows are inserted only on completion (no in-progress rows), so started_at
-- is captured by the caller and passed in at record time.

CREATE TABLE IF NOT EXISTS sync_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','webhook','auto')),
  status TEXT NOT NULL CHECK(status IN ('success','failed','skipped')),
  commits_synced INTEGER NOT NULL DEFAULT 0,
  synced_commit TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  started_at DATETIME NOT NULL,
  completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_sync_history_ns_slug
  ON sync_history(namespace, slug, started_at DESC);
