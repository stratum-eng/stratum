/**
 * How a pipeline deployment ends (#416): the executor's signed report, or the
 * sweep that stops waiting for one.
 *
 * A pipeline deployment is `running` in D1 while its steps run in another
 * Worker. Exactly two things may finish it:
 *
 * - {@link applyDeployReport}: the executor says how the job ended. Verified
 *   against the instance's `CI_EXECUTOR_SECRET` — the same key, and the same
 *   construction, as a first-party check report — before anything is read.
 * - {@link sweepOverdueDeployments}: the row's lease ran out with no report.
 *   The row is failed, and says plainly that the real state of the
 *   environment is unknown. It is not re-run.
 *
 * Both then send an `advance` message, because what follows a finished
 * deployment (promoting it, starting whatever waited for its environment)
 * needs the repository and belongs on the deploy queue.
 */
import { MAX_LOG_TAIL } from "../deploy/limits";
import { redactAndTruncate } from "../deploy/redact";
import { hmacSha256Hex } from "../evaluation/signing-secret";
import { sendDeployMessage } from "../queue/deploy-queue";
import { type StratumEvent, emitEvent } from "../queue/events";
import {
  type Deployment,
  PIPELINE_TARGET,
  completeDeployment,
  findDeploymentById,
  getDeployment,
  listOverdueRunningDeployments,
} from "../storage/deployments";
import type { Env } from "../types";
import { constantTimeEqual } from "../utils/crypto";
import type { Logger } from "../utils/logger";
import { ciExecutorConfig } from "./ci-executor";

/** Largest report body accepted: a summary, sixteen step lines and a log tail. */
export const MAX_DEPLOY_REPORT_BODY_BYTES = 128 * 1024;

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;
const MAX_REASON_LENGTH = 1_000;
const MAX_STEPS = 16;
/** A version is a label handed back to a rollback: short, and never a script. */
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;

export type DeployReportOutcome =
  /** Missing, malformed or wrong signature, or no executor configured. One answer for all. */
  | { kind: "unauthenticated" }
  | { kind: "invalid"; message: string }
  /** Signed and well-formed, but there is no running deployment for it to finish. */
  | { kind: "conflict"; message: string }
  | { kind: "ok"; deployment: Deployment }
  | { kind: "error"; message: string };

interface DeployReport {
  status: "succeeded" | "failed";
  commitSha: string;
  cause?: string;
  summary?: string;
  steps: Array<{ name: string; status: string; summary?: string }>;
  version?: string;
  url?: string;
  logTail?: string;
}

/** Parse a verified report body for `deploymentId`, or say why it is unusable. */
function parseReport(raw: string, deploymentId: string): DeployReport | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "body is not valid JSON";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "body must be a JSON object";
  }
  const body = parsed as Record<string, unknown>;
  // The signature covers the body, and the body names the deployment: a
  // report signed for one deployment cannot be replayed at another's URL.
  if (body.deploymentId !== deploymentId) {
    return "deploymentId must equal the deployment id in the URL";
  }
  if (body.status !== "succeeded" && body.status !== "failed") {
    return "status must be succeeded or failed";
  }
  if (typeof body.commitSha !== "string" || body.commitSha === "") return "commitSha is required";

  const report: DeployReport = { status: body.status, commitSha: body.commitSha, steps: [] };
  if (typeof body.cause === "string") report.cause = body.cause.slice(0, 40);
  if (typeof body.summary === "string") report.summary = body.summary;
  if (Array.isArray(body.steps)) {
    for (const entry of body.steps.slice(0, MAX_STEPS) as unknown[]) {
      if (typeof entry !== "object" || entry === null) continue;
      const step = entry as Record<string, unknown>;
      if (typeof step.name !== "string" || typeof step.status !== "string") continue;
      report.steps.push({
        name: step.name.slice(0, 64),
        status: step.status.slice(0, 20),
        ...(typeof step.summary === "string" ? { summary: step.summary.slice(0, 500) } : {}),
      });
    }
  }
  // Both are written by code that ran in the job's container. They are stored
  // and shown, so they are checked as data again here, whatever the executor
  // already did: a version is a short label, a URL is a plain https link.
  if (typeof body.version === "string" && VERSION_PATTERN.test(body.version)) {
    report.version = body.version;
  }
  if (typeof body.url === "string" && body.url.length <= 2048) {
    try {
      const url = new URL(body.url);
      if (url.protocol === "https:" && url.username === "" && url.password === "") {
        report.url = url.toString();
      }
    } catch {
      // Not a URL: nothing is recorded.
    }
  }
  if (typeof body.logTail === "string") report.logTail = body.logTail;
  return report;
}

/** The row's log tail: one line per step, then the end of the last step's output. */
function logTailOf(report: DeployReport): string | null {
  const lines = report.steps.map(
    (step) => `[${step.status}] ${step.name}${step.summary ? ` — ${step.summary}` : ""}`,
  );
  const text = [lines.join("\n"), report.logTail ?? ""].filter((part) => part !== "").join("\n\n");
  // No secret values to redact against: Stratum holds none for a pipeline, and
  // the job that produced this output held none either. Truncated only.
  return text === "" ? null : redactAndTruncate(text, [], MAX_LOG_TAIL);
}

function failureReason(report: DeployReport): string {
  const summary = report.summary ?? "The deploy job did not finish.";
  return report.cause === "errored"
    ? `The deploy job could not run to the end. ${summary}`
    : summary;
}

/** Announce a finished deployment to the project's webhooks. Never affects the outcome. */
async function emitFinished(
  env: Env,
  logger: Logger,
  deployment: Deployment,
  outcome: { succeeded: boolean; url?: string; reason?: string },
): Promise<void> {
  const base = {
    project: deployment.project,
    deploymentId: deployment.id,
    name: deployment.name,
    target: deployment.target,
    commit: deployment.commitSha,
  };
  const event: StratumEvent = outcome.succeeded
    ? {
        type: "deployment.succeeded",
        ...base,
        ...(outcome.url !== undefined ? { url: outcome.url } : {}),
      }
    : { type: "deployment.failed", ...base, reason: outcome.reason ?? "Deployment failed" };
  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE ?? null,
    event,
    { type: "system" },
    logger,
    deployment.projectId,
  );
}

/**
 * Apply the executor's report on one pipeline deployment.
 *
 * The signature is checked before the deployment is looked up, and every
 * failure up to that point is the same `unauthenticated`: an unsigned caller
 * learns nothing about which deployment ids exist.
 *
 * Only a `running` pipeline row can be finished this way. A row that is
 * `queued` or `pending_approval` was never handed to the executor, and a
 * terminal one already has its result (a redelivered report, or one that
 * arrived after the sweep gave up) — both are a `conflict`, which tells the
 * executor to stop retrying.
 */
export async function applyDeployReport(
  env: Env,
  logger: Logger,
  args: { deploymentId: string; rawBody: string; signatureHeader: string | undefined; now?: Date },
): Promise<DeployReportOutcome> {
  const now = args.now ?? new Date();
  const presented = SIGNATURE_PATTERN.exec(args.signatureHeader ?? "")?.[1]?.toLowerCase();
  if (presented === undefined) return { kind: "unauthenticated" };
  const executor = ciExecutorConfig(env);
  if (executor.status !== "configured") {
    logger.warn("Deploy report refused: no executor is configured", { reason: executor.reason });
    return { kind: "unauthenticated" };
  }
  const expected = await hmacSha256Hex(executor.secret, args.rawBody);
  if (!constantTimeEqual(presented, expected)) {
    logger.warn("Deploy report refused: signature mismatch", { deploymentId: args.deploymentId });
    return { kind: "unauthenticated" };
  }

  const report = parseReport(args.rawBody, args.deploymentId);
  if (typeof report === "string") return { kind: "invalid", message: report };

  const found = await findDeploymentById(env.DB, logger, args.deploymentId);
  if (!found.success) return { kind: "error", message: "Could not read the deployment" };
  const deployment = found.data;
  if (deployment === null || deployment.target !== PIPELINE_TARGET) {
    return { kind: "conflict", message: "There is no pipeline deployment with this id" };
  }
  if (report.commitSha !== deployment.commitSha) {
    return { kind: "conflict", message: "commitSha is not the commit this deployment is for" };
  }
  if (deployment.status !== "running") {
    return { kind: "conflict", message: `The deployment is ${deployment.status}, not running` };
  }

  // A rollback that ran `wrangler rollback` put the target's version back; if
  // its steps recorded none of their own, that is the version now live.
  let version = report.version;
  if (version === undefined && deployment.rollbackOf !== undefined) {
    const target = await getDeployment(env.DB, logger, {
      projectId: deployment.projectId,
      deploymentId: deployment.rollbackOf,
    });
    if (target.success && target.data?.version !== undefined) version = target.data.version;
  }

  const succeeded = report.status === "succeeded";
  const reason = succeeded ? null : redactAndTruncate(failureReason(report), [], MAX_REASON_LENGTH);
  const startedAt =
    deployment.startedAt !== undefined ? Date.parse(deployment.startedAt) : Number.NaN;
  const completed = await completeDeployment(env.DB, logger, {
    projectId: deployment.projectId,
    deploymentId: deployment.id,
    status: report.status,
    reason,
    url: succeeded ? (report.url ?? null) : null,
    logTail: logTailOf(report),
    durationMs: Number.isFinite(startedAt) ? Math.max(0, now.getTime() - startedAt) : null,
    version: version ?? null,
    completedAt: now.toISOString(),
    onlyIfRunning: true,
  });
  if (!completed.success) return { kind: "error", message: "Could not record the deployment" };
  if (!completed.data) {
    // Lost a race with another report or the sweep. Nothing was written.
    return { kind: "conflict", message: "The deployment is no longer running" };
  }

  await emitFinished(env, logger, deployment, {
    succeeded,
    ...(report.url !== undefined ? { url: report.url } : {}),
    ...(reason !== null ? { reason } : {}),
  });
  const advanced = await sendDeployMessage(env, logger, {
    message: { kind: "advance", projectId: deployment.projectId, deploymentId: deployment.id },
    project: deployment.project,
  });
  if (!advanced) {
    // The result is recorded and stays recorded. What is lost is the follow-up:
    // the next environment is not created and a waiting deployment is not
    // started until someone retries or the next merge arrives.
    logger.error("Deployment finished but its follow-up could not be queued", undefined, {
      deploymentId: deployment.id,
      projectId: deployment.projectId,
    });
  }

  const after = await getDeployment(env.DB, logger, {
    projectId: deployment.projectId,
    deploymentId: deployment.id,
  });
  return { kind: "ok", deployment: after.success && after.data ? after.data : deployment };
}

/** Stamped on a pipeline deployment whose executor never reported. */
export const NO_REPORT_REASON =
  "The CI executor did not report on this deployment before its time ran out. Its steps may have run in part or in full: check the environment before retrying. Stratum does not re-run it automatically.";

/**
 * Fail every pipeline deployment whose lease ran out while `running`, and let
 * whatever was waiting for its environment proceed.
 *
 * Cron-driven, like the check-run deadline sweep. Bounded per run; anything
 * left over is picked up five minutes later.
 *
 * @returns How many deployments were failed.
 */
export async function sweepOverdueDeployments(
  env: Env,
  logger: Logger,
  now: Date = new Date(),
): Promise<number> {
  if (!env.DB) return 0;
  const overdue = await listOverdueRunningDeployments(env.DB, logger, { now: now.toISOString() });
  if (!overdue.success) return 0;

  let failed = 0;
  for (const deployment of overdue.data) {
    const completed = await completeDeployment(env.DB, logger, {
      projectId: deployment.projectId,
      deploymentId: deployment.id,
      status: "failed",
      reason: NO_REPORT_REASON,
      completedAt: now.toISOString(),
      onlyIfRunning: true,
    });
    // False means a report landed between the query and this write: it wins.
    if (!completed.success || !completed.data) continue;
    failed++;
    logger.warn("Pipeline deployment failed: no report before its lease expired", {
      deploymentId: deployment.id,
      projectId: deployment.projectId,
      name: deployment.name,
    });
    await emitFinished(env, logger, deployment, { succeeded: false, reason: NO_REPORT_REASON });
    await sendDeployMessage(env, logger, {
      message: { kind: "advance", projectId: deployment.projectId, deploymentId: deployment.id },
      project: deployment.project,
    });
  }
  return failed;
}
