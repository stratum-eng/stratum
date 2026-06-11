import { Hono } from "hono";
import { getProjectByPath } from "../storage/state";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listDeliveries,
  listWebhooks,
  setWebhookActive,
} from "../storage/webhooks";
import type { Env, ProjectEntry } from "../types";
import { canWriteProject } from "../utils/authz";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { badRequest, created, forbidden, internalError, notFound, ok } from "../utils/response";
import { validateWebhookUrl } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

/** Event types a webhook may subscribe to. */
const SUBSCRIBABLE_EVENTS = [
  "change.created",
  "change.evaluated",
  "change.merged",
  "change.rejected",
  "change.commented",
  "change.reviewed",
  "project.created",
  "project.imported",
  "workspace.created",
  "sync.completed",
  "issue.opened",
  "issue.closed",
];

interface ProjectAccess {
  project: ProjectEntry;
}

type AccessFailure = { response: Response };

async function requireProjectAdmin(
  c: {
    env: Env;
    get: (key: "userId") => string | undefined;
    req: { param: (key: string) => string };
  },
  logger: Logger,
): Promise<ProjectAccess | AccessFailure> {
  const userId = c.get("userId");
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
  const project = projectResult.data;

  // Webhook URLs and secrets are sensitive: writers only, even for reads.
  if (!canWriteProject(project, userId)) {
    return { response: forbidden("Project access denied") };
  }

  return { project };
}

function sanitizeEvents(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === "*") return "*";
  if (typeof value !== "string") return null;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return "*";
  const unknown = entries.filter((entry) => !SUBSCRIBABLE_EVENTS.includes(entry));
  if (unknown.length > 0) return null;
  return entries.join(",");
}

// POST /api/projects/:namespace/:slug/webhooks — Create a webhook
app.post("/:namespace/:slug/webhooks", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const access = await requireProjectAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project } = access;
  const userId = c.get("userId");
  if (!userId) return forbidden("Only authenticated users can manage webhooks");

  let body: { url?: unknown; events?: unknown };
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await c.req.json<typeof body>().catch(() => ({}));
  } else {
    const form = await c.req.parseBody();
    body = { url: form.url, events: form.events };
  }

  const urlResult = validateWebhookUrl(body.url, logger);
  if (!urlResult.success) {
    return badRequest(urlResult.error[0]?.message ?? "Invalid webhook URL");
  }

  const events = sanitizeEvents(body.events);
  if (events === null) {
    return badRequest(
      `events must be "*" or a comma-separated subset of: ${SUBSCRIBABLE_EVENTS.join(", ")}`,
    );
  }

  const webhookResult = await createWebhook(c.env.DB, logger, {
    project: project.name,
    url: urlResult.data,
    events,
    createdBy: userId,
  });
  if (!webhookResult.success) {
    logger.error("Failed to create webhook", webhookResult.error);
    return internalError(webhookResult.error.message);
  }

  if (!contentType.includes("application/json")) {
    return c.redirect(`/${project.namespace}/${project.slug}/webhooks`, 302);
  }
  // The secret is returned on creation; receivers verify X-Stratum-Signature with it.
  return created({ webhook: webhookResult.data });
});

// GET /api/projects/:namespace/:slug/webhooks — List webhooks
app.get("/:namespace/:slug/webhooks", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const access = await requireProjectAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project } = access;

  const webhooksResult = await listWebhooks(c.env.DB, logger, project.name);
  if (!webhooksResult.success) {
    return internalError(webhooksResult.error.message);
  }

  return ok({
    webhooks: webhooksResult.data.map(({ secret: _secret, ...webhook }) => webhook),
  });
});

// GET /api/projects/:namespace/:slug/webhooks/:id/deliveries — Delivery log
app.get("/:namespace/:slug/webhooks/:id/deliveries", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const access = await requireProjectAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project } = access;
  const id = c.req.param("id");

  const webhookResult = await getWebhook(c.env.DB, logger, id);
  if (!webhookResult.success) {
    if (webhookResult.error.code === "NOT_FOUND") return notFound("Webhook", id);
    return internalError(webhookResult.error.message);
  }
  if (webhookResult.data.project !== project.name) return notFound("Webhook", id);

  const deliveriesResult = await listDeliveries(c.env.DB, logger, id);
  if (!deliveriesResult.success) {
    return internalError(deliveriesResult.error.message);
  }

  return ok({ deliveries: deliveriesResult.data });
});

// POST /api/projects/:namespace/:slug/webhooks/:id/toggle — Enable/disable
app.post("/:namespace/:slug/webhooks/:id/toggle", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const access = await requireProjectAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project } = access;
  const id = c.req.param("id");

  const webhookResult = await getWebhook(c.env.DB, logger, id);
  if (!webhookResult.success) {
    if (webhookResult.error.code === "NOT_FOUND") return notFound("Webhook", id);
    return internalError(webhookResult.error.message);
  }
  if (webhookResult.data.project !== project.name) return notFound("Webhook", id);

  const updateResult = await setWebhookActive(c.env.DB, logger, id, !webhookResult.data.active);
  if (!updateResult.success) {
    return internalError(updateResult.error.message);
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return c.redirect(`/${project.namespace}/${project.slug}/webhooks`, 302);
  }
  return ok({ id, active: !webhookResult.data.active });
});

// DELETE /api/projects/:namespace/:slug/webhooks/:id — Delete a webhook
app.delete("/:namespace/:slug/webhooks/:id", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const access = await requireProjectAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project } = access;
  const id = c.req.param("id");

  const webhookResult = await getWebhook(c.env.DB, logger, id);
  if (!webhookResult.success) {
    if (webhookResult.error.code === "NOT_FOUND") return notFound("Webhook", id);
    return internalError(webhookResult.error.message);
  }
  if (webhookResult.data.project !== project.name) return notFound("Webhook", id);

  const deleteResult = await deleteWebhook(c.env.DB, logger, id);
  if (!deleteResult.success) {
    return internalError(deleteResult.error.message);
  }

  return ok({ deleted: true, id });
});

// POST /api/projects/:namespace/:slug/webhooks/:id/delete — Form-friendly delete
app.post("/:namespace/:slug/webhooks/:id/delete", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const access = await requireProjectAdmin(c, logger);
  if ("response" in access) return access.response;
  const { project } = access;
  const id = c.req.param("id");

  const webhookResult = await getWebhook(c.env.DB, logger, id);
  if (!webhookResult.success) {
    if (webhookResult.error.code === "NOT_FOUND") return notFound("Webhook", id);
    return internalError(webhookResult.error.message);
  }
  if (webhookResult.data.project !== project.name) return notFound("Webhook", id);

  const deleteResult = await deleteWebhook(c.env.DB, logger, id);
  if (!deleteResult.success) {
    return internalError(deleteResult.error.message);
  }

  return c.redirect(`/${project.namespace}/${project.slug}/webhooks`, 302);
});

export { app as webhooksRouter, SUBSCRIBABLE_EVENTS };
