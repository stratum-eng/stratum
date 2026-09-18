# Getting started

This guide walks a new team from zero to a merged, evaluation-gated change. By the
end you will have a project, a merge policy, a registered agent identity, and the
CLI and MCP server connected to your tools.

Stratum is a code collaboration platform where humans and AI agents are both
first-class citizens. Every proposed change — human or agent — passes through the
same evaluation gates before it can merge, and every merged change carries a
provenance record of who (or what model) produced it.

## 1. Sign up or self-host

### Hosted

The hosted instance runs at `https://app.usestratum.dev` with **open signup** —
no invite code or waitlist. (If you hit an invite prompt, you're on an instance
whose operator has enabled the optional closed-beta gate.)

Sign in with any of:

- **Email magic link** (recommended — no external accounts needed): enter your
  email at `/auth/email` and click the link you receive.
- **GitHub OAuth** at `/auth/github` — required later if you want bidirectional
  GitHub sync.
- **Google OAuth** at `/auth/google`.

All three resolve to the same email-identity account, so you can mix methods.
Every method asks you to choose a **username** the first time: it is your
namespace (`@you/project` in every URL and clone URL). You can change it in
Settings while you own no projects; while any exists it is fixed, because
every project is keyed under it (after deleting your last project, allow up to
15 minutes before the form reappears). GitHub and Google sign-in suggest one from
your handle or email address and let you pick another before the account
exists. A separate display name, shown in the header, can be changed any time.

### Self-hosting

Stratum is AGPL-3.0-or-later and self-hostable on your own Cloudflare account. You
need Node.js 22.13+ and a Cloudflare account with Workers, **Artifacts (beta)**,
D1, KV, Queues, and Durable Objects. R2 is optional — it backs the scheduled
backup run, which logs a warning and skips when `BACKUPS` is unbound
(`src/backup/run-backup.ts:116`). The Workers AI binding is optional too, and
only needed for the LLM evaluator. Sandboxes — needed by the `sandbox`
evaluator and by `merge.postMergeCommand` — is a **gated Cloudflare beta**, and
its `[[sandboxes]]` binding ships **commented out** in `wrangler.toml`, so
neither the hosted instance nor a fresh self-host has it. Leave both features
out of your policy until you have Sandboxes access and have uncommented the
binding in every `[env.*]` block you deploy. Follow the
[Quick Start in the README](../../README.md#quick-start) — everywhere this guide
says `app.usestratum.dev`, substitute your own instance's origin.

Self-hosting an unmodified Stratum obliges you to nothing. If you modify it and
other people use your instance over a network, AGPL §13 asks you to offer them
that version's source — one constant, `STRATUM_SOURCE_URL` in `src/version.ts`,
points both the page footer and the `X-Source-Code` response header at your
repository. The code you *host in* Stratum is untouched by this.

## 2. Create or import a project

### Create a fresh project

From the dashboard, click **New Project** and pick a name and visibility, or use
the API:

```bash
curl -X POST https://app.usestratum.dev/api/projects \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-project", "visibility": "private"}'
```

Projects live under a namespace — `@your-username` for personal projects, or an
org slug for org-owned projects. Org membership grants read access; the org
owner/admin role or membership in a write/admin team grants write access.

### Import an existing repository

Stratum imports from **GitHub, GitLab, and Bitbucket**. Imports run as background
jobs, so large repositories don't block the request:

```bash
curl -X POST https://app.usestratum.dev/api/projects/@you/my-project/import \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/your-org/your-repo", "branch": "main"}'
```

### Choose your level of buy-in: layer mode vs. alternative mode

You do not have to leave your current forge to use Stratum. The same codebase
supports two modes:

- **Layer mode (minimal buy-in).** Stratum sits between your agents and GitHub.
  Import a GitHub repo and enable **bidirectional GitHub sync**: inbound webhooks
  keep the Stratum project current with pushes and PRs, and outbound sync
  promotes a Stratum change to a GitHub PR. Whenever a change with a linked PR
  is evaluated, the verdict is posted to the PR as a comment (edited in place on
  re-evaluation) and a `stratum/evaluation` commit status. Agents work through
  Stratum's gates; your team keeps reviewing in GitHub PRs.
- **Alternative mode (full buy-in).** Stratum is the source of truth for repos,
  workspaces, and changes. No GitHub required — email magic links mean no
  external accounts at all.

Start in layer mode if you're evaluating; nothing about the change flow below
differs between the modes.

## 3. Write your evaluation policy

Merge gates are configured in a `.stratum/policy.yaml` file at the root of your
repository. Commit it like any other file. Here is a realistic policy for a
TypeScript service:

```yaml
# Evaluators live at the TOP level — not nested under any other key.
evaluators:
  # Bound the blast radius of any single change. Patterns match FILE PATHS
  # in the diff, not file contents.
  - type: diff
    maxFiles: 30
    maxLines: 1000
    forbiddenPatterns:
      - "*.lock"
      - "node_modules/"
      - ".env"

  # Call your existing CI system. The secret is used literally — there is
  # no environment-variable interpolation in this file — and timeoutMs is
  # capped at 120000 (2 minutes).
  - type: webhook
    url: "https://ci.example.com/evaluate"
    secret: "a-long-random-string-you-generated"
    timeoutMs: 120000

  # Run the test suite in a Cloudflare Sandbox. LEFT COMMENTED ON PURPOSE:
  # Sandboxes is a gated beta and its binding is off by default, and this
  # evaluator does not skip when the binding is missing — it returns
  # score 0 / failed. Uncomment only once [[sandboxes]] is enabled.
  # - type: sandbox
  #   command: "npm test"
  #   timeoutMs: 120000
  #   totalBudgetMs: 150000
  #   allowInstallScripts: false

  # AI review of the diff, scored 0.0-1.0. With no `provider` this runs on
  # the instance's Workers AI binding, and omitting `model` uses the default
  # (@cf/meta/llama-3.1-8b-instruct); a model id Workers AI doesn't serve makes
  # this evaluator fail closed. Naming a `provider` runs the review on your own
  # key instead (see below) and then `model` is required.
  - type: llm
    threshold: 0.7
    # provider: anthropic
    # model: claude-sonnet-4-5

merge:
  requiredApprovals: 1
  # Only evaluators that actually run belong here. "sandbox" would block every
  # merge in this project while the Sandboxes binding is absent.
  requiredEvaluators: ["secret_scan", "diff"]
  allowForce: false
  requireFreshBase: true
  # Sandboxes-only, so also commented out. Unlike the evaluator, this one
  # degrades quietly: with no binding the smoke test is skipped with a warning.
  # postMergeCommand: "npm test"
  # postMergeTimeoutMs: 120000
  # autoRevert: true
```

A malformed policy file **fails closed**: the merge gate blocks rather than
silently falling back to defaults, so a typo in a stricter policy can't quietly
downgrade your governance.

The same fail-closed instinct is why the Sandboxes-dependent entries above are
commented out. `merge.requiredEvaluators` is enforced against the *latest run*
of each named evaluator, and an evaluator whose binding is missing runs and
fails rather than being skipped — so naming `sandbox` on an instance without
Sandboxes makes every change in that project permanently unmergeable. Recovering
means editing `.stratum/policy.yaml`, which is itself a protected config file
requiring a human approval and refusing force-merge.

### The evaluators

- **Secret scan — always on, always blocking.** You don't configure it and you
  can't turn it off. Every change is scanned for API keys, tokens, and other
  credentials; a hit blocks the merge.
- **`diff`** — pure analysis of the change, no code execution. Caps the number
  of files (`maxFiles`, default 20) and lines (`maxLines`, default 500)
  changed, and can reject diffs touching `forbiddenPatterns` or missing
  `requiredPatterns`. **Patterns match file paths, not file contents** — `*`
  is a wildcard and anything else is a substring match, so `node_modules/`
  works and `console.log(` matches nothing. The verdict is **scored, not
  binary**: each violation costs 0.25 off a 1.0 score, and the evaluator
  passes at `minScore` — so under the default 0.7, a *single* violation
  (0.75) still passes and it takes two to fail. Set `minScore` above 0.75 if
  any one violation should block. Cheap, fast, and the first line of defense
  against runaway agent edits.
- **`webhook`** — POSTs the change to an external URL (your existing CI) and
  waits up to `timeoutMs` (default 10s, capped at 120s) for a verdict.
  `secret` signs the delivery so your CI can verify it came from Stratum; the
  value is used exactly as written, so generate a real secret rather than a
  `${...}` placeholder — nothing interpolates it.
- **`sandbox`** — **needs the Sandboxes beta, which is off by default
  everywhere, including the hosted instance.** `[[sandboxes]]` is commented out
  in `wrangler.toml`, so unless you self-host, have Sandboxes access, and
  uncomment the binding, this evaluator is unavailable — and *unavailable does
  not mean skipped*: it is substituted with an evaluator that returns score 0 /
  failed, so it drags the aggregate verdict down, and listing it in
  `merge.requiredEvaluators` blocks every merge in the project. Where the
  binding *is* enabled it materializes the workspace tree at the evaluated
  commit into a fresh Sandbox and runs `command` (default `npm test`), passing
  or failing on exit code. `timeoutMs` and `installTimeoutMs` bound the scored
  command and the dependency install separately (defaults 60s and 90s, each
  clamped to 1s–120s); `totalBudgetMs` (default 150s) bounds their
  *sum* — each phase gets `min(configured, budget remaining)`, and running out
  fails the evaluation instead of hanging. Dependency installs pass
  `--ignore-scripts` by default, since the evaluated tree is untrusted code an
  agent wrote and a `preinstall`/`postinstall` would otherwise run before any
  human review; set `allowInstallScripts: true` if your build genuinely needs
  them (native modules, a `prepare` step) — the usual symptom of leaving it off
  when you need it is *not* a failing install, but a native module that
  installs unbuilt and then fails when the test command loads it.
- **`llm`** — sends the diff to an LLM for review against your criteria.
  `model` picks the reviewer (default: `@cf/meta/llama-3.1-8b-instruct`, which
  the **Workers AI binding** serves); `threshold` is the minimum passing score
  (0.0–1.0); `maxDiffChars` bounds how much diff is sent (default 24,000, max
  100,000); `provider` runs the review on your own key instead of the
  instance's binding (see [Bringing your own model key](#bringing-your-own-model-key)).
  An unavailable model or unparseable verdict fails closed. Token usage is
  recorded on the change as a cost record — the counts the provider reports,
  or an estimate marked as estimated when a response omits them.
  **A policy may declare at most one `llm` entry** — a second one is a
  merge-blocking policy error, because the two entries cannot both be the
  configuration in force.

  Those four keys are the *only* keys this entry accepts. It is a whitelist:
  anything else you write here — including `baseUrl` — is ignored with a
  warning in the instance's logs and never reaches the reviewer. There is
  deliberately no way for a policy file to name an endpoint; a project may
  only select a provider the operator has already configured.

A policy may declare **at most 16 `evaluators:` entries**; more than that is a
policy error and blocks merges, the same as any other unusable entry. (The
`deploys:` list has the same cap, for the same reason: one merge must not turn
into an unbounded number of external calls.)

Two top-level knobs sit alongside `evaluators`: `requireAll` (default `true`)
makes the aggregate verdict demand every evaluator pass — set it to `false` to
pass when any one does — and `minScore` (default `0.7`, clamped to 0–1) is the
per-evaluator pass threshold the `diff` and `sandbox` evaluators score against.

### Bringing your own model key

By default the `llm` evaluator runs on the instance's Workers AI binding, and
the operator pays for the tokens. A project can instead run the merge gate on
its own account — its own provider, its own model, its own bill.

It takes two things, and both are deliberate:

1. **The operator configures the provider.** A named allowlist lives in the
   instance's `LLM_PROVIDERS` variable; each entry has a `name`, a `kind`
   (`anthropic` or `openai-compatible`), and the `baseUrl` for that endpoint.
   Self-hosting? That variable is yours to set. Unset — the default — the
   binding is the only option and everything below is inert.
2. **The project stores the key.** The credential goes in the project's secret
   store, the same one deploys use (*Project → Settings → Deploy secrets*, or
   `PUT /api/projects/{namespace}/{slug}/secrets/{name}`), under the name
   derived from the provider: provider `anthropic` reads `ANTHROPIC_API_KEY`,
   provider `my-gateway` reads `MY_GATEWAY_API_KEY`. Only a project admin who
   is not an agent may write it, and no route, log line or evaluation reason
   ever reads it back.

Then name the provider in the policy:

```yaml
evaluators:
  - type: llm
    provider: anthropic
    model: claude-sonnet-4-5
    threshold: 0.7
```

**`model` is required whenever `provider` is set.** The default model id is a
Workers AI one and would fail every call against any other endpoint, so a
provider entry that does not name its model is rejected rather than guessed at.

**Everything here fails closed, and never falls back to the instance's
binding.** A provider name the instance has not configured, a missing or
undecryptable key, an instance with no `DEPLOY_SECRET_KEY`, a provider that
answers with a redirect — each one fails the `llm` gate with a reason naming
which of them it was, and none of them quietly moves your review back onto the
operator's account. The corollary is worth planning for: a policy that names a provider
this instance does not have is a **policy error, and policy errors block
merges**.

Two more consequences to know before you switch:

- **Any project *writer* can spend your credit** by opening changes. BYOK moves
  the token bill to your provider account; it does not add an approval step in
  front of it.
- **On a hosted instance, your own key lifts the token allowance and nothing
  else.** The evaluation rate ceiling below is independent of who is billed for
  tokens: it bounds evaluation and Worker capacity, which is the operator's
  whoever owns the model account.

### Usage limits on a hosted instance

Self-hosted, there are no limits: the whole metering path is inert unless the
operator has configured a billing service, and every allowance reads as
unlimited. On a hosted instance the shape is:

- **A monthly token allowance**, plus monthly sandbox time and deploy counts.
  Only platform-billed usage counts against it — spend on your own provider key
  is billed by that provider and is tracked separately.
- **An hourly ceiling on evaluations**, which bounds burst rather than spend.
  **Bringing your own key does not lift it.**
- **An allowance follows the person, not the project.** By default it is checked
  against whoever ran the evaluation (an agent spends its owner's), so it is the
  same allowance whether you work in your own namespace or an organization's, and
  creating another organization does not hand you a fresh one. The one exception
  is an organization on a plan that pools: there the organization is the subject
  and its members draw on its allowance rather than their own. An organization
  the billing service has never heard of is not that — pooling has to be
  positively granted, or creating an organization would be the reset this rule
  exists to close.

You can see all of it — consumption, allowance, and when the period resets — at
`/settings/usage`, or over MCP with `stratum_get_usage`. Crossing 80% of a meter
raises a banner and sends one email. Where an operator has switched enforcement
on, an exhausted allowance surfaces as a **failing gate** on the change that hit
it — never as a skipped one — naming what ran out, when it resets, and both ways
out. An operator who has not switched it on records the same decisions and
admits every one of them, which is how a new limit gets measured before it
blocks anything.

### The merge protections

Everything under `merge:` is branch protection, enforced at the merge step:

- **`requiredApprovals`** — how many **human** approvals a change needs before
  it can merge. Agent approvals never count (see the invariant below).
- **`requiredEvaluators`** — evaluator types whose *latest run* must have
  passed. A change with a failing required evaluator cannot merge.
- **`allowForce`** — force-merge is **deny-by-default**. The `?force=true`
  override is rejected unless the policy explicitly sets `allowForce: true`.
  Leave it off (or set it to `false`, as above) unless you have a specific
  break-glass need.
- **`requireFreshBase`** — when true, a change whose recorded base is behind
  the project HEAD is rejected with `409 STALE_BASE`; re-evaluate on the new
  base first. Independently of this flag, a merge is always rejected if the
  workspace advanced after it was evaluated (`409 STALE_WORKSPACE`) — you can
  never merge commits the evaluators didn't see.
- **`postMergeCommand`** + **`postMergeTimeoutMs`** — a smoke command run in a
  Cloudflare Sandbox against the merged HEAD (e.g. `npm test`), with a default
  timeout of 60 seconds. This needs the same Sandboxes beta binding as the
  `sandbox` evaluator, but unlike the evaluator it fails *open*: with no binding
  the check is skipped with a log warning and the merge stands, so a policy that
  sets it on an instance without Sandboxes is silently getting no smoke test.
- **`autoRevert`** — if the post-merge command fails, Stratum lands a forward
  revert commit, marks the change `reverted`, and emits a `change.reverted`
  event. On by default when a `postMergeCommand` is set.

## 4. Register an agent identity

Agents are not shared service accounts — each one is a first-class identity:

```bash
curl -X POST https://app.usestratum.dev/api/agents \
  -H "Authorization: Bearer stratum_user_xxxxx" \
  -d '{"name": "refactor-bot"}'
```

This returns an **agent token** (`stratum_agent_...`). Two things to
know about its scope:

- The token is **bounded by the owning user**: the agent inherits your project
  access (including org access) and nothing more. Agent tokens do **not**
  expire and carry no read/`read_write` scope of their own. Within that
  inherited access an agent can read, fork workspaces, commit, open changes,
  comment, and open issues — but the **deciding** endpoints require a user
  identity and refuse an agent token outright: review verdicts (approve *and*
  request changes), merge, reject, re-evaluate, GitHub PR promotion, and issue
  triage (edit/close). Session-only endpoints (creating and revoking tokens)
  are out of reach for agent tokens as for scoped ones — the lone exception,
  `rotate-token` accepting the legacy credential, is covered in the
  [authentication reference](../api/authentication.md). Revoke an agent token
  by deleting the agent from the
  settings UI (or `DELETE /api/agents/{id}`); that is the only way to retire
  it.
- All writes made with an agent token are attributed to the agent in
  **provenance** — merged changes record which agent and which model produced
  them, not just which human owned the token.

### The human-approval invariant

Reviews (approve / request changes) are **human-only**. An agent token cannot
approve any change — not its own, not another agent's. This holds across every
surface (REST API, CLI, MCP): if your policy sets `requiredApprovals: 1`, a
human must look at the change before it merges. There is no configuration that
relaxes this.

The reference agent in [`agent/`](../../agent/README.md) shows the intended
shape: it creates its own identity, forks a workspace, asks Claude for edits,
commits, and opens a change — then stops. Review and merge stay on the platform.

## 5. The change flow

Every contribution — human or agent — follows the same path:

```text
workspace  →  commit  →  change (evaluation runs)  →  review  →  merge
```

1. **Fork a workspace.** A workspace is an isolated fork of the project — the
   equivalent of a branch, with its own git remote.

   ```bash
   stratum workspace create @you/my-project --name fix-n-plus-one
   ```

2. **Commit.** Commit files to the workspace via the CLI (`stratum commit` sends
   your staged files), the API, or `git push` to the workspace remote (see
   section 6).

   ```bash
   stratum commit --project @you/my-project --workspace fix-n-plus-one -m "Fix N+1 query"
   ```

3. **Create a change.** A change is Stratum's merge proposal (a PR, roughly).
   Creating it runs your full evaluation policy **synchronously** — you get each
   gate's verdict in the response.

   ```bash
   stratum change create --project @you/my-project --workspace fix-n-plus-one
   stratum change show chg_xxxxx   # eval evidence + costs
   ```

4. **Review.** A human approves or requests changes; this moves the change's
   state machine. Agents cannot perform this step.

   ```bash
   stratum change review chg_xxxxx --verdict approve --comment "LGTM"
   ```

5. **Merge.** The default is a **true three-way merge commit** (`--squash` /
   `strategy: "squash"` opts into a squash), serialized per-project through a
   Durable Object merge queue so there are no races. The merge is rejected if a
   required evaluator is failing, approvals are short, the base is stale
   (`requireFreshBase`), or the workspace moved since evaluation. A conflicting
   three-way merge is refused with `409 MERGE_CONFLICT` and a conflict id rather
   than silently falling back to a squash. If a `postMergeCommand` is configured
   *and* the Sandboxes binding is present, it runs against the merged HEAD and a
   failure auto-reverts.

   ```bash
   stratum change merge chg_xxxxx
   ```

### What a merged change carries

Every merged change keeps:

- **Provenance** — the author (human or agent), the model and prompt hash
  snapshotted at change creation, and the evaluation score, per merged commit.
- **Evaluator evidence** — the full per-evaluator results (score, findings,
  duration), linked by change and browsable in the UI.
- **Cost records** — estimated resource usage per change: LLM tokens, sandbox
  execution time, and git operations.

If a change was linked to an issue, the issue auto-closes on merge.

## 6. Connect your tools

### CLI — `@stratum-eng/cli`

The CLI wraps the full REST API: projects, workspaces, commits, changes
(including review and merge), issues, and activity. It is not yet published to
npm — install it from the `cli/` directory of the repo:

```bash
git clone https://github.com/stratum-eng/stratum.git
cd stratum/cli && npm install && npm run build
npm link   # puts the `stratum` binary on your PATH

stratum login          # opens your browser; no token to create or paste

# Headless (CI, containers), where there is no browser:
# stratum login --host https://app.usestratum.dev --key stratum_user_xxxxx
# or: export STRATUM_HOST=... STRATUM_API_KEY=...   (env overrides the config file)

stratum status        # who am I
stratum projects      # list your projects
```

See [the CLI guide](cli.md) for the full command reference, configuration, and
the commit path's limits.

### MCP server — `/mcp`

Stratum serves MCP from the Worker itself, so **any** MCP-capable agent or
editor (Claude Code, Cursor, Zed, Copilot, custom agents) reaches the eval-gated
change flow with nothing to install.

How much of that flow depends on the credential. An OAuth grant with `mcp:write`
— or a `stratum_user_` token with write access — gets all of it: read files,
fork workspaces, commit, create changes (with each gate's verdict returned),
review, merge, and track issues. An `mcp:read` grant reads only. An **agent
token** can read, fork, commit and open a gated change, but never review, merge
or reject: those are human decisions, and that is the point.

Claude Code:

```bash
claude mcp add --transport http stratum https://app.usestratum.dev/mcp
```

Any MCP client that supports remote servers:

```json
{
  "mcpServers": {
    "stratum": {
      "type": "http",
      "url": "https://app.usestratum.dev/mcp"
    }
  }
}
```

Replace the host with your own instance if you self-host. The first tool call
opens your browser to sign in and approve a consent screen; the client registers
itself and manages tokens from there, so no Stratum credential is ever pasted
into an editor's config. Revoke access from **Settings → Connected
applications**. A headless client with no browser can send a `stratum_user_` or
`stratum_agent_` token as a bearer token instead.

All governance invariants hold over MCP exactly as over REST: agent tokens can't
submit review verdicts, merge, or reject, failing evaluators block merges, and
provenance is recorded. See [the MCP server guide](mcp.md) for the full tool
reference, the OAuth details, and exactly what each credential kind may do.

### Plain git over smart HTTP

Stratum projects and workspaces are real git remotes. Authenticate with your API
key as the HTTP Basic password (username is ignored) — when prompted, or via a
[git credential helper](https://git-scm.com/docs/gitcredentials). Don't embed
the key in the URL: it ends up in shell history and `.git/config`.

```bash
# Clone a project (read) — enter your API key at the password prompt
git clone https://app.usestratum.dev/@you/my-project.git

# Clone AND push to a workspace (read + write)
git clone https://app.usestratum.dev/@you/my-project/workspaces/fix-n-plus-one.git
cd fix-n-plus-one
# ...edit, commit...
git push
```

Note the asymmetry: a push to the **project** URL does not update `main`
directly — a direct push to a protected ref would bypass the evaluation gate.
The push is answered in-protocol: each ref reports `remote rejected` with the
reason, and on instances with gated push enabled, a single-ref push to `main`
lands your commits on a server-managed workspace and opens an eval-gated
change whose id is streamed back in the push output. Otherwise, push to a
**workspace** remote and open a change as usual.

## Where to go next

- [Code Review](code-review.md) — comment threads, line anchors, and verdicts
- [Issues](issues.md) — the built-in tracker, and linking issues to changes
- [CI Integration](ci-integration.md) — bring your own CI via the webhook evaluator
- [FAQ](faq.md) — common questions, including honest current limitations
- [Importing from GitHub](importing.md) — import and sync details
- [Troubleshooting](troubleshooting.md) — common issues
- [API reference](../api/openapi.yml) — the complete REST surface
