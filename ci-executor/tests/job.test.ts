/**
 * The job state machine against a fake `ctx.container` (see
 * tests/helpers/fake-container.ts, written from Cloudflare's documented API).
 *
 * Time is a variable the test owns, so "the step outlived its limit" and "the
 * job outlived its wall clock" are things a test makes happen rather than
 * waits for.
 */
import { describe, expect, it } from "vitest";
import { GIT_HOST } from "../src/config";
import type { Job } from "../src/dispatch";
import {
  type JobDeps,
  JobMachine,
  type JobState,
  type OutgoingReport,
  type SendOutcome,
} from "../src/job";
import { FakeContainer, FakeStorage } from "./helpers/fake-container";
import { HEAD_TREE_SHA, REPO_PASSWORD, REPO_URL, makeJob } from "./helpers/fixtures";

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const IMAGE = "registry.cloudflare.com/acct/stratum-ci@sha256:abc";

function harness(options: { job?: Partial<Job>; logMaxBytes?: number } = {}) {
  const clock = { now: T0 };
  const container = new FakeContainer();
  const storage = new FakeStorage();
  const sent: OutgoingReport[] = [];
  const logs = new Map<string, string>();
  const control = {
    released: 0,
    images: { ci: IMAGE } as Record<string, string>,
    respond: (_report: OutgoingReport): SendOutcome => "delivered",
    failRelease: false,
    failLogs: false,
  };
  const deps: JobDeps = {
    container,
    get images() {
      return control.images;
    },
    storage,
    now: () => clock.now,
    egress: {
      git: (props) => ({ handler: "git", props }) as unknown as Fetcher,
      allowlist: (props) => ({ handler: "allowlist", props }) as unknown as Fetcher,
    },
    send: async (_job, report) => {
      const outcome = control.respond(report);
      if (outcome === "delivered") sent.push(report);
      return outcome;
    },
    putLog: async (checkRunId, body) => {
      if (control.failLogs) throw new Error("bucket unavailable");
      logs.set(checkRunId, new TextDecoder().decode(body));
    },
    release: async () => {
      if (control.failRelease) throw new Error("coordinator unreachable");
      control.released++;
    },
    logMaxBytes: options.logMaxBytes ?? 1024 * 1024,
  };
  const machine = new JobMachine(deps);
  const job = makeJob(T0, options.job);

  /** Tick until the job is done or `until` says stop, moving the clock by each delay. */
  async function run(until: () => boolean = () => false, maxTicks = 400): Promise<void> {
    let delay: number | null = 0;
    for (let i = 0; i < maxTicks && delay !== null && !until(); i++) {
      clock.now += Math.max(delay, 1);
      delay = await machine.tick();
    }
  }
  async function begin(): Promise<void> {
    expect(await machine.accept(job)).toBe(true);
    expect(await machine.begin()).toBe(0);
  }
  const state = () => storage.get<JobState>("state");
  const statuses = () => sent.map((report) => `${report.checkRunId}:${report.status}`);
  return {
    clock,
    container,
    storage,
    sent,
    logs,
    control,
    machine,
    job,
    run,
    begin,
    state,
    statuses,
  };
}

describe("a job that runs to the end", () => {
  it("reports each step as its own check, in order, with increasing sequence numbers", async () => {
    const h = harness();
    h.container.script("s0", { output: "lint ok\n", exit: { exitCode: 0 } });
    h.container.script("s1", { output: "42 tests passed\n", exit: { exitCode: 0 } });
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual([
      "chk_lint:running",
      "chk_lint:passed",
      "chk_test:running",
      "chk_test:passed",
    ]);
    const sequences = h.sent.map((report) => report.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(h.sent[1]?.detailsUrl).toBe(h.job.steps[0]?.logUrl);
    expect(h.logs.get("chk_lint")).toContain("lint ok");
    expect(h.logs.get("chk_test")).toContain("42 tests passed");
    expect(h.logs.get("chk_test")).toContain("[stratum] Passed");
  });

  it("starts one container with no internet, the pinned image and the job's size", async () => {
    const h = harness({ job: { instance: "standard-2" } });
    await h.begin();
    await h.run();

    expect(h.container.starts).toEqual([
      { image: IMAGE, enableInternet: false, instance: "standard-2", labels: { profile: "ci" } },
    ]);
  });

  it("registers every intercept before the container starts", async () => {
    const h = harness();
    await h.begin();
    await h.run();

    const start = h.container.events.indexOf("start");
    const before = h.container.events.slice(0, start).filter((e) => e.startsWith("intercept:"));
    expect(before).toEqual([
      `intercept:${GIT_HOST}`,
      "intercept:registry.npmjs.org",
      "intercept:registry.yarnpkg.com",
      "intercept:nodejs.org",
    ]);
  });

  it("destroys the container, releases its slot and forgets everything", async () => {
    const h = harness();
    await h.begin();
    await h.run();

    expect(h.container.running).toBe(false);
    expect(h.container.events.at(-1)).toBe("destroy");
    expect(h.control.released).toBe(1);
    expect(h.storage.data.size).toBe(0);
    // Done means done: a late alarm finds nothing to do.
    expect(await h.machine.tick()).toBeNull();
  });

  it("runs the steps' own commands, at the repository root, and writes the diff whole", async () => {
    const diff = `diff --git a/big b/big\n${"+x".repeat(1_200_000)}\n`;
    const h = harness({ job: { diff } });
    await h.begin();
    await h.run(() => h.container.startedScript("s1") !== undefined);

    expect(h.container.files.get("/job/change.diff")).toBe(diff);
    expect(h.container.startedScript("s0")).toBe("npm run lint\n");
    expect(h.container.startedScript("s1")).toBe("npm test\n");
    const step = h.container.execs.find((e) => e.cmd[2] === "start" && e.cmd[3] === "s0");
    expect(step?.cmd).toEqual([
      "node",
      "/opt/stratum/agent.mjs",
      "start",
      "s0",
      "600",
      "/workspace",
    ]);
  });

  it("keeps running later steps after one fails", async () => {
    const h = harness();
    h.container.script("s0", { output: "3 problems\n", exit: { exitCode: 1 } });
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual([
      "chk_lint:running",
      "chk_lint:failed",
      "chk_test:running",
      "chk_test:passed",
    ]);
    expect(h.sent[1]?.summary).toMatch(/exit code 1/);
  });

  it("refuses a second job in the same object", async () => {
    const h = harness();
    await h.begin();
    expect(await h.machine.accept(h.job)).toBe(false);
  });
});

describe("the job holds no credential", () => {
  it("passes the repository token to the intercept handler and to nothing in the container", async () => {
    const h = harness();
    await h.begin();
    // Stop while the checkout is being prepared: the one moment the token is in use.
    await h.run(() => h.container.startedScript("prepare") !== undefined);

    const basic = btoa(`x:${REPO_PASSWORD}`);
    // The test can see the token where it belongs…
    expect(JSON.stringify(h.container.intercepts.get(GIT_HOST))).toContain(basic);
    expect(h.container.intercepts.get(GIT_HOST)).toEqual({
      handler: "git",
      props: { upstream: REPO_URL, authorization: `Basic ${basic}` },
    });

    await h.run();
    // …so its absence from everything that entered the container means something:
    // start options, every argv, every environment, every byte of stdin, every file.
    const passedIn = h.container.everythingPassedIn();
    expect(h.container.execs.length).toBeGreaterThan(4);
    expect(passedIn).not.toContain(REPO_PASSWORD);
    expect(passedIn).not.toContain(basic);
    expect(passedIn).not.toContain("Basic ");
    expect(passedIn).not.toContain(REPO_URL);
    expect(passedIn.toLowerCase()).not.toContain("authorization");
  });

  it("gives a step exactly the documented environment", async () => {
    const h = harness();
    await h.begin();
    await h.run();

    const step = h.container.execs.find((e) => e.cmd[2] === "start" && e.cmd[3] === "s0");
    expect(Object.keys(step?.env ?? {}).sort()).toEqual([
      "CI",
      "GIT_TERMINAL_PROMPT",
      "HOME",
      "LANG",
      "NODE_EXTRA_CA_CERTS",
      "STRATUM_CI",
      "npm_config_fund",
      "npm_config_update_notifier",
    ]);
    // `start()` is given no environment at all.
    expect(h.container.starts[0]).not.toHaveProperty("env");
  });

  it("closes the repository proxy and drops the token once the checkout is verified", async () => {
    const h = harness();
    await h.begin();
    await h.run(() => h.container.startedScript("s0") !== undefined);

    expect(h.container.intercepts.get(GIT_HOST)).toEqual({
      handler: "allowlist",
      props: { hosts: [] },
    });
    const stored = JSON.stringify([...h.storage.data.entries()]);
    expect(stored).not.toContain(btoa(`x:${REPO_PASSWORD}`));
    expect(stored).not.toContain("diff --git");
  });
});

describe("the tree check", () => {
  it("fails every check and runs no step when base + diff is not the evaluated tree", async () => {
    const h = harness();
    h.container.script("prepare", {
      output: `prepare: tree mismatch: base + diff gives ${"d".repeat(40)}, the evaluated tree is ${HEAD_TREE_SHA}\n`,
      exit: { exitCode: 3 },
    });
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:errored", "chk_test:errored"]);
    expect(h.sent[0]?.summary).toContain(`did not reproduce the evaluated tree ${HEAD_TREE_SHA}`);
    // No step was started, in this container or any other.
    expect(h.container.execs.filter((e) => e.cmd[2] === "start").map((e) => e.cmd[3])).toEqual([
      "prepare",
    ]);
    expect(h.container.running).toBe(false);
    expect(h.control.released).toBe(1);
    expect(h.logs.get("chk_test")).toContain("tree mismatch");
  });

  it("gives prepare the base commit and the tree to verify, and nothing else of its own", async () => {
    const h = harness();
    await h.begin();
    await h.run(() => h.container.startedScript("prepare") !== undefined);

    const prepare = h.container.execs.find((e) => e.cmd[3] === "prepare");
    expect(prepare?.env?.BASE_SHA).toBe(h.job.baseSha);
    expect(prepare?.env?.HEAD_TREE_SHA).toBe(HEAD_TREE_SHA);
    expect(prepare?.stdin).toBe("exec /opt/stratum/prepare.sh\n");
  });

  it("reports a checkout that could not be built as errored, not failed", async () => {
    const h = harness();
    h.container.script("prepare", { output: "fatal: unable to access\n", exit: { exitCode: 128 } });
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:errored", "chk_test:errored"]);
    expect(h.sent[0]?.summary).toMatch(/could not be prepared \(exit 128\)/);
    expect(h.sent[0]?.summary).toContain("fatal: unable to access");
  });
});

describe("time limits", () => {
  it("reports a step the supervisor stopped at its limit as failed", async () => {
    const h = harness();
    h.container.script("s0", {
      output: "still going\n",
      exit: { exitCode: null, signal: "SIGTERM", timedOut: true, durationMs: 600_000 },
    });
    await h.begin();
    await h.run();

    expect(h.statuses().slice(0, 2)).toEqual(["chk_lint:running", "chk_lint:failed"]);
    expect(h.sent[1]?.summary).toMatch(/^Timed out.*10 minutes/);
    // A timed-out step is that step's failure; the job goes on.
    expect(h.statuses()).toContain("chk_test:passed");
  });

  it("destroys the container when a step does not stop at its limit", async () => {
    const h = harness();
    // Never exits: the supervisor was killed, or ignored.
    h.container.script("s0", { output: "ignoring you\n" });
    await h.begin();
    await h.run(() => h.sent.some((r) => r.status === "running"));
    const startedAt = h.clock.now;
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:running", "chk_lint:failed", "chk_test:errored"]);
    expect(h.sent[1]?.summary).toMatch(/did not stop at its limit of 10 minutes/);
    expect(h.sent[2]?.summary).toMatch(/Not run.*'lint' did not stop/);
    // Stopped by the step's limit (10 min + grace), long before the job's (30 min).
    expect(h.clock.now - startedAt).toBeGreaterThan(600_000);
    expect(h.clock.now - startedAt).toBeLessThan(700_000);
    expect(h.container.running).toBe(false);
    expect(h.container.startedScript("s1")).toBeUndefined();
    expect(h.control.released).toBe(1);
  });

  it("enforces the wall-clock limit from outside, reporting what was cut off as errored", async () => {
    const h = harness({
      job: {
        timeoutSeconds: 300,
        steps: makeJob(T0).steps.map((step) => ({ ...step, timeoutSeconds: 3600 })),
      },
    });
    h.container.script("s0", { output: "working\n" });
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:running", "chk_lint:errored", "chk_test:errored"]);
    expect(h.sent[1]?.summary).toMatch(/exceeded its time limit of 5 minutes while this step/);
    expect(h.sent[2]?.summary).toBe("Not run: the job exceeded its time limit of 5 minutes.");
    expect(h.clock.now - T0).toBeGreaterThanOrEqual(300_000);
    expect(h.clock.now - T0).toBeLessThan(330_000);
    expect(h.container.destroys).toContain("job timeout");
    expect(h.control.released).toBe(1);
    expect(h.logs.get("chk_lint")).toContain("working");
  });

  it("stops a job the coordinator has given up on, even if its own alarm was lost", async () => {
    const h = harness();
    h.container.script("s0", { output: "working\n" });
    await h.begin();
    await h.run(() => h.sent.some((r) => r.status === "running"));

    expect(await h.machine.abandon()).toBe(0);
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:running", "chk_lint:errored", "chk_test:errored"]);
    expect(h.container.running).toBe(false);
  });

  it("gives up on a job that waited too long for a slot without starting anything", async () => {
    const h = harness();
    expect(await h.machine.accept(h.job)).toBe(true);
    expect(await h.machine.expire()).toBe(0);
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:errored", "chk_test:errored"]);
    expect(h.sent[0]?.summary).toMatch(/waited for a free slot/);
    expect(h.container.starts).toHaveLength(0);
    expect(h.control.released).toBe(1);
    expect(h.storage.data.size).toBe(0);
  });

  it("does nothing on a tick while it is still queued", async () => {
    const h = harness();
    await h.machine.accept(h.job);
    expect(await h.machine.tick()).toBeNull();
    expect(h.container.starts).toHaveLength(0);
  });
});

describe("a container that misbehaves", () => {
  it("reports unfinished steps as errored when the container stops answering", async () => {
    const h = harness();
    h.container.script("s0", { output: "working\n" });
    await h.begin();
    await h.run(() => h.sent.some((r) => r.status === "running"));
    h.container.broken = true;
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:running", "chk_lint:errored", "chk_test:errored"]);
    expect(h.sent[1]?.summary).toMatch(/stopped unexpectedly/);
    expect(h.control.released).toBe(1);
  });

  it("gives up after a second failed start, with a fresh container each time", async () => {
    const h = harness();
    h.container.failStart = true;
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:errored", "chk_test:errored"]);
    expect(h.sent[0]?.summary).toMatch(/could not start a container/);
    expect(h.container.starts).toHaveLength(0);
    expect(h.control.released).toBe(1);
  });

  it("says so when the executor was deployed without the job's image", async () => {
    const h = harness();
    h.control.images = {};
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual(["chk_lint:errored", "chk_test:errored"]);
    expect(h.sent[0]?.summary).toMatch(/no 'ci' image/);
  });
});

describe("reports", () => {
  it("retries an undelivered report without losing or reordering any", async () => {
    const h = harness();
    let failures = 3;
    h.control.respond = () => (failures-- > 0 ? "retry" : "delivered");
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual([
      "chk_lint:running",
      "chk_lint:passed",
      "chk_test:running",
      "chk_test:passed",
    ]);
    expect(h.control.released).toBe(1);
  });

  it("stops the job when Stratum says the run was superseded", async () => {
    const h = harness();
    h.container.script("s0", { output: "working\n" });
    h.control.respond = (report) => (report.status === "running" ? "abort" : "delivered");
    await h.begin();
    await h.run();

    expect(h.sent).toEqual([]);
    expect(h.container.destroys).toContain("superseded");
    expect(h.container.startedScript("s1")).toBeUndefined();
    expect(h.control.released).toBe(1);
    expect(h.storage.data.size).toBe(0);
  });

  it("drops a report Stratum will never accept and carries on", async () => {
    const h = harness();
    h.control.respond = (report) => (report.checkRunId === "chk_lint" ? "drop" : "delivered");
    await h.begin();
    await h.run();

    expect(h.statuses()).toEqual(["chk_test:running", "chk_test:passed"]);
  });

  it("holds results while Stratum is unreachable, then gives up after a bounded number of retries", async () => {
    const h = harness();
    h.control.respond = () => "retry";
    await h.begin();
    await h.run(() => false, 2000);

    expect(h.sent).toEqual([]);
    expect(h.container.running).toBe(false);
    expect(h.control.released).toBe(1);
    expect(h.storage.data.size).toBe(0);
  });

  it("still forgets the job when its slot cannot be released", async () => {
    const h = harness();
    h.control.failRelease = true;
    await h.begin();
    await h.run();

    // The coordinator reclaims the slot on its own clock; the job must not
    // keep a credential-bearing record around waiting for it.
    expect(h.storage.data.size).toBe(0);
  });
});

describe("logs", () => {
  it("keeps the start and the end of output over the cap, and says what was dropped", async () => {
    const h = harness({ logMaxBytes: 1000 });
    const output = `START\n${"x".repeat(300_000)}\nTHE ACTUAL ERROR\n`;
    h.container.script("s0", { output, exit: { exitCode: 1 } });
    await h.begin();
    await h.run();

    const log = h.logs.get("chk_lint") ?? "";
    expect(log.startsWith("START\n")).toBe(true);
    expect(log).toContain(`log truncated: the step wrote ${output.length} bytes`);
    expect(log).toContain("THE ACTUAL ERROR");
    expect(log.length).toBeLessThan(80_000);
  });

  it("writes a running step's output before the step ends", async () => {
    const h = harness();
    h.container.script("s0", { output: "compiling…\n" });
    await h.begin();
    await h.run(() => h.logs.has("chk_lint"), 30);

    expect(h.logs.get("chk_lint")).toContain("compiling…");
    expect(h.sent.map((r) => r.status)).toEqual(["running"]);
  });

  it("does not lose a result because its log could not be stored", async () => {
    const h = harness();
    h.container.script("s0", { output: "ok\n", exit: { exitCode: 0 } });
    await h.begin();
    h.control.failLogs = true;
    await h.run();

    expect(h.statuses()).toContain("chk_lint:passed");
  });
});
