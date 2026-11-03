-- One canonical Stratum project per GitHub repository.
--
-- A project's source URL is set freely by its owner, so several projects can
-- name the same GitHub repo. Inbound webhook events (push, pull_request,
-- pull_request_review) and outbound writes (PR promotion, evaluation comments
-- and statuses) must agree on exactly one of them, and it must be a project
-- whose owner is authorized for the repo: linked to the GitHub App
-- installation that covers it (migration 059), or bound to the repo's GitHub
-- owner in the operator's allowlist (GITHUB_ALLOWED_OWNERS). See
-- src/github/repo-authorization.ts.
--
-- A row is claimed only after that authorization passes, so an unauthorized
-- project can never occupy a repo. It is replaced only when its holder no
-- longer exists or is no longer authorized, and deleted with the project.
-- `namespace` + `slug` locate the project in KV without scanning every entry.
CREATE TABLE IF NOT EXISTS github_repo_links (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  project_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner, repo)
);

CREATE INDEX IF NOT EXISTS idx_github_repo_links_project ON github_repo_links (project_id);
