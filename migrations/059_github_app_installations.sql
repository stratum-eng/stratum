-- GitHub App installations, and which Stratum owner each one serves.
--
-- An installation token can act on every repo in the installation. Without
-- this table, any Stratum user who pointed a project's source URL at such a
-- repo could make Stratum push, open PRs, and post statuses there with the
-- app's credentials — the app would be a confused deputy across tenants. So a
-- project may use an installation only when the installation is linked to the
-- project's owner here (or an operator binding in GITHUB_ALLOWED_OWNERS names
-- the project's owner for the repo's GitHub owner; see
-- src/github/repo-authorization.ts).
--
-- Rows are written by the signed `installation` / `installation_repositories`
-- webhooks, never from a URL parameter: `installer_github_id` is the GitHub
-- user who installed the app (the event's `sender`). Linking requires the
-- Stratum user's OAuth-verified `users.github_id` to equal it — or, for an
-- installation on a personal account, to equal that account — which is the
-- proof that the person linking controls the installation.
--
-- One Stratum owner per installation: an owner column pair, not a join table.
-- Both NULL = installed but not linked, which grants nothing.
CREATE TABLE IF NOT EXISTS github_app_installations (
  installation_id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL,
  installer_github_id TEXT,
  suspended_at TEXT,
  stratum_owner_type TEXT CHECK (stratum_owner_type IN ('user', 'org')),
  stratum_owner_id TEXT,
  linked_by_user_id TEXT,
  linked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((stratum_owner_type IS NULL) = (stratum_owner_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_github_app_installations_owner
  ON github_app_installations (stratum_owner_type, stratum_owner_id);

CREATE INDEX IF NOT EXISTS idx_github_app_installations_installer
  ON github_app_installations (installer_github_id);
