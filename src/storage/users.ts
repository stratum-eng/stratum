import type { User } from "../types";
import { generateApiKey, hashToken } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { validateUsername } from "../utils/username-validation";

export interface CreateUserResult {
  user: User;
  plaintext: string;
}

interface UserRow {
  id: string;
  email: string;
  username: string;
  github_id: string | null;
  github_username: string | null;
  token_hash: string;
  created_at: string;
  // Added in migration 026; NULL on live accounts. `SELECT *` already fetches
  // it, so the auth hot path gets `deletingAt` without a second round-trip.
  deleting_at: string | null;
  // Added in migration 049; NULL on enabled accounts. Rides on the same row as
  // deleting_at so the auth hot path sees it for free.
  disabled_at: string | null;
  // Added in migration 041; 0 on accounts that never opted out. Rides the same
  // `SELECT *` as deleting_at, so the auth hot path learns the telemetry
  // preference without a second round-trip.
  telemetry_opt_out: number;
  // Added in migration 045; NULL until the user sets one. Optional in the type
  // because stub/legacy reads may omit the column entirely.
  display_name?: string | null;
}

/** Maps a users row to the public `User`, omitting nullable columns that are unset rather than carrying nulls. */
function rowToUser(row: UserRow): User {
  const user: User = {
    id: row.id,
    email: row.email,
    username: row.username,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
  };
  if (row.display_name != null && row.display_name !== "") user.displayName = row.display_name;
  if (row.github_id !== null) user.githubId = row.github_id;
  if (row.github_username !== null) user.githubUsername = row.github_username;
  // `deleting_at`/`disabled_at` may be absent when a stub/legacy read omits
  // the columns.
  if (row.deleting_at != null) user.deletingAt = row.deleting_at;
  if (row.disabled_at != null) user.disabledAt = row.disabled_at;
  // Compare against 1 rather than coercing: a stub/legacy read that omits the
  // column must mean "opted in" (today's behavior), never `undefined` leaking
  // into a truthiness test downstream.
  if (row.telemetry_opt_out === 1) user.telemetryOptOut = true;
  return user;
}

// Helper function to hash email for logging (privacy)
function hashEmail(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    const char = email.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

export async function createUser(
  db: D1Database,
  email: string,
  logger: Logger,
  preferredUsername?: string,
): Promise<Result<CreateUserResult, AppError>> {
  logger.debug("Creating user", { emailHash: hashEmail(email), preferredUsername });
  try {
    const id = newId("usr");
    const plaintext = await generateApiKey("stratum_user");
    const tokenHash = await hashToken(plaintext);

    // Validate and use preferred username if provided, otherwise generate from email
    let username: string;
    if (preferredUsername) {
      const validation = validateUsername(preferredUsername, logger);
      if (!validation.success) {
        return err(
          new AppError(
            validation.error[0]?.message ?? "Invalid username",
            "VALIDATION_ERROR",
            400,
            { preferredUsername },
          ),
        );
      }
      username = validation.data;
    } else {
      // Generate from email and validate
      const candidate = (email.split("@")[0] ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^[-0-9]+/, "")
        .replace(/-+$/, "");
      const validation = validateUsername(candidate, logger);
      if (!validation.success) {
        return err(
          new AppError(
            "Could not generate valid username from email. Please provide a preferred username.",
            "VALIDATION_ERROR",
            400,
            { email },
          ),
        );
      }
      username = validation.data;
    }

    await db
      .prepare("INSERT INTO users (id, email, username, token_hash) VALUES (?, ?, ?, ?)")
      .bind(id, email, username, tokenHash)
      .run();

    const user: User = {
      id,
      email,
      username,
      tokenHash,
      createdAt: new Date().toISOString(),
    };

    logger.info("User created", { userId: id, username, emailHash: hashEmail(email) });
    return ok({ user, plaintext });
  } catch (error) {
    logger.error("Failed to create user", error instanceof Error ? error : undefined, {
      emailHash: hashEmail(email),
    });
    return err(
      new AppError(`Failed to create user with email '${email}'`, "STORAGE_ERROR", 500, { email }),
    );
  }
}

/**
 * Rotate a user's API key: generates a new key and invalidates the old one
 * in a single update. Returns the new plaintext key — shown once, never stored.
 */
export async function rotateUserToken(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  try {
    const plaintext = await generateApiKey("stratum_user");
    const tokenHash = await hashToken(plaintext);

    const result = await db
      .prepare("UPDATE users SET token_hash = ? WHERE id = ?")
      .bind(tokenHash, userId)
      .run();
    if (result.meta.changes === 0) {
      return err(new AppError(`User '${userId}' not found`, "NOT_FOUND", 404, { userId }));
    }

    logger.info("User API key rotated", { userId });
    return ok(plaintext);
  } catch (error) {
    logger.error("Failed to rotate user token", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(new AppError("Failed to rotate API key", "STORAGE_ERROR", 500, { userId }));
  }
}

/**
 * Mark an account as soft-`deleting` (sets users.deleting_at = now). This
 * immediately invalidates the caller's credentials via the auth middleware
 * (Task 4.1) and is the marker the sweep uses to guarantee the cascade runs.
 * Idempotent: re-marking keeps the original timestamp so the grace window
 * isn't extended by repeated requests.
 */
export async function markUserDeleting(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  const now = new Date().toISOString();
  try {
    const result = await db
      .prepare("UPDATE users SET deleting_at = COALESCE(deleting_at, ?) WHERE id = ?")
      .bind(now, userId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      return err(new AppError(`User '${userId}' not found`, "NOT_FOUND", 404, { userId }));
    }
    logger.info("User marked deleting", { userId });
    return ok(now);
  } catch (error) {
    logger.error("Failed to mark user deleting", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(new AppError("Failed to mark user deleting", "STORAGE_ERROR", 500, { userId }));
  }
}

/**
 * Reversibly disable an account (sets users.disabled_at = now). Every
 * credential path — auth middleware, git smart-HTTP, and the login flows —
 * rejects while the flag is set; `enableUser` restores the same credentials.
 * Idempotent: re-disabling keeps the earliest timestamp, so repeated SCIM
 * deprovision requests don't rewrite when the account was actually disabled.
 */
export async function disableUser(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  const now = new Date().toISOString();
  try {
    // RETURNING so the caller gets the STORED timestamp: on an idempotent
    // re-disable, COALESCE keeps the earlier one, and an audit/SCIM response
    // built from this value must not misreport when disablement happened.
    const row = await db
      .prepare(
        "UPDATE users SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ? RETURNING disabled_at",
      )
      .bind(now, userId)
      .first<{ disabled_at: string }>();
    if (!row) {
      return err(new AppError(`User '${userId}' not found`, "NOT_FOUND", 404, { userId }));
    }
    logger.info("User disabled", { userId });
    return ok(row.disabled_at);
  } catch (error) {
    logger.error("Failed to disable user", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(new AppError("Failed to disable user", "STORAGE_ERROR", 500, { userId }));
  }
}

/**
 * Re-enable a disabled account (clears users.disabled_at). The user's existing
 * credentials — tokens, agents, sessions that survived — work again. Idempotent
 * on an already-enabled account.
 */
export async function enableUser(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    const result = await db
      .prepare("UPDATE users SET disabled_at = NULL WHERE id = ?")
      .bind(userId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      return err(new AppError(`User '${userId}' not found`, "NOT_FOUND", 404, { userId }));
    }
    logger.info("User enabled", { userId });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to enable user", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(new AppError("Failed to enable user", "STORAGE_ERROR", 500, { userId }));
  }
}

/**
 * Set the user's product-analytics preference (#257). `true` stops PostHog
 * export for their requests and for domain events they author, starting with
 * the next request — it does not delete events already sent.
 */
export async function setUserTelemetryOptOut(
  db: D1Database,
  userId: string,
  optOut: boolean,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    const result = await db
      .prepare("UPDATE users SET telemetry_opt_out = ? WHERE id = ?")
      .bind(optOut ? 1 : 0, userId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      return err(new AppError(`User '${userId}' not found`, "NOT_FOUND", 404, { userId }));
    }
    logger.info("User telemetry preference updated", { userId, optOut });
    return ok(undefined);
  } catch (error) {
    logger.error(
      "Failed to update telemetry preference",
      error instanceof Error ? error : undefined,
      { userId },
    );
    return err(
      new AppError("Failed to update telemetry preference", "STORAGE_ERROR", 500, { userId }),
    );
  }
}

/**
 * Set or clear the display name. `null` clears it, so the header falls back to
 * the username. The caller trims and bounds the value; this only stores it.
 */
export async function setUserDisplayName(
  db: D1Database,
  userId: string,
  displayName: string | null,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Setting display name", { userId, cleared: displayName === null });
  try {
    await db
      .prepare("UPDATE users SET display_name = ? WHERE id = ?")
      .bind(displayName, userId)
      .run();
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to set display name", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(new AppError("Failed to set display name", "STORAGE_ERROR", 500, { userId }));
  }
}

/**
 * Change a username.
 *
 * The username is the namespace in every project URL, clone URL, KV project
 * key and backing repository name, and nothing here rewrites those. So the
 * change is refused once the account has created a project — checked inside
 * the UPDATE itself against `namespace_claims`, which creation writes before
 * a project's KV entry (see storage/project-namespace.ts), so a claim and a
 * rename racing each other resolve in D1 rather than across two stores. The
 * caller also lists KV for projects that predate claims. This validates the
 * new name and enforces uniqueness; a taken name comes back as a 409 rather
 * than a 500, since it is the user's to fix.
 */
export async function renameUser(
  db: D1Database,
  userId: string,
  newUsername: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  const validation = validateUsername(newUsername, logger);
  if (!validation.success) {
    return err(
      new AppError(validation.error[0]?.message ?? "Invalid username", "VALIDATION_ERROR", 400),
    );
  }
  const username = validation.data;
  logger.debug("Renaming user", { userId, username });
  try {
    const result = await db
      .prepare(
        "UPDATE users SET username = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM namespace_claims WHERE owner_id = ?)",
      )
      .bind(username, userId, userId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      // Nothing changed: either the row is gone or a claim held the name.
      const exists = await db.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
      if (exists === null) {
        return err(new AppError(`User '${userId}' not found`, "NOT_FOUND", 404, { userId }));
      }
      return err(
        new AppError(
          "Your username cannot be changed while you own projects: every project URL is keyed under it. If you have just deleted your last project, allow up to 15 minutes.",
          "FORBIDDEN",
          403,
          { userId },
        ),
      );
    }
    logger.info("User renamed", { userId, username });
    return ok(username);
  } catch (error) {
    // idx_users_username is UNIQUE; D1 reports a collision as a constraint error.
    if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) {
      return err(
        new AppError("That username is already taken.", "CONFLICT", 409, { userId, username }),
      );
    }
    logger.error("Failed to rename user", error instanceof Error ? error : undefined, { userId });
    return err(new AppError("Failed to rename user", "STORAGE_ERROR", 500, { userId }));
  }
}

export async function getUser(
  db: D1Database,
  id: string,
  logger: Logger,
): Promise<Result<User, NotFoundError>> {
  logger.debug("Fetching user", { id });
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();

  if (!row) {
    return err(new NotFoundError("User", id));
  }

  return ok(rowToUser(row));
}

export async function getUserByToken(
  db: D1Database,
  plaintext: string,
  logger: Logger,
): Promise<Result<User, NotFoundError>> {
  logger.debug("Fetching user by token");
  const tokenHash = await hashToken(plaintext);
  const row = await db
    .prepare("SELECT * FROM users WHERE token_hash = ?")
    .bind(tokenHash)
    .first<UserRow>();

  if (!row) {
    return err(new NotFoundError("User", "by-token"));
  }

  return ok(rowToUser(row));
}

export async function getUserByGitHubId(
  db: D1Database,
  githubId: string,
  logger: Logger,
): Promise<Result<User, NotFoundError>> {
  logger.debug("Fetching user by GitHub ID", { githubId });
  const row = await db
    .prepare("SELECT * FROM users WHERE github_id = ?")
    .bind(githubId)
    .first<UserRow>();

  if (!row) {
    return err(new NotFoundError("User", githubId));
  }

  return ok(rowToUser(row));
}

export async function getUserByEmail(
  db: D1Database,
  email: string,
  logger: Logger,
): Promise<Result<User, NotFoundError>> {
  logger.debug("Fetching user by email", { emailHash: hashEmail(email) });
  const row = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();

  if (!row) {
    return err(new NotFoundError("User", email));
  }

  return ok(rowToUser(row));
}

export async function getUserByUsername(
  db: D1Database,
  username: string,
  logger: Logger,
): Promise<Result<User, NotFoundError>> {
  logger.debug("Fetching user by username", { username });
  const row = await db
    .prepare("SELECT * FROM users WHERE username = ?")
    .bind(username)
    .first<UserRow>();

  if (!row) {
    return err(new NotFoundError("User", username));
  }

  return ok(rowToUser(row));
}

export async function linkGitHub(
  db: D1Database,
  userId: string,
  githubId: string,
  username: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  logger.debug("Linking GitHub account", { userId, githubId, username });
  try {
    await db
      .prepare("UPDATE users SET github_id = ?, github_username = ? WHERE id = ?")
      .bind(githubId, username, userId)
      .run();
    logger.info("GitHub account linked", { userId, githubId });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to link GitHub account", error instanceof Error ? error : undefined, {
      userId,
      githubId,
    });
    return err(
      new AppError(`Failed to link GitHub account for user '${userId}'`, "STORAGE_ERROR", 500, {
        userId,
        githubId,
      }),
    );
  }
}

/**
 * The account behind a verified GitHub identity — `ok(null)` when there is none.
 *
 * Matches by GitHub id first, then by the *verified* email, linking the identity
 * to that account on first use so the next sign-in matches by id.
 *
 * It deliberately does NOT create an account. Account creation is the one thing
 * the closed-beta gate exists to hold, and it lives on a single path for every
 * signup method: the `/auth/signup/complete` form, which collects the username
 * and (while the gate is on) the invite code. A create branch here would be an
 * SSO-shaped way around that gate, guarded only by the caller remembering to
 * check first — so instead a first-time identity comes back as `null` and the
 * callback parks it for that form.
 */
export async function signInGitHubUser(
  db: D1Database,
  opts: { githubId: string; email: string; username: string },
  logger: Logger,
): Promise<Result<User | null, AppError>> {
  logger.debug("Resolving GitHub identity", {
    githubId: opts.githubId,
    emailHash: hashEmail(opts.email),
  });

  const byGitHubId = await getUserByGitHubId(db, opts.githubId, logger);
  if (byGitHubId.success) {
    logger.debug("Found existing user by GitHub ID", { userId: byGitHubId.data.id });
    return ok(byGitHubId.data);
  }

  const byEmail = await getUserByEmail(db, opts.email, logger);
  if (byEmail.success) {
    // Never link onto a frozen (SCIM-disabled or deleting) account: the link
    // would hand it a working GitHub login the moment it is re-enabled. The
    // row is returned unlinked so the caller refuses the sign-in (#253).
    if (byEmail.data.disabledAt || byEmail.data.deletingAt) {
      logger.warn("Matched a disabled or deleting account by email; not linking GitHub", {
        userId: byEmail.data.id,
      });
      return ok(byEmail.data);
    }
    logger.debug("Found existing user by email, linking GitHub", { userId: byEmail.data.id });
    const linkResult = await linkGitHub(db, byEmail.data.id, opts.githubId, opts.username, logger);
    if (!linkResult.success) {
      return err(linkResult.error);
    }
    const updated = await getUser(db, byEmail.data.id, logger);
    if (!updated.success) {
      return err(
        new AppError(`User ${byEmail.data.id} not found after linkGitHub`, "NOT_FOUND", 404, {
          userId: byEmail.data.id,
        }),
      );
    }
    return ok(updated.data);
  }

  logger.debug("No account for this GitHub identity", {
    githubId: opts.githubId,
    emailHash: hashEmail(opts.email),
  });
  return ok(null);
}

/**
 * Makes the legacy `users.token_hash` credential unusable.
 *
 * The column is NOT NULL and uniquely indexed, so it cannot simply be cleared —
 * it is instead rotated to a fresh random value that is never returned to
 * anyone, which is the same thing from the outside. Without this, every account
 * that existed before scoped tokens would permanently keep one un-revocable,
 * un-expiring, unnamed full-power credential alongside its scoped ones.
 */
export async function disableLegacyToken(
  db: D1Database,
  userId: string,
  logger: Logger,
): Promise<Result<void, AppError>> {
  try {
    const unknowable = await generateApiKey("stratum_user_disabled");
    await db
      .prepare("UPDATE users SET token_hash = ? WHERE id = ?")
      .bind(await hashToken(unknowable), userId)
      .run();
    logger.info("Legacy token disabled", { userId });
    return ok(undefined);
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError("Failed to disable legacy token", "DATABASE_ERROR", 500);
    logger.error("Failed to disable legacy token", appError, { userId });
    return err(appError);
  }
}
