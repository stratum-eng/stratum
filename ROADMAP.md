# Roadmap

This file tracks what is **not yet shipped**. Everything that *is* shipped is described in
[`README.md`](README.md) and, in full detail with its caveats, in
[`docs/CURRENT_CAPABILITIES.md`](docs/CURRENT_CAPABILITIES.md). Keeping the two apart is
deliberate: the README carries no status markers, so it can't drift out of sync with them.

[`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md) holds the rationale for each item below —
why it's open, and what it unblocks. Dates and per-change detail live in
[`CHANGELOG.md`](CHANGELOG.md).

Want to pick something up? See [CONTRIBUTING.md](CONTRIBUTING.md). Items here are
deliberately coarse; open an issue to discuss an approach before starting a large one.

## Where things stand

The master-plan feature roadmap — Phases 0–3, plus the code-level Phase 4 hardening — has
been complete since 2026-06-11.

| Phase | Delivered |
|---|---|
| 0 | Fork/commit/merge loop on Artifacts, GitHub import |
| 1 | D1 persistence, authentication, evaluation engine, web UI |
| 2 | LLM evaluator, sandbox execution, event-driven pipeline, Durable Object merge queue, provenance |
| 3 | Organizations and teams, CLI, reference agent, bidirectional GitHub sync, issue tracker |
| 4 (code) | Audit trail, backup/restore, deletion jobs, gated `git push` (ADR 005), security hardening |

What remains is Phase 4's **operational** half — the work required to run Stratum as a
hosted, multi-tenant service — plus engineering debt and the feature gaps below. None of it
blocks single-tenant self-hosted usage.

Post-merge deployments shipped on 2026-09-04 (`deploys:` in `.stratum/policy.yaml`,
targeting Cloudflare and Vercel). What that first version deliberately left out is tracked
under [Deployments](#deployments).

## Operational / scale (Stratum Cloud)

- [ ] **Load testing** — validate 1000+ concurrent workspaces per repo; establish latency
      and error budgets before any public hosting.
- [ ] **D1 hot/cold rotation** — move events, audit entries, and evaluation evidence older
      than 30 days to R2 to keep the hot database small.
- [ ] **Batch merging in the merge queue** — the merge queue Durable Object merges one
      change at a time. Test N queued changes together and bisect on failure. (The
      server-side `changes/merge-batch` endpoint already does this for an explicit batch;
      this item is the queue doing it automatically.)
- [ ] **SSO/SAML** — enterprise sign-in alongside magic-link, GitHub OAuth, and Google OAuth.
- [ ] **Multi-tenancy and billing** — tenant isolation, usage metering, billing. Per-change
      cost tracking already exists and provides the metering foundation.
- [ ] **Monitoring dashboard UI** — a UI over the existing `/api/admin/metrics` (queue
      depth, evaluation latency, error rates, event outbox lag).
- [x] **Backup strategy for D1 and Artifacts** — daily and on-demand backups to R2 with a
      tested restore path ([runbook](docs/runbooks/backup-restore.md)).

## Engineering debt

- [ ] **Migrate project/workspace identity from KV to D1** — KV has no listing or
      transactional guarantees. Unblocks `workspace.deleted` events and removes the scan
      fallback in `getProject`.
- [ ] **Async evaluation worker** — evaluation runs synchronously at change creation, so
      change-creation latency includes the full evaluator suite. A queue-backed worker keeps
      creation fast and allows retries. Fine at current scale.
- [ ] **Per-project team permission grants** — team write/admin grants are org-wide today.

### Publish the client packages to npm

- [ ] `@stratum/cli` and `@stratum/agent` both live in this repo at full API parity, but
      neither is published, so consumers must build from source. Publishing needs a release
      workflow, provenance attestation, and a version policy across the two. (The MCP
      server no longer needs publishing at all — it is served by the Worker at `/mcp`.)

## Feature gaps

### Deployments

Post-merge deploys ship; what follows is what the first version left out. Ordered by how
much each unblocks — the build step gates everything below it, because until a deploy can
build, the set of projects this serves stays small. Rationale for each in
[`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md#deployments).

- [ ] **A build step.** v1 deploys the tree *as committed*, so it serves static sites,
      single-file Workers, and `vercel` (which builds the uploaded source remotely) — not
      the median project that runs `npm run build` first. The design is already drawn: build
      in a sandbox with **no credentials** and egress denied, then let the Worker upload the
      artifact, so the untrusted step and the credentialed step stay apart. Two
      prerequisites: enable the `[[sandboxes]]` binding (still commented out in
      `wrangler.toml`, so nothing that executes code runs on any deploy today), and replace
      `materializeTree`'s file-by-file base64 write with a `git clone` inside the sandbox.
- [ ] **Deployment status that reflects the provider.** A `vercel` row reads `succeeded`
      when Vercel has only *accepted* the upload; a deploy that later fails to build still
      reads green. Needs a non-terminal state completed by polling or a provider webhook.
- [ ] **Rollback.** Retrying an earlier successful commit is the only recovery today, and it
      rebuilds rather than reverting. Both Cloudflare and Vercel can promote a previous
      deployment by id, so storing that id turns rollback into one API call.
- [ ] **Environments and promotion.** `deploys:` is a flat list of names. The model people
      expect is staging → production, where production is a *promotion* of an artifact that
      already passed staging, gated by an approval an agent cannot supply. Every piece
      exists — the approval gate, the deployment record, the audit trail, the
      agents-cannot-approve invariant — except the environment as a first-class object and a
      "what is live where" view.
- [ ] **Preview deploys for unmerged changes.** The most-requested and the most dangerous:
      it publishes agent-authored code that no human has approved. Needs the build step
      first and a **separate preview-scoped credential**, never the production token behind
      a flag.
- [ ] **Netlify target.** The provider interface takes it; nobody has written it.
- [ ] **Operational gaps.** A batch merge (`changes/merge-batch`) triggers neither the
      post-merge check nor a deploy. Outbox recovery fires when a failed enqueue is
      *observed*, so an isolate that dies between the status write and the send still strands
      a `queued` row that nothing reclaims — a stale-queued sweep would close it. Rotating
      `DEPLOY_SECRET_KEY` makes every stored secret undecryptable with no re-encryption path.

### Git LFS support

- [ ] Stratum has no LFS support at all: no `/info/lfs` route, no `objects/batch` endpoint,
      and a 50 MB git push body cap, so large-binary workflows are blocked entirely. An
      implementation needs the LFS batch API plus transfer endpoints, an R2 object store
      addressed by OID, and pointer awareness in the browse and diff surfaces. Until then,
      keep LFS repos on GitHub and use layer mode. Details in
      [`docs/REMAINING_WORK.md`](docs/REMAINING_WORK.md#git-lfs-support).

### Diff depth

- [ ] Per-line intra-hunk highlighting and binary-file diffs. Hunk-level unified and split
      views already ship.

### Merge conflict resolution for changes

- [ ] A conflicting three-way merge is **refused**, not silently squashed: the merge answers
      `409 MERGE_CONFLICT` with a `conflictId` and the conflicting paths. What is missing is
      an interactive way to resolve one for a *change* — resolution today is the out-of-band
      `POST /api/projects/conflicts/{id}/resolve` (`accept-project`, `accept-workspace`, or
      `manual`). (GitHub *sync* conflicts do have a resolution UI.)

## Explicitly not planned

- **SSH transport for git.** Workers have no raw TCP listener. Smart HTTP is the supported
  transport; [ADR 006](docs/adr/006-ssh-transport.md) records what SSH would take, should
  the decision be revisited.
- **Moving git operations off the Worker.** Git runs in-memory via isomorphic-git, which
  caps usable repository size. Containers or a backend service would lift that ceiling; it
  is a plausible future direction rather than committed work.
