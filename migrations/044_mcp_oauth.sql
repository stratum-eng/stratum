-- OAuth 2.1 authorization server for the remote MCP endpoint (#349).
--
-- MCP clients cannot be pre-registered: an editor discovers the server from a
-- URL the user pastes and registers itself on the spot (RFC 7591). So the
-- client table is written by unauthenticated callers, and every constraint that
-- matters — exact redirect-URI match, PKCE, short code lifetimes — has to hold
-- against a client that anyone could have created.
--
-- Timestamps are ISO 8601 strings written by the application, NEVER
-- `datetime('now')`. The two formats sort differently (' ' < 'T'), so a mixed
-- comparison reads an expired credential as live; expiry is therefore always
-- compared in JavaScript, exactly as `api_tokens` does (see 042).

-- A dynamically registered MCP client. `id` IS the client_id — public, quotable
-- in a redirect, and useless without either a secret or a PKCE verifier.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  -- NULL for a public client (the normal MCP case: a desktop editor that cannot
  -- keep a secret and authenticates the exchange with PKCE instead).
  client_secret_hash TEXT,
  client_name TEXT NOT NULL,
  -- JSON array of exact redirect URIs. Matched byte-for-byte at /authorize and
  -- again at /token; no prefix or wildcard matching, which is the open-redirect
  -- that turns an authorization code into someone else's session.
  redirect_uris TEXT NOT NULL,
  -- Space-delimited scopes this client may ever ask for.
  scope TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  created_at TEXT NOT NULL
);

-- One in-flight authorization code. Stored as a HASH: a code is a bearer
-- credential for the seconds it lives, and this table is read by an
-- unauthenticated endpoint.
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  -- PKCE is REQUIRED, not optional: OAuth 2.1 drops the implicit flow and makes
  -- S256 mandatory for public clients, and every MCP client is one. NOT NULL
  -- here so a code without a challenge cannot be written at all.
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  -- RFC 8707 resource indicator, echoed from /authorize and re-checked at
  -- /token so a code minted for this server cannot be replayed at another.
  resource TEXT,
  expires_at TEXT NOT NULL,
  -- Single-use. The row is kept after redemption rather than deleted so a
  -- replay is detected as a replay (and revokes the issued token) instead of
  -- looking indistinguishable from an expired code.
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expiry ON oauth_auth_codes(expires_at);

-- An issued access/refresh token pair. One row per grant; refresh rotation
-- rewrites the hashes in place so a grant keeps one identity (and one row) for
-- its whole life, which is what makes "revoke this client's access" a single
-- update rather than a walk of a token chain.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL UNIQUE,
  -- NULL once rotation has retired it, or when the grant never had one.
  refresh_token_hash TEXT UNIQUE,
  -- The hash rotation just retired. Kept so that presenting an OLD refresh
  -- token is DETECTABLE rather than merely unknown: OAuth 2.1 §4.3.1 and
  -- RFC 9700 §4.14 both say a server that rotates refresh tokens should treat
  -- reuse of a retired one as a compromise signal and revoke the grant. Without
  -- this column the reuse is indistinguishable from a random bad token, so the
  -- stolen half keeps working until the user revokes by hand.
  previous_refresh_token_hash TEXT,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Space-delimited. Narrowed to the api_tokens vocabulary at authentication
  -- time: anything without 'write' authenticates as read-only.
  scope TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  -- Soft revoke, like api_tokens: the row survives so a revoked grant can still
  -- be named in an audit trail.
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
