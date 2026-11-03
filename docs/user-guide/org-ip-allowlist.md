# Organization IP allowlists

An organization can limit where its resources are reached from. When the org has
an IP allowlist, requests from outside the listed networks cannot use the access
that org membership grants. This applies to every kind of credential.

## Setting the allowlist

Org admins and the owner set the list. It accepts IPv4 and IPv6 addresses and
CIDR ranges:

```bash
curl -X PUT https://app.usestratum.dev/api/orgs/acme/security \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ipAllowlist": ["203.0.113.0/24", "2001:db8::/32"]}'
```

- A bare address means that one host (`/32` or `/128`).
- Entries are saved in canonical form, and duplicates are removed. For
  example, `10.1.2.3/8` is saved as `10.0.0.0/8`, the range it describes.
- The list can hold up to 100 entries.
- An empty list (`"ipAllowlist": []`) removes the restriction. This is the
  default, so existing orgs are not affected.
- `GET /api/orgs/{slug}/security` returns the current list. Any member can read
  it, but only from an allowed network once a list is set.

`ipAllowlist` and `requireSecondFactor` are independent. You can send either
one or both in the same request.

### Self-lockout guard

Stratum refuses to save a list that does not include the address your own
request comes from. Saving it would lock you out of the org, and nobody outside
the listed networks could undo the change. You get `409` with code
`IP_ALLOWLIST_SELF_LOCKOUT` and the address Stratum saw.

Sometimes this is intended. For example, you might set the office range while
working from home. In that case, resend the request with
`"allowSelfLockout": true`. The audit entry records that you used the override.

If every admin is locked out, an operator of the Stratum instance has to clear
the list in the database:

```sql
UPDATE orgs SET ip_allowlist = NULL WHERE slug = 'acme';
```

## What it restricts

The allowlist applies **only to that organization's own resources**:

- its projects: code, changes, reviews, issues, deployments, secrets,
  workspaces, and git clone and push
- its org endpoints under `/api/orgs/{slug}/`: details, members, teams, SSO
  configuration, the security policy, and the audit log
- creating a project in the org

It applies to every credential: browser sessions, API tokens (scoped and
legacy), agent tokens, MCP/CLI OAuth grants, and git over HTTPS. For an MCP tool
call, the address checked is the one of the client that called `/mcp`.

A member's personal projects, other organizations, and account settings are
**never** affected. A member can always leave the org
(`DELETE /api/orgs/{slug}/members/{own id}`), from any network.

### What it does not restrict

- **Public projects stay public.** Anyone can still read a public project of the
  org, signed in or not, from any network. The allowlist withholds only what
  membership adds: private projects, write access, and the org's endpoints.
  Make a project private if the allowlist should protect its content.
- **Signing in.** The SSO sign-in flow (`/auth/sso/*`) is not restricted. Signing
  in does not act on the org's resources, and your identity provider may be
  reached from anywhere. After sign-in, the session is held to the allowlist
  like any other credential.
- **SCIM provisioning** (`/scim/v2`) is exempt. SCIM calls come from your
  identity provider's servers, whose addresses you do not control and which
  can change without notice. If those calls were blocked, deprovisioning would
  stop working without any warning, and deprovisioning is the security-critical
  direction. SCIM is authenticated by its own per-connection `stratum_scim_*`
  token, which you can rotate at any time
  (`POST /api/orgs/{slug}/sso/scim-token`).
- **Webhooks and deploy callbacks.** Outbound deliveries, and inbound callbacks
  verified by an HMAC signature, are not affected.

## When a request is refused

A request from outside the allowlist gets `403` with code `IP_NOT_ALLOWED`. The
body names the org and the address Stratum saw:

```json
{
  "error": "The organization 'acme' only allows access from its configured networks, and this request came from 198.51.100.9. …",
  "code": "IP_NOT_ALLOWED",
  "org": "acme",
  "ip": "198.51.100.9"
}
```

A browser shows the same explanation as a page. Over git, the refusal is a
plain-text `403` with an `X-Stratum-Error-Code: IP_NOT_ALLOWED` header.

Only a member, or someone the org would otherwise let in, sees this refusal.
Anyone else gets the usual `404`, so the allowlist does not reveal whether a
private project or the org exists.

### How the address is determined

Stratum uses the `CF-Connecting-IP` header, which Cloudflare's edge sets and a
client cannot override. `X-Forwarded-For` is never read. A request with no
client address is treated as outside every range, so a restricted org fails
closed. An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) matches the
corresponding IPv4 range.

## Audit log

The org's audit log records:

- `org.ip_allowlist_changed` for every change, with the new list, the previous
  list, and whether `allowSelfLockout` was used
- `org.ip_access_denied` for refusals, with the refused address, method, and
  path. Refusals are **sampled**: at most one entry per member per org every 10
  minutes. A burst of refused requests, or requests from many addresses, cannot
  flood the log.

## Changes take effect immediately

The allowlist is read from the database with the same query that checks org
membership, and is not cached across requests. A change applies to the next
request, in every location.
