import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/storage/change-reviews", () => ({
  addComment: vi.fn(),
  getComment: vi.fn(),
  listComments: vi.fn(),
  listReviews: vi.fn(),
  setCommentResolved: vi.fn(),
  submitReview: vi.fn(),
}));
vi.mock("../src/storage/changes", () => ({
  getChange: vi.fn(),
  updateChangeStatus: vi.fn(),
}));
vi.mock("../src/storage/deletion", () => ({ isTargetDeleting: vi.fn() }));
vi.mock("../src/storage/state", () => ({ getProject: vi.fn() }));
vi.mock("../src/utils/authz", () => ({
  canReadProject: vi.fn(),
  canWriteProject: vi.fn(),
}));
vi.mock("../src/queue/events", () => ({ emitEvent: vi.fn() }));

import { reviewsRouter } from "../src/routes/reviews";
import {
  type ChangeComment,
  addComment,
  getComment,
  listComments,
  listReviews,
  setCommentResolved,
  submitReview,
} from "../src/storage/change-reviews";
import { getChange, updateChangeStatus } from "../src/storage/changes";
import { isTargetDeleting } from "../src/storage/deletion";
import { getProject } from "../src/storage/state";
import type { Env } from "../src/types";
import { canReadProject, canWriteProject } from "../src/utils/authz";
import { AppError } from "../src/utils/errors";

const env = { DB: {}, EVENTS_QUEUE: { send: vi.fn() } } as unknown as Env;

function app(vars: { userId?: string; agentId?: string; agentOwnerId?: string } = {}) {
  const a = new Hono<{ Bindings: Env }>();
  a.use("*", async (c, next) => {
    if (vars.userId !== undefined) c.set("userId", vars.userId);
    if (vars.agentId !== undefined) c.set("agentId", vars.agentId);
    if (vars.agentOwnerId !== undefined) c.set("agentOwnerId", vars.agentOwnerId);
    await next();
  });
  a.route("/api", reviewsRouter);
  return a;
}

function jsonPost(path: string, body: unknown, vars = { userId: "user_1" }) {
  return app(vars).request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

const change = {
  id: "chg_1",
  project: "proj",
  projectId: "pid_1",
  workspace: "ws",
  status: "open",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function comment(overrides: Partial<ChangeComment> = {}): ChangeComment {
  return {
    id: "cmt_root",
    changeId: "chg_1",
    authorType: "user",
    authorId: "user_author",
    body: "root",
    createdAt: "2026-01-01T00:00:00.000Z",
    resolved: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // biome-ignore lint/suspicious/noExplicitAny: minimal change shape under test
  vi.mocked(getChange).mockResolvedValue({ success: true, data: change as any });
  // biome-ignore lint/suspicious/noExplicitAny: minimal project shape under test
  vi.mocked(getProject).mockResolvedValue({ success: true, data: { id: "pid_1" } as any });
  vi.mocked(canReadProject).mockResolvedValue(true);
  vi.mocked(canWriteProject).mockResolvedValue(true);
  vi.mocked(isTargetDeleting).mockResolvedValue(false);
  vi.mocked(addComment).mockImplementation(async (_db, _logger, opts) => ({
    success: true,
    data: {
      id: "cmt_new",
      changeId: opts.changeId,
      authorType: opts.authorType,
      authorId: opts.authorId,
      body: opts.body,
      createdAt: "2026-01-01T00:00:01.000Z",
      resolved: false,
      ...(opts.file !== undefined ? { file: opts.file } : {}),
      ...(opts.line !== undefined ? { line: opts.line } : {}),
      ...(opts.side !== undefined ? { side: opts.side } : {}),
      ...(opts.commitSha !== undefined ? { commitSha: opts.commitSha } : {}),
      ...(opts.parentCommentId !== undefined ? { parentCommentId: opts.parentCommentId } : {}),
    },
  }));
  vi.mocked(submitReview).mockImplementation(async (_db, _logger, opts) => ({
    success: true,
    data: {
      id: "rev_new",
      changeId: opts.changeId,
      reviewerId: opts.reviewerId,
      verdict: opts.verdict,
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }));
  vi.mocked(setCommentResolved).mockResolvedValue({ success: true, data: undefined });
  // biome-ignore lint/suspicious/noExplicitAny: minimal change shape under test
  vi.mocked(updateChangeStatus).mockResolvedValue({ success: true, data: change as any });
});

describe("POST /api/changes/:id/comments (anchors)", () => {
  it("passes a valid anchor through to storage", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "off by one",
      file: "src/x.ts",
      line: 42,
      side: "old",
      commitSha: "abc123",
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(addComment)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ file: "src/x.ts", line: 42, side: "old", commitSha: "abc123" }),
    );
  });

  it("accepts a form-encoded line number", async () => {
    const form = new URLSearchParams({ body: "hi", file: "src/x.ts", line: "7" });
    const res = await app({ userId: "user_1" }).request(
      "/api/changes/chg_1/comments",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      env,
    );
    expect(res.status).toBe(302);
    expect(vi.mocked(addComment)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ file: "src/x.ts", line: 7 }),
    );
  });

  it("rejects line < 1", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "x",
      file: "src/x.ts",
      line: 0,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("line must be an integer >= 1");
  });

  it("rejects a non-integer line", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "x",
      file: "src/x.ts",
      line: 1.5,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a bad side", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "x",
      file: "src/x.ts",
      line: 3,
      side: "left",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("side must be 'old' or 'new'");
  });

  it("rejects side/line without a file", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", { body: "x", line: 3 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("requires both file and line");
  });

  it("rejects a file without a line", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", { body: "x", file: "src/x.ts" });
    expect(res.status).toBe(400);
  });

  it("rejects a parent comment from another change", async () => {
    vi.mocked(getComment).mockResolvedValue({
      success: true,
      data: comment({ changeId: "chg_OTHER" }),
    });
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "reply",
      parentCommentId: "cmt_root",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("comment on this change");
    expect(vi.mocked(addComment)).not.toHaveBeenCalled();
  });

  it("rejects a missing parent comment", async () => {
    vi.mocked(getComment).mockResolvedValue({
      success: false,
      error: new AppError("nope", "NOT_FOUND", 404),
    });
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "reply",
      parentCommentId: "cmt_missing",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a reply that carries its own anchor", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "reply",
      parentCommentId: "cmt_root",
      file: "src/x.ts",
      line: 3,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("inherits its thread's anchor");
    expect(vi.mocked(getComment)).not.toHaveBeenCalled();
  });

  it("a reply inherits the thread anchor and flattens onto the root", async () => {
    // The addressed parent is itself a reply; the new comment must attach to
    // the thread root and mirror the inherited anchor.
    vi.mocked(getComment).mockResolvedValue({
      success: true,
      data: comment({
        id: "cmt_reply1",
        parentCommentId: "cmt_root",
        file: "src/x.ts",
        line: 9,
        side: "new",
        commitSha: "abc123",
      }),
    });
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "second reply",
      parentCommentId: "cmt_reply1",
    });
    expect(res.status).toBe(201);
    expect(vi.mocked(addComment)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        parentCommentId: "cmt_root",
        file: "src/x.ts",
        line: 9,
        side: "new",
        commitSha: "abc123",
      }),
    );
  });
});

describe("POST /api/changes/:id/comments/:commentId/(un)resolve", () => {
  it("requires authentication", async () => {
    const res = await app({}).request(
      "/api/changes/chg_1/comments/cmt_root/resolve",
      { method: "POST", headers: { "content-type": "application/json" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("lets a project writer resolve a thread root", async () => {
    vi.mocked(getComment).mockResolvedValue({ success: true, data: comment() });
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_root/resolve", {});
    expect(res.status).toBe(200);
    expect(vi.mocked(setCommentResolved)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "cmt_root",
      true,
    );
    const body = (await res.json()) as { comment: ChangeComment };
    expect(body.comment.resolved).toBe(true);
  });

  it("lets the comment author resolve without project write access", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(false);
    vi.mocked(getComment).mockResolvedValue({
      success: true,
      data: comment({ authorId: "user_1" }),
    });
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_root/resolve", {});
    expect(res.status).toBe(200);
  });

  it("lets an agent author resolve its own thread", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(false);
    vi.mocked(getComment).mockResolvedValue({
      success: true,
      data: comment({ authorType: "agent", authorId: "agent_1" }),
    });
    const res = await app({ agentId: "agent_1", agentOwnerId: "user_9" }).request(
      "/api/changes/chg_1/comments/cmt_root/resolve",
      { method: "POST", headers: { "content-type": "application/json" } },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("forbids a non-author without write access", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(false);
    vi.mocked(getComment).mockResolvedValue({ success: true, data: comment() });
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_root/resolve", {});
    expect(res.status).toBe(403);
    expect(vi.mocked(setCommentResolved)).not.toHaveBeenCalled();
  });

  it("refuses to resolve a reply (thread roots only)", async () => {
    vi.mocked(getComment).mockResolvedValue({
      success: true,
      data: comment({ id: "cmt_reply", parentCommentId: "cmt_root" }),
    });
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_reply/resolve", {});
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("thread root");
  });

  it("404s on a comment from another change", async () => {
    vi.mocked(getComment).mockResolvedValue({
      success: true,
      data: comment({ changeId: "chg_OTHER" }),
    });
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_root/resolve", {});
    expect(res.status).toBe(404);
  });

  it("404s on a missing comment", async () => {
    vi.mocked(getComment).mockResolvedValue({
      success: false,
      error: new AppError("nope", "NOT_FOUND", 404),
    });
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_missing/resolve", {});
    expect(res.status).toBe(404);
  });

  it("unresolve clears the resolved flag and redirects form posts", async () => {
    vi.mocked(getComment).mockResolvedValue({
      success: true,
      data: comment({ resolved: true }),
    });
    const res = await app({ userId: "user_1" }).request(
      "/api/changes/chg_1/comments/cmt_root/unresolve",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/changes/chg_1");
    expect(vi.mocked(setCommentResolved)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "cmt_root",
      false,
    );
  });
});

describe("POST /api/changes/:id/reviews (comment verdict)", () => {
  it("rejects an unknown verdict, naming all three options", async () => {
    const res = await jsonPost("/api/changes/chg_1/reviews", { verdict: "meh" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("'approve', 'request_changes', or 'comment'");
  });

  it("requires a comment body for a comment-only review", async () => {
    const res = await jsonPost("/api/changes/chg_1/reviews", { verdict: "comment" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("requires a comment");
    expect(vi.mocked(submitReview)).not.toHaveBeenCalled();
  });

  it("records the body as a discussion comment and leaves the status untouched", async () => {
    const res = await jsonPost("/api/changes/chg_1/reviews", {
      verdict: "comment",
      comment: "just passing through",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { changeStatus: string };
    expect(body.changeStatus).toBe("open");
    expect(vi.mocked(updateChangeStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(addComment)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ body: "just passing through", authorType: "user" }),
    );
    // The verdict row itself carries no comment (the body lives in the
    // discussion so it survives even when the verdict row is left untouched).
    expect(vi.mocked(submitReview)).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      changeId: "chg_1",
      reviewerId: "user_1",
      verdict: "comment",
    });
  });

  it("still moves the state machine for approve", async () => {
    const res = await jsonPost("/api/changes/chg_1/reviews", { verdict: "approve" });
    expect(res.status).toBe(201);
    expect(vi.mocked(updateChangeStatus)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "chg_1",
      "approved",
    );
    expect(vi.mocked(addComment)).not.toHaveBeenCalled();
  });
});

describe("error paths", () => {
  it("401s an unauthenticated comment", async () => {
    const res = await app({}).request(
      "/api/changes/chg_1/comments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "x" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("404s an unknown change", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: false,
      error: new AppError("nope", "NOT_FOUND", 404),
    });
    const res = await jsonPost("/api/changes/chg_x/comments", { body: "x" });
    expect(res.status).toBe(404);
  });

  it("500s when the change lookup fails", async () => {
    vi.mocked(getChange).mockResolvedValue({
      success: false,
      error: new AppError("db down", "DATABASE_ERROR", 500),
    });
    const res = await jsonPost("/api/changes/chg_1/comments", { body: "x" });
    expect(res.status).toBe(500);
  });

  it("hides comment listing behind project read access", async () => {
    vi.mocked(canReadProject).mockResolvedValue(false);
    const res = await app({ userId: "user_1" }).request("/api/changes/chg_1/comments", {}, env);
    expect(res.status).toBe(404);
  });

  it("401s a review from an agent token", async () => {
    const res = await app({ agentId: "agent_1" }).request(
      "/api/changes/chg_1/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdict: "comment", comment: "x" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("403s a review without project write access", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(false);
    const res = await jsonPost("/api/changes/chg_1/reviews", { verdict: "comment", comment: "x" });
    expect(res.status).toBe(403);
  });

  it("500s when recording the verdict row fails", async () => {
    vi.mocked(submitReview).mockResolvedValue({
      success: false,
      error: new AppError("db down", "DATABASE_ERROR", 500),
    });
    const res = await jsonPost("/api/changes/chg_1/reviews", { verdict: "comment", comment: "x" });
    expect(res.status).toBe(500);
  });

  it("rejects a non-string parentCommentId", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", { body: "x", parentCommentId: 7 });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("parentCommentId must be a non-empty string");
  });

  it("500s when persisting the change status after an approve fails", async () => {
    vi.mocked(updateChangeStatus).mockResolvedValue({
      success: false,
      error: new AppError("db down", "DATABASE_ERROR", 500),
    });
    const res = await jsonPost("/api/changes/chg_1/reviews", { verdict: "approve" });
    expect(res.status).toBe(500);
  });

  it("rejects a non-string commitSha", async () => {
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "x",
      file: "src/x.ts",
      line: 3,
      commitSha: 123,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("commitSha");
  });

  it("500s when the parent lookup fails for a non-NOT_FOUND reason", async () => {
    vi.mocked(getComment).mockResolvedValue({
      success: false,
      error: new AppError("db down", "DATABASE_ERROR", 500),
    });
    const res = await jsonPost("/api/changes/chg_1/comments", {
      body: "reply",
      parentCommentId: "cmt_root",
    });
    expect(res.status).toBe(500);
  });

  it("hides resolve behind project read access (404)", async () => {
    vi.mocked(canReadProject).mockResolvedValue(false);
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_root/resolve", {});
    expect(res.status).toBe(404);
    expect(vi.mocked(getComment)).not.toHaveBeenCalled();
  });

  it("500s when the comment lookup fails during resolve", async () => {
    vi.mocked(getComment).mockResolvedValue({
      success: false,
      error: new AppError("db down", "DATABASE_ERROR", 500),
    });
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_root/resolve", {});
    expect(res.status).toBe(500);
  });

  it("500s when persisting the resolution fails", async () => {
    vi.mocked(getComment).mockResolvedValue({ success: true, data: comment() });
    vi.mocked(setCommentResolved).mockResolvedValue({
      success: false,
      error: new AppError("db down", "DATABASE_ERROR", 500),
    });
    const res = await jsonPost("/api/changes/chg_1/comments/cmt_root/resolve", {});
    expect(res.status).toBe(500);
  });

  it("500s when recording the comment-only body fails", async () => {
    vi.mocked(addComment).mockResolvedValue({
      success: false,
      error: new AppError("db down", "DATABASE_ERROR", 500),
    });
    const res = await jsonPost("/api/changes/chg_1/reviews", {
      verdict: "comment",
      comment: "hello",
    });
    expect(res.status).toBe(500);
    expect(vi.mocked(submitReview)).not.toHaveBeenCalled();
  });

  it("redirects a form-encoded comment verdict back to the change page", async () => {
    const form = new URLSearchParams({ verdict: "comment", comment: "form comment" });
    const res = await app({ userId: "user_1" }).request(
      "/api/changes/chg_1/reviews",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/changes/chg_1");
    expect(vi.mocked(updateChangeStatus)).not.toHaveBeenCalled();
  });
});

describe("GET /api/changes/:id/comments", () => {
  it("returns anchor and thread fields for reconstruction", async () => {
    const root = comment({ file: "src/x.ts", line: 3, side: "new", resolved: true });
    const reply = comment({
      id: "cmt_reply",
      parentCommentId: "cmt_root",
      file: "src/x.ts",
      line: 3,
      createdAt: "2026-01-01T00:00:05.000Z",
    });
    vi.mocked(listComments).mockResolvedValue({ success: true, data: [root, reply] });
    const res = await app({ userId: "user_1" }).request("/api/changes/chg_1/comments", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: ChangeComment[] };
    expect(body.comments[0]).toMatchObject({ file: "src/x.ts", line: 3, resolved: true });
    expect(body.comments[1]).toMatchObject({ parentCommentId: "cmt_root" });
  });
});

describe("GET /api/changes/:id/reviews", () => {
  it("returns reviews including a comment-only verdict", async () => {
    vi.mocked(listReviews).mockResolvedValue({
      success: true,
      data: [
        {
          id: "rev_1",
          changeId: "chg_1",
          reviewerId: "user_2",
          verdict: "comment",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const res = await app({ userId: "user_1" }).request("/api/changes/chg_1/reviews", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reviews: Array<{ verdict: string }> };
    expect(body.reviews[0]?.verdict).toBe("comment");
  });
});
