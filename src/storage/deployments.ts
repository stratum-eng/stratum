/**
 * Storage for post-merge deployments.
 *
 * The `deployments` row *is* the lease. Two properties of this module are load
 * bearing and neither is visible from a casual read of the SQL:
 *
 * 1. {@link insertDeployment} never checks before it inserts. The unique index
 *    `ux_deployments_attempt` is the mutual exclusion — see the comment on that
 *    function before "simplifying" it into a SELECT-then-INSERT.
 * 2. {@link claimDeployment} is a single conditional UPDATE, so two consumers
 *    racing the same row cannot both win. It is the *only* place a stale
 *    `running` row is reclaimed, and only the deploy consumer may call it.
 *
 * Every timestamp is an application-written ISO 8601 string, canonicalised to
 * UTC with a millisecond fraction by {@link resolveTimestamp} before it is
 * bound. These columns are compared as TEXT, so a column holding more than one
 * spelling of an instant sorts by bytes rather than by time: `datetime('now')`
 * produces `YYYY-MM-DD HH:MM:SS`, which sorts before the ISO form (' ' 0x20 <
 * 'T' 0x54) and is rejected outright, while an offset or fraction-less ISO form
 * is accepted and rewritten. Either would break `lease_expires_at`, which is
 * range-compared on the claim path — stranding a deployment forever or letting a
 * consumer reclaim a live one and deploy the same commit twice — and
 * `created_at`, which decides which of two merges publishes over the other. See
 * `migrations/042_api_tokens.sql`.
 *
 * Every query is scoped on `project_id` and never on the bare `project` name:
 * names are not globally unique, so matching on one crosses tenants (see
 * `webhookBelongsToProject` in `./webhooks.ts`).
 */
import type { DeployTargetName } from "../evaluation/types";
import { AppError, ValidationError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** Every status the `status` CHECK in migration 047 admits. */
export const DEPLOYMENT_STATUSES = [
  "pending_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
  "skipped",
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * Statuses from which no further transition happens. A deployment that reaches
 * one holds no lease, and {@link completeDeployment} refuses to overwrite it —
 * a runner that lost its lease must not clobber the result written by the
 * consumer that reclaimed the row.
 */
export const TERMINAL_DEPLOYMENT_STATUSES = [
  "succeeded",
  "failed",
  "superseded",
  "skipped",
] as const;

export type TerminalDeploymentStatus = (typeof TERMINAL_DEPLOYMENT_STATUSES)[number];

/** Which kind of identity asked for this deployment. */
export type DeploymentRequesterType = "user" | "agent" | "system";

/**
 * `target` for a row that never selected a provider: a rejected `deploys:`
 * entry, a tree that could not be read at the merge commit, or a merge with no
 * deploy configured at all. Those rows exist to make the failure visible, and
 * the column is NOT NULL.
 *
 * Deliberately *not* a member of `DeployTargetName`: that type keys the target
 * registry as a total `Record`, so adding a sentinel there would force every
 * dispatch site to handle a case that never dispatches.
 */
export const UNRESOLVED_TARGET = "unresolved";

/** What `deployments.target` can hold: a real provider, or {@link UNRESOLVED_TARGET}. */
export type DeploymentTarget = DeployTargetName | typeof UNRESOLVED_TARGET;

/**
 * How long a claim holds the row before another consumer may reclaim it.
 *
 * This sits in the middle of an ordering that must not be disturbed:
 *
 * ```
 * DEPLOY_ATTEMPT_DEADLINE_MS < DEFAULT_DEPLOY_LEASE_MS
 *                           <= visibility_timeout_ms (wrangler.toml)
 *                           <= QUEUE_CONSUMER_WALL_MS
 * ```
 *
 * The upper bounds keep a redelivery from arriving while the lease is still
 * valid, which would leave the deployment unclaimable until the message was
 * exhausted. The lower bound is what makes the lease *safe*: the runner
 * (`src/deploy/limits.ts`) gives up strictly before the lease can expire, so an
 * expired lease means no runner is alive rather than "the first runner is still
 * uploading". Without it {@link claimDeployment} can hand a genuinely running
 * row to a second consumer and the same commit deploys twice.
 *
 * The three companion constants live in `src/deploy/limits.ts` and are not
 * imported here on purpose — storage does not depend on the deploy package —
 * so the ordering is asserted in the test suite instead.
 */
export const DEFAULT_DEPLOY_LEASE_MS = 15 * 60 * 1000;

/** Default `reason` stamped on a row superseded by a newer merge. */
export const SUPERSEDED_REASON = "Superseded by a newer deployment of the same name";

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

/**
 * ISO 8601 with the `T` separator. Enforced rather than assumed because the one
 * format that would silently corrupt `lease_expires_at` comparisons —
 * SQLite's `YYYY-MM-DD HH:MM:SS` — is also the one a caller is most likely to
 * reach for.
 *
 * This admits more than one spelling of the same instant on purpose (`Z` or a
 * `±HH:MM` offset, with or without a fraction). Accepting them is safe *only*
 * because {@link resolveTimestamp} rewrites every one to the canonical UTC form
 * before it reaches a column; widening this pattern without that step would put
 * text back into the columns whose byte order is not chronological.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Is this a timestamp every column in this module will accept?
 *
 * Exported because the merge time now travels through the queue
 * (`DeployQueueMessage`) before it reaches a column, and the producer and the
 * runner both have to decide whether to trust it. Sharing this predicate keeps
 * one definition of the format: a value that passes here is one
 * {@link insertDeployment} cannot reject, so no queue message can strand a
 * deploy on a timestamp that only fails at the last step.
 *
 * It deliberately only *validates*. Canonicalisation belongs at the storage
 * boundary ({@link resolveTimestamp}) and nowhere else: a message in transit is
 * never compared against a column, so normalising it early would add a second
 * place that has to agree on the canonical form while fixing nothing. A guard
 * also cannot return a rewritten value without ceasing to be a guard, and
 * callers here (`resolveMergeTime`, `mergeTimeOf`) want to pass the operator's
 * own timestamp through untouched.
 */
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_8601.test(value) && !Number.isNaN(Date.parse(value));
}

/** One deployment attempt, as every reader outside this module sees it. */
export interface Deployment {
  id: string;
  /** Canonical project id. The only thing project scoping ever consults. */
  projectId: string;
  /** Bare project name, mirrored so the project-deletion cascade matches on either form. */
  project: string;
  /** Absent for a deploy not traceable to a change, such as a retry of an older commit. */
  changeId?: string;
  commitSha: string;
  name: string;
  target: DeploymentTarget;
  attempt: number;
  status: DeploymentStatus;
  reason?: string;
  url?: string;
  /** Redacted, truncated provider error payload. Serve only to project writers. */
  logTail?: string;
  durationMs?: number;
  leaseExpiresAt?: string;
  requestedByType: DeploymentRequesterType;
  requestedById?: string;
  approvedBy?: string;
  /**
   * **The merge this deployment publishes, not the moment the row was written.**
   *
   * Cloudflare Queues promise no ordering and a retry reorders outright, so
   * stamping this when the message was *processed* let a late-delivered older
   * merge sort after a newer one — and publish over it. Every consumer of
   * deployment order (`listDeployments`, {@link supersedeOlder},
   * {@link findNewerSucceededDeployment}) reads this column, so it has to carry
   * merge order or none of them mean anything.
   *
   * A retry is the deliberate exception: it stamps the current time, because an
   * operator re-running an old commit is asserting it is the newest intent.
   */
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Outcome of racing the unique index. `inserted: false` is a *success* — the
 * caller lost a legitimate race — and is deliberately not an error, so a
 * genuine database failure stays distinguishable from a duplicate.
 */
export type InsertDeploymentOutcome =
  | { inserted: true; deployment: Deployment }
  | {
      inserted: false;
      /** The row that already holds this `(project_id, name, commit_sha, attempt)`, if still readable. */
      existing: Deployment | null;
    };

/** Outcome of a claim attempt. Only `claimed: true` grants the right to deploy. */
export type ClaimDeploymentOutcome =
  | { claimed: true; deployment: Deployment }
  | { claimed: false; reason: "not_found" | "not_claimable" };

interface DeploymentRow {
  id: string;
  project_id: string;
  project: string;
  change_id: string | null;
  commit_sha: string;
  name: string;
  target: string;
  attempt: number;
  status: string;
  reason: string | null;
  url: string | null;
  log_tail: string | null;
  duration_ms: number | null;
  lease_expires_at: string | null;
  requested_by_type: string;
  requested_by_id: string | null;
  approved_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const DEPLOYMENT_SELECT =
  "SELECT id, project_id, project, change_id, commit_sha, name, target, attempt, status, " +
  "reason, url, log_tail, duration_ms, lease_expires_at, requested_by_type, requested_by_id, " +
  "approved_by, created_at, started_at, completed_at FROM deployments";

function rowToDeployment(row: DeploymentRow): Deployment {
  const deployment: Deployment = {
    id: row.id,
    projectId: row.project_id,
    project: row.project,
    commitSha: row.commit_sha,
    name: row.name,
    target: row.target as DeploymentTarget,
    attempt: row.attempt,
    status: row.status as DeploymentStatus,
    requestedByType: row.requested_by_type as DeploymentRequesterType,
    createdAt: row.created_at,
  };
  if (row.change_id !== null) deployment.changeId = row.change_id;
  if (row.reason !== null) deployment.reason = row.reason;
  if (row.url !== null) deployment.url = row.url;
  if (row.log_tail !== null) deployment.logTail = row.log_tail;
  if (row.duration_ms !== null) deployment.durationMs = row.duration_ms;
  if (row.lease_expires_at !== null) deployment.leaseExpiresAt = row.lease_expires_at;
  if (row.requested_by_id !== null) deployment.requestedById = row.requested_by_id;
  if (row.approved_by !== null) deployment.approvedBy = row.approved_by;
  if (row.started_at !== null) deployment.startedAt = row.started_at;
  if (row.completed_at !== null) deployment.completedAt = row.completed_at;
  return deployment;
}

function toAppError(error: unknown, operation: string, context: Record<string, unknown>): AppError {
  return error instanceof AppError
    ? error
    : new AppError(
        error instanceof Error ? error.message : `Failed in ${operation}`,
        "DATABASE_ERROR",
        500,
        { operation, ...context },
      );
}

/**
 * Is this the unique index rejecting a duplicate attempt, or a real failure?
 *
 * Matched on the message because neither D1 nor `node:sqlite` exposes a
 * structured constraint code; D1 prefixes its message with `D1_ERROR:`, hence
 * the substring match rather than an equality check. Same approach as
 * `isUniqueViolation` in `./deletion-jobs.ts`.
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * Validates a caller-supplied timestamp and rewrites it to the one canonical
 * form, or mints one, so no value whose byte order disagrees with its
 * chronological order can reach a column.
 *
 * Validating alone is not enough. {@link ISO_8601} admits several spellings of a
 * single instant, and SQLite compares these columns as TEXT, so storing the
 * caller's spelling verbatim makes lexical order diverge from time order:
 * `...T17:20:43-04:00` sorts *before* the identical instant written
 * `...T21:20:43.000Z` (`1` < `2`), and `...T21:20:43Z` sorts *after*
 * `...T21:20:43.000Z` (`.` 0x2E < `Z` 0x5A). Both comparisons that guard a
 * deploy read this order: `created_at` in {@link supersedeOlder} and
 * {@link findNewerSucceededDeployment} — which decide whether an older commit
 * may publish over a newer one — and `lease_expires_at <= now` in
 * {@link claimDeployment}, which decides whether a lease is dead. `created_at`
 * in particular now carries the merge time, which arrives over the queue from a
 * different code path than the one that wrote the rows it is compared against,
 * so the two spellings genuinely do meet in one column.
 *
 * `Date#toISOString` gives UTC with a fixed-width millisecond fraction, so every
 * accepted input collapses to a single fixed-width representation and byte order
 * *is* chronological order.
 */
function resolveTimestamp(
  value: string | undefined,
  field: string,
): Result<string, ValidationError> {
  if (value === undefined) return ok(new Date().toISOString());
  const parsed = Date.parse(value);
  if (!ISO_8601.test(value) || Number.isNaN(parsed)) {
    return err(
      new ValidationError(
        `${field} must be an ISO 8601 timestamp (e.g. 2026-09-04T00:00:00.000Z); SQLite's 'YYYY-MM-DD HH:MM:SS' form sorts differently and breaks lease comparisons`,
        { field, value },
      ),
    );
  }
  return ok(new Date(parsed).toISOString());
}

function isTerminal(status: DeploymentStatus): status is TerminalDeploymentStatus {
  return (TERMINAL_DEPLOYMENT_STATUSES as readonly string[]).includes(status);
}

async function readDeployment(
  db: D1Database,
  projectId: string,
  deploymentId: string,
): Promise<Deployment | null> {
  const row = await db
    .prepare(`${DEPLOYMENT_SELECT} WHERE id = ? AND project_id = ?`)
    .bind(deploymentId, projectId)
    .first<DeploymentRow>();
  return row ? rowToDeployment(row) : null;
}

/**
 * Inserts a deployment attempt, letting the database decide who owns it.
 *
 * **This is the mutual exclusion for a deploy.** It does not look for an
 * existing row first: two consumers handling the same merge would both pass
 * such a check and both insert, because there is no transaction spanning the
 * read and the write across isolates. Instead both INSERT against
 * `ux_deployments_attempt` on `(project_id, name, commit_sha, attempt)` and
 * exactly one wins; the loser gets `inserted: false`, which means "someone else
 * already owns this deployment" and is a normal outcome, not a failure. Only a
 * genuine database fault comes back through the `err` channel.
 *
 * A retry inserts the same commit with `attempt + 1`, which is a different key
 * and is therefore admitted.
 *
 * @param opts.projectId - Canonical project id; never a project name
 * @param opts.project - Bare project name, mirrored for the deletion cascade
 * @param opts.status - Starting status; defaults to `queued`. A terminal status
 *   (a rejected `deploys:` entry lands as `failed`) also stamps `completed_at`.
 * @param opts.createdAt - What `created_at` should hold: the **merge time** for
 *   a merge-triggered deploy, so the row sorts by merge order rather than by
 *   whenever the queue happened to deliver its message. Defaults to `now`,
 *   which is what a retry wants — see {@link Deployment.createdAt}.
 * @param opts.now - Injected clock, ISO 8601. Defaults to the current time.
 */
export async function insertDeployment(
  db: D1Database,
  logger: Logger,
  opts: {
    projectId: string;
    project: string;
    changeId?: string | null;
    commitSha: string;
    name: string;
    target: DeploymentTarget;
    attempt?: number;
    status?: DeploymentStatus;
    reason?: string | null;
    url?: string | null;
    logTail?: string | null;
    durationMs?: number | null;
    requestedByType: DeploymentRequesterType;
    requestedById?: string | null;
    approvedBy?: string | null;
    createdAt?: string;
    now?: string;
  },
): Promise<Result<InsertDeploymentOutcome, AppError>> {
  const nowResult = resolveTimestamp(opts.now, "now");
  if (!nowResult.success) return err(nowResult.error);
  const now = nowResult.data;
  const createdAtResult = resolveTimestamp(opts.createdAt ?? now, "createdAt");
  if (!createdAtResult.success) return err(createdAtResult.error);
  const createdAt = createdAtResult.data;

  const id = newId("dep");
  const attempt = opts.attempt ?? 1;
  const status: DeploymentStatus = opts.status ?? "queued";
  const completedAt = isTerminal(status) ? now : null;

  try {
    await db
      .prepare(
        "INSERT INTO deployments (id, project_id, project, change_id, commit_sha, name, target, " +
          "attempt, status, reason, url, log_tail, duration_ms, requested_by_type, " +
          "requested_by_id, approved_by, created_at, completed_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        opts.projectId,
        opts.project,
        opts.changeId ?? null,
        opts.commitSha,
        opts.name,
        opts.target,
        attempt,
        status,
        opts.reason ?? null,
        opts.url ?? null,
        opts.logTail ?? null,
        opts.durationMs ?? null,
        opts.requestedByType,
        opts.requestedById ?? null,
        opts.approvedBy ?? null,
        createdAt,
        completedAt,
      )
      .run();

    const deployment: Deployment = {
      id,
      projectId: opts.projectId,
      project: opts.project,
      commitSha: opts.commitSha,
      name: opts.name,
      target: opts.target,
      attempt,
      status,
      requestedByType: opts.requestedByType,
      createdAt,
    };
    if (opts.changeId) deployment.changeId = opts.changeId;
    if (opts.reason) deployment.reason = opts.reason;
    if (opts.url) deployment.url = opts.url;
    if (opts.logTail) deployment.logTail = opts.logTail;
    if (opts.durationMs !== undefined && opts.durationMs !== null) {
      deployment.durationMs = opts.durationMs;
    }
    if (opts.requestedById) deployment.requestedById = opts.requestedById;
    if (opts.approvedBy) deployment.approvedBy = opts.approvedBy;
    if (completedAt) deployment.completedAt = completedAt;

    logger.info("Deployment row created", {
      deploymentId: id,
      projectId: opts.projectId,
      name: opts.name,
      commitSha: opts.commitSha,
      attempt,
      status,
      createdAt,
    });
    return ok({ inserted: true, deployment });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      const appError = toAppError(error, "insertDeployment", { projectId: opts.projectId });
      logger.error("Failed to create deployment row", appError, {
        projectId: opts.projectId,
        name: opts.name,
        commitSha: opts.commitSha,
        attempt,
      });
      return err(appError);
    }

    logger.info("Deployment already owned by another consumer", {
      projectId: opts.projectId,
      name: opts.name,
      commitSha: opts.commitSha,
      attempt,
    });

    try {
      const row = await db
        .prepare(
          `${DEPLOYMENT_SELECT} WHERE project_id = ? AND name = ? AND commit_sha = ? AND attempt = ?`,
        )
        .bind(opts.projectId, opts.name, opts.commitSha, attempt)
        .first<DeploymentRow>();
      return ok({ inserted: false, existing: row ? rowToDeployment(row) : null });
    } catch (readError) {
      // The insert result is already known — losing the read-back only costs the
      // caller the winner's id, so report the duplicate rather than an error.
      logger.warn("Could not read back the winning deployment row", {
        projectId: opts.projectId,
        name: opts.name,
        error: readError instanceof Error ? readError.message : String(readError),
      });
      return ok({ inserted: false, existing: null });
    }
  }
}

/**
 * Claims a deployment for execution, taking a lease on it. **Deploy consumer
 * only.**
 *
 * The single conditional UPDATE is the whole point: the `WHERE` clause and the
 * write happen atomically, so of two consumers holding the same message exactly
 * one sees `meta.changes > 0`. Splitting this into a read followed by a write
 * reintroduces the race it exists to close, after which the same commit deploys
 * twice.
 *
 * A row is claimable when it is `queued`, or when it is `running` with a lease
 * that has already expired — a consumer that died mid-deploy must not strand
 * the deployment forever. Reclamation lives here and nowhere else: doing it on
 * a read path would let a page view flip a live deployment to `failed`, and a
 * retry would then deploy the same commit a second time.
 *
 * `pending_approval` is deliberately not claimable. Approval moves the row to
 * `queued` and enqueues it; a consumer must never run an unapproved deploy.
 *
 * @param opts.leaseMs - Lease duration; defaults to {@link DEFAULT_DEPLOY_LEASE_MS}
 * @param opts.now - Injected clock, ISO 8601. Defaults to the current time.
 */
export async function claimDeployment(
  db: D1Database,
  logger: Logger,
  opts: {
    projectId: string;
    deploymentId: string;
    leaseMs?: number;
    now?: string;
  },
): Promise<Result<ClaimDeploymentOutcome, AppError>> {
  const nowResult = resolveTimestamp(opts.now, "now");
  if (!nowResult.success) return err(nowResult.error);
  const now = nowResult.data;

  const leaseMs = opts.leaseMs ?? DEFAULT_DEPLOY_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    return err(
      new ValidationError("leaseMs must be a positive number of milliseconds", { leaseMs }),
    );
  }
  const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();

  try {
    const updated = await db
      .prepare(
        "UPDATE deployments SET status = 'running', started_at = COALESCE(started_at, ?), " +
          "lease_expires_at = ? WHERE id = ? AND project_id = ? AND (" +
          "status = 'queued' OR " +
          "(status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))",
      )
      .bind(now, leaseExpiresAt, opts.deploymentId, opts.projectId, now)
      .run();

    if (updated.meta.changes === 0) {
      const existing = await readDeployment(db, opts.projectId, opts.deploymentId);
      if (!existing) {
        logger.warn("Deployment not found for claim", {
          deploymentId: opts.deploymentId,
          projectId: opts.projectId,
        });
        return ok({ claimed: false, reason: "not_found" });
      }
      logger.info("Deployment not claimable", {
        deploymentId: opts.deploymentId,
        projectId: opts.projectId,
        status: existing.status,
        leaseExpiresAt: existing.leaseExpiresAt,
      });
      return ok({ claimed: false, reason: "not_claimable" });
    }

    const claimed = await readDeployment(db, opts.projectId, opts.deploymentId);
    if (!claimed) {
      const appError = new AppError(
        "Deployment disappeared immediately after being claimed",
        "DATABASE_ERROR",
        500,
        { operation: "claimDeployment", deploymentId: opts.deploymentId },
      );
      logger.error("Failed to read back claimed deployment", appError, {
        deploymentId: opts.deploymentId,
      });
      return err(appError);
    }

    logger.info("Deployment claimed", {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
      leaseExpiresAt,
    });
    return ok({ claimed: true, deployment: claimed });
  } catch (error) {
    const appError = toAppError(error, "claimDeployment", {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
    });
    logger.error("Failed to claim deployment", appError, {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
    });
    return err(appError);
  }
}

/**
 * Writes a deployment's terminal status and releases its lease.
 *
 * Refuses to overwrite a row that is already terminal, so a runner whose lease
 * expired mid-deploy cannot clobber the result written by the consumer that
 * reclaimed the row. `false` therefore means "this row is no longer yours" —
 * the caller should log it rather than retry.
 *
 * `lease_expires_at` is always cleared: a finished deployment holding a lease
 * would look reclaimable to the next consumer that read it.
 *
 * @returns `true` when a row was written, `false` when the row was missing,
 *   in another project, or already terminal.
 */
export async function completeDeployment(
  db: D1Database,
  logger: Logger,
  opts: {
    projectId: string;
    deploymentId: string;
    status: TerminalDeploymentStatus;
    reason?: string | null;
    url?: string | null;
    logTail?: string | null;
    durationMs?: number | null;
    completedAt?: string;
  },
): Promise<Result<boolean, AppError>> {
  const completedAtResult = resolveTimestamp(opts.completedAt, "completedAt");
  if (!completedAtResult.success) return err(completedAtResult.error);
  const completedAt = completedAtResult.data;

  const terminalList = TERMINAL_DEPLOYMENT_STATUSES.map(() => "?").join(", ");

  try {
    const result = await db
      .prepare(
        `UPDATE deployments SET status = ?, reason = ?, url = ?, log_tail = ?, duration_ms = ?, completed_at = ?, lease_expires_at = NULL WHERE id = ? AND project_id = ? AND status NOT IN (${terminalList})`,
      )
      .bind(
        opts.status,
        opts.reason ?? null,
        opts.url ?? null,
        opts.logTail ?? null,
        opts.durationMs ?? null,
        completedAt,
        opts.deploymentId,
        opts.projectId,
        ...TERMINAL_DEPLOYMENT_STATUSES,
      )
      .run();

    const written = result.meta.changes > 0;
    if (written) {
      logger.info("Deployment completed", {
        deploymentId: opts.deploymentId,
        projectId: opts.projectId,
        status: opts.status,
      });
    } else {
      logger.warn("Deployment was already terminal or not in this project", {
        deploymentId: opts.deploymentId,
        projectId: opts.projectId,
        status: opts.status,
      });
    }
    return ok(written);
  } catch (error) {
    const appError = toAppError(error, "completeDeployment", {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
    });
    logger.error("Failed to complete deployment", appError, {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
    });
    return err(appError);
  }
}

/**
 * Marks every older not-yet-started deployment of the same `(projectId, name)`
 * as `superseded`.
 *
 * Called by the consumer immediately before it runs. Without it, two merges in
 * quick succession can land in either order and the *older* commit can be the
 * one left in production — the queue makes no ordering promise.
 *
 * The comparison is on `created_at`, which carries **merge order** and not
 * delivery order (see {@link Deployment.createdAt}); comparing delivery order
 * here would retire the newer commit whenever the queue reordered two messages.
 * This only reaches rows that have not started, so it cannot help once the
 * newer deploy is already `succeeded` — {@link findNewerSucceededDeployment} is
 * the half that covers that.
 *
 * Only `queued` and `pending_approval` rows are touched. A `running` row is
 * left alone: it is either live, or expired and reclaimable by
 * {@link claimDeployment}, and superseding it here would abandon a deploy that
 * is still uploading.
 *
 * @param opts.createdAt - The keeper's `created_at`; rows at or before it are
 *   superseded. A row sharing the exact timestamp is a genuine race, and the
 *   keeper is the one that reached the consumer.
 * @returns How many rows were superseded.
 */
export async function supersedeOlder(
  db: D1Database,
  logger: Logger,
  opts: {
    projectId: string;
    name: string;
    keepDeploymentId: string;
    createdAt: string;
    reason?: string;
    now?: string;
  },
): Promise<Result<number, AppError>> {
  const createdAtResult = resolveTimestamp(opts.createdAt, "createdAt");
  if (!createdAtResult.success) return err(createdAtResult.error);
  const nowResult = resolveTimestamp(opts.now, "now");
  if (!nowResult.success) return err(nowResult.error);

  try {
    const result = await db
      .prepare(
        "UPDATE deployments SET status = 'superseded', reason = ?, completed_at = ?, " +
          "lease_expires_at = NULL WHERE project_id = ? AND name = ? AND id != ? " +
          "AND created_at <= ? AND status IN ('queued', 'pending_approval')",
      )
      .bind(
        opts.reason ?? SUPERSEDED_REASON,
        nowResult.data,
        opts.projectId,
        opts.name,
        opts.keepDeploymentId,
        createdAtResult.data,
      )
      .run();

    const superseded = result.meta.changes;
    if (superseded > 0) {
      logger.info("Superseded older deployments", {
        projectId: opts.projectId,
        name: opts.name,
        keepDeploymentId: opts.keepDeploymentId,
        superseded,
      });
    }
    return ok(superseded);
  } catch (error) {
    const appError = toAppError(error, "supersedeOlder", {
      projectId: opts.projectId,
      name: opts.name,
    });
    logger.error("Failed to supersede older deployments", appError, {
      projectId: opts.projectId,
      name: opts.name,
    });
    return err(appError);
  }
}

/**
 * The newest already-`succeeded` deployment of the same name that this one would
 * publish *over*, or `null` when there is none.
 *
 * This is the half of ordering that {@link supersedeOlder} cannot cover. That
 * function only touches rows which have not started, so once the newer merge has
 * already reached `succeeded` it retires nothing — and a late-delivered older
 * merge would then deploy straight over the newer commit. Cloudflare Queues
 * promise no ordering and a retry reorders outright, so "the older message
 * arrives second" is a routine delivery, not a rare race.
 *
 * The comparison is strictly greater-than on purpose. Equal timestamps are
 * either siblings of one merge (different `name`, so they never match here) or a
 * retry stamped in the same millisecond as the row it retries; refusing on
 * equality would make that retry unrunnable for no gain.
 *
 * @param opts.createdAt - The candidate's merge time; anything succeeded strictly
 *   after it wins
 * @param opts.excludeDeploymentId - The candidate itself, which must never count
 *   as its own superseder
 */
export async function findNewerSucceededDeployment(
  db: D1Database,
  logger: Logger,
  opts: {
    projectId: string;
    name: string;
    createdAt: string;
    excludeDeploymentId: string;
  },
): Promise<Result<Deployment | null, AppError>> {
  const createdAtResult = resolveTimestamp(opts.createdAt, "createdAt");
  if (!createdAtResult.success) return err(createdAtResult.error);

  try {
    const row = await db
      .prepare(
        `${DEPLOYMENT_SELECT} WHERE project_id = ? AND name = ? AND id != ? AND status = 'succeeded' AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .bind(opts.projectId, opts.name, opts.excludeDeploymentId, createdAtResult.data)
      .first<DeploymentRow>();
    return ok(row ? rowToDeployment(row) : null);
  } catch (error) {
    const appError = toAppError(error, "findNewerSucceededDeployment", {
      projectId: opts.projectId,
      name: opts.name,
    });
    logger.error("Failed to look for a newer succeeded deployment", appError, {
      projectId: opts.projectId,
      name: opts.name,
    });
    return err(appError);
  }
}

/**
 * Lists a project's deployments, newest first.
 *
 * Newest first by **merge time** (see {@link Deployment.createdAt}), so the
 * commit that is actually live sorts to the top even when the queue delivered
 * its message second.
 *
 * `name` then `id` break ties on `created_at`. `name` is the one that matters to
 * a reader: the deploys fanned out from a single merge are stamped from that
 * merge's timestamp, so they *always* tie, and with only `id` behind them a
 * random hex string decided the order of every row on the page — the same
 * deployments rendered in a different order on each request. `id` stays as the
 * final tiebreaker to keep paging stable, since two rows can share both a
 * timestamp and a name across attempts.
 *
 * @param opts.projectId - Canonical project id; a bare project name would cross tenants
 * @param opts.name - Optional deploy name filter (`production`, `staging`, ...)
 */
export async function listDeployments(
  db: D1Database,
  logger: Logger,
  opts: {
    projectId: string;
    name?: string;
    status?: DeploymentStatus;
    limit?: number;
    offset?: number;
  },
): Promise<Result<Deployment[], AppError>> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);

  const conditions = ["project_id = ?"];
  const binds: unknown[] = [opts.projectId];
  if (opts.name !== undefined) {
    conditions.push("name = ?");
    binds.push(opts.name);
  }
  if (opts.status !== undefined) {
    conditions.push("status = ?");
    binds.push(opts.status);
  }

  try {
    const result = await db
      .prepare(
        `${DEPLOYMENT_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, name ASC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all<DeploymentRow>();
    return ok(result.results.map(rowToDeployment));
  } catch (error) {
    const appError = toAppError(error, "listDeployments", { projectId: opts.projectId });
    logger.error("Failed to list deployments", appError, { projectId: opts.projectId });
    return err(appError);
  }
}

/**
 * Reads one deployment, scoped to its project.
 *
 * @returns The deployment, or `null` when it does not exist *or* belongs to
 *   another project — the two are indistinguishable on purpose, so a probe
 *   cannot confirm an id in a project the caller cannot read.
 */
export async function getDeployment(
  db: D1Database,
  logger: Logger,
  opts: { projectId: string; deploymentId: string },
): Promise<Result<Deployment | null, AppError>> {
  try {
    return ok(await readDeployment(db, opts.projectId, opts.deploymentId));
  } catch (error) {
    const appError = toAppError(error, "getDeployment", {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
    });
    logger.error("Failed to get deployment", appError, {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
    });
    return err(appError);
  }
}

/**
 * Outcome of an approval attempt. Only `approved: true` enqueues — see
 * {@link approveDeployment} for why that distinction is the whole safety
 * property.
 */
export type ApproveDeploymentOutcome =
  | { approved: true; deployment: Deployment }
  | { approved: false; reason: "not_found" | "not_pending" };

/**
 * Moves an approved deployment from `pending_approval` to `queued`, stamping
 * who approved it.
 *
 * Without this the approval gate is a dead end: {@link claimDeployment}
 * deliberately refuses `pending_approval`, so a row that is never moved out of
 * it can never be claimed and the deployment hangs forever.
 *
 * The conditional UPDATE is what makes a double-approve safe. Two concurrent
 * approvals of the same row both target `status = 'pending_approval'`, so
 * exactly one sees `meta.changes > 0`; only that caller may enqueue, and the
 * commit therefore cannot deploy twice. A read-then-write would let both
 * callers observe `pending_approval` and both enqueue.
 *
 * @param opts.approvedBy - The approving user id, recorded on the row
 * @param opts.now - Injected clock, ISO 8601. Defaults to the current time.
 */
export async function approveDeployment(
  db: D1Database,
  logger: Logger,
  opts: {
    projectId: string;
    deploymentId: string;
    approvedBy: string;
    now?: string;
  },
): Promise<Result<ApproveDeploymentOutcome, AppError>> {
  const nowResult = resolveTimestamp(opts.now, "now");
  if (!nowResult.success) return err(nowResult.error);

  try {
    const updated = await db
      .prepare(
        "UPDATE deployments SET status = 'queued', approved_by = ? " +
          "WHERE id = ? AND project_id = ? AND status = 'pending_approval'",
      )
      .bind(opts.approvedBy, opts.deploymentId, opts.projectId)
      .run();

    if (updated.meta.changes === 0) {
      const existing = await readDeployment(db, opts.projectId, opts.deploymentId);
      if (!existing) {
        logger.warn("Deployment not found for approval", {
          deploymentId: opts.deploymentId,
          projectId: opts.projectId,
        });
        return ok({ approved: false, reason: "not_found" });
      }
      logger.info("Deployment is not awaiting approval", {
        deploymentId: opts.deploymentId,
        projectId: opts.projectId,
        status: existing.status,
      });
      return ok({ approved: false, reason: "not_pending" });
    }

    const approved = await readDeployment(db, opts.projectId, opts.deploymentId);
    if (!approved) {
      const appError = new AppError(
        "Deployment disappeared immediately after being approved",
        "DATABASE_ERROR",
        500,
        { operation: "approveDeployment", deploymentId: opts.deploymentId },
      );
      logger.error("Failed to read back approved deployment", appError, {
        deploymentId: opts.deploymentId,
      });
      return err(appError);
    }

    logger.info("Deployment approved", {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
      approvedBy: opts.approvedBy,
    });
    return ok({ approved: true, deployment: approved });
  } catch (error) {
    const appError = toAppError(error, "approveDeployment", {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
    });
    logger.error("Failed to approve deployment", appError, {
      deploymentId: opts.deploymentId,
      projectId: opts.projectId,
    });
    return err(appError);
  }
}

/**
 * Reads one deployment without knowing its project.
 *
 * Exists only for `GET|POST /api/deployments/:id`, whose URL carries no
 * project: the row's own `project_id` is what the route then authorizes
 * against. **It performs no access control** — every caller must check the
 * returned `projectId` before revealing anything, including whether the id
 * exists.
 *
 * Every other read stays project-scoped ({@link getDeployment}), so this is the
 * one query that could cross tenants if a caller forgot that check.
 */
export async function findDeploymentById(
  db: D1Database,
  logger: Logger,
  deploymentId: string,
): Promise<Result<Deployment | null, AppError>> {
  try {
    const row = await db
      .prepare(`${DEPLOYMENT_SELECT} WHERE id = ?`)
      .bind(deploymentId)
      .first<DeploymentRow>();
    return ok(row ? rowToDeployment(row) : null);
  } catch (error) {
    const appError = toAppError(error, "findDeploymentById", { deploymentId });
    logger.error("Failed to find deployment", appError, { deploymentId });
    return err(appError);
  }
}
