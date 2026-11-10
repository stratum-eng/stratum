/**
 * Operational alerts, raised as issues in a Stratum project the operator names.
 *
 * A check that finds the instance unhealthy needs somewhere to say so that a
 * person will see. `OPS_ALERT_PROJECT` names that place as `@namespace/slug`
 * (or `namespace/slug`). Unset, an alert is only logged — a self-hosted
 * instance gets no issues it did not ask for.
 *
 * `OPS_ALERT_EMAIL` adds an email, for an operator who would not otherwise look:
 * one when an alert is first raised and one when it clears. It is its own
 * setting, not `ADMIN_EMAIL`, because that one also decides who is an instance
 * administrator and must not be set just to receive mail.
 *
 * One open issue per alert `title` at a time: while it is open a repeat finding
 * is not filed again, and when the check comes back healthy the issue is
 * closed, so the next failure opens a new one instead of hiding behind a stale
 * one.
 */
import { SYSTEM_AUTHOR_ID, createIssue, listIssues, updateIssue } from "../storage/issues";
import { getProjectByPath } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import { escapeHtml } from "../utils/html";
import type { Logger } from "../utils/logger";

/** What an alert needs from the environment. */
export type OpsAlertEnv = Pick<
  Env,
  "DB" | "STATE" | "OPS_ALERT_PROJECT" | "OPS_ALERT_EMAIL" | "EMAIL" | "EMAIL_FROM_ADDRESS"
>;

export type OpsAlertOutcome =
  /** No project is configured, or it could not be resolved; the alert was logged only. */
  | { status: "logged-only"; why: string }
  | { status: "opened"; number: number }
  | { status: "already-open"; number: number }
  | { status: "closed"; number: number }
  | { status: "nothing-open" }
  | { status: "failed"; why: string };

/** How far back the open-issue lookup reads. An ops project with more open
 * issues than this could file a duplicate; that is the tolerable failure. */
const OPEN_ISSUE_SCAN_LIMIT = 200;

/** Parse `@namespace/slug` or `namespace/slug`. */
export function parseAlertProject(
  raw: string | undefined,
): { namespace: string; slug: string } | null {
  const trimmed = (raw ?? "").trim();
  const match = trimmed.match(/^(@?[A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (!match) return null;
  return { namespace: match[1] as string, slug: match[2] as string };
}

async function resolveAlertProject(
  env: Pick<Env, "STATE" | "OPS_ALERT_PROJECT">,
  logger: Logger,
): Promise<{ project: ProjectEntry } | { why: string }> {
  if (!env.OPS_ALERT_PROJECT?.trim()) return { why: "OPS_ALERT_PROJECT is not set" };
  const parsed = parseAlertProject(env.OPS_ALERT_PROJECT);
  if (!parsed) return { why: "OPS_ALERT_PROJECT is not a namespace/slug" };
  const found = await getProjectByPath(env.STATE, parsed.namespace, parsed.slug, logger);
  if (!found.success) return { why: "the OPS_ALERT_PROJECT project was not found" };
  return { project: found.data };
}

async function findOpenAlert(
  env: Pick<Env, "DB">,
  logger: Logger,
  project: ProjectEntry,
  title: string,
): Promise<{ number: number } | null | { why: string }> {
  const open = await listIssues(env.DB, logger, project.name, "open", {
    ...(project.id ? { projectId: project.id } : {}),
    limit: OPEN_ISSUE_SCAN_LIMIT,
  });
  if (!open.success) return { why: open.error.message };
  // Only an issue this module filed: a person's issue that happens to share
  // the title is theirs, and must not be closed on recovery.
  const match = open.data.find(
    (issue) => issue.title === title && issue.authorId === SYSTEM_AUTHOR_ID,
  );
  return match ? { number: match.number } : null;
}

/**
 * Raise an alert. Always logged at error level, whatever else happens, so the
 * finding is in the instance's logs even when no project is configured or the
 * issue could not be filed.
 */
export async function raiseOpsAlert(
  env: OpsAlertEnv,
  logger: Logger,
  alert: { title: string; body: string },
): Promise<OpsAlertOutcome> {
  logger.error("Operational alert", undefined, { title: alert.title, body: alert.body });

  const outcome = await fileAlertIssue(env, logger, alert);
  // Mailed when the alert is new. With no project to file in there is nothing
  // to tell a first finding from a repeat, so that case mails every time it is
  // raised; a check that runs daily then mails daily, which is the reminder an
  // operator with no issue to look at needs.
  if (outcome.status === "opened" || outcome.status === "logged-only") {
    const where =
      outcome.status === "opened"
        ? `Issue #${outcome.number} was opened in ${env.OPS_ALERT_PROJECT}.`
        : "No issue was opened.";
    await sendAlertEmail(env, logger, {
      subject: `[Stratum] ${alert.title}`,
      text: `${alert.body}\n\n${where}`,
    });
  }
  return outcome;
}

async function fileAlertIssue(
  env: OpsAlertEnv,
  logger: Logger,
  alert: { title: string; body: string },
): Promise<OpsAlertOutcome> {
  const resolved = await resolveAlertProject(env, logger);
  if ("why" in resolved) return { status: "logged-only", why: resolved.why };
  const { project } = resolved;

  const existing = await findOpenAlert(env, logger, project, alert.title);
  if (existing && "why" in existing) return { status: "failed", why: existing.why };
  if (existing) return { status: "already-open", number: existing.number };

  const created = await createIssue(env.DB, logger, {
    project: project.name,
    ...(project.id ? { projectId: project.id } : {}),
    title: alert.title,
    body: alert.body,
    authorType: "agent",
    authorId: SYSTEM_AUTHOR_ID,
  });
  if (!created.success) return { status: "failed", why: created.error.message };
  return { status: "opened", number: created.data.number };
}

/**
 * Mail the operator, if the instance can send mail and has been told where.
 * Best-effort: a failed send is logged and never changes what the caller
 * reports, since the issue and the log line already carry the finding.
 */
async function sendAlertEmail(
  env: OpsAlertEnv,
  logger: Logger,
  message: { subject: string; text: string },
): Promise<void> {
  const to = env.OPS_ALERT_EMAIL?.trim();
  if (!to || !env.EMAIL || !env.EMAIL_FROM_ADDRESS) return;
  try {
    await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM_ADDRESS, name: "Stratum Alerts" },
      subject: message.subject,
      text: message.text,
      html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(message.text)}</pre>`,
    });
    logger.info("Operational alert email sent", { subject: message.subject });
  } catch (error) {
    logger.error(
      "Failed to send operational alert email",
      error instanceof Error ? error : undefined,
      { subject: message.subject },
    );
  }
}

/** The check behind `title` is healthy again: close the issue it opened, if one is open. */
export async function resolveOpsAlert(
  env: OpsAlertEnv,
  logger: Logger,
  title: string,
): Promise<OpsAlertOutcome> {
  const resolved = await resolveAlertProject(env, logger);
  if ("why" in resolved) return { status: "logged-only", why: resolved.why };
  const { project } = resolved;

  const existing = await findOpenAlert(env, logger, project, title);
  if (existing && "why" in existing) return { status: "failed", why: existing.why };
  if (!existing) return { status: "nothing-open" };

  const closed = await updateIssue(env.DB, logger, project.name, existing.number, {
    status: "closed",
    actorId: SYSTEM_AUTHOR_ID,
    ...(project.id ? { projectId: project.id } : {}),
  });
  if (!closed.success) return { status: "failed", why: closed.error.message };
  logger.info("Operational alert resolved", { title, number: existing.number });
  await sendAlertEmail(env, logger, {
    subject: `[Stratum] Resolved: ${title}`,
    text: `The check passed again. Issue #${existing.number} in ${env.OPS_ALERT_PROJECT} was closed.`,
  });
  return { status: "closed", number: existing.number };
}
