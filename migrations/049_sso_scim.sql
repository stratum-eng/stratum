-- Enterprise SSO (OIDC) + SCIM deprovisioning data model (#253).
--
-- `identities` is the single model for ALL external identities: OIDC SSO
-- logins, plus GitHub/Google OAuth (which today re-match by raw email string —
-- an account-takeover vector for dormant accounts). A row is keyed by the
-- stable (issuer, subject) pair so an email change at the provider can never
-- detach or hijack an account. Invariant enforced in storage code (not SQL):
-- at most one identity per (user_id, issuer).

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL CHECK(provider IN ('oidc','github','google')),
  -- Non-empty CHECKs: an IdP omitting `sub` must never collapse all of its
  -- users into a single ('issuer', '') row that re-points on every login.
  issuer TEXT NOT NULL CHECK(length(issuer) > 0),
  subject TEXT NOT NULL CHECK(length(subject) > 0),
  email TEXT NOT NULL,
  connection_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

-- One OIDC connection per org (org_id UNIQUE). `protocol` exists so SAML can
-- be added later without re-migrating; only 'oidc' ships. The client secret is
-- stored AES-GCM-encrypted (keyed off SSO_ENCRYPTION_SECRET), the SCIM bearer
-- token only as a SHA-256 hash. `email_domains` is a lowercased JSON array;
-- a connection cannot be enabled until they are DNS-TXT-verified
-- (domains_verified_at), because unverified domains + open org creation would
-- be an account-takeover primitive.
CREATE TABLE IF NOT EXISTS org_sso_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT UNIQUE NOT NULL REFERENCES orgs(id),
  protocol TEXT NOT NULL DEFAULT 'oidc' CHECK(protocol IN ('oidc')),
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  jwks_uri TEXT NOT NULL,
  email_domains TEXT NOT NULL,
  domains_verified_at TEXT,
  scim_token_hash TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Managed-membership + SCIM resource mapping: a user is managed by a
-- connection iff a row exists (created by SCIM provision/adopt or JIT login).
-- SCIM resource id = user_id. `active = 0` records a SCIM deactivation so
-- reactivation and cross-connection guards can reason about who disabled whom.
CREATE TABLE IF NOT EXISTS scim_members (
  connection_id TEXT NOT NULL REFERENCES org_sso_connections(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  scim_external_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_scim_members_user ON scim_members(user_id);

-- OIDC login state lives in D1 (not KV) for the same reason magic links moved
-- in migration 031: consumption must be a single atomic conditional UPDATE so
-- a state value can never be redeemed twice under a race. Rows are short-TTL
-- and purged opportunistically + by the scheduled cron.
-- `connection_id` is deliberately FK-free (like magic_links, 031): rows are
-- ephemeral and purge-friendly, and a state for a just-deleted connection
-- simply fails at consumption time.
CREATE TABLE IF NOT EXISTS oidc_login_states (
  state TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_to TEXT,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oidc_login_states_expires ON oidc_login_states(expires_at);

-- Reversible disable (SCIM deactivation), distinct from destructive
-- `deleting_at` (migration 026): credentials are made inert by enforcement
-- checks, not destroyed, so IdP unsuspend restores the account intact.
ALTER TABLE users ADD COLUMN disabled_at TEXT;

-- Schema drift fix: src/github/client.ts already reads/writes these columns,
-- but no migration ever created them. SQLite has no ADD COLUMN IF NOT EXISTS,
-- so before applying in any environment where they might have been hot-fixed
-- out of band, run `PRAGMA table_info(users)` and reconcile (drop the
-- out-of-band columns or mark this migration applied). Production evidence
-- says they don't exist: the reading code has silently error-caught since
-- migration 007.
ALTER TABLE users ADD COLUMN github_refresh_token TEXT;
ALTER TABLE users ADD COLUMN github_token_expires_at INTEGER;
