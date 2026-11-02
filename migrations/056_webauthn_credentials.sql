-- Migration 056: WebAuthn passkeys as a second factor, recovery codes, and the
-- org policy that requires them (#256).
--
-- Timestamps are ISO 8601 strings written by the application, NOT
-- `datetime('now')`, for the reason 042/044/047 give: the two formats sort
-- differently as TEXT, and a column mixing them breaks every comparison over it.
--
-- Rollback: drop the two tables. The added columns are inert when unused
-- (SQLite cannot drop a column cheaply, and no reader requires them).

-- One row per registered authenticator. `credential_id` and `public_key` are
-- base64url — the public key is the COSE-encoded key the authenticator returned
-- at registration, and is not a secret. `counter` is the last signature counter
-- seen; an assertion whose counter does not advance is refused (a cloned
-- authenticator), except for authenticators that always report 0.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  -- JSON array of AuthenticatorTransport strings, or NULL when not reported.
  transports TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- One-time recovery codes, issued at first passkey registration (and on
-- regeneration). Stored as SHA-256 hashes only; the plaintext is shown once.
-- `used_at` is set by a conditional UPDATE so a code can be spent exactly once.
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  UNIQUE (user_id, code_hash)
);

-- The org policy. Org settings live on the `orgs` row itself (there is no
-- separate settings table). 0/1 boolean.
ALTER TABLE orgs ADD COLUMN require_second_factor INTEGER NOT NULL DEFAULT 0;

-- How a browser session was established. `second_factor` is 'passkey' or
-- 'recovery_code' when the session passed a second factor, NULL otherwise.
-- `sso_org_id` is the org whose IdP authenticated the session (OIDC sign-in);
-- that org's own second-factor requirement is delegated to its IdP.
ALTER TABLE sessions ADD COLUMN second_factor TEXT;
ALTER TABLE sessions ADD COLUMN sso_org_id TEXT;

-- The session lookup checks "is this user in any org that requires a second
-- factor" on every session request; org_members is keyed (org_id, user_id), so
-- the user-side lookup needs its own index.
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
