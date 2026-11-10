import type { ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * Sensitive operations worth an audit trail.
 *
 * The trail is APPEND-ONLY: this module exposes writes and reads, never an
 * update or delete, and migration 055 installs triggers that abort any UPDATE
 * or DELETE against `audit_log` at the database. The only exception the
 * triggers allow (migration 069) is right-to-erasure: rewriting an account's
 * id or email to `deleted-user` in `actor_id`, `subject` or `detail` while that
 * account is being deleted (`anonymizeUserContributions` and
 * `eraseUserFromAuditLog` in src/storage/deletion.ts).
 *
 * `subject` names the thing acted on (a credential, connection, org or team),
 * not a person, where one of those exists (#425); a user the event is about
 * goes in `detail.userId`.
 */
export type AuditAction =
  | "session.created"
  | "token.rotated"
  | "token.created"
  | "token.revoked"
  | "token.legacy_disabled"
  // A short-lived git credential for one workspace (#408). Records the
  // workspace, the expiry and which kind of credential minted it; never the
  // secret.
  | "workspace_remote.credential_minted"
  | "agent.created"
  | "agent.revoked"
  | "agent_signup.requested"
  | "agent_signup.approved"
  | "webhook.created"
  | "webhook.toggled"
  | "webhook.deleted"
  | "webhook.secret_rotated"
  | "merge.forced"
  | "conflict.resolved_manually"
  | "review.approvals_dismissed"
  | "backup.run"
  // An admin applying a backed-up repository (or drilling it). Recorded before
  // the push as well as after, so a run that dies midway still leaves a trail.
  | "backup.repo_restore"
  | "deletion.requested"
  | "deletion.started"
  | "deletion.completed"
  | "deletion.incomplete"
  | "deletion.redrive"
  | "webhook.project_id_backfilled"
  | "branch.created"
  | "branch.deleted"
  | "telemetry.preference_changed"
  | "user.display_name_changed"
  | "user.renamed"
  // MCP OAuth grants (#349). Recorded on the consent decision and on revocation
  // so "which editor did I connect, and when did I disconnect it" is answerable
  // from the trail rather than only from the live grant list.
  | "oauth.authorized"
  | "oauth.revoked"
  // Post-merge deployments. The secret entries record only the name — the value
  // is never read back anywhere, and an audit row is not the place to start.
  | "secret.written"
  | "secret.deleted"
  | "deployment.approved"
  | "deployment.retried"
  // Enterprise SSO (OIDC) + SCIM (#253).
  | "user.disabled"
  | "user.enabled"
  | "sso.connection.created"
  | "sso.connection.updated"
  | "sso.connection.deleted"
  | "sso.domain.verified"
  | "sso.scim_token.rotated"
  | "scim.user.provisioned"
  | "scim.user.updated"
  | "scim.user.deactivated"
  | "scim.user.reactivated"
  // Org structure (#255). Membership and role changes are what an org admin
  // most needs to answer "who gave this person access, and when".
  | "org.created"
  | "org.deleted"
  | "org.owner_transferred"
  | "org.member.added"
  | "org.member.removed"
  | "org.member.role_changed"
  | "team.created"
  | "team.deleted"
  | "team.member.added"
  | "team.member.removed"
  // A rejected credential or sign-in that identified a real account or an
  // org's SSO connection (#255). Unknown credentials are deliberately NOT
  // recorded — see src/utils/auth-audit.ts for the flood-control policy.
  | "auth.failed"
  // Passkeys as a second factor (#256).
  | "passkey.registered"
  | "passkey.renamed"
  | "passkey.removed"
  | "second_factor.succeeded"
  | "recovery_code.used"
  | "recovery_codes.regenerated"
  | "org.second_factor_policy_changed"
  // GitHub App installation ↔ Stratum owner links (migration 059). A link is
  // what lets an owner's projects act on that installation's repositories.
  | "github_app.installation_linked"
  | "github_app.installation_unlinked"
  // Per-org IP allowlist (#399). Denials are sampled: see auditIpDenial.
  | "org.ip_allowlist_changed"
  | "org.ip_access_denied"
  // GitHub issue import (#421): copies a repository's issues into the project
  // using the instance's GitHub credential, so who started one is recorded.
  | "issues.github_import_started"
  // Push mirror (#417). Configuring one decides where a project's history is
  // published, and resuming one is the only thing that clears a divergence, so
  // both name who did it. `mirror.diverged` is written by the system when a
  // push finds the target holding history the project does not.
  | "mirror.configured"
  | "mirror.removed"
  | "mirror.resumed"
  | "mirror.diverged"
  // Break-glass resync (#418): an admin fast-forwarding the default branch to
  // its GitHub copy, which brings in commits no evaluator ran on.
  // `branch.resync_requested` is written BEFORE anything runs, the same way
  // `backup.repo_restore` is, so an attempt that dies between the push and the
  // response still leaves a trail; `branch.resynced` records the move itself,
  // with both commits.
  | "branch.resync_requested"
  | "branch.resynced"
  // The resync stopped without knowing whether its push landed: it timed out
  // (the push is not cancelled) or its run died. Written so the audit log
  // names the two commits when nothing else will.
  | "branch.resync_uncertain";

export interface AuditEntry {
  id: string;
  action: AuditAction | string;
  actorType: "user" | "agent" | "system";
  actorId?: string;
  subject?: string;
  /** The org the event belongs to, when it belongs to one (#255). */
  orgId?: string;
  /** The project the event happened in, when it happened in one (#255). */
  projectId?: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

interface AuditRow {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  subject: string | null;
  detail: string;
  created_at: string;
  org_id?: string | null;
  project_id?: string | null;
}

/** The slice of a project that decides an audit row's scope. */
export type AuditProjectRef = Pick<ProjectEntry, "id" | "ownerType" | "ownerId">;

export interface RecordAuditOptions {
  action: AuditAction;
  actorType: "user" | "agent" | "system";
  actorId?: string;
  subject?: string;
  detail?: Record<string, unknown>;
  /** Explicit org scope, for events about the org itself (membership, SSO). */
  orgId?: string;
  /**
   * The project the event happened in. Its id is recorded, and an org-owned
   * project scopes the row to that org — so a call site hands over the project
   * it already holds and never works out ownership itself.
   */
  project?: AuditProjectRef;
}

/**
 * Where an audit row belongs. An explicit `orgId` wins; otherwise an
 * org-owned project lends its owner. User- and agent-owned projects belong to
 * no org, so their events stay visible to instance admins only.
 */
export function resolveAuditScope(opts: Pick<RecordAuditOptions, "orgId" | "project">): {
  orgId: string | null;
  projectId: string | null;
} {
  const projectOrg = opts.project?.ownerType === "org" ? opts.project.ownerId : undefined;
  return {
    orgId: opts.orgId ?? projectOrg ?? null,
    projectId: opts.project?.id ?? null,
  };
}

function rowToEntry(row: AuditRow): AuditEntry {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.detail);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      detail = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed detail renders as empty; the row itself is still useful.
  }
  const entry: AuditEntry = {
    id: row.id,
    action: row.action,
    actorType: row.actor_type as AuditEntry["actorType"],
    detail,
    createdAt: row.created_at,
  };
  if (row.actor_id !== null) entry.actorId = row.actor_id;
  if (row.subject !== null) entry.subject = row.subject;
  if (row.org_id != null) entry.orgId = row.org_id;
  if (row.project_id != null) entry.projectId = row.project_id;
  return entry;
}

/**
 * Record an audit entry. Best-effort by contract: failures are logged and
 * returned, but audited operations must not fail because auditing did.
 */
export async function recordAudit(
  db: D1Database,
  logger: Logger,
  opts: RecordAuditOptions,
): Promise<Result<void, AppError>> {
  const scope = resolveAuditScope(opts);
  try {
    // org_id/project_id are appended LAST so the first seven bindings keep the
    // positions existing readers (and test stubs) rely on.
    await db
      .prepare(
        "INSERT INTO audit_log (id, action, actor_type, actor_id, subject, detail, created_at, org_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        newId("aud"),
        opts.action,
        opts.actorType,
        opts.actorId ?? null,
        opts.subject ?? null,
        JSON.stringify(opts.detail ?? {}),
        new Date().toISOString(),
        scope.orgId,
        scope.projectId,
      )
      .run();
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to record audit entry",
            "DATABASE_ERROR",
            500,
            { operation: "recordAudit", action: opts.action },
          );
    logger.error("Failed to record audit entry", appError, { action: opts.action });
    return err(appError);
  }
}

/** Hard ceiling on one page, whatever the caller asks for. */
export const AUDIT_PAGE_MAX = 500;
const AUDIT_PAGE_DEFAULT = 100;

export interface AuditQuery {
  action?: string;
  actorId?: string;
  orgId?: string;
  /** Inclusive lower bound on created_at (ISO-8601). */
  since?: string;
  /** Exclusive upper bound on created_at (ISO-8601). */
  until?: string;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Pass back as `cursor` for the next (older) page; absent on the last page. */
  nextCursor?: string;
}

interface AuditCursor {
  createdAt: string;
  id: string;
}

/**
 * Cursors are base64url JSON of the last row's (created_at, id). Keyset rather
 * than OFFSET so a page stays stable while new rows land at the head, and so a
 * deep page costs what the first one does.
 */
export function encodeAuditCursor(cursor: AuditCursor): string {
  const json = JSON.stringify([cursor.createdAt, cursor.id]);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns null for anything that is not a cursor this module minted. */
export function decodeAuditCursor(raw: string): AuditCursor | null {
  try {
    const parsed: unknown = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * One page of the audit trail, newest first, ordered by (created_at, id) so
 * rows sharing a timestamp still page deterministically. An undecodable
 * cursor is a VALIDATION_ERROR rather than a silent restart from the head.
 */
export async function queryAuditLog(
  db: D1Database,
  logger: Logger,
  opts: AuditQuery = {},
): Promise<Result<AuditPage, AppError>> {
  const limit = Math.min(Math.max(opts.limit ?? AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX);
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (opts.orgId !== undefined) {
    conditions.push("org_id = ?");
    bindings.push(opts.orgId);
  }
  if (opts.action) {
    conditions.push("action = ?");
    bindings.push(opts.action);
  }
  if (opts.actorId) {
    conditions.push("actor_id = ?");
    bindings.push(opts.actorId);
  }
  if (opts.since) {
    conditions.push("created_at >= ?");
    bindings.push(opts.since);
  }
  if (opts.until) {
    conditions.push("created_at < ?");
    bindings.push(opts.until);
  }
  if (opts.cursor !== undefined) {
    const cursor = decodeAuditCursor(opts.cursor);
    if (!cursor) {
      return err(new AppError("Invalid cursor", "VALIDATION_ERROR", 400));
    }
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  // One extra row says whether another page exists, without a COUNT.
  bindings.push(limit + 1);

  try {
    const result = await db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(...bindings)
      .all<AuditRow>();
    const rows = result.results;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const page: AuditPage = { entries: pageRows.map(rowToEntry) };
    const last = pageRows[pageRows.length - 1];
    if (hasMore && last) {
      page.nextCursor = encodeAuditCursor({ createdAt: last.created_at, id: last.id });
    }
    return ok(page);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to list audit log",
            "DATABASE_ERROR",
            500,
            { operation: "queryAuditLog" },
          );
    logger.error("Failed to list audit log", appError);
    return err(appError);
  }
}

/** Newest-first entries without paging metadata. */
export async function listAuditLog(
  db: D1Database,
  logger: Logger,
  opts: { action?: string; actorId?: string; limit?: number } = {},
): Promise<Result<AuditEntry[], AppError>> {
  const page = await queryAuditLog(db, logger, opts);
  if (!page.success) return page;
  return ok(page.data.entries);
}

/**
 * Record an entry unless one with the same (action, subject, org scope) was
 * written at or after `sinceIso` — the dedupe for high-volume events (failed
 * authentication). Returns whether a row was written.
 *
 * The guard and the insert are ONE statement (`INSERT … SELECT … WHERE NOT
 * EXISTS`), so concurrent callers cannot both pass a separate probe and each
 * write: SQLite/D1 executes a statement atomically, and the second one sees the
 * first one's row. The org scope is part of the key with `IS`, so an
 * unscoped row only suppresses unscoped rows and one org's failure never
 * hides another org's.
 *
 * Fails OPEN: if the guarded insert itself errors, it falls back to a plain
 * `recordAudit` — a possible duplicate row is acceptable, a dropped
 * failed-auth event is not. If that also fails, recordAudit has logged it.
 */
export async function recordAuditOncePerWindow(
  db: D1Database,
  logger: Logger,
  opts: RecordAuditOptions & { subject: string },
  sinceIso: string,
): Promise<boolean> {
  const scope = resolveAuditScope(opts);
  try {
    const result = await db
      .prepare(
        `INSERT INTO audit_log (id, action, actor_type, actor_id, subject, detail, created_at, org_id, project_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM audit_log
             WHERE action = ? AND subject = ? AND org_id IS ? AND created_at >= ?
          )`,
      )
      .bind(
        newId("aud"),
        opts.action,
        opts.actorType,
        opts.actorId ?? null,
        opts.subject,
        JSON.stringify(opts.detail ?? {}),
        new Date().toISOString(),
        scope.orgId,
        scope.projectId,
        opts.action,
        opts.subject,
        scope.orgId,
        sinceIso,
      )
      .run();
    return (result.meta?.changes ?? 0) > 0;
  } catch (error) {
    logger.warn("Guarded audit insert failed; recording without dedupe", {
      action: opts.action,
      error: error instanceof Error ? error.message : String(error),
    });
    const fallback = await recordAudit(db, logger, opts);
    return fallback.success;
  }
}
