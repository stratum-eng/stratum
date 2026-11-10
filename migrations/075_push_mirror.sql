-- Migration 075: push mirror of a project's default branch and tags (#417).
--
-- One row per project that mirrors to a GitHub repository. The row is three
-- things at once, deliberately:
--
--   * the configuration an admin set (target repo, enabled);
--   * the status the settings page and the sync status API show (state, last
--     pushed commit, last attempt, last error);
--   * the work queue. `requested_seq` is bumped by everything that moves the
--     project's refs; `pushed_seq` is the value of `requested_seq` a completed
--     push started from. Work is pending exactly when the first is ahead of the
--     second, so a queue message is only ever a nudge: a lost or duplicated
--     message changes when a push happens, never whether it does. The mirror
--     always pushes the branch as it is NOW, which is what lets two merges in
--     quick succession collapse into one push that ends at the later one.
--
-- `lease_expires_at` is the mutual exclusion between pushes for one project. A
-- run claims it with a conditional UPDATE and a crashed run's claim expires, so
-- no row is ever stuck `pushing`.
--
-- `state = 'diverged'` is sticky: nothing but an admin's resume clears it. The
-- mirror never force-pushes, so a target that is no longer an ancestor of the
-- project has to be looked at by a person.
--
-- `namespace` + `slug` locate the project in KV from a queue consumer without
-- scanning every entry, the same reason `github_repo_links` carries them.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS push_mirrors (
  project_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  -- Kept as the admin typed them, because GitHub's API is handed the name
  -- verbatim, and compared case-insensitively, because GitHub treats
  -- `Acme/Widgets` and `acme/widgets` as one repository. NOCASE makes every
  -- comparison of these columns — the unique index below included — agree.
  repo_owner TEXT NOT NULL COLLATE NOCASE,
  repo_name TEXT NOT NULL COLLATE NOCASE,
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle', 'pushing', 'ok', 'retrying', 'failed', 'diverged')),
  requested_seq INTEGER NOT NULL DEFAULT 0,
  pushed_seq INTEGER NOT NULL DEFAULT 0,
  -- Consecutive failed attempts since the last success or the last request.
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_expires_at TEXT,
  last_pushed_sha TEXT,
  last_pushed_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  configured_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One mirror per GitHub repository: two projects pushing fast-forward-only to
-- the same branch would each see the other as divergence.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_mirrors_repo
  ON push_mirrors (repo_owner, repo_name);

-- The five-minute sweep's lookup: enabled mirrors with work outstanding.
CREATE INDEX IF NOT EXISTS idx_push_mirrors_pending
  ON push_mirrors (enabled, state, next_attempt_at);
