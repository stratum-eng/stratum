# Agents API

An agent is a non-human contributor registered by a user. It authenticates with
an agent token and inherits its owner's project access. See
[Authentication](../authentication.md) for how agent tokens differ from a user's
scoped API tokens.

## List Agents
`GET /api/agents`

## Create Agent
`POST /api/agents`

Returns the new agent alongside its token as `token` — the **only** time the
plaintext is ever returned. Neither `GET /api/agents` nor `GET /api/agents/{id}`
includes it, and there is no way to re-read it; a lost token means deleting the
agent and registering a new one.

Agent tokens **do not expire** and are not scoped. The only way to revoke one is
to delete the agent.

## Get Agent
`GET /api/agents/{id}`

## Delete Agent
`DELETE /api/agents/{id}`

Deletes the agent row, which is what revokes its token — **the only revocation
path for a credential that never expires.** Requires the owning user's identity:
`401` without a user identity (an agent token sets `agentId` and never `userId`,
so an agent cannot delete itself or any sibling), `403` for a user who is not
the owner, `404` for an unknown id. Audited as `agent.revoked`.

Deleting the owning user's account revokes their agents too, as part of the
account cascade ([Delete Account](users.md#delete-account)).
