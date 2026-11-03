# GitHub App installations

When the instance runs a GitHub App, outbound GitHub calls for a project — PR
promotion, sync, and evaluation comments and statuses — use the app's
installation token for the repository **only if that installation is linked to
the project's owner**. A project's source URL is whatever its owner typed, so
without the link anyone could import another organization's repository and have
Stratum push to it with that organization's installation. Unlinked
installations grant nothing; those calls use the instance-wide `GITHUB_TOKEN`
instead.

Linking proves control on GitHub, not just in Stratum: only the GitHub user who
installed the app (or, for an installation on a personal GitHub account, that
account) can link it, matched against the GitHub account linked to your Stratum
account. Sign in with GitHub once to link one.

The app's **Setup URL** is `/github/app/setup`. GitHub sends you there after
installing, and the page lists your installations with a form to link each one.
It needs no JavaScript.

Users only. These endpoints are unreachable with a project- or org-bound token.

## List installations
`GET /api/github/installations`

Installations you control on GitHub, plus those linked to you or to an org you
administer.

```json
{
  "githubLinked": true,
  "installations": [
    {
      "installationId": 777,
      "account": { "login": "acme", "type": "Organization" },
      "suspended": false,
      "linkedTo": null,
      "canLink": true,
      "canUnlink": true
    }
  ]
}
```

## Link an installation
`POST /api/github/installations/{installationId}/link`

```json
{ "org": "acme" }
```

Omit `org` (or send `""`) to link it to your personal account. An org must be
one you administer, or the request is a 400. An installation you can't prove
control of is a 404, the same as one that doesn't exist. Relinking moves the
installation to the new owner; each installation serves one Stratum owner.

## Unlink an installation
`POST /api/github/installations/{installationId}/unlink`

Allowed for whoever could link it, the linked user, or an admin of the linked
org. The installation's repositories go back to the instance token.

## Operator allowlist

`GITHUB_APP_ALLOWED_OWNERS` (comma-separated GitHub owners) lets **any**
project use the app on those owners' repositories without a link. That is the
same reach the instance `GITHUB_TOKEN` has always had, so list only GitHub
accounts the operator controls.
