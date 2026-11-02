import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env, MessageBatch } from "../src/types";

vi.mock("../src/queue/event-consumer", () => ({
  handleEventQueue: vi.fn(async () => {}),
  sweepStaleEvents: vi.fn(async () => {}),
}));
vi.mock("../src/queue/import-queue", () => ({
  handleImportQueue: vi.fn(async () => {}),
}));
vi.mock("../src/queue/deploy-queue", () => ({
  handleDeployQueue: vi.fn(async () => {}),
  enqueueMergeDeploy: vi.fn(async () => {}),
}));

import { handleDeployQueue } from "../src/queue/deploy-queue";
import { handleEventQueue } from "../src/queue/event-consumer";
import { handleImportQueue } from "../src/queue/import-queue";

function makeBatch(queue: string): MessageBatch<unknown> {
  return {
    queue,
    messages: [],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

const env = {} as Env;

/**
 * Queue names are per-environment ("stratum-events" in production,
 * "stratum-events-staging" on staging) but one codebase consumes them all, so
 * the dispatcher must route by prefix. An exact-name match here silently
 * ack-drops every staging batch as "Unknown queue".
 */
describe("worker queue dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["stratum-events", "stratum-events-staging"])(
    "routes %s to the event consumer",
    async (name) => {
      const batch = makeBatch(name);
      await worker.queue(batch, env);
      expect(handleEventQueue).toHaveBeenCalledWith(batch, env);
      expect(handleImportQueue).not.toHaveBeenCalled();
      expect(batch.ackAll).not.toHaveBeenCalled();
    },
  );

  it.each(["stratum-imports", "stratum-imports-staging"])(
    "routes %s to the import consumer",
    async (name) => {
      const batch = makeBatch(name);
      await worker.queue(batch, env);
      expect(handleImportQueue).toHaveBeenCalledWith(batch, env);
      expect(handleEventQueue).not.toHaveBeenCalled();
      expect(batch.ackAll).not.toHaveBeenCalled();
    },
  );

  it.each(["stratum-deploys", "stratum-deploys-staging"])(
    "routes %s to the deploy consumer, leaving the events consumer untouched",
    async (name) => {
      const batch = makeBatch(name);
      await worker.queue(batch, env);
      expect(handleDeployQueue).toHaveBeenCalledWith(batch, env);
      expect(handleEventQueue).not.toHaveBeenCalled();
      expect(handleImportQueue).not.toHaveBeenCalled();
      expect(batch.ackAll).not.toHaveBeenCalled();
    },
  );

  // The event queue predates deploys and must keep behaving identically; a
  // prefix that also matched "stratum-events" would silently reroute it.
  it.each(["stratum-events", "stratum-events-staging"])(
    "never hands %s to the deploy consumer",
    async (name) => {
      const batch = makeBatch(name);
      await worker.queue(batch, env);
      expect(handleEventQueue).toHaveBeenCalledWith(batch, env);
      expect(handleDeployQueue).not.toHaveBeenCalled();
    },
  );

  it("acks batches from unknown queues without invoking a consumer", async () => {
    const batch = makeBatch("some-other-queue");
    await worker.queue(batch, env);
    expect(handleEventQueue).not.toHaveBeenCalled();
    expect(handleImportQueue).not.toHaveBeenCalled();
    expect(handleDeployQueue).not.toHaveBeenCalled();
    expect(batch.ackAll).toHaveBeenCalled();
  });
});
