### Added
- **Import a repository straight into an organization.** `POST /api/projects/@org/repo/import`
  now accepts an organization namespace when you have write access to that organization
  (an org admin, or a member of a team with write permission), and the project is owned by
  the organization, as if it had been created with `"org"`. A read-only member, a
  non-member, or an organization that doesn't exist gets `403`. Retrying, cancelling and
  deleting the import, and manually syncing the project, follow the same rule. A private
  import counts toward the private-project limit just as creating one there does.
- **MCP tools to create and import projects.** `stratum_create_project` and
  `stratum_import_project` (both with an optional `org`) and `stratum_get_import_status`.
- **MCP tools for the rest of the change loop.** `stratum_evaluate_change` re-runs a
  change's gates, `stratum_comment_change` and `stratum_list_change_comments` give agents
  their feedback channel, `stratum_promote_change` opens the GitHub PR,
  `stratum_get_sync_status` and `stratum_sync_project` keep an imported project current,
  and `stratum_list_branches` lists branches.
- **MCP tools for organizations.** `stratum_create_org`, `stratum_list_orgs`,
  `stratum_get_org`, `stratum_add_org_member`, `stratum_remove_org_member`,
  `stratum_create_team`, `stratum_list_teams` and `stratum_add_team_member`. They call the
  same routes as the REST API, so the same people can do the same things. A read-only
  (`mcp:read`) grant can use every list and get tool but none of the tools that change
  anything.
- `GET /api/users/me` now includes the caller's `username`.

### Changed
- The OAuth consent screen now lists what a read-write MCP grant covers, including project
  creation and import and organization management.
