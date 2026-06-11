-- Per-change resource cost samples: estimated LLM tokens, sandbox runtime,
-- and git/Artifacts operations. Aggregated for display on the change page.

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  change_id TEXT,
  workspace TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('llm_tokens','sandbox_ms','git_ops')),
  quantity REAL NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_costs_change ON cost_records(change_id);

CREATE INDEX IF NOT EXISTS idx_costs_project
  ON cost_records(project, created_at DESC);
