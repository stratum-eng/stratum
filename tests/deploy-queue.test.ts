import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/deploy/runner", () => ({
  runDeployMessage: vi.fn(async () => ({ success: true, data: { deployments: [] } })),
}));
// The outbox recovery tests assert that an internal work row never reaches a
// subscriber, so webhook delivery is observed rather than performed.
vi.mock("../src/queue/webhook-delivery", () => ({
  deliverEventToWebhooks: vi.fn(async () => {}),
}));

import { runDeployMessage } from "../src/deploy/runner";
import {
  DEPLOY_ENQUEUE_EVENT_TYPE,
  enqueueMergeDeploy,
  handleDeployQueue,
} from "../src/queue/deploy-queue";
import { sweepStaleEvents } from "../src/queue/event-consumer";
import { deliverEventToWebhooks } from "../src/queue/webhook-delivery";
import type { Env, Message, MessageBatch } from "../src/types";
import { AppError } from "../src/utils/errors";
import { createLogger } from "../src/utils/logger";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

interface StubMessage {
  message: Message<unknown>;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function makeMessage(body: unknown): StubMessage {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: {
      id: "msg_1",
      timestamp: new Date(),
      body,
      attempts: 1,
      ack,
      retry,
    } as unknown as Message<unknown>,
    ack,
    retry,
  };
}

function makeBatch(messages: Message<unknown>[]): MessageBatch<unknown> {
  return {
    queue: "stratum-deploys",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

const env = {} as Env;
const logger = createLogger({ component: "test" });

const MERGED_AT = "2026-09-04T09:00:00.000Z";

const mergeBody = { kind: "merge", projectId: "proj_1", changeId: "chg_1", commitSha: "sha_1" };

describe("handleDeployQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runDeployMessage).mockResolvedValue({ success: true, data: { deployments: [] } });
  });

  it("routes one message to one deployment run and acks it", async () => {
    const msg = makeMessage(mergeBody);
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(runDeployMessage).toHaveBeenCalledTimes(1);
    expect(runDeployMessage).toHaveBeenCalledWith(
      env,
      { kind: "merge", projectId: "proj_1", changeId: "chg_1", commitSha: "sha_1" },
      expect.any(Object),
    );
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("carries the merge time through to the runner", async () => {
    const msg = makeMessage({ ...mergeBody, mergedAt: MERGED_AT });
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(runDeployMessage).toHaveBeenCalledWith(
      env,
      { ...mergeBody, mergedAt: MERGED_AT },
      expect.any(Object),
    );
  });

  // A merge time the deployments columns would reject must not reach them: the
  // insert would fail and the deploy would be stranded, where dropping the field
  // costs only the ordering guarantee for this one message.
  it.each([
    ["SQLite's space-separated form", "2026-09-04 09:00:00"],
    ["a non-timestamp", "yesterday"],
    ["a number", 1_757_000_000_000],
  ])("drops an unusable merge time (%s) rather than stranding the deploy", async (_l, mergedAt) => {
    const msg = makeMessage({ ...mergeBody, mergedAt });
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(runDeployMessage).toHaveBeenCalledWith(env, mergeBody, expect.any(Object));
    expect(msg.ack).toHaveBeenCalledTimes(1);
  });

  it("passes a deployment message through unchanged", async () => {
    const msg = makeMessage({ kind: "deployment", projectId: "proj_1", deploymentId: "dep_1" });
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(runDeployMessage).toHaveBeenCalledWith(
      env,
      { kind: "deployment", projectId: "proj_1", deploymentId: "dep_1" },
      expect.any(Object),
    );
    expect(msg.ack).toHaveBeenCalled();
  });

  // An abort is the runner saying "no redelivery of this can ever succeed".
  it("acks an aborted run instead of retrying it", async () => {
    vi.mocked(runDeployMessage).mockResolvedValue({
      success: true,
      data: { deployments: [], aborted: "The change was reverted" },
    });
    const msg = makeMessage(mergeBody);
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  // A failed deployment row is a result, not a delivery failure.
  it("acks a run that produced a failed deployment", async () => {
    vi.mocked(runDeployMessage).mockResolvedValue({
      success: true,
      data: {
        deployments: [
          { deploymentId: "dep_1", name: "site", status: "failed", reason: "Missing secret TOKEN" },
        ],
      },
    });
    const msg = makeMessage(mergeBody);
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("retries when the run could not determine what happened", async () => {
    vi.mocked(runDeployMessage).mockResolvedValue({
      success: false,
      error: new AppError("D1 unavailable", "INTERNAL_ERROR", 500),
    });
    const msg = makeMessage(mergeBody);
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("retries when the run throws despite its no-throw contract", async () => {
    vi.mocked(runDeployMessage).mockRejectedValue(new Error("boom"));
    const msg = makeMessage(mergeBody);
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  // Redelivering a message the consumer cannot parse changes nothing about it,
  // so it is acked rather than burned through the retry budget.
  it.each([
    ["a non-object body", "not-a-message"],
    ["a null body", null],
    ["an unknown kind", { kind: "publish", projectId: "proj_1" }],
    ["a merge without projectId", { kind: "merge", changeId: "chg_1", commitSha: "sha_1" }],
    ["a merge with a blank projectId", { ...mergeBody, projectId: "   " }],
    ["a merge without commitSha", { kind: "merge", projectId: "proj_1", changeId: "chg_1" }],
    ["a deployment without deploymentId", { kind: "deployment", projectId: "proj_1" }],
  ])("acks %s without running a deploy", async (_label, body) => {
    const msg = makeMessage(body);
    await handleDeployQueue(makeBatch([msg.message]), env);

    expect(runDeployMessage).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it("handles every message in a batch independently", async () => {
    vi.mocked(runDeployMessage)
      .mockResolvedValueOnce({
        success: false,
        error: new AppError("D1 unavailable", "INTERNAL_ERROR", 500),
      })
      .mockResolvedValueOnce({ success: true, data: { deployments: [] } });
    const first = makeMessage(mergeBody);
    const second = makeMessage(mergeBody);
    await handleDeployQueue(makeBatch([first.message, second.message]), env);

    expect(first.retry).toHaveBeenCalledTimes(1);
    expect(second.ack).toHaveBeenCalledTimes(1);
  });
});

describe("enqueueMergeDeploy", () => {
  function envWithQueue(send: ReturnType<typeof vi.fn>): Env {
    return { DEPLOY_QUEUE: { send } } as unknown as Env;
  }

  it.each(["skipped", "passed"] as const)(
    "enqueues after a %s post-merge check",
    async (status) => {
      const send = vi.fn(async () => {});
      await enqueueMergeDeploy(envWithQueue(send), logger, {
        projectId: "proj_1",
        changeId: "chg_1",
        commitSha: "sha_1",
        postMergeStatus: status,
        mergedAt: MERGED_AT,
      });

      expect(send).toHaveBeenCalledWith({
        kind: "merge",
        projectId: "proj_1",
        changeId: "chg_1",
        commitSha: "sha_1",
        mergedAt: MERGED_AT,
      });
    },
  );

  // The queue merge path has no merge time in scope, so the change row is what
  // the message is stamped from. Enqueue time will not do: `runPostMergeCheck`
  // runs between the merge and this call and can spend minutes in a sandbox, so
  // a slow-checked merge would be stamped *after* a later, faster one.
  it("reads the merge time off the change when the caller has none", async () => {
    const send = vi.fn(async () => {});
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({
            id: "chg_1",
            project: "site",
            status: "merged",
            merged_at: MERGED_AT,
          }),
        }),
      }),
    } as unknown as D1Database;

    await enqueueMergeDeploy({ DB: db, DEPLOY_QUEUE: { send } } as unknown as Env, logger, {
      projectId: "proj_1",
      changeId: "chg_1",
      commitSha: "sha_1",
      postMergeStatus: "passed",
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ mergedAt: MERGED_AT }));
  });

  // A merge with no readable `merged_at` still deploys. Enqueue time is an
  // approximation, but it still orders correctly against every merge whose time
  // *is* known, which a missing field would not.
  it("falls back to enqueue time when the change carries no merge time", async () => {
    const send = vi.fn(async () => {});
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("D1 unavailable");
          },
        }),
      }),
    } as unknown as D1Database;

    await enqueueMergeDeploy({ DB: db, DEPLOY_QUEUE: { send } } as unknown as Env, logger, {
      projectId: "proj_1",
      changeId: "chg_1",
      commitSha: "sha_1",
      postMergeStatus: "passed",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ mergedAt: expect.any(String) as unknown as string }),
    );
    const [message] = send.mock.calls[0] as unknown as [{ mergedAt: string }];
    expect(Number.isNaN(Date.parse(message.mergedAt))).toBe(false);
  });

  // The regression this whole ordering exists to prevent: a failed post-merge
  // check reverts the merge, so deploying that commit publishes reverted code.
  it.each(["reverted", "failed"] as const)("does not enqueue after a %s check", async (status) => {
    const send = vi.fn(async () => {});
    await enqueueMergeDeploy(envWithQueue(send), logger, {
      projectId: "proj_1",
      changeId: "chg_1",
      commitSha: "sha_1",
      postMergeStatus: status,
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("is inert when no deploy queue is bound", async () => {
    await expect(
      enqueueMergeDeploy({} as Env, logger, {
        projectId: "proj_1",
        changeId: "chg_1",
        commitSha: "sha_1",
        postMergeStatus: "passed",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not enqueue without a commit to deploy", async () => {
    const send = vi.fn(async () => {});
    await enqueueMergeDeploy(envWithQueue(send), logger, {
      projectId: "proj_1",
      changeId: "chg_1",
      commitSha: "",
      postMergeStatus: "passed",
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a queue-send failure", async () => {
    const send = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    await expect(
      enqueueMergeDeploy(envWithQueue(send), logger, {
        projectId: "proj_1",
        changeId: "chg_1",
        commitSha: "sha_1",
        postMergeStatus: "passed",
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalled();
  });
});

/**
 * The durability half of this queue: a `send` that fails must not lose the
 * request. Real SQLite, because the outbox row is the whole guarantee.
 */
describe("a deploy request whose send failed", () => {
  let db: D1Database;
  let raw: ReturnType<typeof makeSqliteD1>["raw"];

  const rejects = () =>
    vi.fn(async () => {
      throw new Error("queue unavailable");
    });

  interface OutboxRow {
    id: string;
    type: string;
    project: string;
    project_id: string | null;
    status: string;
    payload: string;
  }

  function outbox(): OutboxRow[] {
    return raw
      .prepare("SELECT id, type, project, project_id, status, payload FROM events")
      .all() as unknown as OutboxRow[];
  }

  beforeEach(() => {
    const made = makeSqliteD1();
    db = made.db;
    raw = made.raw;
    vi.clearAllMocks();
  });

  // The merge path is the one a sweep over `deployments` could never fix: the
  // runner creates rows only *after* it consumes the message, so a dropped send
  // leaves nothing at all behind.
  it("is recorded in the outbox when the merge enqueue fails", async () => {
    await enqueueMergeDeploy(
      { DB: db, DEPLOY_QUEUE: { send: rejects() } } as unknown as Env,
      logger,
      {
        projectId: "proj_1",
        changeId: "chg_1",
        commitSha: "sha_1",
        postMergeStatus: "passed",
        mergedAt: MERGED_AT,
      },
    );

    const rows = outbox();
    expect(rows).toHaveLength(1);
    const row = rows[0] as OutboxRow;
    expect(row.type).toBe(DEPLOY_ENQUEUE_EVENT_TYPE);
    expect(row.status).toBe("pending");
    expect(row.project_id).toBe("proj_1");
    expect(JSON.parse(row.payload)).toEqual({
      kind: "merge",
      projectId: "proj_1",
      changeId: "chg_1",
      commitSha: "sha_1",
      mergedAt: MERGED_AT,
    });
  });

  it("writes nothing when the send succeeds", async () => {
    await enqueueMergeDeploy(
      { DB: db, DEPLOY_QUEUE: { send: vi.fn(async () => {}) } } as unknown as Env,
      logger,
      {
        projectId: "proj_1",
        changeId: "chg_1",
        commitSha: "sha_1",
        postMergeStatus: "passed",
        mergedAt: MERGED_AT,
      },
    );

    expect(outbox()).toHaveLength(0);
  });

  // End to end: the row the failed send left behind is what the five-minute
  // sweep turns back into a deploy queue message. Nothing here runs the deploy
  // on the events queue — the handler only forwards.
  it("is recovered by the outbox sweep and forwarded to the deploy queue", async () => {
    await enqueueMergeDeploy(
      { DB: db, DEPLOY_QUEUE: { send: rejects() } } as unknown as Env,
      logger,
      {
        projectId: "proj_1",
        changeId: "chg_1",
        commitSha: "sha_1",
        postMergeStatus: "passed",
        mergedAt: MERGED_AT,
      },
    );

    // Age the row past the sweep's staleness window.
    raw.prepare("UPDATE events SET created_at = ?").run("2026-01-01T00:00:00.000Z");

    const send = vi.fn(async () => {});
    // No EVENTS_QUEUE bound, so the sweep processes the row inline — the same
    // handlers a queue delivery would run.
    await sweepStaleEvents({ DB: db, DEPLOY_QUEUE: { send } } as unknown as Env, logger);

    expect(send).toHaveBeenCalledWith({
      kind: "merge",
      projectId: "proj_1",
      changeId: "chg_1",
      commitSha: "sha_1",
      mergedAt: MERGED_AT,
    });
    expect((outbox()[0] as OutboxRow).status).toBe("processed");
    // An internal work row is not a notification: a `*` webhook subscriber must
    // never see one.
    expect(deliverEventToWebhooks).not.toHaveBeenCalled();
  });

  it("stays pending when the forward fails again, so a later sweep retries it", async () => {
    await enqueueMergeDeploy(
      { DB: db, DEPLOY_QUEUE: { send: rejects() } } as unknown as Env,
      logger,
      {
        projectId: "proj_1",
        changeId: "chg_1",
        commitSha: "sha_1",
        postMergeStatus: "passed",
        mergedAt: MERGED_AT,
      },
    );
    raw.prepare("UPDATE events SET created_at = ?").run("2026-01-01T00:00:00.000Z");

    await sweepStaleEvents({ DB: db, DEPLOY_QUEUE: { send: rejects() } } as unknown as Env, logger);

    expect((outbox()[0] as OutboxRow).status).toBe("pending");
  });
});
