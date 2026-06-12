-- Append-only audit trail for sensitive operations: authentication,
-- credential lifecycle, webhook configuration, and forced merges.

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user','agent','system')),
  actor_id TEXT,
  subject TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC);
