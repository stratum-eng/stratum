# Remaining Work

Last updated: 2026-09-04 — records what post-merge deployments left out, now
that they ship.

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

The sandbox evaluator's share is now bounded by a total budget (`totalBudgetMs`,
default 150s — see ADR 007), so it can no longer run for the unbounded sum of
its per-phase timeouts. The `llm` evaluator still has no timeout at all, so
overall evaluation latency remains unbounded; that, and moving the whole suite
off the request path, are what this item still covers.

### Per-project team permission grants

Team write/admin grants are org-wide. Per-project grants allow finer-grained
access control within an org.

### Publish @stratum-eng/cli and @stratum-eng/agent to npm

Both packages live in the repo at full API parity but are not yet published,
so consumers must install from source.

## Feature gaps

### Deployments

Post-merge deploys shipped on 2026-09-04: `deploys:` in `.stratum/policy.yaml`
publishes the merged tree to Cloudflare static assets, a Cloudflare Worker
script, or Vercel, using per-project encrypted secrets. See
[user-guide/deployments.md](./user-guide/deployments.md) for what exists.

The shape of that first version is worth stating, because it explains every gap
below. Cloudflare's guidance for Sandboxes is explicit that live API keys must
not be passed into one, so the design separates the untrusted step from the
credentialed step: **the Worker calls the provider's HTTP API directly and the
credential never leaves it.** That is why there is no CLI in the deploy path
(and so no `npx` resolving a repo-supplied `node_modules/.bin/wrangler` with the
token in its environment), why the `command` escape hatch was cut, and why v1
needs no `SANDBOX` binding at all.

#### A build step

The single biggest limit. v1 deploys the tree *as committed*, which serves
static sites, single-file Workers, and `vercel` (whose API builds the uploaded
source remotely) — but not the median project, which runs `npm run build`.

The deploy half does not change: build in a sandbox with **no credentials** and
egress denied, then have the Worker upload the artifact. Two prerequisites:

- **Enable `[[sandboxes]]`.** It is still commented out in `wrangler.toml`, so
  nothing that executes code runs on any deployed instance — not the `sandbox`
  evaluator, not `merge.postMergeCommand`, and not a build.
- **`git clone` inside the sandbox** instead of `materializeTree`, which reads
  the tree into the Worker and writes it back file-by-file, base64-encoding
  binaries. Tolerable for uploading a committed `dist/`; not viable once
  `node_modules` is involved. Authenticated smart HTTP already exists
  (`src/routes/git-http.ts`), so a short-lived read token is enough.

If a build ever needs a private registry credential, that is the case for
Sandbox **outbound Workers**: the handler runs in the Workers runtime, holds the
secret, and attaches it to requests on the way out, so the container never sees
it.

#### Deployment status that reflects the provider

A `vercel` deployment is recorded `succeeded` when Vercel has *accepted* the
upload — its `readyState` is carried into the row's reason, but Stratum does not
poll, so a deploy that later fails to build still reads green. The same shape
will apply to any provider that builds asynchronously.

The fix is a non-terminal state completed by polling or a provider webhook,
which is the same machinery an async check-reporting API would need.

#### Rollback

Not modelled. Retrying an earlier successful commit is the only recovery, and it
re-runs the deploy rather than reverting to a known-good artifact. Both
Cloudflare and Vercel can promote a previous deployment by id, so recording that
id turns rollback into a single API call.

#### Environments and promotion

`deploys:` is a flat list of names with no relationship between them. The model
users expect is staging → production, where production is a **promotion** of an
artifact that already passed staging rather than a fresh deploy of the same
commit.

This is the item most worth doing for reasons beyond parity. The approval gate,
the deployment record, the audit trail, and the invariant that agent credentials
cannot approve all already exist; what is missing is the environment as a
first-class object and a "what is live where" view. Together they finish the
sentence the product has been writing since branch protection: an agent can
write code, open a change, and land it — and cannot ship it to customers.

Build provenance follows cheaply from the same records: which agent, model and
prompt produced the commit is already stored, so attesting that an artifact was
built from that commit and deployed by a named human is an extension rather than
new infrastructure.

#### Preview deploys for unmerged changes

The most-requested and the most dangerous, because it publishes agent-authored
code that no human has approved — the case v1 deliberately excluded by running
only after merge. It needs the build step first, and a **separate
preview-scoped credential**; reusing the production token behind a flag would
undo the reason the credential never enters a sandbox.

#### Netlify

The `DeployTarget` interface accommodates it and nothing else blocks it.

#### Operational gaps

- **`changes/merge-batch` triggers neither the post-merge check nor a deploy.**
  Batch-merged changes silently never deploy. Pre-existing asymmetry in that
  endpoint, surfaced by the deploy work rather than caused by it.
- **The outbox recovery window.** A failed `DEPLOY_QUEUE.send` is recorded to the
  event outbox and re-enqueued by the five-minute sweep — but only when the
  failure is *observed*. An isolate that dies between the status write and the
  send leaves a `queued` row nothing reclaims. A stale-queued sweep over
  `deployments` would close it.
- **`DEPLOY_SECRET_KEY` rotation.** Rotating it makes every stored secret
  undecryptable, with no re-encryption path; the runbook says so, but the fix is
  a re-encrypt job.
- **Approval strength.** The gate refuses agent identities, but a user's scoped
  API token and MCP OAuth grants both set `userId` and are accepted, so it means
  "not an agent" rather than "a human at a keyboard". `cannotMintLegacyCredential`
  in `src/middleware/auth.ts` shows the stronger session-vs-token distinction the
  routes would need.
- **A deploy-only policy still needs an `evaluators:` block.** A policy file
  without one is treated as malformed, which blocks *all* merges with an error
  about evaluators — a poor first-hour experience for someone who only wanted a
  deploy. Relaxing it changes when the merge gate fails closed, so it needs its
  own decision rather than being folded in.

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
