import type { User } from "../types";
import { generateApiKey, hashToken } from "../utils/crypto";
import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

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
}

function rowToUser(row: UserRow): User {
  const user: User = {
    id: row.id,
    email: row.email,
    username: row.username,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
  };
  if (row.github_id !== null) user.githubId = row.github_id;
  if (row.github_username !== null) user.githubUsername = row.github_username;
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

    // Use preferred username if provided, otherwise generate from email
    const username = preferredUsername
      ? preferredUsername.toLowerCase().replace(/[^a-z0-9]/g, "")
      : (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

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

export async function upsertGitHubUser(
  db: D1Database,
  opts: { githubId: string; email: string; username: string },
  logger: Logger,
): Promise<Result<User, AppError>> {
  logger.debug("Upserting GitHub user", {
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

  logger.debug("Creating new user for GitHub account", { emailHash: hashEmail(opts.email) });
  const createResult = await createUser(db, opts.email, logger);
  if (!createResult.success) {
    return err(createResult.error);
  }
  const { user } = createResult.data;
  const linkResult = await linkGitHub(db, user.id, opts.githubId, opts.username, logger);
  if (!linkResult.success) {
    return err(linkResult.error);
  }
  const linked = await getUser(db, user.id, logger);
  if (!linked.success) {
    return err(
      new AppError(`User ${user.id} not found after createUser`, "NOT_FOUND", 404, {
        userId: user.id,
      }),
    );
  }
  return ok(linked.data);
}
