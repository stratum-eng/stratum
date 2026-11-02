import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * Passkeys (WebAuthn credentials) and one-time recovery codes — the second
 * factor (#256). Schema: migration 056.
 *
 * Nothing here is a bearer secret: a credential row holds the PUBLIC key, and a
 * recovery code is stored only as its SHA-256 hash.
 */

/** A registered passkey as the rest of the app sees it. */
export interface PasskeyRecord {
  id: string;
  userId: string;
  /** base64url credential id, as the authenticator reports it. */
  credentialId: string;
  /** base64url COSE public key. */
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What the settings page and the list endpoint expose — never the key material. */
export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** Display names are user input shown back on the settings page. */
export const MAX_PASSKEY_NAME_LENGTH = 64;

/** How many recovery codes a set holds. */
export const RECOVERY_CODE_COUNT = 10;

function parseTransports(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function rowToPasskey(row: PasskeyRow): PasskeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: Number(row.counter),
    transports: parseTransports(row.transports),
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function toPasskeySummary(record: PasskeyRecord): PasskeySummary {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function storageError(message: string, logger: Logger, error: unknown, userId: string): AppError {
  logger.error(message, error instanceof Error ? error : undefined, { userId });
  return new AppError(message, "STORAGE_ERROR", 500, { userId });
}

export async function listPasskeys(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<PasskeyRecord[], AppError>> {
  try {
    const { results } = await db
      .prepare(
        "SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at ASC, id ASC",
      )
      .bind(userId)
      .all<PasskeyRow>();
    return ok((results ?? []).map(rowToPasskey));
  } catch (error) {
    return err(storageError("Failed to list passkeys", logger, error, userId));
  }
}

export async function countPasskeys(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<number, AppError>> {
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?")
      .bind(userId)
      .first<{ n: number }>();
    return ok(Number(row?.n ?? 0));
  } catch (error) {
    return err(storageError("Failed to count passkeys", logger, error, userId));
  }
}

/** The caller's credential with this WebAuthn credential id — scoped to the user,
 * so an assertion made with someone else's passkey never resolves. */
export async function getPasskeyByCredentialId(
  db: D1Database,
  logger: Logger,
  userId: string,
  credentialId: string,
): Promise<Result<PasskeyRecord, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?")
      .bind(userId, credentialId)
      .first<PasskeyRow>();
    if (!row) return err(new NotFoundError("Passkey", "(credential)"));
    return ok(rowToPasskey(row));
  } catch (error) {
    return err(storageError("Failed to read passkey", logger, error, userId));
  }
}

export interface NewPasskey {
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
}

export async function insertPasskey(
  db: D1Database,
  logger: Logger,
  input: NewPasskey,
): Promise<Result<PasskeyRecord, AppError>> {
  const record: PasskeyRecord = {
    id: newId("pk"),
    userId: input.userId,
    credentialId: input.credentialId,
    publicKey: input.publicKey,
    counter: input.counter,
    transports: input.transports,
    name: input.name,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  try {
    await db
      .prepare(
        `INSERT INTO webauthn_credentials
           (id, user_id, credential_id, public_key, counter, transports, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.userId,
        record.credentialId,
        record.publicKey,
        record.counter,
        record.transports.length > 0 ? JSON.stringify(record.transports) : null,
        record.name,
        record.createdAt,
      )
      .run();
    return ok(record);
  } catch (error) {
    // credential_id is UNIQUE: the same authenticator registered twice (the
    // browser's excludeCredentials should prevent it, but it is advisory).
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      return err(
        new AppError("This passkey is already registered", "PASSKEY_EXISTS", 409, {
          userId: input.userId,
        }),
      );
    }
    return err(storageError("Failed to save passkey", logger, error, input.userId));
  }
}

export async function renamePasskey(
  db: D1Database,
  logger: Logger,
  userId: string,
  id: string,
  name: string,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare("UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?")
      .bind(name, id, userId)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(storageError("Failed to rename passkey", logger, error, userId));
  }
}

export async function deletePasskey(
  db: D1Database,
  logger: Logger,
  userId: string,
  id: string,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare("DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(storageError("Failed to delete passkey", logger, error, userId));
  }
}

/**
 * Advance a credential's signature counter after a verified assertion.
 *
 * Compare-and-swap on the counter the verification was checked against: two
 * concurrent replays of the same assertion both pass the library's
 * "counter must increase" check against the same stored value, and only one of
 * them may win here. A `false` return means the counter moved underneath us and
 * the assertion must be refused.
 */
export async function advancePasskeyCounter(
  db: D1Database,
  logger: Logger,
  record: PasskeyRecord,
  newCounter: number,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare(
        "UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?",
      )
      .bind(newCounter, new Date().toISOString(), record.id, record.counter)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(storageError("Failed to update passkey counter", logger, error, record.userId));
  }
}

/** Replace the user's recovery codes with a fresh set (hashes only). */
export async function replaceRecoveryCodes(
  db: D1Database,
  logger: Logger,
  userId: string,
  codeHashes: string[],
): Promise<Result<void, AppError>> {
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
      ...codeHashes.map((hash) =>
        db
          .prepare(
            "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)",
          )
          .bind(newId("rc"), userId, hash, now),
      ),
    ]);
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to save recovery codes", logger, error, userId));
  }
}

/**
 * Spend one recovery code. The conditional UPDATE is the single-use guarantee:
 * two concurrent attempts with the same code cannot both see `used_at IS NULL`.
 */
export async function consumeRecoveryCode(
  db: D1Database,
  logger: Logger,
  userId: string,
  codeHash: string,
): Promise<Result<boolean, AppError>> {
  try {
    const result = await db
      .prepare(
        "UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
      )
      .bind(new Date().toISOString(), userId, codeHash)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    return err(storageError("Failed to use recovery code", logger, error, userId));
  }
}

export async function countUnusedRecoveryCodes(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<number, AppError>> {
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL")
      .bind(userId)
      .first<{ n: number }>();
    return ok(Number(row?.n ?? 0));
  } catch (error) {
    return err(storageError("Failed to count recovery codes", logger, error, userId));
  }
}

export async function deleteRecoveryCodes(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<void, AppError>> {
  try {
    await db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId).run();
    return ok(undefined);
  } catch (error) {
    return err(storageError("Failed to delete recovery codes", logger, error, userId));
  }
}

/** Account erasure: every passkey and recovery code the user holds. */
export async function deleteSecondFactorDataForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM webauthn_credentials WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId).run();
}
