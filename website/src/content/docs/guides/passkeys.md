---
title: "Passkeys and two-factor sign-in"
description: "Add a passkey as a second factor, keep recovery codes, and require two-factor sign-in for an organization."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/passkeys.md"
---

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

You can remove your last passkey even if an organization you belong to requires
a second factor. You then lose access to that organization's resources until you
add a passkey again. Nothing else changes.

## What a second factor does not cover

A passkey protects **interactive browser sign-in**. These credentials work as
before and never ask for a passkey:

- API tokens (`stratum_user_…`) and the legacy API key
- Agent tokens (`stratum_agent_…`)
- MCP / OAuth grants for connected editors and agents (`stratum_mcp_…`)
- `git` over HTTPS, which authenticates with a token

These credentials are not all limited in what they can do:

- A named API token is `read` or `read_write`, can expire, and can be revoked on
  its own.
- The legacy API key has full read-write access and never expires. You can
  rotate it or disable it, but not revoke it on its own.
- An agent token has your full access until you revoke the agent.
- An MCP grant is `mcp:read` or `mcp:write` until you disconnect the app.

Treat each one like a password, and revoke or disable any you no longer trust
from **Settings**. No token can read or change your passkeys.

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

The policy applies **only to that organization's own resources**:

- its projects (code, changes, reviews, issues, deployments)
- its organization endpoints under `/api/orgs/{slug}/` (details, members, teams,
  SSO, and changing the policy)

Your personal projects, other organizations, account settings, and sign-out are
never affected. An organization can add you as a member without your consent,
so its policy cannot restrict anything it did not give you.

The policy limits the access that **membership** grants. It does not hide
anything that is already public. A **public** project of the org stays readable
to everyone, including a member whose session has not passed a second factor
and visitors who are not signed in. Only the access that membership adds is
withheld: private projects, write access, and the org's own endpoints. Make a
project private if the second factor should protect its content.

If your session has not passed a second factor, requests for the org's
resources return `403` with code `SECOND_FACTOR_REQUIRED` and a link to
`/settings/security`. Browser pages show the same explanation.

- **You have no passkey yet:** add one at `/settings/security`. Your current
  session then counts as verified, and the org's resources open up.
- **You have a passkey, but this session did not use it** (for example, it
  started before the policy was turned on): sign out, then sign in again and use
  your passkey.

Two org endpoints stay open even when the policy blocks you: reading the policy
(`GET /api/orgs/{slug}/security`) and leaving the org.

### Creating credentials

A credential you create keeps working after you create it, whatever session it
came from, so the policy also applies when a credential is **created**. While
your session has not met an org's policy, you cannot create anything that could
reach that org:

- an API token that is not limited to one project or organization
- a token limited to that org, or to one of its projects, public or private (a
  token for a public project still carries your write access there)
- an agent token
- a rotated legacy API key
- a connection for an MCP client or the CLI (the consent screen explains why
  instead of asking you to allow)

These requests return `403 SECOND_FACTOR_REQUIRED`, and the settings pages
show the same explanation. You can still create a token limited to one of your
own projects, or to an organization without the policy. Meeting the policy as
described above lifts the restriction, and so does leaving the org.

### Leaving an organization

Any member can remove themselves from an organization with
`DELETE /api/orgs/{slug}/members/{your user id}`, whatever the org's policy. The
org owner cannot leave.

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
and removed; second-factor success; recovery code used; recovery codes
regenerated; and organization policy changes.

A failed second factor (a wrong passkey or recovery code) is recorded the same
way as every other failed sign-in: as `auth.failed`, at most once per minute for
the same account or passkey. Events from a sign-in through an organization's SSO
also appear in that organization's audit log, as do changes to its policy.

## For operators

Passkeys are bound to the hostname users visit. By default, that is the hostname
of the request. If an instance can be reached under more than one hostname, set
`APP_URL` (for example, `https://app.usestratum.dev`) to bind every passkey to
one origin. Passkeys registered under a different hostname do not work after the
change.

Recovery codes are stored as per-user hashes. To key those hashes with a secret
that is never stored in D1 or in backups, set the optional `RECOVERY_CODE_PEPPER`
secret (`wrangler secret put RECOVERY_CODE_PEPPER`). Codes issued before you set
it keep working. If you later change or remove the secret, codes issued under it
stop working, and users must generate new ones from Settings → Security.
