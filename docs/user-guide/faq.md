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
  merged HEAD, and a failure automatically lands a forward revert commit.
- **Provenance and cost are recorded per merged change** — model, prompt hash,
  eval score, LLM tokens, sandbox time.
- A malformed `.stratum/policy.yaml` **fails closed** (blocks merges) instead of
  silently falling back to defaults.

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
are alternatives; all resolve to the same email-based identity.

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
configuration that relaxes it. Whether an agent can trigger a *merge* is up to
your policy: with `merge.requiredApprovals: 1` or more, at least one human must
approve first, so an agent can never land work no human has seen. If you set no
required approvals and its required evaluators pass, a merge call with an agent
token will go through — so set `requiredApprovals` on anything you care about.

## What does provenance actually record?

Per merged change: the author identity (human or agent), the model and a hash of
the prompt snapshotted at change creation, and the evaluation score, per merged
commit. Full per-evaluator evidence (scores, findings, durations) is linked by
change. The schema also has room for model config, reasoning traces, and tool
calls where the client supplies them. Agents authenticate with their own
short-lived tokens (scoped to an owning user), so work is attributed to the
agent, not laundered through a human account.

## What does it cost, and what is metered?

The software is MIT-licensed and free; self-hosted, you pay only for the
Cloudflare resources you use (Workers, Artifacts, D1, KV, Queues, plus AI
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
- **Squash-only merges**: true merge commits are not yet supported.
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

See `docs/CURRENT_CAPABILITIES.md` for the authoritative, current state.

## Can I use plain `git` with Stratum?

Yes, over smart HTTP with your API key as the HTTP Basic password (enter it at
the prompt or store it with a git credential helper — don't embed it in the
URL): `git clone https://<host>/@ns/slug.git` for projects (read), and
`.../@ns/slug/workspaces/<name>.git` for workspaces (read **and** `git push`).
A push to the project URL is rejected in-protocol so the evaluation gate can't
be bypassed.
SSH transport is not supported (Workers have no raw TCP listener).

## What do I need to self-host?

Node.js 20+ and your own Cloudflare account with Workers, **Artifacts (which is
in beta — you need access to it)**, D1, KV, and Queues. Optional: AI Gateway for
the LLM evaluator, Sandboxes for the sandbox evaluator (without the binding that
evaluator fails closed), R2 for backups, and Cloudflare Email for magic links.
The README Quick Start covers secrets, migrations, and deployment; keep
production and staging in separate Artifacts namespaces.

## How do backups work?

Backups require the **optional R2 bucket binding** — without it the scheduled
backup logs a warning and skips the run, so configure R2 if you want backups.
With R2 configured, D1 (changes, issues, events, costs, audit) and KV identity
data back up daily and on demand, along with the reachable history of a
rotating slice of repositories — coverage rotates across runs under a per-run
cap, so every repo is covered over time rather than every run. There is a
tested restore path, documented in `docs/runbooks/backup-restore.md`.

## Can I turn off telemetry?

Yes. Analytics (PostHog) is optional — it only runs if you set a
`POSTHOG_API_KEY`, and self-hosted instances can set
`STRATUM_TELEMETRY_DISABLED = "true"` in `wrangler.toml` to switch it off
entirely. When enabled, each event's request properties are limited to the
matched route pattern (e.g. `/:namespace/:slug/files`), method, status, and
latency — never the concrete URL, so namespaces, repo slugs, change ids, and
file paths are not sent to PostHog. A request that never reached a
registered route is captured with `route: "*"`; a 404 is excluded entirely
rather than captured as `"*"`. Events also carry identity attribution: the
`distinctId` is the acting user or agent id (or `server` for unattributed
requests, which are marked personless) so usage can be counted per account.

## What if my policy file has a mistake in it?

A present-but-malformed `.stratum/policy.yaml` fails closed: the merge gate
blocks until the file parses, rather than silently running on defaults. This is
deliberate — a typo in a stricter policy can't quietly downgrade governance.
Fix the YAML and re-evaluate.

## How do I get help?

Open an issue on the GitHub repository, or start with the
[getting started guide](getting-started.md),
[troubleshooting](troubleshooting.md), and the API reference in
`docs/api/openapi.yml`.
