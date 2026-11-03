/**
 * Pages that a form's POST handler re-renders itself when it refuses the
 * submission, shared with the GET routes that render them fresh.
 *
 * A refusal used to redirect back with what the user typed in the query
 * string. That let anyone build a link that opened the form already holding
 * values of their choosing — a webhook pointed at their endpoint with every
 * event checked, an import of their repository — one click from being saved by
 * a project admin. So a refused submission is re-rendered directly from the
 * POST, with the user's own values and a 4xx status, the way the settings
 * forms already work; the query string may select an error message by code,
 * but never supplies a value.
 */
import type { Context } from "hono";
import { getUser } from "../storage/users";
import { listDeliveries, listWebhooks } from "../storage/webhooks";
import type { Env, ProjectEntry } from "../types";
import {
  type NewProjectError,
  type NewProjectFormValues,
  NewProjectPage,
} from "../ui/pages/new-project";
import { type WebhookFormError, type WebhookFormValues, WebhooksPage } from "../ui/pages/webhooks";
import type { createLogger } from "../utils/logger";

type Logger = ReturnType<typeof createLogger>;

/** The signed-in user as the page chrome shows them, or `null`. */
export async function getCurrentUser(
  c: { get: (key: "userId") => string | undefined; env: { DB: D1Database } },
  logger: Logger,
): Promise<{ id: string; email: string; username: string; displayName?: string } | null> {
  const userId = c.get("userId");
  if (!userId) return null;
  const result = await getUser(c.env.DB, userId, logger);
  if (!result.success) return null;

  const user = result.data;
  // Username is always present - enforced by database schema and validation.
  // The display name rides along so the header shows it on every page, not
  // only on Settings.
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    ...(user.displayName !== undefined ? { displayName: user.displayName } : {}),
  };
}

type FormStatus = 200 | 400 | 403 | 409;

/**
 * The new-project form, optionally with a refusal and the values the user
 * submitted. `values` must come from the request body being refused, never
 * from the query string (see the module comment).
 */
export async function renderNewProjectPage(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
  form: { error?: NewProjectError | undefined; values?: NewProjectFormValues } = {},
  status: FormStatus = 200,
): Promise<Response> {
  const user = await getCurrentUser(c, logger);
  return c.html(
    <NewProjectPage
      user={user}
      nonce={c.get("cspNonce") ?? ""}
      error={form.error}
      {...(form.values !== undefined ? { values: form.values } : {})}
    />,
    status,
  );
}

/**
 * The webhook management page, optionally with a refused "Add webhook"
 * submission. Callers have already checked the caller may manage the
 * project's webhooks. `values` must come from the refused request body.
 */
export async function renderWebhooksPage(
  c: Context<{ Bindings: Env }>,
  logger: Logger,
  project: ProjectEntry,
  subscribableEvents: string[],
  form: { error?: WebhookFormError | undefined; values?: WebhookFormValues | undefined } = {},
  status: FormStatus = 200,
): Promise<Response | { error: "list-failed" }> {
  const [user, webhooksResult] = await Promise.all([
    getCurrentUser(c, logger),
    listWebhooks(c.env.DB, logger, project.id),
  ]);
  if (!webhooksResult.success) {
    logger.error("Failed to list webhooks", webhooksResult.error);
    return { error: "list-failed" };
  }

  const webhooks = await Promise.all(
    // Strip the signing secret before it reaches the HTML — it is shown once on
    // creation via the JSON API and must never render in the management page.
    webhooksResult.data.map(async ({ secret: _secret, ...webhook }) => {
      const deliveriesResult = await listDeliveries(c.env.DB, logger, webhook.id, 5);
      return { webhook, deliveries: deliveriesResult.success ? deliveriesResult.data : [] };
    }),
  );

  return c.html(
    <WebhooksPage
      project={{
        name: project.name,
        namespace: project.namespace,
        slug: project.slug,
        ...(project.visibility !== undefined ? { visibility: project.visibility } : {}),
      }}
      webhooks={webhooks}
      subscribableEvents={subscribableEvents}
      formError={form.error}
      formValues={form.values}
      user={user}
      nonce={c.get("cspNonce") ?? ""}
    />,
    status,
  );
}
