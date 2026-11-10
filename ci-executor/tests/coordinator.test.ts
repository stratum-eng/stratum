/**
 * The coordinator's wiring around {@link Admission}: what it does when a job
 * it promoted cannot be told to start.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { START_RETRY_MS, pendingStarts } from "../src/admission";
import type { Env } from "../src/config";
import { Coordinator } from "../src/coordinator";

const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

let store: Map<string, unknown>;
let alarmAt: number | null;
let background: Promise<unknown>[];
let begun: string[];
let failBegin: Set<string>;
let coordinator: Coordinator;

/** Let every `waitUntil` promise, and the ones it starts, finish. */
async function settle(): Promise<void> {
  while (background.length > 0) await background.shift();
}

function request() {
  return { timeoutMs: 10 * MINUTE, startBy: Date.now() + 60 * MINUTE };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store = new Map();
  alarmAt = null;
  background = [];
  begun = [];
  failBegin = new Set();
  const ctx = {
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
      },
      setAlarm: async (at: number) => {
        alarmAt = at;
      },
      deleteAlarm: async () => {
        alarmAt = null;
      },
    },
    waitUntil: (work: Promise<unknown>) => {
      background.push(work);
    },
  };
  const env = {
    CI_EXECUTOR_SECRET: "s".repeat(64),
    STRATUM_ORIGIN: "https://stratum.example",
    CI_MAX_CONCURRENT_JOBS: "1",
    JOB: {
      idFromName: (name: string) => name,
      get: (jobId: string) => ({
        begin: async () => {
          if (failBegin.has(jobId)) throw new Error("runner reset");
          begun.push(jobId);
        },
        expire: async () => undefined,
        abandon: async () => undefined,
      }),
    },
  } as unknown as Env;
  coordinator = new Coordinator(ctx as unknown as DurableObjectState, env);
});

describe("pendingStarts", () => {
  it("joins the waiting and the newly promoted, once each", () => {
    expect(pendingStarts(["a"], ["a", "b"], { a: 1, b: 1 })).toEqual(["a", "b"]);
  });

  it("drops a job whose slot is gone, so it is never told to start", () => {
    expect(pendingStarts(["a", "b"], [], { b: 1 })).toEqual(["b"]);
  });
});

describe("a promoted job that cannot be told to start", () => {
  it("is told again on the next alarm, and only until it hears", async () => {
    expect(await coordinator.submit("first", request())).toEqual({ decision: "start" });
    expect(await coordinator.submit("second", request())).toMatchObject({ decision: "queued" });

    // The slot frees and `second` is promoted, but its runner cannot be reached.
    failBegin.add("second");
    await coordinator.release("first");
    await settle();
    expect(begun).toEqual([]);
    // It holds the slot, so without a retry it would wait out its deadline.
    expect(alarmAt).toBe(T0 + START_RETRY_MS);

    failBegin.clear();
    vi.setSystemTime(T0 + START_RETRY_MS);
    await coordinator.alarm();
    await settle();
    expect(begun).toEqual(["second"]);

    // Confirmed: a later alarm does not tell it a second time.
    await coordinator.alarm();
    await settle();
    expect(begun).toEqual(["second"]);
  });

  it("is not told to start after its slot was reclaimed", async () => {
    await coordinator.submit("first", request());
    await coordinator.submit("second", request());
    failBegin.add("second");
    await coordinator.release("first");
    await settle();

    // The job gives the slot back (it expired on its own alarm, say).
    await coordinator.release("second");
    await settle();
    failBegin.clear();
    await coordinator.alarm();
    await settle();
    expect(begun).toEqual([]);
  });
});
