-- Scoped, expiring API tokens (#254).
--
-- Replaces the single `users.token_hash` credential with a table of named,
-- independently revocable tokens. The old column stays for a migration window:
-- it still authenticates (as read_write) so this deploys without an outage, and
-- a user can disable it explicitly once their scoped tokens are in place.
--
-- Timestamps are ISO 8601 strings written by the application, NOT
-- `datetime('now')`. The two formats sort differently (' ' < 'T'), so mixing
-- them in a comparison makes an expired token read as unexpired — expiry is
-- therefore always compared in JavaScript, never in SQL.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  -- The leading, non-secret portion of the token, so a listing can identify an
  -- unlabelled credential sitting in someone's CI config. Never the whole token.
  token_prefix TEXT NOT NULL,
  -- CHECK, plus a resolver that treats anything other than 'read_write' as
  -- read-only, so a malformed row fails closed instead of becoming a token that
  -- is neither.
  scope TEXT NOT NULL CHECK (scope IN ('read', 'read_write')),
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  -- Soft revoke: the row survives so the audit trail can still name the token.
  revoked_at TEXT
);

-- No index on token_hash: the UNIQUE constraint above already creates one, and
-- that is what the authentication hot path's lookup by hash uses.
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
