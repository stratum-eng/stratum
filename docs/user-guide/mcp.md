# The Stratum MCP server

Stratum serves [MCP](https://modelcontextprotocol.io/) directly from the Worker
at **`/mcp`**, so any MCP-capable agent or editor — Claude Code, Cursor, Zed,
Copilot, custom agents — can read a project, fork a workspace, commit, and
propose governed changes. There is nothing to install: you point your client at
a URL and approve the connection in your browser.

Stratum's governance invariants hold over MCP exactly as they do over the REST
API, because the tools call the same route handlers: a change cannot merge past
failing evaluators, review verdicts are a human gate, and every merged change
keeps its provenance and cost records. The protocol is a doorway, not a bypass.

(This server is distinct from the docs site's own
[agent discovery surface](https://docs.usestratum.dev/reference/agent-discovery/),
which serves documentation to agents. This one operates on your projects.)

## Connecting a client

The endpoint is `/mcp` on your own Stratum instance. The examples below use
`https://app.usestratum.dev`, the maintainer's hosted instance — **if you
self-host, substitute your own Worker's origin.** Pointing a client at someone
else's instance sends your tool calls there, along with any credential you
configure by hand.

<!-- Do NOT reintroduce a `your-instance.workers.dev` placeholder into the
     sentence above. `SELF_HOST_PLACEHOLDER` in website/scripts/mirror-docs.mjs
     rewrites that string to the hosted origin for the published site, which
     turns a sentence contrasting the two hosts into one naming the same host
     twice — and tells a self-hoster to point their client at someone else's
     instance. The wording above is correct in both copies. -->

Claude (web, desktop and mobile), as a connector: **Settings → Connectors →
Add custom connector**. Name it, paste `https://app.usestratum.dev/mcp` as the
URL, and leave the advanced OAuth client id and secret blank — Stratum registers
the client itself. Click **Connect** on the new connector and approve the
consent screen that opens; the tools are then available in any conversation
where the connector is enabled.

Claude Code:

```bash
claude mcp add --transport http stratum https://app.usestratum.dev/mcp
```

Any MCP client that supports remote servers:

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

Connecting opens your browser, asks you to sign in if you are not already, and
shows a consent screen: which application is asking, what it will be able to do,
the host it returns you to, and **who it connects as** (see
[Connecting as an agent](#connecting-as-an-agent)). The full redirect address and
where to disconnect later are one click away under **Where this request came
from**. Approve it once; the client stores the tokens and refreshes them on its
own.

**No account yet?** The sign-in page offers **Create an account**. Sign up with
your email, open the link we send you **in the same browser**, and you land back
on the consent screen for the editor that started it. If the instance requires
an invite code and the client added `invite=<code>` to its authorization URL,
the code is filled in for you. Opening the link in a different browser or on
another device still creates your account and signs you in, but cannot finish
connecting the editor: connect it again from the editor, and sign in when the
browser opens. The same applies to a sign-in link sent from that page.

You never paste a Stratum credential into your editor's configuration, and you
can withdraw access at any time from **Settings → Connected applications**
without touching the client.

### Headless clients and CI

An automation with no browser can present a Stratum credential directly instead
of running the OAuth flow:

```bash
curl -X POST https://app.usestratum.dev/mcp \
  -H "Authorization: Bearer $STRATUM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Both credential kinds work: a user token (`stratum_user_...`) or an agent token
(`stratum_agent_...`). See
[what an agent token can do](#what-an-agent-token-can--and-cannot--do) below —
the difference matters.

## How authorization works

The endpoint is an OAuth 2.1 protected resource, and Stratum is the
authorization server. A client bootstraps the whole flow from the URL alone:

1. It calls `/mcp` with no credential. The `401` carries a `WWW-Authenticate`
   header naming `/.well-known/oauth-protected-resource` and the scopes full
   use of the endpoint needs (`scope="mcp:read mcp:write"`).
2. That document points at `/.well-known/oauth-authorization-server`.
3. The client registers itself at `/oauth/register`
   ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) dynamic client
   registration) — no pre-shared client id, nothing configured in advance.
4. It opens `/oauth/authorize` in your browser. You sign in and consent.
5. It exchanges the resulting code at `/oauth/token`.

Details worth knowing:

| Property | Value |
|---|---|
| PKCE | **Required**, `S256` only. `plain` is not offered and cannot be stored. |
| Authorization code lifetime | 60 seconds, single use. A replayed code revokes **every grant that client holds for you** (RFC 6749 §10.5), not just the one the code produced — but a redemption that merely *fails validation* (wrong client, wrong verifier, wrong redirect URI) leaves the code untouched, so observing one is not enough to disrupt the real client. |
| Access token lifetime | 1 hour |
| Refresh token lifetime | 30 days, **rotated** on every use |
| Redirect URIs | `https`, or plaintext `http` on loopback (`localhost`, `127.0.0.1`, `[::1]`) for native apps. Matched exactly against the registered list, except that a loopback redirect may use any port, which RFC 8252 requires because a native app binds whatever port is free when it starts. |
| Scopes | `mcp:read`, `mcp:write` |

Every metadata document is built from the request's own origin, so a self-hosted
instance advertises itself with nothing to configure.

### Scopes

| Scope | Grants |
|---|---|
| `mcp:read` | Read projects, files, branches, changes and their comments, evaluations, import and sync status, issues, and the organizations and teams you belong to. Exactly a read-only API token. |
| `mcp:write` | The above, plus creating and importing projects, syncing them, workspaces, commits, changes, re-evaluation, comments, merges, reviews, GitHub promotion, issue management, and organization, member and team management. Exactly a read-write API token. |

A client that asks for no scope gets `mcp:read`. Most clients ask for more: the
`401` challenge names `mcp:read mcp:write` as what full use of the endpoint
needs, and the protected-resource metadata lists both scopes as supported, so a
client that follows either discovery path can request both. Neither obliges it
to: a client may still ask for `mcp:read` alone. The consent screen spells out
what the grant covers, so a read-only connection is a choice you can see being
made. A read-only grant is refused in the middleware, before routing, on any
write request — so no route has to remember the rule.

The one place the check is deferred is `/mcp` itself, and only because the HTTP
method there says nothing about the operation: every MCP call is a POST,
`tools/list` as much as `stratum_commit`, so refusing on the method would lock a
read-only grant out of the endpoint rather than restrict it. Each tool call is
re-dispatched internally as a real API request carrying the same credential, and
*that* request meets the identical check against the method the operation
actually uses. So `stratum_get_file` works on an `mcp:read` grant and
`stratum_commit` does not. The same holds for every tool: each list/get tool
dispatches a GET and works on a read-only grant, and each tool that creates,
changes or removes anything dispatches a POST or DELETE and is refused on one,
before the route runs.

An OAuth grant is a *delegated* credential: it lives inside software you do not
control. Two things it therefore cannot do, regardless of scope:

- **Reach the admin API.** `/api/admin/*` is refused for OAuth grants even when
  the account behind them is the instance administrator.
- **Mint the legacy API key.** The key never expires and cannot be revoked
  individually, so a credential that could mint one would outlive its own
  revocation.

### Connecting as an agent

The consent screen asks who the application should act as:

- **A new agent** (the default), named after the application. You can rename it,
  for example to "Claude Code on my-laptop". Everything the application does is
  recorded as that agent acting for you: changes it opens carry the agent in
  their provenance, and the activity feed shows an agent rather than you.
- **An existing agent** you own, if you have any. Pick the same agent again when
  you reconnect and its work stays under one identity.
- **Me.** The application acts as you, as every connection did before this
  choice existed. Its work is recorded as yours, with **no agent provenance**.

A connection bound to an agent has exactly the authority an
[agent token](#what-an-agent-token-can--and-cannot--do) has: it can read, fork,
commit, open changes and file issues, but it can't merge, reject, review or
triage issues, and `stratum_list_projects` returns an empty list. Choose **Me**
if you want the application to do those things for you. Your granted scope still
applies: an `mcp:read` connection is read-only whichever identity it uses.

An agent created on the consent screen **has no token of its own**. The
connection is its only credential, so it stops working when the connection
does: when you disconnect it, when it is revoked, or when it reaches the
180-day limit below. Refreshing the connection keeps the same agent. The agent
itself is kept after that, because the changes it made still refer to it, but
nothing can sign in as it. Binding an existing agent doesn't touch that agent's
own token. Disconnecting ends only the access that came through the connection.

`stratum_whoami` tells the application which it is: `"actingAs": "user"` with
your account, or `"actingAs": "agent"` with the agent's id and name and the
owner it acts for.

Connections made before this choice existed keep acting as you until you
disconnect them or they reach the 180-day limit. Reconnecting shows the new
consent screen.

### Disconnecting an application

**Settings → Connected applications** lists every client you have authorized,
with its self-declared name, its client id, the access you granted, who it acts
as (`You (no agent provenance)` or `Agent: <name>`) and when it was last used.
Disconnecting is immediate: the access token and the ability to refresh both
stop working at once.

Application names are chosen by the application at registration and are not
vetted by anyone. A name you do not recognise should be disconnected.

## The tools

Forty tools cover the full contribution loop, from creating or importing
a project to promoting a change to GitHub, plus organization management. Project
arguments take a `namespace/slug` reference (`@acme/api` and `acme/api` both
work); organization arguments take the org's slug (`acme` or `@acme`). Every
tool's description states the access it needs, and the API behind it enforces
exactly what it enforces over REST.

**Identity and reading**

| Tool | What it does |
|---|---|
| `stratum_whoami` | Identify who the connection acts as (calls `GET /api/users/me`). `actingAs: "user"` returns your account; `actingAs: "agent"` returns the agent the connection is bound to and the owner it acts for. A bare agent token gets a 401. |
| `stratum_get_usage` | This account's metered usage against its plan limits for the current period — per-meter consumption, the limit on each, the rate ceilings, and when the period resets. An agent token reports its **owner's** allowance, because that is the account its evaluations are charged to. |
| `stratum_list_projects` | List projects in the caller's **own namespace** — org-namespace projects are not included, and an agent (an agent token or a connection bound to an agent) gets an empty list. |
| `stratum_get_project` | Project metadata — id, namespace, visibility, git remote. |
| `stratum_list_files` | File paths at the HEAD of the default branch. |
| `stratum_get_file` | One file's content at HEAD. |
| `stratum_get_activity` | Recent activity feed. |
| `stratum_list_branches` | A project's branches. |

**Creating and importing projects**

| Tool | What it does |
|---|---|
| `stratum_create_project` | Create an empty project in your own namespace, or with `org` in that organization's (needs write access to the org). Optional `visibility` and `seed`. |
| `stratum_import_project` | Import a GitHub, GitLab or Bitbucket repository by `url`. Without `org` it lands in your own namespace; with `org`, in that organization's — which needs **write** access there (an org admin, or a member of a team with write permission). A read-only member or a non-member is refused with `403`. `name` defaults to the source repository's name. Returns at once with `status: "queued"`. |
| `stratum_get_import_status` | Follow an import: status, file counts, errors and logs. Until it completes, the project is visible only to people who can write to it. |
| `stratum_get_sync_status` | An imported project's sync state against its source. |
| `stratum_sync_project` | Pull new commits from the source repository, in your own namespace or an organization where you have write access. |

Creating and importing are user actions: an agent token is refused, and so is a
token bound to a single project. An org-bound token may create only inside its
org and cannot import. A private project counts toward the private-project
limit whichever namespace it lands in. See
[Importing](importing.md#importing-into-an-organization) for the REST
equivalent.

**Forking and committing**

| Tool | What it does |
|---|---|
| `stratum_create_workspace` | Fork an isolated workspace; returns its name and git remote. |
| `stratum_list_workspaces` | List a project's workspaces — all of them; there is no status filter, so workspaces whose changes already merged still appear. |
| `stratum_commit` | Commit a map of repo-relative paths to **complete file contents**. |
| `stratum_workspace_remote` | The workspace's git remote URL plus a **short-lived push credential** for it, for working in a local checkout. See [Pushing from a local checkout](#pushing-from-a-local-checkout). |

`stratum_commit` takes the `project_id` from `stratum_get_project`, not the
`namespace/slug` reference. The file map is capped at 2,000 files, and it cannot
express a deletion or rename — only full contents of added or modified files.
Larger or destructive edits go over the workspace's git remote instead, with a
credential from `stratum_workspace_remote`.

**The whole MCP request is capped at 8 MB**, below the REST API's 25 MB commit
limit. A tool call is buffered, parsed, re-serialized into an internal request
and parsed again, so a body near the REST limit would cost more than a Workers
isolate's entire 128 MB budget — which is shared with every other request that
isolate is serving. A commit that does not fit belongs on the git remote
anyway.

### Pushing from a local checkout

An agent that works in a real checkout would rather `git push` than send whole
files through `stratum_commit`. `stratum_workspace_remote` gives it what it
needs without a long-lived token set up out of band:

```json
{ "project": "@acme/billing", "workspace": "fix-retries", "expires_in_minutes": 60 }
```

returns

```json
{
  "remote": "https://stratum.example.com/@acme/billing/workspaces/fix-retries.git",
  "username": "stratum",
  "token": "stratum_git_…",
  "expiresAt": "2026-11-02T13:00:00.000Z",
  "credentialId": "tok_…",
  "branches": ["main", "fix-retries"]
}
```

Hand the token to git as the HTTP password, either through a credential helper
or in the URL:

```bash
# Credential helper: keeps the token out of .git/config and the remote URL.
export STRATUM_GIT_TOKEN='stratum_git_…'
git remote add stratum https://stratum.example.com/@acme/billing/workspaces/fix-retries.git
git -c credential.helper= \
    -c 'credential.helper=!f() { echo username=stratum; echo "password=$STRATUM_GIT_TOKEN"; }; f' \
    push stratum HEAD:main

# URL token: simplest, but the token is then stored in .git/config.
git push https://stratum:stratum_git_…@stratum.example.com/@acme/billing/workspaces/fix-retries.git HEAD:main
```

A push may update the branches listed in `branches` (the project's default
branch or the workspace branch) and tags. It lands on the workspace only; open a
change with `stratum_create_change` to propose merging it, exactly as after
`stratum_commit`.

What the credential is, and is not:

- **One workspace, git only.** It works for `git fetch` and `git push`
  (`git-upload-pack` and `git-receive-pack`) on the workspace it was minted for.
  It is refused on the project's own URL, on every other workspace, on the REST
  API, and on this MCP server. It does not follow the workspace's name: if the
  workspace is deleted and re-created, the old credential is dead.
- **Short-lived.** 60 minutes by default, 5 to 60 on request. Call the tool
  again when it runs out.
- **Never outlives what minted it.** It expires no later than the credential the
  tool was called with, and it stops working the moment that credential does:
  disconnecting the MCP application, revoking the API token, revoking the agent,
  or rotating or disabling the legacy key ends it immediately. Its authority is
  also re-checked on every push, so losing access to the project or workspace
  ends it too.
- **Needs write access.** It is refused for an `mcp:read` grant or a read-only
  token, and for anyone who cannot push to the workspace (its creator or a
  project admin can).
- **Audited.** Every mint is recorded as `workspace_remote.credential_minted`,
  and a refused use of an expired or revoked one as `auth.failed`. The secret
  itself is never logged or stored; only its hash is.
- **Bounded.** At most 20 live credentials per user. They do not appear in, or
  count towards, your API tokens in settings.

It is still a secret that passes through the model's context. It is narrow and
short-lived precisely so that this is tolerable, but an agent should not write
it into files, commits or messages.

**The change flow**

| Tool | What it does |
|---|---|
| `stratum_create_change` | Open a change and run every gate in `.stratum/policy.yaml`. With an evaluation queue (the hosted instance) the change comes back `evaluating` with no verdict yet — poll `stratum_get_change` until its status leaves `evaluating`. Without one, the verdicts are returned directly. |
| `stratum_list_changes` | List changes, optionally by status. |
| `stratum_get_change` | One change with per-gate evidence and metered costs. |
| `stratum_merge_change` | Merge a change that passed its gates and approvals. |
| `stratum_reject_change` | Close a change without merging. |
| `stratum_review_change` | Submit a `request_changes` verdict. `approve` is refused over MCP: approvals are made by a signed-in human in the browser. |
| `stratum_evaluate_change` | Re-run a change's gates against its workspace's current state — after pushing more commits. Needs write access to the project. |
| `stratum_list_checks` | A change's [check runs](checks.md): the newest run of each check on the evaluated revision, which is what `merge.requiredChecks` reads. Poll it until every required check is terminal; only `passed` lets the merge through. `all` returns every revision and attempt. Needs read access to the project. |
| `stratum_rerun_check` | Re-run one check on the revision it ran against — a flaky failure, or a runner that never reported. It does not pick up new commits: after a push, use `stratum_evaluate_change`. Needs write access to the project; user credentials only. |
| `stratum_comment_change` | Comment on a change: change-wide, anchored to a diff line (`file` + `line`), or as a reply (`parent_comment_id`). Needs read access to the project. |
| `stratum_list_change_comments` | A change's comments in order, with anchors, replies and resolved state. |
| `stratum_promote_change` | Push an **accepted** change's branch to the project's linked GitHub repository and open a PR (a draft by default) against the default branch. Needs write access to the project. |

**Issues**

| Tool | What it does |
|---|---|
| `stratum_create_issue` | Open an issue; linking a change id auto-closes it on merge. |
| `stratum_list_issues` | List issues, optionally by status. |
| `stratum_update_issue` | Update status, title, or body by issue number. |

**Organizations**

| Tool | What it does |
|---|---|
| `stratum_create_org` | Create an organization; you become its admin. The slug cannot match an existing username or org. |
| `stratum_list_orgs` | The organizations you belong to. |
| `stratum_get_org` | One organization's record. Members only. |
| `stratum_add_org_member` | Add a user (by Stratum user id) or change their role (`member` or `admin`). Org admins only. |
| `stratum_remove_org_member` | Remove a member. Org admins only; any member may remove themselves. |
| `stratum_create_team` | Create a team with `read`, `write` or `admin` permission across the org's projects. Org admins only. |
| `stratum_list_teams` | An organization's teams. Members only. |
| `stratum_add_team_member` | Add a user to a team. Org admins only. |

A non-member asking about an organization gets the same "not found" as for one
that does not exist. Organization tools are user actions — agent tokens can read
an org their owner belongs to but cannot change one — and no token bound to a
single project or org can reach them at all.

**The billing surface is read-only, and stays that way.** `stratum_get_usage` is
the only tool that touches it: there is no tool to raise a limit, buy capacity,
attach a payment method, or store a provider key. A spend limit an agent can
lift is not a limit — the same line that keeps agent tokens from submitting
review verdicts — and a provider credential must never pass through a model's
context window. Those actions live in the web UI, where a human consents to them
in a browser.

## What an agent token can — and cannot — do

The server accepts either token kind, but the API behind it does not treat
them alike. With an **agent token**, or an OAuth connection
[bound to an agent](#connecting-as-an-agent):

- **Works:** the project reading tools (`get_project`, `list_files`,
  `get_file`, `get_activity`), `stratum_create_workspace`, `stratum_commit`,
  `stratum_workspace_remote` (the credential then pushes as the agent),
  `stratum_create_change`, `stratum_comment_change`,
  `stratum_list_change_comments`, `stratum_list_checks`, `stratum_create_issue`,
  `stratum_list_issues`,
  and `stratum_get_usage` (which reports the **owner's** allowance) — an agent
  can do everything up to and including proposing a gated change, discussing it,
  and opening issues about its work. Address projects by `namespace/slug`
  directly: `stratum_list_projects` returns an **empty list** on an agent
  token or a bound connection rather than the owner's projects. A bare agent
  token gets a 401 from `stratum_whoami`; a bound connection gets its identity.
- **Always refused:** `stratum_merge_change`, `stratum_reject_change`,
  `stratum_review_change`, `stratum_update_issue`, `stratum_evaluate_change`,
  `stratum_rerun_check`,
  `stratum_promote_change`, `stratum_create_project`, `stratum_import_project`,
  `stratum_sync_project`, and the organization tools that change anything.
  Merging, deciding, issue triage, re-running gates, publishing to GitHub,
  creating projects and administering orgs are user actions, and review
  verdicts are refused from agent tokens **entirely** — `request_changes` as
  much as `approve`. An agent's feedback channel is
  [change comments](code-review.md), through `stratum_comment_change`.

So an agent-token deployment is a *proposer*: it forks, commits, opens the
change, and a human (over the UI, [CLI](cli.md), or their own MCP session)
reviews and merges.

An **OAuth grant that acts as you** ("Me" on the consent screen) is a user
credential: a human consented to it in a browser, so it carries the same
authority a user token does when `mcp:write` was granted, with one exception:
it **cannot approve**.
An approval is the human half of the merge gate, and an OAuth grant is
software acting for the human, so `stratum_review_change` with `approve` is
refused with `SESSION_REQUIRED`; approve on the change page in the browser.
`request_changes` still works. If you want an MCP client that can propose but
never decide anything, connect it as an agent on the consent screen, or use an
agent token.

## Operational notes

- The endpoint is **stateless**: no session to establish or resume, no
  `Mcp-Session-Id`. Every request is self-contained and authenticated on its
  own, so any edge location can answer any call and a reconnect loses nothing.
- `GET /mcp` returns **405**. This server never initiates messages, so there is
  no server-to-client stream to open; clients treat the 405 as "none offered".
- Protocol versions accepted: `2025-06-18`, `2025-03-26`, `2024-11-05`. An
  explicitly unsupported `Mcp-Protocol-Version` header is a 400; an absent one
  is fine.
- Tool failures come back as results marked as errors, prefixed
  `Stratum API error:` — or `Invalid arguments for <tool>:` for a schema
  violation, so a calling agent knows whether to fix its input or its
  expectations. Argument errors list **every** problem at once rather than the
  first.
- With an evaluation queue, `stratum_create_change` returns as soon as the
  change exists, in status `evaluating`; the gates run afterwards. Poll
  `stratum_get_change` until the status is `accepted` or `needs_changes` before
  acting on it — `stratum_merge_change` refuses an evaluating change with
  `EVALUATION_PENDING`. On an instance without the queue, evaluation runs inside
  the call, so a slow sandbox evaluator makes it legitimately run long; if such
  a call fails mid-evaluation, follow up with `stratum_list_changes` /
  `stratum_get_change` rather than re-submitting.
- The credential is re-resolved on **every** tool call, not once per
  connection. A token you revoke stops working on the next call.

## Reference

- [Getting started §6](getting-started.md#6-connect-your-tools) — where MCP
  fits in the end-to-end flow
- [Authentication](../api/authentication.md) — the credential kinds
- [CI integration](ci-integration.md) — evaluating changes on your own infra
- [OpenAPI specification](../api/openapi.yml) — the API the tools wrap
