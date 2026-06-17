-- Commit/merge hot-path phase timings (ADR 004, Phase 0 instrumentation).
-- One row per merge attempt. Distinct from import_metrics on purpose: different
-- shape (per-phase spans, not a single value), different lifecycle.

CREATE TABLE IF NOT EXISTS commit_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  change_id TEXT NOT NULL,
  outcome TEXT NOT NULL,            -- 'fast_forward' | 'cold_fallback' | 'squash'
  conflict_mode TEXT,              -- 'none' | 'same' | NULL (benchmark context)
  concurrency_n INTEGER,           -- N concurrent writers during a bench run, or NULL

  -- Per-phase wall-clock spans in milliseconds. NULL when a phase did not run
  -- (e.g. project_clone is NULL on a fast-forward). Spans may include
  -- interleaved CPU and must NOT be summed into total_ms (see PhaseTimer docs).
  token_mint_ms REAL,
  project_clone_ms REAL,
  workspace_fetch_ms REAL,
  merge_ms REAL,
  push_ms REAL,
  ref_advance_ms REAL,
  d1_update_ms REAL,
  provenance_ms REAL,

  total_ms REAL NOT NULL,          -- end-to-end wall clock of the merge attempt
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- getCommitMetrics reads the most recent rows ordered by time; that's the only
-- query path today. Keep indexes minimal — this is a high-frequency write table,
-- so every extra index taxes the hot path. (Add a project index if/when a
-- per-project query is introduced.)
CREATE INDEX IF NOT EXISTS idx_commit_metrics_recorded_at ON commit_metrics(recorded_at);
