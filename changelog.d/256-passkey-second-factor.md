### Added
- **Passkeys as a second factor.** Add a passkey (WebAuthn: Touch ID, Windows
  Hello, a password manager, or a security key) at **Settings → Security**. After
  that, signing in with a magic link, GitHub, Google, or SSO also asks for the
  passkey before the session starts. Your first passkey comes with ten one-time
  recovery codes, shown once, so a lost device does not lock you out. Passkeys can
  be renamed and removed. Managing them requires a recent sign-in. The JSON API is
  at `/api/users/me/passkeys`.
- **Organizations can require a second factor.** An org admin sets
  `PUT /api/orgs/{slug}/security` `{"requireSecondFactor": true}`. Members
  without a passkey can then reach only the passkey setup page. A session that
  skipped a member's passkey is signed out. A session that signed in through the
  org's own SSO satisfies that org's requirement (the IdP's MFA is trusted).
- New audit events: `passkey.registered`, `passkey.renamed`, `passkey.removed`,
  `second_factor.succeeded`, `second_factor.failed`, `recovery_code.used`,
  `recovery_codes.regenerated`, and `org.second_factor_policy_changed`.
- Optional `APP_URL` setting binds passkeys to one origin on instances reachable
  under more than one hostname.

### Security
- API tokens, agent tokens, MCP OAuth grants, SCIM tokens, and git over HTTPS
  are **not** subject to the second factor. They are possession-based,
  scoped, and revocable. Revoke any you no longer trust.
