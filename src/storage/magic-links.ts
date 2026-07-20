import { hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** The data carried by a magic link, opaque to this module. */
export interface MagicLinkPayload {
  email: string;
  intent: "signup" | "login";
  rememberMe?: boolean;
  username?: string;
  inviteCode?: string;
  createdAt?: number;
}

/**
 * Persist a magic-link token (hashed) with its payload and absolute expiry.
 * Stored in D1 so consumption can be made atomic (see consumeMagicLink).
 */
export async function createMagicLink(
  db: D1Database,
  token: string,
  payload: MagicLinkPayload,
  ttlSeconds: number,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    const tokenHash = await hashToken(token);
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    await db
      .prepare(
        "INSERT OR REPLACE INTO magic_links (token_hash, payload, expires_at, consumed) VALUES (?, ?, ?, 0)",
      )
      .bind(tokenHash, JSON.stringify(payload), expiresAt)
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to store magic link", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to store magic link", "DATABASE_ERROR", 500));
  }
}

/**
 * Atomically consume a magic-link token: it succeeds for exactly ONE caller even
 * under concurrent verifies, because the guard is a single conditional UPDATE
 * (`consumed = 0 AND not expired`) whose affected-row count is the winner signal.
 * Returns the payload on the winning consume, or null if the token is unknown,
 * already consumed, or expired.
 */
export async function consumeMagicLink(
  db: D1Database,
  token: string,
  logger: Logger,
): Promise<Result<MagicLinkPayload | null, AppError>> {
  try {
    const tokenHash = await hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    const update = await db
      .prepare(
        "UPDATE magic_links SET consumed = 1 WHERE token_hash = ? AND consumed = 0 AND expires_at > ?",
      )
      .bind(tokenHash, now)
      .run();

    // meta.changes === 1 means THIS call won the single-use race. A concurrent
    // verify sees 0 (row already consumed) and gets null.
    if (update.meta.changes !== 1) return ok(null);

    const row = await db
      .prepare("SELECT payload FROM magic_links WHERE token_hash = ?")
      .bind(tokenHash)
      .first<{ payload: string }>();
    if (!row) return ok(null);

    return ok(JSON.parse(row.payload) as MagicLinkPayload);
  } catch (error) {
    logger.error("Failed to consume magic link", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to consume magic link", "DATABASE_ERROR", 500));
  }
}
