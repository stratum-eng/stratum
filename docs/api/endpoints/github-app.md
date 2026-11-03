# GitHub App installations

When the instance runs a GitHub App, outbound GitHub calls for a project — PR
promotion, sync, and evaluation comments and statuses — use the app's
installation token for the repository **only if that installation is linked to
the project's owner**. A project's source URL is whatever its owner typed, so
without the link anyone could import another organization's repository and have
Stratum push to it with that organization's installation. Unlinked
installations grant nothing, and a caller the installation refuses is **not**
handed the instance-wide `GITHUB_TOKEN` instead: that credential is reserved
for owners the operator binds explicitly (see [Operator bindings](#operator-bindings)).

The same rule decides which project receives a repository's webhook events
(push, pull request, review), and every repository has **one canonical
project**. The first authorized project to act on a repository, or to receive
an event for it, claims it. Another project naming the same repository can
neither receive its events nor push or report to it, until the holder is
deleted or loses its authorization. A promotion from a non-canonical project
answers `409`.

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
control of is a 404, the same as one that doesn't exist. Each installation
serves one Stratum owner. Moving an existing link is a 403 (`LINKED_ELSEWHERE`)
unless you are also the current owner or an admin of the current owner's org,
so having installed the app never lets you take a link away from the account
its admins chose.

The installer is recorded once, when GitHub reports the installation, and is
not re-checked against later org membership. If the person who installed the
app leaves the GitHub organization, an organization owner should link the
installation to the org (or suspend or uninstall the app on GitHub) so a stale
installer cannot link it elsewhere.

## Unlink an installation
`POST /api/github/installations/{installationId}/unlink`

Allowed for the linked user, or an admin of the linked org. The installation's
repositories then serve no project until it is linked again (or an operator
binding covers them).

## Operator bindings

`GITHUB_ALLOWED_OWNERS` binds a GitHub owner to the Stratum owner allowed to
act on its repositories without an installation link. It is a comma-separated
list of `githubOwner=@stratumNamespace` entries:

```
GITHUB_ALLOWED_OWNERS = "acme=@acme,acme-labs=@acme"
```

An entry admits only projects owned by that Stratum user or org, or by an
agent whose owner it is. It covers the GitHub App on those repositories and is
the **only** way a project can use the instance `GITHUB_TOKEN`. An entry with
no `=@namespace` part is ignored, with a warning in the logs. It does not admit
every project. The former name, `GITHUB_APP_ALLOWED_OWNERS`, is still read, and
the two lists combine.
