### Added
- **`stratum_workspace_remote`: push to a workspace from a local checkout over MCP.**
  The new MCP tool (and `POST /api/workspaces/{namespace}/{slug}/workspaces/{name}/remote-credential`
  behind it) returns the workspace's git remote and a short-lived `stratum_git_`
  credential, so an agent can `git push` instead of sending whole files through
  `stratum_commit`, with no long-lived token set up out of band. The credential works
  only for `git fetch` and `git push` on that one workspace, and is refused on the
  project URL, other workspaces, the REST API and `/mcp`. It lasts an hour at most,
  never outlives the credential that minted it, and stops working the moment that
  credential is revoked. Minting needs write access (an `mcp:read` grant is refused)
  and is audited as `workspace_remote.credential_minted`. Requires D1 migration 065.
