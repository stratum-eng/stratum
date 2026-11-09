# Authentication

Most API endpoints accept a Stratum API token as an
`Authorization: Bearer <token>` header. Browser requests may instead be
authenticated by the `stratum_session` cookie. The
[OpenAPI specification](openapi.yml) marks the exact security requirements per
endpoint.

## API tokens

For programmatic access:

- **User tokens**: `stratum_user_xxxxx` — named, scoped, independently
  revocable, and optionally expiring. Created from the settings UI or
  `POST /api/users/me/tokens`.
- **Agent tokens**: `stratum_agent_xxxxx` — issued to an agent, tied to the
  owning user's access, and attributed to the agent in provenance. They do
  **not** expire and are not scoped. Within the access they inherit they can
  read, fork workspaces, commit, open changes, comment, and open issues — but
  every **deciding** endpoint requires a user identity and refuses an agent
  token: review verdicts (approve and request-changes alike), merge, reject,
  re-evaluate, GitHub PR promotion, issue editing/closing, approving a gated
  deployment, and managing a project's deploy secrets — the secret routes refuse
  an agent outright, including one whose *owner* is a project admin, because
  deploy credentials are the one thing an agent is never trusted with. Retrying
  an already-finished deployment is not a deciding endpoint and *is* open to an
  agent with write access. Session-only
  endpoints (token management) refuse agent and scoped tokens alike — the one
  exception is `rotate-token`, [below](#the-legacy-token). Revoke one by
  deleting the agent (settings UI, or `DELETE /api/agents/{id}`).
- **SCIM tokens**: `stratum_scim_xxxxx` — per-SSO-connection bearer accepted
  only by the SCIM endpoints under `/scim/v2` (which accept no other
  credential). Rotated by an org admin via
  `POST /api/orgs/{slug}/sso/scim-token`; the plaintext is returned exactly
  once.

An account deactivated through SCIM is **disabled**, reversibly: every
credential it holds — user tokens, agent tokens, OAuth grants, the session
cookie, and git over HTTPS — is refused with `401` until the identity provider
reactivates it. Reactivation restores the account's tokens, agents, and OAuth
grants as they were, but deactivation deleted its browser sessions, so the user
signs in again.

```bash
curl -H "Authorization: Bearer stratum_user_xxxxx" \
  https://your-instance.workers.dev/api/projects
```

### Scopes

Every user token carries exactly one scope, chosen when it is created:

| Scope | What it can do |
|---|---|
| `read` (default) | `GET` and `HEAD` requests, and `git clone` / `git fetch` over HTTPS. Nothing else. |
| `read_write` | Everything its owner can do through the API and git. |

A `read` token is refused on **every** request that is not a `GET` or a `HEAD`,
with `403` and the code `TOKEN_SCOPE_INSUFFICIENT`. The check runs before
routing, on an allow-list of methods, so no endpoint can forget it and a reason
expressed as a `POST` gets no exception. Over git, the same rule is applied to
the operation the server resolves rather than to the URL: a `read` token clones
and fetches, and is refused on `git push` to both the project and the workspace
remote — including the `info/refs?service=git-receive-pack` advertisement that
precedes it.

Read-only bounds *damage*, not *exposure*: a `read` token still reads every
private project its owner can read — to bound exposure, limit the token to a
project or organization as well ([below](#project-and-organization-binding)).
Sessions and agent tokens are unaffected by scopes.

### Project and organization binding

A user token can additionally be **bound** to one project or one organization
when it is created. Binding is the second scope dimension, independent of
`read` / `read_write`: the scope says *what* the token may do, the binding says
*where*.

| Binding | What it reaches |
|---|---|
| none (default) | Every project its owner can reach — the behaviour of every token created before bindings existed. |
| `project` | That one project, by its stable id (renaming it does not break the token). |
| `org` | Every project currently **owned by** that organization. Not the owner's personal projects, and not other organizations' projects. |

A binding only ever narrows: inside it, the token can still do no more than its
owner can, under its scope. One project *or* one organization per token, not a
set — create another token for another project.

Outside its binding a token learns nothing about what exists: every route
answers an out-of-binding project exactly as it answers one that does not
exist — `404` almost everywhere, even when the project is public. That holds on
the routes that refuse a non-writer with `403` too (webhooks, deploy secrets,
change merges and reviews, issue edits): a stranger gets `403` there, but a
bound token gets the not-found answer, so it cannot tell another private
project from a missing one. (The `/api/projects/{namespace}/{slug}/sync/*`
routes answer `403` for missing and inaccessible projects alike, and so for an
out-of-binding one.) Over git, clone and push to an out-of-binding remote are
the same `404`. `GET /api/projects` lists only the bound project (or
the bound organization's projects).

A bound token can reach only the project surfaces of the API:
`/api/projects/...`, `/api/changes/...`, `/api/workspaces/...`,
`/api/deployments/...`, `GET /api/users/me`, the MCP endpoint at `/mcp` (whose
tools are held to the same binding), git over HTTPS, and the public health
checks (`/health`, `/api/health`). **Everything else** —
the rest of `/api/users/me/*` (usage, token management, key rotation, account
deletion), `/api/agents`, `/api/orgs` (including SSO and SCIM administration),
`/api/bulk-import`, `/api/admin/*`, session management and the web UI — answers
`403` with the code `TOKEN_BINDING_EXCLUDES_ROUTE`, before routing. In
particular a bound token can never mint a broader credential: not a token, not
an agent, not the legacy key.

The [read-only rule](#scopes) is checked first. A **`read`** bound token
calling any non-`GET`/`HEAD` endpoint — including one outside its surfaces, such
as `POST /api/agents` — gets `403 TOKEN_SCOPE_INSUFFICIENT`, not
`TOKEN_BINDING_EXCLUDES_ROUTE`. Both are refusals before routing; only the code
differs.

Within its surfaces a bound token also cannot create anything outside its
binding: a project-bound token cannot create or import projects at all, and an
organization-bound token can create projects only in that organization
(`POST /api/projects` with `"org"` set to it).

A token whose bound project or organization is later deleted stops reaching
anything; it is not widened back to account-wide. Revoke it as usual.

To bind a token, pass **one** of `project` (a path such as `"@alice/web"`) or
`org` (an organization slug) when creating it. You must be able to read the
project, or be a member of the organization; otherwise the request is a `404`,
the same as for one that does not exist. Sending both is a `400`.

### Expiry and limits

- `expiresInDays` is an integer from **1 to 365**; omit it for a token that
  never expires. Expiry is checked on every authentication, against the time of
  the request.
- An expired or revoked token is a `401` everywhere — API and git alike.
  Revoked rows are kept, so the audit trail survives revocation.
- Each user may hold **20 active tokens**. The 21st is a `409`
  (`TOKEN_LIMIT_REACHED`). Revoked tokens do not count towards the limit, so
  rotating never locks you out.
- `lastUsedAt` records when a token last authenticated, written at most once an
  hour. It is **not** written on the git smart-HTTP path, which has no
  execution context to defer the write to — so a token used only for `git
  clone` can show as never used.

### Managing tokens requires a session

`GET|POST /api/users/me/tokens`, `DELETE /api/users/me/tokens/{id}` and
`POST /api/users/me/legacy-token/disable` accept the `stratum_session` cookie
**only** — the cookie every web sign-in sets (magic link, GitHub or Google
OAuth, or organization SSO at `/auth/sso`). An API token calling them gets `403 SESSION_REQUIRED`, whatever its
scope. A token that could mint tokens, revoke its siblings, or turn off the
legacy credential would make revocation meaningless — a lost machine would
simply issue itself a replacement.

The plaintext is returned exactly once, by the call that creates it, with
`Cache-Control: no-store`. It is never stored and never listed again; a listing
shows only the non-secret prefix (e.g. `stratum_user_1a2b3c4d`), which is enough
to recognise a credential sitting in a CI config.

```bash
# Create a read-only token that expires in 90 days (session cookie required)
curl -X POST https://your-instance.workers.dev/api/users/me/tokens \
  -b "stratum_session=..." -H "Content-Type: application/json" \
  -d '{"name":"buildkite","scope":"read","expiresInDays":90}'

# Create a read & write token that can reach only one project
curl -X POST https://your-instance.workers.dev/api/users/me/tokens \
  -b "stratum_session=..." -H "Content-Type: application/json" \
  -d '{"name":"deploy-bot","scope":"read_write","project":"@alice/web"}'
```

### The legacy token

**Every** account carries a single unnamed credential on the user row — it is
minted at signup, though the plaintext is discarded unseen, so on a new account
it sits inert until `POST /api/users/me/rotate-token` mints and returns a fresh
one. Only accounts from before scoped tokens may have seen theirs. The
credential works with `read_write` access and never expires. It is legacy for a
reason: it has no name, no scope, no expiry, and no last-used record, rotating
it invalidates whatever else is using it — and any account can activate it, so
"we predate scoped tokens" is not the only way to end up depending on one.
Prefer named scoped tokens for everything.

`POST /api/users/me/legacy-token/disable` (or the button in the settings UI)
makes it permanently unusable, by rotating it to a value that is never returned
to anyone. Named API tokens are unaffected. Move anything still using the legacy
credential onto a named token first — disabling it cannot be undone, though
`rotate-token` will mint a fresh legacy credential if you truly need one.

`rotate-token` accepts a browser session or the legacy credential itself, but
refuses a **scoped** token or an **OAuth grant** with `SESSION_REQUIRED`. The key
it mints never expires and cannot be revoked one at a time, so letting either
rotate it would mean revoking them contained nothing — the credential could have
issued itself a permanent replacement on the way out.

## OAuth grants

Stratum is an OAuth 2.1 authorization server, and the remote MCP endpoint at
`/mcp` is a protected resource. A client registers itself
([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)), sends the user to a
consent screen, and receives an access token — so a user connects an editor
without ever pasting a credential into it.

Two first-party clients use this flow, and the grants they receive are the same
kind of credential:

- **MCP clients** (editors, agent frameworks) — see
  [the MCP guide](../user-guide/mcp.md).
- **The CLI**, since `stratum login` — see [the CLI guide](../user-guide/cli.md).
  It registers as a public client with a loopback redirect
  ([RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252)) rather than an
  https one, because it runs on the user's own machine.

An OAuth access token authenticates **everywhere a user token does**, which is
what keeps the MCP tools from drifting away from the API they wrap — with the
carve-outs listed below.

| | |
|---|---|
| Access token prefix | `stratum_mcp_` |
| Lifetime | 1 hour, refreshed with a rotating 30-day refresh token. The refresh window slides on every rotation but is capped **180 days** from first issue, so an actively used grant still returns the user to the consent screen twice a year |
| Authorization code | 60 seconds, single use |
| Scopes | `mcp:read` (= a `read` token), `mcp:write` (= a `read_write` token) |
| PKCE | Required, `S256` only |
| Discovery | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` |

An access token authenticates like any other bearer token, on every endpoint a
user token reaches, and the `read`/`read_write` scope rules above apply
unchanged. Two limits are specific to it, because a grant lives inside software
the user does not control:

- **No admin API.** `/api/admin/*` returns `403
  ADMIN_REQUIRES_DIRECT_CREDENTIAL` for an OAuth grant, even when the account
  behind it is the instance administrator.
- **No legacy-key minting.** Like a scoped token, it is refused by
  `rotate-token` with `SESSION_REQUIRED`.
- **No approvals.** Like a scoped token, it cannot submit an `approve` review
  verdict (`403 SESSION_REQUIRED`): approvals are made by a signed-in human in
  the browser. `request_changes` and comments still work.

### Grants bound to an agent

On the consent screen the user chooses who the grant acts as: themselves, one
of their existing agents, or a new agent created for this connection (the
default). A grant bound to an agent **authenticates as that agent**, acting for
the user. The request context is the one an agent token produces, so the
change, event and provenance records name the agent, and every agent rule
applies: no merge, reject, review verdict or issue triage, and an empty
`GET /api/projects` listing. The grant's scope, the admin-API refusal and the
minting and approval refusals above still apply on top.

An agent created on the consent screen has **no token of its own**: the grant
is its only credential, so revoking the grant, the grant expiring at 180
days, or deleting the agent ends its access. If the bound agent is deleted
or changes owner, the grant is refused rather than falling back to the user.
`GET /api/users/me` reports which identity a grant uses (`actingAs`). Grants
issued before this choice existed act as the user.

Grants are listed and revoked by their owner under **Settings → Connected
applications**, and by the client itself at `POST /oauth/revoke`
([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)). Revocation is
immediate and covers both halves of the pair — revoking either the access token
or the refresh token ends the grant.

## Second factor (passkeys)

Browser sign-in can require a passkey after the first step (magic link, GitHub,
Google, or SSO). Stratum issues the `stratum_session` cookie only after the
passkey or a recovery code is verified at `/auth/2fa`. An org can require this
for its members (`PUT /api/orgs/{slug}/security`). The requirement covers only
**that org's** projects and `/api/orgs/{slug}/` endpoints. A session without the
second factor gets `403 SECOND_FACTOR_REQUIRED` there, and keeps all of its
other access.

**Non-interactive credentials are never asked for a second factor.** An org
that requires one holds them to it by how the session that created them had
signed in, which each credential records. A credential created without a
second factor gets `403 SECOND_FACTOR_REQUIRED` on that org's resources, and
keeps all of its other access. Creating it again from a session that meets the
policy restores access. See
[Using credentials](../user-guide/passkeys.md#using-credentials).

They are not all scoped, so treat every one of them like a password:

| Credential | What it can reach | How to cut it off |
|------------|-------------------|-------------------|
| Named API token (`stratum_user_…`) | `read` or `read_write`, as chosen when it was created | Revoke it individually; it can also expire |
| Legacy API key | Full `read_write` account access, no scope, never expires | Rotate it (invalidates the old key) or disable it permanently; it cannot be revoked on its own |
| Agent token (`stratum_agent_…`) | The owning user's full access, no scope | Revoke the agent |
| MCP OAuth grant (`stratum_mcp_…`) | `mcp:read` or `mcp:write`, as the user or as the agent chosen at consent; never the admin API | Disconnect the app in settings, or `POST /oauth/revoke` |
| SCIM token (`stratum_scim_…`) | Only `/scim/v2` for one org's SSO connection | An org admin rotates it |
| Workspace remote credential (`stratum_git_…`) | `git fetch` / `git push` on one workspace; nothing on the API. At most an hour | Revoke the credential that minted it, which ends it at once; otherwise it expires |
| git over HTTPS | Whatever the token it presents can reach | Revoke that token |

See [Passkeys and two-factor sign-in](../user-guide/passkeys.md).

## Anonymous access

Read endpoints on projects with `visibility: public` accept anonymous
requests. A small set of endpoints requires no authentication at all:

- `GET /health`, `GET /api/health`, `GET /api/health/simple` — liveness and
  dependency health checks
- `GET /api/users/check-username` — username availability
- `POST /api/agent-signup` and `POST /api/agent-signup/poll` — agent-initiated
  signup (see [below](#agent-initiated-signup))
- `POST /api/webhooks/github` — the inbound GitHub webhook receiver, which is
  authenticated by HMAC signature (`X-Hub-Signature-256`) against the
  configured webhook secret rather than by a bearer token

## Agent-initiated signup

An agent can get its human onto Stratum without a browser of its own:

```bash
# 1. The agent asks for the account. Nothing is created yet.
curl -X POST https://app.usestratum.dev/api/agent-signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","username":"you","agentName":"Claude Code","inviteCode":"ABCD1234"}'
# → 202 {"pollToken":"stratum_asp_…","userCode":"WXYZ-4KHT","interval":5,"expiresAt":"…"}

# 2. The agent shows you the userCode. You get an email naming the agent; the
#    link asks for that code, then creates your account exactly as a normal
#    signup would, and signs you in.

# 3. The agent polls until approved, then receives its own agent token.
curl -X POST https://app.usestratum.dev/api/agent-signup/poll \
  -H 'Content-Type: application/json' -d '{"pollToken":"stratum_asp_…"}'
# → {"status":"pending"} … then once:
# → {"status":"complete","agent":{…},"token":"stratum_agent_…"}
```

The code is what ties the approval to *your* agent. It is never in the email,
so someone who requests an account for an address that isn't theirs cannot get
it approved by an unsuspecting click: the person at that address has no code to
type. If no agent of yours showed you a code, don't approve. Five wrong codes
end the request, and the agent's next poll answers 410 `LOCKED`.

What the agent ends up with is an **agent token** under your account, not your
own credential: it acts with your access, it is recorded as the agent in
provenance, and it can never submit a review, so approvals stay yours. Revoke it
from **Settings** like any other agent.

The endpoint carries the same limits as the web signup form: the per-address
and per-IP email caps, the closed-beta invite code where the instance requires
one, and 15-minute single-use approval links. A request lasts 30 minutes, and is
deleted a day after it expires. An
address that already has an account is refused (409 `EMAIL_EXISTS`) rather
than attached to, because attaching an agent to an existing account takes that
account's owner, not a link the agent asked for; connect an agent from
Settings or over OAuth instead. Operators can turn the endpoint off with
`AGENT_SIGNUP_DISABLED=1`.

## Admin API key

Administrator endpoints (metrics, audit, backup, restore, deletion jobs)
additionally accept an `X-Admin-API-Key` header carrying the instance's admin
API key, configured by the instance operator. Alternatively an authenticated
user whose email matches the instance's `ADMIN_EMAIL` is treated as an
administrator — but **not** when they authenticated with an MCP OAuth grant,
which is refused on these routes before routing.

## Dev login

For local development:

```bash
curl http://localhost:8787/dev-login
```

The route is gated on `DEV_LOGIN_ENABLED = "true"` **and** a `localhost` /
`127.0.0.1` request host, checked as one condition so neither gate can be
bypassed alone. The flag is `"true"` only in the top-level (local) `wrangler.toml`
config and `"false"` in staging and production, where the route answers `403`.
