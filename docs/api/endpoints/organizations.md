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
- `PUT /api/orgs/:slug/security` — `{ "requireSecondFactor": true }` (admins/owner).
  Either field (`requireSecondFactor`, `ipAllowlist`) may be sent alone.

With `requireSecondFactor` on, a member's browser session reaches this org's
projects and `/api/orgs/:slug/` endpoints only if it passed a passkey check or
signed in through this org's own SSO. Otherwise those requests return
`403 SECOND_FACTOR_REQUIRED`. The policy never affects members' personal
projects, other orgs, or account settings. See
[Passkeys and two-factor sign-in](../../user-guide/passkeys.md). Turning it on
returns `409 ADMIN_SECOND_FACTOR_REQUIRED` until you have a passkey yourself.
API tokens are not checked against the policy when they are used. Instead the
policy applies when a credential is created: a session that has not met it
cannot mint an unbound API token, a token bound to this org or its projects,
an agent token, a rotated legacy key, or an OAuth grant (MCP/CLI consent).
Those requests return `403 SECOND_FACTOR_REQUIRED`. Tokens bound to other
targets are unaffected. See
[Creating credentials](../../user-guide/passkeys.md#creating-credentials).

### IP allowlist

- `PUT /api/orgs/:slug/security` — `{ "ipAllowlist": ["203.0.113.0/24", "2001:db8::/32"] }`
  (admins/owner). `[]` removes the restriction.

When the list is non-empty, requests from outside it cannot use the access the
org grants. This covers its projects (including git clone and push), its
`/api/orgs/:slug/` endpoints, and creating projects in it. Every credential is
covered: sessions, API tokens, agent tokens, and OAuth grants. Those requests
return `403 IP_NOT_ALLOWED`, with `org` and the `ip` Stratum saw. A caller who is
not a member gets the usual `404` instead. Anonymous reads of public projects,
the SSO sign-in flow, SCIM, and leaving the org are not restricted. The client
address comes from `CF-Connecting-IP` only, and a request without it is refused.

Entries are IPv4 or IPv6 addresses or CIDR ranges, at most 100. They are returned
in canonical form. Saving a list that excludes your own current address returns
`409 IP_ALLOWLIST_SELF_LOCKOUT`; add `"allowSelfLockout": true` to save it
anyway. Changes are audited as `org.ip_allowlist_changed`. Refusals are audited
as `org.ip_access_denied`, at most once per member per org every 10 minutes. See
[Organization IP allowlists](../../user-guide/org-ip-allowlist.md).

## Members and teams

Any member can leave with `DELETE /api/orgs/:slug/members/<own user id>`, even
when the org's second-factor policy or IP allowlist blocks them. The owner cannot leave
(`409 OWNER_CANNOT_LEAVE`). Removing anyone else requires an org admin.

Members and teams are managed under `/api/orgs/{slug}/members` and
`/api/orgs/{slug}/teams` — add and remove a member, create, list and delete a
team, and add and remove a team's members. See the
[OpenAPI specification](../openapi.yml) for the exact routes and schemas.

Every add, removal, and role change of a member, and every team created,
deleted, joined, or left, is recorded in the org's audit log below.

## Audit log (org admins/owner)

- `GET /api/orgs/:slug/audit` — one page of the org's audit trail, newest first
- `GET /api/orgs/:slug/audit/export` — the same entries as an NDJSON download

Plain members get `403`; non-members get the same `404` as a missing org.
A token bound to a project or organization is refused with `403
TOKEN_BINDING_EXCLUDES_ROUTE`, even one bound to this org: reading the audit
log is org administration, so use a session or an unbound token.

**What lands in an org's trail.** Events about the org itself (creation,
member added/removed, role changed, teams and team membership, SSO connection
and SCIM token administration, SCIM provisioning), failed SSO sign-ins against
the org's connection, and events on projects the org owns (forced merges,
dismissed approvals, manual conflict resolutions, webhooks, branches, deploy
secrets, deployment approvals and retries, deletion requests). Account-level
events — a user's own tokens, sessions, agents — belong to no org and appear
only in the instance-wide `GET /api/admin/audit`. Entries recorded before org
scoping shipped carry no org and are likewise instance-only.

**Filters.** `action`, `actor` (actor id), `since` (inclusive) and `until`
(exclusive, both ISO-8601). Malformed values are a `400`, never silently
ignored.

**Pagination.** `limit` (1–500, default 100). The response is
`{ "entries": [...], "nextCursor": "..." }`; pass `nextCursor` back as
`cursor` for the next, older page. It is absent on the last page. Cursors are
keyset-based, so pages stay stable while new events are appended.

```bash
curl -H "Authorization: Bearer $STRATUM_TOKEN" \
  "https://your-instance.workers.dev/api/orgs/acme/audit?action=org.member.role_changed&limit=50"
```

**Export.** `GET /api/orgs/:slug/audit/export` (or `?format=ndjson` on the read
route) streams one JSON entry per line for the window `[since, until)`.
`until` defaults to now and `since` to 30 days earlier; a window longer than
90 days is refused with `400`, so export long periods in consecutive windows.
If storage fails partway through, the download is aborted rather than cut
short, so a file that completes is a complete window.

```bash
curl -H "Authorization: Bearer $STRATUM_TOKEN" -o acme-audit.ndjson \
  "https://your-instance.workers.dev/api/orgs/acme/audit/export?since=2026-10-01T00:00:00Z&until=2026-11-01T00:00:00Z"
```

**Failed sign-ins.** An `auth.failed` entry is written only when the attempt
identifies something real — for an org, an SSO callback that reached its
connection with a valid sign-in state (bad or expired ID token, nonce
mismatch, email outside the verified domains, a disabled account). Repeats
for the same account or connection are collapsed to at most one entry per
minute.

**Who an entry is about.** An entry's `subject` is the thing acted on, never a
person: member and role events carry the org id (team membership events the
team id), and SCIM provisioning events carry the SSO connection id. The member
or provisioned user is named in `detail.userId`. Entries written before this
change carried the user id in `subject`.

**Immutability.** The audit log is append-only: there is no API to edit or
delete an entry, and the database rejects updates and deletes. The single
exception is account erasure, which replaces the erased person's id and email
with `deleted-user` — in the actor, the subject, and any complete value in
`detail` — and changes nothing else. The database accepts every such rewrite
only to the `deleted-user` sentinel, and the subject and detail rewrites only for
an account that is being deleted.
