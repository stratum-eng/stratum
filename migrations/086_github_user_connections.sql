-- Opening promoted pull requests as the person promoting, not as the app.
--
-- GitHub makes a pull request's author whoever's token created it. Promotion
-- used the app's installation token, so every pull request Stratum opened was
-- authored by the app's bot: tools that key on the author (review seats,
-- "the author cannot approve") saw a bot, not the person responsible.
--
-- A person who chooses to connect their GitHub account lets Stratum keep a
-- user-to-server token for the GitHub App and open their promotions as them.
-- This is the first table to hold a GitHub USER token at rest. Both tokens are
-- AES-GCM ciphertext under `GITHUB_USER_TOKEN_SECRET`; without that secret the
-- feature is off and nothing is written here.
--
-- One row per Stratum user. `access_expires_at` / `refresh_expires_at` are
-- epoch seconds, NULL when the app is configured for tokens that do not
-- expire (GitHub then issues no refresh token either).
--
-- `refresh_lease_until` serialises refreshing: a refresh token is single-use,
-- so of two promotions that both find the access token expired exactly one
-- may spend it. The other opens its pull request as the app that once.
CREATE TABLE IF NOT EXISTS github_user_connections (
  user_id TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  access_expires_at INTEGER,
  refresh_expires_at INTEGER,
  refresh_lease_until INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A revoked authorization arrives from GitHub naming the GitHub user.
CREATE INDEX IF NOT EXISTS idx_github_user_connections_github_user
  ON github_user_connections(github_user_id);

-- The round trip that links an installation and the one that connects an
-- account share a callback URL (GitHub allows the app one) and so share the
-- state table. 'link' is every row that existed before this migration.
ALTER TABLE github_app_link_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'link';
