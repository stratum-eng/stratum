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

## Members and teams

Members and teams are managed under `/api/orgs/{slug}/members` and
`/api/orgs/{slug}/teams` — add and remove a member, create, list and delete a
team, and add and remove a team's members. See the
[OpenAPI specification](../openapi.yml) for the exact routes and schemas.
