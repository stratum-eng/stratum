/**
 * A person's stored connection to GitHub (migration 086): the GitHub App
 * user-to-server token Stratum opens their promoted pull requests with.
 *
 * This is the one place a GitHub user token is kept at rest. Both tokens are
 * encrypted before they reach D1 and decrypted only by {@link readConnection};
 * nothing here logs a token, a ciphertext, or an error that could carry one.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { decryptToken, encryptToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** PBKDF2 salt for these rows, so the key is not shared with any other use of the secret. */
const CONNECTION_SALT = "stratum-github-user-connection-salt";

/** How long one refresh may take before another caller may try. */
export const REFRESH_LEASE_SECONDS = 30;

/** The tokens of one authorization, with expiries as epoch seconds. */
export interface ConnectionTokens {
  accessToken: string;
  /** Absent when the app issues tokens that do not expire. */
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
}

/** What may be shown about a connection: never a token. */
export interface ConnectionSummary {
  githubUserId: string;
  githubLogin: string;
  connectedAt: string;
}

/** A connection with its tokens decrypted, for the request that is about to use them. */
export interface StoredConnection extends ConnectionSummary, ConnectionTokens {}

interface ConnectionRow {
  github_user_id: string;
  github_login: string;
  access_token: string;
  refresh_token: string | null;
  access_expires_at: number | null;
  refresh_expires_at: number | null;
  created_at: string;
}

function storageError(message: string): AppError {
  return new AppError(message, "STORAGE_ERROR", 500);
}

/** A failure's message only: a D1 error names the statement, never a bound value. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function encryptTokens(
  tokens: ConnectionTokens,
  secret: string,
): Promise<{ access: string; refresh: string | null }> {
  return {
    access: await encryptToken(tokens.accessToken, secret, CONNECTION_SALT),
    refresh:
      tokens.refreshToken !== undefined
        ? await encryptToken(tokens.refreshToken, secret, CONNECTION_SALT)
        : null,
  };
}

/**
 * Stores a person's connection, replacing any they had.
 *
 * @param db - D1 database
 * @param secret - `GITHUB_USER_TOKEN_SECRET`
 * @param connection - Whose it is on both sides, and the tokens GitHub issued
 * @param logger - Request logger
 */
export async function saveConnection(
  db: D1Database,
  secret: string,
  connection: { userId: string; githubUserId: string; githubLogin: string } & ConnectionTokens,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    const encrypted = await encryptTokens(connection, secret);
    await db
      .prepare(
        `INSERT INTO github_user_connections
           (user_id, github_user_id, github_login, access_token, refresh_token,
            access_expires_at, refresh_expires_at, refresh_lease_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET
           github_user_id = excluded.github_user_id,
           github_login = excluded.github_login,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           access_expires_at = excluded.access_expires_at,
           refresh_expires_at = excluded.refresh_expires_at,
           refresh_lease_until = NULL,
           created_at = datetime('now'),
           updated_at = datetime('now')`,
      )
      .bind(
        connection.userId,
        connection.githubUserId,
        connection.githubLogin,
        encrypted.access,
        encrypted.refresh,
        connection.accessExpiresAt ?? null,
        connection.refreshExpiresAt ?? null,
      )
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to store a GitHub connection", undefined, {
      userId: connection.userId,
      error: reason(error),
    });
    return err(storageError("Failed to store the GitHub connection"));
  }
}

/**
 * Whether a person is connected, and as whom. Reads no token.
 *
 * @param db - D1 database
 * @param userId - The Stratum user
 * @param logger - Request logger
 * @returns The summary, or null when they are not connected
 */
export async function getConnectionSummary(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<ConnectionSummary | null, AppError>> {
  try {
    const row = await db
      .prepare(
        `SELECT github_user_id, github_login, created_at
         FROM github_user_connections WHERE user_id = ?`,
      )
      .bind(userId)
      .first<Pick<ConnectionRow, "github_user_id" | "github_login" | "created_at">>();
    if (!row) return ok(null);
    return ok({
      githubUserId: row.github_user_id,
      githubLogin: row.github_login,
      connectedAt: row.created_at,
    });
  } catch (error) {
    logger.error("Failed to read a GitHub connection", undefined, { userId, error: reason(error) });
    return err(storageError("Failed to read the GitHub connection"));
  }
}

/**
 * A person's connection with its tokens decrypted.
 *
 * A row that no longer decrypts (the secret was rotated) is reported as an
 * error, not as "not connected": the caller falls back to the app either way,
 * and the person is not told they disconnected when they did not.
 *
 * @param db - D1 database
 * @param secret - `GITHUB_USER_TOKEN_SECRET`
 * @param userId - The Stratum user
 * @param logger - Request logger
 * @returns The connection, or null when they are not connected
 */
export async function readConnection(
  db: D1Database,
  secret: string,
  userId: string,
  logger: Logger,
): Promise<Result<StoredConnection | null, AppError>> {
  try {
    const row = await db
      .prepare(
        `SELECT github_user_id, github_login, access_token, refresh_token,
                access_expires_at, refresh_expires_at, created_at
         FROM github_user_connections WHERE user_id = ?`,
      )
      .bind(userId)
      .first<ConnectionRow>();
    if (!row) return ok(null);
    const accessToken = await decryptToken(row.access_token, secret, CONNECTION_SALT);
    const refreshToken =
      row.refresh_token !== null
        ? await decryptToken(row.refresh_token, secret, CONNECTION_SALT)
        : undefined;
    if (accessToken === null || refreshToken === null) {
      logger.error("A stored GitHub connection does not decrypt", undefined, { userId });
      return err(storageError("The stored GitHub connection could not be read"));
    }
    return ok({
      githubUserId: row.github_user_id,
      githubLogin: row.github_login,
      connectedAt: row.created_at,
      accessToken,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(row.access_expires_at !== null ? { accessExpiresAt: row.access_expires_at } : {}),
      ...(row.refresh_expires_at !== null ? { refreshExpiresAt: row.refresh_expires_at } : {}),
    });
  } catch (error) {
    logger.error("Failed to read a GitHub connection", undefined, { userId, error: reason(error) });
    return err(storageError("Failed to read the GitHub connection"));
  }
}

/**
 * Takes the right to refresh a person's token, for {@link REFRESH_LEASE_SECONDS}.
 *
 * @param db - D1 database
 * @param userId - The Stratum user
 * @param nowSeconds - The current time, epoch seconds
 * @param logger - Request logger
 * @returns True for the one caller that may spend the refresh token
 */
export async function claimRefresh(
  db: D1Database,
  userId: string,
  nowSeconds: number,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const claimed = await db
      .prepare(
        `UPDATE github_user_connections SET refresh_lease_until = ?
         WHERE user_id = ? AND (refresh_lease_until IS NULL OR refresh_lease_until <= ?)`,
      )
      .bind(nowSeconds + REFRESH_LEASE_SECONDS, userId, nowSeconds)
      .run();
    return ok((claimed.meta.changes ?? 0) > 0);
  } catch (error) {
    logger.error("Failed to claim a GitHub token refresh", undefined, {
      userId,
      error: reason(error),
    });
    return err(storageError("Failed to claim the GitHub token refresh"));
  }
}

/**
 * Stores the tokens a refresh returned and gives the lease back.
 *
 * @param db - D1 database
 * @param secret - `GITHUB_USER_TOKEN_SECRET`
 * @param userId - The Stratum user
 * @param tokens - The new pair; the old one no longer works
 * @param logger - Request logger
 */
export async function storeRefreshedTokens(
  db: D1Database,
  secret: string,
  userId: string,
  tokens: ConnectionTokens,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    const encrypted = await encryptTokens(tokens, secret);
    await db
      .prepare(
        `UPDATE github_user_connections SET
           access_token = ?, refresh_token = ?, access_expires_at = ?,
           refresh_expires_at = ?, refresh_lease_until = NULL, updated_at = datetime('now')
         WHERE user_id = ?`,
      )
      .bind(
        encrypted.access,
        encrypted.refresh,
        tokens.accessExpiresAt ?? null,
        tokens.refreshExpiresAt ?? null,
        userId,
      )
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to store refreshed GitHub tokens", undefined, {
      userId,
      error: reason(error),
    });
    return err(storageError("Failed to store the refreshed GitHub tokens"));
  }
}

/**
 * Gives a refresh lease back without new tokens, after a refresh that did not
 * reach GitHub. Best effort: a lease left behind expires by itself.
 *
 * @param db - D1 database
 * @param userId - The Stratum user
 * @param logger - Request logger
 */
export async function releaseRefresh(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<void> {
  try {
    await db
      .prepare("UPDATE github_user_connections SET refresh_lease_until = NULL WHERE user_id = ?")
      .bind(userId)
      .run();
  } catch (error) {
    logger.warn("Could not release a GitHub token refresh lease", { userId, error: reason(error) });
  }
}

/**
 * Removes a person's connection.
 *
 * @param db - D1 database
 * @param userId - The Stratum user
 * @param logger - Request logger
 * @returns True when there was one to remove
 */
export async function deleteConnection(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const removed = await db
      .prepare("DELETE FROM github_user_connections WHERE user_id = ?")
      .bind(userId)
      .run();
    return ok((removed.meta.changes ?? 0) > 0);
  } catch (error) {
    logger.error("Failed to remove a GitHub connection", undefined, {
      userId,
      error: reason(error),
    });
    return err(storageError("Failed to remove the GitHub connection"));
  }
}

/**
 * Removes every connection made by one GitHub account, when GitHub reports that
 * the account revoked its authorization of the app.
 *
 * @param db - D1 database
 * @param githubUserId - The GitHub user id, as a string
 * @param logger - Request logger
 * @returns How many were removed
 */
export async function deleteConnectionsForGitHubUser(
  db: D1Database,
  githubUserId: string,
  logger: Logger,
): Promise<Result<number, AppError>> {
  try {
    const removed = await db
      .prepare("DELETE FROM github_user_connections WHERE github_user_id = ?")
      .bind(githubUserId)
      .run();
    return ok(removed.meta.changes ?? 0);
  } catch (error) {
    logger.error("Failed to remove GitHub connections for a GitHub account", undefined, {
      error: reason(error),
    });
    return err(storageError("Failed to remove the GitHub connections"));
  }
}
