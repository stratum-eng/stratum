/**
 * The deploy profile of the job state machine (#416), against the same fake
 * `ctx.container` the CI tests use.
 *
 * Two kinds of assertion live here. The first is behaviour: a pipeline stops
 * at its first failing step, and a deployment is reported once. The second is
 * the boundary this profile exists for, checked at the executor's own level
 * rather than by reading the code: the deploy credential's VALUE is in
 * nothing that enters the container and nothing the job stores, and a CI job
 * has no way to get a credentialed handler registered at all.
 */
import { describe, expect, it, vi } from "vitest";
import { GIT_HOST, readDeploySecret } from "../src/config";
import type { Job } from "../src/dispatch";
import type { CredentialProxyProps } from "../src/egress";
import {
  type JobDeps,
  JobMachine,
  type OutgoingReport,
  PLACEHOLDER_API_TOKEN,
  type SendOutcome,
} from "../src/job";
import { type EgressExports, egressFor } from "../src/job-object";
import { FakeContainer, FakeStorage } from "./helpers/fake-container";
import {
  COMMIT_SHA,
  DEPLOY_ID,
  DEPLOY_SECRET,
  DEPLOY_TOKEN,
  makeDeployJob,
  makeJob,
} from "./helpers/fixtures";

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);

/** The Worker's environment, holding the credential the way a Wrangler secret does. */
const WORKER_ENV = { [DEPLOY_SECRET]: DEPLOY_TOKEN };

type Handler = { handler: string; props: unknown };

/**
 * `ctx.exports`, as the runtime provides it: loopback bindings built from
 * props. The credentialed one resolves its secret from the Worker's
 * environment exactly as the real entrypoint does — so if anything in the
 * machine could reach the value, this is where it would have to come from.
 */
function fakeExports() {
  const credentialRequests: CredentialProxyProps[] = [];
  const exports: EgressExports = {
    GitProxy: ({ props }) => ({ handler: "git", props }) as unknown as Fetcher,
    EgressAllowlist: ({ props }) => ({ handler: "allowlist", props }) as unknown as Fetcher,
    DeployCredentialProxy: ({ props }) => {
      credentialRequests.push(props);
      // What the handler would send upstream; never returned to the machine.
      void readDeploySecret(WORKER_ENV, props.secret);
      return { handler: "credential", props } as unknown as Fetcher;
    },
  };
  return { exports, credentialRequests };
}

function harness(options: { job: Job; profile: "ci" | "deploy" }) {
  const clock = { now: T0 };
  const container = new FakeContainer();
  const storage = new FakeStorage();
  const sent: OutgoingReport[] = [];
  const logs = new Map<string, string>();
  const { exports, credentialRequests } = fakeExports();
  const control = { released: 0, respond: (_report: OutgoingReport): SendOutcome => "delivered" };
  const deps: JobDeps = {
    container,
    images: { ci: "registry/ci@sha256:1", deploy: "registry/deploy@sha256:2" },
    storage,
    now: () => clock.now,
    egress: egressFor(options.profile, exports),
    send: async (_job, report) => {
      const outcome = control.respond(report);
      if (outcome === "delivered") sent.push(report);
      return outcome;
    },
    putLog: async (id, body) => {
      logs.set(id, new TextDecoder().decode(body));
    },
    release: async () => {
      control.released++;
    },
    logMaxBytes: 1024 * 1024,
  };
  const machine = new JobMachine(deps);
  async function run(maxTicks = 400): Promise<void> {
    let delay: number | null = 0;
    for (let i = 0; i < maxTicks && delay !== null; i++) {
      clock.now += Math.max(delay, 1);
      delay = await machine.tick();
    }
  }
  async function begin(): Promise<void> {
    expect(await machine.accept(options.job)).toBe(true);
    expect(await machine.begin()).toBe(0);
  }
  /** Everything the job ever stored, as one searchable string. */
  const everythingStored = () => JSON.stringify([...storage.data.entries()]);
  return {
    clock,
    container,
    storage,
    sent,
    logs,
    control,
    credentialRequests,
    machine_tick: () => machine.tick(),
    run,
    begin,
    everythingStored,
  };
}

/** The script a step was started with — read from the record, which outlives the container. */
const scriptOf = (container: FakeContainer, id: string) =>
  container.execs.find((exec) => exec.cmd[2] === "start" && exec.cmd[3] === id)?.stdin;

const handlerOf = (container: FakeContainer, host: string) =>
  container.intercepts.get(host) as Handler | undefined;

describe("a deploy job that runs to the end", () => {
  it("runs the pipeline's steps in order and reports the deployment once", async () => {
    const h = harness({ job: makeDeployJob(T0), profile: "deploy" });
    h.container.script("s0", { output: "2 migrations applied\n", exit: { exitCode: 0 } });
    h.container.script("s1", {
      output: "Uploaded app\nCurrent Version ID: 11111111-2222-3333-4444-555555555555\n",
      exit: { exitCode: 0 },
      writes: {
        "/job/out/version": "11111111-2222-3333-4444-555555555555\n",
        "/job/out/url": "https://app-staging.example.workers.dev\n",
      },
    });
    h.container.script("s2", { output: "ok\n", exit: { exitCode: 0 } });
    await h.begin();
    await h.run();

    // One report for the whole deployment: no per-step check runs.
    expect(h.sent).toHaveLength(1);
    const report = h.sent[0];
    expect(report?.checkRunId).toBe(DEPLOY_ID);
    expect(report?.status).toBe("passed");
    expect(report?.deploy?.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "migrate:passed",
      "deploy:passed",
      "smoke:passed",
    ]);
    expect(report?.deploy?.version).toBe("11111111-2222-3333-4444-555555555555");
    expect(report?.deploy?.url).toBe("https://app-staging.example.workers.dev/");
    expect(scriptOf(h.container, "s0")).toContain("d1 migrations apply");
    expect(h.logs.get(`${DEPLOY_ID}-1`)).toContain("Current Version ID");
    expect(h.control.released).toBe(1);
    expect(h.container.running).toBe(false);
  });

  it("starts the deploy image, with no internet, and checks out the commit without a diff", async () => {
    const h = harness({ job: makeDeployJob(T0), profile: "deploy" });
    await h.begin();
    await h.run();

    expect(h.container.starts).toHaveLength(1);
    expect(h.container.starts[0]).toMatchObject({
      image: "registry/deploy@sha256:2",
      enableInternet: false,
      labels: { profile: "deploy" },
    });
    const prepare = h.container.execs.find(
      (exec) => exec.cmd[2] === "start" && exec.cmd[3] === "prepare",
    );
    expect(prepare?.env).toMatchObject({ BASE_SHA: COMMIT_SHA, STRATUM_JOB_PROFILE: "deploy" });
    expect(prepare?.env).not.toHaveProperty("HEAD_TREE_SHA");
    expect(h.container.files.has("/job/change.diff")).toBe(false);
  });

  it("gives the steps the target's plain variables and the deployment's identity", async () => {
    const h = harness({ job: makeDeployJob(T0), profile: "deploy" });
    await h.begin();
    await h.run();

    const step = h.container.execs.find((exec) => exec.cmd[2] === "start" && exec.cmd[3] === "s1");
    expect(step?.env).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: "acct123",
      STRATUM_ENVIRONMENT: "staging",
      STRATUM_DEPLOYMENT_ID: DEPLOY_ID,
      STRATUM_COMMIT_SHA: COMMIT_SHA,
      STRATUM_DEPLOY_VERSION_FILE: "/job/out/version",
      // A fixed public string, so Wrangler runs non-interactively. Not a token.
      CLOUDFLARE_API_TOKEN: PLACEHOLDER_API_TOKEN,
    });
    expect(step?.env).not.toHaveProperty("STRATUM_ROLLBACK_VERSION");
  });

  it("drops a recorded version or URL that is not a plain label or an https URL", async () => {
    const h = harness({ job: makeDeployJob(T0), profile: "deploy" });
    h.container.script("s2", {
      exit: { exitCode: 0 },
      writes: { "/job/out/version": "$(curl evil)\n", "/job/out/url": "javascript:alert(1)" },
    });
    await h.begin();
    await h.run();

    expect(h.sent[0]?.status).toBe("passed");
    expect(h.sent[0]?.deploy).not.toHaveProperty("version");
    expect(h.sent[0]?.deploy).not.toHaveProperty("url");
  });
});

describe("a deploy job whose step fails", () => {
  it("stops at the failing step, never starts the ones after it, and reports failed with the log", async () => {
    const h = harness({ job: makeDeployJob(T0), profile: "deploy" });
    h.container.script("s0", {
      output: "applying 079_add_column.sql\nERROR: duplicate column name\n",
      exit: { exitCode: 1 },
      // Even if a step claims a version, a failed deployment records none.
      writes: { "/job/out/version": "should-not-be-recorded" },
    });
    await h.begin();
    await h.run();

    expect(scriptOf(h.container, "s0")).toBeDefined();
    expect(scriptOf(h.container, "s1")).toBeUndefined();
    expect(scriptOf(h.container, "s2")).toBeUndefined();

    expect(h.sent).toHaveLength(1);
    const report = h.sent[0];
    expect(report?.status).toBe("failed");
    expect(report?.summary).toContain("Step 'migrate' failed");
    expect(report?.deploy?.steps.map((step) => `${step.name}:${step.status}`)).toEqual([
      "migrate:failed",
      "deploy:skipped",
      "smoke:skipped",
    ]);
    expect(report?.deploy?.logTail).toContain("duplicate column name");
    expect(report?.deploy).not.toHaveProperty("version");
    expect(h.container.running).toBe(false);
    expect(h.control.released).toBe(1);
  });

  it("reports errored, not failed, when the job outlives its wall clock", async () => {
    const h = harness({ job: makeDeployJob(T0, { timeoutSeconds: 120 }), profile: "deploy" });
    // A step that never exits.
    h.container.script("s0", { output: "waiting…\n" });
    await h.begin();
    await h.run();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.status).toBe("errored");
    expect(h.sent[0]?.deploy?.steps[0]?.status).toBe("errored");
    expect(h.container.running).toBe(false);
  });

  it("writes a failed checkout's log once, not once per step", async () => {
    const h = harness({ job: makeDeployJob(T0), profile: "deploy" });
    h.container.script("prepare", {
      output: "prepare: base commit is not in the repository\n",
      exit: { exitCode: 4 },
    });
    await h.begin();
    await h.run();

    expect(h.sent[0]?.status).toBe("errored");
    expect([...h.logs.keys()]).toEqual([`${DEPLOY_ID}-0`]);
    expect(h.sent[0]?.deploy?.logTail).toContain("not in the repository");
  });
});

describe("a rollback job", () => {
  it("passes the recorded version to the steps", async () => {
    const job = makeDeployJob(T0);
    const h = harness({
      job: { ...job, deploy: { ...job.deploy, rollback: { version: "v-old-123" } } } as Job,
      profile: "deploy",
    });
    await h.begin();
    await h.run();

    const step = h.container.execs.find((exec) => exec.cmd[2] === "start" && exec.cmd[3] === "s0");
    expect(step?.env).toMatchObject({
      STRATUM_ROLLBACK: "true",
      STRATUM_ROLLBACK_VERSION: "v-old-123",
    });
  });
});

describe("where the deploy credential is, and is not", () => {
  it("is in nothing passed into the container and nothing the job stores", async () => {
    const h = harness({ job: makeDeployJob(T0), profile: "deploy" });
    h.container.script("s1", { output: "deployed\n", exit: { exitCode: 0 } });
    await h.begin();

    // Inspected mid-job, before storage is cleared, and again at the end.
    let delay: number | null = 0;
    let sawStepRunning = false;
    for (let i = 0; i < 400 && delay !== null; i++) {
      h.clock.now += Math.max(delay, 1);
      delay = await h.machine_tick();
      expect(h.everythingStored()).not.toContain(DEPLOY_TOKEN);
      expect(h.container.everythingPassedIn()).not.toContain(DEPLOY_TOKEN);
      if (h.container.startedScript("s1") !== undefined) sawStepRunning = true;
    }
    expect(sawStepRunning).toBe(true);

    expect(h.container.everythingPassedIn()).not.toContain(DEPLOY_TOKEN);
    expect(JSON.stringify(h.sent)).not.toContain(DEPLOY_TOKEN);
    expect(JSON.stringify([...h.logs.entries()])).not.toContain(DEPLOY_TOKEN);
    // The intercept is registered by NAME of the secret, for the one host.
    expect(handlerOf(h.container, "api.cloudflare.com")).toEqual({
      handler: "credential",
      props: { host: "api.cloudflare.com", secret: DEPLOY_SECRET },
    });
    expect(h.credentialRequests).toEqual([{ host: "api.cloudflare.com", secret: DEPLOY_SECRET }]);
  });

  it("registers the credentialed handler before the container starts, and only for its host", async () => {
    const h = harness({ job: makeDeployJob(T0), profile: "deploy" });
    await h.begin();
    await h.run();

    const start = h.container.events.indexOf("start");
    expect(h.container.events.indexOf("intercept:api.cloudflare.com")).toBeLessThan(start);
    expect(handlerOf(h.container, "registry.npmjs.org")?.handler).toBe("allowlist");
    expect(handlerOf(h.container, "app-staging.example.workers.dev")?.handler).toBe("allowlist");
    // The repository proxy is closed once the checkout is built, as for CI.
    expect(handlerOf(h.container, GIT_HOST)).toEqual({
      handler: "allowlist",
      props: { hosts: [] },
    });
  });
});

describe("a CI job cannot obtain the deploy credential", () => {
  it("the CI profile's egress has no way to construct a credentialed handler", () => {
    const { exports, credentialRequests } = fakeExports();
    const egress = egressFor("ci", exports);

    expect(egress.credential).toBeUndefined();
    expect(Object.keys(egress).sort()).toEqual(["allowlist", "git"]);
    expect(egressFor("deploy", exports).credential).toBeTypeOf("function");
    expect(credentialRequests).toEqual([]);
  });

  it("a CI job reaches the credential's host, if allowed at all, with no credential", async () => {
    // The project's own ci.yaml allowlists the Cloudflare API.
    const job = makeJob(T0, {
      profile: {
        name: "ci",
        image: "ci",
        allowedHosts: ["registry.npmjs.org", "api.cloudflare.com"],
      },
    });
    const h = harness({ job, profile: "ci" });
    await h.begin();
    await h.run();

    expect(h.credentialRequests).toEqual([]);
    expect(handlerOf(h.container, "api.cloudflare.com")?.handler).toBe("allowlist");
    for (const handler of h.container.intercepts.values()) {
      expect((handler as Handler).handler).not.toBe("credential");
    }
    const step = h.container.execs.find((exec) => exec.cmd[2] === "start" && exec.cmd[3] === "s0");
    expect(step?.env).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
  });

  it("a CI job that somehow names a credential does not start, in the CI class", async () => {
    const job = makeJob(T0, {
      profile: {
        name: "ci",
        image: "ci",
        allowedHosts: ["registry.npmjs.org"],
        credentials: [{ host: "api.cloudflare.com", secret: DEPLOY_SECRET }],
      },
    });
    const h = harness({ job, profile: "ci" });
    await h.begin();
    await h.run();

    expect(h.container.starts).toHaveLength(0);
    expect(h.credentialRequests).toEqual([]);
    expect(h.sent.every((report) => report.status === "errored")).toBe(true);
  });

  it("nor in the deploy class: the profile on the job is checked as well as the class", async () => {
    const job = makeJob(T0, {
      profile: {
        name: "ci",
        image: "ci",
        allowedHosts: ["registry.npmjs.org"],
        credentials: [{ host: "api.cloudflare.com", secret: DEPLOY_SECRET }],
      },
    });
    // Even handed the deploy profile's egress, a job whose profile is `ci`
    // gets no credentialed intercept.
    const h = harness({ job, profile: "deploy" });
    await h.begin();
    await h.run();

    expect(h.container.starts).toHaveLength(0);
    expect(h.credentialRequests).toEqual([]);
  });

  it("the secret reader gives up nothing for a name outside the deploy prefix", () => {
    const env = { CI_EXECUTOR_SECRET: "the-shared-secret", [DEPLOY_SECRET]: DEPLOY_TOKEN };
    expect(readDeploySecret(env, "CI_EXECUTOR_SECRET")).toBeUndefined();
    expect(readDeploySecret(env, "DEPLOY_CRED_MISSING")).toBeUndefined();
    expect(readDeploySecret(env, DEPLOY_SECRET)).toBe(DEPLOY_TOKEN);
    expect(vi.isMockFunction(readDeploySecret)).toBe(false);
  });
});
