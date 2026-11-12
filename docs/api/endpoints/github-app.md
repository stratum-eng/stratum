# GitHub App installations

When the instance runs a GitHub App, outbound GitHub calls for a project —
pushing a promoted change's branch, sync, and evaluation comments and statuses
— use the app's installation token for the repository **only if that installation is linked to
the project's owner, or an [operator binding](#operator-bindings) names that
owner** for the repository's GitHub owner. A project's source URL is whatever
its owner typed, so without one of the two anyone could import another
organization's repository and have Stratum push to it with that organization's
installation. An installation that is neither linked nor covered by a binding
grants nothing, and a caller the installation refuses is **not** handed the
instance-wide `GITHUB_TOKEN` instead: that credential is reserved for owners the
operator binds explicitly.

One call at promotion is not always the app's. The pull request itself is
created with the promoting person's own GitHub authorization when they have
[connected their GitHub account](#connect-a-github-account) and it can be used,
so that GitHub records them as its author, and with the installation token
otherwise. See
[Promote to a GitHub PR](changes.md#promote-to-a-github-pr) for the rule.

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

Linking proves control on GitHub, not just in Stratum, and proves it **at the
moment of linking**. Stratum sends you to GitHub to authorize the app, then asks
GitHub what you manage right now:

- An installation on a GitHub **organization** can be linked by a current
  **owner** of that organization: an active member whose role is `admin`.
- An installation on a **personal** GitHub account can be linked by that
  account.

GitHub must also list the installation as one you can reach. An installation on
any other kind of account (an enterprise) cannot be linked; use an
[operator binding](#operator-bindings). Who installed the
app is recorded for the audit trail and decides nothing: an owner who did not
install it can link it, and someone who installed it and has since left the
organization, or lost the owner role, cannot. The GitHub account that authorizes
must be the one connected to your Stratum account; sign in with GitHub once to
connect one.

The answer is used for that one request. Stratum does not store the GitHub user
token a link round trip gives it, does not log it, and asks GitHub to revoke it
before the request ends. (The only GitHub user token Stratum keeps is the one a
person stores by [connecting their account](#connect-a-github-account), which
linking neither reads nor changes.) A link, once made, is not re-checked when someone later leaves
the GitHub organization; unlink it, or suspend or uninstall the app on GitHub.

Linking is **off until the operator sets `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_CLIENT_SECRET`** (the GitHub App's own client ID and secret, not the
sign-in OAuth app's). Without both, every link attempt is refused with `501`
`NOT_CONFIGURED`. There is no weaker rule to fall back to. Unlinking, and links
that already exist, keep working.

## The setup page

`/github/app/setup` lists the installations linked to you or to an org you
administer, with a form to link, move, or unlink each. It needs no JavaScript.

- **Find installations I can link** asks GitHub which installations you manage
  and lists them (up to 30), for that browser session, for ten minutes. The
  list is a convenience: every link is still confirmed with GitHub when you
  make it, and an installation it leaves out can be linked by its number.
- Arriving with `?installation_id=N`, as GitHub sends you after installing,
  offers that installation by number. Nothing about it is shown until GitHub
  confirms it is yours.

Each link is one round trip: the form posts to Stratum, Stratum redirects to
GitHub's authorization page, and GitHub returns to `/github/app/callback`,
which lands you back on the setup page with the outcome. If the app is already
authorized for your GitHub account, GitHub returns at once without a prompt.

Users only. These endpoints are unreachable with a project- or org-bound token.
Acting on an organization (linking to it, unlinking from it, moving a link
away from it) takes an admin of that org whose session meets its
second-factor policy. Otherwise the request is refused with `403`
`SECOND_FACTOR_REQUIRED`, and the org is not offered as a link target.

## List installations
`GET /api/github/installations`

Installations linked to you or to an org you administer. A browser session
also sees the installations GitHub said it could link the last time it asked
from the setup page, for ten minutes; an API token never does.

```json
{
  "githubLinked": true,
  "linkingConfigured": true,
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

`linkingConfigured` is `false` when the operator has not set the two variables
above. `canLink` means only that this caller may **start** a link (a browser
session, with a GitHub account connected, on a deployment where linking is
configured); GitHub is asked afresh every time. It is always `false` for an API
token.

## Link an installation
`POST /api/github/installations/{installationId}/link`

```json
{ "org": "acme" }
```

Starts the round trip; it links nothing by itself. Omit `org` (or send `""`) to
link the installation to your personal account. It needs a **browser session**:
an API token cannot be walked through GitHub's authorization page.

A form post is answered with a `303` to GitHub. A JSON request is answered with
the URL to send the browser to:

```json
{ "ok": true, "authorizeUrl": "https://github.com/login/oauth/authorize?client_id=…&redirect_uri=…&state=…" }
```

Refused before anyone is sent to GitHub (a form post gets a `303` back to the
setup page carrying the same code as `?notice=`, in lower case):

| Status | `code` | Meaning |
|--------|--------|---------|
| `501` | `NOT_CONFIGURED` | The operator has not set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` |
| `403` | `BROWSER_REQUIRED` | The request was authenticated by a token, not a browser session |
| `403` | `GITHUB_ACCOUNT_REQUIRED` | Your Stratum account has no GitHub account connected |
| `400` | `BAD_TARGET` | `org` is not an org you administer |
| `403` | `SECOND_FACTOR_REQUIRED` / `IP_NOT_ALLOWED` | The target org's policy is not met by this session |

This request says nothing about the installation itself, so an installation id
cannot be probed with it: an id that does not exist is answered the same as one
that does.

### The callback
`GET /github/app/callback`

The GitHub App's **Callback URL**. GitHub returns here with a `code` and the
`state` Stratum issued. The `state` is single-use, expires after ten minutes,
and is bound to the browser session that started the link: presented twice, or
in any other session, it is refused and nothing changes. Stratum then exchanges
the code, checks your current access as described above, and redirects (`303`)
to `/github/app/setup?notice=<code>`:

| `notice` | Meaning |
|----------|---------|
| `linked` | The installation is linked |
| `access_checked` | (From **Find installations I can link**) the list was refreshed |
| `not_found` | GitHub does not list that installation for you, or it does not exist. The two are deliberately indistinguishable |
| `not_authorized` | You do not manage the account it is installed on right now: GitHub lists it for you but you are not an owner of that organization (or are not that personal account), or you hold its Stratum link and GitHub no longer lists it for you |
| `linked_elsewhere` | It is linked to a Stratum owner you do not hold. Moving a link takes the current owner, or an admin of the current owner's org, as well as control on GitHub |
| `bad_target` | You stopped administering the target org while at GitHub |
| `second_factor_required` / `ip_not_allowed` | An org policy on the target, or on the org the link is being moved away from, is not met |
| `github_account_mismatch` | You authorized as a different GitHub account than the one connected to your Stratum account |
| `authorization_denied` | You cancelled on GitHub |
| `state_invalid` | The `state` was missing from this session, expired, or already used |
| `github_unavailable` | GitHub could not be asked. Nothing is linked on a guess; try again |
| `not_configured` | The operator removed the credentials mid-flight |

Stratum reads at most 10 pages of 100 from each of the two GitHub lists it
consults: the installations GitHub lists for you, and your organization
memberships. Past that it stops. An installation beyond the first 1,000 that
GitHub lists for you is answered `not_found`, and an organization beyond your
first 1,000 active memberships is answered `not_authorized`, exactly as if
GitHub had not listed it.

Each installation serves one Stratum owner. Controlling the GitHub account
never lets you take a link away from the Stratum account its admins chose:
they unlink it first.

A callback that carries a `code` but no `state` is the redirect GitHub makes
straight after an install. Stratum does not redeem that code. It sends you to
the setup page for that installation, where you link it with a round trip of
your own.

## Unlink an installation
`POST /api/github/installations/{installationId}/unlink`

Allowed for the linked user, or an admin of the linked org. The installation's
repositories then serve no project until it is linked again (or an operator
binding covers them).

## Connect a GitHub account

Separate from installations: this is one person letting Stratum open the pull
requests **they** promote as them, so that GitHub records them as the author
and not the app. See
[Who the pull request is opened as](../../user-guide/code-review.md#who-the-pull-request-is-opened-as).

`POST /github/app/connect`

A browser session only. Redirects to GitHub to authorize the app, and GitHub
returns to the same [callback](#the-callback) as linking. The account that
authorizes must be the GitHub account the Stratum account signs in with;
anything else is refused and the authorization revoked. On success Stratum
stores the user access token, and the refresh token when the app issues expiring
tokens, encrypted with `GITHUB_USER_TOKEN_SECRET`. This is the only GitHub user
token Stratum keeps: the token a link round trip uses is still revoked before
that request ends.

`POST /github/app/disconnect`

A browser session only. Deletes the stored authorization and asks GitHub to
revoke the token. The same happens when the account is deleted. The stored
authorization is also deleted, with nothing left to revoke, when GitHub reports
that the person revoked the app (`github_app_authorization` webhook), when
GitHub refuses to renew it, and when GitHub answers `401` for it at a
promotion.

Both end with a redirect to `/settings#github` carrying a fixed notice code.
There is no JSON form of either. They need **`GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_CLIENT_SECRET` and `GITHUB_USER_TOKEN_SECRET`**; without all three
the settings card is not shown, connecting is refused, and every pull request
is opened with the instance's own credential.

Stored authorizations are deliberately left out of database backups. After a
restore, people connect again.

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
