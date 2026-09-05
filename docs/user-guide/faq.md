# FAQ

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
  merged HEAD, and a failure automatically lands a forward revert commit. This
  one needs the Cloudflare Sandboxes beta, which is off by default everywhere
  (see the next answer); without the binding the command is skipped with a
  warning.
- **Provenance and cost are recorded per merged change** — model, prompt hash,
  eval score, LLM tokens, sandbox time.
- A malformed `.stratum/policy.yaml` **fails closed** (blocks merges) instead of
  silently falling back to defaults.

## Does Stratum replace GitHub Actions?

No. Stratum has no native CI runner — no workflows, hosted runners, matrix
builds, artifacts, caching, scheduled jobs, deployment environments, or
status-check aggregation (it does not collect external CI check results the way
a GitHub PR's checks tab does). Its code execution is limited to the evaluation
pipeline: the sandbox evaluator, the `webhook` evaluator (a synchronous call-out
to CI *you* host, which must answer within the request timeout — default 10s),
and the post-merge smoke command run in a sandbox.

Of those, **only the webhook evaluator works out of the box.** Both sandbox
paths need the Cloudflare Sandboxes beta, and `[[sandboxes]]` is commented out
in `wrangler.toml` — so the hosted instance and any fresh self-host have no
`SANDBOX` binding. Without it the sandbox evaluator does not skip, it **fails
closed** (score 0 / failed), and naming `sandbox` in `merge.requiredEvaluators`
therefore blocks every merge in that project; `merge.postMergeCommand` is
skipped with a warning instead. If you want tests gating merges today, bring
your own CI and wire it in via the webhook evaluator, or use layer mode and keep
running GitHub Actions on the promoted PRs. See
[CI Integration](ci-integration.md).

Two things on that list have since arrived in a narrow form. Stratum now has an
**encrypted per-project secret store** — but it is deploy-only: the deploy
runner is its sole reader, and the webhook evaluator's `secret` still lives
literally in the policy file. And it can **deploy the merged tree** to
Cloudflare or Vercel from a `deploys:` block, with an optional approval gate
and a retry. That is not deployment environments: there is no
staging/production separation, no per-environment variables, no build step, no
preview deploy, and no rollback. See [Deployments](deployments.md).

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

The software is MIT-licensed and free; self-hosted, you pay only for the
Cloudflare resources you use (Workers, Artifacts, D1, KV, Queues, plus Workers
AI and Sandboxes if you enable those evaluators). Stratum meters estimated
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
  [Importing from GitHub](importing.md#unsupported-content).

See [`docs/CURRENT_CAPABILITIES.md`](../CURRENT_CAPABILITIES.md) for the
authoritative, current state.

## Does Stratum support Git LFS?

No. There is no LFS server: the git smart-HTTP router exposes only
`info/refs`, `git-upload-pack`, and `git-receive-pack` — there is no
`/info/lfs` route and no `objects/batch` endpoint, so `git lfs` clients get a
`404 Not found` when they call the batch API and an LFS-enabled clone fails
at that point. Combined with the 50 MB cap on git push request bodies,
large-binary workflows are effectively blocked. Keep binaries out of
Stratum-hosted repos, or keep LFS-dependent repos on GitHub and use layer
mode. See [`docs/CURRENT_CAPABILITIES.md`](../CURRENT_CAPABILITIES.md) and the
implementation sketch in [`docs/REMAINING_WORK.md`](../REMAINING_WORK.md).

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
Optional: the Workers AI binding for the LLM evaluator, R2 for backups, and
Cloudflare Email for magic links. Sandboxes — for the `sandbox` evaluator and
`merge.postMergeCommand` — is a gated beta whose `[[sandboxes]]` binding is
commented out in `wrangler.toml`; uncomment it in every `[env.*]` block you
deploy once your account has access, and until then keep both features out of
your policy, since the evaluator fails closed (and a `requiredEvaluators` entry
for it blocks all merges).
The [README Quick Start](../../README.md#quick-start) covers secrets,
migrations, and deployment; keep production and staging in separate
Artifacts namespaces.

## How do backups work?

Backups require the **optional R2 bucket binding** — without it the scheduled
backup logs a warning and skips the run, so configure R2 if you want backups.
With R2 configured, D1 (changes, issues, events, costs, audit) and KV identity
data back up daily and on demand, along with the reachable history of a
rotating slice of repositories — coverage rotates across runs under a per-run
cap, so every repo is covered over time rather than every run. There is a
tested restore path, documented in
[`docs/runbooks/backup-restore.md`](../runbooks/backup-restore.md).

## Can I turn off telemetry?

Yes, at two levels.

**Per account.** Open **Settings → Privacy** and clear *Send anonymous usage
analytics*. That stops future events for your account and for any agent token
you own — an agent inherits its owner's choice, so routing traffic through an
agent does not re-enable it. The change takes effect on your next request. It
is not retroactive: events already sent are not deleted.

**Per instance.** Analytics only runs at all if you set a `POSTHOG_API_KEY`,
and self-hosted instances can set `STRATUM_TELEMETRY_DISABLED = "true"` in
`wrangler.toml` to switch it off for everyone. Declare it in **each**
`[env.<name>.vars]` block you deploy — named environments do not inherit
top-level `[vars]`, so a top-level-only setting never reaches
`wrangler deploy --env=production`. The instance switch always wins over an
individual account's preference.

Two kinds of event are sent, and only these:

- **`api_request`**, one per request. Its properties are limited to the matched
  route pattern (e.g. `/:namespace/:slug/files`), method, status, and latency —
  never the concrete URL, so namespaces, repo slugs, change ids, and file paths
  are not sent to PostHog. A request that never reached a registered route is
  captured with `route: "*"`; a 404 is excluded entirely rather than captured as
  `"*"`.
- **`stratum.<event type>`**, one per repository activity (a change opening, a
  merge). Its properties are limited to the event type, the actor type, and an
  opaque project id — never the project's name.

Neither carries diffs, file contents, or request payloads.

Events also carry identity attribution: the `distinctId` is the acting user or
agent id (or `server` for unattributed requests, which are marked personless) so
usage can be counted per account.

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
[getting started guide](getting-started.md),
[troubleshooting](troubleshooting.md), and the
[API reference](../api/openapi.yml).
