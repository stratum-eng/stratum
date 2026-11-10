/**
 * Job logs: where they are kept and who may read them.
 *
 * A log is whatever the change's code printed, which for a private repository
 * is the repository. So the bucket is bound to this Worker and nothing else,
 * has no public access, and this Worker serves a log to exactly one caller:
 * Stratum, on a request signed with the shared secret. Stratum decides who may
 * see it — the people who can read the project — before it asks.
 */
import { verify } from "./signature";

/** How far a log request's timestamp may be from this Worker's clock. */
export const LOG_REQUEST_WINDOW_SECONDS = 300;

const CHECK_RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function logKey(checkRunId: string): string {
  return `logs/${checkRunId}.log`;
}

/** What Stratum signs: the method, the path and when. The path binds it to one run. */
export function logSigningInput(checkRunId: string, timestamp: string): string {
  return `GET\n/logs/${checkRunId}\n${timestamp}`;
}

function json(status: number, error: string, code: string): Response {
  return Response.json({ error, code }, { status });
}

export async function serveLog(
  request: Request,
  checkRunId: string,
  secret: string,
  bucket: Pick<R2Bucket, "get">,
  now: number = Date.now(),
): Promise<Response> {
  // One answer for every way a request can fail to be Stratum's, so the
  // endpoint cannot be used to find out which check run ids have logs.
  const unauthorized = () => json(401, "Invalid signature", "INVALID_SIGNATURE");
  if (!CHECK_RUN_ID.test(checkRunId)) return unauthorized();
  const timestamp = request.headers.get("X-Stratum-Timestamp") ?? "";
  if (!/^\d{1,12}$/.test(timestamp)) return unauthorized();
  if (Math.abs(now / 1000 - Number(timestamp)) > LOG_REQUEST_WINDOW_SECONDS) return unauthorized();
  const signed = await verify(
    secret,
    logSigningInput(checkRunId, timestamp),
    request.headers.get("X-Stratum-Signature"),
  );
  if (!signed) return unauthorized();

  const object = await bucket.get(logKey(checkRunId));
  if (object === null) return json(404, "No log is stored for this check run", "LOG_NOT_FOUND");
  return new Response(object.body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
