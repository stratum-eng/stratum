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

### usage_periods

- owner_id, owner_type, period ('YYYY-MM' UTC), meter, source, quantity
- PK is `(owner_id, period, meter, source)`. `source` is in the key on purpose:
  `platform` and `byok` spend accumulate as separate rows, and an enforcement
  read sums the `platform` rows alone — a sum that omitted the filter would
  charge a project's own provider spend against its hosted allowance.
- Subject-keyed rather than project-keyed, so it survives the project-deletion
  cascade that hard-deletes `cost_records`; otherwise a month's usage would be
  refundable by deleting the project that incurred it. It joins the *account*
  deletion cascades instead, and is backed up in its own right because it is
  not recoverable by replaying `cost_records`.

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
