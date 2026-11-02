import { AppError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

// External identities (migration 049): one row per (issuer, subject), the
// stable pair an IdP guarantees for a user. Two invariants:
//   1. (issuer, subject) is globally unique — enforced by the schema.
//   2. At most one identity per (user_id, issuer) — enforced here (SQL can't
//      express it without blocking legitimate subject rotation), so a user can
//      hold identities from many issuers but never two subjects at one issuer.

export type IdentityProvider = "oidc" | "github" | "google";

export interface Identity {
  id: string;
  userId: string;
  provider: IdentityProvider;
  issuer: string;
  subject: string;
  email: string;
  connectionId: string | null;
  createdAt: string;
}

export interface UpsertIdentityInput {
  userId: string;
  provider: IdentityProvider;
  issuer: string;
  subject: string;
  email: string;
  connectionId?: string | null;
}

interface IdentityRow {
  id: string;
  user_id: string;
  provider: IdentityProvider;
  issuer: string;
  subject: string;
  email: string;
  connection_id: string | null;
  created_at: string;
}

// IdP claims are semi-hostile input once org admins can register arbitrary
// issuers; a cap keeps a multi-MB claim from becoming a multi-MB D1 row.
const MAX_IDENTITY_FIELD_LENGTH = 1024;

function validateIdentityField(name: string, value: string): ValidationError | null {
  if (value.trim().length === 0) {
    return new ValidationError(`Identity ${name} must be non-empty`, { field: name });
  }
  if (value.length > MAX_IDENTITY_FIELD_LENGTH) {
    return new ValidationError(`Identity ${name} exceeds ${MAX_IDENTITY_FIELD_LENGTH} chars`, {
      field: name,
    });
  }
  return null;
}

function rowToIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    email: row.email,
    connectionId: row.connection_id,
    createdAt: row.created_at,
  };
}

/**
 * Link an external identity to a user, replacing any prior state that would
 * violate either invariant: the user's previous subject at this issuer is
 * removed (subject rotation), and an existing (issuer, subject) row is
 * re-pointed at this user (the row's email/connection refresh on every login).
 * Both statements run in one atomic batch so a crash can't leave the user with
 * two identities at one issuer.
 */
export async function upsertIdentity(
  db: D1Database,
  logger: Logger,
  input: UpsertIdentityInput,
): Promise<Result<Identity, AppError>> {
  const { userId, provider, issuer, subject } = input;
  logger.debug("Upserting identity", { userId, provider, issuer });

  for (const [name, value] of [
    ["issuer", issuer],
    ["subject", subject],
    ["email", input.email],
  ] as const) {
    const invalid = validateIdentityField(name, value);
    if (invalid) return err(invalid);
  }
  // Domain checks and email-matching downstream compare lowercased (the repo
  // convention for emails); issuer/subject stay byte-exact per OIDC.
  const email = input.email.trim().toLowerCase();

  try {
    const id = newId("idn");
    const createdAt = new Date().toISOString();
    const connectionId = input.connectionId ?? null;

    // Best-effort pre-read, for the forensic re-point warning below only —
    // correctness never depends on it.
    const prior = await db
      .prepare("SELECT user_id FROM identities WHERE issuer = ? AND subject = ?")
      .bind(issuer, subject)
      .first<{ user_id: string }>();

    await db.batch([
      db
        .prepare("DELETE FROM identities WHERE user_id = ? AND issuer = ? AND subject != ?")
        .bind(userId, issuer, subject),
      db
        .prepare(
          `INSERT INTO identities (id, user_id, provider, issuer, subject, email, connection_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (issuer, subject) DO UPDATE SET
             user_id = excluded.user_id,
             provider = excluded.provider,
             email = excluded.email,
             connection_id = excluded.connection_id,
             created_at = CASE
               WHEN identities.user_id = excluded.user_id THEN identities.created_at
               ELSE excluded.created_at
             END`,
        )
        .bind(id, userId, provider, issuer, subject, email, connectionId, createdAt),
    ]);

    // Re-read: on conflict the stored row keeps its original id. The ownership
    // assertion closes the read-after-batch race — if a concurrent upsert
    // re-pointed the pair to another user in the window, fail rather than hand
    // the caller an identity it would mint a session for.
    const row = await db
      .prepare("SELECT * FROM identities WHERE issuer = ? AND subject = ?")
      .bind(issuer, subject)
      .first<IdentityRow>();
    if (!row) {
      return err(
        new AppError(`Identity missing after upsert for issuer '${issuer}'`, "STORAGE_ERROR", 500),
      );
    }
    if (row.user_id !== userId) {
      logger.error("Identity re-pointed concurrently during upsert", undefined, {
        issuer,
        expectedUserId: userId,
        actualUserId: row.user_id,
      });
      return err(new ConflictError("Identity was linked to another account concurrently"));
    }

    if (prior && prior.user_id !== userId) {
      // The breadcrumb for account-takeover forensics: an (issuer, subject)
      // changing owners is legitimate only in rare flows (subject reuse at the
      // IdP); the normal login path signs in the existing owner instead.
      logger.warn("Identity re-pointed from another user", {
        issuer,
        provider,
        previousUserId: prior.user_id,
        userId,
      });
    }

    logger.info("Identity upserted", { userId, provider, issuer, identityId: row.id });
    return ok(rowToIdentity(row));
  } catch (error) {
    logger.error("Failed to upsert identity", error instanceof Error ? error : undefined, {
      userId,
      provider,
      issuer,
    });
    return err(new AppError("Failed to upsert identity", "STORAGE_ERROR", 500, { userId }));
  }
}

export async function getIdentityByIssuerSubject(
  db: D1Database,
  logger: Logger,
  issuer: string,
  subject: string,
): Promise<Result<Identity, NotFoundError | AppError>> {
  logger.debug("Querying identity by issuer/subject", { issuer });

  try {
    const row = await db
      .prepare("SELECT * FROM identities WHERE issuer = ? AND subject = ?")
      .bind(issuer, subject)
      .first<IdentityRow>();

    if (!row) {
      logger.debug("Identity not found", { issuer });
      return err(new NotFoundError("Identity", `${issuer}#subject`));
    }

    logger.debug("Identity found", { issuer, identityId: row.id, userId: row.user_id });
    return ok(rowToIdentity(row));
  } catch (error) {
    // Never mask a DB failure as NotFound: the SSO resolution chain falls
    // through NotFound into email-matching/JIT-creation, so a transient error
    // here must fail the login closed, not provision a duplicate account.
    logger.error("Failed to get identity", error instanceof Error ? error : undefined, { issuer });
    return err(new AppError("Failed to get identity", "STORAGE_ERROR", 500));
  }
}

/**
 * Remove every identity for a user (account deletion cascade), so a future
 * signup by the same IdP subject is neither blocked nor hijacked.
 */
export async function deleteIdentitiesForUser(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<number, AppError>> {
  logger.debug("Deleting identities for user", { userId });

  try {
    const result = await db.prepare("DELETE FROM identities WHERE user_id = ?").bind(userId).run();
    const deletedCount = result.meta?.changes ?? 0;
    logger.info("Identities deleted for user", { userId, deletedCount });
    return ok(deletedCount);
  } catch (error) {
    logger.error(
      "Failed to delete identities for user",
      error instanceof Error ? error : undefined,
      {
        userId,
      },
    );
    return err(new AppError("Failed to delete identities", "STORAGE_ERROR", 500, { userId }));
  }
}
