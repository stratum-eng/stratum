-- SCIM auth does a per-request lookup by token hash
-- (getSsoConnectionByScimTokenHash); index the hashed column so that hot path
-- never scans org_sso_connections. Partial: connections without a SCIM token
-- (scim_token_hash NULL) can never authenticate and stay out of the index.
CREATE INDEX IF NOT EXISTS idx_org_sso_connections_scim_token_hash
  ON org_sso_connections(scim_token_hash)
  WHERE scim_token_hash IS NOT NULL;
