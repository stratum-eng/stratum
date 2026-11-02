---
title: "Troubleshooting"
description: "Symptoms and fixes for auth, imports, evaluation, merges, and access."
editUrl: "https://github.com/stratum-eng/stratum/edit/main/docs/user-guide/troubleshooting.md"
---

Symptoms grouped by where they surface. Machine-readable codes are listed in
the [error code reference](/reference/errors/).

## Authentication and tokens

### `401 Unauthorized`

The token is unknown, revoked, or **expired**. Named API tokens can carry a
1–365 day expiry, checked on every request, and an expired token is a `401`
everywhere — API and git alike. Check the token's expiry in Settings; revoked
and expired rows are kept, so it will still be listed.

An agent token also fails closed if its **owning user is being deleted**.

### `403 TOKEN_SCOPE_INSUFFICIENT`

You are using a `read` token for a write. On API routes a `read` token is
refused with this `403` on everything that is not a `GET` or `HEAD`. Over
**git** the same rule applies to `git push` — including the
`info/refs?service=git-receive-pack` advertisement that precedes it — but
surfaces as a plain `404` ("Not found"), deliberately identical to a missing
repository so permissions can't be probed. A push that mysteriously 404s on a
repo you can clone is this. Mint a `read_write` token, or use the one you
meant to.

Read-only bounds *damage*, not *exposure*: a `read` token still reads every
private project its owner can read.

### `403 SESSION_REQUIRED`

Token-management endpoints (`GET|POST /api/users/me/tokens`,
`DELETE /api/users/me/tokens/{id}`, `POST /api/users/me/legacy-token/disable`,
and `rotate-token` for scoped tokens) accept the browser session cookie
**only**, whatever the token's scope. A token that could mint or revoke tokens
would make revocation meaningless. Do it from the settings UI.

### `409 TOKEN_LIMIT_REACHED`

You hold 20 active tokens. Revoke one — revoked tokens do not count toward the
limit, so rotating never locks you out.

### A token shows as never used

`lastUsedAt` is written at most once an hour, and **not at all** on the git
smart-HTTP path, which has no execution context to defer the write to. A token
used only for `git clone` legitimately shows as never used.

## Imports

### The import is stuck in "Import in Progress" or `CANCELLING`

It is not stuck any more. A scheduled sweep moves wedged jobs to a terminal
state on their own: a cancel that never finished lands in `cancelled`,
anything else that stopped progressing lands in `failed`. A job that was never
picked up by a worker gets a much longer grace period than one that started and
stalled, and its message will say the queue message was likely lost — retry to
re-queue it.

Previously this recovery only ran when somebody happened to open the project's
progress page, so an abandoned job could claim to be running indefinitely.

### The import failed on submodules

Git submodules are **not supported**. A gitlink entry at any depth, or a
root-level `.gitmodules`, fails the import rather than silently importing a
broken tree.

On import the scan is **best-effort**: if the just-imported tree cannot be read
at all (the read token cannot be minted, the clone fails, or the scan itself
errors) the import proceeds with a warning and is left unscanned, rather than
failing a healthy repository over an infrastructure hiccup. So a completed
import is not on its own proof that a repository is submodule-free.

The same scan runs whenever a change is created — on a gated push and through
`POST /api/projects/{name}/changes` alike — and **there it is unconditional**: a
change carrying submodule content is refused, and so is one whose scan could not
run. That is the gate that keeps submodule content out of a merge. See
[Unsupported content](/guides/importing/#unsupported-content).

### The import failed on Git LFS

Git LFS is entirely absent — there is no `/info/lfs` route and no
`objects/batch` endpoint, so an LFS-enabled clone or push fails when the
`git lfs` client tries to reach them. Pointer files import as ordinary text.

### `SYNC_DIVERGED`

The upstream and the Stratum copy have genuinely diverged in content — this is
raised only for real conflicts, not for a fetch window that was merely too
shallow. The fetch window is deepened incrementally before this is reported, so
a `SYNC_DIVERGED` means the histories actually conflict, not that the clone was
too shallow.

### Only some tags came across

Tag fetching pulls only tag-reachable objects and caps the tag count, reporting
`truncated` explicitly rather than silently dropping the rest.

## Evaluation

### Every change fails on `SANDBOX binding is not configured`

Your policy names a `sandbox` evaluator on an instance without the Cloudflare
Sandboxes binding. `[[sandboxes]]` is commented out in `wrangler.toml` (it is a
gated beta), so this is the default state on the hosted instance and on a fresh
self-host.

The evaluator is **not skipped**. It is replaced with one that returns score 0 /
failed and the reason *"sandbox unavailable: SANDBOX binding is not configured —
enable `[[sandboxes]]` in `wrangler.toml` or remove the sandbox evaluator from
the policy"*. That drags the aggregate verdict down, and if `sandbox` is listed in
`merge.requiredEvaluators` it blocks **every** merge in the project.

Remove the `sandbox` evaluator (and any `"sandbox"` entry in
`requiredEvaluators`) from `.stratum/policy.yaml`, or enable the binding. Note
the recovery commit edits a protected config file, so it needs a human approval
and cannot be force-merged. `merge.postMergeCommand` behaves differently: with
no binding it is skipped with a warning rather than failing the merge.

The `llm` evaluator fails closed the same way when the `AI` binding is absent
(`llm unavailable: AI binding is not configured`), though `wrangler.toml` does
bind Workers AI in every environment.

The remaining entries in this section apply only where Sandboxes **is** enabled.

### `sandbox budget exceeded (install)` or `(command)`

The evaluation ran out of its **total** time budget — `totalBudgetMs`, default
150s — which bounds the *sum* of the install and command phases. Each phase is
granted `min(configured, budget remaining)`, and exhausting the budget returns a
failing verdict naming the phase rather than hanging.

Raise `totalBudgetMs` on the `sandbox` evaluator in `.stratum/policy.yaml`, or
make the phase cheaper. Note the per-phase defaults (`installTimeoutMs` 90s,
`timeoutMs` 60s) sum to exactly the default budget, so an unconfigured project
is never truncated.

### A native module fails when the test command loads it

Dependency installs pass `--ignore-scripts`, because the evaluated tree is code
an agent wrote and a `preinstall`/`postinstall` would run before any human
review. The symptom is **not** a failing install — the module installs unbuilt
and then fails at load. If your build genuinely needs lifecycle scripts
(native modules, a `prepare` step), set `allowInstallScripts: true` on the
`sandbox` evaluator.

### A change that passed before now fails on re-evaluation

Re-evaluating runs under the current defaults, and the default install timeout
dropped from 120s to 90s. Re-check against `totalBudgetMs` above.

## Merging

### `STALE_BASE` / `STALE_WORKSPACE` / `WORKSPACE_UNVERIFIABLE`

The change was evaluated against code that is no longer what would land.
Re-evaluate on the current base. `STALE_WORKSPACE` specifically means the
workspace advanced *after* evaluation, so unevaluated commits can never slip in.

### Approvals disappeared

Approvals are dismissed when the evaluated **base** moves, not only when the
tip does — a change re-evaluated against a newer base was previously keeping
approvals that had been granted against different code.

### `PROTECTION_BLOCKED`

The response lists the specific `reasons`. Common ones:

- Not enough approvals. Remember the **change author's own approval does not
  count**; for an agent-created change the excluded author is the agent's
  owning user.
- The change edits the merge-protection config, which requires an approval
  even when `requiredApprovals` is 0.

### `MERGE_CONFLICT`

The response carries a conflict id for
`POST /api/projects/conflicts/{id}/resolve`. Manual resolutions are **not** a
back door: they are secret-scanned and run through the full merge gate,
reusing the originating change's review trail.

## Projects and access

### `404` on a project you believe exists

Read access is checked before existence is revealed, so an unauthorised private
project is a `404`, not a `403`. Check the namespace and slug, and that your
token's owner has access.

### `409 TARGET_DELETING`

The project, or its owner's account, is being deleted. Writes are refused so
the cascade is not fighting new rows.

## Getting help

Include the machine-readable `code` where there is one, the project path, and
the change or issue number. Open an issue on
[GitHub](https://github.com/stratum-eng/stratum/issues).
