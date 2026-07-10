import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSweepStaleEvents = vi.fn(async () => {});
const mockHandleEventQueue = vi.fn(async () => {});
vi.mock("../src/queue/event-consumer", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/queue/event-consumer")>();
  return {
    ...original,
    sweepStaleEvents: (...args: unknown[]) => mockSweepStaleEvents(...args),
    handleEventQueue: (...args: unknown[]) => mockHandleEventQueue(...args),
  };
});

const mockSweepDeletionJobs = vi.fn(async () => {});
vi.mock("../src/queue/deletion-runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/queue/deletion-runner")>();
  return {
    ...original,
    sweepDeletionJobs: (...args: unknown[]) => mockSweepDeletionJobs(...args),
  };
});

const mockRunTtlSweep = vi.fn(async () => ({ deleted: 0 }));
vi.mock("../src/queue/ttl-sweep", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/queue/ttl-sweep")>();
  return {
    ...original,
    runTtlSweep: (...args: unknown[]) => mockRunTtlSweep(...args),
  };
});

const mockSyncAllProjects = vi.fn(async () => ({ synced: 0, failed: 0 }));
vi.mock("../src/routes/sync", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/routes/sync")>();
  return {
    ...original,
    syncAllProjects: (...args: unknown[]) => mockSyncAllProjects(...args),
  };
});

import worker from "../src/index";
import type { Env } from "../src/types";

function makeEnv(): Env {
  return { DB: {}, STATE: {}, ARTIFACTS: {} } as unknown as Env;
}

function makeExecutionContext(): { ctx: ExecutionContext; waitUntils: Promise<unknown>[] } {
  const waitUntils: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waitUntils.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, waitUntils };
}

function makeScheduledEvent(cron: string): ScheduledEvent {
  return { cron, scheduledTime: Date.now(), noRetry: () => {} } as unknown as ScheduledEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scheduled handler (*/5 * * * * cron)", () => {
  it("drives the stale-events sweep and the authoritative deletion sweep", async () => {
    const { ctx, waitUntils } = makeExecutionContext();
    const env = makeEnv();

    await worker.scheduled(makeScheduledEvent("*/5 * * * *"), env, ctx);
    await Promise.all(waitUntils);

    expect(mockSweepStaleEvents).toHaveBeenCalledTimes(1);
    expect(mockSweepStaleEvents).toHaveBeenCalledWith(env, expect.anything());
    expect(mockSweepDeletionJobs).toHaveBeenCalledTimes(1);
    expect(mockSweepDeletionJobs).toHaveBeenCalledWith(env, expect.anything());
  });

  it("does not run the TTL sweep or project sync on the */5 cron", async () => {
    const { ctx, waitUntils } = makeExecutionContext();
    const env = makeEnv();

    await worker.scheduled(makeScheduledEvent("*/5 * * * *"), env, ctx);
    await Promise.all(waitUntils);

    expect(mockRunTtlSweep).not.toHaveBeenCalled();
    expect(mockSyncAllProjects).not.toHaveBeenCalled();
  });

  it("deferred work is registered via ctx.waitUntil, not awaited inline", async () => {
    const { ctx, waitUntils } = makeExecutionContext();
    const env = makeEnv();

    await worker.scheduled(makeScheduledEvent("*/5 * * * *"), env, ctx);

    // The handler itself resolves without waiting for the sweeps — the two
    // promises are only observable via the ctx.waitUntil() collection.
    expect(waitUntils).toHaveLength(2);
  });
});

describe("scheduled handler (any other cron)", () => {
  it("runs the TTL sweep and project sync, and skips the event/deletion sweeps", async () => {
    const { ctx, waitUntils } = makeExecutionContext();
    const env = makeEnv();

    await worker.scheduled(makeScheduledEvent("0 0 * * *"), env, ctx);
    await Promise.all(waitUntils);

    expect(mockRunTtlSweep).toHaveBeenCalledTimes(1);
    expect(mockRunTtlSweep).toHaveBeenCalledWith(env, expect.anything());
    expect(mockSyncAllProjects).toHaveBeenCalledTimes(1);
    expect(mockSyncAllProjects).toHaveBeenCalledWith(env);
    expect(mockSweepStaleEvents).not.toHaveBeenCalled();
    expect(mockSweepDeletionJobs).not.toHaveBeenCalled();
  });
});