/**
 * Operational alerts, raised as issues in a Stratum project the operator names.
 *
 * A check that finds the instance unhealthy needs somewhere to say so that a
 * person will see. `OPS_ALERT_PROJECT` names that place as `@namespace/slug`
 * (or `namespace/slug`). Unset, an alert is only logged — a self-hosted
 * instance gets no issues it did not ask for.
 *
 * One open issue per alert `title` at a time: while it is open a repeat finding
 * is not filed again, and when the check comes back healthy the issue is
 * closed, so the next failure opens a new one instead of hiding behind a stale
 * one.
 */
import { SYSTEM_AUTHOR_ID, createIssue, listIssues, updateIssue } from "../storage/issues";
import { getProjectByPath } from "../storage/state";
import type { Env, ProjectEntry } from "../types";
import type { Logger } from "../utils/logger";

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
  env: Pick<Env, "DB" | "STATE" | "OPS_ALERT_PROJECT">,
  logger: Logger,
  alert: { title: string; body: string },
): Promise<OpsAlertOutcome> {
  logger.error("Operational alert", undefined, { title: alert.title, body: alert.body });

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

/** The check behind `title` is healthy again: close the issue it opened, if one is open. */
export async function resolveOpsAlert(
  env: Pick<Env, "DB" | "STATE" | "OPS_ALERT_PROJECT">,
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
  return { status: "closed", number: existing.number };
}
