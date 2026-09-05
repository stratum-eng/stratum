# Stratum Current Capabilities

Last updated: 2026-09-04 — reflects completion of the master-plan feature roadmap
(Phases 0–3 plus the code-level Phase 4 hardening items), plus post-merge
deployments, scoped API tokens, the MCP server and browser-based CLI login, and
the Git LFS and submodule limitations recorded below.

> **Read the caveats, not just the bullets.** Two capabilities below exist in
> code but cannot be used on a stock instance, because the Cloudflare Sandboxes
> binding they need is a gated beta and is **commented out in `wrangler.toml`**
> (`# [[sandboxes]]`, `wrangler.toml:156` — the only occurrence in the file, and
> named environments do not inherit top-level bindings). See
> [Sandbox-dependent features](#sandbox-dependent-features-unavailable-by-default).

## Core platform

- Cloudflare Worker (Hono) on Artifacts, KV, D1, Queues, R2 (backups), Workers
  AI, Analytics Engine, Email, and three Durable Objects — `MergeQueue`,
  `RepoDO` and `MagicLinkRateLimiter` (`src/index.ts:52`, `wrangler.toml:78`).
- Project create/import (GitHub/GitLab/Bitbucket), workspace fork/commit/delete,
  change creation with synchronous evaluation, evaluation-gated merge, provenance
  (records the agent, the model and prompt hash snapshotted at change creation, and
  the eval score per merged commit; full per-evaluator evidence is linked by change).
- Project resolution accepts namespace/slug refs, legacy names, and falls back to a
  scan — the change/review APIs work for all project generations.
- Org-owned projects: org membership grants read; org owner/admin role or a
  write/admin team grants write. Agents inherit their owning user's access.

## Evaluation & merge pipeline

- Evaluators: secret scan (always on, blocking), diff, webhook, LLM (AI binding),
  sandbox (Sandboxes binding — **unavailable by default**, see below). Per-change
  evaluator evidence and estimated resource costs (LLM tokens, sandbox time, git
  ops).
- Branch protection in `.stratum/policy.yaml` (`merge:`): required evaluators
  (latest run per type), required human approvals, force-merge control
  (**deny-by-default** — force is only allowed when the policy sets
  `merge.allowForce: true`), and staleness rejection: `requireFreshBase` blocks a
  moved project base (409 STALE_BASE), and a merge is rejected if the workspace
  advanced since it was evaluated (409 STALE_WORKSPACE).
- Post-merge smoke command in a sandbox with auto-revert (forward revert commit,
  change marked `reverted`, `change.reverted` event) — **unavailable by
  default**, see below.
- Post-merge deployments in `.stratum/policy.yaml` (`deploys:`): a named list of
  deploys, each with a `target` (`cloudflare-pages`, `cloudflare-workers`,
  `vercel`), an optional `dir`, declared `secrets`, and an optional
  `requiresApproval` gate. Triggered only when the post-merge check did not
  revert or fail — a check that was *skipped* (no `postMergeCommand`, or no
  Sandboxes binding) does not hold a deploy back
  (`src/queue/deploy-queue.ts:361`), so deployments work on a stock instance even
  though the smoke check does not. Run from a queue consumer against the tree at
  the pinned merge commit, with per-project AES-GCM-encrypted secrets
  (`DEPLOY_SECRET_KEY` required; project admins only, agents refused),
  supersession of older deploys of the same name, retry as a new attempt (open to
  an agent with write access, unlike approval), and `deployment.requested` /
  `deployment.succeeded` / `deployment.failed` events. **No build step, no
  preview deploy, and no rollback** — see `user-guide/deployments.md`. A batch
  merge (`changes/merge-batch`) triggers neither the post-merge check nor a
  deploy. The deploy DLQ (`stratum-deploys-dlq`) has no consumer: dead-lettered
  messages sit there for manual inspection.
- Human reviews (approve / request changes) move the change state machine and are
  human-only; agents cannot approve work.

### Sandbox-dependent features (unavailable by default)

`[[sandboxes]]` is a gated Cloudflare beta and is commented out in
`wrangler.toml` (`wrangler.toml:155-157`; it appears nowhere else, and named
environments do not inherit top-level bindings). Unless an operator has
Sandboxes access and uncomments it, `env.SANDBOX` is absent on **every**
environment, including the maintainer's hosted instance, with two consequences:

- **The `sandbox` evaluator is not skipped — it fails closed.**
  `buildEvaluators` substitutes an `UnavailableEvaluator` that returns score 0
  / failed (`src/services/change-flow.ts:137-152`), so naming `sandbox` in
  `merge.requiredEvaluators` **blocks every merge in that project** until the
  binding is enabled or the evaluator is removed from the policy.
- **`merge.postMergeCommand` is silently skipped**, returning
  `{ status: "skipped", reason: "Sandbox binding is not configured" }`
  (`src/merge/post-merge.ts:39-43`). Nothing runs and nothing is reverted.

This repo's own `.stratum/policy.yaml` uses only `diff` and `llm` and sets no
`postMergeCommand`, so it avoids both. The `llm` evaluator has the same
fail-closed shape when the AI binding is absent
(`src/services/change-flow.ts:129-136`), but `[ai]` **is** bound in every
environment (`wrangler.toml:75`), so it works out of the box.

## Events & integrations

- Durable event outbox in D1 → queue consumer with handler registry → 5-minute
  sweep cron re-enqueues stale events. At-least-once processing.
- Per-project activity feed (UI + API) over the event stream.
- Per-project webhooks with HMAC-SHA256-signed deliveries, event filters,
  delivery log, SSRF-guarded URLs.
- Issue tracker with per-project numbering and auto-close when a linked change
  merges. Bidirectional GitHub sync (inbound webhooks, outbound PR promotion).
- Remote **MCP server** at `/mcp` (a protected resource of the OAuth server
  above), advertising `tools` only — 18 tools spanning whoami, projects, files,
  activity, workspaces, commits, changes (create/list/get/review/merge/reject)
  and issues (`src/mcp/tools.ts:113-288`). The tools call the same route
  handlers as the REST API, so scope and agent-identity rules apply unchanged.

## Auth & security

- Magic-link email auth, GitHub OAuth, Google OAuth (email-identity model), and
  named API tokens (`read` or `read_write`, optionally expiring after 1–365
  days, individually revocable, 20 active per user —
  `src/storage/api-tokens.ts:15-21`); agent tokens bounded by an owning user's
  access. A `read` token is refused on every non-`GET`/`HEAD` request before
  routing (`src/middleware/auth.ts:227-241`) and on `git push`.
- Stratum is itself an **OAuth 2.1 authorization server** (RFC 7591 dynamic
  registration, PKCE `S256` only): grants carry `mcp:read`/`mcp:write`, a
  1-hour access token and a rotating 30-day refresh token capped at 180 days
  absolute (`src/storage/oauth.ts:58-71`), and are revocable at
  `POST /oauth/revoke` or from **Settings → Connected applications**.
- CSRF protection (Origin/Referer enforcement for session-cookie mutations),
  API key rotation, settings UI for API token, agent token and OAuth grant
  management. Token management endpoints accept the browser session **only**
  (`SESSION_REQUIRED`, `src/routes/users.ts:130-142`).
- Append-only audit trail for sensitive operations with an admin query API;
  admin access requires `ADMIN_API_KEY` or the `ADMIN_EMAIL` user (fails closed),
  and an OAuth grant is refused on `/api/admin/*` before routing even when its
  owner is the instance admin (`src/middleware/auth.ts:344-358`).
- Rate limiting (global + import-specific), secret scanning on every change,
  workspace TTL sweep.

## UI

- Server-rendered (Hono JSX): dashboard, repo browser with collapsible file tree,
  syntax-highlighted file viewer (dependency-free lexer), commit log, changes with
  diff viewer + evaluator evidence + costs + reviews + comments, issues, activity,
  webhooks management, deployments (history, log tail for writers, Approve and
  Retry buttons), deploy-secret management in project settings, settings. Open
  changes poll via meta refresh.

## Tooling

- `cli/` — @stratum/cli covering projects, workspaces, commits, changes incl.
  review/merge, issues, activity and account. `stratum login` is a
  browser-based OAuth 2.1 + PKCE flow against a loopback redirect (RFC 8252),
  with `--read-only` for an `mcp:read` grant and `--key <token>` as the
  headless path for CI (`cli/src/index.ts:54-133`); `stratum logout` always
  clears the local credential and revokes the grant on a best-effort basis
  (`cli/src/index.ts:148-171`). Deployments have no CLI command yet — use the
  API or the UI.
- `agent/` — @stratum/agent reference agent: identity → fork → Claude edit plan
  → commit → Change with evaluation.

## Known limitations / future work

- Project/workspace identity lives in KV; changes, issues, events, costs, and
  audit live in D1. Full identity migration to D1 is future work (so is
  `workspace.deleted` event emission, blocked on an id→name index).
- Evaluation runs synchronously at change creation; the event pipeline is async
  but evaluation itself has no queue worker yet.
- Team permissions are org-wide; per-project team grants are not implemented.
- The Cloudflare Sandboxes binding is a gated beta and is commented out in
  `wrangler.toml`, so the `sandbox` evaluator and `merge.postMergeCommand` are
  unusable on a stock instance — see
  [Sandbox-dependent features](#sandbox-dependent-features-unavailable-by-default).
- Deployments have no build step, no preview environment and no rollback, and
  the deploy DLQ has no consumer.
- Phase 4 operational items remain: load testing at 1000+ concurrent workspaces,
  D1 hot/cold rotation, SSO/SAML, multi-tenancy/billing for Stratum Cloud.
- Durability is covered: D1 and KV identity back up to R2 daily and on demand,
  along with the reachable history of a rotating slice of repos (coverage rotates
  across runs under a per-run cap), with a tested restore path
  (`docs/runbooks/backup-restore.md`).
- Git submodules are not supported (#258). A gitlink tree entry (mode 160000)
  at any depth, or a root-level `.gitmodules` file, is detected and rejected at
  the three points repo content enters Stratum — GitHub import, a gated push,
  and REST change creation (the last two share one scan, in the diff the change
  gate computes). The rejection carries the `SUBMODULES_UNSUPPORTED` code
  internally, but each entry point reports it in its own transport's terms: a
  gated push answers 200 with a per-ref `ng` reason and a permanent
  `push rejected` message, `POST /api/projects/{name}/changes` answers 400 with
  the explanatory message, and an import records the queue job as `failed`
  rather than answering any request at all. Change creation fails
  closed unconditionally: submodule content is refused, and so is a change
  whose scan could not run — that is the gate that keeps submodule content out
  of a server-side merge, which would otherwise corrupt it silently
  (isomorphic-git's checkout drops a gitlink from the materialized working
  tree). The import guard is deliberately best-effort: if the imported tree
  cannot be read at all — the read token cannot be minted, the clone fails, or
  the scan itself errors — the import proceeds with a warning and is left
  unscanned rather than failing a healthy repo on an infrastructure hiccup, so
  a completed import is not on its own proof the repo is submodule-free.
  Recursive submodule clone/browse is future work; see
  `user-guide/importing.md#unsupported-content`.

## Git LFS: not supported

Git LFS is entirely absent from Stratum:

- The git smart-HTTP router (`src/routes/git-http.ts`) exposes only
  `info/refs`, `git-upload-pack`, and `git-receive-pack` for projects and
  workspaces. There is **no `/info/lfs` route and no `objects/batch`
  endpoint**, so an LFS-enabled clone or push fails when the `git lfs` client
  calls the batch API — the request falls through to the app's 404 handler
  (`{"error": "Not found"}`).
- Nothing server-side understands LFS pointer files: browse and diff render a
  pointer file as its small text content, and imports bring over pointers,
  not the binaries behind them.
- Git push request bodies are capped at **50 MB**
  (`MAX_GIT_BODY_BYTES = 50 * 1024 * 1024` in `src/routes/git-http.ts`), so
  committing large binaries directly instead of via LFS is also blocked
  beyond that size.

Together these mean large-binary workflows are not viable on Stratum today.
Practical guidance:

- Keep binaries out of Stratum-hosted repos (generated assets, models, media
  belong in object storage referenced by URL).
- Keep LFS-dependent repos on GitHub and use **layer mode** (bidirectional
  sync) so agent work still flows through Stratum's gates.

Supporting LFS would require, at minimum: implementing the LFS batch API
(`POST <repo>.git/info/lfs/objects/batch`) plus the transfer endpoints, an R2
object store for LFS content addressed by OID, and pointer-file awareness in
the browse/diff surfaces so pointers resolve to their objects. This is
tracked as future work in `REMAINING_WORK.md`.
