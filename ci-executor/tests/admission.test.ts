import { describe, expect, it } from "vitest";
import { Admission, RELEASE_GRACE_MS, emptyAdmissionState } from "../src/admission";

const T0 = 1_000_000;
const MINUTE = 60_000;

function admission(maxConcurrent = 2, maxQueued = 2) {
  return new Admission(emptyAdmissionState(), { maxConcurrent, maxQueued });
}

/** A job that takes up to 10 minutes and must start within the hour. */
const REQUEST = { timeoutMs: 10 * MINUTE, startBy: T0 + 60 * MINUTE };

describe("the concurrency cap", () => {
  it("starts jobs up to the limit and no further", () => {
    const a = admission(2, 5);
    expect(a.submit("a", REQUEST, T0)).toEqual({ decision: "start" });
    expect(a.submit("b", REQUEST, T0)).toEqual({ decision: "start" });
    expect(a.submit("c", REQUEST, T0)).toEqual({ decision: "queued", position: 1 });
    expect(Object.keys(a.state.running)).toEqual(["a", "b"]);
  });

  it("never runs more than the limit however jobs arrive and leave", () => {
    const a = admission(3, 100);
    let peak = 0;
    for (let i = 0; i < 50; i++) {
      a.submit(`job${i}`, REQUEST, T0 + i);
      if (i % 4 === 0) a.release(`job${Math.floor(i / 2)}`, T0 + i);
      peak = Math.max(peak, Object.keys(a.state.running).length);
    }
    expect(peak).toBe(3);
  });

  it("refuses a job that was already submitted", () => {
    const a = admission();
    a.submit("a", REQUEST, T0);
    expect(a.submit("a", REQUEST, T0).decision).toBe("refused");
  });
});

describe("the queue bound", () => {
  it("refuses a dispatch that does not fit, and says why", () => {
    const a = admission(1, 2);
    a.submit("a", REQUEST, T0);
    a.submit("b", REQUEST, T0);
    a.submit("c", REQUEST, T0);
    const refused = a.submit("d", REQUEST, T0);
    expect(refused).toEqual({
      decision: "refused",
      reason: "1 job(s) running and 2 queued, which is this executor's limit",
    });
    expect(a.state.queue.map((entry) => entry.jobId)).toEqual(["b", "c"]);
  });

  it("with no queue at all, refuses whatever cannot start at once", () => {
    const a = admission(1, 0);
    a.submit("a", REQUEST, T0);
    expect(a.submit("b", REQUEST, T0).decision).toBe("refused");
  });

  it("starts waiting jobs oldest first, and never lets a newcomer jump the queue", () => {
    const a = admission(1, 3);
    a.submit("a", REQUEST, T0);
    a.submit("b", REQUEST, T0);
    a.submit("c", REQUEST, T0);

    expect(a.release("a", T0 + 1).start).toEqual(["b"]);
    expect(a.release("b", T0 + 2).start).toEqual(["c"]);
    expect(a.state.queue).toEqual([]);
  });

  it("refuses a job that could not start in time to finish", () => {
    const a = admission();
    const refused = a.submit("late", { timeoutMs: MINUTE, startBy: T0 }, T0);
    expect(refused.decision).toBe("refused");
  });

  it("drops a queued job once it can no longer start in time", () => {
    const a = admission(1, 3);
    a.submit("a", REQUEST, T0);
    a.submit("b", { timeoutMs: MINUTE, startBy: T0 + 5 * MINUTE }, T0);

    expect(a.sweep(T0 + 4 * MINUTE)).toEqual({ timedOut: [], expired: [], start: [] });
    expect(a.sweep(T0 + 5 * MINUTE)).toEqual({ timedOut: [], expired: ["b"], start: [] });
    expect(a.state.queue).toEqual([]);
  });

  it("removes a queued job that is released before it starts", () => {
    const a = admission(1, 3);
    a.submit("a", REQUEST, T0);
    a.submit("b", REQUEST, T0);
    a.release("b", T0);
    expect(a.state.queue).toEqual([]);
    expect(Object.keys(a.state.running)).toEqual(["a"]);
  });
});

describe("slot release", () => {
  it("frees the slot when the job ends, and starts the next one", () => {
    const a = admission(1, 1);
    a.submit("a", REQUEST, T0);
    a.submit("b", REQUEST, T0);
    expect(a.release("a", T0 + MINUTE)).toEqual({ timedOut: [], expired: [], start: ["b"] });
    expect(Object.keys(a.state.running)).toEqual(["b"]);
  });

  it("frees the slot when the job's time runs out, without the job saying anything", () => {
    const a = admission(1, 1);
    a.submit("a", REQUEST, T0);
    a.submit("b", REQUEST, T0);
    const releaseAt = T0 + REQUEST.timeoutMs + RELEASE_GRACE_MS;

    expect(a.nextWake()).toBe(releaseAt);
    expect(a.sweep(releaseAt - 1)).toEqual({ timedOut: [], expired: [], start: [] });
    // `a` never called release. Its slot comes back anyway, and `b` gets it.
    expect(a.sweep(releaseAt)).toEqual({ timedOut: ["a"], expired: [], start: ["b"] });
    expect(Object.keys(a.state.running)).toEqual(["b"]);
  });

  it("does not leak capacity when every job is lost", () => {
    const a = admission(2, 0);
    a.submit("a", REQUEST, T0);
    a.submit("b", REQUEST, T0);
    expect(a.submit("c", REQUEST, T0).decision).toBe("refused");

    a.sweep(T0 + REQUEST.timeoutMs + RELEASE_GRACE_MS);
    expect(a.submit("c", REQUEST, T0 + 20 * MINUTE)).toEqual({ decision: "start" });
  });

  it("times a promoted job from when it started, not from when it was queued", () => {
    const a = admission(1, 1);
    a.submit("a", REQUEST, T0);
    a.submit("b", REQUEST, T0);
    a.release("a", T0 + 8 * MINUTE);
    expect(a.state.running.b).toBe(T0 + 8 * MINUTE + REQUEST.timeoutMs + RELEASE_GRACE_MS);
  });

  it("is harmless to release a job twice, or one it never knew", () => {
    const a = admission();
    a.submit("a", REQUEST, T0);
    a.release("a", T0);
    expect(a.release("a", T0)).toEqual({ timedOut: [], expired: [], start: [] });
    expect(a.release("ghost", T0)).toEqual({ timedOut: [], expired: [], start: [] });
  });

  it("has nothing to wake for when idle", () => {
    expect(admission().nextWake()).toBeNull();
  });
});

describe("deploy jobs", () => {
  const DEPLOY = { ...REQUEST, priority: true };
  const withDeploys = (maxConcurrent: number, maxQueued: number, maxQueuedPriority: number) =>
    new Admission(emptyAdmissionState(), { maxConcurrent, maxQueued, maxQueuedPriority });

  it("count against the same cap as CI jobs: there is no reserved slot", () => {
    const a = withDeploys(2, 5, 2);
    expect(a.submit("ci-1", REQUEST, T0).decision).toBe("start");
    expect(a.submit("deploy-1", DEPLOY, T0).decision).toBe("start");
    expect(a.submit("deploy-2", DEPLOY, T0).decision).toBe("queued");
    expect(Object.keys(a.state.running)).toHaveLength(2);

    // And with no deploys about, CI may use every slot.
    const b = withDeploys(2, 5, 2);
    expect(b.submit("ci-1", REQUEST, T0).decision).toBe("start");
    expect(b.submit("ci-2", REQUEST, T0).decision).toBe("start");
  });

  it("take the next free slot ahead of every waiting CI job", () => {
    const a = withDeploys(1, 5, 2);
    a.submit("ci-running", REQUEST, T0);
    a.submit("ci-waiting-1", REQUEST, T0);
    a.submit("ci-waiting-2", REQUEST, T0);
    expect(a.submit("deploy-1", DEPLOY, T0)).toEqual({ decision: "queued", position: 1 });

    expect(a.release("ci-running", T0 + MINUTE).start).toEqual(["deploy-1"]);
    // CI resumes in its own order once the deploy is done.
    expect(a.release("deploy-1", T0 + 2 * MINUTE).start).toEqual(["ci-waiting-1"]);
  });

  it("keep their own order among themselves", () => {
    const a = withDeploys(1, 5, 3);
    a.submit("ci-running", REQUEST, T0);
    a.submit("deploy-1", DEPLOY, T0);
    expect(a.submit("deploy-2", DEPLOY, T0)).toEqual({ decision: "queued", position: 2 });
    expect(a.release("ci-running", T0 + MINUTE).start).toEqual(["deploy-1"]);
    expect(a.release("deploy-1", T0 + 2 * MINUTE).start).toEqual(["deploy-2"]);
  });

  it("are not refused because CI's queue is full, and do not use it up", () => {
    const a = withDeploys(1, 2, 1);
    a.submit("ci-running", REQUEST, T0);
    a.submit("ci-waiting-1", REQUEST, T0);
    a.submit("ci-waiting-2", REQUEST, T0);
    expect(a.submit("ci-waiting-3", REQUEST, T0).decision).toBe("refused");

    expect(a.submit("deploy-1", DEPLOY, T0).decision).toBe("queued");
    // The deploy queue has its own bound.
    const refused = a.submit("deploy-2", DEPLOY, T0);
    expect(refused.decision).toBe("refused");
    expect(refused).toMatchObject({ reason: expect.stringContaining("deploy job(s) queued") });
  });

  it("hold their slot on the same terms: until released, or their time runs out", () => {
    const a = withDeploys(1, 2, 2);
    a.submit("deploy-1", DEPLOY, T0);
    a.submit("ci-1", REQUEST, T0);
    // Nothing starts beside a running deploy.
    expect(a.sweep(T0 + 5 * MINUTE).start).toEqual([]);
    const swept = a.sweep(T0 + 10 * MINUTE + RELEASE_GRACE_MS);
    expect(swept.timedOut).toEqual(["deploy-1"]);
    expect(swept.start).toEqual(["ci-1"]);
  });

  it("are refused with no deploy queue configured, when no slot is free", () => {
    const a = new Admission(emptyAdmissionState(), { maxConcurrent: 1, maxQueued: 5 });
    a.submit("ci-running", REQUEST, T0);
    expect(a.submit("deploy-1", DEPLOY, T0).decision).toBe("refused");
  });
});
