/**
 * The short-lived state behind linking a GitHub App installation on the
 * strength of current GitHub access (#442, migration 082): the CSRF `state` of
 * one OAuth round trip, and the display-only list of installations GitHub said
 * a session's user could link.
 *
 * Nothing here ever sees a GitHub token. Sessions are identified by the same
 * SHA-256 hash `sessions.id` holds, never by the cookie value.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { constantTimeEqual, hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** How long a person has to come back from GitHub. */
export const LINK_STATE_TTL_SECONDS = 600;

/** How long the setup page keeps offering what GitHub last said was linkable. */
export const ACCESS_SNAPSHOT_TTL_SECONDS = 600;

/**
 * Rows per snapshot. Far above how many accounts one person installs an app
 * on, and it keeps the multi-row INSERT under D1's 100-bound-parameter cap.
 */
export const ACCESS_SNAPSHOT_MAX_INSTALLATIONS = 30;

/** What a person asked for before being sent to GitHub. */
export interface LinkIntent {
  userId: string;
  /** Absent: the round trip only refreshes the list of linkable installations. */
  installationId?: number;
  /** Absent: link to the person's own account. */
  targetOrgId?: string;
}

interface LinkStateRow {
  session_hash: string;
  user_id: string;
  installation_id: number | null;
  target_org_id: string | null;
  expires_at: number;
}

/** The error callers pass on when a statement fails. */
function storageError(message: string): AppError {
  return new AppError(message, "STORAGE_ERROR", 500);
}

/** The current time in whole seconds, the unit the expiry columns use. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** A fresh, unguessable `state` value for one round trip to GitHub. */
function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Records an intent and returns the `state` to send to GitHub with it.
 *
 * @param db - D1 database
 * @param sessionHash - SHA-256 of the session cookie that is starting the round trip
 * @param intent - Who is asking, and for what
 * @param logger - Request logger
 * @returns The raw state; only its hash is stored
 */
export async function issueLinkState(
  db: D1Database,
  sessionHash: string,
  intent: LinkIntent,
  logger: Logger,
): Promise<Result<string, AppError>> {
  try {
    const state = randomState();
    await db
      .prepare(
        `INSERT INTO github_app_link_states
           (state_hash, session_hash, user_id, installation_id, target_org_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await hashToken(state),
        sessionHash,
        intent.userId,
        intent.installationId ?? null,
        intent.targetOrgId ?? null,
        nowSeconds() + LINK_STATE_TTL_SECONDS,
      )
      .run();
    return ok(state);
  } catch (error) {
    logger.error("Failed to record GitHub App link state", undefined, {
      userId: intent.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to record GitHub App link state"));
  }
}

/**
 * Redeems a `state`, at most once, for the session and user it was issued to.
 *
 * The row is deleted by the same statement that reads it, so of two concurrent
 * callbacks exactly one gets the intent. It is deleted whoever presents it: a
 * state that turns up on another session, for another user, or after expiry is
 * burned rather than left for a second try.
 *
 * @param db - D1 database
 * @param state - The `state` query parameter, as received
 * @param sessionHash - SHA-256 of the session cookie on the callback request
 * @param userId - The user that session belongs to
 * @param logger - Request logger
 * @returns The intent, or null when the state is unknown, spent, expired, or someone else's
 */
export async function consumeLinkState(
  db: D1Database,
  state: string,
  sessionHash: string,
  userId: string,
  logger: Logger,
): Promise<Result<LinkIntent | null, AppError>> {
  try {
    const row = await db
      .prepare(
        `DELETE FROM github_app_link_states WHERE state_hash = ?
         RETURNING session_hash, user_id, installation_id, target_org_id, expires_at`,
      )
      .bind(await hashToken(state))
      .first<LinkStateRow>();
    if (!row) return ok(null);
    if (row.expires_at <= nowSeconds()) return ok(null);
    if (!constantTimeEqual(row.session_hash, sessionHash) || row.user_id !== userId) {
      // Worth a line: the ordinary causes (signed out and back in mid-flow) are
      // rare, and the other cause is someone replaying a state they obtained.
      logger.warn("GitHub App link state presented on a different session; burned", { userId });
      return ok(null);
    }
    return ok({
      userId: row.user_id,
      ...(row.installation_id !== null ? { installationId: row.installation_id } : {}),
      ...(row.target_org_id !== null ? { targetOrgId: row.target_org_id } : {}),
    });
  } catch (error) {
    logger.error("Failed to redeem GitHub App link state", undefined, {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to redeem GitHub App link state"));
  }
}

/**
 * Replaces a session's list of installations GitHub said it could link.
 *
 * @param db - D1 database
 * @param sessionHash - SHA-256 of the session cookie
 * @param installationIds - Installation ids verified linkable just now
 * @param logger - Request logger
 * @returns Nothing; an error leaves the previous list in place or empty
 */
export async function replaceAccessSnapshot(
  db: D1Database,
  sessionHash: string,
  installationIds: readonly number[],
  logger: Logger,
): Promise<Result<void, AppError>> {
  const ids = [...new Set(installationIds)].slice(0, ACCESS_SNAPSHOT_MAX_INSTALLATIONS);
  const expiresAt = nowSeconds() + ACCESS_SNAPSHOT_TTL_SECONDS;
  try {
    const statements = [
      db
        .prepare("DELETE FROM github_app_access_snapshots WHERE session_hash = ?")
        .bind(sessionHash),
    ];
    if (ids.length > 0) {
      statements.push(
        db
          .prepare(
            `INSERT INTO github_app_access_snapshots (session_hash, installation_id, expires_at)
             VALUES ${ids.map(() => "(?, ?, ?)").join(", ")}`,
          )
          .bind(...ids.flatMap((id) => [sessionHash, id, expiresAt])),
      );
    }
    await db.batch(statements);
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to store GitHub App access snapshot", undefined, {
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to store GitHub App access snapshot"));
  }
}

/**
 * Deletes expired link states and access snapshots. Housekeeping only: both
 * are ignored once expired whether or not this has run.
 *
 * @param db - D1 database
 * @param logger - Job logger
 * @returns How many rows were removed
 */
export async function purgeExpiredLinkStates(
  db: D1Database,
  logger: Logger,
): Promise<Result<number, AppError>> {
  try {
    const now = nowSeconds();
    const [states, snapshots] = await db.batch([
      db.prepare("DELETE FROM github_app_link_states WHERE expires_at < ?").bind(now),
      db.prepare("DELETE FROM github_app_access_snapshots WHERE expires_at < ?").bind(now),
    ]);
    const purged = (states?.meta?.changes ?? 0) + (snapshots?.meta?.changes ?? 0);
    if (purged > 0) logger.debug("Purged expired GitHub App link states", { purged });
    return ok(purged);
  } catch (error) {
    logger.error("Failed to purge GitHub App link states", undefined, {
      error: error instanceof Error ? error.message : String(error),
    });
    return err(storageError("Failed to purge GitHub App link states"));
  }
}
