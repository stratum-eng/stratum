# GitHub App installations

When the instance runs a GitHub App, outbound GitHub calls for a project — PR
promotion, sync, and evaluation comments and statuses — use the app's
installation token for the repository **only if that installation is linked to
the project's owner, or an [operator binding](#operator-bindings) names that
owner** for the repository's GitHub owner. A project's source URL is whatever
its owner typed, so without one of the two anyone could import another
organization's repository and have Stratum push to it with that organization's
installation. An installation that is neither linked nor covered by a binding
grants nothing, and a caller the installation refuses is **not** handed the
instance-wide `GITHUB_TOKEN` instead: that credential is reserved for owners the
operator binds explicitly.

A [push mirror](../../user-guide/push-mirror.md) uses the app too, and only
the app: it never falls back to `GITHUB_TOKEN`. For each push it asks for an
installation token limited to the mirror repository, so the app needs the
**Contents: read and write** repository permission there, and **Workflows: read
and write** if the project has files under `.github/workflows/`. A project that
mirrors to a repository holds it as its canonical project, exactly as a project
imported from it does.

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
Acting on an organization (linking to it, unlinking from it, moving a link
away from it) takes an admin of that org whose session meets its
second-factor policy. Otherwise the request is refused with `403`
`SECOND_FACTOR_REQUIRED`, and the org is not offered as a link target.

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
      "canUnlink": false
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
list of entries naming the Stratum owner **by id**:

```
GITHUB_ALLOWED_OWNERS = "acme=org:org_0123abcd,acme-labs=user:usr_4567ef01"
```

An entry admits only projects owned by that org or user, or by an agent whose
owner is that user. It covers the GitHub App on those repositories and is the
**only** way a project can use the instance `GITHUB_TOKEN`.

Ids are used rather than `@namespace` names because a namespace can be renamed
or deleted and then claimed by someone else, who must not inherit the binding.
Any other entry, including `githubOwner=@namespace`, is ignored, with a warning
in the logs. It does not admit every project. Members can read an org's id
from `GET /api/orgs/{slug}` (`org.id`), and their own from `GET /api/users/me`.
The former name, `GITHUB_APP_ALLOWED_OWNERS`, is still read, and the two lists
combine.
