-- Migration 072: how a credential's minter had authenticated (#441).
--
-- An org's "require a second factor" policy (#256) is checked against a
-- browser session's own factors, and since #428 against the session that
-- mints a credential. A credential minted BEFORE the policy was turned on, or
-- before its owner joined the org, carried no record of how it was minted, so
-- it kept reaching the org's projects.
--
-- Each credential now records what its minter had passed, in the same two
-- terms a session does (migration 056):
--   minted_second_factor  'passkey' | 'recovery_code' | NULL
--   minted_sso_org_id     the org whose IdP authenticated the minter, or NULL
-- and the policy is evaluated against those on every use, exactly as it is
-- for a session: a second factor satisfies every org, and an SSO sign-in
-- satisfies the org whose IdP it was.
--
-- A credential minted by another credential (an agent created with an API
-- key, a workspace git credential minted over MCP) copies its minter's values.
--
-- NULL on every existing row, which is the point: nothing is known about how
-- those were minted, so an org that requires a second factor stops honouring
-- them until they are minted again from a session that meets its policy.
-- Access to anything that org does not own is unchanged.
--
-- Additive only: nullable columns with no default rewrite, safe on a database
-- that already has every earlier migration applied.

-- Scoped API tokens, and workspace git credentials (purpose = 'workspace_git').
ALTER TABLE api_tokens ADD COLUMN minted_second_factor TEXT;
ALTER TABLE api_tokens ADD COLUMN minted_sso_org_id TEXT;

-- Agent tokens. A grant-only agent (credential = 'oauth_grant') has no token
-- of its own; its grant's row below governs it.
ALTER TABLE agents ADD COLUMN minted_second_factor TEXT;
ALTER TABLE agents ADD COLUMN minted_sso_org_id TEXT;

-- OAuth grants. Recorded on the authorization code at consent, and copied to
-- the grant when the code is redeemed. A grant keeps its row across refresh
-- rotations, so the values last as long as the grant does.
ALTER TABLE oauth_auth_codes ADD COLUMN minted_second_factor TEXT;
ALTER TABLE oauth_auth_codes ADD COLUMN minted_sso_org_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN minted_second_factor TEXT;
ALTER TABLE oauth_tokens ADD COLUMN minted_sso_org_id TEXT;

-- The legacy account key (`users.token_hash`), set when the key is rotated.
ALTER TABLE users ADD COLUMN token_minted_second_factor TEXT;
ALTER TABLE users ADD COLUMN token_minted_sso_org_id TEXT;
