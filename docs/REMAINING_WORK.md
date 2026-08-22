# Remaining Work

Last updated: 2026-08-17

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

## Feature gaps

### Git LFS support

Stratum has no Git LFS support at all — the smart-HTTP router serves only
`info/refs`, `git-upload-pack`, and `git-receive-pack`; there is no
`/info/lfs` route or `objects/batch` endpoint, so LFS-enabled clones fail at
the batch call with a 404. With the 50 MB git push body cap
(`MAX_GIT_BODY_BYTES` in `src/routes/git-http.ts`), large-binary workflows
are blocked entirely (see the "Git LFS: not supported" section in
[CURRENT_CAPABILITIES.md](./CURRENT_CAPABILITIES.md)).

An implementation would require:

- **LFS batch API**: `POST <repo>.git/info/lfs/objects/batch` plus
  upload/download transfer endpoints, authenticated with the same API-key
  Basic auth as the git router.
- **R2 object store** for LFS content, addressed by OID (SHA-256), with
  size verification on upload.
- **Pointer handling in browse/diff**: detect LFS pointer files and resolve
  or label them instead of rendering the raw pointer text.

Until then, the guidance is: keep binaries out of Stratum-hosted repos, or
keep LFS-dependent repos on GitHub in layer mode.

## Deferred UX recommendation

From [research/master-plan-alignment.md](./research/master-plan-alignment.md),
not a master-plan line item:

### Client-side unified/split diff toggle — ✅ done

The diff viewer
([`src/ui/components/diff-view.tsx`](../src/ui/components/diff-view.tsx))
now renders both views and switches instantly with a pure-CSS checkbox toggle —
no page reload, no content refetch, and no client-side JavaScript, preserving
the server-rendered-only invariant.
