-- Linking a GitHub App installation on the strength of CURRENT GitHub access (#442).
--
-- Migration 059 let whoever INSTALLED the app link the installation, a fact
-- recorded once from a webhook and never re-checked. Linking now sends the
-- person through the app's user-to-server OAuth and asks GitHub what they can
-- manage right now. Two short-lived tables carry that round trip. Neither ever
-- holds a GitHub token: the token lives only inside the callback request.

-- The CSRF `state` of one round trip, and what the person asked for before
-- they left for GitHub. Single-use and bound to the browser session that
-- started it: the row is deleted by the statement that reads it, so exactly
-- one callback can win, and a state presented on any other session is burned
-- without being honoured. Both the state and the session id are stored only as
-- SHA-256 hashes, so a database read yields nothing replayable.
--
-- `installation_id` NULL means the round trip only refreshes the list of
-- linkable installations (see the next table). `target_org_id` NULL means the
-- link target is the person's own account. No foreign keys, like
-- `oidc_login_states` (migration 049): rows live ten minutes, and one whose
-- user, session or org has since gone simply fails at the callback.
CREATE TABLE IF NOT EXISTS github_app_link_states (
  state_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  installation_id INTEGER,
  target_org_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_app_link_states_expires
  ON github_app_link_states(expires_at);

-- Which installations GitHub said this session's user could link, as of their
-- last round trip. DISPLAY ONLY: it decides which rows the setup page offers a
-- Link button on, never whether a link is allowed. Every link runs its own
-- round trip and re-checks GitHub, so a stale row here costs a refused click
-- and nothing else. Keyed by the hashed session so it dies with the session's
-- usefulness and is never shared between two browsers of the same account.
CREATE TABLE IF NOT EXISTS github_app_access_snapshots (
  session_hash TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_hash, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_github_app_access_snapshots_expires
  ON github_app_access_snapshots(expires_at);
