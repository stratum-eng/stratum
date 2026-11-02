/**
 * Bounds on a single post-merge deployment.
 *
 * They live in their own module for the same reason `src/evaluation/limits.ts`
 * does: the provider targets, the runner, and (eventually) the queue's
 * `visibility_timeout_ms` all need the same numbers, and none of them should
 * have to import a provider implementation to get them.
 *
 * Every one of these is enforced **before the first provider request is
 * issued**. A deployment that uploads half a tree and then fails leaves the
 * site in a state no one asked for; a clean up-front rejection with a named
 * reason does not.
 */

/**
 * Most files one deployment may publish.
 *
 * The Worker holds the whole tree in memory while it uploads, so this is a
 * memory bound as much as a fairness one.
 */
export const MAX_FILES = 2_000;

/** Most bytes one deployment may publish, summed across every file. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * Largest single file one deployment may publish.
 *
 * Below `MAX_TOTAL_BYTES` on purpose: one file must not be able to consume the
 * entire budget and starve the rest of the tree.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Most provider HTTP requests one deployment may issue.
 *
 * Cloudflare's own ceiling is the real limit — 10,000 per invocation on paid
 * plans since 2026-02-11, and only 50 external subrequests on the free plan.
 * This budget sits far below the paid ceiling because a deployment shares its
 * invocation with D1 reads, the git tree read, and the queue's own traffic,
 * and because `wrangler.toml` sets no `[limits]` block to raise it.
 *
 * It is deliberately just above `MAX_FILES + 2`: the Cloudflare static-asset
 * flow's worst case is one upload request per file plus a manifest
 * registration and a script deploy, so a tree that passes `MAX_FILES` can
 * never be rejected here for a reason the author cannot act on.
 *
 * A self-hoster on the Workers free plan will hit the platform's 50-subrequest
 * ceiling long before this one. That is a platform failure, not a limit this
 * module can enforce away.
 */
export const MAX_SUBREQUESTS = 2_048;

/**
 * Longest provider output persisted on a deployment row (`deployments.log_tail`).
 *
 * Redaction always runs on the full text *before* truncation to this length —
 * see `src/deploy/redact.ts`. Truncating first would let a secret survive by
 * straddling the cut.
 */
export const MAX_LOG_TAIL = 16_384;

/**
 * Memory one Worker isolate has, in bytes. Not configurable — it is the
 * platform's per-isolate limit, and exceeding it kills the isolate outright
 * rather than throwing something a `finally` could catch.
 */
export const ISOLATE_MEMORY_BYTES = 128 * 1024 * 1024;

/**
 * How many deploy messages one isolate may run at once — the
 * `max_concurrency` every `stratum-deploys` consumer in `wrangler.toml` must
 * be set to.
 *
 * **It is 1 because concurrent queue invocations share one isolate's
 * {@link ISOLATE_MEMORY_BYTES}, and an OOM kill is not catchable.** The Vercel
 * target inlines the whole tree in one JSON request body
 * (`src/deploy/targets/vercel.ts`), so one accepted deployment peaks at
 * `MAX_TOTAL_BYTES` of raw bytes plus a base64 copy plus the serialized body —
 * roughly 92 MiB. Two of those at once is ~183 MiB: the isolate dies *before*
 * `runOneDeployment` reaches the `finally` that writes a terminal status, and
 * every row it was holding is stranded at `running` with no lease to recover.
 *
 * The price, stated so nobody "optimizes" it back: this also serializes
 * Cloudflare Pages and Workers deploys, which are nowhere near that peak. That
 * is the accepted cost of a bound that holds whatever mix of targets a merge
 * fans out to — a Vercel-only byte limit would have to be re-derived every time
 * a target changes how it buffers, and would reject trees that deploy fine
 * today. Raising this requires cutting the per-deploy peak first (a streamed
 * request body), not the other way round.
 */
export const MAX_DEPLOY_CONCURRENCY = 1;

/**
 * Wall-clock budget for one deployment attempt, after which the runner gives up
 * and writes a terminal `failed` row.
 *
 * **Invariant, and the reason this constant exists:**
 *
 * ```
 * DEPLOY_ATTEMPT_DEADLINE_MS < DEFAULT_DEPLOY_LEASE_MS
 *                           <= visibility_timeout_ms (wrangler.toml)
 *                           <= QUEUE_CONSUMER_WALL_MS
 * ```
 *
 * Every `<` and `<=` is load bearing. Without the first one, the storage lease
 * (`DEFAULT_DEPLOY_LEASE_MS` in `src/storage/deployments.ts`) can expire while
 * the first runner is still uploading to the provider, and `claimDeployment`
 * will then hand a *genuinely running* row to a second consumer — the double
 * deploy the lease exists to prevent. Bounding the runner below the lease makes
 * "the lease expired" mean "no runner is alive", which is what every reclaim
 * decision already assumes.
 */
export const DEPLOY_ATTEMPT_DEADLINE_MS = 10 * 60 * 1000;

/**
 * Cloudflare's wall-clock ceiling on one queue-consumer invocation. Recorded
 * here because it is the outermost term of the ordering above and nothing else
 * in the codebase states it.
 */
export const QUEUE_CONSUMER_WALL_MS = 15 * 60 * 1000;
