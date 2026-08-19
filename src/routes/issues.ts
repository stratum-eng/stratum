import { Hono } from "hono";
import { type EventActor, emitEvent } from "../queue/events";
import { getChange } from "../storage/changes";
import { isTargetDeleting } from "../storage/deletion";
import { addIssueComment, listIssueComments } from "../storage/issue-comments";
import { getLabelsForIssues, listIssueLabels, setIssueLabels } from "../storage/issue-labels";
import {
  type IssueStatus,
  createIssue,
  getIssueByNumber,
  listIssues,
  updateIssue,
} from "../storage/issues";
import { getProjectByPath } from "../storage/state";
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

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 20_000;
const MAX_COMMENT_LENGTH = 20_000;
const MAX_LABEL_LENGTH = 50;
const MAX_LABELS_PER_ISSUE = 20;
/** Longest ?q= text the search filter accepts (bounds the LIKE pattern). */
const MAX_SEARCH_LENGTH = 200;

/** Default + hard cap for the paginated issues listing (bounds the response). */
const DEFAULT_ISSUES_PAGE = 100;
const MAX_ISSUES_PAGE = 500;

/** Default + hard cap for the paginated comment listing. */
const DEFAULT_COMMENTS_PAGE = 100;
const MAX_COMMENTS_PAGE = 500;

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

/**
 * Whether a change belongs to this project. The changes table's `project`
 * column is historically mixed: it holds the project NAME on rows created via
 * the name-keyed API paths and the project ID on rows created by the GitHub
 * webhook path — and post-025 rows also carry the canonical `projectId`.
 * Compare against all three (same as the merge-batch guard in changes.ts) so an
 * id-keyed change is not mis-rejected.
 */
function changeBelongsToProject(change: Change, project: ProjectEntry): boolean {
  return (
    change.projectId === project.id ||
    change.project === project.name ||
    change.project === project.id
  );
}

/**
 * Validate a `labels` payload: an array of at most MAX_LABELS_PER_ISSUE
 * non-empty strings (trimmed, capped at MAX_LABEL_LENGTH, deduped). Returns an
 * error string for the 400 response when invalid.
 */
function parseLabels(raw: unknown): { labels: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "labels must be an array of strings" };
  const labels: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      return { error: "labels must be non-empty strings" };
    }
    labels.push(entry.trim().slice(0, MAX_LABEL_LENGTH));
  }
  const unique = [...new Set(labels)];
  if (unique.length > MAX_LABELS_PER_ISSUE) {
    return { error: `an issue may have at most ${MAX_LABELS_PER_ISSUE} labels` };
  }
  return { labels: unique };
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

  // Refuse opening an issue while the project is being deleted — it resurrects a
  // row the cascade removed and wedges the job. Best-effort; verifier re-run backs it.
  if (await isTargetDeleting(c.env, project, logger)) {
    return c.json({ error: "Project is being deleted", code: "TARGET_DELETING" }, 409);
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
    if (!changeResult.success || !changeBelongsToProject(changeResult.data, project)) {
      return badRequest("linkedChangeId does not reference a change in this project");
    }
    linkedChangeId = changeResult.data.id;
  }

  const issueResult = await createIssue(c.env.DB, logger, {
    project: project.name,
    projectId: project.id,
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
    project.id,
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

  // Bound the response so a project with thousands of issues can't return them
  // all at once. Client may request fewer via ?limit=, capped at the max, and
  // page forward with ?offset= (LIMIT/OFFSET matches the D1 scale here).
  const requested = Number(c.req.query("limit"));
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_ISSUES_PAGE)
      : DEFAULT_ISSUES_PAGE;
  const offsetRaw = Number(c.req.query("offset"));
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : undefined;

  const labelParam = c.req.query("label");
  const assigneeParam = c.req.query("assignee");
  const qParam = c.req.query("q");

  const issuesResult = await listIssues(c.env.DB, logger, project.name, status, {
    projectId: project.id,
    limit,
    ...(offset !== undefined ? { offset } : {}),
    ...(labelParam?.trim() ? { label: labelParam.trim() } : {}),
    ...(assigneeParam?.trim() ? { assignee: assigneeParam.trim() } : {}),
    ...(qParam?.trim() ? { search: qParam.trim().slice(0, MAX_SEARCH_LENGTH) } : {}),
  });
  if (!issuesResult.success) {
    return internalError(issuesResult.error.message);
  }
  const issues = issuesResult.data;

  // One batched query attaches each issue's labels to the listing.
  const labelsResult = await getLabelsForIssues(
    c.env.DB,
    logger,
    issues.map((issue) => issue.id),
  );
  if (!labelsResult.success) {
    return internalError(labelsResult.error.message);
  }
  const byIssue = labelsResult.data;

  return ok({
    issues: issues.map((issue) => ({ ...issue, labels: byIssue[issue.id] ?? [] })),
  });
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

  const issueResult = await getIssueByNumber(c.env.DB, logger, project.name, number, {
    projectId: project.id,
  });
  if (!issueResult.success) {
    if (issueResult.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(issueResult.error.message);
  }

  const labelsResult = await listIssueLabels(c.env.DB, logger, issueResult.data.id);
  if (!labelsResult.success) {
    return internalError(labelsResult.error.message);
  }

  return ok({ issue: { ...issueResult.data, labels: labelsResult.data } });
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
    .json<{
      title?: unknown;
      body?: unknown;
      status?: unknown;
      linkedChangeId?: unknown;
      assignee?: unknown;
      labels?: unknown;
    }>()
    .catch(() => ({}) as Record<string, unknown>);

  const updates: {
    title?: string;
    body?: string;
    status?: IssueStatus;
    linkedChangeId?: string | null;
    assignee?: string | null;
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
      if (!changeResult.success || !changeBelongsToProject(changeResult.data, project)) {
        return badRequest("linkedChangeId does not reference a change in this project");
      }
      updates.linkedChangeId = changeResult.data.id;
    } else {
      return badRequest("linkedChangeId must be a string or null");
    }
  }
  if (body.assignee !== undefined) {
    // Single assignee by design (#198): a string sets it, null/"" clears it.
    if (body.assignee === null || body.assignee === "") {
      updates.assignee = null;
    } else if (typeof body.assignee === "string" && body.assignee.trim()) {
      updates.assignee = body.assignee.trim();
    } else {
      return badRequest("assignee must be a non-empty string or null");
    }
  }
  let labels: string[] | undefined;
  if (body.labels !== undefined) {
    const parsed = parseLabels(body.labels);
    if ("error" in parsed) return badRequest(parsed.error);
    labels = parsed.labels;
  }

  const before = await getIssueByNumber(c.env.DB, logger, project.name, number, {
    projectId: project.id,
  });
  if (!before.success) {
    if (before.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(before.error.message);
  }

  const updateResult = await updateIssue(c.env.DB, logger, project.name, number, {
    ...updates,
    projectId: project.id,
  });
  if (!updateResult.success) {
    if (updateResult.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(updateResult.error.message);
  }
  const issue = updateResult.data;

  // Labels are a full-set replace keyed by the issue's globally-unique id, so
  // setting/removing is one idempotent write. Omitting `labels` leaves them as-is.
  let finalLabels: string[];
  if (labels !== undefined) {
    const setResult = await setIssueLabels(c.env.DB, logger, issue.id, labels);
    if (!setResult.success) return internalError(setResult.error.message);
    finalLabels = [...setResult.data].sort();
  } else {
    const labelsResult = await listIssueLabels(c.env.DB, logger, issue.id);
    if (!labelsResult.success) return internalError(labelsResult.error.message);
    finalLabels = labelsResult.data;
  }

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
      project.id,
    );
  }

  return ok({ issue: { ...issue, labels: finalLabels } });
});

// POST /api/projects/:namespace/:slug/issues/:number/comments — Add a comment
app.post("/:namespace/:slug/issues/:number/comments", async (c) => {
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

  // Same bar as opening an issue: anyone who can read the project may comment.
  if (!(await canReadProject(c.env.DB, project, userId, agentOwnerId))) {
    return notFound("Project", `${project.namespace}/${project.slug}`);
  }

  const number = parseIssueNumber(c.req.param("number"));
  if (number === null) return badRequest("Invalid issue number");

  const issueResult = await getIssueByNumber(c.env.DB, logger, project.name, number, {
    projectId: project.id,
  });
  if (!issueResult.success) {
    if (issueResult.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(issueResult.error.message);
  }
  const issue = issueResult.data;

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

  const commentResult = await addIssueComment(c.env.DB, logger, {
    issueId: issue.id,
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
    { type: "issue.commented", project: project.name, issueNumber: issue.number },
    actor,
    logger,
    project.id,
  );

  if (!contentType.includes("application/json")) {
    return c.redirect(`/${project.namespace}/${project.slug}/issues/${issue.number}`, 302);
  }
  return created({ comment: commentResult.data });
});

// GET /api/projects/:namespace/:slug/issues/:number/comments — List comments (paginated)
app.get("/:namespace/:slug/issues/:number/comments", async (c) => {
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

  const issueResult = await getIssueByNumber(c.env.DB, logger, project.name, number, {
    projectId: project.id,
  });
  if (!issueResult.success) {
    if (issueResult.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(issueResult.error.message);
  }

  // Same LIMIT/OFFSET pattern as the issues listing, in chronological order.
  const requested = Number(c.req.query("limit"));
  const limit =
    Number.isInteger(requested) && requested > 0
      ? Math.min(requested, MAX_COMMENTS_PAGE)
      : DEFAULT_COMMENTS_PAGE;
  const offsetRaw = Number(c.req.query("offset"));
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : undefined;

  const commentsResult = await listIssueComments(c.env.DB, logger, issueResult.data.id, {
    limit,
    ...(offset !== undefined ? { offset } : {}),
  });
  if (!commentsResult.success) {
    return internalError(commentsResult.error.message);
  }
  return ok({ comments: commentsResult.data });
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

  const before = await getIssueByNumber(c.env.DB, logger, project.name, number, {
    projectId: project.id,
  });
  if (!before.success) {
    if (before.error.code === "NOT_FOUND") return notFound("Issue", `#${number}`);
    return internalError(before.error.message);
  }

  const newStatus: IssueStatus = before.data.status === "open" ? "closed" : "open";
  const updateResult = await updateIssue(c.env.DB, logger, project.name, number, {
    status: newStatus,
    actorId: userId,
    projectId: project.id,
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
      project.id,
    );
  }

  return c.redirect(`/${project.namespace}/${project.slug}/issues/${number}`, 302);
});

export { app as issuesRouter };
