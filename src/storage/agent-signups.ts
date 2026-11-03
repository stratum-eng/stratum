import { constantTimeEqual, hashToken } from "../utils/crypto";
import { AppError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * How long a request waits for the human, and how long an approved request
 * waits for the agent to collect its token. The emailed link itself lives 15
 * minutes (the magic-link TTL); the extra margin lets an agent that polls on a
 * slow interval still collect after a late click.
 */
export const AGENT_SIGNUP_TTL_SECONDS = 30 * 60;

/** Wrong user-code entries allowed before a request is dead. */
export const MAX_USER_CODE_ATTEMPTS = 5;

/**
 * Alphabet for the user code: no vowels (no accidental words), and none of the
 * characters people confuse when copying by eye (0/O, 1/I/L, 5/S, 2/Z, 8/B).
 * Twenty symbols over 8 positions is ~34 bits; with five attempts per request
 * and a 30-minute life, guessing is not a practical route.
 */
const USER_CODE_ALPHABET = "CDFGHJKMNPQRTVWXY349";
const USER_CODE_LENGTH = 8;

/**
 * Generates a user code, formatted `XXXX-XXXX` for reading aloud or copying.
 *
 * @returns A fresh code
 */
export function generateUserCode(): string {
  const bytes = new Uint8Array(USER_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  // 256 is not a multiple of 20, so reject the top of the range to keep every
  // symbol equally likely rather than skewing toward the first few.
  const limit = 256 - (256 % USER_CODE_ALPHABET.length);
  let code = "";
  let i = 0;
  while (code.length < USER_CODE_LENGTH) {
    if (i >= bytes.length) {
      crypto.getRandomValues(bytes);
      i = 0;
    }
    const byte = bytes[i++] ?? 0;
    if (byte < limit) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Canonical form for comparison: what the human types may have lowercase,
 * spaces, or no dash.
 *
 * @param input - The code as entered
 * @returns Uppercase symbols only
 */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type AgentSignupStatus = "pending" | "approved" | "collected";

export interface AgentSignup {
  id: string;
  email: string;
  username: string;
  agentName: string;
  agentModel?: string;
  status: AgentSignupStatus;
  userId?: string;
  agentId?: string;
  /** Wrong user-code entries so far; at {@link MAX_USER_CODE_ATTEMPTS} the request is dead. */
  codeAttempts: number;
  createdAt: number;
  expiresAt: number;
}

interface AgentSignupRow {
  id: string;
  email: string;
  username: string;
  agent_name: string;
  agent_model: string | null;
  status: AgentSignupStatus;
  user_id: string | null;
  agent_id: string | null;
  code_attempts: number;
  created_at: number;
  expires_at: number;
}

function fromRow(row: AgentSignupRow): AgentSignup {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    agentName: row.agent_name,
    ...(row.agent_model !== null ? { agentModel: row.agent_model } : {}),
    status: row.status,
    ...(row.user_id !== null ? { userId: row.user_id } : {}),
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    codeAttempts: row.code_attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function storageError(message: string, error: unknown, logger: Logger): AppError {
  logger.error(message, error instanceof Error ? error : undefined);
  return new AppError(message, "DATABASE_ERROR", 500);
}

/**
 * Records a pending agent signup. Only hashes of the poll secret and the user
 * code are stored, so a database read yields neither.
 *
 * @param db - D1 database
 * @param input - The requested account and the agent asking for it
 * @param secrets - The agent's poll secret and the user code (plaintext; hashed here)
 * @param logger - Request logger
 * @returns The stored request
 */
export async function createAgentSignup(
  db: D1Database,
  input: { email: string; username: string; agentName: string; agentModel?: string },
  secrets: { pollToken: string; userCode: string },
  logger: Logger,
): Promise<Result<AgentSignup, AppError>> {
  const id = newId("asu");
  const createdAt = nowSeconds();
  const expiresAt = createdAt + AGENT_SIGNUP_TTL_SECONDS;
  try {
    const pollTokenHash = await hashToken(secrets.pollToken);
    const userCodeHash = await hashToken(normalizeUserCode(secrets.userCode));
    await db
      .prepare(
        `INSERT INTO agent_signups
           (id, poll_token_hash, user_code_hash, email, username, agent_name, agent_model, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        id,
        pollTokenHash,
        userCodeHash,
        input.email,
        input.username,
        input.agentName,
        input.agentModel ?? null,
        createdAt,
        expiresAt,
      )
      .run();
    return ok({
      id,
      email: input.email,
      username: input.username,
      agentName: input.agentName,
      ...(input.agentModel !== undefined ? { agentModel: input.agentModel } : {}),
      status: "pending",
      codeAttempts: 0,
      createdAt,
      expiresAt,
    });
  } catch (error) {
    return err(storageError("Failed to store agent signup", error, logger));
  }
}

/**
 * Reads a signup by id.
 *
 * @param db - D1 database
 * @param id - Signup id
 * @param logger - Request logger
 * @returns The request, or null when there is no such row
 */
export async function getAgentSignup(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<AgentSignup | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM agent_signups WHERE id = ?")
      .bind(id)
      .first<AgentSignupRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to read agent signup", error, logger));
  }
}

/**
 * Reads a signup by the agent's poll secret.
 *
 * @param db - D1 database
 * @param pollToken - The poll secret the agent was handed
 * @param logger - Request logger
 * @returns The request, or null when the secret matches nothing
 */
export async function getAgentSignupByPollToken(
  db: D1Database,
  pollToken: string,
  logger: Logger,
): Promise<Result<AgentSignup | null, AppError>> {
  try {
    const pollTokenHash = await hashToken(pollToken);
    const row = await db
      .prepare("SELECT * FROM agent_signups WHERE poll_token_hash = ?")
      .bind(pollTokenHash)
      .first<AgentSignupRow>();
    return ok(row ? fromRow(row) : null);
  } catch (error) {
    return err(storageError("Failed to read agent signup", error, logger));
  }
}

/**
 * Marks a pending, unexpired signup approved for the account the human just
 * created. Conditional, so a request that expired or was already approved is
 * left alone.
 *
 * @param db - D1 database
 * @param id - Signup id
 * @param userId - The account created at approval
 * @param logger - Request logger
 * @returns Whether this call made the transition
 */
export async function approveAgentSignup(
  db: D1Database,
  id: string,
  userId: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const now = nowSeconds();
    const result = await db
      .prepare(
        `UPDATE agent_signups SET status = 'approved', user_id = ?, approved_at = ?
         WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .bind(userId, now, id, now)
      .run();
    return ok(result.meta.changes === 1);
  } catch (error) {
    return err(storageError("Failed to approve agent signup", error, logger));
  }
}

/**
 * Claims an approved signup for collection. Exactly one caller wins, because
 * the guard is a single conditional UPDATE whose change count is the signal,
 * so two concurrent polls can never both mint an agent token.
 *
 * @param db - D1 database
 * @param id - Signup id
 * @param logger - Request logger
 * @returns Whether this call won the claim
 */
export async function claimAgentSignupForCollection(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  try {
    const now = nowSeconds();
    const result = await db
      .prepare(
        `UPDATE agent_signups SET status = 'collected', collected_at = ?
         WHERE id = ? AND status = 'approved' AND expires_at > ?`,
      )
      .bind(now, id, now)
      .run();
    return ok(result.meta.changes === 1);
  } catch (error) {
    return err(storageError("Failed to claim agent signup", error, logger));
  }
}

/**
 * Records which agent a collected signup produced, for the audit trail and so
 * the row can be traced from the agent.
 *
 * @param db - D1 database
 * @param id - Signup id
 * @param agentId - The agent minted at collection
 * @param logger - Request logger
 * @returns Nothing on success
 */
export async function recordAgentSignupAgent(
  db: D1Database,
  id: string,
  agentId: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db.prepare("UPDATE agent_signups SET agent_id = ? WHERE id = ?").bind(agentId, id).run();
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to record agent signup agent", error, logger));
  }
}

/**
 * Returns a claimed signup to `approved` after minting its agent failed, so
 * the agent's next poll can try again instead of finding a request marked
 * collected with nothing to show for it.
 *
 * @param db - D1 database
 * @param id - Signup id
 * @param logger - Request logger
 * @returns Nothing on success
 */
export async function approveAgentSignupRelease(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    await db
      .prepare(
        "UPDATE agent_signups SET status = 'approved', collected_at = NULL WHERE id = ? AND status = 'collected' AND agent_id IS NULL",
      )
      .bind(id)
      .run();
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to release agent signup claim", error, logger));
  }
}

export type UserCodeCheck = "match" | "mismatch" | "locked";

/**
 * Checks the code the human typed on the approval page against the request.
 *
 * The attempt is counted BEFORE the comparison, with a conditional UPDATE, so
 * concurrent guesses cannot each read "attempts < 5" and all get a try. Once
 * the cap is reached the request is dead: the agent must start over, and the
 * human is told the link expired.
 *
 * @param db - D1 database
 * @param id - Signup id
 * @param input - The code as typed
 * @param logger - Request logger
 * @returns Whether it matched, missed, or the request is out of attempts
 */
export async function checkAgentSignupUserCode(
  db: D1Database,
  id: string,
  input: string,
  logger: Logger,
): Promise<Result<UserCodeCheck, AppError>> {
  try {
    const counted = await db
      .prepare(
        "UPDATE agent_signups SET code_attempts = code_attempts + 1 WHERE id = ? AND code_attempts < ?",
      )
      .bind(id, MAX_USER_CODE_ATTEMPTS)
      .run();
    if (counted.meta.changes !== 1) return ok("locked");
    const row = await db
      .prepare("SELECT user_code_hash FROM agent_signups WHERE id = ?")
      .bind(id)
      .first<{ user_code_hash: string }>();
    if (!row) return ok("locked");
    const candidate = await hashToken(normalizeUserCode(input));
    return ok(constantTimeEqual(candidate, row.user_code_hash) ? "match" : "mismatch");
  } catch (error) {
    return err(storageError("Failed to check agent signup code", error, logger));
  }
}

/**
 * How long a request is kept after it expires before the daily purge deletes
 * it. Long enough to look into a failed signup the same day; short enough that
 * an address someone typed into an unauthenticated endpoint is not retained.
 */
export const AGENT_SIGNUP_RETENTION_SECONDS = 24 * 60 * 60;

/**
 * Deletes requests that expired more than {@link AGENT_SIGNUP_RETENTION_SECONDS}
 * ago, whatever their status. Each row names an email address, and an
 * unapproved one names an address that never agreed to anything, so rows must
 * not outlive their usefulness. Nothing reads a request after expiry.
 *
 * @param db - D1 database
 * @param logger - Logger
 * @returns How many rows were deleted
 */
export async function purgeExpiredAgentSignups(
  db: D1Database,
  logger: Logger,
): Promise<Result<number, AppError>> {
  try {
    const cutoff = nowSeconds() - AGENT_SIGNUP_RETENTION_SECONDS;
    const result = await db
      .prepare("DELETE FROM agent_signups WHERE expires_at < ?")
      .bind(cutoff)
      .run();
    const purged = result.meta?.changes ?? 0;
    if (purged > 0) logger.info("Purged expired agent signups", { purged });
    return ok(purged);
  } catch (error) {
    return err(storageError("Failed to purge expired agent signups", error, logger));
  }
}
