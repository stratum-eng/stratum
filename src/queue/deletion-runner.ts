import { recordAudit } from "../storage/audit";
import {
  type DeletionTarget,
  deleteAccountCascade,
  deleteProjectCascade,
  verifyProjectDeleted,
} from "../storage/deletion";
import {
  acquireLease,
  finishJob,
  getDeletionJob,
  heartbeat,
  listUnfinishedJobs,
  setJobState,
} from "../storage/deletion-jobs";
import type { Env } from "../types";
import type { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

// Lease outlives the stale-heartbeat threshold so an actively-progressing driver
// (which refreshes the lease on every heartbeat) is never stolen while healthy;
// only a genuinely dead driver's lease lapses for the sweep to reclaim.
const LEASE_TTL_MS = 15 * 60 * 1000;

/** A job with no heartbeat progress for this long counts as stuck. */
const STALE_HEARTBEAT_MS = 10 * 60 * 1000;

function parseProjectTarget(raw: string): DeletionTarget | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  const stringFields = ["projectId", "namespace", "slug", "name"] as const;
  for (const field of stringFields) {
    if (typeof candidate[field] !== "string") return null;
  }
  const arrayFields = ["workspaceNames", "forkRepoNames", "changeIds", "webhookIds"] as const;
  for (const field of arrayFields) {
    if (!Array.isArray(candidate[field])) return null;
  }
  if (typeof candidate.nameCollision !== "boolean") return null;
  return candidate as unknown as DeletionTarget;
}

/** Parse the account target JSON ({ userId }) set by the delete-account route. */
function parseAccountTarget(raw: string): { userId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.userId !== "string") return null;
  return { userId: candidate.userId };
}

/**
 * Drive one deletion job to a terminal state. Safe to call from multiple
 * drivers (the lease admits one) and idempotent under re-drive: the cascade
 * and verifier converge, and the `started` audit is only written on the first
 * drive (empty checkpoint).
 */
export async function runDeletionJob(
  env: Env,
  jobId: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  const log = logger.child({ component: "deletion-runner", jobId });

  const jobResult = await getDeletionJob(env.DB, log, jobId);
  if (!jobResult.success) return err(jobResult.error);
  const job = jobResult.data;
  if (!job) {
    log.warn("Deletion job not found; nothing to drive", { jobId });
    return ok(undefined);
  }
  if (job.state === "completed" || job.state === "incomplete") {
    log.debug("Deletion job already finished", { jobId, state: job.state });
    return ok(undefined);
  }

  const driverId = newId("drv");
  const leaseResult = await acquireLease(env.DB, log, jobId, driverId, LEASE_TTL_MS);
  if (!leaseResult.success) return err(leaseResult.error);
  if (!leaseResult.data) {
    log.debug("Deletion job lease held by another driver; skipping", { jobId });
    return ok(undefined);
  }

  // Invariant: the `started` audit lands BEFORE any destruction so a crash
  // mid-cascade can never yield a deleted-but-unaudited project. Only the
  // first drive (empty checkpoint) writes it; re-drives already have one.
  if (!job.checkpoint) {
    const audited = await recordAudit(env.DB, log, {
      action: "deletion.started",
      actorType: "system",
      subject: jobId,
      detail: { kind: job.kind },
    });
    // If we can't prove the audit landed, we must not destroy anything yet.
    if (!audited.success) return err(audited.error);
  }

  const running = await setJobState(env.DB, log, jobId, driverId, "running");
  if (!running.success) return err(running.error);
  if (!running.data) {
    log.warn("Lost deletion lease before running; aborting", { jobId });
    return ok(undefined);
  }
  const started = await heartbeat(env.DB, log, jobId, driverId, LEASE_TTL_MS, "started");
  if (!started.success) log.warn("Failed to record deletion heartbeat", { jobId });

  const residuals: string[] = [];
  if (job.kind === "account") {
    const account = parseAccountTarget(job.target);
    if (!account) {
      log.error("Account deletion job target is unparseable", undefined, { jobId });
      residuals.push("target:unparseable");
    } else {
      const cascade = await deleteAccountCascade(env, account.userId, log);
      if (cascade.success) {
        residuals.push(...cascade.data.residuals);
      } else {
        log.error("Account deletion cascade failed", cascade.error, { jobId });
        residuals.push(`cascade:error:${cascade.error.code}`);
      }
      const cascaded = await heartbeat(env.DB, log, jobId, driverId, LEASE_TTL_MS, "cascade");
      if (!cascaded.success) log.warn("Failed to record deletion heartbeat", { jobId });
      if (cascaded.success && !cascaded.data) {
        // A concurrent driver stole the lease. Bow out; the owner will finish.
        log.warn("Lost deletion lease after account cascade; deferring", { jobId });
        return ok(undefined);
      }
    }
  } else {
    const target = parseProjectTarget(job.target);
    if (!target) {
      log.error("Deletion job target is unparseable", undefined, { jobId });
      residuals.push("target:unparseable");
    } else {
      const cascade = await deleteProjectCascade(env, target, log);
      if (cascade.success) {
        residuals.push(...cascade.data.residuals);
      } else {
        log.error("Deletion cascade failed", cascade.error, { jobId });
        residuals.push(`cascade:error:${cascade.error.code}`);
      }
      const cascaded = await heartbeat(env.DB, log, jobId, driverId, LEASE_TTL_MS, "cascade");
      if (!cascaded.success) log.warn("Failed to record deletion heartbeat", { jobId });
      if (cascaded.success && !cascaded.data) {
        // A concurrent driver stole the lease (e.g. we ran past expiry). Bow out;
        // the current owner will verify + finish. Idempotency keeps this safe.
        log.warn("Lost deletion lease after cascade; deferring to lease owner", { jobId });
        return ok(undefined);
      }

      const verifying = await setJobState(env.DB, log, jobId, driverId, "verifying");
      if (!verifying.success) log.warn("Failed to mark deletion job verifying", { jobId });
      const verified = await verifyProjectDeleted(env, target, log);
      if (verified.success) {
        residuals.push(...verified.data.residuals);
      } else {
        log.error("Deletion verification failed", verified.error, { jobId });
        residuals.push(`verify:error:${verified.error.code}`);
      }
    }
  }

  const unique = [...new Set(residuals)];
  const finalState = unique.length === 0 ? "completed" : "incomplete";
  const finished = await finishJob(env.DB, log, jobId, driverId, finalState, unique);
  if (!finished.success) return err(finished.error);
  if (!finished.data) {
    log.warn("Lost deletion lease before finishing; lease owner will close", { jobId });
    return ok(undefined);
  }

  const closedAudit = await recordAudit(env.DB, log, {
    action: finalState === "completed" ? "deletion.completed" : "deletion.incomplete",
    actorType: "system",
    subject: jobId,
    detail: { kind: job.kind, residuals: unique },
  });
  if (!closedAudit.success) {
    // The job row already records the outcome; recordAudit logged the failure.
    log.warn("Deletion outcome audit missing", { jobId, finalState });
  }
  log.info("Deletion job finished", { jobId, state: finalState, residuals: unique.length });
  return ok(undefined);
}

/**
 * Authoritative sweep (extends the 5-minute cron): re-drives every unfinished
 * job with a stale (or missing) heartbeat. The initial enqueue after a delete
 * request is only an optimization — this sweep is what guarantees completion.
 *
 * `incomplete` is intentionally TERMINAL here: `listUnfinishedJobs` excludes it,
 * so the sweep never auto-retries. A permanently-failing Artifacts repo would
 * otherwise loop forever; instead the residuals are recorded + audited for an
 * operator, who recovers by enqueueing a FRESH job for the same target once the
 * underlying fault clears (the cascade is idempotent, so it converges).
 */
export async function sweepDeletionJobs(env: Env, logger: Logger): Promise<void> {
  const log = logger.child({ component: "deletion-sweep" });
  const staleBefore = new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString();
  const jobsResult = await listUnfinishedJobs(env.DB, log, staleBefore);
  if (!jobsResult.success) {
    log.error("Failed to list unfinished deletion jobs", jobsResult.error);
    return;
  }
  // Sequential on purpose: one Worker invocation driving many cascades in
  // parallel would compound subrequest limits and D1 write contention.
  for (const job of jobsResult.data) {
    const result = await runDeletionJob(env, job.id, log);
    if (!result.success) {
      log.error("Failed to drive deletion job", result.error, { jobId: job.id });
    }
  }
}
