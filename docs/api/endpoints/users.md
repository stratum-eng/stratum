# Users API

Token management is covered in full — scopes, expiry, limits, and the legacy
credential — in [Authentication](../authentication.md).

## Get Current User
`GET /api/users/me`

Returns the authenticated user's profile, with `"actingAs": "user"`: `id`,
`email`, `username` (the caller's personal namespace is `@username`) and
`createdAt`.

```json
{ "id": "usr_…", "email": "alice@example.com", "username": "alice", "createdAt": "…", "actingAs": "user" }
```

An MCP OAuth grant [bound to an agent](../authentication.md#oauth-grants) gets
the agent and the owner it acts for instead. The owner's email is not included:

```json
{
  "actingAs": "agent",
  "agent": { "id": "agt_…", "name": "Claude Code on my-laptop" },
  "owner": { "id": "usr_…", "username": "alice" }
}
```

A bare agent token (`stratum_agent_…`) gets `401`.

## Get Current Usage

`GET /api/users/me/usage`

The caller's metered usage against their plan for the current billing period:
each meter's consumption and limit, the rate ceilings, the period, and when it
resets. A limit of `-1` is unlimited and `0` is a plan that forbids that meter
outright, so a client renders words rather than computing a percentage against
either.

Read-only, and deliberately the **only** billing surface a token can reach:
there is no endpoint here to raise a limit, buy capacity, or attach a payment
method. An **agent token** reports its owner's allowance, because that is the
account its evaluations are charged to.

Figures cover platform-billed usage only. Spend on a project's own provider key
(BYOK) is reported separately and never counted against an allowance. On an
instance with no billing service configured — every self-hosted deployment —
`metered` is `false` and every limit is unlimited.

## API tokens

Listing, creating, revoking, and disabling the legacy token accept the
**browser session cookie only**. An API token calling those gets
`403 SESSION_REQUIRED`, whatever its scope — a token that could mint or revoke
tokens would make revocation meaningless. `rotate-token` is the exception and
has its own rule, described with it below.

### List Tokens
`GET /api/users/me/tokens`

Shows each token's name, scope, expiry, `lastUsedAt`, and non-secret prefix,
and — for a token bound to a project or organization — a `binding` object
(`kind`, the target's id, and a readable `label` such as `@alice/web`). An
account-wide token has no `binding`. The plaintext is never listed again.

### Create Token
`POST /api/users/me/tokens`

```json
{ "name": "buildkite", "scope": "read", "expiresInDays": 90 }
```

`scope` is `read` (default) or `read_write`. `expiresInDays` is 1–365; omit for
a token that never expires. The plaintext is returned **exactly once**, by this
call, with `Cache-Control: no-store`. `409 TOKEN_LIMIT_REACHED` past 20 active
tokens.

To limit the token to one project or one organization's projects, add **one**
of:

```json
{ "name": "deploy-bot", "scope": "read_write", "project": "@alice/web" }
{ "name": "acme-ci", "scope": "read", "org": "acme" }
```

You must be able to read the project, or be a member of the organization;
otherwise `404`, exactly as for one that does not exist. Both at once is a
`400`. A bound token is refused (`403 TOKEN_BINDING_EXCLUDES_ROUTE`) on every
endpoint outside the project surfaces — see
[Project and organization binding](../authentication.md#project-and-organization-binding).

### Revoke Token
`DELETE /api/users/me/tokens/{id}`

Revoked rows are kept, so the audit trail survives revocation, and they do not
count toward the 20-token limit.

### Disable the Legacy Token
`POST /api/users/me/legacy-token/disable`

Permanently disables the single unnamed credential every account carries on its
user row (minted at signup; revealed only by `rotate-token`). Named tokens are
unaffected. **Cannot be undone** — move anything still using it onto a named
token first.

### Rotate the Legacy Token
`POST /api/users/me/rotate-token`

Accepts a browser session **or the legacy credential itself**, but refuses a
**scoped** token with `SESSION_REQUIRED`. The key it mints never expires and
cannot be revoked individually, so letting a scoped token rotate it would mean
revoking that token contained nothing — it could have issued itself a permanent
replacement on the way out.

## Passkeys

Passkeys (WebAuthn) are the second factor of browser sign-in. See
[Passkeys and two-factor sign-in](../../user-guide/passkeys.md). Every endpoint
below accepts the **browser session cookie only** (`403 SESSION_REQUIRED` for a
token). Registering, removing, and regenerating recovery codes also need a
session from the last 15 minutes that used the account's existing passkey, if it
has one. Otherwise they return `403 REAUTHENTICATION_REQUIRED`.

- `GET /api/users/me/passkeys` — the passkeys (name, created, last used) and
  `recoveryCodesRemaining`
- `POST /api/users/me/passkeys/registration/options` — WebAuthn creation options
  for `navigator.credentials.create()`; the challenge is single-use and expires
  after 5 minutes
- `POST /api/users/me/passkeys/registration/verify` —
  `{ "name": "Laptop", "response": <RegistrationResponseJSON> }`; on the first
  passkey the `201` also carries ten one-time `recoveryCodes`, shown once
- `PATCH /api/users/me/passkeys/{id}` — `{ "name": "…" }`
- `DELETE /api/users/me/passkeys/{id}` — removing the last passkey also deletes
  the recovery codes
- `POST /api/users/me/passkeys/recovery-codes` — replace the recovery codes

## Delete Account
`DELETE /api/users/me`

GDPR-grade account erasure. Deletes the caller's account and **all** owned
projects, revokes all tokens/sessions (and the user's agents), and **anonymizes**
the user's contributions to *other* people's projects (author set to a
`deleted-user` tombstone — the contribution stays, the identity is removed).
Audit log entries are kept, with the account's id and email replaced by
`deleted-user` wherever they appear — as the actor, as the subject, or as a
value in the entry's detail.
Requires confirmation with the caller's own username:

```json
{ "confirm": "<your-username>" }
```

Setting deletion **immediately invalidates the caller's credentials** (subsequent
requests return `401`). Returns `202 Accepted` with
`{ "status": "deleting", "jobId": "del_…" }`; the cascade runs asynchronously and
always completes (org sole-ownership is auto-resolved, never blocking erasure). A
mismatched `confirm` returns `400`.
