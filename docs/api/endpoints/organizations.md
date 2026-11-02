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

With `requireSecondFactor` on, a member's browser session reaches this org's
projects and `/api/orgs/:slug/` endpoints only if it passed a passkey check or
signed in through this org's own SSO. Otherwise those requests return
`403 SECOND_FACTOR_REQUIRED`. The policy never affects members' personal
projects, other orgs, or account settings. See
[Passkeys and two-factor sign-in](../../user-guide/passkeys.md). Turning it on
returns `409 ADMIN_SECOND_FACTOR_REQUIRED` until you have a passkey yourself.
API tokens are not affected.

## Members and teams

Any member can leave with `DELETE /api/orgs/:slug/members/<own user id>`, even
when the org's second-factor policy blocks them. The owner cannot leave
(`409 OWNER_CANNOT_LEAVE`). Removing anyone else requires an org admin.

Members and teams are managed under `/api/orgs/{slug}/members` and
`/api/orgs/{slug}/teams` — add and remove a member, create, list and delete a
team, and add and remove a team's members. See the
[OpenAPI specification](../openapi.yml) for the exact routes and schemas.
