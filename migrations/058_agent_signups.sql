-- Migration 058: agent-initiated signup.
--
-- An agent asks for an account on a human's behalf (POST /api/agent-signup).
-- The human approves by following an emailed link, which creates the account
-- exactly as a magic-link signup does. The agent, polling with a secret it was
-- handed at request time, then collects an agent token owned by that account.
--
-- The agent token is minted at COLLECT time, not at approval, so no usable
-- credential is ever stored here: the row holds only the hash of the poll
-- secret and, once approved, the id of the account the agent will belong to.
--
-- A request also carries a short user code, shown to the AGENT only, which
-- the human must type on the approval page (the OAuth device-flow pattern).
-- Without it, an agent could request an account for someone else's address
-- and hope they click "approve" on an email they didn't expect, leaving the
-- requester holding an agent token in the victim's new account. The code is
-- stored hashed; `code_attempts` caps guessing at five tries per request.
--
-- status: pending -> approved -> collected. Expiry is by timestamp, not by a
-- status write; an expired pending row is simply never approvable or
-- collectable. `collected` is set by a conditional UPDATE so two concurrent
-- polls cannot both mint a token.
CREATE TABLE IF NOT EXISTS agent_signups (
  id TEXT PRIMARY KEY,
  poll_token_hash TEXT NOT NULL UNIQUE,
  user_code_hash TEXT NOT NULL,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL,
  username TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_model TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'collected')),
  user_id TEXT,
  agent_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  collected_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_signups_expires ON agent_signups (expires_at);
