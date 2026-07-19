# Stratum Current Capabilities

Last updated: 2026-06-11 — reflects completion of the master-plan feature roadmap
(Phases 0–3 plus the code-level Phase 4 hardening items).

## Core platform

- Cloudflare Worker (Hono) on Artifacts, KV, D1, Queues, and a merge Durable Object.
- Project create/import (GitHub/GitLab/Bitbucket), workspace fork/commit/delete,
  change creation with synchronous evaluation, evaluation-gated merge, provenance.
- Project resolution accepts namespace/slug refs, legacy names, and falls back to a
  scan — the change/review APIs work for all project generations.
- Org-owned projects: org membership grants read; org owner/admin role or a
  write/admin team grants write. Agents inherit their owning user's access.

## Evaluation & merge pipeline

- Evaluators: secret scan (always on, blocking), diff, webhook, LLM (AI binding),
  sandbox (Sandboxes binding; fails closed when absent). Per-change evaluator
  evidence and estimated resource costs (LLM tokens, sandbox time, git ops).
- Branch protection in `.stratum/policy.yaml` (`merge:`): required evaluators
  (latest run per type), required human approvals, force-merge control, and
  `requireFreshBase` staleness rejection (409 STALE_BASE).
- Post-merge smoke command in a sandbox with auto-revert (forward revert commit,
  change marked `reverted`, `change.reverted` event).
- Human reviews (approve / request changes) move the change state machine and are
  human-only; agents cannot approve work.

## Events & integrations

- Durable event outbox in D1 → queue consumer with handler registry → 5-minute
  sweep cron re-enqueues stale events. At-least-once processing.
- Per-project activity feed (UI + API) over the event stream.
- Per-project webhooks with HMAC-SHA256-signed deliveries, event filters,
  delivery log, SSRF-guarded URLs.
- Issue tracker with per-project numbering and auto-close when a linked change
  merges. Bidirectional GitHub sync (inbound webhooks, outbound PR promotion).

## Auth & security

- Magic-link email auth, GitHub OAuth, Google OAuth (email-identity model), and
  API keys; short-lived agent tokens scoped to an owning user.
- CSRF protection (Origin/Referer enforcement for session-cookie mutations),
  API key rotation, settings UI for key + agent token management.
- Append-only audit trail for sensitive operations with an admin query API;
  admin access requires `ADMIN_API_KEY` or the `ADMIN_EMAIL` user (fails closed).
- Rate limiting (global + import-specific), secret scanning on every change,
  workspace TTL sweep.

## UI

- Server-rendered (Hono JSX): dashboard, repo browser with collapsible file tree,
  syntax-highlighted file viewer (dependency-free lexer), commit log, changes with
  diff viewer + evaluator evidence + costs + reviews + comments, issues, activity,
  webhooks management, settings. Open changes poll via meta refresh.

## Tooling

- `cli/` — @stratum/cli at full API parity (projects, workspaces, commits,
  changes incl. review/merge, issues, activity).
- `agent/` — @stratum/agent reference agent: identity → fork → Claude edit plan
  → commit → Change with evaluation.

## Known limitations / future work

- Project/workspace identity lives in KV; changes, issues, events, costs, and
  audit live in D1. Full identity migration to D1 is future work (so is
  `workspace.deleted` event emission, blocked on an id→name index).
- Evaluation runs synchronously at change creation; the event pipeline is async
  but evaluation itself has no queue worker yet.
- Team permissions are org-wide; per-project team grants are not implemented.
- Phase 4 operational items remain: load testing at 1000+ concurrent workspaces,
  D1 hot/cold rotation, SSO/SAML, multi-tenancy/billing for Stratum Cloud.
- Durability is covered: D1 and KV identity back up to R2 daily and on demand,
  along with the reachable history of a rotating slice of repos (coverage rotates
  across runs under a per-run cap), with a tested restore path
  (`docs/runbooks/backup-restore.md`).
