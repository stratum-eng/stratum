# Passkeys and two-factor sign-in

Stratum supports **passkeys** (WebAuthn) as a second factor. Once you add one,
signing in with a magic link, GitHub, Google, or your organization's SSO is no
longer enough on its own: Stratum asks for your passkey before your session
starts. Someone who gets into your email inbox cannot get into your Stratum
account.

A passkey can be your device's built-in authenticator (Touch ID, Face ID,
Windows Hello, Android screen lock), a password manager that stores passkeys, or
a hardware security key such as a YubiKey.

## Adding a passkey

1. Open **Settings → Security** (`/settings/security`).
2. Give the passkey a name you will recognize later, such as "MacBook Touch ID".
3. Click **Add passkey** and follow your browser's prompt.

Adding a passkey needs JavaScript — WebAuthn is a browser API with no form
equivalent.

For your security, adding or removing a passkey requires a sign-in from the last
15 minutes. If you already have a passkey, that sign-in must also have used it.
If the page says to sign in again, sign out and back in, then return to the page.

### Recovery codes

When you add your **first** passkey, Stratum shows **ten recovery codes**, once.
Store them somewhere safe, such as a password manager or printed paper. Each code
signs you in **one time** in place of your passkey, so a lost or broken device
does not lock you out of your account.

Stratum stores only a hash of each code and cannot show them again. To get a new
set, use **Generate new recovery codes** on the Security page. The old codes stop
working immediately. The page shows how many unused codes you have left.

## Signing in

After the first step of sign-in (the magic link, GitHub, Google, or SSO), you see
a **Verify it's you** page:

- Click **Use passkey** and approve the browser prompt, **or**
- Enter one of your recovery codes. This works without JavaScript.

The verification step expires after 10 minutes. After five failed attempts,
Stratum cancels the sign-in, and you must start again from the first step.

## Managing passkeys

On the Security page you can:

- **Rename** a passkey.
- **Remove** a passkey. When you remove your last passkey, Stratum also deletes
  your recovery codes, and sign-in goes back to a single step.

You cannot remove your **last** passkey while an organization you belong to
requires a second factor. Add another passkey first.

## What a second factor does not cover

A passkey protects **interactive browser sign-in**. These credentials work as
before and never ask for a passkey:

- API tokens (`stratum_user_…`) and the legacy API key
- Agent tokens (`stratum_agent_…`)
- MCP / OAuth grants for connected editors and agents (`stratum_mcp_…`)
- `git` over HTTPS, which authenticates with a token

Each of these is a credential you already hold. Each can be scoped and revoked
from **Settings**. Revoke any token you no longer trust. An API token cannot read or
change your passkeys.

## Requiring a second factor for an organization

An org admin or owner can require every member to use a second factor:

```bash
curl -X PUT https://app.usestratum.dev/api/orgs/acme/security \
  -H "Authorization: Bearer $STRATUM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"requireSecondFactor": true}'
```

`GET /api/orgs/{slug}/security` reads the setting. Any member can read it.

To prevent locking yourself out, you must have a passkey on your own account
before you can turn the policy on. The exception is when your current session
signed in through this org's SSO.

### How the policy is enforced

Stratum checks the policy on **every browser request**, not only on the org's
projects. While you belong to an org that requires a second factor:

- **You have no passkey yet:** you can reach only the Security page, its passkey
  API, and sign-out. Pages redirect to `/settings/security`. API requests return
  `403` with code `SECOND_FACTOR_ENROLLMENT_REQUIRED`. When you add a passkey,
  your current session counts as verified and everything works again.
- **You have a passkey, but this session did not use it** (for example, it
  started before the policy was turned on): Stratum signs the session out. Sign
  in again and use your passkey. API requests return `401` with code
  `SECOND_FACTOR_REQUIRED`.

**SSO sessions:** a session that signed in through an org's own SSO satisfies
**that org's** requirement. Stratum trusts the identity provider to enforce
multi-factor authentication, so configure MFA there. That session does not
satisfy a *different* org's requirement. If you have added a passkey yourself,
Stratum still asks for it after SSO, because your passkey protects your whole
account.

API tokens, agent tokens, and OAuth grants are not affected by the policy (see
above).

## Audit trail

Stratum records these events in the instance audit log: passkey added, renamed,
and removed; second-factor success and failure; recovery code used; recovery
codes regenerated; and organization policy changes.

## For operators

Passkeys are bound to the hostname users visit. By default, that is the hostname
of the request. If an instance can be reached under more than one hostname, set
`APP_URL` (for example, `https://app.usestratum.dev`) to bind every passkey to
one origin. Passkeys registered under a different hostname do not work after the
change.
