import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getEvent,
  incrementEventAttempts,
  insertEvent,
  listProjectEvents,
  listRecentEvents,
  listStalePendingEvents,
  markEventFailed,
  markEventProcessed,
} from "../src/storage/events";
import type { Logger } from "../src/utils/logger";
import { type EventRow, makeEventsD1 } from "./helpers/events-d1";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

describe("events storage", () => {
  let db: D1Database;
  let rows: EventRow[];

  beforeEach(() => {
    ({ db, rows } = makeEventsD1());
  });

  it("inserts an event as pending with payload", async () => {
    const result = await insertEvent(db, mockLogger, {
      type: "change.merged",
      project: "my-project",
      actorType: "user",
      actorId: "user_1",
      payload: { changeId: "chg_1", commit: "abc123" },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("pending");
    expect(result.data.attempts).toBe(0);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? "{}")).toEqual({ changeId: "chg_1", commit: "abc123" });
  });

  it("round-trips an event through getEvent", async () => {
    const inserted = await insertEvent(db, mockLogger, {
      type: "workspace.created",
      project: "p",
      actorType: "agent",
      actorId: "agent_1",
      payload: { workspace: "ws-1" },
    });
    expect(inserted.success).toBe(true);
    if (!inserted.success) return;

    const fetched = await getEvent(db, mockLogger, inserted.data.id);
    expect(fetched.success).toBe(true);
    if (!fetched.success) return;
    expect(fetched.data.type).toBe("workspace.created");
    expect(fetched.data.actorType).toBe("agent");
    expect(fetched.data.actorId).toBe("agent_1");
    expect(fetched.data.payload).toEqual({ workspace: "ws-1" });
  });

  it("returns NOT_FOUND for a missing event", async () => {
    const result = await getEvent(db, mockLogger, "evt_missing");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("lists events scoped by project, newest first", async () => {
    await insertEvent(db, mockLogger, {
      type: "project.created",
      project: "alpha",
      actorType: "user",
      payload: {},
    });
    await insertEvent(db, mockLogger, {
      type: "project.created",
      project: "beta",
      actorType: "user",
      payload: {},
    });

    const result = await listProjectEvents(db, mockLogger, "alpha");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.project).toBe("alpha");
  });

  it("lists recent events across projects", async () => {
    await insertEvent(db, mockLogger, {
      type: "project.created",
      project: "alpha",
      actorType: "user",
      payload: {},
    });
    await insertEvent(db, mockLogger, {
      type: "project.created",
      project: "beta",
      actorType: "user",
      payload: {},
    });

    const result = await listRecentEvents(db, mockLogger);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
  });

  it("marks events processed and failed, increments attempts", async () => {
    const inserted = await insertEvent(db, mockLogger, {
      type: "change.created",
      project: "p",
      actorType: "system",
      payload: {},
    });
    expect(inserted.success).toBe(true);
    if (!inserted.success) return;
    const id = inserted.data.id;

    await incrementEventAttempts(db, mockLogger, id);
    await markEventProcessed(db, mockLogger, id);
    expect(rows[0]?.status).toBe("processed");
    expect(rows[0]?.attempts).toBe(1);
    expect(rows[0]?.processed_at).toBeTruthy();

    await markEventFailed(db, mockLogger, id);
    expect(rows[0]?.status).toBe("failed");
  });

  it("finds stale pending events older than the cutoff", async () => {
    const inserted = await insertEvent(db, mockLogger, {
      type: "change.created",
      project: "p",
      actorType: "system",
      payload: {},
    });
    expect(inserted.success).toBe(true);
    if (!inserted.success) return;

    // Fresh event: not stale.
    const fresh = await listStalePendingEvents(db, mockLogger, { olderThanMs: 5 * 60 * 1000 });
    expect(fresh.success).toBe(true);
    if (!fresh.success) return;
    expect(fresh.data).toHaveLength(0);

    // Backdate the row: now stale.
    const row = rows[0];
    if (row) row.created_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stale = await listStalePendingEvents(db, mockLogger, { olderThanMs: 5 * 60 * 1000 });
    expect(stale.success).toBe(true);
    if (!stale.success) return;
    expect(stale.data).toHaveLength(1);

    // Processed rows are never stale.
    if (row) row.status = "processed";
    const afterProcess = await listStalePendingEvents(db, mockLogger, {
      olderThanMs: 5 * 60 * 1000,
    });
    expect(afterProcess.success).toBe(true);
    if (!afterProcess.success) return;
    expect(afterProcess.data).toHaveLength(0);
  });

  it("tolerates malformed payload JSON", async () => {
    rows.push({
      id: "evt_bad",
      type: "change.created",
      project: "p",
      project_id: null,
      actor_type: "system",
      actor_id: null,
      payload: "not-json{",
      status: "pending",
      attempts: 0,
      created_at: new Date().toISOString(),
      processed_at: null,
    });

    const result = await getEvent(db, mockLogger, "evt_bad");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.payload).toEqual({});
  });
});
