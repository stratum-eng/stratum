### Added
- **Passkeys as a second factor.** Add a passkey (WebAuthn: Touch ID, Windows
  Hello, a password manager, or a security key) at **Settings → Security**. After
  that, signing in with a magic link, GitHub, Google, or SSO also asks for the
  passkey before the session starts. Your first passkey comes with ten one-time
  recovery codes, shown once, so a lost device does not lock you out. Passkeys can
  be renamed and removed. Managing them requires a recent sign-in. The JSON API is
  at `/api/users/me/passkeys`.
- **Organizations can require a second factor.** An org admin sets
  `PUT /api/orgs/{slug}/security` `{"requireSecondFactor": true}`. A member's
  session that has not passed a second factor then gets
  `403 SECOND_FACTOR_REQUIRED` on **that org's** projects and org endpoints, with
  a link to set up a passkey. Members' personal projects, other organizations,
  and account settings are never affected. A session that signed in through the
  org's own SSO satisfies that org's requirement (the IdP's MFA is trusted).
- **Members can leave an organization.** `DELETE /api/orgs/{slug}/members/{own
  id}` works for any member, including when the org's policy blocks them. The
  owner cannot leave.
- New audit events: `passkey.registered`, `passkey.renamed`, `passkey.removed`,
  `second_factor.succeeded`, `second_factor.failed`, `recovery_code.used`,
  `recovery_codes.regenerated`, and `org.second_factor_policy_changed`.
- Optional `APP_URL` setting binds passkeys to one origin on instances reachable
  under more than one hostname.

### Security
- API tokens, the legacy API key, agent tokens, MCP OAuth grants, SCIM tokens,
  and git over HTTPS are **not** subject to the second factor. They are not all
  scoped: the legacy key and agent tokens carry full account access. Revoke,
  rotate, or disable any you no longer trust.
- **Recovery codes** are 12 characters (about 59 bits). They are stored as
  per-user hashes, keyed with HMAC when the optional `RECOVERY_CODE_PEPPER`
  secret is set. Each code works once.
