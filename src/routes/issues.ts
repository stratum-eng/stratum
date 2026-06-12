import { Hono } from "hono";
import { type EventActor, emitEvent } from "../queue/events";
import { getChange } from "../storage/changes";
import {
  type IssueStatus,
  createIssue,
  getIssueByNumber,
  listIssues,
  updateIssue,
} from "../storage/issues";
import { getProjectByPath } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
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

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 20_000;

interface RouteContext {
  env: Env;
  get(key: "userId" | "agentId" | "agentOwnerId"): string | undefined;
  req: { param(key: string): string };
}

async function loadProject(
  c: RouteContext,
  logger: Logger,
): Promise<{ project: ProjectEntry } | { response: Response }> {
  const namespace = c.req.param("namespace");
  const slug = c.req.param("slug");

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return { response: notFound("Project", `${namespace}/${slug}`) };
    }
    logger.error("Failed to get project", projectResult.error);
    return { response: internalError(projectResult.error.message) };
  }
  return { project: projectResult.data };
}

function parseIssueNumber(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// POST /api/projects/:namespace/:slug/issues — Open an issue
app.post("/:namespace/:slug/issues", async (c) => {
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

  const result = await loadProject(c, logger);
  if ("response" in result) return result.response;
  const { project } = result;

  // Anyone who can read the project can open issues against it.
  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Project", `${project.namespace}/${project.slug}`);
  }

  let body: { title?: unknown; body?: unknown; linkedChangeId?: unknown };
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await c.req.json<typeof body>().catch(() => ({}));
  } else {
    const form = await c.req.parseBody();
    body = { title: form.title, body: form.body, linkedChangeId: form.linkedChangeId };
  }

  if (typeof body.title !== "string" || !body.title.trim()) {
    return badRequest("title is required");
  }
  const title = body.title.trim().slice(0, MAX_TITLE_LENGTH);
  const issueBody =
    typeof body.body === "string" && body.body.trim()
      ? body.body.trim().slice(0, MAX_BODY_LENGTH)
      : undefined;

  let linkedChangeId: string | undefined;
  if (typeof body.linkedChangeId === "string" && body.linkedChangeId.trim()) {
    const changeResult = await getChange(c.env.DB, logger, body.linkedChangeId.trim());
    if (!changeResult.success || changeResult.data.project !== project.name) {
      return badRequest("linkedChangeId does not reference a change in this project");
    }
    linkedChangeId = changeResult.data.id;
  }

  const issueResult = await createIssue(c.env.DB, logger, {
    project: project.name,
    title,
    ...(issueBody !== undefined ? { body: issueBody } : {}),
    authorType: agentId ? "agent" : "user",
    authorId: agentId ?? userId ?? "unknown",
    ...(linkedChangeId !== undefined ? { linkedChangeId } : {}),
  });
  if (!issueResult.success) {
    return internalError(issueResult.error.message);
  }
  const issue = issueResult.data;

  const actor: EventActor = agentId
    ? { type: "agent", id: agentId }
    : { type: "user", ...(userId !== undefined ? { id: userId } : {}) };
  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    { type: "issue.opened", project: project.name, issueNumber: issue.number, title: issue.title },
    actor,
    logger,
  );

  if (!contentType.includes("application/json")) {
    return c.redirect(`/${project.namespace}/${project.slug}/issues/${issue.number}`, 302);
  }
  return created({ issue });
});

// GET /api/projects/:namespace/:slug/issues — List issues
app.get("/:namespace/:slug/issues", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");

  const result = await loadProject(c, logger);
  if ("response" in result) return result.response;
  const { project } = result;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Project", `${project.namespace}/${project.slug}`);
  }

  const statusParam = c.req.query("status");
  const status: IssueStatus | undefined =
    statusParam === "open" || statusParam === "closed" ? statusParam : undefined;

  const issuesResult = await listIssues(c.env.DB, logger, project.name, status);
  if (!issuesResult.success) {
    return internalError(issuesResult.error.message);
  }

  return ok({ issues: issuesResult.data });
});

// GET /api/projects/:namespace/:slug/issues/:number — Issue detail
app.get("/:namespace/:slug/issues/:number", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");

  const result = await loadProject(c, logger);
  if ("response" in result) return result.response;
  const { project } = result;

  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Project", `${project.namespace}/${project.slug}`);
  }

  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return badRequest("Invalid issue number");

  const issueResult = await getIssueByNumber(c.env.DB, logger, project.name, number);
  if (!issueResult.success) {
    if (issueResult.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(issueResult.error.message);
  }

  return ok({ issue: issueResult.data });
});

// PATCH /api/projects/:namespace/:slug/issues/:number — Edit / close / reopen
app.patch("/:namespace/:slug/issues/:number", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can edit issues");

  const result = await loadProject(c, logger);
  if ("response" in result) return result.response;
  const { project } = result;

  // Editing and closing issues requires write access to the project.
  if (!(await canWriteProject(c.env.DB, project, userId)))
    return forbidden("Project access denied");

  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return badRequest("Invalid issue number");

  const body = await c.req
    .json<{ title?: unknown; body?: unknown; status?: unknown; linkedChangeId?: unknown }>()
    .catch(() => ({}) as Record<string, unknown>);

  const updates: {
    title?: string;
    body?: string;
    status?: IssueStatus;
    linkedChangeId?: string | null;
    actorId: string;
  } = { actorId: userId };

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      return badRequest("title must be a non-empty string");
    }
    updates.title = body.title.trim().slice(0, MAX_TITLE_LENGTH);
  }
  if (body.body !== undefined) {
    if (typeof body.body !== "string") return badRequest("body must be a string");
    updates.body = body.body.trim().slice(0, MAX_BODY_LENGTH);
  }
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "closed") {
      return badRequest("status must be 'open' or 'closed'");
    }
    updates.status = body.status;
  }
  if (body.linkedChangeId !== undefined) {
    if (body.linkedChangeId === null || body.linkedChangeId === "") {
      updates.linkedChangeId = null;
    } else if (typeof body.linkedChangeId === "string") {
      const changeResult = await getChange(c.env.DB, logger, body.linkedChangeId);
      if (!changeResult.success || changeResult.data.project !== project.name) {
        return badRequest("linkedChangeId does not reference a change in this project");
      }
      updates.linkedChangeId = changeResult.data.id;
    } else {
      return badRequest("linkedChangeId must be a string or null");
    }
  }

  const before = await getIssueByNumber(c.env.DB, logger, project.name, number);
  if (!before.success) {
    if (before.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(before.error.message);
  }

  const updateResult = await updateIssue(c.env.DB, logger, project.name, number, updates);
  if (!updateResult.success) {
    if (updateResult.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(updateResult.error.message);
  }
  const issue = updateResult.data;

  if (updates.status === "closed" && before.data.status === "open") {
    await emitEvent(
      c.env.DB,
      c.env.EVENTS_QUEUE,
      {
        type: "issue.closed",
        project: project.name,
        issueNumber: issue.number,
        title: issue.title,
      },
      { type: "user", id: userId },
      logger,
    );
  }

  return ok({ issue });
});

// POST /api/projects/:namespace/:slug/issues/:number/close — Form-friendly close
app.post("/:namespace/:slug/issues/:number/close", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  if (!userId) return unauthorized("Only authenticated users can close issues");

  const result = await loadProject(c, logger);
  if ("response" in result) return result.response;
  const { project } = result;

  if (!(await canWriteProject(c.env.DB, project, userId)))
    return forbidden("Project access denied");

  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return badRequest("Invalid issue number");

  const before = await getIssueByNumber(c.env.DB, logger, project.name, number);
  if (!before.success) {
    if (before.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(before.error.message);
  }

  const newStatus: IssueStatus = before.data.status === "open" ? "closed" : "open";
  const updateResult = await updateIssue(c.env.DB, logger, project.name, number, {
    status: newStatus,
    actorId: userId,
  });
  if (!updateResult.success) {
    return internalError(updateResult.error.message);
  }

  if (newStatus === "closed") {
    await emitEvent(
      c.env.DB,
      c.env.EVENTS_QUEUE,
      {
        type: "issue.closed",
        project: project.name,
        issueNumber: number,
        title: updateResult.data.title,
      },
      { type: "user", id: userId },
      logger,
    );
  }

  return c.redirect(`/${project.namespace}/${project.slug}/issues/${number}`, 302);
});

export { app as issuesRouter };
