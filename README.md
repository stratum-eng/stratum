# Stratum

[![CI Status](https://github.com/stratum-eng/stratum/actions/workflows/ci.yml/badge.svg)](https://github.com/stratum-eng/stratum/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docs](https://img.shields.io/badge/docs-usestratum.dev-blue.svg)](https://docs.usestratum.dev)

**The governance layer for AI-written code** — the control plane that decides what agent
output is allowed to merge, wherever your code lives. Built on Cloudflare Workers with
Artifacts, D1, KV, R2, Queues, and Durable Objects.

> [!NOTE]
> **Project status: pre-1.0 and under active development.** The feature set below is
> shipped and tested, but APIs and schemas may still change between releases. See
> [ROADMAP.md](ROADMAP.md) for what's next and
> [`docs/CURRENT_CAPABILITIES.md`](docs/CURRENT_CAPABILITIES.md) for the authoritative,
> caveat-by-caveat account of what exists today.

- **Try it:** [app.usestratum.dev](https://app.usestratum.dev) — the maintainer's hosted instance
- **Read it:** [docs.usestratum.dev](https://docs.usestratum.dev)
- **Run it:** self-host on your own Cloudflare account — see [Quick start](#quick-start)

Examples below use `https://your-instance.workers.dev` as a placeholder for your deployment.

## Contents

- [Why Stratum](#why-stratum)
- [Quick start](#quick-start)
- [Using Stratum](#using-stratum)
- [Configuring the merge gate](#configuring-the-merge-gate)
- [What's included](#whats-included)
- [Known limitations](#known-limitations)
- [Architecture](#architecture)
- [Documentation](#documentation)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Why Stratum

Humans and AI agents are both first-class citizens, with different powers by design:

- **Evaluation-gated merges** — policy-as-code (`.stratum/policy.yaml`) blocks merges on
  secret scans, diff rules, sandboxed tests, external CI, and LLM review.
- **Branch protection that agents can't relax** — required evaluators, required human
  approvals, deny-by-default force-merge, and staleness rejection. A change that edits the
  policy file itself always requires a human approval.
- **Provenance & cost tracking** — every merged commit records which agent, model, and
  prompt produced it, its evaluation score, and what it cost (LLM tokens, sandbox time).
- **Agent identities with a hard invariant** — agents authenticate as themselves and can
  never approve work; approvals are a human gate.
- **Any agent, any editor** — REST API, CLI, and a remote MCP server at `/mcp`: Claude
  Code, Cursor, Copilot, or your own agents all speak to the same gate. Connecting one is
  a URL and a browser consent screen. No editor subscription required.
- **Two ways to run it** — as a **layer over GitHub** (keep your repos and PRs; eval
  verdicts land as PR comments and commit statuses) or as a **standalone forge** (Git
  hosting on Cloudflare Artifacts, workspace forking, issues, orgs, server-rendered UI).

## Quick start

### Prerequisites

- **Node.js 22.13+** (the test suite uses `node:sqlite`, unflagged only from 22.13)
- A Cloudflare account with access to:

  | Binding | Used for | |
  |---|---|---|
  | Workers | the application | **required** |
  | Artifacts (beta) | Git repository storage | **required** |
  | D1 | changes, issues, events, audit, costs | **required** |
  | KV | project/workspace identity, session state | **required** |
  | Queues | imports, events, webhook delivery | recommended |
  | Durable Objects | merge queue, repo hot index, rate limiting | recommended |
  | R2 | backups; backups no-op when unbound | recommended |
  | Analytics Engine | request analytics | optional |
  | Workers AI | the LLM evaluator | optional |
  | Sandboxes | sandbox evaluator, post-merge smoke tests | **beta, off by default** |

  `wrangler.toml` declares every binding above **except `[[sandboxes]]`, which is commented
  out** — Sandboxes is a gated Cloudflare beta, so neither the hosted instance nor a fresh
  self-host has it. Uncomment it (and add it to each `[env.*]` block you deploy) only once
  your account has Sandboxes access.

  Missing bindings do not crash the Worker, but the two evaluator bindings **fail closed**
  rather than degrade: with no `SANDBOX` binding a `sandbox` evaluator is replaced by one
  that returns score 0 / failed, and the same is true of `llm` with no `AI` binding. Naming
  either in `merge.requiredEvaluators` while its binding is absent blocks **every** merge in
  that project. `merge.postMergeCommand` is the exception — with no `SANDBOX` binding it is
  skipped with a warning.

### Installation

```bash
git clone https://github.com/stratum-eng/stratum.git
cd stratum
npm install

# Authenticate with Cloudflare
npx wrangler login
```

Fill in the placeholder resource IDs in `wrangler.toml` (each one carries a comment with
the `wrangler` command that creates it), then set up authentication — you need at least one
method:

```bash
# Email magic links (recommended — no external dependencies):
npx wrangler email sending enable yourdomain.com
npx wrangler secret put EMAIL_FROM_ADDRESS   # e.g. noreply@yourdomain.com

# GitHub OAuth:
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET

# Google OAuth:
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
# and set GOOGLE_REDIRECT_URI in [vars]

# Admin surface (/api/admin/*: backups, restore plans, audit, metrics).
# Set at least one, or the whole admin surface is unreachable — including backups:
npx wrangler secret put ADMIN_API_KEY        # accepted via the X-Admin-API-Key header
npx wrangler secret put ADMIN_EMAIL          # or: a signed-in user with this email is admin

# Optional:
npx wrangler secret put POSTHOG_API_KEY      # analytics (route patterns only, never paths)
npx wrangler secret put GITHUB_TOKEN         # REQUIRED for promote-to-PR and eval reporting to GitHub; also raises import rate limits
npx wrangler secret put GITHUB_WEBHOOK_SECRET  # inbound GitHub sync
```

OAuth callback URLs are set in `[vars]` (`OAUTH_REDIRECT_URI`, `GOOGLE_REDIRECT_URI`) —
point them at your own host and register the same URLs in your OAuth apps.

### Database setup

```bash
npx wrangler d1 create stratum                              # if not already created
npx wrangler d1 migrations apply stratum --local            # local dev
npx wrangler d1 migrations apply stratum --remote           # production
```

### Local development

```bash
npm run dev          # dev server at http://localhost:8787
npm test             # unit tests
npm run lint         # Biome
npm run typecheck    # tsc --noEmit
```

`DEV_LOGIN_ENABLED` is on for local `wrangler dev` only, giving you a `/dev-login` session
without configuring an email or OAuth provider. Named environments don't inherit it.

For a fuller walkthrough see [`docs/developer/local-setup.md`](docs/developer/local-setup.md).

## Using Stratum

### Git remotes

A Stratum project is a real git remote over smart HTTP, authenticated with your API key over
HTTP Basic (username ignored, password is the token):

```bash
# Clone a project (read)
git clone https://your-instance.workers.dev/@yourname/my-project.git

# Clone a workspace fork — this is where you push (write)
git clone https://your-instance.workers.dev/@yourname/my-project/workspaces/my-branch.git
cd my-branch
git push
```

Pushing directly to a project's default branch is refused in-protocol with a legible
`ng` report-status pointing at the workspace remote — `main` only moves through the merge
gate. Where the gated-push flag (`GIT_PUSH_GATED_ENABLED`) is on, such a push instead lands
on a server-managed workspace fork and opens an eval-gated change automatically. See
[ADR 005](docs/adr/005-git-smart-http-proxy.md). SSH transport is not supported — Workers
have no raw TCP listener ([ADR 006](docs/adr/006-ssh-transport.md)).

### REST API

```bash
# Authenticate with an API key or agent token
curl https://your-instance.workers.dev/api/projects \
  -H "Authorization: Bearer stratum_agent_xxxxx"

# Import a repository (GitHub, GitLab, or Bitbucket)
curl -X POST https://your-instance.workers.dev/api/projects/@you/react/import \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"url": "https://github.com/facebook/react", "branch": "main"}'

# Fork a workspace, commit into it, then open an evaluation-gated change.
# The repeated "workspaces" segment is correct, not a typo: the router mounts at
# /api/workspaces and declares /:namespace/:slug/workspaces. Project-scoped
# though it is, this route does not live under /api/projects.
curl -X POST .../api/workspaces/@you/my-project/workspaces -d '{"name": "fix-bug"}'
curl -X POST .../api/workspaces/fix-bug/commit \
  -d '{"files": {"src/index.ts": "export const fixed = true;"}, "message": "Fix the bug", "projectId": "..."}'
curl -X POST .../api/projects/@you/my-project/changes -d '{"workspace": "fix-bug"}'
curl -X POST .../api/changes/<change-id>/merge
```

The full surface — 93 paths, 116 operations — is specified in
[`docs/api/openapi.yml`](docs/api/openapi.yml), with per-resource guides under
[`docs/api/endpoints/`](docs/api/endpoints/README.md).

### MCP — connect an editor or agent

The MCP server is part of the Worker, served at **`/mcp`**. Nothing to install:

```bash
claude mcp add --transport http stratum https://your-instance.workers.dev/mcp
```

The first tool call opens your browser for sign-in and a consent screen; the client
registers itself and handles tokens from there. No Stratum credential is ever pasted
into an editor's config, and **Settings → Connected applications** revokes access
immediately. Headless callers can present a `stratum_user_` or `stratum_agent_` token
directly instead.

That exposes the whole eval-gated change flow as eighteen MCP tools, so Claude Code,
Cursor, Zed, Copilot, or a custom agent can drive Stratum without a bespoke integration.
See the [MCP guide](docs/user-guide/mcp.md).

### CLI and reference agent

Two first-party client packages live in this repo. Neither is published to npm yet
([tracked](ROADMAP.md#publish-the-client-packages-to-npm)), so install them from source:

```bash
# from the repository root
for pkg in cli agent; do
  (cd "$pkg" && npm install && npm run build && npm link)
done
```

That gives you `stratum` (CLI: projects, workspaces, commits, changes including review and
merge, issues, and activity — not the whole REST surface) and `stratum-agent` (reference agent:
identity → fork → LLM edit plan → commit → change).

## Configuring the merge gate

Merge policy is a file in the repository, at `.stratum/policy.yaml` (or
`stratum.config.json`). `evaluators` is **top level** — a policy file that's present but
malformed fails the merge gate closed rather than silently falling back to the default.

```yaml
# Structural sanity plus an LLM review gate.
# The secret scan is always on and blocking; it needs no entry here.
evaluators:
  - type: diff
    maxFiles: 30                        # default 20
    maxLines: 5000                      # default 500
    forbiddenPatterns: ["src/auth/*"]   # globs, matched against changed file paths

  - type: llm
    threshold: 0.6
    maxDiffChars: 48000

  - type: webhook
    url: "https://ci.example.com/evaluate"
    timeoutMs: 120000                   # clamped to 120000; larger values are lowered

  # Requires the Sandboxes beta (see Prerequisites). With no SANDBOX binding this
  # evaluator does NOT skip — it returns score 0 / failed, so uncommenting it on an
  # instance without Sandboxes makes every change in this project fail evaluation.
  # - type: sandbox
  #   command: "npm test"
  #   timeoutMs: 120000

requireAll: true
minScore: 0.6

merge:
  requiredApprovals: 1                  # human approvals; agents can never approve
  requiredEvaluators: ["secret_scan"]   # latest run of each must have passed
  allowForce: false                     # deny-by-default; ?force=true is rejected unless true
  requireFreshBase: true                # block a change whose base moved (409 STALE_BASE)
  # Also Sandboxes-only. Unlike the evaluator this one degrades quietly: with no
  # SANDBOX binding the smoke test is skipped with a warning and the merge stands.
  # postMergeCommand: "npm test"        # smoke test the merged HEAD in a sandbox
  # autoRevert: true                    # revert the merge commit if it fails (default true)
```

> [!WARNING]
> Never put `"sandbox"` in `merge.requiredEvaluators` unless the `[[sandboxes]]` binding is
> actually enabled. A required evaluator that fails closed blocks every merge in the
> project, and short of enabling the binding the only fix is to edit the policy file —
> which itself needs a human approval and refuses force-merge, because
> `.stratum/policy.yaml` is a protected config file.

This repository runs under its own policy — [`.stratum/policy.yaml`](.stratum/policy.yaml)
is the live, dogfooded example.

## What's included

Everything listed here works today. Anything not yet shipped lives in
[ROADMAP.md](ROADMAP.md) — this section deliberately carries no status markers, so it can't
drift out of sync with them.

**Repositories and changes**
Git hosting on Cloudflare Artifacts · clone/fetch/push over smart HTTP · workspace forking ·
changes (PRs) with evaluation gates · hunk-level diffs with a pure-CSS unified/split toggle ·
squash and true three-way merges · a Durable Object merge queue · batch merging ·
post-merge smoke tests with auto-revert (Sandboxes beta) · repo browser, file viewer,
commit log, and tags.

**The evaluation gate**
Secret scanner (always on and blocking; 25+ credential patterns plus entropy detection) ·
diff analysis · webhook for external CI · LLM review via the Workers AI binding · sandboxed
test execution (Sandboxes beta; see [Prerequisites](#prerequisites)) · per-evaluator
evidence and estimated resource costs (LLM tokens, sandbox time, git ops) · branch
protection · provenance recorded per merged commit.

**Post-merge deployments**
A `deploys:` block in `.stratum/policy.yaml` publishes the merged tree to Cloudflare
(static assets or a Worker script) or Vercel · encrypted per-project deploy secrets that
no API ever reads back and that agent identities cannot manage · an optional approval gate
per deploy · retry as a new attempt · supersession when a newer merge lands first ·
deployment events on the webhook stream. There is no build step — see
[Known limitations](#known-limitations).

**Import and sync**
Import from GitHub, GitLab, and Bitbucket · bidirectional GitHub sync (inbound webhooks,
outbound PR promotion) with conflict resolution · bulk import · queue-backed with
resumable progress.

**Identity and access**
Magic-link email auth · GitHub OAuth · Google OAuth · named API tokens, each `read` or
`read_write`, independently revocable and optionally expiring · agent identities with
tokens bounded by an owning user · organizations, teams, and
role-based project access · CSRF protection · rate limiting.

**Collaboration**
Per-project issue tracker with auto-close on linked-change merge · human reviews
(approve / request changes) and comments · per-project activity feed · outbound webhooks
with HMAC-SHA256 signatures, event filters, delivery logs, and SSRF-guarded URLs.

**Operations**
Append-only audit trail with an admin query API · daily and on-demand backups to R2 with a
tested restore path · deletion jobs · admin metrics API · durable event outbox with a
queue consumer and a stale-event sweep · workspace TTL sweep.

**Interfaces**
Server-rendered web UI · REST API (93 paths) · remote MCP server at `/mcp` with an
OAuth 2.1 authorization server (dynamic client registration, PKCE, rotating refresh
tokens) · `@stratum/cli` covering the change flow, issues, and activity ·
`@stratum/agent` reference agent.

## Known limitations

- **Merge conflicts** — a three-way merge that conflicts does **not** fall back to a squash
  merge: the merge is refused with `409 MERGE_CONFLICT`, carrying the conflicting paths and
  a conflict id you resolve out-of-band via
  `POST /api/projects/conflicts/{id}/resolve` — `accept-project`, `accept-workspace`, or
  `manual` with whole-file contents, not a hunk editor. There's no in-UI conflict resolution
  for changes; GitHub *sync* conflicts do have a resolution UI.
- **Diff depth** — diffs are hunk-level with unified and split views, but there's no
  per-line intra-hunk highlighting, binary files aren't diffed, and very large files are
  rendered whole.
- **Git LFS is not supported at all** — there's no `/info/lfs` route or `objects/batch`
  endpoint, and git push bodies are capped at 50 MB, so large-binary workflows aren't
  viable. Keep LFS repos on GitHub and use layer mode.
- **Git submodules are rejected**, not supported — a gitlink or `.gitmodules` fails import,
  gated push, and change creation rather than corrupting the tree silently.
- **Deploys have no build step** — v1 publishes the tree **exactly as committed**. There's
  no install, bundle, or framework build, so commit your built output (and point `dir:` at
  it) or use the `vercel` target, which builds the uploaded source remotely. There's also
  no preview deploy of an unmerged change and no rollback: retrying an earlier successful
  deployment is the recovery path. Netlify isn't supported.
- **Scale** — git operations run in-memory on the Worker; large repos will hit Worker limits.
- **Synchronous evaluation** — the evaluator suite runs inline at change creation, so change
  creation latency includes it.
- **Identity in KV** — project and workspace identity records live in KV rather than D1,
  which is why `workspace.deleted` events aren't emitted yet.
- **Team permissions are org-wide** — per-project team grants aren't implemented.

Each of these is documented in full, with the specific code paths involved, in
[`docs/CURRENT_CAPABILITIES.md`](docs/CURRENT_CAPABILITIES.md).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │  Hono API   │  │   Web UI    │  │ Queue Consumers │  │
│  │   Routes    │  │    (JSX)    │  │ (events/import) │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │    Auth     │  │  Evaluation │  │  Merge Queue    │  │
│  │ Middleware  │  │   Engine    │  │ (Durable Obj)   │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
│  ┌─────────────┐  ┌─────────────────────────────────┐   │
│  │  MCP /mcp   │  │  OAuth 2.1 authorization server │   │
│  │  (tools)    │  │  register · authorize · token   │   │
│  └─────────────┘  └─────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                           │
    ┌─────────┬────────────┼───────────┬──────────┐
    ▼         ▼            ▼           ▼          ▼
┌───────┐ ┌────────┐ ┌───────────┐ ┌────────┐ ┌────────┐
│  D1   │ │   KV   │ │ Artifacts │ │   R2   │ │ Queues │
│changes│ │identity│ │   (Git)   │ │backups │ │  jobs  │
│events │ │ state  │ │           │ │        │ │        │
│ audit │ │        │ │           │ │        │ │        │
└───────┘ └────────┘ └───────────┘ └────────┘ └────────┘
```

**Tech stack:** Cloudflare Workers (V8 isolates) · [Hono](https://hono.dev/) ·
[isomorphic-git](https://isomorphic-git.org/) with an in-memory filesystem · D1 (SQLite) ·
KV · R2 · [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) ·
server-rendered Hono JSX with CSS-in-JSX. The UI is server-rendered by default; the handful
of inline scripts (file tree, clipboard, import progress) are progressive enhancement — the
pages work without them.

See [`docs/developer/architecture.md`](docs/developer/architecture.md) for the full design.

## Documentation

Published at [docs.usestratum.dev](https://docs.usestratum.dev), built from
[`website/`](website/) (Astro Starlight).

**Users** — [Getting started](docs/user-guide/getting-started.md) ·
[Importing from GitHub](docs/user-guide/importing.md) ·
[CI integration](docs/user-guide/ci-integration.md) ·
[Deployments](docs/user-guide/deployments.md) ·
[Troubleshooting](docs/user-guide/troubleshooting.md) ·
[FAQ](docs/user-guide/faq.md)

**API** — [OpenAPI spec](docs/api/openapi.yml) ·
[Authentication](docs/api/authentication.md) ·
[Endpoints](docs/api/endpoints/README.md) ·
[Error codes](docs/api/errors.md)

**Developers** — [Architecture](docs/developer/architecture.md) ·
[Local setup](docs/developer/local-setup.md) ·
[Database schema](docs/developer/database.md) ·
[Queues](docs/developer/queues.md) ·
[Testing](docs/developer/testing.md) ·
[Deployment](docs/developer/deployment.md)

**Operations** — [Backup & restore](docs/runbooks/backup-restore.md) ·
[Artifacts scaling & operating policy](docs/runbooks/artifacts-scaling.md) ·
[D1 migration reconciliation](docs/runbooks/d1-migration-reconciliation.md)

**Decisions** — [ADR 001: Namespace support](docs/adr/001-namespace-support.md) ·
[ADR 002: Queue-based imports](docs/adr/002-queue-based-imports.md) ·
[ADR 003: D1 for import state](docs/adr/003-d1-for-import-state.md) ·
[ADR 004: High-frequency agent commits](docs/adr/004-high-frequency-agent-commits.md) ·
[ADR 005: Git smart-HTTP proxy](docs/adr/005-git-smart-http-proxy.md) ·
[ADR 006: SSH transport](docs/adr/006-ssh-transport.md)

## Deployment

### GitHub Actions

- **`pr-checks.yml`** — tests, lint, typecheck, security scan, and the CLI/agent package
  builds on every pull request. It deliberately deploys nothing: a PR deploying over the
  shared staging Worker desynchronised its Durable Object migration tag and red-lined
  `main`.
- **`pr-preview.yml`** — the per-PR preview instead: an isolated `stratum-pr-<N>` Worker
  with its own D1 and KV, torn down when the PR closes. Fork PRs get none.
- **`ci.yml`** — the same gates on every push to `main`, then deploys to staging and to
  production. Both deploys are gated by GitHub deployment environments, so production waits
  for whatever approvals that environment requires.
- **`deploy-production.yml`** — manual (`workflow_dispatch`) production deploy.
- **`d1-migrate.yml`** — manual D1 migrations against staging or production.

### Manual

```bash
npx wrangler deploy --env=staging
npx wrangler deploy --env=production

npx wrangler d1 migrations apply stratum --remote
npx wrangler d1 migrations apply stratum-staging --env=staging --remote
```

Production and staging **must** use distinct Artifacts namespaces, and changing a namespace
in `wrangler.toml` requires a migration of the existing repos — see
[`docs/runbooks/artifacts-scaling.md`](docs/runbooks/artifacts-scaling.md) for the operating
policy and the migration procedure, and
[`docs/developer/deployment.md`](docs/developer/deployment.md) for deploy detail.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, coding
standards, and the PR process; [ROADMAP.md](ROADMAP.md) lists the open work, and issues
labelled [`good first issue`](https://github.com/stratum-eng/stratum/labels/good%20first%20issue)
are a good entry point.

Working with an AI coding agent? Point it at [AGENTS.md](AGENTS.md) — the agent-facing
version of the contributor guide.

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Notable changes are
recorded in [CHANGELOG.md](CHANGELOG.md), and tagged versions are published on the
[releases page](https://github.com/stratum-eng/stratum/releases).

## Security

Please **do not** report vulnerabilities through public issues. Use a
[private security advisory](https://github.com/stratum-eng/stratum/security/advisories/new)
instead — see [SECURITY.md](SECURITY.md) for what to include and expected response times.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgments

Built with [Cloudflare Workers](https://workers.cloudflare.com/),
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/),
[Hono](https://hono.dev/), and [isomorphic-git](https://isomorphic-git.org/).
