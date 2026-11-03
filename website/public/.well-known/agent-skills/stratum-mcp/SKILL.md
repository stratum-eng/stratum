---
name: stratum-mcp
description: Connect an MCP-capable agent or editor to Stratum and use its tools for the full evaluation-gated change flow.
license: MIT
homepage: https://docs.usestratum.dev/guides/getting-started/
---

# Using Stratum over MCP

Stratum serves MCP directly from its Worker, at `/mcp`. There is nothing to
install. The machine-readable server card lives at
https://docs.usestratum.dev/.well-known/mcp/server-card.json.

## Connect

Remote server over streamable HTTP:

```json
{
  "mcpServers": {
    "stratum": {
      "type": "http",
      "url": "https://app.usestratum.dev/mcp"
    }
  }
}
```

Authorization is OAuth 2.1 with dynamic client registration and PKCE: call
`/mcp` with no credential, follow the `WWW-Authenticate` header to
`/.well-known/oauth-protected-resource`, register at `/oauth/register`, and send
the user to `/oauth/authorize` in a browser. Nothing needs configuring first.

If you are a headless agent with no browser, send a bearer token instead — a
user token (`stratum_user_...`) or an agent token (`stratum_agent_...`). Prefer
an agent token: your writes are then attributed to the agent in provenance.

Call `stratum_whoami` first — but read its answer carefully. On a user
credential (an OAuth grant, or a `stratum_user_` token) it returns your account.
On an **agent token it returns 401, and that is the expected answer**, not a
misconfiguration: the endpoint behind it is user-only. A 401 here means you are
an agent, so plan for `stratum_review_change`, `stratum_merge_change`,
`stratum_reject_change`, `stratum_update_issue`, `stratum_evaluate_change`,
`stratum_promote_change`, project creation, import and sync, and org changes to
be refused, and address
projects by `namespace/slug` rather than through `stratum_list_projects`, which
returns an empty list for you.

## Tools

| Tool | Use it for |
|---|---|
| `stratum_whoami` | Confirm identity and whether you are a human or agent principal |
| `stratum_get_usage` | Read this account's metered usage and limits before you spend them — on an agent token it reports your owner's allowance, which is the one your evaluations are charged to. Read-only: nothing raises a limit or buys capacity. |
| `stratum_list_projects`, `stratum_get_project` | Find the project and read its settings |
| `stratum_list_files`, `stratum_get_file` | Read the tree and file contents, including `.stratum/policy.yaml` |
| `stratum_list_workspaces`, `stratum_create_workspace` | Fork an isolated workspace to work in |
| `stratum_commit` | Commit files to your workspace |
| `stratum_create_change` | Open a change — **this runs every evaluation gate synchronously and returns each verdict** |
| `stratum_list_changes`, `stratum_get_change` | Read evaluation evidence and cost records |
| `stratum_review_change` | Human-only. Rejected for agent tokens. |
| `stratum_merge_change`, `stratum_reject_change` | Land or abandon a change |
| `stratum_list_issues`, `stratum_create_issue`, `stratum_update_issue` | Track work |
| `stratum_get_activity` | Read the project activity feed |
| `stratum_list_branches` | List a project's branches |
| `stratum_comment_change`, `stratum_list_change_comments` | Your feedback channel on a change — agent tokens may comment, even though they cannot review |
| `stratum_evaluate_change` | Re-run a change's gates after pushing more commits. User credentials only. |
| `stratum_promote_change` | Open the GitHub PR for an accepted change. User credentials only. |
| `stratum_create_project`, `stratum_import_project` | Create a project, or import one from GitHub/GitLab/Bitbucket — into your namespace or, with `org`, an organization you can write to. User credentials only. |
| `stratum_get_import_status`, `stratum_get_sync_status` | Follow an import, or read an imported project's sync state. Needs read access to the project (write access while an import is unfinished); agent tokens may use them. |
| `stratum_sync_project` | Pull new commits from an imported project's source. User credentials only. |
| `stratum_create_org`, `stratum_list_orgs`, `stratum_get_org`, `stratum_add_org_member`, `stratum_remove_org_member`, `stratum_create_team`, `stratum_list_teams`, `stratum_add_team_member` | Organization administration. Changes need an org admin's user credential, except that any member may remove themselves with `stratum_remove_org_member` (the org's owner cannot leave). |

## The loop that works

1. `stratum_whoami`
2. `stratum_get_file` on `.stratum/policy.yaml` — know the gates before you write
3. `stratum_create_workspace`
4. `stratum_commit`
5. `stratum_create_change` — read every verdict in the response
6. If a gate failed, fix it and go back to step 4. Do not retry the merge.
7. When green, hand it to a human for review. `stratum_review_change` will refuse
   an agent token, by design; leave your notes with `stratum_comment_change`.
8. After a human approves, `stratum_merge_change`.

## Constraints to respect

- Agent tokens can never approve a change, on any surface. There is no flag.
- Merges are rejected when a required evaluator is failing, approvals are short,
  or the workspace advanced after evaluation.
- The secret scanner is always on and always blocking.
- An OAuth grant scoped `mcp:read` is refused on every write, before routing.
  Ask for `mcp:write` at authorization time if you intend to commit.
- OAuth grants cannot reach `/api/admin/*` and cannot mint the legacy API key,
  whatever scope was granted.

## Reference

- Server card: https://docs.usestratum.dev/.well-known/mcp/server-card.json
- Authentication: https://docs.usestratum.dev/reference/authentication/
- Guide: https://docs.usestratum.dev/guides/mcp/
- Source: https://github.com/stratum-eng/stratum/tree/main/src/mcp
