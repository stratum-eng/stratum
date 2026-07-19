/**
 * EVENT-8: a retry resumes past handlers that already completed, instead of
 * re-running them (which duplicated analytics/webhook side effects).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../src/storage/events";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/analytics/posthog", () => ({
  createPostHogClient: () => ({ capture: mockCapture }),
}));
vi.mock("../src/queue/webhook-delivery", () => ({
  deliverEventToWebhooks: (...a: unknown[]) => mockDeliver(...a),
}));
vi.mock("../src/queue/issue-autoclose", () => ({
  autoCloseLinkedIssues: (...a: unknown[]) => mockAutoClose(...a),
}));
vi.mock("../src/storage/events", async (orig) => ({
  ...(await orig<typeof import("../src/storage/events")>()),
  setCompletedHandlers: (...a: unknown[]) => mockSetCompleted(...a),
}));

const mockCapture = vi.fn(async (..._a: unknown[]) => undefined);
const mockDeliver = vi.fn(async (..._a: unknown[]) => undefined);
const mockAutoClose = vi.fn(async (..._a: unknown[]) => undefined);
const mockSetCompleted = vi.fn(async (..._a: unknown[]) => ({ success: true }));

import { processEvent } from "../src/queue/event-consumer";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const env = { DB: {} } as unknown as Env;

function makeEvent(completedHandlers: string[]): EventRecord {
  return {
    id: "evt_1",
    type: "change.merged",
    project: "acme/web",
    actorType: "system",
    payload: {},
    status: "pending",
    attempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedHandlers,
  };
}

describe("processEvent handler resume", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs every handler on a fresh event", async () => {
    await processEvent(env, makeEvent([]), logger);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockAutoClose).toHaveBeenCalledTimes(1);
    expect(mockDeliver).toHaveBeenCalledTimes(1);
  });

  it("skips handlers already recorded as completed", async () => {
    // analytics + issue-autoclose already ran on a prior attempt; only webhooks left.
    await processEvent(env, makeEvent(["analytics", "issue-autoclose"]), logger);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockAutoClose).not.toHaveBeenCalled();
    expect(mockDeliver).toHaveBeenCalledTimes(1);
  });

  it("does nothing when all handlers already completed", async () => {
    await processEvent(env, makeEvent(["analytics", "issue-autoclose", "webhooks"]), logger);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockAutoClose).not.toHaveBeenCalled();
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it("stops and throws if progress cannot be persisted, so the message retries", async () => {
    // Persisting after the FIRST handler fails: we must not run later handlers on
    // unpersisted state (a subsequent failure would re-run/re-emit the first).
    mockSetCompleted.mockResolvedValueOnce({
      success: false,
      error: new Error("d1 write failed"),
    });
    await expect(processEvent(env, makeEvent([]), logger)).rejects.toThrow(/d1 write failed/);
    expect(mockCapture).toHaveBeenCalledTimes(1); // first handler ran
    expect(mockAutoClose).not.toHaveBeenCalled(); // later handlers did NOT
    expect(mockDeliver).not.toHaveBeenCalled();
  });
});
