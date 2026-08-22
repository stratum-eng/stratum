import { type Context, Hono } from "hono";
import { type EventActor, emitEvent } from "../queue/events";
import {
  type ChangeComment,
  type CommentAnchor,
  type ReviewVerdict,
  addComment,
  getComment,
  listComments,
  listReviews,
  setCommentResolved,
  submitReview,
} from "../storage/change-reviews";
import { getChange, updateChangeStatus } from "../storage/changes";
import { isTargetDeleting } from "../storage/deletion";
import { getProject } from "../storage/state";
import type { Change, Env, ProjectEntry } from "../types";
import { canReadProject, canWriteProject } from "../utils/authz";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import {
  badRequest,
  created,
  forbidden,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";

const app = new Hono<{ Bindings: Env }>();

const MAX_COMMENT_LENGTH = 20_000;

/** Statuses on which a human verdict can still move the change. */
const REVIEWABLE_STATUSES: Change["status"][] = ["open", "needs_changes", "accepted", "approved"];

async function loadChangeAndProject(
  c: { env: Env; req: { param(key: string): string } },
  logger: Logger,
): Promise<{ change: Change; project: ProjectEntry } | { response: Response }> {
  const id = c.req.param("id");

  const changeResult = await getChange(c.env.DB, logger, id);
  if (!changeResult.success) {
    if (changeResult.error.code === "NOT_FOUND") {
      return { response: notFound("Change", id) };
    }
    logger.error("Failed to get change", changeResult.error);
    return { response: internalError(changeResult.error.message) };
  }
  const change = changeResult.data;

  const projectResult = await getProject(c.env.STATE, change.project, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return { response: notFound("Project", change.project) };
    }
    logger.error("Failed to get project", projectResult.error);
    return { response: internalError(projectResult.error.message) };
  }

  return { change, project: projectResult.data };
}

/**
 * Validate and normalize the optional line-anchor / threading fields of a
 * comment request. Rules:
 * - A line anchor requires BOTH file and line (line: integer >= 1); side
 *   ('old' | 'new') and commitSha are only allowed alongside such an anchor.
 * - A reply (parentCommentId) may not carry its own anchor fields — it
 *   inherits the thread's anchor. Replies to replies are flattened onto the
 *   thread root (single-level threads), mirroring the parent's own anchor.
 * - The parent must exist and belong to the same change.
 */
async function resolveCommentAnchor(
  db: D1Database,
  logger: Logger,
  changeId: string,
  body: {
    file?: unknown;
    line?: unknown;
    side?: unknown;
    commitSha?: unknown;
    parentCommentId?: unknown;
  },
): Promise<{ anchor: CommentAnchor } | { response: Response }> {
  const hasAnchorInput =
    body.file !== undefined ||
    body.line !== undefined ||
    body.side !== undefined ||
    body.commitSha !== undefined;

  if (body.parentCommentId !== undefined) {
    if (typeof body.parentCommentId !== "string" || !body.parentCommentId.trim()) {
      return { response: badRequest("parentCommentId must be a non-empty string") };
    }
    if (hasAnchorInput) {
      return {
        response: badRequest("a reply inherits its thread's anchor; omit file/line/side/commitSha"),
      };
    }
    const parentResult = await getComment(db, logger, body.parentCommentId.trim());
    if (!parentResult.success) {
      if (parentResult.error.code === "NOT_FOUND") {
        return { response: badRequest("parentCommentId must reference a comment on this change") };
      }
      return { response: internalError(parentResult.error.message) };
    }
    const parent = parentResult.data;
    if (parent.changeId !== changeId) {
      return { response: badRequest("parentCommentId must reference a comment on this change") };
    }
    return {
      anchor: {
        // Flatten reply-to-reply onto the thread root; inherit its anchor
        // (a reply's anchor always equals its root's, by induction).
        parentCommentId: parent.parentCommentId ?? parent.id,
        ...(parent.file !== undefined ? { file: parent.file } : {}),
        ...(parent.line !== undefined ? { line: parent.line } : {}),
        ...(parent.side !== undefined ? { side: parent.side } : {}),
        ...(parent.commitSha !== undefined ? { commitSha: parent.commitSha } : {}),
      },
    };
  }

  if (!hasAnchorInput) return { anchor: {} };

  if (typeof body.file !== "string" || !body.file.trim()) {
    return { response: badRequest("a line comment requires both file and line") };
  }
  const line = typeof body.line === "string" && body.line.trim() ? Number(body.line) : body.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    return { response: badRequest("line must be an integer >= 1") };
  }
  let side: "old" | "new" | undefined;
  if (body.side !== undefined && body.side !== "") {
    if (body.side !== "old" && body.side !== "new") {
      return { response: badRequest("side must be 'old' or 'new'") };
    }
    side = body.side;
  }
  let commitSha: string | undefined;
  if (body.commitSha !== undefined && body.commitSha !== "") {
    if (typeof body.commitSha !== "string" || !body.commitSha.trim()) {
      return { response: badRequest("commitSha must be a non-empty string") };
    }
    commitSha = body.commitSha.trim();
  }

  return {
    anchor: {
      file: body.file.trim(),
      line,
      ...(side !== undefined ? { side } : {}),
      ...(commitSha !== undefined ? { commitSha } : {}),
    },
  };
}

// POST /api/changes/:id/comments — Add a comment
app.post("/changes/:id/comments", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const loaded = await loadChangeAndProject(c, logger);
  if ("response" in loaded) return loaded.response;
  const { change, project } = loaded;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Change", change.id);
  }

  let body: {
    body?: unknown;
    file?: unknown;
    line?: unknown;
    side?: unknown;
    commitSha?: unknown;
    parentCommentId?: unknown;
  };
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await c.req.json<typeof body>().catch(() => ({}));
  } else {
    const form = await c.req.parseBody();
    body = {
      body: form.body,
      file: form.file,
      line: form.line,
      side: form.side,
      commitSha: form.commitSha,
      parentCommentId: form.parentCommentId,
    };
  }

  if (typeof body.body !== "string" || !body.body.trim()) {
    return badRequest("body is required");
  }

  const anchorResult = await resolveCommentAnchor(c.env.DB, logger, change.id, body);
  if ("response" in anchorResult) return anchorResult.response;

  const commentResult = await addComment(c.env.DB, logger, {
    changeId: change.id,
    authorType: agentId ? "agent" : "user",
    authorId: agentId ?? userId ?? "unknown",
    body: body.body.trim().slice(0, MAX_COMMENT_LENGTH),
    ...anchorResult.anchor,
  });
  if (!commentResult.success) {
    return internalError(commentResult.error.message);
  }

  const actor: EventActor = agentId
    ? { type: "agent", id: agentId }
    : { type: "user", ...(userId !== undefined ? { id: userId } : {}) };
  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    { type: "change.commented", project: change.project, changeId: change.id },
    actor,
    logger,
    change.projectId ?? project.id,
  );

  if (!contentType.includes("application/json")) {
    return c.redirect(`/changes/${change.id}`, 302);
  }
  return created({ comment: commentResult.data });
});

// GET /api/changes/:id/comments — List comments
app.get("/changes/:id/comments", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");

  const loaded = await loadChangeAndProject(c, logger);
  if ("response" in loaded) return loaded.response;
  const { change, project } = loaded;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Change", change.id);
  }

  const commentsResult = await listComments(c.env.DB, logger, change.id);
  if (!commentsResult.success) {
    return internalError(commentsResult.error.message);
  }
  // Ordered by created_at with parentCommentId included, so callers can
  // reconstruct threads (roots in order, replies grouped under their root).
  return ok({ comments: commentsResult.data });
});

// POST /api/changes/:id/comments/:commentId/resolve|unresolve — Toggle a
// thread root's resolution state. Allowed for project writers or the
// comment's author.
async function handleResolveToggle(
  c: Context<{ Bindings: Env }>,
  resolved: boolean,
): Promise<Response> {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const loaded = await loadChangeAndProject(c, logger);
  if ("response" in loaded) return loaded.response;
  const { change, project } = loaded;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Change", change.id);
  }

  const commentId = c.req.param("commentId") ?? "";
  const commentResult = await getComment(c.env.DB, logger, commentId);
  if (!commentResult.success) {
    if (commentResult.error.code === "NOT_FOUND") return notFound("Comment", commentId);
    return internalError(commentResult.error.message);
  }
  const comment = commentResult.data;
  if (comment.changeId !== change.id) return notFound("Comment", commentId);
  if (comment.parentCommentId !== undefined) {
    return badRequest("Only a thread root can be resolved; resolve the root comment");
  }

  const isAuthor =
    (comment.authorType === "user" && userId !== undefined && comment.authorId === userId) ||
    (comment.authorType === "agent" && agentId !== undefined && comment.authorId === agentId);
  if (!isAuthor && !(await canWriteProject(c.env.DB, project, userId, agentOwnerId))) {
    return forbidden("Project access denied");
  }

  const updateResult = await setCommentResolved(c.env.DB, logger, comment.id, resolved);
  if (!updateResult.success) {
    return internalError(updateResult.error.message);
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return c.redirect(`/changes/${change.id}`, 302);
  }
  const updated: ChangeComment = { ...comment, resolved };
  return ok({ comment: updated });
}

app.post("/changes/:id/comments/:commentId/resolve", (c) => handleResolveToggle(c, true));
app.post("/changes/:id/comments/:commentId/unresolve", (c) => handleResolveToggle(c, false));

// POST /api/changes/:id/reviews — Submit a human review verdict
app.post("/changes/:id/reviews", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  // Reviews are a human gate by design: agent tokens cannot approve work.
  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can review changes");

  const loaded = await loadChangeAndProject(c, logger);
  if ("response" in loaded) return loaded.response;
  const { change, project } = loaded;

  if (!(await canWriteProject(c.env.DB, project, userId)))
    return forbidden("Project access denied");

  // Refuse a review verdict while the project is being deleted (it resurrects
  // change_reviews rows and wedges the cascade). Best-effort; verifier re-run backs it.
  if (await isTargetDeleting(c.env, project, logger)) {
    return c.json({ error: "Project is being deleted", code: "TARGET_DELETING" }, 409);
  }

  if (!REVIEWABLE_STATUSES.includes(change.status)) {
    return badRequest(`Cannot review a ${change.status} change`);
  }

  let body: { verdict?: unknown; comment?: unknown };
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await c.req.json<typeof body>().catch(() => ({}));
  } else {
    const form = await c.req.parseBody();
    body = { verdict: form.verdict, comment: form.comment };
  }

  if (
    body.verdict !== "approve" &&
    body.verdict !== "request_changes" &&
    body.verdict !== "comment"
  ) {
    return badRequest("verdict must be 'approve', 'request_changes', or 'comment'");
  }
  const verdict: ReviewVerdict = body.verdict;
  const comment =
    typeof body.comment === "string" && body.comment.trim()
      ? body.comment.trim().slice(0, MAX_COMMENT_LENGTH)
      : undefined;
  if (verdict === "comment" && comment === undefined) {
    return badRequest("a comment-only review requires a comment");
  }

  // A comment-only review's body lands in the append-only discussion (not in
  // the verdict row) so it survives even when the reviewer already has an
  // approve/request_changes verdict, which submitReview leaves untouched.
  if (verdict === "comment" && comment !== undefined) {
    const commentResult = await addComment(c.env.DB, logger, {
      changeId: change.id,
      authorType: "user",
      authorId: userId,
      body: comment,
    });
    if (!commentResult.success) {
      return internalError(commentResult.error.message);
    }
  }

  const reviewResult = await submitReview(c.env.DB, logger, {
    changeId: change.id,
    reviewerId: userId,
    verdict,
    ...(verdict !== "comment" && comment !== undefined ? { comment } : {}),
  });
  if (!reviewResult.success) {
    return internalError(reviewResult.error.message);
  }

  // A human verdict moves the change state machine — except a comment-only
  // review, which neither approves nor blocks.
  let newStatus: Change["status"] = change.status;
  if (verdict !== "comment") {
    newStatus = verdict === "approve" ? "approved" : "needs_changes";
    if (newStatus !== change.status) {
      const updateResult = await updateChangeStatus(c.env.DB, logger, change.id, newStatus);
      if (!updateResult.success) {
        logger.error("Failed to update change status after review", updateResult.error);
        return internalError(updateResult.error.message);
      }
    }
  }

  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    { type: "change.reviewed", project: change.project, changeId: change.id, verdict },
    { type: "user", id: userId },
    logger,
    change.projectId ?? project.id,
  );

  if (!contentType.includes("application/json")) {
    return c.redirect(`/changes/${change.id}`, 302);
  }
  return created({ review: reviewResult.data, changeStatus: newStatus });
});

// GET /api/changes/:id/reviews — List reviews
app.get("/changes/:id/reviews", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");

  const loaded = await loadChangeAndProject(c, logger);
  if ("response" in loaded) return loaded.response;
  const { change, project } = loaded;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Change", change.id);
  }

  const reviewsResult = await listReviews(c.env.DB, logger, change.id);
  if (!reviewsResult.success) {
    return internalError(reviewsResult.error.message);
  }
  return ok({ reviews: reviewsResult.data });
});

export { app as reviewsRouter };
