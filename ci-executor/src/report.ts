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
