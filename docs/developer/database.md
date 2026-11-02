# Database Schema

## Tables

### users
- id, email, username, token_hash

### agents
- id, name, owner_id, token_hash

### changes
- id, project, workspace, status, eval_score

### eval_runs
- id, change_id, evaluator_type, score, passed

### import_jobs
- id, namespace, slug, status, progress

### api_tokens
- id, user_id, name, token_hash, token_prefix, scope, expires_at, revoked_at

### oauth_clients
- id (the client_id), client_secret_hash, client_name, redirect_uris, scope,
  token_endpoint_auth_method

### oauth_auth_codes
- code_hash, client_id, user_id, redirect_uri, scope, code_challenge, resource,
  expires_at, consumed_at

### oauth_tokens
- id, access_token_hash, refresh_token_hash, client_id, user_id, scope,
  access_expires_at, refresh_expires_at, revoked_at

Every secret in these tables is stored as a SHA-256 hash, and every expiry is
compared in JavaScript rather than SQL — this codebase stores both ISO and
`datetime('now')` timestamps, and `' '` sorts below `'T'`, so a SQL comparison
reads expired rows as live.
