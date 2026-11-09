/**
 * Validation of a deploy dispatch (#416) and of the executor's own
 * `DEPLOY_TARGETS`.
 *
 * The property under test: which credential a job's requests leave with is
 * decided by THIS Worker's configuration, keyed on the project id and
 * environment in the signed body. Nothing Stratum sends can name a secret,
 * and nothing a CI dispatch sends can produce a job that has one.
 */
import { describe, expect, it } from "vitest";
import { readDeploySecret, readDeployTargets } from "../src/config";
import { type DeployContext, parseDispatch } from "../src/dispatch";
import {
  COMMIT_SHA,
  CONFIG,
  DEPLOY_CONTEXT,
  DEPLOY_ID,
  DEPLOY_PROJECT_ID,
  DEPLOY_SECRET,
  DEPLOY_TARGETS,
  DEPLOY_TOKEN,
  STRATUM,
  deployDispatchBody,
  dispatchBody,
} from "./helpers/fixtures";

const NOW = Date.UTC(2026, 10, 9, 12);

function parse(
  overrides: Record<string, unknown> = {},
  context: DeployContext | undefined = DEPLOY_CONTEXT,
  config = CONFIG,
) {
  return parseDispatch(JSON.stringify(deployDispatchBody(NOW, overrides)), config, context);
}

function reason(overrides: Record<string, unknown>, context?: DeployContext): string {
  const result = parse(overrides, context ?? DEPLOY_CONTEXT);
  if (result.ok) throw new Error("dispatch was accepted");
  return result.reason;
}

describe("a valid deploy dispatch", () => {
  it("becomes a deploy job whose credentials come from the executor's own targets", () => {
    const result = parse();
    if (!result.ok) throw new Error(result.reason);
    const { job } = result;

    expect(job.profile.name).toBe("deploy");
    expect(job.profile.image).toBe("deploy");
    expect(job.profile.credentials).toEqual([
      { host: "api.cloudflare.com", secret: DEPLOY_SECRET },
    ]);
    expect(job.deploy).toEqual({
      deploymentId: DEPLOY_ID,
      projectId: DEPLOY_PROJECT_ID,
      environment: "staging",
      env: { CLOUDFLARE_ACCOUNT_ID: "acct123" },
    });
    expect(job.baseSha).toBe(COMMIT_SHA);
    expect(job.headSha).toBe(COMMIT_SHA);
    expect(job.diff).toBe("");
    expect(job.steps.map((step) => step.name)).toEqual(["migrate", "deploy", "smoke"]);
    // Each step's log has its own key under the deployment.
    expect(job.steps.map((step) => step.checkRunId)).toEqual([
      `${DEPLOY_ID}-0`,
      `${DEPLOY_ID}-1`,
      `${DEPLOY_ID}-2`,
    ]);
  });

  it("holds the name of the secret and never its value", () => {
    const result = parse();
    if (!result.ok) throw new Error(result.reason);
    expect(JSON.stringify(result.job)).not.toContain(DEPLOY_TOKEN);
  });

  it("reaches a credentialed host through the credential intercept only", () => {
    const result = parse({ job: { allowHosts: ["api.cloudflare.com", "status.example.com"] } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.job.profile.allowedHosts).not.toContain("api.cloudflare.com");
    expect(result.job.profile.allowedHosts).toEqual(
      expect.arrayContaining([
        "registry.npmjs.org",
        "app-staging.example.workers.dev",
        "status.example.com",
      ]),
    );
  });

  it("carries a rollback's version through as a label", () => {
    const result = parse({ rollback: { version: "0f1e2d3c-aaaa-bbbb-cccc-000000000000" } });
    if (!result.ok) throw new Error(result.reason);
    expect(result.job.deploy?.rollback).toEqual({
      version: "0f1e2d3c-aaaa-bbbb-cccc-000000000000",
    });
    expect(reason({ rollback: { version: "$(rm -rf /)" } })).toContain("rollback.version");
  });
});

describe("what a deploy dispatch cannot do", () => {
  it("name a credential: one in the body is ignored, the executor's is used", () => {
    const result = parse({
      credentials: [{ host: "evil.example.com", secret: "CI_EXECUTOR_SECRET" }],
      job: {
        profile: "deploy",
        credentials: [{ host: "evil.example.com", secret: "CI_EXECUTOR_SECRET" }],
      },
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.job.profile.credentials).toEqual([
      { host: "api.cloudflare.com", secret: DEPLOY_SECRET },
    ]);
    expect(JSON.stringify(result.job)).not.toContain("evil.example.com");
  });

  it("deploy a project or environment the executor has no target for", () => {
    expect(reason({ projectId: "prj_other" })).toContain("no deploy target for project prj_other");
    expect(reason({ environment: "production" })).toContain("environment 'production'");
  });

  it("run when a secret its target names is not set, and says which by name only", () => {
    const text = reason({}, { ...DEPLOY_CONTEXT, hasSecret: () => false });
    expect(text).toContain(DEPLOY_SECRET);
    expect(text).not.toContain(DEPLOY_TOKEN);
  });

  it("run on an executor with no deploy configuration at all", () => {
    const result = parseDispatch(JSON.stringify(deployDispatchBody(NOW)), CONFIG);
    expect(result).toEqual({ ok: false, reason: "this executor does not run deploy jobs" });
    expect(reason({}, { targets: { ok: true, targets: {} }, hasSecret: () => true })).toContain(
      "no deploy target",
    );
  });

  it("run when DEPLOY_TARGETS is broken", () => {
    const text = reason(
      {},
      { targets: { ok: false, reason: "DEPLOY_TARGETS is not valid JSON" }, hasSecret: () => true },
    );
    expect(text).toContain("misconfigured");
  });

  it("report anywhere but the executor's Stratum, or skip its limits", () => {
    expect(reason({ callbackUrl: "https://evil.example.com/api/deployments/callback" })).toContain(
      "callbackUrl",
    );
    expect(reason({ job: { logUrl: "https://evil.example.com/x" } })).toContain("logUrl");
    expect(reason({ job: { timeoutSeconds: 999_999 } })).toContain("time limit");
    expect(reason({ commitSha: "main" })).toContain("commitSha");
    expect(reason({ deploymentId: "../etc" })).toContain("deploymentId");
    expect(reason({ job: { profile: "ci" } })).toContain("unsupported job profile");
  });
});

describe("a CI dispatch", () => {
  it("cannot become a deploy job or carry a credential, whatever it says", () => {
    const body = dispatchBody(NOW, {
      deploymentId: DEPLOY_ID,
      projectId: DEPLOY_PROJECT_ID,
      environment: "staging",
      job: {
        credentials: [{ host: "api.cloudflare.com", secret: DEPLOY_SECRET }],
        logUrls: {
          lint: `${STRATUM}/api/changes/chg_1/checks/chk_lint/log`,
          test: `${STRATUM}/api/changes/chg_1/checks/chk_test/log`,
        },
      },
    });
    const result = parseDispatch(JSON.stringify(body), CONFIG, DEPLOY_CONTEXT);
    if (!result.ok) throw new Error(result.reason);
    expect(result.job.profile).toEqual({
      name: "ci",
      image: "ci",
      allowedHosts: ["registry.npmjs.org", "registry.yarnpkg.com", "nodejs.org"],
    });
    expect(result.job.deploy).toBeUndefined();
    expect(JSON.stringify(result.job)).not.toContain(DEPLOY_SECRET);
  });

  it("is refused if it asks for the deploy profile", () => {
    const body = dispatchBody(NOW, { job: { profile: "deploy" } });
    const result = parseDispatch(JSON.stringify(body), CONFIG, DEPLOY_CONTEXT);
    expect(result).toEqual({ ok: false, reason: "unsupported job profile" });
  });
});

describe("DEPLOY_TARGETS", () => {
  const read = (value: unknown) =>
    readDeployTargets({
      DEPLOY_TARGETS: typeof value === "string" ? value : JSON.stringify(value),
    });

  it("is empty, and valid, when unset", () => {
    expect(readDeployTargets({})).toEqual({ ok: true, targets: {} });
    expect(read("  ")).toEqual({ ok: true, targets: {} });
  });

  it("reads project, environment, credentials, plain variables and hosts", () => {
    expect(read(DEPLOY_TARGETS)).toEqual({ ok: true, targets: DEPLOY_TARGETS });
  });

  it("refuses a secret name outside the deploy prefix, so it cannot point at the shared secret", () => {
    for (const secret of ["CI_EXECUTOR_SECRET", "deploy_cred_x", "DEPLOY_CRED_", "TOKEN"]) {
      const result = read({
        prj_a: { staging: { credentials: [{ host: "api.cloudflare.com", secret }] } },
      });
      expect(result.ok, secret).toBe(false);
    }
  });

  it("refuses anything that is not an exact public hostname", () => {
    for (const host of [
      "*.cloudflare.com",
      "https://api.cloudflare.com",
      "10.0.0.1",
      "localhost",
    ]) {
      const result = read({
        prj_a: { staging: { credentials: [{ host, secret: DEPLOY_SECRET }] } },
      });
      expect(result.ok, host).toBe(false);
    }
  });

  it("refuses two credentials for one host", () => {
    const result = read({
      prj_a: {
        staging: {
          credentials: [
            { host: "api.cloudflare.com", secret: "DEPLOY_CRED_A" },
            { host: "api.cloudflare.com", secret: "DEPLOY_CRED_B" },
          ],
        },
      },
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("twice") });
  });

  it("refuses variables that would redirect a credentialed tool or stand in for a credential", () => {
    for (const name of [
      "CLOUDFLARE_API_BASE_URL",
      "CLOUDFLARE_API_TOKEN",
      "STRATUM_ENVIRONMENT",
      "NODE_EXTRA_CA_CERTS",
      "PATH",
    ]) {
      const result = read({ prj_a: { staging: { env: { [name]: "x" } } } });
      expect(result.ok, name).toBe(false);
    }
  });

  it("refuses unknown fields and malformed JSON, without echoing a value", () => {
    expect(read("{not json")).toEqual({ ok: false, reason: "DEPLOY_TARGETS is not valid JSON" });
    expect(read({ prj_a: { staging: { token: DEPLOY_TOKEN } } })).toMatchObject({
      ok: false,
      reason: expect.not.stringContaining(DEPLOY_TOKEN),
    });
    expect(read({ prj_a: { "Bad Env": {} } }).ok).toBe(false);
    expect(read([]).ok).toBe(false);
  });

  it("reads a secret's value only by a deploy secret's name", () => {
    const env = { DEPLOY_CRED_STAGING: ` ${DEPLOY_TOKEN}\n`, CI_EXECUTOR_SECRET: "shared" };
    expect(readDeploySecret(env, "DEPLOY_CRED_STAGING")).toBe(DEPLOY_TOKEN);
    expect(readDeploySecret(env, "CI_EXECUTOR_SECRET")).toBeUndefined();
    expect(readDeploySecret({ DEPLOY_CRED_EMPTY: "  " }, "DEPLOY_CRED_EMPTY")).toBeUndefined();
    expect(readDeploySecret(null, "DEPLOY_CRED_STAGING")).toBeUndefined();
  });
});
