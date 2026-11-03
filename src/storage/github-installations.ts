/**
 * GitHub App installations and their link to a Stratum owner
 * (migration 059). See that migration for why the link exists; the token
 * path that enforces it is `resolveGitHubToken` in src/github/app-auth.ts.
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { ProjectEntry } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** A Stratum owner an installation can be linked to. */
export interface StratumOwnerRef {
  type: "user" | "org";
  id: string;
}

/**
 * Whoever an outbound GitHub call acts for — normally the project's owner.
 * An agent principal is matched through the user who owns the agent.
 */
export interface GitHubPrincipal {
  type: ProjectEntry["ownerType"];
  id: string;
}

export const projectPrincipal = (
  project: Pick<ProjectEntry, "ownerType" | "ownerId">,
): GitHubPrincipal => ({ type: project.ownerType, id: project.ownerId });

export interface GitHubInstallation {
  installationId: number;
  accountLogin: string;
  accountId: string;
  /** GitHub's account type: "User" or "Organization". */
  accountType: string;
  installerGithubId?: string;
  suspendedAt?: string;
  owner?: StratumOwnerRef;
  linkedByUserId?: string;
  linkedAt?: string;
}

interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_id: string;
  account_type: string;
  installer_github_id: string | null;
  suspended_at: string | null;
  stratum_owner_type: "user" | "org" | null;
  stratum_owner_id: string | null;
  linked_by_user_id: string | null;
  linked_at: string | null;
}

function rowToInstallation(row: InstallationRow): GitHubInstallation {
  return {
    installationId: row.installation_id,
    accountLogin: row.account_login,
    accountId: row.account_id,
    accountType: row.account_type,
    ...(row.installer_github_id !== null ? { installerGithubId: row.installer_github_id } : {}),
    ...(row.suspended_at !== null ? { suspendedAt: row.suspended_at } : {}),
    ...(row.stratum_owner_type !== null && row.stratum_owner_id !== null
      ? { owner: { type: row.stratum_owner_type, id: row.stratum_owner_id } }
      : {}),
    ...(row.linked_by_user_id !== null ? { linkedByUserId: row.linked_by_user_id } : {}),
    ...(row.linked_at !== null ? { linkedAt: row.linked_at } : {}),
  };
}

function storageError(message: string, error: unknown): AppError {
  return new AppError(
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    "STORAGE_ERROR",
    500,
  );
}

export interface InstallationEventFacts {
  installationId: number;
  accountLogin: string;
  accountId: string;
  accountType: string;
  /** Only an `installation.created` event's sender is the installer. */
  installerGithubId?: string;
}

/**
 * Records an installation as GitHub reported it. The installer is written
 * only when known and never overwritten — a later event's sender is whoever
 * changed the repo selection, not who installed — and the Stratum link is
 * left untouched.
 */
export async function upsertInstallation(
  db: D1Database,
  facts: InstallationEventFacts,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `INSERT INTO github_app_installations
           (installation_id, account_login, account_id, account_type, installer_github_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (installation_id) DO UPDATE SET
           account_login = excluded.account_login,
           account_id = excluded.account_id,
           account_type = excluded.account_type,
           installer_github_id = COALESCE(github_app_installations.installer_github_id, excluded.installer_github_id),
           updated_at = datetime('now')`,
      )
      .bind(
        facts.installationId,
        facts.accountLogin,
        facts.accountId,
        facts.accountType,
        facts.installerGithubId ?? null,
      )
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to record GitHub App installation", undefined, {
      installationId: facts.installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to record GitHub App installation", error));
  }
}

/** Forgets an uninstalled installation, link included. */
export async function deleteInstallation(
  db: D1Database,
  installationId: number,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare("DELETE FROM github_app_installations WHERE installation_id = ?")
      .bind(installationId)
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to delete GitHub App installation", undefined, {
      installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to delete GitHub App installation", error));
  }
}

export async function setInstallationSuspended(
  db: D1Database,
  installationId: number,
  suspended: boolean,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `UPDATE github_app_installations
            SET suspended_at = ${suspended ? "datetime('now')" : "NULL"}, updated_at = datetime('now')
          WHERE installation_id = ?`,
      )
      .bind(installationId)
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to update GitHub App installation suspension", undefined, {
      installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to update GitHub App installation", error));
  }
}

export async function getInstallation(
  db: D1Database,
  installationId: number,
  logger: Logger,
): Promise<Result<GitHubInstallation | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM github_app_installations WHERE installation_id = ?")
      .bind(installationId)
      .first<InstallationRow>();
    return ok(row ? rowToInstallation(row) : null);
  } catch (error) {
    logger.error("Failed to read GitHub App installation", undefined, {
      installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to read GitHub App installation", error));
  }
}

/**
 * Installations a user may see on the setup page: ones they can prove control
 * of on GitHub, plus ones linked to them or to an org they administer.
 */
export async function listInstallationsVisibleTo(
  db: D1Database,
  user: { id: string; githubId?: string | undefined },
  logger: Logger,
): Promise<Result<GitHubInstallation[], AppError>> {
  try {
    const { results } = await db
      .prepare(
        `SELECT * FROM github_app_installations
          WHERE (?1 IS NOT NULL AND (installer_github_id = ?1
                 OR (account_type = 'User' AND account_id = ?1)))
             OR (stratum_owner_type = 'user' AND stratum_owner_id = ?2)
             OR (stratum_owner_type = 'org' AND stratum_owner_id IN
                  (SELECT org_id FROM org_members WHERE user_id = ?2 AND role = 'admin'))
          ORDER BY account_login`,
      )
      .bind(user.githubId ?? null, user.id)
      .all<InstallationRow>();
    return ok(results.map(rowToInstallation));
  } catch (error) {
    logger.error("Failed to list GitHub App installations", undefined, {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to list GitHub App installations", error));
  }
}

/**
 * Whether this GitHub identity controls the installation: it installed it,
 * or the installation is on its own personal account. Only a verified
 * `users.github_id` may be passed — that is what makes this a proof.
 */
export function githubIdentityControls(
  installation: GitHubInstallation,
  githubId: string | undefined,
): boolean {
  if (!githubId) return false;
  if (installation.installerGithubId === githubId) return true;
  return installation.accountType === "User" && installation.accountId === githubId;
}

export async function linkInstallation(
  db: D1Database,
  installationId: number,
  owner: StratumOwnerRef,
  linkedByUserId: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    const result = await db
      .prepare(
        `UPDATE github_app_installations
            SET stratum_owner_type = ?, stratum_owner_id = ?, linked_by_user_id = ?,
                linked_at = datetime('now'), updated_at = datetime('now')
          WHERE installation_id = ?`,
      )
      .bind(owner.type, owner.id, linkedByUserId, installationId)
      .run();
    if (result.meta.changes === 0) {
      return err(new AppError("Installation not found", "NOT_FOUND", 404, { installationId }));
    }
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to link GitHub App installation", undefined, {
      installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to link GitHub App installation", error));
  }
}

export async function unlinkInstallation(
  db: D1Database,
  installationId: number,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        `UPDATE github_app_installations
            SET stratum_owner_type = NULL, stratum_owner_id = NULL, linked_by_user_id = NULL,
                linked_at = NULL, updated_at = datetime('now')
          WHERE installation_id = ?`,
      )
      .bind(installationId)
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to unlink GitHub App installation", undefined, {
      installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to unlink GitHub App installation", error));
  }
}

/**
 * Whether `principal` may use this installation's token: the installation is
 * linked to it (an agent through its owning user) and not suspended. Errors
 * are returned, and callers treat them as "no" — this gate fails closed.
 */
export async function isInstallationLinkedTo(
  db: D1Database,
  installationId: number,
  principal: GitHubPrincipal,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  const ownerClause =
    principal.type === "agent"
      ? "stratum_owner_type = 'user' AND stratum_owner_id = (SELECT owner_id FROM agents WHERE id = ?)"
      : "stratum_owner_type = ? AND stratum_owner_id = ?";
  const binds: unknown[] =
    principal.type === "agent"
      ? [installationId, principal.id]
      : [installationId, principal.type, principal.id];
  try {
    const row = await db
      .prepare(
        `SELECT 1 AS linked FROM github_app_installations
          WHERE installation_id = ? AND suspended_at IS NULL AND ${ownerClause}`,
      )
      .bind(...binds)
      .first<{ linked: number }>();
    return ok(row !== null);
  } catch (error) {
    logger.error("Failed to check GitHub App installation link", undefined, {
      installationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to check GitHub App installation link", error));
  }
}
