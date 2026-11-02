/**
 * Per-project encrypted secret store, backing deploy provider credentials.
 *
 * Write-only by construction: the only function that yields a plaintext value is
 * {@link loadSecretValues}, which exists for the deploy runner and is deliberately
 * not reachable from any route. Everything else returns names and metadata.
 */
import type { Env } from "../types";
import { type SecretScope, decryptSecret, deriveSecretKey, encryptSecret } from "../utils/crypto";
import { AppError, ValidationError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * Environment-shaped uppercase name, so a secret maps cleanly onto the provider
 * environment variables the deploy targets expect. The 64-character bound keeps
 * a name inside the AAD and the log-redaction paths without truncation.
 */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Cap on a secret's UTF-8 length. Generous for every credential the three deploy
 * targets accept (API tokens, account ids), while keeping a project's whole
 * secret set well inside one D1 row-size budget.
 *
 * There is deliberately no *minimum*: some providers legitimately accept an
 * empty value, and rejecting one would only push operators to store a
 * placeholder that reads like a real credential.
 */
export const MAX_SECRET_VALUE_BYTES = 4096;

/**
 * Error code raised when `DEPLOY_SECRET_KEY` is unset. Distinct from a generic
 * database failure because it is an operator misconfiguration with a specific
 * remedy, and the deploy runner reports it verbatim on the failed deployment.
 */
export const DEPLOY_SECRET_KEY_MISSING = "DEPLOY_SECRET_KEY_MISSING";

/** A secret as anyone other than the deploy runner may ever see it. */
export interface ProjectSecretSummary {
  name: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Outcome of resolving a deploy's declared secret names. */
export interface LoadedSecrets {
  /** Name to plaintext, for the names that resolved. */
  values: Map<string, string>;
  /** Requested names with no row in this project. */
  missing: string[];
  /**
   * Rows that exist but failed AES-GCM authentication — `DEPLOY_SECRET_KEY` was
   * rotated, or the ciphertext was moved between projects or names. Reported
   * apart from `missing` because the remedy differs: re-enter the value versus
   * restore the key.
   */
  undecryptable: string[];
}

type SecretKeyEnv = Pick<Env, "DEPLOY_SECRET_KEY">;

interface SecretRow {
  name: string;
  ciphertext: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

function rowToSummary(row: Omit<SecretRow, "ciphertext">): ProjectSecretSummary {
  return {
    name: row.name,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

function validateName(name: string): ValidationError | null {
  if (SECRET_NAME_PATTERN.test(name)) return null;
  return new ValidationError(
    "Secret name must match ^[A-Z][A-Z0-9_]{0,63}$ (uppercase letter first, then letters, digits, or underscores)",
    { name },
  );
}

function validateValue(value: string): ValidationError | null {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes <= MAX_SECRET_VALUE_BYTES) return null;
  return new ValidationError(`Secret value exceeds ${MAX_SECRET_VALUE_BYTES} bytes`, {
    bytes,
    limit: MAX_SECRET_VALUE_BYTES,
  });
}

/**
 * Resolves the derived AES key, or a typed error when the instance is not
 * configured for deploys. Returned as a value rather than thrown so a route can
 * render an actionable 500 and the deploy runner can write a named failure.
 */
async function resolveKey(env: SecretKeyEnv): Promise<Result<CryptoKey, AppError>> {
  const secret = env.DEPLOY_SECRET_KEY;
  if (!secret) {
    return err(
      new AppError(
        "DEPLOY_SECRET_KEY is not configured; deploy secrets cannot be encrypted or decrypted",
        DEPLOY_SECRET_KEY_MISSING,
        500,
      ),
    );
  }
  try {
    return ok(await deriveSecretKey(secret));
  } catch (error) {
    return err(toAppError(error, "deriveSecretKey", {}));
  }
}

/**
 * Creates or replaces a project's secret, returning only its metadata.
 *
 * An overwrite keeps `created_by`/`created_at` and stamps `updated_by`, so a
 * second admin rotating another admin's credential stays attributable.
 *
 * @param env - Needs `DEPLOY_SECRET_KEY`
 * @param opts.projectId - Canonical project id; never a project name
 * @param opts.actorId - The user performing the write
 */
export async function putSecret(
  db: D1Database,
  logger: Logger,
  env: SecretKeyEnv,
  opts: { projectId: string; name: string; value: string; actorId: string },
): Promise<Result<ProjectSecretSummary, AppError>> {
  const nameError = validateName(opts.name);
  if (nameError) return err(nameError);
  const valueError = validateValue(opts.value);
  if (valueError) return err(valueError);

  const keyResult = await resolveKey(env);
  if (!keyResult.success) {
    logger.error("Cannot store project secret", keyResult.error, {
      projectId: opts.projectId,
      name: opts.name,
    });
    return err(keyResult.error);
  }

  const scope: SecretScope = { projectId: opts.projectId, name: opts.name };
  const now = new Date().toISOString();

  try {
    const ciphertext = await encryptSecret(opts.value, keyResult.data, scope);

    await db
      .prepare(
        "INSERT INTO project_secrets (id, project_id, name, ciphertext, created_by, updated_by, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(project_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      )
      .bind(
        newId("psec"),
        opts.projectId,
        opts.name,
        ciphertext,
        opts.actorId,
        opts.actorId,
        now,
        now,
      )
      .run();

    const row = await db
      .prepare(
        "SELECT name, created_by, updated_by, created_at, updated_at FROM project_secrets WHERE project_id = ? AND name = ?",
      )
      .bind(opts.projectId, opts.name)
      .first<Omit<SecretRow, "ciphertext">>();

    if (!row) {
      const appError = new AppError(
        "Secret disappeared immediately after being written",
        "DATABASE_ERROR",
        500,
        { operation: "putSecret", projectId: opts.projectId },
      );
      logger.error("Failed to read back project secret", appError, { projectId: opts.projectId });
      return err(appError);
    }

    logger.info("Project secret stored", { projectId: opts.projectId, name: opts.name });
    return ok(rowToSummary(row));
  } catch (error) {
    const appError = toAppError(error, "putSecret", { projectId: opts.projectId });
    logger.error("Failed to store project secret", appError, {
      projectId: opts.projectId,
      name: opts.name,
    });
    return err(appError);
  }
}

/**
 * Lists a project's secret names and metadata. Never returns a value.
 *
 * Scoped on `project_id` alone — a bare project name collides across
 * namespaces, so matching on it would let a same-named project in another
 * tenant enumerate these credentials (see `webhookBelongsToProject`).
 */
export async function listSecretNames(
  db: D1Database,
  logger: Logger,
  projectId: string,
): Promise<Result<ProjectSecretSummary[], AppError>> {
  try {
    const result = await db
      .prepare(
        "SELECT name, created_by, updated_by, created_at, updated_at FROM project_secrets WHERE project_id = ? ORDER BY name ASC",
      )
      .bind(projectId)
      .all<Omit<SecretRow, "ciphertext">>();
    return ok(result.results.map(rowToSummary));
  } catch (error) {
    const appError = toAppError(error, "listSecretNames", { projectId });
    logger.error("Failed to list project secrets", appError, { projectId });
    return err(appError);
  }
}

/**
 * Deletes one secret.
 *
 * @returns `true` when a row was removed, `false` when the project had no such
 *   secret — so a route can answer 404 without a preceding read.
 */
export async function deleteSecret(
  db: D1Database,
  logger: Logger,
  opts: { projectId: string; name: string },
): Promise<Result<boolean, AppError>> {
  const nameError = validateName(opts.name);
  if (nameError) return err(nameError);

  try {
    const result = await db
      .prepare("DELETE FROM project_secrets WHERE project_id = ? AND name = ?")
      .bind(opts.projectId, opts.name)
      .run();
    const deleted = result.meta.changes > 0;
    if (deleted)
      logger.info("Project secret deleted", { projectId: opts.projectId, name: opts.name });
    return ok(deleted);
  } catch (error) {
    const appError = toAppError(error, "deleteSecret", { projectId: opts.projectId });
    logger.error("Failed to delete project secret", appError, {
      projectId: opts.projectId,
      name: opts.name,
    });
    return err(appError);
  }
}

/**
 * Resolves plaintext secret values for the deploy runner. **The only read path
 * for a value anywhere in the codebase** — do not call it from a route.
 *
 * Derives the AES key once for the whole batch: PBKDF2 at 100k iterations is CPU
 * work and the deploy consumer runs under a CPU limit, so per-secret derivation
 * would put a multi-secret deploy at risk of being cut off mid-run.
 *
 * Unresolvable names are reported rather than thrown, so the runner can name the
 * offender on the failed deployment row.
 */
export async function loadSecretValues(
  db: D1Database,
  logger: Logger,
  env: SecretKeyEnv,
  opts: { projectId: string; names: readonly string[] },
): Promise<Result<LoadedSecrets, AppError>> {
  const wanted = [...new Set(opts.names)];
  if (wanted.length === 0) {
    return ok({ values: new Map(), missing: [], undecryptable: [] });
  }

  const keyResult = await resolveKey(env);
  if (!keyResult.success) {
    logger.error("Cannot load project secrets", keyResult.error, { projectId: opts.projectId });
    return err(keyResult.error);
  }

  try {
    const placeholders = wanted.map(() => "?").join(", ");
    const result = await db
      .prepare(
        `SELECT name, ciphertext FROM project_secrets WHERE project_id = ? AND name IN (${placeholders})`,
      )
      .bind(opts.projectId, ...wanted)
      .all<Pick<SecretRow, "name" | "ciphertext">>();

    const values = new Map<string, string>();
    const undecryptable: string[] = [];
    for (const row of result.results) {
      const plaintext = await decryptSecret(row.ciphertext, keyResult.data, {
        projectId: opts.projectId,
        name: row.name,
      });
      if (plaintext === null) undecryptable.push(row.name);
      else values.set(row.name, plaintext);
    }

    const found = new Set(result.results.map((row) => row.name));
    const missing = wanted.filter((name) => !found.has(name));

    if (missing.length > 0 || undecryptable.length > 0) {
      logger.warn("Some project secrets could not be resolved", {
        projectId: opts.projectId,
        missing,
        undecryptable,
      });
    }

    return ok({ values, missing, undecryptable });
  } catch (error) {
    const appError = toAppError(error, "loadSecretValues", { projectId: opts.projectId });
    logger.error("Failed to load project secrets", appError, { projectId: opts.projectId });
    return err(appError);
  }
}
