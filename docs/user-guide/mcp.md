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
and the host it returns you to. The full redirect address and where to
disconnect later are one click away under **Where this request came from**.
Approve it once; the client stores the tokens and refreshes them on its own.

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
| `mcp:read` | Read projects, files, changes, evaluations and issues. Exactly a read-only API token. |
| `mcp:write` | The above, plus workspaces, commits, changes, merges, reviews and issue management. Exactly a read-write API token. |

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
`stratum_commit` does not.

An OAuth grant is a *delegated* credential: it lives inside software you do not
control. Two things it therefore cannot do, regardless of scope:

- **Reach the admin API.** `/api/admin/*` is refused for OAuth grants even when
  the account behind them is the instance administrator.
- **Mint the legacy API key.** The key never expires and cannot be revoked
  individually, so a credential that could mint one would outlive its own
  revocation.

### Disconnecting an application

**Settings → Connected applications** lists every client you have authorized,
with its self-declared name, its client id, the access you granted and when it
was last used. Disconnecting is immediate: the access token and the ability to
refresh both stop working at once.

Application names are chosen by the application at registration and are not
vetted by anyone. A name you do not recognise should be disconnected.

## The tools

Nineteen tools cover the full contribution loop. Project arguments take a
`namespace/slug` reference (`@acme/api` and `acme/api` both work).

**Identity and reading**

| Tool | What it does |
|---|---|
| `stratum_whoami` | Identify the authenticated **user** (calls `GET /api/users/me`, which refuses agent tokens). |
| `stratum_get_usage` | This account's metered usage against its plan limits for the current period — per-meter consumption, the limit on each, the rate ceilings, and when the period resets. An agent token reports its **owner's** allowance, because that is the account its evaluations are charged to. |
| `stratum_list_projects` | List projects in the caller's **own namespace** — org-namespace projects are not included, and an agent token gets an empty list. |
| `stratum_get_project` | Project metadata — id, namespace, visibility, git remote. |
| `stratum_list_files` | File paths at the HEAD of the default branch. |
| `stratum_get_file` | One file's content at HEAD. |
| `stratum_get_activity` | Recent activity feed. |

**Forking and committing**

| Tool | What it does |
|---|---|
| `stratum_create_workspace` | Fork an isolated workspace; returns its name and git remote. |
| `stratum_list_workspaces` | List a project's workspaces — all of them; there is no status filter, so workspaces whose changes already merged still appear. |
| `stratum_commit` | Commit a map of repo-relative paths to **complete file contents**. |

`stratum_commit` takes the `project_id` from `stratum_get_project`, not the
`namespace/slug` reference. The file map is capped at 2,000 files, and it cannot
express a deletion or rename — only full contents of added or modified files.
Larger or destructive edits go over the workspace's git remote instead.

**The whole MCP request is capped at 8 MB**, below the REST API's 25 MB commit
limit. A tool call is buffered, parsed, re-serialized into an internal request
and parsed again, so a body near the REST limit would cost more than a Workers
isolate's entire 128 MB budget — which is shared with every other request that
isolate is serving. A commit that does not fit belongs on the git remote
anyway.

**The change flow**

| Tool | What it does |
|---|---|
| `stratum_create_change` | Open a change; **synchronously** runs every gate in `.stratum/policy.yaml` and returns the verdicts. |
| `stratum_list_changes` | List changes, optionally by status. |
| `stratum_get_change` | One change with per-gate evidence and metered costs. |
| `stratum_merge_change` | Merge a change that passed its gates and approvals. |
| `stratum_reject_change` | Close a change without merging. |
| `stratum_review_change` | Submit an `approve` or `request_changes` verdict. |

**Issues**

| Tool | What it does |
|---|---|
| `stratum_create_issue` | Open an issue; linking a change id auto-closes it on merge. |
| `stratum_list_issues` | List issues, optionally by status. |
| `stratum_update_issue` | Update status, title, or body by issue number. |

**The billing surface is read-only, and stays that way.** `stratum_get_usage` is
the only tool that touches it: there is no tool to raise a limit, buy capacity,
attach a payment method, or store a provider key. A spend limit an agent can
lift is not a limit — the same line that keeps agent tokens from submitting
review verdicts — and a provider credential must never pass through a model's
context window. Those actions live in the web UI, where a human consents to them
in a browser.

## What an agent token can — and cannot — do

The server accepts either token kind, but the API behind it does not treat
them alike. With an **agent token**:

- **Works:** the project reading tools (`get_project`, `list_files`,
  `get_file`, `get_activity`), `stratum_create_workspace`, `stratum_commit`,
  `stratum_create_change`, `stratum_create_issue`, and `stratum_list_issues` —
  an agent can do everything up to and including proposing a gated change and
  opening issues about its work. Address projects by `namespace/slug`
  directly: `stratum_list_projects` returns an **empty list** on an agent
  token rather than the owner's projects, and `stratum_whoami` returns a 401.
- **Always refused:** `stratum_merge_change`, `stratum_reject_change`,
  `stratum_review_change`, and `stratum_update_issue`. Merging, deciding, and
  issue triage are user actions, and review verdicts are refused from agent
  tokens **entirely** — `request_changes` as much as `approve`. An agent's
  feedback channel is [change comments](code-review.md), which the REST API
  accepts from agents but this server does not yet expose as a tool.

So an agent-token deployment is a *proposer*: it forks, commits, opens the
change, and a human (over the UI, [CLI](cli.md), or their own MCP session)
reviews and merges.

An **OAuth grant is a user credential**, not an agent identity: a human
consented to it in a browser, so it carries the same authority a user token
does, including review verdicts when `mcp:write` was granted. If you want an
MCP client that can propose but never decide, connect it with an agent token
rather than through OAuth.

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
- Evaluation runs inside `stratum_create_change`, so on a project with a slow
  sandbox evaluator that call legitimately runs long. There is no client-side
  deadline cutting it short any more — the bound is the request's own budget.
  If a call does fail mid-evaluation, the evaluation continues server-side:
  follow up with `stratum_list_changes` / `stratum_get_change` rather than
  re-submitting.
- The credential is re-resolved on **every** tool call, not once per
  connection. A token you revoke stops working on the next call.

## Reference

- [Getting started §6](getting-started.md#6-connect-your-tools) — where MCP
  fits in the end-to-end flow
- [Authentication](../api/authentication.md) — the credential kinds
- [CI integration](ci-integration.md) — evaluating changes on your own infra
- [OpenAPI specification](../api/openapi.yml) — the API the tools wrap
