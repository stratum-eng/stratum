---
name: stratum-agent-identity
description: Obtain a Stratum agent identity and token, authenticate to the REST API, and understand what an agent token may and may not do.
license: MIT
homepage: https://docs.usestratum.dev/reference/authentication/
---

# Getting and using a Stratum agent identity

Stratum treats agents as first-class identities, not shared service accounts.
Each agent authenticates as itself, and its writes are attributed to it in
provenance.

## Registration

Agent registration is **delegated**: a human account holder creates the agent
identity, and Stratum returns a short-lived agent token. There is no anonymous
self-registration endpoint — see https://docs.usestratum.dev/auth.md for the
full registration contract.

A human with a user token runs:

```bash
curl -X POST https://app.usestratum.dev/api/agents \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "refactor-bot"}'
```

The response contains a `stratum_agent_...` token. Store it as `STRATUM_API_KEY`.

## Authenticating

Every request carries the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer $STRATUM_API_KEY" \
  https://app.usestratum.dev/api/projects
```

Browser sessions use a `stratum_session` cookie instead; agents should always use
the bearer header.

Call `GET /api/users/me` (or the MCP `stratum_whoami` tool) once at startup and
cache the result. It tells you which identity you hold.

## What an agent token can do

- Read any project it inherits access to
- Create workspaces, commit, and open changes
- Create and update issues
- Merge a change **once a human has approved it and the gates are green**

## What an agent token can never do

- **Approve or request changes on a review.** Reviews are human-only on every
  surface — REST, CLI, and MCP alike. No configuration relaxes this. Do not try
  to work around it by borrowing a user token.
- **Exceed the owning user's access.** The token is scoped to the human who
  created it and inherits exactly their project and org access, nothing more.
- **Force a merge past a failing gate**, unless the project policy explicitly
  sets `allowForce: true`. It is deny-by-default.

## Token hygiene

- Agent tokens are short-lived. Expect `401` and re-request rather than
  retrying a stale token in a loop.
- Rotate a user token with `POST /api/users/me/rotate-token`. Rotation
  invalidates the old token immediately.
- Never write a token into a commit. The secret scanner is always on and will
  block the merge — correctly.

## Unauthenticated surface

These need no token: `GET /health`, `GET /api/health`,
`GET /api/health/simple`, `GET /api/users/check-username`, and read endpoints on
projects with `visibility: public`.

## Reference

- Authentication: https://docs.usestratum.dev/reference/authentication/
- Agent registration contract: https://docs.usestratum.dev/auth.md
- Error codes: https://docs.usestratum.dev/reference/errors/
