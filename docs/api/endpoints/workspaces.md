# Workspaces API

## List Workspaces
`GET /api/workspaces/{namespace}/{slug}/workspaces`

## Create Workspace
`POST /api/workspaces/{namespace}/{slug}/workspaces`

## Commit Changes
`POST /api/workspaces/{name}/commit`

## Mint a Workspace Remote Credential
`POST /api/workspaces/{namespace}/{slug}/workspaces/{name}/remote-credential`

Returns the workspace's git remote and a short-lived `stratum_git_` credential
for it. Backs the MCP tool `stratum_workspace_remote`; see
[Pushing from a local checkout](../../user-guide/mcp.md#pushing-from-a-local-checkout).

```bash
curl -X POST https://stratum.example.com/api/workspaces/@acme/billing/workspaces/fix-retries/remote-credential \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expiresInMinutes": 30}'
# → 201 {"remote":"https://stratum.example.com/@acme/billing/workspaces/fix-retries.git",
#        "username":"stratum","token":"stratum_git_…","expiresAt":"…",
#        "credentialId":"tok_…","branches":["main","fix-retries"], …}
```

- **What it can do:** `git fetch` and `git push` on that one workspace, nothing
  else. It is refused on the project URL, on every other workspace, and on the
  whole API, `/mcp` included.
- **How long it lasts:** `expiresInMinutes`, 5 to 60, default 60. Never longer
  than the credential that minted it, and it stops working the moment that
  credential is revoked or expires (or, for the legacy key, is rotated or
  disabled; for an agent token, the agent is revoked).
- **Who may mint it:** a `read_write` API token, an `mcp:write` OAuth grant, an
  agent token, or the legacy key, held by someone who can push to the workspace
  (its creator or a project admin). A read-only credential gets `403
  TOKEN_SCOPE_INSUFFICIENT`; a browser session gets `403 TOKEN_REQUIRED`; every
  other refusal is a `404`.
- **Limits:** 20 live credentials per user (`409 TOKEN_LIMIT_REACHED`).
- **Audit:** each mint is recorded as `workspace_remote.credential_minted`, with
  the workspace, the expiry and the kind of credential that minted it. A refused
  use of an expired or revoked credential is recorded as `auth.failed` with
  method `workspace_git_token`. The secret itself is never logged or stored.
