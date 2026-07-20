import { Hono } from "hono";
import { type EventActor, emitEvent } from "../queue/events";
import {
  type ReviewVerdict,
  addComment,
  listComments,
  listReviews,
  submitReview,
} from "../storage/change-reviews";
import { getChange, updateChangeStatus } from "../storage/changes";
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

  let body: { body?: unknown };
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await c.req.json<typeof body>().catch(() => ({}));
  } else {
    const form = await c.req.parseBody();
    body = { body: form.body };
  }

  if (typeof body.body !== "string" || !body.body.trim()) {
    return badRequest("body is required");
  }

  const commentResult = await addComment(c.env.DB, logger, {
    changeId: change.id,
    authorType: agentId ? "agent" : "user",
    authorId: agentId ?? userId ?? "unknown",
    body: body.body.trim().slice(0, MAX_COMMENT_LENGTH),
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
  return ok({ comments: commentsResult.data });
});

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

  if (body.verdict !== "approve" && body.verdict !== "request_changes") {
    return badRequest("verdict must be 'approve' or 'request_changes'");
  }
  const verdict: ReviewVerdict = body.verdict;
  const comment =
    typeof body.comment === "string" && body.comment.trim()
      ? body.comment.trim().slice(0, MAX_COMMENT_LENGTH)
      : undefined;

  const reviewResult = await submitReview(c.env.DB, logger, {
    changeId: change.id,
    reviewerId: userId,
    verdict,
    ...(comment !== undefined ? { comment } : {}),
  });
  if (!reviewResult.success) {
    return internalError(reviewResult.error.message);
  }

  // A human verdict moves the change state machine.
  const newStatus: Change["status"] = verdict === "approve" ? "approved" : "needs_changes";
  if (newStatus !== change.status) {
    const updateResult = await updateChangeStatus(c.env.DB, logger, change.id, newStatus);
    if (!updateResult.success) {
      logger.error("Failed to update change status after review", updateResult.error);
      return internalError(updateResult.error.message);
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
