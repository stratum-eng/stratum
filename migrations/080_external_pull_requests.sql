-- Migration 080: pull requests from the GitHub mirror, as external changes (#420).
--
-- In forge mode the GitHub repository is a read-only mirror, and people with
-- no Stratum account still open pull requests there. Each such pull request
-- becomes one change in status `external`: recorded, shown, and inert until a
-- maintainer imports it. `changes.status` has no CHECK constraint, so the new
-- status needs no schema change of its own.
--
-- `external_pull_requests` is everything about the pull request that is not
-- the change: one row per (project, pull request number), pointing at the
-- change that currently stands for it. It deliberately does NOT reuse the
-- `changes.github_*` columns. Those belong to layer mode, where Stratum opened
-- the pull request itself, and code keyed on them reports evaluation results
-- to GitHub and re-pushes branches there — none of which may happen to a pull
-- request a stranger opened.
--
-- Everything in this table that came from GitHub's webhook is attacker-chosen
-- text or a number GitHub computed about attacker-chosen content. Nothing here
-- is ever executed, interpolated into a command, or sent to a model.
--
--   * `head_sha` is the newest head GitHub reported. `imported_head_sha` is the
--     head the workspace actually holds. They differ while new commits wait for
--     a maintainer.
--   * `refusal_code` / `refusal_reason` say why the newest head cannot be
--     imported (too large, submodules, Git LFS, conflicts). Cleared when the
--     head moves.
--   * `agreement_confirmed_by` / `_at` record the maintainer who confirmed the
--     contributor agreement for the import, where the project requires it.
--   * `closure_state` drives closing the pull request on GitHub after the
--     change merges: `none` (nothing to do yet), `commented` (the link back to
--     Stratum is posted; GitHub is being given time to mark the pull request
--     merged by itself), `done`, `failed`.
--
-- The two `push_mirrors` columns are the per-project switches. Both default to
-- off: a mirror that existed before this migration does not start accepting
-- pull requests because the instance was upgraded.
--
-- Additive only.

CREATE TABLE IF NOT EXISTS external_pull_requests (
  project_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  change_id TEXT NOT NULL,
  repo_owner TEXT NOT NULL COLLATE NOCASE,
  repo_name TEXT NOT NULL COLLATE NOCASE,
  author_login TEXT NOT NULL,
  title TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  imported_head_sha TEXT,
  -- GitHub's own counts for the pull request, as last reported.
  commits INTEGER,
  changed_files INTEGER,
  refusal_code TEXT,
  refusal_reason TEXT,
  -- JSON array of {name, email}: the authors of the imported commits.
  commit_authors TEXT,
  agreement_confirmed_by TEXT,
  agreement_confirmed_at TEXT,
  imported_by TEXT,
  imported_at TEXT,
  pr_state TEXT NOT NULL DEFAULT 'open'
    CHECK (pr_state IN ('open', 'closed', 'merged')),
  closure_state TEXT NOT NULL DEFAULT 'none'
    CHECK (closure_state IN ('none', 'commented', 'done', 'failed')),
  closure_attempts INTEGER NOT NULL DEFAULT 0,
  closure_error TEXT,
  closure_comment_id INTEGER,
  closure_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, pr_number)
);

-- A change stands for at most one pull request; also the lookup from a change
-- page to its pull request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_pull_requests_change
  ON external_pull_requests (change_id);

-- The closure pass: pull requests whose change merged and which are not settled.
CREATE INDEX IF NOT EXISTS idx_external_pull_requests_closure
  ON external_pull_requests (closure_state, closure_updated_at);

ALTER TABLE push_mirrors ADD COLUMN accept_pull_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_mirrors ADD COLUMN require_contributor_agreement INTEGER NOT NULL DEFAULT 0;
