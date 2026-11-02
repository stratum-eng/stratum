# Organizations API

## List Organizations
`GET /api/orgs`

## Create Organization
`POST /api/orgs`

## SSO Connection (org admins/owner)

- `PUT /api/orgs/:slug/sso` — create or replace the org's OIDC connection
- `GET /api/orgs/:slug/sso` — read the connection (secrets redacted)
- `DELETE /api/orgs/:slug/sso` — delete the connection
- `POST /api/orgs/:slug/sso/verify-domains` — verify email domains via DNS TXT
- `POST /api/orgs/:slug/sso/enable` — enable (requires verified domains)
- `POST /api/orgs/:slug/sso/disable` — disable
- `POST /api/orgs/:slug/sso/scim-token` — rotate the SCIM bearer token

See the [OpenAPI specification](../openapi.yml) for full request/response
shapes, and [Authentication](../authentication.md) for the SCIM token class.

## Security policy

- `GET /api/orgs/:slug/security` — read the policy (any member)
- `PUT /api/orgs/:slug/security` — `{ "requireSecondFactor": true }` (admins/owner)

With `requireSecondFactor` on, every member's browser session must have passed a
passkey check, or have signed in through this org's own SSO. See
[Passkeys and two-factor sign-in](../../user-guide/passkeys.md) for how it is
enforced. Turning it on returns `409 ADMIN_SECOND_FACTOR_REQUIRED` until you
have a passkey yourself. API tokens are not affected.

## Members and teams

Members and teams are managed under `/api/orgs/{slug}/members` and
`/api/orgs/{slug}/teams` — add and remove a member, create, list and delete a
team, and add and remove a team's members. See the
[OpenAPI specification](../openapi.yml) for the exact routes and schemas.
