/**
 * Short-lived git credentials for one workspace's smart-HTTP remote (#408).
 *
 * Minted by `stratum_workspace_remote` so an agent working in a local checkout
 * can `git fetch`/`git push` its workspace without a long-lived API token set
 * up out of band. The credential is an `api_tokens` row (see migration 065)
 * with three restrictions no ordinary token has:
 *
 * - **Git only, one workspace.** The plaintext carries `stratum_git_`, a prefix
 *   only `git-http.ts` accepts, and that router lets it reach exactly the
 *   workspace it names — never the project URL, never another workspace, never
 *   the REST API or `/mcp`.
 * - **Short-lived.** At most {@link MAX_WORKSPACE_GIT_TTL_MINUTES}, and never
 *   past the minting credential's own expiry.
 * - **Tied to its parent.** The minting credential is re-checked on every use,
 *   so revoking it, letting it expire, or rotating the legacy key ends the
 *   child immediately. That is what makes it safe for a scoped token or an
 *   OAuth grant to mint one, which `cannotMintLegacyCredential` otherwise
 *   forbids for exactly the reason it cannot apply here: those refusals exist
 *   because the minted credential would outlive its minter's revocation.
 *
 * The plaintext exists only in the mint's return value. Nothing here logs it.
 */
import type { CredentialBinding, User } from "../types";
import { generateApiKey, hashToken } from "../utils/crypto";
import { AppError, NotFoundError, RejectedCredentialError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { isExpired, narrowTokenBinding, narrowTokenScope } from "./api-tokens";
import { narrowOAuthScope } from "./oauth";

/** The plaintext prefix. Distinct from `stratum_user_` so the API middleware,
 * which accepts only the prefixes it knows, refuses it without a lookup. */
export const WORKSPACE_GIT_TOKEN_PREFIX = "stratum_git";

export const DEFAULT_WORKSPACE_GIT_TTL_MINUTES = 60;
export const MIN_WORKSPACE_GIT_TTL_MINUTES = 5;
export const MAX_WORKSPACE_GIT_TTL_MINUTES = 60;

/** Live workspace credentials one user may hold at once. Separate from the
 * API-token cap so an agent re-minting through the day cannot exhaust the
 * user's ordinary tokens, and bounded so a runaway loop cannot mint without
 * limit. At an hour each, twenty is far beyond what one workspace needs. */
export const MAX_LIVE_WORKSPACE_GIT_CREDENTIALS = 20;

/** Expired rows are kept this long (the audit log keeps the mint for good),
 * then pruned on the owner's next mint so short-lived rows do not pile up. */
const EXPIRED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How many hex characters of `users.token_hash` identify the legacy key a
 * child was minted from. 64 bits of a hash: enough to notice a rotation, and
 * no more sensitive than the hash itself, which lives in the same database. */
const LEGACY_FINGERPRINT_LENGTH = 16;

/** The credential that is minting, as the route reads it off the context. */
export type MintingCredential =
  | { kind: "api_token"; id: string }
  | { kind: "oauth_grant"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "legacy_token" };

/** The stored parent reference. */
type ParentRef =
  | { kind: "api_token" | "oauth_grant" | "agent"; id: string }
  | { kind: "legacy_token"; id: string };

export interface MintedWorkspaceGitCredential {
  id: string;
  /** The only time the plaintext exists outside the caller's own storage. */
  plaintext: string;
  expiresAt: string;
}

/** What a presented `stratum_git_` credential resolved to. */
export interface ResolvedWorkspaceGitCredential {
  user: User;
  tokenId: string;
  /** Set when an agent minted it: the git request then acts as that agent. */
  agentId?: string;
  projectId: string;
  workspaceName: string;
  workspaceCreatedAt: string;
  /** The minting token's own binding (#323). Git authz requires it to cover
   * the project as well as the child's, so a project moved out of an org the
   * parent was bound to takes the child with it. */
  parentBinding: CredentialBinding;
}

function dbError(error: unknown, operation: string): AppError {
  return error instanceof AppError
    ? error
    : new AppError(
        error instanceof Error ? error.message : `Failed in ${operation}`,
        "DATABASE_ERROR",
        500,
        { operation },
      );
}

function legacyFingerprint(tokenHash: string): string {
  return tokenHash.slice(0, LEGACY_FINGERPRINT_LENGTH);
}

/** Why a parent no longer authorizes its children. */
type ParentFailure = "revoked" | "expired";

interface ParentStatus {
  /** When the parent stops being valid, or null if it never expires. */
  expiresAtMs: number | null;
  binding: CredentialBinding;
  agentId?: string;
}

/**
 * Is the parent still a live, WRITE-capable credential of `userId`?
 *
 * Shared by mint and resolve, so "may this parent mint" and "does this parent
 * still authorize its child" can never disagree. Every lookup is keyed on
 * `userId` as well as the id, so a parent reference cannot be pointed at
 * someone else's credential. A missing row reads as revoked.
 */
async function parentStatus(
  db: D1Database,
  userId: string,
  userTokenHash: string,
  parent: ParentRef,
): Promise<Result<ParentStatus, ParentFailure>> {
  switch (parent.kind) {
    case "api_token": {
      const row = await db
        .prepare(
          `SELECT scope, expires_at, revoked_at, binding_kind, binding_id
             FROM api_tokens WHERE id = ? AND user_id = ? AND purpose = 'api'`,
        )
        .bind(parent.id, userId)
        .first<{
          scope: string;
          expires_at: string | null;
          revoked_at: string | null;
          binding_kind: string | null;
          binding_id: string | null;
        }>();
      if (!row || row.revoked_at !== null) return err("revoked");
      if (isExpired(row.expires_at)) return err("expired");
      if (narrowTokenScope(row.scope) !== "read_write") return err("revoked");
      const binding = narrowTokenBinding(row.binding_kind, row.binding_id);
      if (binding === null) return err("revoked");
      return ok({
        expiresAtMs: row.expires_at === null ? null : Date.parse(row.expires_at),
        binding,
      });
    }
    case "oauth_grant": {
      const row = await db
        .prepare(
          `SELECT scope, access_expires_at, refresh_expires_at, revoked_at
             FROM oauth_tokens WHERE id = ? AND user_id = ?`,
        )
        .bind(parent.id, userId)
        .first<{
          scope: string;
          access_expires_at: string;
          refresh_expires_at: string | null;
          revoked_at: string | null;
        }>();
      if (!row || row.revoked_at !== null) return err("revoked");
      // The GRANT, not the access token that happened to present it: the
      // grant lives as long as either half can still be used.
      const accessLive = !isExpired(row.access_expires_at);
      const refreshLive = row.refresh_expires_at !== null && !isExpired(row.refresh_expires_at);
      if (!accessLive && !refreshLive) return err("expired");
      if (narrowOAuthScope(row.scope) !== "read_write") return err("revoked");
      const ends = [row.access_expires_at, row.refresh_expires_at]
        .filter((value): value is string => value !== null)
        .map((value) => Date.parse(value))
        .filter((value) => Number.isFinite(value));
      return ok({
        expiresAtMs: ends.length > 0 ? Math.max(...ends) : Date.now(),
        binding: { kind: "unbound" },
      });
    }
    case "agent": {
      const row = await db
        .prepare("SELECT id FROM agents WHERE id = ? AND owner_id = ?")
        .bind(parent.id, userId)
        .first<{ id: string }>();
      if (!row) return err("revoked");
      return ok({ expiresAtMs: null, binding: { kind: "unbound" }, agentId: row.id });
    }
    case "legacy_token": {
      if (legacyFingerprint(userTokenHash) !== parent.id) return err("revoked");
      return ok({ expiresAtMs: null, binding: { kind: "unbound" } });
    }
  }
}

/**
 * Mint a credential for one workspace.
 *
 * The caller (the route) has already authorized the minter for write on the
 * workspace and applied the org second-factor rule. This layer re-checks the
 * parent itself, caps the lifetime at the parent's, enforces the live cap and
 * prunes the owner's long-expired rows.
 */
export async function mintWorkspaceGitCredential(
  db: D1Database,
  logger: Logger,
  opts: {
    userId: string;
    minter: MintingCredential;
    projectId: string;
    projectRef: string;
    workspaceName: string;
    workspaceCreatedAt: string;
    ttlMinutes: number;
  },
): Promise<Result<MintedWorkspaceGitCredential, AppError>> {
  const { userId, minter, projectId, workspaceName, workspaceCreatedAt, ttlMinutes } = opts;
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < MIN_WORKSPACE_GIT_TTL_MINUTES ||
    ttlMinutes > MAX_WORKSPACE_GIT_TTL_MINUTES
  ) {
    return err(
      new AppError(
        `expiresInMinutes must be an integer between ${MIN_WORKSPACE_GIT_TTL_MINUTES} and ${MAX_WORKSPACE_GIT_TTL_MINUTES}`,
        "VALIDATION_ERROR",
        400,
      ),
    );
  }

  try {
    const user = await db
      .prepare("SELECT token_hash FROM users WHERE id = ?")
      .bind(userId)
      .first<{ token_hash: string }>();
    if (!user) return err(new AppError("Unknown user", "AUTH_ERROR", 401));

    const parent: ParentRef =
      minter.kind === "legacy_token"
        ? { kind: "legacy_token", id: legacyFingerprint(user.token_hash) }
        : minter;
    const status = await parentStatus(db, userId, user.token_hash, parent);
    if (!status.success) {
      return err(
        new AppError("The credential minting this one is no longer valid", "AUTH_ERROR", 401),
      );
    }

    const now = Date.now();
    const existing = await db
      .prepare(
        `SELECT id, expires_at, revoked_at FROM api_tokens
          WHERE user_id = ? AND purpose = 'workspace_git'`,
      )
      .bind(userId)
      .all<{ id: string; expires_at: string | null; revoked_at: string | null }>();
    const rows = existing.results ?? [];
    // Compared in JavaScript, never SQL: see `isExpired`.
    const stale = rows.filter((row) => {
      const at = row.expires_at === null ? Number.NaN : Date.parse(row.expires_at);
      return !Number.isFinite(at) || at <= now - EXPIRED_RETENTION_MS;
    });
    for (const row of stale) {
      await db.prepare("DELETE FROM api_tokens WHERE id = ?").bind(row.id).run();
    }
    const live = rows.filter((row) => row.revoked_at === null && !isExpired(row.expires_at));
    if (live.length >= MAX_LIVE_WORKSPACE_GIT_CREDENTIALS) {
      return err(
        new AppError(
          `At most ${MAX_LIVE_WORKSPACE_GIT_CREDENTIALS} live workspace remote credentials per user. Wait for one to expire.`,
          "TOKEN_LIMIT_REACHED",
          409,
        ),
      );
    }

    const requested = now + ttlMinutes * 60 * 1000;
    const capped =
      status.data.expiresAtMs === null ? requested : Math.min(requested, status.data.expiresAtMs);
    if (!Number.isFinite(capped) || capped <= now) {
      return err(new AppError("The minting credential is about to expire", "AUTH_ERROR", 401));
    }
    const expiresAt = new Date(capped).toISOString();

    const plaintext = await generateApiKey(WORKSPACE_GIT_TOKEN_PREFIX);
    const id = newId("tok");
    await db
      .prepare(
        `INSERT INTO api_tokens
           (id, user_id, name, token_hash, token_prefix, scope, expires_at, created_at,
            binding_kind, binding_id, purpose, workspace_name, workspace_created_at,
            parent_kind, parent_id)
         VALUES (?, ?, ?, ?, ?, 'read_write', ?, ?, 'project', ?, 'workspace_git', ?, ?, ?, ?)`,
      )
      .bind(
        id,
        userId,
        `Workspace remote: ${opts.projectRef}/${workspaceName}`,
        await hashToken(plaintext),
        plaintext.slice(0, `${WORKSPACE_GIT_TOKEN_PREFIX}_`.length + 8),
        expiresAt,
        new Date(now).toISOString(),
        projectId,
        workspaceName,
        workspaceCreatedAt,
        parent.kind,
        parent.id,
      )
      .run();

    logger.info("Workspace git credential minted", {
      userId,
      tokenId: id,
      projectId,
      workspaceName,
      parentKind: parent.kind,
      expiresAt,
    });
    return ok({ id, plaintext, expiresAt });
  } catch (error) {
    const appError = dbError(error, "mintWorkspaceGitCredential");
    logger.error("Failed to mint workspace git credential", appError, { userId });
    return err(appError);
  }
}

interface ResolvedRow {
  user_id: string;
  email: string;
  username: string;
  github_id: string | null;
  github_username: string | null;
  user_token_hash: string;
  user_created_at: string;
  deleting_at: string | null;
  disabled_at: string | null;
  telemetry_opt_out: number | null;
  token_id: string;
  expires_at: string | null;
  revoked_at: string | null;
  binding_kind: string | null;
  binding_id: string | null;
  workspace_name: string | null;
  workspace_created_at: string | null;
  parent_kind: string | null;
  parent_id: string | null;
}

function storedParent(kind: string | null, id: string | null): ParentRef | null {
  if (id === null || id.length === 0) return null;
  switch (kind) {
    case "api_token":
    case "oauth_grant":
    case "agent":
    case "legacy_token":
      return { kind, id };
    default:
      return null;
  }
}

/**
 * Resolve a presented `stratum_git_` plaintext.
 *
 * Fails CLOSED on every branch, matching `resolveApiToken`: an unknown hash, a
 * revoked or expired credential, a dead parent, a deleting or disabled owner,
 * a malformed row, or a storage error. A rejection that names a real account
 * is a {@link RejectedCredentialError}, so git-http can audit it (#255).
 */
export async function resolveWorkspaceGitCredential(
  db: D1Database,
  plaintext: string,
  logger: Logger,
): Promise<Result<ResolvedWorkspaceGitCredential, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare(
        `SELECT u.id AS user_id, u.email, u.username, u.github_id, u.github_username,
                u.token_hash AS user_token_hash, u.created_at AS user_created_at,
                u.deleting_at, u.disabled_at, u.telemetry_opt_out,
                t.id AS token_id, t.expires_at, t.revoked_at, t.binding_kind, t.binding_id,
                t.workspace_name, t.workspace_created_at, t.parent_kind, t.parent_id
           FROM api_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = ? AND t.purpose = 'workspace_git'`,
      )
      .bind(await hashToken(plaintext))
      .first<ResolvedRow>();

    if (!row) return err(new NotFoundError("Token", "by-token"));
    const reject = (reason: "revoked" | "expired" | "owner-deleting" | "owner-disabled") =>
      err(new RejectedCredentialError(reason, row.user_id, row.token_id));
    if (row.revoked_at !== null) return reject("revoked");
    if (row.deleting_at !== null) return reject("owner-deleting");
    if (row.disabled_at != null) return reject("owner-disabled");
    // A workspace credential with no expiry is malformed, never immortal.
    if (row.expires_at === null || isExpired(row.expires_at)) return reject("expired");

    const binding = narrowTokenBinding(row.binding_kind, row.binding_id);
    const parent = storedParent(row.parent_kind, row.parent_id);
    if (
      binding === null ||
      binding.kind !== "project" ||
      parent === null ||
      row.workspace_name === null ||
      row.workspace_created_at === null
    ) {
      logger.warn("Workspace git credential is malformed; refusing it", { tokenId: row.token_id });
      return err(new NotFoundError("Token", "malformed"));
    }

    const status = await parentStatus(db, row.user_id, row.user_token_hash, parent);
    if (!status.success) return reject(status.error);

    const user: User = {
      id: row.user_id,
      email: row.email,
      username: row.username,
      tokenHash: row.user_token_hash,
      createdAt: row.user_created_at,
    };
    if (row.github_id !== null) user.githubId = row.github_id;
    if (row.github_username !== null) user.githubUsername = row.github_username;
    if (row.telemetry_opt_out === 1) user.telemetryOptOut = true;

    const resolved: ResolvedWorkspaceGitCredential = {
      user,
      tokenId: row.token_id,
      projectId: binding.projectId,
      workspaceName: row.workspace_name,
      workspaceCreatedAt: row.workspace_created_at,
      parentBinding: status.data.binding,
    };
    if (status.data.agentId !== undefined) resolved.agentId = status.data.agentId;
    return ok(resolved);
  } catch (error) {
    logger.warn("Workspace git credential lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return err(new AppError("Token lookup failed", "DATABASE_ERROR", 500));
  }
}
