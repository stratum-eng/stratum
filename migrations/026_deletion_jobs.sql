-- Durable deletion jobs (project + account erasure, PRD .claude/ship/PRD.md).
--
-- Both deletion kinds run as a D1-backed state machine driven by the */5 sweep,
-- never a best-effort synchronous request that can half-finish. The row carries
-- the full captured DeletionTarget JSON so a re-drive after a partial cascade
-- still knows about FK children whose parents are already gone, plus a
-- checkpoint/heartbeat/lease so two drivers can't run the same cascade.

CREATE TABLE IF NOT EXISTS deletion_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('project','account')),
  target TEXT NOT NULL,            -- JSON DeletionTarget (or account target)
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','verifying','completed','incomplete')),
  checkpoint TEXT,                 -- last completed step key
  heartbeat_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  residuals TEXT,                  -- JSON string[]
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deletion_jobs_state ON deletion_jobs(state);

-- Account soft-deleting marker (bounded grace window; used by later tasks).
ALTER TABLE users ADD COLUMN deleting_at TEXT;
