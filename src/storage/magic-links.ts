import { hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** The data carried by a magic link, opaque to this module. */
export interface MagicLinkPayload {
  email: string;
  /**
   * `agent-signup` is a signup an agent requested on the human's behalf
   * (POST /api/agent-signup); approving it also releases an agent token to the
   * agent that asked, via `agentSignupId`.
   */
  intent: "signup" | "login" | "agent-signup";
  rememberMe?: boolean;
  username?: string;
  inviteCode?: string;
  createdAt?: number;
  /**
   * The person ticked the telemetry consent box on the signup form (#257).
   * Carried on the link because the account is created at verify, a request
   * that has no form of its own. Absent means no consent was given.
   */
  telemetryConsent?: boolean;
  /** The `agent_signups` row this link approves; set only for `agent-signup`. */
  agentSignupId?: string;
  /**
   * The OAuth authorization request to return to after verifying (#410). Bound
   * here, server-side, rather than carried in the link's URL, so the email
   * cannot be edited to send someone anywhere else; re-validated at verify.
   */
  returnTo?: string;
  /** SHA-256 of the nonce cookie set on the browser that requested the link. */
  returnBinding?: string;
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

/**
 * Read a magic link's payload WITHOUT consuming it, whatever its state. Only
 * for auditing a failed verify (#255): an already-used or expired link that
 * still exists names the account someone tried to sign in to, which an
 * unknown token does not. Never used to authenticate — `consumeMagicLink` is
 * the only gate. Returns null for an unknown token or a lookup failure.
 */
export async function inspectMagicLink(
  db: D1Database,
  token: string,
  logger: Logger,
): Promise<{ payload: MagicLinkPayload; consumed: boolean } | null> {
  try {
    const row = await db
      .prepare("SELECT payload, consumed FROM magic_links WHERE token_hash = ?")
      .bind(await hashToken(token))
      .first<{ payload: string; consumed: number }>();
    if (!row) return null;
    return { payload: JSON.parse(row.payload) as MagicLinkPayload, consumed: row.consumed === 1 };
  } catch (error) {
    logger.warn("Failed to inspect magic link for audit", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Reads a magic link's payload WITHOUT consuming it, for checks that must pass
 * before the single use is spent (an agent-signup approval checks the user
 * code first, so a typo does not burn the link). Never a substitute for
 * consumeMagicLink: a peek grants nothing.
 *
 * @param db - D1 database
 * @param token - The magic-link token
 * @param logger - Request logger
 * @returns The payload of a live, unconsumed link, or null
 */
export async function peekMagicLink(
  db: D1Database,
  token: string,
  logger: Logger,
): Promise<Result<MagicLinkPayload | null, AppError>> {
  try {
    const tokenHash = await hashToken(token);
    const now = Math.floor(Date.now() / 1000);
    const row = await db
      .prepare(
        "SELECT payload FROM magic_links WHERE token_hash = ? AND consumed = 0 AND expires_at > ?",
      )
      .bind(tokenHash, now)
      .first<{ payload: string }>();
    return ok(row ? (JSON.parse(row.payload) as MagicLinkPayload) : null);
  } catch (error) {
    logger.error("Failed to read magic link", error instanceof Error ? error : undefined);
    return err(new AppError("Failed to read magic link", "DATABASE_ERROR", 500));
  }
}
