/**
 * Per-project encrypted secret store, backing deploy provider credentials and
 * the per-project LLM provider keys BYOK runs on.
 *
 * Write-only by construction *to a caller*: the only function that yields a
 * plaintext value is {@link loadSecretValues}, and no route returns, renders or
 * logs what it resolves. It is no longer unreachable from a route, though —
 * BYOK resolves a provider credential on the change-creation path, so the
 * routes that create or re-evaluate a change (`routes/changes.ts`,
 * `routes/git-http.ts`, `routes/sync-management.ts`) reach it through
 * `evaluation/llm-byok.ts`. What keeps that safe is the rule below, not the
 * call graph: the value it returns goes into one outbound request header and
 * nowhere else. Everything else here returns names and metadata.
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

/**
 * Characters no credential contains and that a header cannot carry: C0, DEL,
 * and NUL among them.
 *
 * Rejected at the WRITE, which is the only place the value is ever attacker-
 * chosen. A stored value ends up in an outbound header, and `new Headers()`
 * throws a `TypeError` whose message QUOTES the offending value — so a CR, LF
 * or NUL in a stored secret turns into an error message carrying the secret,
 * which then becomes an evaluation reason persisted on the change and rendered
 * on a page that is world-readable for a public project. The provider closes
 * the other end (`evaluation/llm-provider.ts` builds its headers outside the
 * try and maps a failure to a constant), so neither end alone is load-bearing.
 */
/**
 * Does `value` contain a C0 control character or DEL?
 *
 * A char-code scan rather than a regex: matching control characters is the
 * whole point here, which Biome's `noControlCharactersInRegex` flags, and a
 * suppression for a rule this deliberately trips reads worse than the loop.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateValue(value: string): ValidationError | null {
  if (hasControlCharacter(value)) {
    // Deliberately says nothing about the value — not its length, not the
    // offending character, and above all not the value itself: this message is
    // rendered back to the caller.
    return new ValidationError(
      "Secret value must not contain control characters (including CR, LF, tab and NUL)",
    );
  }
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
    // Cached per isolate, keyed on the value so a rebind (or a test) is never
    // served the key of a different secret. PBKDF2 at 100k iterations was
    // affordable once per deploy; BYOK puts it on the change-creation path,
    // which already does two clones and a diff, and that path runs on every
    // change rather than on every merge. The *promise* is cached rather than
    // the key so two concurrent evaluations in one isolate derive once, not
    // twice. The derived key is non-extractable and the secret is already in
    // this isolate's `env`, so the cache widens nothing.
    if (derivedKeyCache?.secret !== secret) {
      derivedKeyCache = { secret, key: deriveSecretKey(secret) };
    }
    return ok(await derivedKeyCache.key);
  } catch (error) {
    // Never leave a rejected promise memoized: the next request would replay
    // the same failure forever without retrying the derivation.
    derivedKeyCache = null;
    return err(toAppError(error, "deriveSecretKey", {}));
  }
}

/** @see resolveKey — one entry, because one instance has one `DEPLOY_SECRET_KEY`. */
let derivedKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

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
 * Resolves plaintext secret values. **The only read path for a value anywhere
 * in the codebase**, and the rule for a caller is that the plaintext goes
 * straight into the one outbound request that needs it and is never returned,
 * rendered, logged, or interpolated into an error.
 *
 * Two callers today: the deploy runner (`deploy/runner.ts`), and BYOK provider
 * resolution (`evaluation/llm-byok.ts`), which the change-creation and
 * re-evaluation routes reach synchronously. The comment that used to stand here
 * said no route may call it; that stopped being true when BYOK landed, and a
 * rule nobody can follow is worse than the honest one above.
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
