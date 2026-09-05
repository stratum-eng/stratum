---
title: "Authentication"
description: "Named scoped API tokens, agent tokens, session cookies, anonymous access, and the admin API key."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/api/authentication.md"
---

Most API endpoints accept a Stratum API token as an
`Authorization: Bearer <token>` header. Browser requests may instead be
authenticated by the `stratum_session` cookie. The
[OpenAPI specification](/reference/openapi/) marks the exact security requirements per
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

```bash
curl -H "Authorization: Bearer stratum_user_xxxxx" \
  https://app.usestratum.dev/api/projects
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
private project its owner can read. Sessions and agent tokens are unaffected by
scopes.

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
**only** — the cookie every web sign-in sets (magic link, GitHub, or Google
OAuth). An API token calling them gets `403 SESSION_REQUIRED`, whatever its
scope. A token that could mint tokens, revoke its siblings, or turn off the
legacy credential would make revocation meaningless — a lost machine would
simply issue itself a replacement.

The plaintext is returned exactly once, by the call that creates it, with
`Cache-Control: no-store`. It is never stored and never listed again; a listing
shows only the non-secret prefix (e.g. `stratum_user_1a2b3c4d`), which is enough
to recognise a credential sitting in a CI config.

```bash
# Create a read-only token that expires in 90 days (session cookie required)
curl -X POST https://app.usestratum.dev/api/users/me/tokens \
  -b "stratum_session=..." -H "Content-Type: application/json" \
  -d '{"name":"buildkite","scope":"read","expiresInDays":90}'
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
  [the MCP guide](/guides/mcp/).
- **The CLI**, since `stratum login` — see [the CLI guide](/guides/cli/).
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

Grants are listed and revoked by their owner under **Settings → Connected
applications**, and by the client itself at `POST /oauth/revoke`
([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)). Revocation is
immediate and covers both halves of the pair — revoking either the access token
or the refresh token ends the grant.

## Anonymous access

Read endpoints on projects with `visibility: public` accept anonymous
requests. A small set of endpoints requires no authentication at all:

- `GET /health`, `GET /api/health`, `GET /api/health/simple` — liveness and
  dependency health checks
- `GET /api/users/check-username` — username availability
- `POST /api/webhooks/github` — the inbound GitHub webhook receiver, which is
  authenticated by HMAC signature (`X-Hub-Signature-256`) against the
  configured webhook secret rather than by a bearer token

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
