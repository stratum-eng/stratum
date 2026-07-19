-- Per-project backup cursor. The backup orchestrator snapshots repos oldest-
-- backed-up-first so an instance above MAX_REPOS_PER_RUN still covers every repo
-- across runs instead of re-snapshotting the same N each time.
CREATE TABLE IF NOT EXISTS backup_state (
  project_id TEXT PRIMARY KEY,
  last_backed_up_at TEXT
);
