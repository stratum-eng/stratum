import { hashToken } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { parseSecondFactor, parseUnmetOrgs, unmetPolicyOrgsSql } from "./credential-factors";

// Sessions are stored HASHED at rest: the `id` column holds hashToken(rawId), and
// the raw id is only ever held by the client cookie. A read-only leak of the
// sessions table (SQLi read, a backup, logs) therefore yields no replayable
// credential — matching how user/agent/magic-link tokens are stored.

/** How a session passed a second factor (#256). */
export type SessionSecondFactor = "passkey" | "recovery_code";

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  /** When the session was minted — i.e. when the user last authenticated. */
  createdAt?: string;
  /** Set when the session passed a second factor at sign-in (or was upgraded
   * by registering the account's first passkey). */
  secondFactor?: SessionSecondFactor;
  /** The org whose IdP authenticated this session (OIDC SSO sign-in). */
  ssoOrgId?: string;
  /**
   * Orgs the user belongs to that require a second factor this session does
   * NOT satisfy — computed by `getSession` in the same query, so the policy
   * costs no extra round-trip. Empty when the session is compliant.
   *
   * This is NOT a gate on the session: an org's policy binds only that org's
   * own resources (see `src/utils/authz.ts`). Membership is granted by the org
   * without the user's consent, so a session-wide gate would let any org lock
   * any user out of everything they own.
   */
  unmetSecondFactorOrgs?: UnmetSecondFactorOrg[];
}

export interface UnmetSecondFactorOrg {
  id: string;
  slug: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at?: string | null;
  second_factor?: string | null;
  sso_org_id?: string | null;
  unmet_policy_orgs?: string | null;
}

function rowToSession(row: SessionRow): Session {
  const secondFactor = parseSecondFactor(row.second_factor);
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    ...(row.created_at ? { createdAt: row.created_at } : {}),
    ...(secondFactor !== undefined ? { secondFactor } : {}),
    ...(row.sso_org_id ? { ssoOrgId: row.sso_org_id } : {}),
    ...(row.unmet_policy_orgs
      ? { unmetSecondFactorOrgs: parseUnmetOrgs(row.unmet_policy_orgs) }
      : {}),
  };
}

/** What a new session records about how it was authenticated (#256). */
export interface SessionFactors {
  secondFactor?: SessionSecondFactor;
  ssoOrgId?: string;
}

/**
 * `sessions.created_at` defaults to `datetime('now')` ("YYYY-MM-DD HH:MM:SS",
 * UTC with no zone marker); parse either that or an ISO string as UTC.
 */
export function sessionCreatedAtMs(createdAt: string | undefined): number | null {
  if (!createdAt) return null;
  const iso = createdAt.includes("T") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Start a session for a user, recording how they authenticated. Returns the
 * raw id for the cookie; only its hash is stored.
 */
export async function createSession(
  db: D1Database,
  userId: string,
  logger: Logger,
  rememberMe = true,
  factors: SessionFactors = {},
): Promise<Result<Session, AppError>> {
  logger.debug("Creating session", { userId, rememberMe });
  try {
    const id = newId("sess");
    // 30 days for remember me, 1 day otherwise
    const expirationDays = rememberMe ? 30 : 1;
    const expiresAt = new Date(Date.now() + expirationDays * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare(
        "INSERT INTO sessions (id, user_id, expires_at, second_factor, sso_org_id) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        await hashToken(id),
        userId,
        expiresAt,
        factors.secondFactor ?? null,
        factors.ssoOrgId ?? null,
      )
      .run();

    logger.info("Session created", { userId, rememberMe, secondFactor: factors.secondFactor });
    // Return the RAW id — it becomes the cookie; only its hash is persisted.
    return ok({
      id,
      userId,
      expiresAt,
      ...(factors.secondFactor !== undefined ? { secondFactor: factors.secondFactor } : {}),
      ...(factors.ssoOrgId !== undefined ? { ssoOrgId: factors.ssoOrgId } : {}),
    });
  } catch (error) {
    logger.error("Failed to create session", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(
      new AppError(`Failed to create session for user '${userId}'`, "STORAGE_ERROR", 500, {
        userId,
      }),
    );
  }
}

/**
 * Load a session by its raw id, with the orgs whose second-factor policy it
 * does not satisfy. Expiry is the caller's to check.
 */
export async function getSession(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<Session, NotFoundError | AppError>> {
  logger.debug("Fetching session");
  try {
    // The org-policy column (#256) rides on this lookup so the per-request
    // org-resource check costs no extra round-trip. It is only evaluated for a
    // session without a second factor: a passkey-verified session satisfies
    // every org, and an SSO session satisfies the org whose IdP issued it.
    // The rule itself is `unmetPolicyOrgsSql`, shared with every credential
    // lookup (#441).
    const row = await db
      .prepare(
        `SELECT s.id, s.user_id, s.expires_at, s.created_at, s.second_factor, s.sso_org_id,
                ${unmetPolicyOrgsSql({
                  userId: "s.user_id",
                  secondFactor: "s.second_factor",
                  ssoOrgId: "s.sso_org_id",
                })} AS unmet_policy_orgs
         FROM sessions s WHERE s.id = ?`,
      )
      .bind(await hashToken(id))
      .first<SessionRow>();

    // A missing row is expected (invalid/expired cookie); return NotFound without
    // the raw id so an unauthenticated bearer value never lands in a log.
    if (!row) {
      return err(new NotFoundError("Session", "(hashed)"));
    }

    // Return the caller's raw id (the row's id is the hash) so downstream refresh/
    // isCurrent comparisons against the cookie keep working.
    return ok({ ...rowToSession(row), id });
  } catch (error) {
    // hashToken or the D1 read can reject; surface it as a Result so callers never
    // get a thrown error instead of Result<Session, …>.
    logger.error("Failed to fetch session", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to fetch session", "STORAGE_ERROR", 500));
  }
}

export async function deleteSession(
  db: D1Database,
  id: string,
  userId: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  logger.debug("Deleting session", { userId });
  try {
    const result = await db
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .bind(await hashToken(id), userId)
      .run();

    const deleted = (result.meta?.changes ?? 0) > 0;

    // Never log the raw id — it is the bearer cookie; userId is enough to trace.
    if (deleted) {
      logger.info("Session deleted", { userId });
    } else {
      logger.warn("Session not found or not owned by user", { userId });
    }

    return ok(deleted);
  } catch (error) {
    logger.error("Failed to delete session", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(new AppError("Failed to delete session", "STORAGE_ERROR", 500, { userId }));
  }
}

/**
 * Record that an existing session has now passed a second factor — used when a
 * user registers their FIRST passkey from a session that predates it: they just
 * proved possession of the authenticator, so the session counts as verified.
 */
export async function markSessionSecondFactor(
  db: D1Database,
  id: string,
  secondFactor: SessionSecondFactor,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare("UPDATE sessions SET second_factor = ? WHERE id = ?")
      .bind(secondFactor, await hashToken(id))
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    logger.error(
      "Failed to mark session second factor",
      error instanceof Error ? error : undefined,
    );
    return err(new AppError("Failed to update session", "STORAGE_ERROR", 500));
  }
}

/**
 * Revoke a session by its STORED id (the hash surfaced by getUserSessions), NOT a
 * raw cookie value — so it must not be re-hashed. Used by the "log out of this
 * device" list UI, where the client only ever sees the opaque hashed handle.
 */
export async function deleteSessionByStoredId(
  db: D1Database,
  storedId: string,
  userId: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?")
      .bind(storedId, userId)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    logger.error(
      "Failed to delete session by stored id",
      error instanceof Error ? error : undefined,
      {
        userId,
      },
    );
    return err(new AppError("Failed to delete session", "STORAGE_ERROR", 500, { userId }));
  }
}

/**
 * Refresh a session by extending its expiration time.
 * Only extends if the session is still valid.
 */
export async function refreshSession(
  db: D1Database,
  id: string,
  rememberMe: boolean,
  logger: Logger,
): Promise<Result<Session, AppError | NotFoundError>> {
  // Never log the raw id (the bearer cookie).
  logger.debug("Refreshing session", { rememberMe });

  // First check if session exists and is valid
  const sessionResult = await getSession(db, id, logger);
  if (!sessionResult.success) {
    return err(sessionResult.error);
  }

  const session = sessionResult.data;
  const now = new Date();
  const expiresAt = new Date(session.expiresAt);

  // Don't refresh expired sessions
  if (expiresAt < now) {
    logger.warn("Attempted to refresh expired session", { userId: session.userId });
    return err(
      new AppError("Session has expired", "SESSION_EXPIRED", 401, { userId: session.userId }),
    );
  }

  try {
    // Calculate new expiration based on remember me preference
    const extensionDays = rememberMe ? 30 : 1;
    const newExpiresAt = new Date(Date.now() + extensionDays * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind(newExpiresAt, await hashToken(id))
      .run();

    logger.info("Session refreshed", { newExpiresAt, rememberMe });
    return ok({ ...session, expiresAt: newExpiresAt });
  } catch (error) {
    logger.error("Failed to refresh session", error instanceof Error ? error : undefined, {
      userId: session.userId,
    });
    return err(
      new AppError("Failed to refresh session", "STORAGE_ERROR", 500, { userId: session.userId }),
    );
  }
}

/**
 * Delete all sessions for a user (logout from all devices)
 */
export async function deleteAllUserSessions(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<number, AppError>> {
  logger.debug("Deleting all sessions for user", { userId });
  try {
    const result = await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    const deletedCount = result.meta?.changes ?? 0;
    logger.info("All user sessions deleted", { userId, deletedCount });
    return ok(deletedCount);
  } catch (error) {
    logger.error("Failed to delete user sessions", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(
      new AppError(`Failed to delete sessions for user '${userId}'`, "STORAGE_ERROR", 500, {
        userId,
      }),
    );
  }
}

/**
 * Get all active sessions for a user
 */
export async function getUserSessions(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<Session[], AppError>> {
  logger.debug("Fetching sessions for user", { userId });
  try {
    const { results } = await db
      .prepare(
        "SELECT id, user_id, expires_at FROM sessions WHERE user_id = ? ORDER BY expires_at DESC",
      )
      .bind(userId)
      .all<SessionRow>();

    const sessions = (results ?? []).map(rowToSession);
    logger.debug("Sessions fetched", { userId, count: sessions.length });
    return ok(sessions);
  } catch (error) {
    logger.error("Failed to fetch user sessions", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(
      new AppError(`Failed to fetch sessions for user '${userId}'`, "STORAGE_ERROR", 500, {
        userId,
      }),
    );
  }
}
