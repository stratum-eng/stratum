-- Per-project webhook subscriptions and their delivery log.
-- secret is the HMAC-SHA256 signing key for deliveries; it must remain
-- readable (not hashed) because every delivery is signed with it.

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhooks_project ON webhooks(project, active);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','failed')),
  status_code INTEGER,
  error TEXT,
  duration_ms INTEGER,
  created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_webhook
  ON webhook_deliveries(webhook_id, created_at DESC);
