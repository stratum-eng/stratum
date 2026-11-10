/**
 * Reporting a step's status to Stratum: the check-run callback (#414).
 *
 * `POST <callbackUrl>/<checkRunId>`, signed over the exact bytes sent. There
 * is no credential on the request — the signature is the authentication.
 */
import type { JobRecord, OutgoingReport, SendOutcome } from "./job";
import { sign } from "./signature";

const REPORT_TIMEOUT_MS = 10_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function sendReport(
  secret: string,
  job: Pick<JobRecord, "callbackUrl" | "headSha">,
  report: OutgoingReport,
  fetchImpl: FetchLike = fetch,
): Promise<SendOutcome> {
  const body = JSON.stringify({
    checkRunId: report.checkRunId,
    headSha: job.headSha,
    status: report.status,
    sequence: report.sequence,
    ...(report.summary !== undefined ? { summary: report.summary } : {}),
    detailsUrl: report.detailsUrl,
  });
  let response: Response;
  try {
    response = await fetchImpl(`${job.callbackUrl}/${report.checkRunId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stratum-Signature": await sign(secret, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch {
    return "retry";
  }
  if (response.ok) return "delivered";
  if (response.status === 409) {
    let code: unknown;
    try {
      code = ((await response.json()) as { code?: unknown }).code;
    } catch {
      code = undefined;
    }
    // The revision was re-evaluated or the check re-run: this whole job is
    // testing something Stratum no longer wants an answer about.
    if (code === "STALE_REVISION" || code === "CHECK_SUPERSEDED") return "abort";
    // Already terminal, or past its deadline: this report is moot, the job is not.
    return "drop";
  }
  if (response.status === 429 || response.status >= 500) return "retry";
  console.error("report: Stratum refused a report", response.status);
  return "drop";
}

/**
 * Report a deploy job's outcome to Stratum: one signed request per
 * deployment, to `<callbackUrl>/<deploymentId>` (#416).
 *
 * Unlike a check report there is nothing to abort: the job is over by the
 * time this is sent. A `409` means the row is no longer waiting for this
 * report — Stratum gave the deployment up, or already has the result — and
 * retrying cannot change that.
 */
export async function sendDeployReport(
  secret: string,
  job: Pick<JobRecord, "callbackUrl" | "headSha" | "deploy">,
  report: OutgoingReport,
  fetchImpl: FetchLike = fetch,
): Promise<SendOutcome> {
  const body = JSON.stringify({
    deploymentId: report.checkRunId,
    commitSha: job.headSha,
    environment: job.deploy?.environment,
    status: report.status === "passed" ? "succeeded" : "failed",
    // Whether a step broke, or the job could not run it: both are a failed
    // deployment, but the remedy differs and the row should say which.
    cause: report.status === "passed" ? undefined : report.status,
    sequence: report.sequence,
    ...(report.summary !== undefined ? { summary: report.summary } : {}),
    steps: report.deploy?.steps ?? [],
    ...(report.deploy?.version !== undefined ? { version: report.deploy.version } : {}),
    ...(report.deploy?.url !== undefined ? { url: report.deploy.url } : {}),
    ...(report.deploy?.logTail !== undefined ? { logTail: report.deploy.logTail } : {}),
  });
  let response: Response;
  try {
    response = await fetchImpl(`${job.callbackUrl}/${report.checkRunId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Stratum-Signature": await sign(secret, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch {
    return "retry";
  }
  if (response.ok) return "delivered";
  if (response.status === 429 || response.status >= 500) return "retry";
  console.error("report: Stratum refused a deploy report", response.status);
  return "drop";
}
