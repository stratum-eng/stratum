import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { autoCloseLinkedIssues } from "../src/queue/issue-autoclose";
import { issuesRouter } from "../src/routes/issues";
import type { EventRecord } from "../src/storage/events";
import { addIssueComment, listIssueComments } from "../src/storage/issue-comments";
import { getLabelsForIssues, listIssueLabels, setIssueLabels } from "../src/storage/issue-labels";
import {
  closeIssue,
  createIssue,
  escapeLike,
  getIssueByNumber,
  listIssues,
  listOpenIssuesByChange,
  updateIssue,
} from "../src/storage/issues";
import type { Env, ProjectEntry } from "../src/types";
import { hashToken } from "../src/utils/crypto";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";
import { makeIssuesD1 } from "./helpers/issues-d1";
import { makeSqliteD1, makeThrowingD1 } from "./helpers/sqlite-d1";

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

describe("issue tenant isolation (project_id-scoped reads)", () => {
  it("does not return a same-named project's issue in another namespace", async () => {
    const { db } = makeIssuesD1();
    // Two projects share the name "acme" but have distinct canonical ids; each
    // gets its own number sequence (migration 035), so isolation comes from
    // project_id on both the numbering AND the read.
    await seedIssue(db, { project: "acme", projectId: "proj_A", title: "A's issue" });
    await seedIssue(db, { project: "acme", projectId: "proj_B", title: "B's issue" });

    const aOnly = await listIssues(db, mockLogger, "acme", undefined, { projectId: "proj_A" });
    const bOnly = await listIssues(db, mockLogger, "acme", undefined, { projectId: "proj_B" });
    expect(aOnly.success && aOnly.data.map((i) => i.title)).toEqual(["A's issue"]);
    expect(bOnly.success && bOnly.data.map((i) => i.title)).toEqual(["B's issue"]);
  });

  it("getIssueByNumber scoped by project_id returns each tenant's OWN issue, never the other's", async () => {
    const { db } = makeIssuesD1();
    // Per-project-id numbering (035): each same-named project gets its own #1.
    const a = await seedIssue(db, { project: "acme", projectId: "proj_A", title: "A#1" });
    const b = await seedIssue(db, { project: "acme", projectId: "proj_B", title: "B#1" });
    expect(a.number).toBe(1);
    expect(b.number).toBe(1); // independent sequence, not a shared 2

    const forA = await getIssueByNumber(db, mockLogger, "acme", 1, { projectId: "proj_A" });
    const forB = await getIssueByNumber(db, mockLogger, "acme", 1, { projectId: "proj_B" });
    // Each project resolves its OWN #1 — the scoped read never crosses tenants.
    expect(forA.success && forA.data.title).toBe("A#1");
    expect(forB.success && forB.data.title).toBe("B#1");
  });

  it("legacy rows with NULL project_id remain reachable via the name fallback", async () => {
    const { db } = makeIssuesD1();
    await seedIssue(db, { project: "legacy" }); // no projectId → project_id NULL

    const found = await getIssueByNumber(db, mockLogger, "legacy", 1, { projectId: "proj_new" });
    expect(found.success).toBe(true);
  });

  it("bounds the result with a limit when one is given", async () => {
    const { db } = makeIssuesD1();
    await seedIssue(db, { project: "acme", projectId: "proj_A" });
    await seedIssue(db, { project: "acme", projectId: "proj_A" });
    await seedIssue(db, { project: "acme", projectId: "proj_A" });

    const capped = await listIssues(db, mockLogger, "acme", undefined, {
      projectId: "proj_A",
      limit: 2,
    });
    expect(capped.success && capped.data).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: the issues router + auth middleware against a REAL SQLite
// engine (every production migration applied) so the storage layer's actual
// SQL — LIKE escaping, label subqueries, LIMIT/OFFSET — is what's exercised.
// ---------------------------------------------------------------------------

const OWNER_TOKEN = "stratum_user_ownertoken0000000000000000";
const READER_TOKEN = "stratum_user_readertoken000000000000000";
const AGENT_TOKEN = "stratum_agent_agenttoken000000000000000";
const OWNER_AUTH = { Authorization: `Bearer ${OWNER_TOKEN}` };
const READER_AUTH = { Authorization: `Bearer ${READER_TOKEN}` };
const AGENT_AUTH = { Authorization: `Bearer ${AGENT_TOKEN}` };

const PROJECT_ID = "proj_A";
const API = "/api/projects/testns/my-project/issues";

/** Loosely-typed response body — each test's assertions pin the fields that matter. */
interface ApiIssue {
  id: string;
  number: number;
  title: string;
  status: string;
  assignee?: string;
  linkedChangeId?: string;
  labels?: string[];
}
interface ApiComment {
  id: string;
  authorType: string;
  authorId: string;
  body: string;
}
interface ApiBody {
  issue: ApiIssue;
  issues: ApiIssue[];
  comment: ApiComment;
  comments: ApiComment[];
}
const jsonOf = (res: Response) => res.json() as Promise<ApiBody>;

async function makeIssuesApp(opts?: { visibility?: "public" | "private" }) {
  const { db, raw } = makeSqliteD1();
  const now = "2026-01-01T00:00:00.000Z";
  const insertUser = raw.prepare(
    "INSERT INTO users (id, email, username, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertUser.run("user_owner", "owner@example.com", "owner", await hashToken(OWNER_TOKEN), now);
  insertUser.run("user_reader", "reader@example.com", "reader", await hashToken(READER_TOKEN), now);
  raw
    .prepare(
      "INSERT INTO agents (id, name, owner_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run("agent_test", "test-agent", "user_owner", await hashToken(AGENT_TOKEN), now);

  const project: ProjectEntry = {
    id: PROJECT_ID,
    name: "my-project",
    slug: "my-project",
    namespace: "testns",
    ownerId: "user_owner",
    ownerType: "user",
    remote: "https://artifacts.example.com/repos/my-project",
    createdAt: now,
    ...(opts?.visibility ? { visibility: opts.visibility } : {}),
  } as ProjectEntry;
  const kv = makeFakeKV();
  await kv.put("project:testns:my-project", JSON.stringify(project));

  const env = { DB: db, STATE: kv } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/projects", issuesRouter);

  /** Seed a change row directly; `project` may hold the name OR the id (legacy mix). */
  const seedChange = (id: string, projectRef: string, projectId: string | null = null) => {
    raw
      .prepare(
        "INSERT INTO changes (id, project, project_id, workspace, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
      )
      .run(id, projectRef, projectId, "ws-1", now);
  };

  const json = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );

  const openIssue = async (title: string, extra?: Record<string, unknown>) => {
    const res = await json("POST", API, { title, ...extra }, OWNER_AUTH);
    expect(res.status).toBe(201);
    return (await jsonOf(res)).issue as { id: string; number: number };
  };

  return { app, env, db, raw, json, openIssue, seedChange };
}

describe("linkedChangeId project comparison (regression #198)", () => {
  it("accepts a change whose project column holds the project ID (legacy id-keyed row)", async () => {
    const { json, seedChange } = await makeIssuesApp();
    seedChange("chg_idkeyed", PROJECT_ID); // change.project = project.id, project_id NULL

    const res = await json(
      "POST",
      API,
      { title: "Bug", linkedChangeId: "chg_idkeyed" },
      OWNER_AUTH,
    );
    expect(res.status).toBe(201);
    const { issue } = await jsonOf(res);
    expect(issue.linkedChangeId).toBe("chg_idkeyed");
  });

  it("accepts a change matched via its canonical projectId column", async () => {
    const { json, seedChange } = await makeIssuesApp();
    // Neither name nor id in the legacy column, but project_id matches.
    seedChange("chg_canonical", "stale-name", PROJECT_ID);

    const res = await json(
      "POST",
      API,
      { title: "Bug", linkedChangeId: "chg_canonical" },
      OWNER_AUTH,
    );
    expect(res.status).toBe(201);
  });

  it("still accepts a name-keyed change", async () => {
    const { json, seedChange } = await makeIssuesApp();
    seedChange("chg_named", "my-project");

    const res = await json("POST", API, { title: "Bug", linkedChangeId: "chg_named" }, OWNER_AUTH);
    expect(res.status).toBe(201);
  });

  it("rejects a change belonging to another project", async () => {
    const { json, seedChange } = await makeIssuesApp();
    seedChange("chg_other", "someone-elses-project", "proj_B");

    const res = await json("POST", API, { title: "Bug", linkedChangeId: "chg_other" }, OWNER_AUTH);
    expect(res.status).toBe(400);
  });

  it("PATCH accepts an id-keyed change and rejects a foreign one", async () => {
    const { json, openIssue, seedChange } = await makeIssuesApp();
    await openIssue("Bug");
    seedChange("chg_idkeyed", PROJECT_ID);
    seedChange("chg_other", "other-project");

    const okRes = await json("PATCH", `${API}/1`, { linkedChangeId: "chg_idkeyed" }, OWNER_AUTH);
    expect(okRes.status).toBe(200);
    expect((await jsonOf(okRes)).issue.linkedChangeId).toBe("chg_idkeyed");

    const badRes = await json("PATCH", `${API}/1`, { linkedChangeId: "chg_other" }, OWNER_AUTH);
    expect(badRes.status).toBe(400);

    const clearRes = await json("PATCH", `${API}/1`, { linkedChangeId: null }, OWNER_AUTH);
    expect(clearRes.status).toBe(200);
    expect((await jsonOf(clearRes)).issue.linkedChangeId).toBeUndefined();
  });
});

describe("issue comments API", () => {
  it("requires authentication to comment", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const res = await json("POST", `${API}/1/comments`, { body: "hi" });
    expect(res.status).toBe(401);
  });

  it("adds and lists comments (users and agents)", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const first = await json("POST", `${API}/1/comments`, { body: "from user" }, OWNER_AUTH);
    expect(first.status).toBe(201);
    const firstBody = await jsonOf(first);
    expect(firstBody.comment).toMatchObject({
      authorType: "user",
      authorId: "user_owner",
      body: "from user",
    });

    const second = await json("POST", `${API}/1/comments`, { body: "from agent" }, AGENT_AUTH);
    expect(second.status).toBe(201);
    expect((await jsonOf(second)).comment).toMatchObject({
      authorType: "agent",
      authorId: "agent_test",
    });

    const list = await json("GET", `${API}/1/comments`, undefined, OWNER_AUTH);
    expect(list.status).toBe(200);
    const { comments } = await jsonOf(list);
    expect(comments.map((c: { body: string }) => c.body)).toEqual(["from user", "from agent"]);
  });

  it("rejects empty, whitespace-only, and non-string bodies", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    for (const body of [{}, { body: "" }, { body: "   " }, { body: 42 }]) {
      const res = await json("POST", `${API}/1/comments`, body, OWNER_AUTH);
      expect(res.status).toBe(400);
    }
  });

  it("caps comment length at 20k characters", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const res = await json("POST", `${API}/1/comments`, { body: "x".repeat(25_000) }, OWNER_AUTH);
    expect(res.status).toBe(201);
    expect((await jsonOf(res)).comment.body).toHaveLength(20_000);
  });

  it("404s comments on a missing issue and 400s invalid issue numbers", async () => {
    const { json } = await makeIssuesApp();

    const missing = await json("POST", `${API}/99/comments`, { body: "hi" }, OWNER_AUTH);
    expect(missing.status).toBe(404);
    const invalid = await json("POST", `${API}/abc/comments`, { body: "hi" }, OWNER_AUTH);
    expect(invalid.status).toBe(400);
    const listMissing = await json("GET", `${API}/99/comments`, undefined, OWNER_AUTH);
    expect(listMissing.status).toBe(404);
    const listInvalid = await json("GET", `${API}/abc/comments`, undefined, OWNER_AUTH);
    expect(listInvalid.status).toBe(400);
  });

  it("hides comments of a private project from non-members", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const read = await json("GET", `${API}/1/comments`, undefined, READER_AUTH);
    expect(read.status).toBe(404);
    const write = await json("POST", `${API}/1/comments`, { body: "hi" }, READER_AUTH);
    expect(write.status).toBe(404);
  });

  it("lets any reader of a public project comment", async () => {
    const { json, openIssue } = await makeIssuesApp({ visibility: "public" });
    await openIssue("Bug");

    const res = await json("POST", `${API}/1/comments`, { body: "drive-by insight" }, READER_AUTH);
    expect(res.status).toBe(201);
    expect((await jsonOf(res)).comment.authorId).toBe("user_reader");
  });

  it("form posts redirect back to the issue page", async () => {
    const { app, env, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const res = await app.fetch(
      new Request(`http://localhost${API}/1/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...OWNER_AUTH,
        },
        body: new URLSearchParams({ body: "via form" }).toString(),
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/testns/my-project/issues/1");
  });

  it("paginates comments with limit/offset in chronological order", async () => {
    const { json, raw, openIssue } = await makeIssuesApp();
    const issue = await openIssue("Bug");
    // Insert directly with distinct timestamps so the order is unambiguous.
    const insert = raw.prepare(
      "INSERT INTO issue_comments (id, issue_id, author_type, author_id, body, created_at) VALUES (?, ?, 'user', 'user_owner', ?, ?)",
    );
    insert.run("icm_1", issue.id, "one", "2026-01-01T00:00:01.000Z");
    insert.run("icm_2", issue.id, "two", "2026-01-01T00:00:02.000Z");
    insert.run("icm_3", issue.id, "three", "2026-01-01T00:00:03.000Z");

    const page1 = await json("GET", `${API}/1/comments?limit=2`, undefined, OWNER_AUTH);
    expect((await jsonOf(page1)).comments.map((c: { body: string }) => c.body)).toEqual([
      "one",
      "two",
    ]);
    const page2 = await json("GET", `${API}/1/comments?limit=2&offset=2`, undefined, OWNER_AUTH);
    expect((await jsonOf(page2)).comments.map((c: { body: string }) => c.body)).toEqual(["three"]);
  });
});

describe("issue labels API", () => {
  it("sets, replaces, and clears labels via PATCH", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const set = await json("PATCH", `${API}/1`, { labels: ["ui", "bug"] }, OWNER_AUTH);
    expect(set.status).toBe(200);
    expect((await jsonOf(set)).issue.labels).toEqual(["bug", "ui"]);

    const replace = await json("PATCH", `${API}/1`, { labels: ["bug"] }, OWNER_AUTH);
    expect((await jsonOf(replace)).issue.labels).toEqual(["bug"]);

    const clear = await json("PATCH", `${API}/1`, { labels: [] }, OWNER_AUTH);
    expect((await jsonOf(clear)).issue.labels).toEqual([]);
  });

  it("leaves labels untouched when the PATCH omits them", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");
    await json("PATCH", `${API}/1`, { labels: ["bug"] }, OWNER_AUTH);

    const res = await json("PATCH", `${API}/1`, { title: "Renamed" }, OWNER_AUTH);
    expect(res.status).toBe(200);
    const { issue } = await jsonOf(res);
    expect(issue.title).toBe("Renamed");
    expect(issue.labels).toEqual(["bug"]);
  });

  it("dedupes labels and validates the payload", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const deduped = await json(
      "PATCH",
      `${API}/1`,
      { labels: ["bug", "bug", " bug "] },
      OWNER_AUTH,
    );
    expect(deduped.status).toBe(200);
    expect((await jsonOf(deduped)).issue.labels).toEqual(["bug"]);

    for (const labels of ["bug", [""], ["  "], [42], [null]]) {
      const res = await json("PATCH", `${API}/1`, { labels }, OWNER_AUTH);
      expect(res.status).toBe(400);
    }

    const tooMany = await json(
      "PATCH",
      `${API}/1`,
      { labels: Array.from({ length: 21 }, (_, i) => `label-${i}`) },
      OWNER_AUTH,
    );
    expect(tooMany.status).toBe(400);
  });

  it("filters the listing by ?label= and returns labels on list + detail", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Crash");
    await openIssue("Slow");
    await json("PATCH", `${API}/1`, { labels: ["bug"] }, OWNER_AUTH);
    await json("PATCH", `${API}/2`, { labels: ["perf"] }, OWNER_AUTH);

    const filtered = await json("GET", `${API}?label=bug`, undefined, OWNER_AUTH);
    const { issues } = await jsonOf(filtered);
    expect(issues.map((i: { title: string }) => i.title)).toEqual(["Crash"]);
    expect(issues[0]?.labels).toEqual(["bug"]);

    const detail = await json("GET", `${API}/2`, undefined, OWNER_AUTH);
    expect((await jsonOf(detail)).issue.labels).toEqual(["perf"]);

    const none = await json("GET", `${API}?label=nope`, undefined, OWNER_AUTH);
    expect((await jsonOf(none)).issues).toEqual([]);
  });
});

describe("issue assignee API", () => {
  it("sets, filters by, and clears the assignee", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");
    await openIssue("Other");

    const set = await json("PATCH", `${API}/1`, { assignee: "user_reader" }, OWNER_AUTH);
    expect(set.status).toBe(200);
    expect((await jsonOf(set)).issue.assignee).toBe("user_reader");

    const filtered = await json("GET", `${API}?assignee=user_reader`, undefined, OWNER_AUTH);
    expect((await jsonOf(filtered)).issues.map((i: { number: number }) => i.number)).toEqual([1]);

    const cleared = await json("PATCH", `${API}/1`, { assignee: null }, OWNER_AUTH);
    expect((await jsonOf(cleared)).issue.assignee).toBeUndefined();
    const clearedByEmpty = await json("PATCH", `${API}/2`, { assignee: "" }, OWNER_AUTH);
    expect(clearedByEmpty.status).toBe(200);

    const empty = await json("GET", `${API}?assignee=user_reader`, undefined, OWNER_AUTH);
    expect((await jsonOf(empty)).issues).toEqual([]);
  });

  it("rejects a non-string assignee", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    for (const assignee of [42, ["a"], "   "]) {
      const res = await json("PATCH", `${API}/1`, { assignee }, OWNER_AUTH);
      expect(res.status).toBe(400);
    }
  });

  it("requires write access to update issues (labels/assignee included)", async () => {
    const { json, openIssue } = await makeIssuesApp({ visibility: "public" });
    await openIssue("Bug");

    const res = await json("PATCH", `${API}/1`, { assignee: "user_reader" }, READER_AUTH);
    expect(res.status).toBe(403);
  });
});

describe("issue search + pagination API", () => {
  it("matches title and body case-insensitively via ?q=", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Crash on save", { body: "The editor dies" });
    await openIssue("Slow builds", { body: "CI takes forever" });

    const byTitle = await json("GET", `${API}?q=CRASH`, undefined, OWNER_AUTH);
    expect((await jsonOf(byTitle)).issues.map((i: { number: number }) => i.number)).toEqual([1]);

    const byBody = await json("GET", `${API}?q=takes+forever`, undefined, OWNER_AUTH);
    expect((await jsonOf(byBody)).issues.map((i: { number: number }) => i.number)).toEqual([2]);

    const nothing = await json("GET", `${API}?q=zzz`, undefined, OWNER_AUTH);
    expect((await jsonOf(nothing)).issues).toEqual([]);
  });

  it("escapes LIKE metacharacters so % and _ match literally", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Progress hits 100% then hangs");
    await openIssue("Progress hits 100 then hangs"); // would match an unescaped %
    await openIssue("score_test fails");
    await openIssue("scoreXtest fails"); // would match an unescaped _

    const percent = await json(
      "GET",
      `${API}?q=${encodeURIComponent("100%")}`,
      undefined,
      OWNER_AUTH,
    );
    expect((await jsonOf(percent)).issues.map((i: { number: number }) => i.number)).toEqual([1]);

    const underscore = await json("GET", `${API}?q=score_test`, undefined, OWNER_AUTH);
    expect((await jsonOf(underscore)).issues.map((i: { number: number }) => i.number)).toEqual([3]);
  });

  it("combines q with the status filter and paginates with limit/offset", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("bug one");
    await openIssue("bug two");
    await openIssue("bug three");
    await openIssue("feature");
    await json("PATCH", `${API}/3`, { status: "closed" }, OWNER_AUTH);

    const openBugs = await json("GET", `${API}?q=bug&status=open`, undefined, OWNER_AUTH);
    expect((await jsonOf(openBugs)).issues.map((i: { number: number }) => i.number)).toEqual([
      2, 1,
    ]);

    const closedBugs = await json("GET", `${API}?q=bug&status=closed`, undefined, OWNER_AUTH);
    expect((await jsonOf(closedBugs)).issues.map((i: { number: number }) => i.number)).toEqual([3]);

    // Newest-first listing, one per page.
    const page1 = await json("GET", `${API}?limit=1`, undefined, OWNER_AUTH);
    expect((await jsonOf(page1)).issues.map((i: { number: number }) => i.number)).toEqual([4]);
    const page2 = await json("GET", `${API}?limit=1&offset=1`, undefined, OWNER_AUTH);
    expect((await jsonOf(page2)).issues.map((i: { number: number }) => i.number)).toEqual([3]);
    const page3 = await json("GET", `${API}?limit=2&offset=2`, undefined, OWNER_AUTH);
    expect((await jsonOf(page3)).issues.map((i: { number: number }) => i.number)).toEqual([2, 1]);

    // Bogus offsets fall back to no offset.
    const bogus = await json("GET", `${API}?limit=1&offset=-3`, undefined, OWNER_AUTH);
    expect((await jsonOf(bogus)).issues.map((i: { number: number }) => i.number)).toEqual([4]);
  });
});

describe("issue routes: auth, form posts, and error paths", () => {
  it("requires authentication to open an issue", async () => {
    const { json } = await makeIssuesApp();
    const res = await json("POST", API, { title: "Bug" });
    expect(res.status).toBe(401);
  });

  it("hides a private project's issues from non-members (create, list, detail)", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    expect((await json("POST", API, { title: "Sneaky" }, READER_AUTH)).status).toBe(404);
    expect((await json("GET", API, undefined, READER_AUTH)).status).toBe(404);
    expect((await json("GET", `${API}/1`, undefined, READER_AUTH)).status).toBe(404);
  });

  it("404s an unknown project path", async () => {
    const { json } = await makeIssuesApp();
    const res = await json(
      "POST",
      "/api/projects/testns/nope/issues",
      { title: "Bug" },
      OWNER_AUTH,
    );
    expect(res.status).toBe(404);
  });

  it("opens issues from form posts (redirect) and validates the title", async () => {
    const { app, env } = await makeIssuesApp();

    const formPost = (fields: Record<string, string>) =>
      app.fetch(
        new Request(`http://localhost${API}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...OWNER_AUTH },
          body: new URLSearchParams(fields).toString(),
        }),
        env,
      );

    const created = await formPost({ title: "Via form", body: "details" });
    expect(created.status).toBe(302);
    expect(created.headers.get("location")).toBe("/testns/my-project/issues/1");

    const missingTitle = await formPost({ body: "no title" });
    expect(missingTitle.status).toBe(400);
  });

  it("refuses opening an issue while the project owner's account is deleting (409)", async () => {
    const { json, raw } = await makeIssuesApp({ visibility: "public" });
    raw.prepare("UPDATE users SET deleting_at = ? WHERE id = 'user_owner'").run("2026-01-01");

    // The reader still authenticates (their account is fine) and can read the
    // public project, but the deletion guard refuses the write.
    const res = await json("POST", API, { title: "Bug" }, READER_AUTH);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("TARGET_DELETING");
  });

  it("PATCH validates auth, issue number, and existence", async () => {
    const { json } = await makeIssuesApp();

    expect((await json("PATCH", `${API}/1`, { title: "x" })).status).toBe(401);
    expect((await json("PATCH", `${API}/abc`, { title: "x" }, OWNER_AUTH)).status).toBe(400);
    expect((await json("PATCH", `${API}/9`, { title: "x" }, OWNER_AUTH)).status).toBe(404);
  });

  it("PATCH rejects invalid title/body/status/linkedChangeId payloads", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    expect((await json("PATCH", `${API}/1`, { title: "  " }, OWNER_AUTH)).status).toBe(400);
    expect((await json("PATCH", `${API}/1`, { body: 42 }, OWNER_AUTH)).status).toBe(400);
    expect((await json("PATCH", `${API}/1`, { status: "wontfix" }, OWNER_AUTH)).status).toBe(400);
    expect((await json("PATCH", `${API}/1`, { linkedChangeId: 42 }, OWNER_AUTH)).status).toBe(400);
    expect(
      (await json("PATCH", `${API}/1`, { linkedChangeId: "chg_missing" }, OWNER_AUTH)).status,
    ).toBe(400);
  });

  it("closing via PATCH emits and detail 400s on a bad number", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const closed = await json("PATCH", `${API}/1`, { status: "closed" }, OWNER_AUTH);
    expect(closed.status).toBe(200);
    expect((await jsonOf(closed)).issue.status).toBe("closed");

    const badDetail = await json("GET", `${API}/abc`, undefined, OWNER_AUTH);
    expect(badDetail.status).toBe(400);
    const missingDetail = await json("GET", `${API}/9`, undefined, OWNER_AUTH);
    expect(missingDetail.status).toBe(404);
  });

  it("the form-friendly close route toggles status and redirects", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");

    const close = await json("POST", `${API}/1/close`, undefined, OWNER_AUTH);
    expect(close.status).toBe(302);
    expect(close.headers.get("location")).toBe("/testns/my-project/issues/1");
    let detail = await jsonOf(await json("GET", `${API}/1`, undefined, OWNER_AUTH));
    expect(detail.issue.status).toBe("closed");

    // Toggling again reopens.
    await json("POST", `${API}/1/close`, undefined, OWNER_AUTH);
    detail = await jsonOf(await json("GET", `${API}/1`, undefined, OWNER_AUTH));
    expect(detail.issue.status).toBe("open");
  });

  it("the close route enforces auth and validates its target", async () => {
    const { json, openIssue } = await makeIssuesApp({ visibility: "public" });
    await openIssue("Bug");

    expect((await json("POST", `${API}/1/close`)).status).toBe(401);
    expect((await json("POST", `${API}/1/close`, undefined, READER_AUTH)).status).toBe(403);
    expect((await json("POST", `${API}/abc/close`, undefined, OWNER_AUTH)).status).toBe(400);
    expect((await json("POST", `${API}/9/close`, undefined, OWNER_AUTH)).status).toBe(404);
  });
});

describe("issue routes: database failures surface as 500s", () => {
  /** Wrap a working D1 so any statement matching `pattern` throws at prepare(). */
  function failOn(db: D1Database, pattern: RegExp): D1Database {
    return {
      prepare(sql: string) {
        if (pattern.test(sql)) throw new Error("injected failure");
        return db.prepare(sql);
      },
      batch: (stmts: unknown[]) => (db as unknown as { batch(s: unknown[]): unknown }).batch(stmts),
    } as unknown as D1Database;
  }

  async function makeFaultApp() {
    const made = await makeIssuesApp();
    await made.openIssue("Bug");
    const envRef = made.env as unknown as { DB: D1Database };
    const swap = (pattern: RegExp) => {
      envRef.DB = failOn(made.db, pattern);
    };
    const restore = () => {
      envRef.DB = made.db;
    };
    return { ...made, swap, restore };
  }

  it("create / list / detail surface storage failures", async () => {
    const { json, swap, restore } = await makeFaultApp();

    swap(/INSERT INTO issues/);
    expect((await json("POST", API, { title: "x" }, OWNER_AUTH)).status).toBe(500);

    swap(/SELECT \* FROM issues WHERE/);
    expect((await json("GET", API, undefined, OWNER_AUTH)).status).toBe(500);
    expect((await json("GET", `${API}/1`, undefined, OWNER_AUTH)).status).toBe(500);

    swap(/FROM issue_labels/);
    expect((await json("GET", API, undefined, OWNER_AUTH)).status).toBe(500);
    expect((await json("GET", `${API}/1`, undefined, OWNER_AUTH)).status).toBe(500);
    restore();
  });

  it("PATCH surfaces lookup, update, and label-write failures", async () => {
    const { json, swap, restore } = await makeFaultApp();

    swap(/SELECT \* FROM issues WHERE/);
    expect((await json("PATCH", `${API}/1`, { title: "x" }, OWNER_AUTH)).status).toBe(500);

    swap(/UPDATE issues SET/);
    expect((await json("PATCH", `${API}/1`, { title: "x" }, OWNER_AUTH)).status).toBe(500);

    swap(/DELETE FROM issue_labels/);
    expect((await json("PATCH", `${API}/1`, { labels: ["bug"] }, OWNER_AUTH)).status).toBe(500);

    swap(/FROM issue_labels/);
    expect((await json("PATCH", `${API}/1`, { title: "x" }, OWNER_AUTH)).status).toBe(500);
    restore();
  });

  it("comment endpoints surface lookup and write failures", async () => {
    const { json, swap, restore } = await makeFaultApp();

    swap(/SELECT \* FROM issues WHERE/);
    expect((await json("POST", `${API}/1/comments`, { body: "hi" }, OWNER_AUTH)).status).toBe(500);
    expect((await json("GET", `${API}/1/comments`, undefined, OWNER_AUTH)).status).toBe(500);

    swap(/INSERT INTO issue_comments/);
    expect((await json("POST", `${API}/1/comments`, { body: "hi" }, OWNER_AUTH)).status).toBe(500);

    swap(/FROM issue_comments/);
    expect((await json("GET", `${API}/1/comments`, undefined, OWNER_AUTH)).status).toBe(500);
    restore();
  });

  it("the close toggle surfaces lookup and update failures", async () => {
    const { json, swap, restore } = await makeFaultApp();

    swap(/SELECT \* FROM issues WHERE/);
    expect((await json("POST", `${API}/1/close`, undefined, OWNER_AUTH)).status).toBe(500);

    swap(/UPDATE issues SET/);
    expect((await json("POST", `${API}/1/close`, undefined, OWNER_AUTH)).status).toBe(500);
    restore();
  });

  it("a corrupt project entry in KV becomes a 500 (loadProject parse failure)", async () => {
    const { app, env } = await makeIssuesApp();
    await (env as unknown as { STATE: KVNamespace }).STATE.put("project:testns:broken", "not-json");
    const res = await app.fetch(
      new Request("http://localhost/api/projects/testns/broken/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...OWNER_AUTH },
        body: JSON.stringify({ title: "x" }),
      }),
      env,
    );
    expect(res.status).toBe(500);
  });
});

describe("issue routes: remaining happy paths", () => {
  it("agents can open issues (agent actor on the event)", async () => {
    const { json } = await makeIssuesApp();
    const res = await json("POST", API, { title: "From agent" }, AGENT_AUTH);
    expect(res.status).toBe(201);
    const { issue } = (await res.json()) as { issue: { authorType: string; authorId: string } };
    expect(issue).toMatchObject({ authorType: "agent", authorId: "agent_test" });
  });

  it("PATCH updates the body", async () => {
    const { json, openIssue } = await makeIssuesApp();
    await openIssue("Bug");
    const res = await json("PATCH", `${API}/1`, { body: "updated body" }, OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { issue: { body: string } }).issue.body).toBe("updated body");
  });
});

describe("issue storage error paths", () => {
  it("wraps engine failures as DATABASE_ERROR results", async () => {
    const bad = makeThrowingD1();

    const create = await createIssue(bad, mockLogger, {
      project: "p",
      title: "t",
      authorType: "user",
      authorId: "u",
    });
    expect(!create.success && create.error.code).toBe("DATABASE_ERROR");

    const get = await getIssueByNumber(bad, mockLogger, "p", 1);
    expect(!get.success && get.error.code).toBe("DATABASE_ERROR");

    const list = await listIssues(bad, mockLogger, "p");
    expect(!list.success && list.error.code).toBe("DATABASE_ERROR");

    const update = await updateIssue(bad, mockLogger, "p", 1, { title: "x", actorId: "u" });
    expect(!update.success && update.error.code).toBe("DATABASE_ERROR");

    const byChange = await listOpenIssuesByChange(bad, mockLogger, "chg_1");
    expect(!byChange.success && byChange.error.code).toBe("DATABASE_ERROR");
  });

  it("createIssue surfaces an error when the insert returns no row", async () => {
    const noRow = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    } as unknown as D1Database;
    const result = await createIssue(noRow, mockLogger, {
      project: "p",
      title: "t",
      authorType: "user",
      authorId: "u",
    });
    expect(!result.success && result.error.code).toBe("DATABASE_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Storage-level coverage for the new modules against the real engine.
// ---------------------------------------------------------------------------

describe("issue comments + labels storage", () => {
  async function seedRealIssue(db: D1Database) {
    const result = await createIssue(db, mockLogger, {
      project: "my-project",
      projectId: "proj_A",
      title: "Something",
      authorType: "user",
      authorId: "user_1",
    });
    if (!result.success) throw new Error("seed failed");
    return result.data;
  }

  it("escapeLike escapes %, _, and backslash", () => {
    expect(escapeLike("100%_done\\now")).toBe("100\\%\\_done\\\\now");
    expect(escapeLike("plain")).toBe("plain");
  });

  it("orders comments chronologically and honors offset without a limit", async () => {
    const { db } = makeSqliteD1();
    const issue = await seedRealIssue(db);
    await addIssueComment(db, mockLogger, {
      issueId: issue.id,
      authorType: "user",
      authorId: "u1",
      body: "first",
    });
    await addIssueComment(db, mockLogger, {
      issueId: issue.id,
      authorType: "agent",
      authorId: "a1",
      body: "second",
    });

    const all = await listIssueComments(db, mockLogger, issue.id);
    expect(all.success && all.data.map((c) => c.body)).toEqual(["first", "second"]);

    const skipped = await listIssueComments(db, mockLogger, issue.id, { offset: 1 });
    expect(skipped.success && skipped.data.map((c) => c.body)).toEqual(["second"]);
  });

  it("setIssueLabels dedupes and getLabelsForIssues batches", async () => {
    const { db } = makeSqliteD1();
    const a = await seedRealIssue(db);
    const b = await seedRealIssue(db);

    const set = await setIssueLabels(db, mockLogger, a.id, ["bug", "bug", "ui"]);
    expect(set.success && [...set.data].sort()).toEqual(["bug", "ui"]);
    await setIssueLabels(db, mockLogger, b.id, ["perf"]);

    const single = await listIssueLabels(db, mockLogger, a.id);
    expect(single.success && single.data).toEqual(["bug", "ui"]);

    const batch = await getLabelsForIssues(db, mockLogger, [a.id, b.id, "iss_absent"]);
    expect(batch.success && batch.data).toEqual({ [a.id]: ["bug", "ui"], [b.id]: ["perf"] });

    const empty = await getLabelsForIssues(db, mockLogger, []);
    expect(empty.success && empty.data).toEqual({});
  });

  it("listIssues supports offset without a limit and search over NULL bodies", async () => {
    const { db } = makeSqliteD1();
    await createIssue(db, mockLogger, {
      project: "my-project",
      projectId: "proj_A",
      title: "no body here",
      authorType: "user",
      authorId: "u1",
    });
    await createIssue(db, mockLogger, {
      project: "my-project",
      projectId: "proj_A",
      title: "second",
      authorType: "user",
      authorId: "u1",
    });

    const offsetOnly = await listIssues(db, mockLogger, "my-project", undefined, {
      projectId: "proj_A",
      offset: 1,
    });
    expect(offsetOnly.success && offsetOnly.data.map((i) => i.number)).toEqual([1]);

    // A NULL body must not break the title match (COALESCE in the OR).
    const search = await listIssues(db, mockLogger, "my-project", undefined, {
      projectId: "proj_A",
      search: "no body",
    });
    expect(search.success && search.data.map((i) => i.number)).toEqual([1]);
  });

  it("updateIssue persists assignee set + clear through the real engine", async () => {
    const { db } = makeSqliteD1();
    await seedRealIssue(db);

    const set = await updateIssue(db, mockLogger, "my-project", 1, {
      assignee: "user_9",
      actorId: "user_1",
      projectId: "proj_A",
    });
    expect(set.success && set.data.assignee).toBe("user_9");

    const byAssignee = await listIssues(db, mockLogger, "my-project", undefined, {
      projectId: "proj_A",
      assignee: "user_9",
    });
    expect(byAssignee.success && byAssignee.data).toHaveLength(1);

    const cleared = await updateIssue(db, mockLogger, "my-project", 1, {
      assignee: null,
      actorId: "user_1",
      projectId: "proj_A",
    });
    expect(cleared.success && cleared.data.assignee).toBeUndefined();
  });

  it("surfaces DATABASE_ERROR results when the engine throws", async () => {
    const bad = makeThrowingD1();
    const comment = await addIssueComment(bad, mockLogger, {
      issueId: "iss_x",
      authorType: "user",
      authorId: "u1",
      body: "b",
    });
    expect(!comment.success && comment.error.code).toBe("DATABASE_ERROR");

    const list = await listIssueComments(bad, mockLogger, "iss_x");
    expect(!list.success && list.error.code).toBe("DATABASE_ERROR");

    const set = await setIssueLabels(bad, mockLogger, "iss_x", ["bug"]);
    expect(!set.success && set.error.code).toBe("DATABASE_ERROR");

    const labels = await listIssueLabels(bad, mockLogger, "iss_x");
    expect(!labels.success && labels.error.code).toBe("DATABASE_ERROR");

    const batch = await getLabelsForIssues(bad, mockLogger, ["iss_x"]);
    expect(!batch.success && batch.error.code).toBe("DATABASE_ERROR");
  });
});
