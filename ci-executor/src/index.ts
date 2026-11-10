/**
 * Stratum's first-party CI executor (#415, ADR 012).
 *
 * A separate Worker from Stratum on purpose: it runs code from changes nobody
 * has reviewed yet, so it is deployed with nothing worth stealing. No D1, no
 * session store, no Artifacts binding, no deploy credential — a job dispatch
 * brings the one short-lived, read-only repository token the job needs, and
 * that token is used here, in the Worker, never inside a container.
 *
 *   POST /jobs             a signed dispatch from Stratum; 202 running or queued
 *   GET  /logs/:checkRunId a step's log, to Stratum only (signed request)
 *   GET  /health           whether this deployment is configured
 *
 * Everything this module exports is a handler or a class the runtime looks up
 * by name; workerd refuses to start a Worker whose entry module exports
 * anything else, so constants live in the modules beside it.
 */
import { type Env, MAX_DISPATCH_BYTES, readConfig } from "./config";
import type { Coordinator } from "./coordinator";
import { parseDispatch } from "./dispatch";
import type { JobRunner } from "./job-object";
import { serveLog } from "./logs";
import { verify } from "./signature";

export { Coordinator } from "./coordinator";
export { EgressAllowlist, GitProxy } from "./egress";
export { JobRunner } from "./job-object";

/** A job must be able to start this long before its repository token expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** Room after a job's own limit for its last report to reach Stratum in time. */
const REPORT_MARGIN_MS = 60_000;

function refuse(status: number, error: string, code: string): Response {
  return Response.json({ error, code }, { status });
}

/** Read at most `limit` bytes of a body; null when it is larger. */
async function readBody(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function submitJob(request: Request, env: Env): Promise<Response> {
  const loaded = readConfig(env);
  if (!loaded.ok) {
    console.error("executor: not configured", loaded.reason);
    return refuse(503, `The CI executor is not configured: ${loaded.reason}`, "NOT_CONFIGURED");
  }
  const { config } = loaded;

  const raw = await readBody(request, MAX_DISPATCH_BYTES);
  if (raw === null) {
    return refuse(
      413,
      `The change is too large for the CI executor (dispatch over ${MAX_DISPATCH_BYTES} bytes)`,
      "DISPATCH_TOO_LARGE",
    );
  }
  // Verified over the bytes as received, before a single one is parsed. The
  // body is never logged: it holds a repository token.
  if (!(await verify(config.secret, raw, request.headers.get("X-Stratum-Signature")))) {
    return refuse(401, "Invalid signature", "INVALID_SIGNATURE");
  }
  const parsed = parseDispatch(raw, config);
  if (!parsed.ok) return refuse(400, parsed.reason, "INVALID_DISPATCH");
  const { job } = parsed;

  const now = Date.now();
  const timeoutMs = job.timeoutSeconds * 1000;
  const startBy = Math.min(
    job.deadline - timeoutMs - REPORT_MARGIN_MS,
    job.repository.expiresAt - TOKEN_MARGIN_MS,
  );
  if (startBy <= now) {
    return refuse(
      400,
      "The job could not finish before its checks' deadline or its repository token's expiry",
      "INVALID_DISPATCH",
    );
  }

  const jobId = crypto.randomUUID();
  const jobs = env.JOB as unknown as DurableObjectNamespace<JobRunner>;
  const runner = jobs.get(jobs.idFromName(jobId));
  const coordinators = env.COORDINATOR as unknown as DurableObjectNamespace<Coordinator>;
  const coordinator = coordinators.get(coordinators.idFromName("coordinator"));

  // Stored before it is admitted, so a job the coordinator promotes out of the
  // queue always has something to run.
  await runner.accept(jobId, job);
  let decision: Awaited<ReturnType<Coordinator["submit"]>>;
  try {
    decision = await coordinator.submit(jobId, { timeoutMs, startBy });
  } catch (error) {
    // The coordinator did not answer. The job was stored with its repository
    // token and now has no owner and no alarm, so nothing would ever delete
    // it. Discard it here; Stratum sees the failure and can dispatch again.
    console.error("executor: admission failed", String(error));
    // `submit` may have saved its decision before it failed, or its answer
    // may have been lost, so the job can hold a slot or a queue place the
    // caller never heard about. Releasing is harmless when it holds neither.
    await coordinator.release(jobId).catch((cleanup: unknown) => {
      console.error("executor: could not release after a failed admission", String(cleanup));
    });
    await runner.discard().catch((cleanup: unknown) => {
      // Not lost for good: a stored job deletes itself once its checks'
      // deadline has passed (`expireIfAbandoned`).
      console.error("executor: could not discard after a failed admission", String(cleanup));
    });
    return refuse(503, "The executor could not admit the job; try again", "ADMISSION_FAILED");
  }
  if (decision.decision === "refused") {
    await runner.discard();
    return refuse(429, decision.reason, "AT_CAPACITY");
  }
  if (decision.decision === "start") {
    try {
      await runner.begin();
    } catch (error) {
      // Admitted but never started. Give the slot back and drop the stored
      // job, or the slot stays taken until its timeout while Stratum's retry
      // queues behind a job that does not exist.
      console.error("executor: could not start an admitted job", String(error));
      await coordinator.release(jobId).catch((cleanup: unknown) => {
        // The coordinator takes the slot back on its own clock regardless.
        console.error("executor: could not release after a failed start", String(cleanup));
      });
      await runner.discard().catch((cleanup: unknown) => {
        console.error("executor: could not discard after a failed start", String(cleanup));
      });
      return refuse(503, "The executor could not start the job; try again", "START_FAILED");
    }
  }
  return Response.json(
    { jobId, state: decision.decision === "start" ? "running" : "queued" },
    {
      status: 202,
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/jobs") return submitJob(request, env);

    const log = /^\/logs\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && log?.[1] !== undefined) {
      const loaded = readConfig(env);
      if (!loaded.ok) return refuse(503, "The CI executor is not configured", "NOT_CONFIGURED");
      return serveLog(request, log[1], loaded.config.secret, env.LOGS);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const loaded = readConfig(env);
      // Says which setting is wrong, never what it is set to.
      return Response.json(loaded.ok ? { ok: true } : { ok: false, reason: loaded.reason }, {
        status: loaded.ok ? 200 : 503,
      });
    }
    return refuse(404, "Not found", "NOT_FOUND");
  },
};
