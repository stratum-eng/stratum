---
title: "The Stratum CLI"
description: "Install and use @stratum-eng/cli — projects, workspaces, commits, and the change flow from the terminal."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/cli.md"
---

`@stratum-eng/cli` puts the change flow in the terminal: projects, workspaces,
commits, evaluation-gated changes, reviews, and issues, each command a thin
wrapper over the [REST API](/reference/endpoints/). It is built for humans
and shell scripts; agents are usually better served by the
[MCP server](/guides/mcp/), which speaks the same surface over a protocol editors and
agent frameworks already understand.

## Installation

The package is **not yet published to npm** — install it from the `cli/`
directory of the repository (Node 20+):

```bash
git clone https://github.com/stratum-eng/stratum.git
cd stratum/cli
npm install && npm run build
npm link          # puts the `stratum` binary on your PATH
```

## Authentication

```bash
stratum login
```

That is the whole thing: `login` opens your browser, you approve the CLI on
Stratum's consent screen, and the tokens land in `~/.stratum/config.json`.
There is no token to create by hand and none to paste.

Under the hood it is the OAuth 2.1 authorization-code flow that native apps
use (RFC 8252): the CLI registers itself as a public client
([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591)), proves possession of the code with
PKCE, and receives the redirect on a loopback listener bound to an ephemeral
port on `127.0.0.1`. Nothing is minted that you have to store, and the grant
shows up under **Settings → Connected applications** alongside your editors,
where it can be revoked like any other.

The **granted** scope is printed at login and by `stratum status`, so a grant
narrower than you asked for is visible immediately rather than at the first
write that fails. By default the session is read **and** write, because most
commands write. For a session that cannot change anything:

```bash
stratum login --read-only
```

Sign out, which asks the host to revoke the grant and then clears the local
credential — and still clears it locally if the host is unreachable:

```bash
stratum logout
```

`logout` reports that the revocation request was *delivered*, not that the grant
is gone: [RFC 7009 §2.2](https://datatracker.ietf.org/doc/html/rfc7009#section-2.2)
has the server answer `200` whether or not anything matched. To confirm, check
**Settings → Connected applications**.

### Headless: CI, containers, and anywhere without a browser

Without a terminal, `stratum login` refuses rather than opening a browser nobody
can see. Two options:

```bash
stratum login --host https://app.usestratum.dev --key stratum_user_xxxxx
```

or set `STRATUM_HOST` and `STRATUM_API_KEY`, which override the config file.
`STRATUM_API_KEY` overrides on its own; `STRATUM_HOST` on its own retargets a
stored **API token** only. With a browser session it is refused, because an
OAuth grant belongs to the server that issued it and is worthless — and unsafe —
anywhere else. Passing `--key` is also how you say "do not open a
browser" on a machine that has one. Create the token from
**Settings → API tokens**; token management deliberately requires a browser
session, so a token can never mint another token.

> **Changed:** `stratum login --host <url>` *without* `--key` now opens a
> browser instead of prompting for a key. A script that piped a key into that
> prompt must pass `--key` or use the environment variables.

Two things to know either way:

- **Credentials land in `~/.stratum/config.json`.** The file is `0600` in a
  `0700` directory — including on installs upgraded from a release that left it
  world-readable — and is written atomically, so an interrupted write cannot
  destroy a session. It is still plaintext: treat it like the token itself. In
  CI, skip the file entirely and use the environment variables.
- **`login --key` verifies the key exists, not what it can do.** It calls the
  host's `/health` endpoint with your key, and an invalid or mistyped key
  fails there with `HTTP 401` before anything is saved. What it does *not*
  check is **scope**: a `read`-scoped token logs in fine and only fails on
  the first write. The browser flow has no such gap — you choose the scope at
  login and `--read-only` is the only way to end up with less than you need.

`stratum status` confirms which account you are:

```bash
stratum status
# Authenticated as you@example.com (usr_...)
```

### Sessions renew themselves

An OAuth access token is good for an hour and the CLI refreshes it silently
when it expires, rotating the stored refresh token each time. You stay signed
in for up to 30 days of inactivity, and 180 days in total, after which
`stratum login` asks for approval again. An API token, by contrast, lives
until it expires or is revoked.

Rotation is coordinated across processes with a lock file
(`~/.stratum/config.lock`), so running several `stratum` commands at once is
safe. It has to be: presenting a refresh token that has already been rotated is
indistinguishable from a stolen one, and the server responds by revoking the
whole grant.

A read-only session — `--read-only`, or a `read`-scoped API token — is refused
on every request that is not a `GET` or a `HEAD`, with
`403 TOKEN_SCOPE_INSUFFICIENT`. Beyond `logout`, the CLI has no commands for
creating or revoking API tokens: that surface is deliberately
[session-only](/reference/authentication/#managing-tokens-requires-a-session), so
it lives in the settings UI.

## Projects

```bash
stratum init billing                 # create a project in your namespace
stratum init billing --org acme      # ...or under an organization
stratum init billing --public       # public instead of the default private
stratum projects                     # list your projects
stratum activity acme/billing        # recent events (changes, merges, evals)
```

`init` prints the project's git remote when one is provisioned.

Deleting a project is owner-only, irreversible, and asks you to repeat the
project reference as a confirmation token:

```bash
stratum project delete acme/billing --confirm acme/billing
```

Deletion is enqueued (the command prints the job id) and removes the project
and everything attached to it — see the
[projects API](/reference/endpoints/) for what the cascade covers.

## Workspaces and commits

A workspace is your isolated fork of the project; changes are proposed from it.

```bash
stratum workspace create acme/billing --name fix-retries
stratum workspace list acme/billing
stratum workspace delete acme/billing fix-retries
```

`stratum commit` bridges a **local git checkout** to a workspace: it reads the
files currently *staged* in your local repository (the index version, not the
working tree) and commits their full contents to the workspace:

```bash
git add src/retry.ts
stratum commit --project acme/billing --workspace fix-retries -m "Honour Retry-After"
```

Limits worth knowing, since the underlying commit API takes a map of complete
file contents: at most **2,000 files** and **25 MB** of content per commit, and
**staged deletions and renames cannot be expressed** — the command errors on a
staged deletion rather than silently dropping it. For anything the file map
cannot say, push to the workspace's git remote instead; the same change gate
applies either way.

## Changes

```bash
stratum change create --project acme/billing --workspace fix-retries
# Created change chg_abc123 (open)
# Evaluation: score 0.92, passed — all gates passed
```

Creating a change runs the project's evaluation gates **synchronously** and
prints the verdict. Then:

```bash
stratum change list acme/billing --status open
stratum change show chg_abc123        # per-evaluator evidence + metered costs
stratum change review chg_abc123 --verdict approve --comment "LGTM"
stratum change merge chg_abc123       # runs the full merge gate
stratum change merge chg_abc123 --squash
stratum change merge chg_abc123 --force   # denied unless policy allows force
stratum change reject chg_abc123
```

`review` accepts `approve` or `request_changes` (the comment-only verdict from
the [code review guide](/guides/code-review/) is not exposed here), and the change
author's own approval never counts toward required approvals. A refused merge
prints the blocking reasons — the codes are in the
[error reference](/reference/errors/).

## Issues

```bash
stratum issue create acme/billing --title "Retry storms on 429" --body "..."
stratum issue create acme/billing --title "Retry storms" --change chg_abc123
stratum issue list acme/billing --status closed    # default is open
stratum issue close acme/billing 42
```

An issue created with `--change` auto-closes when that change merges — see
[Issues](/guides/issues/).

## Account

```bash
stratum account delete --confirm your-username
```

Irreversible, GDPR-grade erasure of your account and owned projects, confirmed
by repeating your username. Your credentials stop working the moment the
command returns; the deletion itself runs as a background job.

## Errors and scripting

Every failure exits non-zero, so the CLI composes with `&&` and `set -e`. API
failures print an `Error: ...` line to stderr carrying the server's message —
plus the server's `reasons` as indented bullet lines when there are several,
as on a `PROTECTION_BLOCKED` merge. (Bad arguments are reported by the option
parser in its own `error: ...` format before any request is made.) The
machine-readable codes behind API errors are catalogued in the
[error reference](/reference/errors/).

## Reference

- [`cli/README.md`](https://github.com/stratum-eng/stratum/blob/main/cli/README.md) — the package's own quick reference
- [Getting started §6](/guides/getting-started/#6-connect-your-tools) — where the CLI
  fits in the end-to-end flow
- [OpenAPI specification](/reference/openapi/) — the API each command wraps
