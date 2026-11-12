/**
 * Who a promoted pull request is opened as on GitHub.
 *
 * GitHub makes a pull request's author whoever's token created it. With the
 * app's installation token that is the app's bot, and everything on GitHub
 * that keys on the author then sees a bot: a review tool asks for a seat for
 * it, and the person whose agent wrote the code can approve it themselves.
 *
 * So the pull request is opened as the person promoting, when they have
 * connected their GitHub account. Never anyone else. A change opened by one
 * person and promoted by another is the promoter's pull request, as it would be had they
 * pushed the branch themselves; nobody's identity is used for an action they
 * took no part in.
 *
 * Everything here fails towards the app. A missing secret, no connection, a
 * token GitHub will not refresh, a database error: each one yields the app as
 * author and a reason, never a failed promotion.
 */

import {
  type GitHubAppOAuthConfig,
  type GitHubAppUserTokens,
  githubAppOAuthConfig,
  refreshGitHubAppUserTokens,
  revokeGitHubAppUserToken,
} from "../github/user-access";
import {
  type ConnectionTokens,
  claimRefresh,
  deleteConnection,
  readConnection,
  releaseRefresh,
  storeRefreshedTokens,
} from "../storage/github-user-connections";
import type { Env } from "../types";
import type { Logger } from "../utils/logger";

/**
 * A token this close to expiry is refreshed first: the pull request call that
 * follows has its own retries, and a token that dies between two of them
 * would read as GitHub refusing the person.
 */
const EXPIRY_MARGIN_SECONDS = 120;

/** Why a pull request was opened as the app although the feature exists. */
export type AppAuthorReason =
  /** The deployment has not turned the feature on. */
  | "not_configured"
  /** The person promoting has not connected a GitHub account. */
  | "not_connected"
  /** Their authorization lapsed or was revoked; they need to connect again. */
  | "connection_expired"
  /** Another promotion of theirs was refreshing the token at that moment. */
  | "refresh_in_progress"
  /** The connection could not be read or refreshed just now. */
  | "unavailable"
  /** GitHub would not let them open this pull request. */
  | "github_refused";

export type PrAuthor =
  | { kind: "user"; userId: string; githubLogin: string; token: string }
  | { kind: "app"; reason: AppAuthorReason };

/** What the feature needs from the deployment; null when it is off. */
export interface UserConnectionConfig {
  oauth: GitHubAppOAuthConfig;
  secret: string;
}

type ConnectionEnv = Pick<
  Env,
  "GITHUB_APP_CLIENT_ID" | "GITHUB_APP_CLIENT_SECRET" | "GITHUB_USER_TOKEN_SECRET"
>;

/**
 * The deployment's configuration for connecting GitHub accounts.
 *
 * @param env - Worker environment
 * @returns The app's OAuth credentials and the encryption secret, or null when
 *   either is missing and nobody can connect
 */
export function userConnectionConfig(env: ConnectionEnv): UserConnectionConfig | null {
  const oauth = githubAppOAuthConfig(env);
  const secret = env.GITHUB_USER_TOKEN_SECRET?.trim();
  if (!oauth || !secret) return null;
  return { oauth, secret };
}

/**
 * Turns the lifetimes GitHub reports into the expiry times that are stored.
 *
 * @param tokens - What the token endpoint answered
 * @param nowSeconds - When it answered, epoch seconds
 * @returns The same tokens with absolute expiries
 */
export function toConnectionTokens(
  tokens: GitHubAppUserTokens,
  nowSeconds: number,
): ConnectionTokens {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.accessExpiresIn !== undefined
      ? { accessExpiresAt: nowSeconds + tokens.accessExpiresIn }
      : {}),
    ...(tokens.refreshExpiresIn !== undefined
      ? { refreshExpiresAt: nowSeconds + tokens.refreshExpiresIn }
      : {}),
  };
}

/**
 * Decides who opens a promoted pull request, and returns their token when it
 * is a person.
 *
 * @param env - Worker environment
 * @param actingUserId - The person promoting; undefined when the caller is
 *   not a person
 * @param logger - Request logger
 * @param nowMs - The current time; a parameter so tests can move it
 * @returns The person and a usable token, or the app and why
 */
export async function resolvePrAuthor(
  env: ConnectionEnv & Pick<Env, "DB">,
  actingUserId: string | undefined,
  logger: Logger,
  nowMs: number = Date.now(),
): Promise<PrAuthor> {
  const config = userConnectionConfig(env);
  if (!config) return { kind: "app", reason: "not_configured" };
  if (actingUserId === undefined) return { kind: "app", reason: "not_connected" };

  const stored = await readConnection(env.DB, config.secret, actingUserId, logger);
  if (!stored.success) return { kind: "app", reason: "unavailable" };
  const connection = stored.data;
  if (!connection) return { kind: "app", reason: "not_connected" };

  const asUser = (token: string): PrAuthor => ({
    kind: "user",
    userId: actingUserId,
    githubLogin: connection.githubLogin,
    token,
  });
  const nowSeconds = Math.floor(nowMs / 1000);
  const { accessExpiresAt, refreshToken, refreshExpiresAt } = connection;
  if (accessExpiresAt === undefined || accessExpiresAt - nowSeconds > EXPIRY_MARGIN_SECONDS) {
    return asUser(connection.accessToken);
  }

  const lapsed = async (): Promise<PrAuthor> => {
    await deleteConnection(env.DB, actingUserId, logger);
    logger.info("GitHub connection lapsed; removed", { userId: actingUserId });
    return { kind: "app", reason: "connection_expired" };
  };
  if (refreshToken === undefined) return lapsed();
  if (refreshExpiresAt !== undefined && refreshExpiresAt <= nowSeconds) return lapsed();

  // A refresh token works once. Of two promotions that both got here, only the
  // one holding the lease may spend it.
  const claimed = await claimRefresh(env.DB, actingUserId, nowSeconds, logger);
  if (!claimed.success) return { kind: "app", reason: "unavailable" };
  if (!claimed.data) return { kind: "app", reason: "refresh_in_progress" };

  const refreshed = await refreshGitHubAppUserTokens(config.oauth, refreshToken, logger);
  if (!refreshed.success) {
    // GitHub was not reached, so the refresh token is presumably unspent.
    await releaseRefresh(env.DB, actingUserId, logger);
    return { kind: "app", reason: "unavailable" };
  }
  if (refreshed.data === null) return lapsed();

  const saved = await storeRefreshedTokens(
    env.DB,
    config.secret,
    actingUserId,
    toConnectionTokens(refreshed.data, nowSeconds),
    logger,
  );
  if (!saved.success) {
    // The new pair is good for this request but is not on record, and the old
    // refresh token is spent: the next refresh will be refused and the
    // connection removed. Said loudly, because the person will have to connect
    // again without having done anything.
    logger.error("Refreshed GitHub tokens were not stored; the connection will lapse", undefined, {
      userId: actingUserId,
    });
  }
  return asUser(refreshed.data.accessToken);
}

/**
 * Removes a connection GitHub has just answered 401 for: the token is dead,
 * and keeping it would send every later promotion through the same failure.
 *
 * @param env - Worker environment
 * @param userId - Whose connection it was
 * @param logger - Request logger
 */
export async function dropRejectedConnection(
  env: Pick<Env, "DB">,
  userId: string,
  logger: Logger,
): Promise<void> {
  await deleteConnection(env.DB, userId, logger);
  logger.info("GitHub rejected a stored user token; connection removed", { userId });
}

/**
 * Removes a person's connection and asks GitHub to revoke its token, for an
 * account that is being erased. The row always goes; revocation is best
 * effort, since a token that cannot be read cannot be named to GitHub.
 *
 * @param env - Worker environment
 * @param userId - Whose connection to remove
 * @param logger - Request logger
 * @returns False only when the row could not be removed
 */
export async function forgetConnection(
  env: ConnectionEnv & Pick<Env, "DB">,
  userId: string,
  logger: Logger,
): Promise<boolean> {
  const config = userConnectionConfig(env);
  const stored = config ? await readConnection(env.DB, config.secret, userId, logger) : undefined;
  const removed = await deleteConnection(env.DB, userId, logger);
  if (config && stored?.success && stored.data) {
    await revokeGitHubAppUserToken(config.oauth, stored.data.accessToken, logger);
  }
  return removed.success;
}
