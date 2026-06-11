import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_EVENT_ATTEMPTS,
  handleEventQueue,
  sweepStaleEvents,
} from "../src/queue/event-consumer";
import { emitEvent } from "../src/queue/events";
import type { Env, Message, MessageBatch, Queue } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeEventsD1 } from "./helpers/events-d1";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeQueue(): { queue: Queue; sent: unknown[] } {
  const sent: unknown[] = [];
  const queue = {
    send: vi.fn(async (msg: unknown) => {
      sent.push(msg);
    }),
  } as unknown as Queue;
  return { queue, sent };
}

function makeMessage(body: unknown): Message<{ eventId: string }> & {
  acked: boolean;
  retried: boolean;
} {
  const msg = {
    id: "msg_1",
    timestamp: new Date(),
    body: body as { eventId: string },
    acked: false,
    retried: false,
    ack() {
      this.acked = true;
    },
    retry() {
      this.retried = true;
    },
  };
  return msg as unknown as Message<{ eventId: string }> & { acked: boolean; retried: boolean };
}

function makeEnv(db: D1Database, queue?: Queue): Env {
  return {
    DB: db,
    ...(queue ? { EVENTS_QUEUE: queue } : {}),
  } as unknown as Env;
}

describe("emitEvent", () => {
  it("writes an outbox row and sends the event id to the queue", async () => {
    const { db, rows } = makeEventsD1();
    const { queue, sent } = makeQueue();

    await emitEvent(
      db,
      queue,
      { type: "change.merged", project: "p", changeId: "chg_1", commit: "abc" },
      { type: "user", id: "user_1" },
      mockLogger,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("change.merged");
    expect(rows[0]?.actor_type).toBe("user");
    expect(JSON.parse(rows[0]?.payload ?? "{}")).toEqual({ changeId: "chg_1", commit: "abc" });
    expect(sent).toEqual([{ eventId: rows[0]?.id }]);
  });

  it("still writes the outbox row when the queue send fails", async () => {
    const { db, rows } = makeEventsD1();
    const queue = {
      send: vi.fn().mockRejectedValue(new Error("queue down")),
    } as unknown as Queue;

    await expect(
      emitEvent(
        db,
        queue,
        { type: "project.created", project: "p" },
        { type: "user", id: "u1" },
        mockLogger,
      ),
    ).resolves.toBeUndefined();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("writes the outbox row when no queue is bound", async () => {
    const { db, rows } = makeEventsD1();

    await emitEvent(
      db,
      null,
      { type: "workspace.created", project: "p", workspace: "ws" },
      { type: "agent", id: "agent_1" },
      mockLogger,
    );

    expect(rows).toHaveLength(1);
  });

  it("never throws when the database is unavailable", async () => {
    const badDb = {
      prepare: () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    const { queue, sent } = makeQueue();

    await expect(
      emitEvent(
        badDb,
        queue,
        { type: "project.created", project: "p" },
        { type: "system" },
        mockLogger,
      ),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});

describe("handleEventQueue", () => {
  let db: D1Database;
  let rows: ReturnType<typeof makeEventsD1>["rows"];

  beforeEach(() => {
    ({ db, rows } = makeEventsD1());
  });

  async function seedEvent(): Promise<string> {
    await emitEvent(
      db,
      null,
      { type: "change.created", project: "p", changeId: "chg_1", workspace: "ws" },
      { type: "user", id: "u1" },
      mockLogger,
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("seed failed");
    return id;
  }

  it("processes a pending event and acks", async () => {
    const eventId = await seedEvent();
    const msg = makeMessage({ eventId });
    const batch = { queue: "stratum-events", messages: [msg] } as unknown as MessageBatch<{
      eventId: string;
    }>;

    await handleEventQueue(batch, makeEnv(db));

    expect(msg.acked).toBe(true);
    expect(msg.retried).toBe(false);
    expect(rows[0]?.status).toBe("processed");
    expect(rows[0]?.attempts).toBe(1);
  });

  it("acks and skips an already-processed event", async () => {
    const eventId = await seedEvent();
    const row = rows[0];
    if (row) row.status = "processed";
    const msg = makeMessage({ eventId });
    const batch = { queue: "stratum-events", messages: [msg] } as unknown as MessageBatch<{
      eventId: string;
    }>;

    await handleEventQueue(batch, makeEnv(db));

    expect(msg.acked).toBe(true);
    expect(rows[0]?.attempts).toBe(0);
  });

  it("acks a message whose event row is missing", async () => {
    const msg = makeMessage({ eventId: "evt_gone" });
    const batch = { queue: "stratum-events", messages: [msg] } as unknown as MessageBatch<{
      eventId: string;
    }>;

    await handleEventQueue(batch, makeEnv(db));
    expect(msg.acked).toBe(true);
  });

  it("acks a malformed message without an eventId", async () => {
    const msg = makeMessage({});
    const batch = { queue: "stratum-events", messages: [msg] } as unknown as MessageBatch<{
      eventId: string;
    }>;

    await handleEventQueue(batch, makeEnv(db));
    expect(msg.acked).toBe(true);
  });
});

describe("sweepStaleEvents", () => {
  it("re-enqueues stale pending events", async () => {
    const { db, rows } = makeEventsD1();
    const { queue, sent } = makeQueue();
    await emitEvent(
      db,
      null,
      { type: "project.created", project: "p" },
      { type: "system" },
      mockLogger,
    );
    const row = rows[0];
    if (row) row.created_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    await sweepStaleEvents(makeEnv(db, queue), mockLogger);

    expect(sent).toEqual([{ eventId: row?.id }]);
    expect(row?.status).toBe("pending");
  });

  it("fails out events that exhausted their attempts", async () => {
    const { db, rows } = makeEventsD1();
    const { queue, sent } = makeQueue();
    await emitEvent(
      db,
      null,
      { type: "project.created", project: "p" },
      { type: "system" },
      mockLogger,
    );
    const row = rows[0];
    if (row) {
      row.created_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      row.attempts = MAX_EVENT_ATTEMPTS;
    }

    await sweepStaleEvents(makeEnv(db, queue), mockLogger);

    expect(sent).toHaveLength(0);
    expect(row?.status).toBe("failed");
  });

  it("processes inline when no queue is bound", async () => {
    const { db, rows } = makeEventsD1();
    await emitEvent(
      db,
      null,
      { type: "project.created", project: "p" },
      { type: "system" },
      mockLogger,
    );
    const row = rows[0];
    if (row) row.created_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    await sweepStaleEvents(makeEnv(db), mockLogger);

    expect(row?.status).toBe("processed");
  });

  it("ignores fresh pending events", async () => {
    const { db, rows } = makeEventsD1();
    const { queue, sent } = makeQueue();
    await emitEvent(
      db,
      null,
      { type: "project.created", project: "p" },
      { type: "system" },
      mockLogger,
    );

    await sweepStaleEvents(makeEnv(db, queue), mockLogger);

    expect(sent).toHaveLength(0);
    expect(rows[0]?.status).toBe("pending");
  });
});
