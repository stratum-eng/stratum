# Spike Plan: Option B — Warm RepoDO Cache

**Goal:** Kill clone-per-operation on the commit/merge hot path and produce a
**measured** single-repo throughput number (commits/sec, p50/p95 latency, and a
per-phase breakdown). This is the evidence-gathering stage from
[ADR 004](../adr/004-high-frequency-agent-commits.md) — it does **not** build the
owned object store (Option A). We instrument first, warm the cache second, then
decide whether the remaining gap justifies Option A.

**Target effort:** ~1–2 weeks. **Exit criterion:** a before/after number we
trust, plus a go/no-go recommendation on Option A.

---

## Phase 0 — Instrument the current path (get the "before" number)

We cannot improve what we have not measured. Before touching architecture,
capture where the seconds go today.

- [ ] Add phase timings around each step in the merge path: token mint, clone,
      fetch, merge, push, D1 update. Wrap the calls in
      `src/storage/git-ops.ts` (`mergeWorkspaceIntoProject`, `cloneRepo`,
      `commitAndPush`) and `src/queue/merge-queue.ts` (`MergeQueue.merge`).
- [ ] Emit timings through the existing metrics path
      (`src/storage/metrics.ts`, surfaced at `/api/admin/metrics`) rather than
      inventing a new sink. Add a `commit_phase_timings` table/rollup or reuse
      the import-metrics shape.
- [ ] Write a load harness under `scripts/` (e.g. `bench-commit-throughput.ts`,
      alongside the existing `scripts/*.ts`) that fires N concurrent commits at
      **one** repo and reports: commits/sec, p50/p95/p99 end-to-end latency, and
      the per-phase breakdown. Parameterize N (1, 5, 25, 100) and commit size.
- [ ] Run it against staging. Record the baseline in this doc's Results table.

**Deliverable:** the honest current number, replacing "I think ~1–2/sec," and a
breakdown proving clone+push dominate (the ADR's hypothesis).

## Phase 1 — Warm RepoDO cache (remove clone-per-op)

- [ ] Introduce a per-repo Durable Object (extend `MergeQueue` into `RepoDO`, or
      add `RepoDO` and have `MergeQueue` delegate). One instance per project
      repo, keyed by project id.
- [ ] Cache warm state in DO storage between operations: packed refs + a hot
      object index, so a commit no longer triggers a cold `git.clone`
      (`depth: 50`) every time. Large blobs stay in Artifacts; the DO holds
      refs + index, not the whole working tree.
- [ ] Route commits through the DO: write objects, then ask the DO to apply the
      change against its warm state and push to Artifacts. Keep the existing
      cold path as a fallback when the cache is empty or stale.
- [ ] Keep the persisted commit/merge semantics identical — this phase is a
      latency change, not a behavior change. Existing tests
      (`tests/git-ops.test.ts`, `tests/changes.test.ts`,
      `tests/merge-protection.test.ts`) must stay green.

**Deliverable:** commits that reuse warm state instead of re-cloning; the
clone phase drops out of the Phase 0 breakdown.

## Phase 2 — Fast-forward CAS + optimistic concurrency

- [ ] Commit carries `expectedParent`. The DO does an in-memory compare-and-swap
      on `refs/heads/main`: if `head == expectedParent`, fast-forward and return;
      this is the common case at high frequency (concurrent agents mostly touch
      different files). Mirrors the optimistic-locking `version` CAS already used
      for import state in [ADR 003](../adr/003-d1-for-import-state.md).
- [ ] On CAS miss (raced), **do not reject** — enqueue to a resolve step that
      rebases the incoming tree onto the new head and re-attempts the CAS. For
      this spike the resolver can be the mechanical three-way tree merge only;
      LLM auto-resolution of true same-hunk overlaps is explicitly out of scope
      (it lives in the resolve plane and reuses the existing evaluator later).
- [ ] (Stretch) Batch: drain N queued advances, one combined tree, one CAS, one
      push — the load-bearing version of the `TODO.md` "batch merging" item.

**Deliverable:** the serialization window shrinks from a full merge to a ref
CAS; throughput should jump on the concurrent-N runs.

## Phase 3 — Re-measure and decide

- [ ] Re-run the Phase 0 harness unchanged. Fill in the "after" column.
- [ ] Compare against the ~20+ commits/sec single-repo target and write a
      go/no-go recommendation on Option A: if Option B (bounded by Artifacts'
      ref-update latency) lands close enough, Option A may be unnecessary; if a
      real gap remains, the measured number justifies the quarter-scale build.
- [ ] Update ADR 004 status (Proposed → Accepted/Superseded) based on findings.

---

## Out of scope for this spike

- Owning the object store / R2-direct plumbing (Option A).
- LLM-assisted conflict resolution (resolve plane intelligence).
- Containerized native-git backend for gc/repack/large packs.
- Changing the fork-per-workspace model; this runs alongside it.

## Results (fill in as we go)

| Metric (single repo)        | Before (Phase 0) | After (Phase 2) | Target |
|-----------------------------|------------------|-----------------|--------|
| Commits/sec (N=25)          | TBD              | TBD             | ~20+   |
| p50 end-to-end latency      | TBD              | TBD             | —      |
| p95 end-to-end latency      | TBD              | TBD             | —      |
| Clone phase share of total  | TBD              | ~0 (removed)    | —      |

## References

- [ADR 004](../adr/004-high-frequency-agent-commits.md) — the architecture this
  spike de-risks
- Hot path: `src/storage/git-ops.ts`, `src/queue/merge-queue.ts`
- Metrics: `src/storage/metrics.ts`, `src/routes/metrics.ts`
  (`/api/admin/metrics`)
- Related tests: `tests/git-ops.test.ts`, `tests/merge-protection.test.ts`,
  `tests/conflict-resolution.test.ts`
