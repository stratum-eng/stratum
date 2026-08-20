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

### Self-hosting

Stratum is MIT-licensed and self-hostable on your own Cloudflare account. You
need Node.js 20+ and a Cloudflare account with Workers, **Artifacts (beta)**, D1,
KV, and Queues; AI Gateway is optional and only needed for the LLM evaluator,
and Sandboxes only for the sandbox evaluator. Follow the
[Quick Start in the README](../../README.md#quick-start) — everywhere this guide
says `app.usestratum.dev`, substitute your own `https://your-instance.workers.dev`.

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
evaluation:
  evaluators:
    # Bound the blast radius of any single change.
    - type: diff
      maxFiles: 30
      maxLines: 1000
      forbiddenPatterns:
        - "console.log("
        - "TODO: remove"

    # Call your existing CI system.
    - type: webhook
      url: "https://ci.example.com/evaluate"
      secret: "${CI_WEBHOOK_SECRET}"
      timeoutMs: 300000

    # Run the test suite in a Cloudflare Sandbox.
    - type: sandbox
      command: "npm test"
      timeoutMs: 120000

    # AI review of the diff, scored 0.0-1.0.
    - type: llm
      model: "claude-sonnet-4-20250514"
      threshold: 0.7
      maxDiffChars: 100000

merge:
  requiredApprovals: 1
  requiredEvaluators: ["secret_scan", "diff", "sandbox"]
  allowForce: false
  requireFreshBase: true
  postMergeCommand: "npm test"
  postMergeTimeoutMs: 120000
  autoRevert: true
```

A malformed policy file **fails closed**: the merge gate blocks rather than
silently falling back to defaults, so a typo in a stricter policy can't quietly
downgrade your governance.

### The evaluators

- **Secret scan — always on, always blocking.** You don't configure it and you
  can't turn it off. Every change is scanned for API keys, tokens, and other
  credentials; a hit blocks the merge.
- **`diff`** — pure analysis of the change, no code execution. Caps the number
  of files (`maxFiles`) and lines (`maxLines`) changed, and can reject diffs
  containing `forbiddenPatterns` or missing `requiredPatterns`. Cheap, fast, and
  the first line of defense against runaway agent edits.
- **`webhook`** — POSTs the change to an external URL (your existing CI) and
  waits up to `timeoutMs` for a verdict. `secret` signs the delivery so your CI
  can verify it came from Stratum.
- **`sandbox`** — clones the workspace into a Cloudflare Sandbox and runs
  `command` (default: the project's test command), passing or failing on exit
  code. Requires the Sandboxes binding on self-hosted instances; when the
  binding is absent this evaluator **fails closed** rather than silently
  passing.
- **`llm`** — sends the diff to an LLM (via AI Gateway) for review against your
  criteria. `model` picks the reviewer, `threshold` is the minimum passing score
  (0.0–1.0), and `maxDiffChars` bounds how much diff is sent. Token usage is
  recorded on the change as a cost record.

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
  sandbox against the merged HEAD (e.g. `npm test`), with a default timeout of
  60 seconds.
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

This returns a **short-lived agent token** (`stratum_agent_...`). Two things to
know about its scope:

- The token is **scoped to the owning user**: the agent inherits your project
  access (including org access) and nothing more. Tokens are short-lived and
  managed from the settings UI alongside your API keys.
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

5. **Merge.** Merges are **squash merges**, serialized per-project through a
   Durable Object merge queue so there are no races. The merge is rejected if a
   required evaluator is failing, approvals are short, the base is stale
   (`requireFreshBase`), or the workspace moved since evaluation. If a
   `postMergeCommand` is configured it runs against the merged HEAD, and a
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

### CLI — `@stratum/cli`

The CLI wraps the full REST API: projects, workspaces, commits, changes
(including review and merge), issues, and activity. It is not yet published to
npm — install it from the `cli/` directory of the repo:

```bash
git clone https://github.com/stratum-eng/stratum.git
cd stratum/cli && npm install && npm run build
npm link   # puts the `stratum` binary on your PATH

stratum login --host https://app.usestratum.dev --key stratum_user_xxxxx
# or: export STRATUM_HOST=... STRATUM_API_KEY=...   (env overrides the config file)

stratum status        # who am I
stratum projects      # list your projects
```

See [`cli/README.md`](../../cli/README.md) for the full command reference.

### MCP server — `@stratum/mcp`

The MCP server gives **any** MCP-capable agent or editor (Claude Code, Cursor,
Zed, Copilot, custom agents) the full eval-gated change flow: read files, fork
workspaces, commit, create changes (with each gate's verdict returned), review,
merge, and track issues. Like the CLI, it is not yet on npm — install from the
`mcp/` directory.

Claude Code:

```bash
export STRATUM_API_KEY=stratum_user_xxxxx
claude mcp add stratum -e STRATUM_API_KEY=$STRATUM_API_KEY -- node /path/to/stratum/mcp/dist/index.js
```

Any MCP client (stdio):

```json
{
  "mcpServers": {
    "stratum": {
      "command": "node",
      "args": ["/path/to/stratum/mcp/dist/index.js"],
      "env": { "STRATUM_API_KEY": "stratum_user_..." }
    }
  }
}
```

`STRATUM_HOST` defaults to `https://app.usestratum.dev`; set it for self-hosted
instances. All governance invariants hold over MCP exactly as over REST: agent
tokens can't approve their own work, failing evaluators block merges, and
provenance is recorded.

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

- [FAQ](faq.md) — common questions, including honest current limitations
- [Importing from GitHub](importing.md) — import and sync details
- [Troubleshooting](troubleshooting.md) — common issues
- [API reference](../api/openapi.yml) — the complete REST surface
