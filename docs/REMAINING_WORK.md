# Remaining Work

Last updated: 2026-06-12

The master-plan feature roadmap (Phases 0–3 plus the code-level Phase 4
hardening items) is complete as of 2026-06-11. See
[CURRENT_CAPABILITIES.md](./CURRENT_CAPABILITIES.md) for what exists and its
limitations. This doc tracks everything that remains, with context on why each
item is open and what it unblocks.

## Phase 4: operational / scale (Stratum Cloud)

These are the items required to run Stratum as a hosted, multi-tenant service.
None of them block current single-tenant usage.

### Load testing

Validate 1000+ concurrent workspaces per repo. Exercises the merge queue
Durable Object, D1 write throughput, and Artifacts under contention. Should
establish baseline latency/error budgets before any public hosting.

### D1 hot/cold rotation

Move data older than 30 days (events, audit entries, evaluation evidence) from
D1 to R2. Keeps the hot database small and query latency predictable as event
volume grows.

### Batch merging in the merge queue

The merge queue Durable Object currently merges changes one at a time. Batch
merging (test N queued changes together, bisect on failure) increases
throughput when the queue is deep.

### SSO/SAML

Enterprise sign-in alongside the existing magic-link, GitHub OAuth, and Google
OAuth options. Required for most paid team adoption.

### Multi-tenancy and billing

Tenant isolation, usage metering, and billing integration for Stratum Cloud.
Per-change cost tracking (LLM tokens, sandbox time, git ops) already exists
and provides the metering foundation.

### Backup strategy

Scheduled backups and tested restore paths for D1 and Artifacts data. Today a
loss of either store is unrecoverable.

### Monitoring dashboard UI

A metrics API already exists at `/api/admin/metrics`; this item is a UI over
it (queue depth, evaluation latency, error rates, event outbox lag).

## Engineering debt

Known shortcuts that are fine at current scale but should be paid down.

### Migrate project/workspace identity from KV to D1

Project and workspace identity records live in KV, which has no listing or
transactional guarantees. Migrating to D1 unblocks `workspace.deleted` events
and removes the scan fallback in `getProject`.

### Async evaluation worker

Evaluation currently runs synchronously at change creation, so change creation
latency includes the full evaluator suite (LLM, sandbox). Moving evaluation to
a queue-backed worker keeps change creation fast and allows retries; fine at
current scale.

### Per-project team permission grants

Team write/admin grants are org-wide. Per-project grants allow finer-grained
access control within an org.

### Publish @stratum/cli and @stratum/agent to npm

Both packages live in the repo at full API parity but are not yet published,
so consumers must install from source.

## Deferred UX recommendation

From [research/master-plan-alignment.md](./research/master-plan-alignment.md),
not a master-plan line item:

### Client-side unified/split diff toggle

The diff viewer
([`src/ui/components/diff-view.tsx`](../src/ui/components/diff-view.tsx))
renders unified diffs
only. The alignment research recommends a split-view toggle that switches
client-side — no page reload or content refetch — as a differentiator over
GitHub/GitLab, which require a full reload to switch views.
