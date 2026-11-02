import type { ApiTokenScope, User } from "../types";
import { generateApiKey, hashToken } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * Most active tokens one user may hold. Revoked AND expired rows deliberately
 * do NOT count: both are kept for the audit trail, and counting them would mean
 * a user who rotates often — or who simply let short-lived tokens lapse — is
 * eventually locked out of creating any token at all, with no remedy that does
 * not destroy the trail.
 */
export const MAX_ACTIVE_TOKENS_PER_USER = 20;

/** Bounds on `expiresInDays`. A day is the smallest unit worth offering, and a
 * year is long enough that anyone wanting more is really asking for no expiry —
 * which is what omitting the field already means. */
export const MIN_TOKEN_EXPIRY_DAYS = 1;
export const MAX_TOKEN_EXPIRY_DAYS = 365;

/** How stale `last_used_at` must be before a successful authentication rewrites
 * it. Without a debounce every authenticated request would carry a D1 write; an
 * hour is coarse enough to cost nothing and fine enough to answer "is this
 * credential still in use". */
export const LAST_USED_DEBOUNCE_MS = 60 * 60 * 1000;

/**
 * Has this expiry passed? A `null` expiry never has.
 *
 * ALWAYS compared in JavaScript, never in SQL. This codebase stores both
 * `datetime('now')` (`"… 12:00:00"`) and ISO (`"…T12:00:00.000Z"`), and `' '`
 * (0x20) sorts below `'T'` (0x54) — so `WHERE expires_at > datetime('now')`
 * against an ISO value reads every expired token as live.
 *
 * An unparseable expiry counts as EXPIRED: a token whose lifetime cannot be
 * established must not be honoured indefinitely.
 */
export function isExpired(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  const at = Date.parse(expiresAt);
  return !Number.isFinite(at) || at <= Date.now();
}

/** A token as listed to its owner. Deliberately carries no hash. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  /** The token's leading, non-secret characters — enough to recognise a
   * credential already deployed somewhere, never enough to use one. */
  tokenPrefix: string;
  scope: ApiTokenScope;
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  revokedAt?: string;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  scope: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Narrows a stored scope value to the union.
 *
 * Anything that is not exactly `read_write` is read-only. The column has a
 * CHECK constraint, so a bad value should be impossible — but a resolver that
 * defaulted the other way would turn a constraint failure into a privilege
 * escalation, and this direction turns it into a harmless downgrade.
 */
export function narrowTokenScope(value: string): ApiTokenScope {
  return value === "read_write" ? "read_write" : "read";
}

function rowToSummary(row: ApiTokenRow): ApiTokenSummary {
  const summary: ApiTokenSummary = {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scope: narrowTokenScope(row.scope),
    createdAt: row.created_at,
  };
  if (row.expires_at !== null) summary.expiresAt = row.expires_at;
  if (row.last_used_at !== null) summary.lastUsedAt = row.last_used_at;
  if (row.revoked_at !== null) summary.revokedAt = row.revoked_at;
  return summary;
}

function toAppError(error: unknown, operation: string, context: Record<string, unknown>): AppError {
  return error instanceof AppError
    ? error
    : new AppError(
        error instanceof Error ? error.message : `Failed in ${operation}`,
        "DATABASE_ERROR",
        500,
        { operation, ...context },
      );
}

/** The non-secret leading portion recorded for display: the `stratum_user_`
 * prefix plus the first 8 hex characters, which is 32 bits of the 128 the token
 * carries — enough to tell two of a user's own tokens apart, far short of
 * enough to guess one. */
function displayPrefix(plaintext: string): string {
  return plaintext.slice(0, "stratum_user_".length + 8);
}

export interface CreatedApiToken {
  token: ApiTokenSummary;
  /** The only time the plaintext exists outside the caller's own storage. */
  plaintext: string;
}

/**
 * Mints a named token for a user.
 *
 * The plaintext is returned exactly once and never stored — only its SHA-256
 * hash is, matching how `users.token_hash` and `agents.token_hash` already work
 * so the authentication path stays a single indexed lookup.
 *
 * @param opts.expiresInDays - Omitted means the token never expires. Callers are
 * expected to have validated the range; this re-checks rather than trusting it,
 * because an out-of-range value here silently becomes a nonsense timestamp.
 */
export async function createApiToken(
  db: D1Database,
  logger: Logger,
  opts: { userId: string; name: string; scope: ApiTokenScope; expiresInDays?: number },
): Promise<Result<CreatedApiToken, AppError>> {
  const { userId, name, scope, expiresInDays } = opts;

  if (
    expiresInDays !== undefined &&
    (!Number.isInteger(expiresInDays) ||
      expiresInDays < MIN_TOKEN_EXPIRY_DAYS ||
      expiresInDays > MAX_TOKEN_EXPIRY_DAYS)
  ) {
    return err(
      new AppError(
        `expiresInDays must be an integer between ${MIN_TOKEN_EXPIRY_DAYS} and ${MAX_TOKEN_EXPIRY_DAYS}`,
        "VALIDATION_ERROR",
        400,
      ),
    );
  }

  try {
    // Counted in JS, not with a SQL `COUNT(*)` filtered on expiry: this table
    // stores ISO timestamps while other rows in this codebase carry
    // `datetime('now')`, and `' '` sorts below `'T'`, so a SQL comparison reads
    // expired rows as live. `resolveApiToken` dodges the same trap the same way.
    const live = await db
      .prepare("SELECT expires_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL")
      .bind(userId)
      .all<{ expires_at: string | null }>();
    const activeCount = (live.results ?? []).filter((row) => !isExpired(row.expires_at)).length;
    if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
      return err(
        new AppError(
          `At most ${MAX_ACTIVE_TOKENS_PER_USER} active tokens per user. Revoke one first.`,
          "TOKEN_LIMIT_REACHED",
          409,
        ),
      );
    }

    const plaintext = await generateApiKey("stratum_user");
    const id = newId("tok");
    const createdAt = new Date().toISOString();
    const expiresAt =
      expiresInDays === undefined
        ? null
        : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    await db
      .prepare(
        `INSERT INTO api_tokens
           (id, user_id, name, token_hash, token_prefix, scope, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        userId,
        name,
        await hashToken(plaintext),
        displayPrefix(plaintext),
        scope,
        expiresAt,
        createdAt,
      )
      .run();

    logger.info("API token created", { userId, tokenId: id, scope });
    const token: ApiTokenSummary = {
      id,
      name,
      tokenPrefix: displayPrefix(plaintext),
      scope,
      createdAt,
    };
    if (expiresAt !== null) token.expiresAt = expiresAt;
    return ok({ token, plaintext });
  } catch (error) {
    const appError = toAppError(error, "createApiToken", { userId });
    logger.error("Failed to create API token", appError, { userId });
    return err(appError);
  }
}

/** Lists a user's tokens, newest first. Never returns a hash. */
export async function listApiTokens(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<ApiTokenSummary[], AppError>> {
  try {
    const rows = await db
      .prepare(
        `SELECT id, user_id, name, token_prefix, scope, expires_at, last_used_at, created_at, revoked_at
         FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .bind(userId)
      .all<ApiTokenRow>();
    return ok(rows.results.map(rowToSummary));
  } catch (error) {
    const appError = toAppError(error, "listApiTokens", { userId });
    logger.error("Failed to list API tokens", appError, { userId });
    return err(appError);
  }
}

/**
 * Revokes one of a user's own tokens.
 *
 * Scoped by `user_id` in the UPDATE itself rather than by a read-then-check, so
 * another user's token id is indistinguishable from one that does not exist —
 * the caller gets the same not-found either way.
 */
export async function revokeApiToken(
  db: D1Database,
  logger: Logger,
  opts: { userId: string; tokenId: string },
): Promise<Result<void, NotFoundError | AppError>> {
  try {
    const result = await db
      .prepare(
        "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .bind(new Date().toISOString(), opts.tokenId, opts.userId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      return err(new NotFoundError("Token", opts.tokenId));
    }
    logger.info("API token revoked", { userId: opts.userId, tokenId: opts.tokenId });
    return ok(undefined);
  } catch (error) {
    const appError = toAppError(error, "revokeApiToken", opts);
    logger.error("Failed to revoke API token", appError, opts);
    return err(appError);
  }
}

/**
 * Records that a token was used, at most once per {@link LAST_USED_DEBOUNCE_MS}.
 *
 * Best-effort by contract: this runs off the response path and its failure must
 * never fail the request. The debounce is what makes the field affordable —
 * without it every authenticated request would carry a write.
 */
export async function touchApiTokenLastUsed(
  db: D1Database,
  logger: Logger,
  opts: { tokenId: string; lastUsedAt?: string },
): Promise<void> {
  const now = Date.now();
  if (opts.lastUsedAt !== undefined) {
    const previous = Date.parse(opts.lastUsedAt);
    if (Number.isFinite(previous) && now - previous < LAST_USED_DEBOUNCE_MS) return;
  }
  try {
    await db
      .prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .bind(new Date(now).toISOString(), opts.tokenId)
      .run();
  } catch (error) {
    logger.warn("Failed to record API token last-used time", {
      tokenId: opts.tokenId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** An `api_tokens` credential that authenticated, with its owner and scope. */
export interface ResolvedApiToken {
  user: User;
  scope: ApiTokenScope;
  tokenId: string;
  /** Drives the last-used debounce; absent until the token is first used. */
  lastUsedAt?: string;
}

interface ResolvedTokenRow {
  user_id: string;
  email: string;
  username: string;
  github_id: string | null;
  github_username: string | null;
  user_token_hash: string;
  user_created_at: string;
  deleting_at: string | null;
  disabled_at: string | null;
  telemetry_opt_out: number;
  token_id: string;
  token_scope: string;
  token_expires_at: string | null;
  token_last_used_at: string | null;
  token_revoked_at: string | null;
}

/**
 * Resolves a `stratum_user_` plaintext against the scoped-token table.
 *
 * One statement: the token joined to its owner, so a valid token costs a single
 * indexed read rather than a lookup plus an owner fetch. The owner's
 * `deleting_at` rides along for the same reason `getUserByToken` selects `*`,
 * as does `telemetry_opt_out` (#257).
 *
 * Returns `NOT_FOUND` when the plaintext names no scoped token — which is the
 * signal for the caller to try the legacy `users.token_hash` credential. Every
 * other outcome is a rejection: revoked, expired, a missing or soft-deleting
 * owner (#236/#229), or a storage failure.
 *
 * **Expiry is compared here, in JavaScript, never in SQL.** This codebase stores
 * both `datetime('now')` (`"… 12:00:00"`) and ISO (`"…T12:00:00.000Z"`), and
 * `' '` sorts below `'T'` — so a SQL comparison against an ISO value would read
 * every expired token as unexpired. Sessions compare in JS for the same reason.
 */
export async function resolveApiToken(
  db: D1Database,
  plaintext: string,
  logger: Logger,
): Promise<Result<ResolvedApiToken, NotFoundError | AppError>> {
  const tokenHash = await hashToken(plaintext);

  let row: ResolvedTokenRow | null;
  try {
    row = await db
      .prepare(
        `SELECT u.id AS user_id, u.email, u.username, u.github_id, u.github_username,
                u.token_hash AS user_token_hash, u.created_at AS user_created_at, u.deleting_at, u.disabled_at,
                u.telemetry_opt_out,
                t.id AS token_id, t.scope AS token_scope, t.expires_at AS token_expires_at,
                t.last_used_at AS token_last_used_at, t.revoked_at AS token_revoked_at
           FROM api_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ?`,
      )
      .bind(tokenHash)
      .first<ResolvedTokenRow>();
  } catch (error) {
    logger.warn("Scoped-token lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return err(new AppError("Token lookup failed", "DATABASE_ERROR", 500));
  }

  if (!row) return err(new NotFoundError("Token", "by-token"));
  if (row.token_revoked_at !== null) return err(new NotFoundError("Token", "revoked"));
  if (row.deleting_at !== null) return err(new NotFoundError("Token", "owner-deleting"));
  // A SCIM-disabled owner is as inert as a deleting one (#253); the column is
  // NULL on enabled accounts, and `!= null` also tolerates a stub row without it.
  if (row.disabled_at != null) return err(new NotFoundError("Token", "owner-disabled"));
  if (isExpired(row.token_expires_at)) return err(new NotFoundError("Token", "expired"));

  const user: User = {
    id: row.user_id,
    email: row.email,
    username: row.username,
    tokenHash: row.user_token_hash,
    createdAt: row.user_created_at,
  };
  if (row.github_id !== null) user.githubId = row.github_id;
  if (row.github_username !== null) user.githubUsername = row.github_username;
  // Same rule as `rowToUser` in storage/users: compare against 1, so a read
  // that omits the column means "opted in" rather than leaking `undefined`
  // into a truthiness test. Selected here so a scoped-token caller carries the
  // owner's analytics preference (#257) exactly as a legacy-token caller does.
  if (row.telemetry_opt_out === 1) user.telemetryOptOut = true;

  const resolved: ResolvedApiToken = {
    user,
    scope: narrowTokenScope(row.token_scope),
    tokenId: row.token_id,
  };
  if (row.token_last_used_at !== null) resolved.lastUsedAt = row.token_last_used_at;
  return ok(resolved);
}
