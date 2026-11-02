# auth.md — agent registration for Stratum

This document tells an AI agent how to obtain credentials for the Stratum API
and what those credentials are allowed to do.

## Audience

Autonomous coding agents, MCP clients, and CI integrations that need to read
projects, open changes, and merge approved work through the Stratum API at
`https://app.usestratum.dev`. Human contributors should use the
[web UI](https://app.usestratum.dev) instead.

## Read this first: two credential systems, and which one you want

Stratum authenticates two surfaces, and they do not share a credential model.

**The REST API takes opaque bearer tokens.** It is not an OAuth-protected
resource: there is no `authorization_endpoint` and no `jwks_uri` describing it,
and no `/.well-known/oauth-authorization-server` document for it. A human account
holder mints the token out-of-band and hands it to you. That is the registration
flow below.

**The MCP endpoint at `/mcp` is an OAuth 2.1 protected resource**, and
`https://app.usestratum.dev` is its authorization server — dynamic client
registration (RFC 7591), PKCE, a browser consent screen, and `mcp:read` /
`mcp:write` scopes. Its metadata is published on that origin, because RFC 9728
and RFC 8414 have a client derive both URLs from the resource's own origin:

| Document | URL |
|---|---|
| Protected-resource metadata (RFC 9728) | `https://app.usestratum.dev/.well-known/oauth-protected-resource` |
| Authorization-server metadata (RFC 8414) | `https://app.usestratum.dev/.well-known/oauth-authorization-server` |

You do not need either in advance. `POST /mcp` with no credential and the `401`'s
`WWW-Authenticate` header names the first, which points at the second.

So: if you drive an editor and can open a browser, connect over MCP and let the
OAuth flow issue your credential — nothing is configured ahead of time. If you
are headless, follow the registration flow below and send the resulting token as
a bearer.

**There is no client-credentials grant on either surface**, and none is planned.
An agent's authority in Stratum derives from a human's, so a machine cannot mint
itself a credential without one — every OAuth grant begins with a person at a
consent screen. GitHub OAuth and Google OAuth appear only as *inbound sign-in
providers* for humans; they do not issue tokens for the Stratum API.

## Registration is delegated, not self-service

Agent identities are created by a human account holder. There is no anonymous
self-registration endpoint, and none is planned: an agent's authority in Stratum
is derived from a human's, and that link is the point.

**Do not probe `POST /api/agents` speculatively.** It creates a real identity and
issues a real credential. Only call it when a human has asked you to.

### Flow

1. **A human obtains a user token.** They sign in at
   `https://app.usestratum.dev` — email magic link, GitHub OAuth, or Google
   OAuth — and create or rotate a `stratum_user_...` token from the settings UI
   (`POST /api/users/me/rotate-token`).

2. **The human registers the agent identity.**

   ```bash
   curl -X POST https://app.usestratum.dev/api/agents \
     -H "Authorization: Bearer stratum_user_xxxxx" \
     -H "Content-Type: application/json" \
     -d '{"name": "refactor-bot"}'
   ```

   The response carries a `stratum_agent_...` token.

3. **The agent receives the token out-of-band** — an environment variable or a
   secret store. It is never transmitted to the agent by Stratum directly.

An agent driving an editor with a browser can skip all of this and connect over
MCP at `/mcp` instead, where OAuth 2.1 with dynamic client registration issues
the credential after a human consents. That grant is a *user* credential, not an
agent identity — see [the MCP guide](https://docs.usestratum.dev/guides/mcp/).

## Using the credential

| | |
|---|---|
| Credential type | Opaque bearer token |
| Prefix | `stratum_agent_` (agents), `stratum_user_` (humans) |
| Transport | `Authorization: Bearer <token>` header |
| Alternative | `stratum_session` cookie — browsers only, not for agents |
| Scopes | A user token carries `read` or `read_write`. An agent token carries neither: its authority is the owning user's access, minus the human-only gates. |
| Lifetime | A `stratum_user_` token is short-lived — obtain a new one after a `401`. A `stratum_agent_` token has no TTL: it is valid until the agent or the owning account is deleted (see Revocation). Never retry a `401` in a loop. |

**These are the REST API's credentials, minted out-of-band.** The MCP endpoint
at `app.usestratum.dev/mcp` is a separate surface with its own OAuth 2.1 flow —
dynamic client registration, PKCE, a browser consent screen, and `mcp:read` /
`mcp:write` scopes — so an agent driving an editor never needs one of the tokens
above. It accepts them anyway, for headless callers with no browser. See
[the MCP guide](https://docs.usestratum.dev/guides/mcp/).

```bash
curl -H "Authorization: Bearer $STRATUM_API_KEY" \
  https://app.usestratum.dev/api/projects
```

Call `GET /api/users/me` once at startup to confirm which identity you hold.

## Revocation

Revoke an agent credential with `DELETE /api/agents/{agent_id}`, authenticated as
the owning user. That is the only thing that revokes it:

- **`POST /api/users/me/rotate-token` does not.** It replaces the *user's* token
  and leaves every agent credential the account owns working.
- **Agent credentials do not expire.** There is no TTL on them; they are valid
  until the agent is deleted or the owning account is.
- **An agent cannot revoke itself.** An `stratum_agent_…` credential does not
  authenticate as a user, so both endpoints above answer it with `401`.

There is no webhook for revocation events; treat a `401` as authoritative and
stop.

## What the credential may not do

- **It can never approve a change.** Reviews are human-only across REST, CLI, and
  MCP. There is no configuration that relaxes this, and no user token you may
  hold for another purpose makes it acceptable to route around.
- **It cannot exceed the owning user's access**, including org access.
- **It cannot force-merge past a failing gate** unless the project's
  `.stratum/policy.yaml` sets `allowForce: true`. Force-merge is deny-by-default.

## No credential required

`GET /health`, `GET /api/health`, `GET /api/health/simple`,
`GET /api/users/check-username`, and read endpoints on projects with
`visibility: public`.

`POST /api/webhooks/github` is authenticated by HMAC signature
(`X-Hub-Signature-256`), not by a bearer token.

## Skills

- [Getting a Stratum agent identity](https://docs.usestratum.dev/.well-known/agent-skills/stratum-agent-identity/SKILL.md)
- [Getting a change through the merge gate](https://docs.usestratum.dev/.well-known/agent-skills/stratum-merge-gate/SKILL.md)
- [Using Stratum over MCP](https://docs.usestratum.dev/.well-known/agent-skills/stratum-mcp/SKILL.md)

## See also

- [Authentication reference](https://docs.usestratum.dev/reference/authentication/)
- [OpenAPI specification](https://docs.usestratum.dev/openapi.yml)
- [Agent discovery index](https://docs.usestratum.dev/.well-known/ai-catalog.json)
