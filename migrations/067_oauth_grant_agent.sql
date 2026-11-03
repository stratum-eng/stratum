-- Bind an agent identity to an MCP OAuth grant (#409, ADR 009).
--
-- Until now an OAuth grant always acted as the user who consented, so work done
-- over MCP carried no agent identity and its provenance was empty. The consent
-- screen now lets the user pick which identity the client acts as: themselves
-- (the old behaviour), one of their existing agents, or a new agent created
-- for this connection.
--
-- Every column is added NULLable (or with a default), so a database that
-- already has every earlier migration applied keeps every existing row valid:
-- a grant with no `agent_id` is exactly the grant it was before, and keeps
-- acting as the user.

-- The identity the user chose on the consent screen, carried on the code from
-- consent to redemption. At most one of the two is set:
--   agent_id       an existing agent the consenting user owns;
--   new_agent_name a new agent to create when the code is redeemed. Created at
--                  redemption rather than at consent so a code that is never
--                  redeemed leaves no agent behind.
-- Both NULL means "act as me".
ALTER TABLE oauth_auth_codes ADD COLUMN agent_id TEXT;
ALTER TABLE oauth_auth_codes ADD COLUMN new_agent_name TEXT;

-- The agent this grant authenticates as. NULL = acts as the user.
--
-- Deliberately no REFERENCES agents(id): a foreign key would make deleting an
-- agent fail while any grant (even a revoked one, which is kept for audit)
-- still names it. The resolver LEFT JOINs agents instead and fails CLOSED when
-- the agent is gone or no longer owned by the grant's user, so deleting the
-- agent ends the grant's access without needing the constraint.
ALTER TABLE oauth_tokens ADD COLUMN agent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_agent ON oauth_tokens(agent_id);

-- How an agent authenticates.
--   'token'       a `stratum_agent_` token, minted by POST /api/agents. Every
--                 agent that exists before this migration is one.
--   'oauth_grant' created on the consent screen for one connection. It has NO
--                 token of its own: its `token_hash` is the hash of a random
--                 value that was never revealed to anyone, and the agent-token
--                 lookup refuses these rows outright. Its only way in is an
--                 OAuth grant bound to it, so its access lives exactly as long
--                 as that grant does.
ALTER TABLE agents ADD COLUMN credential TEXT NOT NULL DEFAULT 'token'
  CHECK (credential IN ('token', 'oauth_grant'));
