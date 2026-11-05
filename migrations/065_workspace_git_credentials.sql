-- Short-lived git credentials for one workspace's smart-HTTP remote (#408),
-- minted by the `stratum_workspace_remote` MCP tool.
--
-- Stored in `api_tokens` rather than a table of their own, so they inherit
-- everything that table already gets: the hash-only storage, soft revoke, the
-- account-deletion cascade (storage/deletion.ts deletes by user_id) and the D1
-- backup list. `binding_kind = 'project'` (#323) carries the project half of
-- the restriction; the columns below carry the rest.
--
-- `purpose` keeps the two kinds of row apart. Every row that exists before this
-- migration is an ordinary API token, hence the default. A `workspace_git` row
-- is never valid on the API: its plaintext carries the `stratum_git_` prefix,
-- which the API auth middleware does not accept, and `resolveApiToken` filters
-- on `purpose = 'api'` as well, so neither guard alone is load-bearing.
ALTER TABLE api_tokens ADD COLUMN purpose TEXT NOT NULL DEFAULT 'api'
  CHECK (purpose IN ('api', 'workspace_git'));

-- The one workspace the credential may fetch from and push to. Workspaces have
-- no stable id (they are addressed as project id + name in KV), so the
-- workspace's `createdAt` is recorded too: a workspace deleted and re-created
-- under the same name within the credential's lifetime is a different
-- workspace, and the credential must not follow the name to it.
ALTER TABLE api_tokens ADD COLUMN workspace_name TEXT;
ALTER TABLE api_tokens ADD COLUMN workspace_created_at TEXT;

-- The credential that minted this one. Checked on EVERY use, so revoking (or
-- the expiry of) the parent kills the child at once instead of when the child
-- expires: the child cannot outlive its grant.
--   api_token    -> api_tokens.id
--   oauth_grant  -> oauth_tokens.id
--   agent        -> agents.id
--   legacy_token -> the leading 16 hex characters of users.token_hash at mint
--                   time; rotating or disabling the legacy key changes the
--                   hash, which is how the child notices.
-- No foreign key: the parent rows live in three tables, and a missing parent
-- must read as "dead parent", which the resolver does.
ALTER TABLE api_tokens ADD COLUMN parent_kind TEXT
  CHECK (parent_kind IN ('api_token', 'oauth_grant', 'agent', 'legacy_token'));
ALTER TABLE api_tokens ADD COLUMN parent_id TEXT;
