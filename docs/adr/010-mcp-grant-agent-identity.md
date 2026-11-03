# ADR 010: Agent Identity on MCP OAuth Grants

## Status

Accepted. Implements #409.

## Context

The remote MCP server (`/mcp`, #349) authenticates editors with OAuth 2.1
grants. A grant has always acted as **the user who consented**: requests made
with it set `userId`, exactly as a user token does.

That made MCP the one way of doing agent work in Stratum that leaves no agent
behind. A change opened over MCP by Claude Code is recorded as opened by the
user, so its provenance (agent, model, prompt hash) is empty and the activity
feed shows a person. Provenance is one of the main things Stratum records, and
MCP is the main way agents now reach it.

The obvious fix doesn't work. `POST /api/agents` refuses OAuth grants (#376),
because an agent token never expires and is not tied to the credential that
minted it. A client that could mint itself an agent token would keep access
after the user disconnected it. So the identity has to be bound to the grant by
the user, at consent, and must not create a credential that outlives the grant.

## Decision

### The consent screen asks which identity the client acts as

The consent page (`GET /oauth/authorize`) gets one more question, rendered on
the server as radio buttons and a `<select>`, with no JavaScript:

```
Connect as:
  (•) A new agent named [ Claude Code                ]   e.g. "Claude Code on my-laptop"
  ( ) An existing agent  [ release-bot ▾ ]               (only when the user owns one)
  ( ) Me (alice)       — work is recorded as yours, with no agent provenance
```

- **The default is a new agent**, prefilled with the client's registered name.
  It is the more restricted choice as well as the one that records
  provenance: an agent cannot list the user's whole namespace, reach account
  settings, or approve a change.
- **Existing agent** lists only agents the signed-in user owns. The consent
  POST checks ownership again, and so does the token exchange, because the
  hidden and selected fields come back through a page, which is not a trust
  boundary.
- **Me** keeps today's behaviour for anyone who wants it, and says plainly
  what is lost.

The consent POST is gated exactly as before: a signed-in browser session,
same-origin, and the org second-factor-at-mint check (#428). Choosing "new
agent" adds no way to create an agent that the consent screen didn't already
require, so the #376 rule still holds. No credential the client holds can
create an agent. Only a person in the browser can.

### Requests made with a bound grant authenticate as the agent

`authMiddleware` resolves a bound grant to `agentId` = the agent and
`agentOwnerId` = the consenting user, with **no `userId`**. That is the same
context a `stratum_agent_` token produces, so every rule written for agent
tokens applies to MCP traffic unchanged: authorship, `createdByAgentId`,
`actor: { type: "agent" }` on events, the provenance snapshot of the agent's
model and prompt hash, and the approval-count exclusion for the owner.

The grant keeps the markers of a delegated credential. `oauthGrantId`,
`oauthClientId` and `tokenScope` are still set. So:

- `mcp:read` stays read-only (the scope rule keys on `tokenScope`);
- the admin API stays unreachable;
- `cannotMintLegacyCredential` is still true, so the grant can't mint agent
  tokens or rotate the legacy key, and **can't approve a change** (#427).
  An agent-bound grant is refused twice over: once as a delegated credential
  and once because there is no human `userId` to count as the approver.

### What happens to grants that already exist

Nothing, apart from a label. A grant issued before this change has
`agent_id = NULL` and keeps acting as the user until it is revoked or reaches
the 180-day cap, when the user sees the new consent screen. We don't rewrite
existing grants into agents. The user never chose an agent for them, and
silently changing who a credential acts as is a change of authority nobody
consented to.

Settings → Connected applications labels every grant with who it acts as:
"You (no agent provenance)" or "Agent: <name>".

### How `whoami` reports it

`GET /api/users/me` (the `stratum_whoami` MCP tool) now answers for a
bound grant instead of returning 401 as it does for a bare agent token:

```json
{ "actingAs": "agent", "agent": { "id": "agt_…", "name": "Claude Code on my-laptop" },
  "owner": { "id": "usr_…", "username": "alice" } }
```

A grant acting as the user gets the existing body plus `"actingAs": "user"`.
The asymmetry with a bare agent token is deliberate. An agent that holds its
own token was created deliberately and knows its id. A client connected over
OAuth was given its identity on a page it never saw, and `whoami` is how it
finds out. The owner's email is not included: the agent acts for the owner and
doesn't need their contact details.

### The agent's access lives exactly as long as the grant

A consent-created agent is stored with `credential = 'oauth_grant'`. It has no
token. Its `token_hash` is the hash of a random value that is generated and
thrown away in the same function, and the agent-token lookup refuses
`oauth_grant` rows anyway. Its only way in is a grant bound to it, so:

- **Refresh** rotates the grant's tokens in place (same row, same `agent_id`),
  so the agent keeps working across rotations and nothing new is minted.
- **Revoke**, whether from Settings, RFC 7009 `/oauth/revoke`, or the
  automatic revocation on code or refresh-token replay, marks the grant row
  revoked. The resolver refuses it, and the agent has no other credential, so
  its access ends at that moment.
- **The 180-day cap** (`REFRESH_GRANT_MAX_MS`) expires the grant, and the agent
  with it. Reconnecting shows the consent screen again, where the user can pick
  the same agent from "existing agent" to continue its history under one
  identity.
- **Deleting the agent** also ends the grant's access: the resolver LEFT JOINs
  `agents` and fails closed when the agent is missing or no longer owned by the
  grant's user.

The agent row itself is kept after its grant ends. Changes and provenance
reference it, and an identity that disappears when its credential does would
erase the provenance this change exists to record. A row with no credential
grants nothing.

Binding an *existing* token-backed agent creates no credential either. That
agent's own token predates the grant and is unaffected by it. Revoking the
grant ends the access that came through the grant, and nothing else.

## Consequences

- MCP work done through a bound grant has agent provenance and shows as the
  agent in the activity feed.
- An agent-bound client sees exactly what an agent token sees. In particular
  `stratum_list_projects` returns an empty list (agents address projects by
  `namespace/slug`), and the account-scoped `/api/users/me/*` endpoints that
  require a `userId` are refused. Users who need the old behaviour choose "Me".
- `agents` gains a `credential` column, `oauth_tokens` and `oauth_auth_codes`
  gain `agent_id`, and codes gain `new_agent_name` (migration 067). There is no
  foreign key from grants to agents, by design (see the migration).
