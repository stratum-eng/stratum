/**
 * #257: the queue exporter is the SECOND PostHog call site. Suppressing only
 * the request middleware would have shipped a privacy toggle that visibly does
 * not stop telemetry — domain events would keep flowing for an opted-out user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRecord } from "../src/storage/events";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";
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
vi.mock("../src/storage/users", () => ({ getUser: vi.fn() }));
vi.mock("../src/storage/agents", () => ({ getAgent: vi.fn() }));

const mockCapture = vi.fn(async (..._a: unknown[]) => undefined);
const mockDeliver = vi.fn(async (..._a: unknown[]) => undefined);
const mockAutoClose = vi.fn(async (..._a: unknown[]) => undefined);
const mockSetCompleted = vi.fn(async (..._a: unknown[]) => ({ success: true }));

import { processEvent } from "../src/queue/event-consumer";
import { getAgent } from "../src/storage/agents";
import { getUser } from "../src/storage/users";

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

const liveUser = {
  id: "usr_1",
  email: "a@b.com",
  username: "alice",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "evt_1",
    type: "change.merged",
    project: "acme/web",
    projectId: "prj_abc",
    actorType: "user",
    actorId: "usr_1",
    payload: {},
    status: "pending",
    attempts: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedHandlers: [],
    ...overrides,
  };
}

describe("telemetry opt-out — queue path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends nothing for an event authored by an opted-out user", async () => {
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { ...liveUser, telemetryOptOut: true },
    });

    await processEvent(env, makeEvent(), logger);

    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("still sends for an event authored by an opted-in user", async () => {
    vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });

    await processEvent(env, makeEvent(), logger);

    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("suppresses an agent-authored event when the agent's OWNER has opted out", async () => {
    vi.mocked(getAgent).mockResolvedValue({
      success: true,
      data: { id: "agt_1", ownerId: "usr_1", name: "bot", tokenHash: "h", createdAt: "2026-01-01" },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { ...liveUser, telemetryOptOut: true },
    });

    await processEvent(env, makeEvent({ actorType: "agent", actorId: "agt_1" }), logger);

    expect(getUser).toHaveBeenCalledWith(env.DB, "usr_1", logger);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("exports system-authored events unchanged — no person, no preference", async () => {
    await processEvent(env, makeEvent({ actorType: "system", actorId: undefined }), logger);

    expect(getUser).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  describe("failing closed", () => {
    it("suppresses the event when the user lookup fails", async () => {
      vi.mocked(getUser).mockResolvedValue({
        success: false,
        error: new NotFoundError("User", "usr_1"),
      });

      await processEvent(env, makeEvent(), logger);

      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("suppresses the event when the lookup throws", async () => {
      vi.mocked(getUser).mockRejectedValue(new Error("D1 exploded"));

      await processEvent(env, makeEvent(), logger);

      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("never blocks the sibling handlers a suppressed event still owes", async () => {
      vi.mocked(getUser).mockRejectedValue(new Error("D1 exploded"));

      await processEvent(env, makeEvent(), logger);

      expect(mockAutoClose).toHaveBeenCalledTimes(1);
      expect(mockDeliver).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry resume", () => {
    it("records the handler as completed when suppressed, so a retry does not re-run it", async () => {
      vi.mocked(getUser).mockResolvedValue({
        success: true,
        data: { ...liveUser, telemetryOptOut: true },
      });

      await processEvent(env, makeEvent(), logger);

      // Suppression is a normal return, so "analytics" is persisted as done.
      expect(mockSetCompleted).toHaveBeenCalledWith(
        env.DB,
        logger,
        "evt_1",
        expect.arrayContaining(["analytics"]),
      );
    });

    it("skips analytics entirely on a retry that already completed it", async () => {
      // Attempt 1 exported while the user was opted in; a later handler failed.
      // On redelivery the export must not repeat — and must not be re-decided
      // against a preference the user may have changed in between.
      vi.mocked(getUser).mockResolvedValue({
        success: true,
        data: { ...liveUser, telemetryOptOut: true },
      });

      await processEvent(env, makeEvent({ completedHandlers: ["analytics"] }), logger);

      expect(mockCapture).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expect(mockAutoClose).toHaveBeenCalledTimes(1);
    });

    it("keeps a transient lookup failure from re-exporting on retry", async () => {
      vi.mocked(getUser).mockRejectedValue(new Error("D1 exploded"));

      await processEvent(env, makeEvent(), logger);

      // Documented trade-off: the suppressed event is marked done, so the drop
      // is permanent rather than retried. Pinned so the choice is deliberate.
      expect(mockSetCompleted).toHaveBeenCalledWith(
        env.DB,
        logger,
        "evt_1",
        expect.arrayContaining(["analytics"]),
      );
    });
  });

  describe("payload redaction", () => {
    it("never sends the concrete project name", async () => {
      vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });

      await processEvent(env, makeEvent(), logger);

      const properties = mockCapture.mock.calls[0]?.[0] as {
        properties: Record<string, unknown>;
      };
      expect(JSON.stringify(properties)).not.toContain("acme/web");
      expect(properties.properties.project).toBeUndefined();
      expect(properties.properties.project_id).toBe("prj_abc");
    });

    it("omits project_id entirely on rows written before dual-write", async () => {
      vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });

      await processEvent(env, makeEvent({ projectId: undefined }), logger);

      const properties = mockCapture.mock.calls[0]?.[0] as {
        properties: Record<string, unknown>;
      };
      expect("project_id" in properties.properties).toBe(false);
      expect(properties.properties.actor_type).toBe("user");
    });
  });
});
