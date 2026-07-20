import { describe, expect, it, vi } from "vitest";
import { autoCloseLinkedIssues } from "../src/queue/issue-autoclose";
import type { EventRecord } from "../src/storage/events";
import {
  closeIssue,
  createIssue,
  getIssueByNumber,
  listIssues,
  listOpenIssuesByChange,
  updateIssue,
} from "../src/storage/issues";
import type { Env } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeIssuesD1 } from "./helpers/issues-d1";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

async function seedIssue(
  db: D1Database,
  overrides: Partial<Parameters<typeof createIssue>[2]> = {},
) {
  const result = await createIssue(db, mockLogger, {
    project: "my-project",
    title: "Something is broken",
    authorType: "user",
    authorId: "user_1",
    ...overrides,
  });
  if (!result.success) throw new Error("seed failed");
  return result.data;
}

describe("issue storage", () => {
  it("assigns sequential per-project numbers", async () => {
    const { db } = makeIssuesD1();
    const first = await seedIssue(db);
    const second = await seedIssue(db);
    const otherProject = await seedIssue(db, { project: "other" });

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
    expect(otherProject.number).toBe(1);
  });

  it("numbers independently per project_id for same-named projects (no collision)", async () => {
    const { db } = makeIssuesD1();
    // Two projects share the name "acme" but have distinct canonical ids. Under
    // the old per-name numbering + UNIQUE(project, number) this would collide;
    // per project_id each gets its own sequence and (project_id, number) is unique.
    const a1 = await seedIssue(db, { project: "acme", projectId: "proj_A" });
    const b1 = await seedIssue(db, { project: "acme", projectId: "proj_B" });
    const a2 = await seedIssue(db, { project: "acme", projectId: "proj_A" });

    expect(a1.number).toBe(1);
    expect(b1.number).toBe(1);
    expect(a2.number).toBe(2);
  });

  it("continues from legacy NULL-project_id issues instead of restarting at 1", async () => {
    const { db } = makeIssuesD1();
    // A pre-migration issue: no project_id, numbered by name.
    const legacy = await seedIssue(db, { project: "acme" });
    expect(legacy.number).toBe(1);

    // The first stamped issue for that project counts the legacy row via the name
    // fallback, so it is #2 — not a colliding #1.
    const stamped = await seedIssue(db, { project: "acme", projectId: "proj_A" });
    expect(stamped.number).toBe(2);
  });

  it("round-trips issues through getIssueByNumber", async () => {
    const { db } = makeIssuesD1();
    await seedIssue(db, { body: "Details here", linkedChangeId: "chg_1" });

    const fetched = await getIssueByNumber(db, mockLogger, "my-project", 1);
    expect(fetched.success).toBe(true);
    if (!fetched.success) return;
    expect(fetched.data.title).toBe("Something is broken");
    expect(fetched.data.body).toBe("Details here");
    expect(fetched.data.linkedChangeId).toBe("chg_1");
    expect(fetched.data.status).toBe("open");
  });

  it("returns NOT_FOUND for missing issues", async () => {
    const { db } = makeIssuesD1();
    const result = await getIssueByNumber(db, mockLogger, "my-project", 99);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("filters issue lists by status", async () => {
    const { db } = makeIssuesD1();
    await seedIssue(db);
    await seedIssue(db, { title: "Second" });
    await closeIssue(db, mockLogger, "my-project", 1, "user_1");

    const open = await listIssues(db, mockLogger, "my-project", "open");
    const closed = await listIssues(db, mockLogger, "my-project", "closed");
    const all = await listIssues(db, mockLogger, "my-project");

    expect(open.success && open.data.map((i) => i.number)).toEqual([2]);
    expect(closed.success && closed.data.map((i) => i.number)).toEqual([1]);
    expect(all.success && all.data).toHaveLength(2);
  });

  it("closing sets closed_at/closed_by; reopening clears them", async () => {
    const { db } = makeIssuesD1();
    await seedIssue(db);

    const closed = await updateIssue(db, mockLogger, "my-project", 1, {
      status: "closed",
      actorId: "user_9",
    });
    expect(closed.success).toBe(true);
    if (!closed.success) return;
    expect(closed.data.status).toBe("closed");
    expect(closed.data.closedBy).toBe("user_9");
    expect(closed.data.closedAt).toBeTruthy();

    const reopened = await updateIssue(db, mockLogger, "my-project", 1, {
      status: "open",
      actorId: "user_9",
    });
    expect(reopened.success).toBe(true);
    if (!reopened.success) return;
    expect(reopened.data.status).toBe("open");
    expect(reopened.data.closedAt).toBeUndefined();
    expect(reopened.data.closedBy).toBeUndefined();
  });

  it("updates title, body, and linked change", async () => {
    const { db } = makeIssuesD1();
    await seedIssue(db);

    const updated = await updateIssue(db, mockLogger, "my-project", 1, {
      title: "New title",
      body: "New body",
      linkedChangeId: "chg_42",
      actorId: "user_1",
    });
    expect(updated.success).toBe(true);
    if (!updated.success) return;
    expect(updated.data.title).toBe("New title");
    expect(updated.data.body).toBe("New body");
    expect(updated.data.linkedChangeId).toBe("chg_42");
  });

  it("finds open issues by linked change", async () => {
    const { db } = makeIssuesD1();
    await seedIssue(db, { linkedChangeId: "chg_1" });
    await seedIssue(db, { title: "Other", linkedChangeId: "chg_2" });
    await seedIssue(db, { title: "Closed one", linkedChangeId: "chg_1" });
    await closeIssue(db, mockLogger, "my-project", 3, "user_1");

    const result = await listOpenIssuesByChange(db, mockLogger, "chg_1");
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((i) => i.number)).toEqual([1]);
  });
});

describe("autoCloseLinkedIssues", () => {
  function makeMergedEvent(changeId: string): EventRecord {
    return {
      id: "evt_1",
      type: "change.merged",
      project: "my-project",
      actorType: "user",
      payload: { changeId, commit: "abc" },
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
  }

  it("closes open linked issues and emits issue.closed", async () => {
    const { db, issues, emittedEvents } = makeIssuesD1();
    await seedIssue(db, { linkedChangeId: "chg_1" });
    await seedIssue(db, { title: "Unrelated", linkedChangeId: "chg_other" });
    const env = { DB: db } as unknown as Env;

    await autoCloseLinkedIssues(env, makeMergedEvent("chg_1"), mockLogger);

    expect(issues[0]?.status).toBe("closed");
    expect(issues[0]?.closed_by).toBe("system");
    expect(issues[1]?.status).toBe("open");

    const closedEvents = emittedEvents.filter((e) => e.type === "issue.closed");
    expect(closedEvents).toHaveLength(1);
    expect(JSON.parse(closedEvents[0]?.payload ?? "{}")).toMatchObject({
      issueNumber: 1,
      changeId: "chg_1",
    });
  });

  it("ignores events that are not change.merged", async () => {
    const { db, issues } = makeIssuesD1();
    await seedIssue(db, { linkedChangeId: "chg_1" });
    const env = { DB: db } as unknown as Env;

    await autoCloseLinkedIssues(
      env,
      { ...makeMergedEvent("chg_1"), type: "change.created" },
      mockLogger,
    );

    expect(issues[0]?.status).toBe("open");
  });

  it("ignores merged events without a changeId payload", async () => {
    const { db, issues } = makeIssuesD1();
    await seedIssue(db, { linkedChangeId: "chg_1" });
    const env = { DB: db } as unknown as Env;

    const event = makeMergedEvent("chg_1");
    event.payload = {};
    await autoCloseLinkedIssues(env, event, mockLogger);

    expect(issues[0]?.status).toBe("open");
  });

  it("does nothing when no issues link to the change", async () => {
    const { db, emittedEvents } = makeIssuesD1();
    const env = { DB: db } as unknown as Env;

    await expect(
      autoCloseLinkedIssues(env, makeMergedEvent("chg_nope"), mockLogger),
    ).resolves.toBeUndefined();
    expect(emittedEvents).toHaveLength(0);
  });
});
