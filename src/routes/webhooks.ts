import { Hono } from "hono";
import type { StratumEvent } from "../queue/events";
import { recordAudit } from "../storage/audit";
import { getProjectByPath } from "../storage/state";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listDeliveries,
  listWebhooks,
  setWebhookActive,
  webhookBelongsToProject,
} from "../storage/webhooks";
import type { Env, ProjectEntry } from "../types";
import { SOURCE_FOOTER_HTML } from "../ui/components/source-footer";
import { canWriteProject } from "../utils/authz";
import { escapeHtml } from "../utils/html";
import { createLogger } from "../utils/logger";
import type { Logger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { badRequest, created, forbidden, internalError, notFound, ok } from "../utils/response";
import { validateWebhookUrl } from "../utils/validation";

// Webhook config body is small (a URL string + an events list).
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

const app = new Hono<{ Bindings: Env }>();

/**
 * Event types a webhook may subscribe to.
 *
 * Keyed by `StratumEvent["type"]` rather than written as a bare string array so
 * the two cannot drift: adding a variant to the event union without listing it
 * here is a missing-property error, and listing a type the union does not have
 * is an excess-property error. Both fail the build instead of silently making
 * an event unsubscribable (or advertising one that can never fire).
 *
 * Object key order is the order the list is rendered and reported in.
 */
const SUBSCRIBABLE_EVENT_TYPES: Record<StratumEvent["type"], true> = {
  "change.created": true,
  "change.evaluated": true,
  "change.merged": true,
  "change.rejected": true,
  "change.reverted": true,
  "change.commented": true,
  "change.reviewed": true,
  "project.created": true,
  "project.imported": true,
  "workspace.created": true,
  "sync.completed": true,
  "issue.opened": true,
  "issue.commented": true,
  "issue.closed": true,
  "deployment.requested": true,
  "deployment.succeeded": true,
  "deployment.failed": true,
};

const SUBSCRIBABLE_EVENTS: string[] = Object.keys(SUBSCRIBABLE_EVENT_TYPES);

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
  if (!(await canWriteProject(c.env.DB, project, userId))) {
    return { response: forbidden("Project access denied") };
  }

  return { project };
}

function sanitizeEvents(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === "*") return "*";
  // Accept both API shapes ("a,b" string) and the management form's repeated
  // checkboxes (string[]; a checked "All events" box contributes "*").
  let raw: string[];
  if (Array.isArray(value)) {
    if (!value.every((entry): entry is string => typeof entry === "string")) return null;
    raw = value;
  } else if (typeof value === "string") {
    raw = [value];
  } else {
    return null;
  }
  const entries = raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.includes("*")) return "*";
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
    const parsed = await readJsonWithLimit<typeof body>(c, MAX_WEBHOOK_BODY_BYTES, logger).catch(
      () => ({}),
    );
    if (parsed instanceof Response) return parsed;
    body = parsed;
  } else {
    // all:true keeps every checked events checkbox instead of only the last one.
    const form = await c.req.parseBody({ all: true });
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
    projectId: project.id,
    url: urlResult.data,
    events,
    createdBy: userId,
  });
  if (!webhookResult.success) {
    logger.error("Failed to create webhook", webhookResult.error);
    return internalError(webhookResult.error.message);
  }

  await recordAudit(c.env.DB, logger, {
    action: "webhook.created",
    actorType: "user",
    actorId: userId,
    subject: webhookResult.data.id,
    detail: { project: project.name, url: webhookResult.data.url },
  });

  // Both responses below carry the signing secret: the HTML page renders it and
  // the JSON body returns it. `no-store` keeps it out of the browser disk cache
  // and any shared cache in between — `no-cache` would still permit storage,
  // which is the opposite of what is wanted.
  //
  // Set on the Response rather than through `c.header()`, because `created()`
  // returns a bare `Response.json(...)` that never passes through the Hono
  // context — a context header would silently miss the JSON path.
  const noStore = (res: Response): Response => {
    res.headers.set("Cache-Control", "no-store");
    return res;
  };

  if (!contentType.includes("application/json")) {
    // The management page redacts the signing secret, so a form-based creator
    // would otherwise never see it. Show it exactly once here (not persisted,
    // not in the URL) with a copy control and a link back to the management page.
    const wh = webhookResult.data;
    const backUrl = `/${project.namespace}/${project.slug}/webhooks`;
    const nonce = c.get("cspNonce") ?? "";
    const copyScript = `(function () {
  var btn = document.getElementById('copy-secret');
  var secret = document.getElementById('webhook-secret');
  if (!btn || !secret) return;
  btn.addEventListener('click', function () {
    // Clipboard API can be missing (insecure context) or blocked by policy;
    // fall back to selecting the value so a manual Ctrl/Cmd+C still works.
    var fallback = function () {
      var range = document.createRange();
      range.selectNodeContents(secret);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      btn.textContent = 'Press Ctrl/Cmd+C';
      setTimeout(function () { btn.textContent = 'Copy'; }, 3000);
    };
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fallback();
      return;
    }
    navigator.clipboard.writeText(secret.textContent).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
    }, fallback);
  });
})();`;
    return noStore(
      c.html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Webhook created — Stratum</title><link rel="stylesheet" href="/ui.css"></head><body><main class="main" style="max-width:640px"><div class="card settings-token-reveal"><h3 style="margin-top:0">Webhook created</h3><p class="settings-help"><strong>Copy the signing secret now — it will not be shown again.</strong></p><p class="settings-help">Payload URL: <code>${escapeHtml(wh.url)}</code></p><div class="token-reveal-row"><code class="settings-token" id="webhook-secret">${escapeHtml(wh.secret)}</code><button type="button" class="btn btn-small" id="copy-secret">Copy</button></div><p class="settings-help" style="margin-top:0.75rem">Verify each delivery's <code>X-Stratum-Signature</code> (HMAC-SHA256) with this secret.</p><p style="margin-top:1rem"><a href="${escapeHtml(backUrl)}">&larr; Back to webhooks</a></p></div></main>${SOURCE_FOOTER_HTML}<script nonce="${escapeHtml(nonce)}">${copyScript}</script></body></html>`,
        201,
      ),
    );
  }
  // The secret is returned on creation; receivers verify X-Stratum-Signature with it.
  return noStore(created({ webhook: webhookResult.data }));
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

  const webhooksResult = await listWebhooks(c.env.DB, logger, project.id);
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
  if (!webhookBelongsToProject(webhookResult.data, project)) return notFound("Webhook", id);

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
  if (!webhookBelongsToProject(webhookResult.data, project)) return notFound("Webhook", id);

  const updateResult = await setWebhookActive(c.env.DB, logger, id, !webhookResult.data.active);
  if (!updateResult.success) {
    return internalError(updateResult.error.message);
  }

  await recordAudit(c.env.DB, logger, {
    action: "webhook.toggled",
    actorType: "user",
    actorId: c.get("userId"),
    subject: id,
    detail: { project: project.name, active: !webhookResult.data.active },
  });

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
  if (!webhookBelongsToProject(webhookResult.data, project)) return notFound("Webhook", id);

  const deleteResult = await deleteWebhook(c.env.DB, logger, id);
  if (!deleteResult.success) {
    return internalError(deleteResult.error.message);
  }

  await recordAudit(c.env.DB, logger, {
    action: "webhook.deleted",
    actorType: "user",
    actorId: c.get("userId"),
    subject: id,
    detail: { project: project.name },
  });

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
  if (!webhookBelongsToProject(webhookResult.data, project)) return notFound("Webhook", id);

  const deleteResult = await deleteWebhook(c.env.DB, logger, id);
  if (!deleteResult.success) {
    return internalError(deleteResult.error.message);
  }

  await recordAudit(c.env.DB, logger, {
    action: "webhook.deleted",
    actorType: "user",
    actorId: c.get("userId"),
    subject: id,
    detail: { project: project.name },
  });

  return c.redirect(`/${project.namespace}/${project.slug}/webhooks`, 302);
});

export { app as webhooksRouter, SUBSCRIBABLE_EVENTS };
