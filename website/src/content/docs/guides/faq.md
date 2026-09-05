---
title: "FAQ"
description: "Common questions about Stratum's merge gate, provenance, CI, limitations, and telemetry."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/faq.md"
---

## What is Stratum?

A code collaboration platform where humans and AI agents are both first-class
citizens. It hosts git repositories (on Cloudflare Artifacts), and every
proposed change — whether a human or an agent wrote it — passes through
policy-defined evaluation gates before it can merge. Merged changes carry
provenance (which agent, which model, which prompt) and cost records.

## How is this different from GitHub branch protection and required checks?

GitHub branch protection gates on external check *statuses*; Stratum runs the
evaluation itself, treats agents as first-class identities, and enforces
invariants GitHub doesn't have:

- **A secret scan is always on and always blocking** — not a configurable check
  someone can remove.
- **Approvals are human-only by construction.** An agent token cannot approve
  any change on any surface (API, CLI, MCP). On GitHub, a bot with the right
  permissions can approve and merge.
- **Staleness is enforced against what was evaluated**: a merge is rejected if
  the workspace advanced after evaluation (`409 STALE_WORKSPACE`), so you can
  never merge commits the evaluators didn't see. `requireFreshBase` additionally
  rejects merges when the base moved (`409 STALE_BASE`).
- **Force-merge is deny-by-default** — the override only exists if the policy
  explicitly sets `merge.allowForce: true`.
- **Post-merge smoke with auto-revert**: a configured command runs against the
  merged HEAD, and a failure automatically lands a forward revert commit.
- **Provenance and cost are recorded per merged change** — model, prompt hash,
  eval score, LLM tokens, sandbox time.
- A malformed `.stratum/policy.yaml` **fails closed** (blocks merges) instead of
  silently falling back to defaults.

## Does Stratum replace GitHub Actions?

No. Stratum has no native CI runner — no workflows, hosted runners, matrix
builds, artifacts, caching, scheduled jobs, deployment environments, or
status-check aggregation (it does not collect external CI check results the way
a GitHub PR's checks tab does). Its code execution is limited to the evaluation
pipeline: the sandbox evaluator (needs the optional `SANDBOX` binding; fails
closed without it), the `webhook` evaluator (a synchronous call-out to CI *you*
host, which must answer within the request timeout — default 10s), and the
post-merge smoke command run in a sandbox. Bring your own CI and wire it in via
the webhook evaluator, or use layer mode and keep running GitHub Actions on the
promoted PRs. See [CI Integration](/guides/ci-integration/).

Two things on that list have since arrived in a narrow form. Stratum now has an
**encrypted per-project secret store** — but it is deploy-only: the deploy
runner is its sole reader, and the webhook evaluator's `secret` still lives
literally in the policy file. And it can **deploy the merged tree** to
Cloudflare or Vercel from a `deploys:` block, with an optional approval gate
and a retry. That is not deployment environments: there is no
staging/production separation, no per-environment variables, no build step, no
preview deploy, and no rollback. See [Deployments](/guides/deployments/).

## Do I have to leave GitHub to use it?

No. Stratum supports two modes with the same codebase. In **layer mode**,
Stratum sits between your agents and GitHub: import the repo, enable
bidirectional sync (inbound webhooks, outbound PR promotion), and agent work
goes through Stratum's gates while your team keeps reviewing GitHub PRs —
each evaluation of a change with a linked PR posts the verdict to the PR as a
comment and a `stratum/evaluation` commit status. In
**alternative mode**, Stratum is the source of truth and GitHub isn't involved
at all. You choose the level of buy-in, and you can start with layer mode.

## Do I need a GitHub account at all?

No. Email magic-link authentication is the recommended sign-in and has no
external dependencies. GitHub OAuth (needed for GitHub sync) and Google OAuth
are alternatives; all resolve to the same email-based identity, and all three
ask you to choose your username when the account is first created.

## What happens when an evaluation fails?

The change is created anyway, with each evaluator's verdict, findings, and score
recorded as evidence you can inspect (`stratum change show <id>` or the UI). What
a failure blocks is the **merge**: any evaluator type listed in
`merge.requiredEvaluators` must have a passing latest run. To recover, push new
commits to the workspace — re-evaluation runs against the new state — or, if
your policy allows it (`allowForce: true`, off by default), force-merge past it.
The reference agent exits with code `2` in this case so CI wrappers can
distinguish "agent produced rejected work" from operational errors.

## Can agents approve or merge their own code?

Agents can never **approve** — reviews are human-only, everywhere, with no
configuration that relaxes it. An agent cannot trigger the *merge* either —
`POST /api/changes/{id}/merge` (and merge-batch) requires a user identity, so
a merge call with an agent token is refused with `401` regardless of policy.
The human in the loop presses merge; what `merge.requiredApprovals` controls is
how many approvals from humans *other than the change's author* must exist
before that press succeeds. The merger themselves can be one of those
approvers — the only excluded identity is the author (for an agent-created
change, the agent's owning user). Set it to 1 or more on anything you care
about, so no single person can both own the agent and wave its work through
unreviewed.

## What does provenance actually record?

Per merged change: the author identity (human or agent), the model and a hash of
the prompt snapshotted at change creation, and the evaluation score, per merged
commit. Full per-evaluator evidence (scores, findings, durations) is linked by
change. The schema also has room for model config, reasoning traces, and tool
calls where the client supplies them. Agents authenticate with their own
tokens, bounded by an owning user's access, so work is attributed to the
agent, not laundered through a human account.

## What does it cost, and what is metered?

The software is free software (see the licensing question below) and costs
nothing; self-hosted, you pay only for the Cloudflare resources you use
(Workers, Artifacts, D1, KV, Queues, plus AI
Gateway and Sandboxes if you enable those evaluators). Stratum meters estimated
resource usage per change — LLM tokens, sandbox execution milliseconds, and git
operations — and shows it alongside the evaluation evidence, so you can see what
each (agent) change cost you. The hosted instance has open signup and is free
while billing and multi-tenancy for a managed offering ("Stratum Cloud") are
planned but not built.

## What are the current limitations?

Honestly, several:

- **Diff limits**: diffs are hunk-level with unified and side-by-side views,
  but binary files are not diffed and very large files are rendered whole.
- **Scale**: git operations run in-memory inside a Worker, so very large
  repositories will hit Worker limits. Moving git ops off the Worker is on the
  roadmap.
- **Push to project remotes doesn't move `main` directly** — the push is
  rejected in-protocol with the reason (and, where gated push is enabled, opens
  an eval-gated change instead). Push to workspace remotes for direct writes.
- **Authorization** is still minimal in places; project-level access control is
  not enforced on every route. One deliberate GitHub-parity choice worth
  knowing: any authenticated user can **open** an issue on a public project
  (rate-limited), while editing or closing issues requires project write
  access.
- **Evaluation runs synchronously** at change creation — there's no async
  evaluation queue yet, so very slow evaluators stretch the request.
- **No Git LFS**: see
  [Does Stratum support Git LFS?](#does-stratum-support-git-lfs) below.
- **Git submodules are not supported.** A gitlink entry at any depth, or a
  root-level `.gitmodules` file, is rejected — with a clear error — whenever a
  change is created, on a gated push and through the REST API alike, rather
  than risk a server-side merge silently corrupting it. The same check runs on
  import, but there it is best-effort: an import whose tree can't be read
  proceeds unscanned with a warning. See
  [Importing from GitHub](/guides/importing/#unsupported-content).

See [`docs/CURRENT_CAPABILITIES.md`](https://github.com/stratum-eng/stratum/blob/main/docs/CURRENT_CAPABILITIES.md) for the
authoritative, current state.

## Does Stratum support Git LFS?

No. There is no LFS server: the git smart-HTTP router exposes only
`info/refs`, `git-upload-pack`, and `git-receive-pack` — there is no
`/info/lfs` route and no `objects/batch` endpoint, so `git lfs` clients get a
`404 Not found` when they call the batch API and an LFS-enabled clone fails
at that point. Combined with the 50 MB cap on git push request bodies,
large-binary workflows are effectively blocked. Keep binaries out of
Stratum-hosted repos, or keep LFS-dependent repos on GitHub and use layer
mode. See [`docs/CURRENT_CAPABILITIES.md`](https://github.com/stratum-eng/stratum/blob/main/docs/CURRENT_CAPABILITIES.md) and the
implementation sketch in [`docs/REMAINING_WORK.md`](https://github.com/stratum-eng/stratum/blob/main/docs/REMAINING_WORK.md).

## Can I use plain `git` with Stratum?

Yes, over smart HTTP with your API key as the HTTP Basic password (enter it at
the prompt or store it with a git credential helper — don't embed it in the
URL): `git clone https://<host>/@ns/slug.git` for projects (read), and
`.../@ns/slug/workspaces/<name>.git` for workspaces (read **and** `git push`).
A push to the project URL is rejected in-protocol so the evaluation gate can't
be bypassed.
SSH transport is not supported (Workers have no raw TCP listener).

## What do I need to self-host?

Node.js 22.13+ and your own Cloudflare account with Workers, **Artifacts (which
is in beta — you need access to it)**, D1, KV, Queues, and Durable Objects.
Optional: the Workers AI binding for the LLM evaluator, Sandboxes for the
sandbox evaluator (without the binding that evaluator fails closed), R2 for
backups, and Cloudflare Email for magic links.
The [README Quick Start](https://github.com/stratum-eng/stratum/blob/main/README.md#quick-start) covers secrets,
migrations, and deployment; keep production and staging in separate
Artifacts namespaces.

## What license is Stratum under, and what does self-hosting oblige me to?

Licensing is by directory: the server, web UI, `docs/`, and `website/` sources
are **AGPL-3.0-or-later**; the `@stratum/cli` and `@stratum/agent` packages are
**Apache-2.0**; the published agent skills under
`website/public/.well-known/agent-skills/` stay **MIT**, because they exist to be
pasted into third-party agents. Releases through v0.2.0 were MIT and stay MIT.
[`LICENSING.md`](https://github.com/stratum-eng/stratum/blob/main/LICENSING.md) is authoritative and explains each choice.

Running an **unmodified** Stratum obliges you to nothing at all — no notice, no
publication. If you **modify** Stratum and other people reach your instance over
a network (your own developers count), AGPL §13 asks you to offer those users
the source of the version you are running. Point `STRATUM_SOURCE_URL` in
`src/version.ts` at the repository holding your changes and redeploy; the page
footer and the `X-Source-Code` header on every API and `/mcp` response then
carry the offer. That is the source-offer mechanism — the part Stratum handles
for you — rather than the whole of the license: modifying Stratum also carries
§5's obligations to mark your changes and preserve the legal notices.

Nothing in the license reaches your own work. The repositories Stratum hosts,
the changes it evaluates, your `.stratum/policy.yaml`, your custom evaluators
consumed over the CI integration, and anything that talks to the REST API, the
CLI, or `/mcp` are separate works under whatever license you choose. Commercial
use, including running Stratum as a paid service, is permitted under the AGPL.

## How do backups work?

Backups require the **optional R2 bucket binding** — without it the scheduled
backup logs a warning and skips the run, so configure R2 if you want backups.
With R2 configured, D1 (changes, issues, events, costs, audit) and KV identity
data back up daily and on demand, along with the reachable history of a
rotating slice of repositories — coverage rotates across runs under a per-run
cap, so every repo is covered over time rather than every run. There is a
tested restore path, documented in
[`docs/runbooks/backup-restore.md`](https://github.com/stratum-eng/stratum/blob/main/docs/runbooks/backup-restore.md).

## Can I turn off telemetry?

Yes, at two levels.

**Per account.** Open **Settings → Privacy** and clear *Send anonymous usage
analytics*. That stops future events for your account and for any agent token
you own — an agent inherits its owner's choice, so routing traffic through an
agent does not re-enable it. The change takes effect on your next request. It
is not retroactive: events already sent are not deleted.

**Browser analytics is separate, and off unless you turn it on.** Everything
described above is sent by the server. A second, independent switch —
`POSTHOG_PUBLIC_KEY` — additionally loads PostHog's JavaScript SDK in your
users' browsers. The documentation site is built separately and reads the same
variable at build time, so it is set in both places if you run both. It is a distinct key on purpose: enabling server-side
telemetry has never meant running third-party code in your users' browsers or
sending their IP addresses anywhere, and setting `POSTHOG_API_KEY` still does
not. If it is unset, no analytics script is served, to anyone. It must be a PostHog **project** key (`phc_…`); anything else is
refused rather than published, because the value appears in every page of HTML
and a personal API key (`phx_…`) pasted there would be a credential leak.

**Per instance.** Analytics only runs at all if you set a `POSTHOG_API_KEY`,
and self-hosted instances can set `STRATUM_TELEMETRY_DISABLED = "true"` in
`wrangler.toml` to switch it off for everyone. Declare it in **each**
`[env.<name>.vars]` block you deploy — named environments do not inherit
top-level `[vars]`, so a top-level-only setting never reaches
`wrangler deploy --env=production`. The instance switch always wins over an
individual account's preference.

### What exactly is sent

Every property on every event is either a **source-code literal** (a route
pattern, an event type, a tool name) or a **bounded value** (a status code, a
duration, a score, an enum). Names, paths, URLs, titles, refs, diffs, file
contents, and request payloads are never sent. The one exception is noted
against `mcp_request` below.

The list is exhaustive — `src/analytics/events.ts` is its single source of
truth, and a test fails the build if this table and that file disagree.

| Event | Sent when | Properties |
|-------|-----------|------------|
| `api_request` | Once per request that matched a route | `method`, `route`, `status`, `latency_ms`, `surface`, `actor_type` |
| `mcp_request` | Once per JSON-RPC message handled at `/mcp` | `mcp_method`, `outcome`, `tool`, `client_name`, `client_version`, `protocol_version` |
| `auth_completed` | Once per completed sign-up or sign-in | `kind` (`signup`/`signin`), `provider` (`github`/`google`/`email`) |
| `error_occurred` | Once per unhandled exception | `route`, `method`, `error_type` |
| `background_job_completed` | Once per background job reaching a terminal state | `job`, `outcome`, `attempts` |
| `stratum.<event type>` | Once per repository activity (a change opening, a merge, a deploy) | `project_id`, `actor_type`, plus the per-type properties below |

If you have also set `POSTHOG_PUBLIC_KEY`, the SDK sends these from the
browser. They are produced by PostHog's code, not Stratum's, so the guarantees
below describe how we configure it rather than what we choose to emit:

| Event | Sent when |
|-------|-----------|
| `$pageview` | A page is loaded |
| `$pageleave` | A page is left |
| `$autocapture` | A link, button, or form control is interacted with |
| `$rageclick` | The same spot is clicked repeatedly, if your PostHog project enables it |
| `$identify` | A signed-in user is associated with their account |
| `$set` | Person properties are recorded, as part of identifying |
| `$create_alias` | A pre-sign-in anonymous session is linked to the account |

Every event additionally carries `environment` — the label the operator set in
`STRATUM_ENVIRONMENT`, so staging traffic can be told apart from production —
and `$lib_version`, the Stratum version that sent it, so a change in a metric
can be tied to the release that caused it. An event caused by an agent also
carries `agent_id`.

One person property is ever set: `signup_provider`, recorded once when an
account is created. It is what lets a question like "accounts that signed up
with GitHub in August" be asked at all. Your email address, username, and
display name are never sent.

The per-type properties on `stratum.*` events are the whole reason they are
worth collecting, and they are whitelisted per event type:

| Event type | Extra properties |
|------------|------------------|
| `stratum.change.evaluated` | `score`, `passed` |
| `stratum.change.reviewed` | `verdict` (`approve`/`request_changes`/`comment`) |
| `stratum.project.imported` | `source_provider` (`github`/`gitlab`/`bitbucket`/`other`) |
| `stratum.issue.closed` | `linked_change` (boolean) |
| `stratum.deployment.*` | `target` (`cloudflare`/`vercel`), `linked_change` (boolean) |

Everything else in an event's payload is dropped: workspace names, commit
shas, issue titles, import URLs, and deployment failure text all stay on your
instance. An event type not listed above contributes no extra properties at
all.

### What the browser sends, and what it does not

**Everything in this section describes the Stratum application.** The
documentation site is a separate deployment with separate rules, described
after it — its pages are published documentation with no accounts and nothing
private, so it deliberately does not redact what the application must.

Browser analytics on the application is held to the same promise as the server,
but it takes more work to keep, because PostHog's SDK collects by default and
this app's URLs and page titles are made of the things the promise forbids.

- **The same route patterns.** The server hands the SDK the route pattern it
  matched, and every URL-bearing property is rewritten to it before the event
  leaves the browser. `$current_url` becomes `https://your-host/:namespace/:slug`.
  Query strings, refs and `#fragment` anchors go with it.
- **Page titles are dropped**, because this app's titles contain repository,
  file, and issue names.
- **Referrers are dropped**, not rewritten. The referrer is the *previous*
  page's URL, and the route pattern describes the current one, so rewriting it
  would be silently wrong rather than merely absent. The referring **domain**
  is kept, since it has no path and is what makes acquisition answerable.
- **Anything unrecognised is dropped.** The filter is an allowlist: a property
  a future SDK release introduces is removed unless it has been reviewed and
  named. It cannot leak by being new.
- **Clicked elements are recorded without their text or attributes.** Otherwise
  a click on a repository link would send the repository name as link text and
  its path as an `href`. You therefore see that a file link was clicked, not
  which file.
- **No Core Web Vitals or dead-click tracking.** Both are implemented in code
  posthog-js downloads at runtime, and Stratum blocks runtime downloads so the
  only script your users receive is the pinned one served from your origin.
  The trade is deliberate: unpinned third-party code on pages that render
  private repositories is worse than a missing metric.
- **No session replay.** Stratum does not record sessions. It renders private
  source, and no masking configuration makes recording it a good idea.
- **Do Not Track is respected**, and so is Global Privacy Control — the SDK
  checks `navigator.doNotTrack`, `navigator.msDoNotTrack`, `window.doNotTrack`
  and `navigator.globalPrivacyControl`. This is the only control a signed-out
  visitor has, since the per-account setting needs an account.
- **IP addresses.** This is the one thing the browser sends that the server
  never did. PostHog derives approximate location from it. Requests are
  proxied through your own instance at `/_ph/*`, so PostHog sees your Worker
  rather than your users — and the client IP is forwarded in a header, because
  without it every user appears to be in a Cloudflare datacentre. If that
  trade is wrong for your instance, leave `POSTHOG_PUBLIC_KEY` unset.
- **Why the requests go through your instance.** The SDK and its events are
  served from your own origin rather than PostHog's. It keeps the script under
  your Content-Security-Policy, lets it be version-pinned and cached, and means
  content blockers do not silently bias your numbers toward users who do not
  run one. That last reason is a deliberate choice and is stated here rather
  than left for you to discover in `src/routes/posthog-proxy.ts`. The proxy
  forwards only PostHog's ingestion paths, strips your session cookie and
  `Referer` before forwarding, and refuses anything else. It is inert unless
  `POSTHOG_PUBLIC_KEY` is set, so an instance that never turned browser
  analytics on is not running a relay, and it refuses a beacon from an account
  that has opted out — which is what stops a browser tab opened *before* you
  opted out from continuing to report. That account check applies to the
  application only; the documentation site has no accounts.

### What the documentation site sends

`docs.usestratum.dev` is built and deployed separately, and it is instrumented
separately. The differences are deliberate:

- **URLs are sent as they are**, not rewritten to route patterns. Which
  documentation page someone read is the entire question there, and every one
  of those URLs is public.
- **Clicked link text and attributes are not masked**, for the same reason:
  they are published documentation, so masking them would cost the answer and
  protect nothing.
- **There is no account**, so there is no per-account opt-out to honour and no
  user is ever identified. `respect_dnt` is the only control, and it is on.
- **No session replay**, the same as the application.
- It is off unless `POSTHOG_PUBLIC_KEY` is present at build time, so a fork
  building these docs ships nothing.

### The details worth knowing

- **Route patterns, never URLs.** `api_request` reports
  `/:namespace/:slug/files`, not the path that was actually requested, so
  namespaces, repo slugs, change ids, and file paths are not sent. A request
  that never reached a registered route is captured with `route: "*"`; a 404 is
  excluded entirely rather than captured as `"*"`.
- **`surface`** says which part of Stratum served the request — `api`, `ui`,
  `git`, `mcp`, `auth`, `admin`, or `internal`. It is derived from the route
  pattern, so it inherits the same guarantee.
- **`mcp_request` carries the one free-text field.** `client_name` and
  `client_version` are whatever the connecting software calls itself in the MCP
  handshake, capped at 64 characters. They answer "which editors and agents
  connect to Stratum". Everything else on the event is bounded: `tool` and
  `mcp_method` are reported only when they name a tool or a JSON-RPC method
  this build actually implements, and anything else — both are strings a client
  can put anything in — is reported as `unknown` rather than echoed back.
- **`error_occurred` never carries the exception message.** Messages quote
  their input. Only the error's type name (`TypeError`) is sent; the message
  stays in your own Workers logs.
- **Project ids, never project names.** A name identifies private source as
  surely as a repo slug in a URL does. The opaque id groups events just as
  well.

Events also carry identity attribution: the `distinctId` is the acting user's
id (or `server` for unattributed requests, and `system` for events no person
caused — both marked personless) so usage can be counted per account.

**An agent is attributed to the person who owns it**, not to itself. An agent
token is a credential you minted, acting under your account — your opt-out
already governs it, so your identity is what "who did this" means. The agent's
own id rides along as `agent_id`, so the two stay distinguishable without an
agent counting as a separate person.

Domain events are dated from when the activity happened, not from when the
queue got round to exporting them.

## Where are my invite codes?

Open **Settings** (the *settings* link in the header) and look under
*Account*. If your account was issued invite codes, they are listed there with
a share link for each one and whether it has been redeemed yet — codes you can
still give away are marked *Available*. (`/profile` still redirects there.)

Codes are issued only on an instance running the optional closed-beta gate, and
only to accounts that joined through it. If you signed up while signups were
open, you have no codes and the page says so. The hosted instance
(`app.usestratum.dev`) has open signup, so most accounts there hold none.

Send someone the share link rather than the bare code: it carries `?ref=<code>`,
which fills the code in for them on the signup form. Each code admits one
person, and a redeemed code cannot be reused.

The page also stays useful after the gate is switched off — codes minted while
it was on remain listed and redeemable, so the listing keys off the invite
service being configured rather than off the gate. If the page says your codes
could not be loaded, that is a temporary problem reaching the invite service;
nothing has been lost, and a reload once it recovers shows them again.

## What if my policy file has a mistake in it?

A present-but-malformed `.stratum/policy.yaml` fails closed: the merge gate
blocks until the file parses, rather than silently running on defaults. This is
deliberate — a typo in a stricter policy can't quietly downgrade governance.
Fix the YAML and re-evaluate.

## How do I get help?

Open an issue on the GitHub repository, or start with the
[getting started guide](/guides/getting-started/),
[troubleshooting](/guides/troubleshooting/), and the
[API reference](/reference/openapi/).
