# ADR 004: High-Frequency Agent Commits to a Shared Repo

## Status

Proposed

## Context

The current commit/merge path was designed for a fork-per-workspace model:
each agent or human works in an isolated workspace repo and merges into the
project repo deliberately, through an evaluation gate. That model is safe and
correct, but it assumes merges are *infrequent*.

A growing class of workloads breaks that assumption: **many agents editing the
same repository concurrently, at high frequency.** Competing forges are now
demonstrating sustained single-repo throughput (~20+ commits/sec into one repo,
plus hundreds of thousands of clones/pushes per hour) explicitly to remove Git
as a bottleneck once a swarm of agents edits one codebase at once.

We believe this parallel-agent pattern is where the ecosystem is heading, and
Stratum should be able to compete on it rather than only on isolation.

### Why we cannot do this today

Two architectural walls, both in `src/storage/git-ops.ts` and
`src/queue/merge-queue.ts`:

1. **Heavy work inside the serialization window.** Every merge does a full
   `git.clone` (`depth: 50`) into an in-memory filesystem, fetches the
   workspace remote, runs a three-way merge, and pushes the whole result back —
   and the push body is fully buffered because Workers cannot half-duplex
   stream (`git-ops.ts`, the custom `http.request`). Each commit is seconds of
   cold network round-trips to Artifacts.

2. **Per-project serialization with no fast path.** Merges run through the
   `MergeQueue` Durable Object (`merge-queue.ts`), one project per DO, one merge
   in flight at a time. That caps a single repo at ~1–2 merges/sec — and the DO
   does the heavy git work *itself*, so the cap is on seconds-long operations,
   not on the underlying coordination primitive.

`TODO.md` already lists the relevant gaps: "Batch merging in the merge queue
Durable Object" and "Load testing: 1000+ concurrent workspaces per repo."

### The core insight

A git commit is two operations with opposite concurrency profiles:

- **Object writes** (blobs, trees, commit objects) are content-addressed and
  immutable. They need **zero coordination** — the hash is the address, so any
  number of agents can write objects in parallel and never collide.
- **The ref update** (`refs/heads/main`: oldOid → newOid) is the *only*
  serialization point in git, and it is a compare-and-swap — microseconds, not
  seconds.

High single-repo throughput is not hard because of the CAS; it is hard because
today we do *seconds of heavy work inside the CAS window*. The fix is to move
everything except the ref CAS out of the serialized path.

## Decision

Adopt a **three-plane architecture** that separates object writes, ref updates,
and conflict resolution, and roll it out in two stages (Option B first, then
Option A if the metric still warrants it — see Alternatives).

```
        ┌─────────────────────────────────────────────┐
Agents  │   OBJECT PLANE  (no coordination)            │
  ──────┼──▶  write blobs/trees/commits ──▶  store     │  infinite fan-out
        │                                              │
        │   REF PLANE     (one authority per repo)      │
  ──────┼──▶  RepoDO: CAS on refs/heads/main           │  microsecond serialize
        │         ├─ fast-forward? done.                │
        │         └─ raced? ─┐                           │
        │                    ▼                           │
        │   RESOLVE PLANE (async, off the hot path)      │
        │      3-way tree merge → LLM only on overlap    │  true conflicts only
        └─────────────────────────────────────────────┘
```

1. **Object plane — no coordination.** Commit objects are written to the object
   store directly and in parallel. Because they are content-addressed, there is
   nothing to serialize. This is the part that must absorb "hundreds of
   thousands of writes/hour."

2. **Ref plane — one authority per repo.** Promote the per-project Durable
   Object from "merge serializer" to **repo ref authority**. It holds packed
   refs and a hot object index in memory (not the whole repo; large blobs stay
   in the object store). A commit becomes: *write objects → ask the DO to
   advance the ref.* The DO does an in-memory compare-and-swap:
   - `head == expectedParent` → fast-forward, return. This is the overwhelming
     majority of commits at high frequency, because concurrent agents mostly
     touch different files. The hot path is now a pointer write; a single DO
     sustains tens of thousands/sec.
   - `head != expectedParent` → the commit raced; hand it to the resolve plane.
     **Never reject on a race.**

3. **Resolve plane — async, off the hot path.** When the CAS loses a race,
   rebase the incoming tree onto the new head. Most races are not real
   conflicts (different files three-way merge mechanically). Only a genuine
   same-hunk overlap escalates, and *that* is where the existing LLM evaluator
   (AI Gateway) becomes an auto-resolver: it produces a resolved tree, which
   re-attempts the CAS like any other commit. The LLM call happens in the
   async resolve plane and never blocks the commit loop. This is the
   "automatic conflict resolution" capability, built from infrastructure we
   already have (`resolveConflict` in `git-ops.ts`, the LLM evaluator, and the
   `conflict-resolution.tsx` UI).

4. **Batch the CAS.** The DO drains N queued ref advances, computes one combined
   tree, performs one CAS, and writes one pack. This makes the already-cheap
   serialization point cheaper still and turns the existing "batch merging in
   the merge queue DO" TODO item into a load-bearing component.

### Rollout: Option B first

We will ship **Option B (warm DO cache in front of Artifacts)** first to stop
the clone-per-operation bleeding and obtain a real, measured single-repo
throughput number, *before* committing to the larger Option A rewrite.

- **Option B — keep Artifacts as the object store, add a warm `RepoDO` cache.**
  The DO caches refs and a hot object index so commits stop re-negotiating a
  packfile from a cold clone on every operation. Smaller lift (target: a 1–2
  week spike). Ref-path latency is still bounded by how fast Artifacts can
  apply a ref update, so this may not reach a true microsecond CAS — but it
  removes the dominant cost and tells us whether the remaining gap is worth
  Option A.

- **Option A — own the object store (object store + DO directly).** Maximum
  control over the ref-CAS path and true fast-forward semantics, at the cost of
  maintaining git plumbing (pack format, object writes) ourselves. This is the
  "warm git backend" the README has long called for. Pursue only if Option B's
  measured number shows the shared-repo benchmark still matters and the gap is
  real.

Heavy operations that need a real filesystem (gc, repacking, very large packs)
move to a Cloudflare Container running native git and syncing packs to the
object store — independent of the A/B choice.

## Consequences

### Positive

- Single-repo commit throughput is bounded by an in-memory CAS, not by
  seconds-long clones — the architectural ceiling moves by orders of magnitude.
- Object writes scale horizontally with zero coordination.
- Automatic conflict resolution becomes a first-class, async forge primitive
  reusing the existing LLM evaluator, instead of a synchronous manual gate.
- Stage B is a small, measurable spike; we buy data before betting a quarter on
  Stage A.
- Directly retires two `TODO.md` Phase-4 items (batch merging, high-concurrency
  load testing).

### Negative / risks

- A single repo's ref authority is a single DO. This is correct for
  serialization but means the DO must do *only* CAS + orchestration and never
  heavy git work, or the ceiling returns. Discipline required in the boundary.
- Option A means owning git plumbing we currently delegate to Artifacts —
  meaningful new surface area and maintenance.
- Optimistic concurrency + async resolution is more moving parts than the
  current synchronous merge; observability and retry/poison-message handling on
  the resolve queue become load-bearing.
- The fork-per-workspace model that gives us isolation/correctness still exists
  alongside this; we must keep both coherent rather than fragmenting the commit
  path.

### Product bet

This work is justified by a deliberate bet: **many agents working in parallel on
a shared repository is the future.** If that bet is wrong and the world stays on
"N agents on N branches merged through a gate," our existing fork-per-workspace
model already serves it and this architecture is unnecessary. We are recording
that we accept this bet, while staging the rollout (B before A) so the
investment scales with measured evidence.

## Alternatives Considered

### Keep clone-per-operation, just raise limits

Tune depth, parallelism, and DO count. **Rejected:** the cost is structural —
seconds of work inside the serialization window — so no amount of tuning reaches
high single-repo throughput.

### Drop serialization, accept eventual ref consistency

Let agents push refs without a single authority. **Rejected:** loses git's one
correctness guarantee (atomic ref advance) and reintroduces lost-update races.

### Jump straight to Option A

Build the owned object store now. **Rejected for now:** quarter-scale
investment on faith. Option B first yields a measured number for the decision.

## Related Decisions

- [ADR 002: Queue-Based Imports](./002-queue-based-imports.md) — async heavy
  work off the request path
- [ADR 003: D1 for Import State](./003-d1-for-import-state.md) — optimistic
  locking via a `version` CAS, the same primitive applied to refs here

## References

- Current commit/merge path: `src/storage/git-ops.ts`,
  `src/queue/merge-queue.ts`
- Conflict resolution scaffolding: `resolveConflict` in `src/storage/git-ops.ts`,
  `src/ui/components/conflict-resolution.tsx`
- Open items this addresses: `TODO.md` (batch merging in the merge queue DO;
  load testing 1000+ concurrent workspaces per repo)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)
