/**
 * What a person can manage on GitHub right now, asked of GitHub with their own
 * user-to-server token (#442).
 *
 * This is the GitHub App's OAuth identity (`GITHUB_APP_CLIENT_ID` /
 * `GITHUB_APP_CLIENT_SECRET`), not the login OAuth app's (`GITHUB_CLIENT_ID`):
 * only a token minted for the app can list the app's installations.
 *
 * The user token never leaves this module's callers' stack frames. It is not
 * stored, not returned inside an error, and not logged — every log line here
 * carries an HTTP status or a fixed string, never a response body, because the
 * token-exchange response body IS the token.
 */

import type { GitHubInstallation } from "../storage/github-installations";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 10_000;

const INSTALLATIONS_PER_PAGE = 100;
/**
 * A ceiling on pagination, so a misbehaving upstream cannot keep a request
 * alive. An installation past it is simply not found, and an organization
 * membership past it is not seen; either refuses the link.
 */
const MAX_INSTALLATION_PAGES = 10;

/** Where GitHub sends the browser back to; must be registered on the app. */
export const GITHUB_APP_CALLBACK_PATH = "/github/app/callback";

export interface GitHubAppOAuthConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * The app's OAuth credentials, or null when either is missing. Callers refuse
 * to link on null: there is deliberately no other rule to fall back to.
 *
 * @param env - Worker environment
 * @returns The credentials, or null when linking is not configured
 */
export function githubAppOAuthConfig(
  env: Pick<Env, "GITHUB_APP_CLIENT_ID" | "GITHUB_APP_CLIENT_SECRET">,
): GitHubAppOAuthConfig | null {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * The callback URL for this deployment. `APP_URL` wins when set, so a
 * deployment reachable under several hostnames always names the one registered
 * on the GitHub App; otherwise the request's own origin is used.
 *
 * @param env - Worker environment
 * @param requestUrl - The URL of the current request
 * @returns The absolute callback URL
 */
export function githubAppCallbackUrl(env: Pick<Env, "APP_URL">, requestUrl: string): string {
  let origin: string;
  try {
    origin = new URL(env.APP_URL && env.APP_URL.length > 0 ? env.APP_URL : requestUrl).origin;
  } catch {
    origin = new URL(requestUrl).origin;
  }
  return `${origin}${GITHUB_APP_CALLBACK_PATH}`;
}

/**
 * GitHub's authorize URL for the app. A GitHub App's user token takes its
 * permissions from the app, so there is no `scope` to ask for.
 *
 * @param config - The app's OAuth credentials
 * @param redirectUri - The callback URL
 * @param state - The single-use CSRF state
 * @returns The URL to send the browser to
 */
export function githubAppAuthorizeUrl(
  config: GitHubAppOAuthConfig,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/** The error for anything GitHub got wrong or refused: a 502, since it is the upstream's. */
function githubError(message: string): AppError {
  return new AppError(message, "GITHUB_ERROR", 502);
}

/** Headers for a call made as the user, with their token. */
function userHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "stratum",
    Authorization: `Bearer ${token}`,
  };
}

/** One GET to GitHub's API as the user. A transport failure is an error; any HTTP answer is returned. */
async function githubGet(path: string, token: string): Promise<Result<Response, AppError>> {
  try {
    return ok(
      await fetch(`${GITHUB_API_BASE}${path}`, {
        headers: userHeaders(token),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      }),
    );
  } catch (error) {
    // A transport error's message names the failure (timeout, DNS), never the
    // request headers, so it is safe to carry.
    return err(
      githubError(
        `GitHub request failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/** The response body as JSON, or null when it is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Is this a plain object: not null and not an array? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GitHub's OAuth error codes are short snake_case words; log nothing else from that body. */
function safeOAuthErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "unknown";
}

/**
 * Exchanges the callback's `code` for a user-to-server token.
 *
 * @param config - The app's OAuth credentials
 * @param code - The `code` query parameter GitHub sent back
 * @param redirectUri - The same callback URL the authorize request named
 * @param logger - Request logger
 * @returns The token, to be used within this request and then dropped
 */
export async function exchangeGitHubAppCode(
  config: GitHubAppOAuthConfig,
  code: string,
  redirectUri: string,
  logger: Logger,
): Promise<Result<string, AppError>> {
  let response: Response;
  try {
    response = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "stratum",
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("GitHub App code exchange did not complete", {
      error: error instanceof Error ? error.message : String(error),
    });
    return err(githubError("GitHub App code exchange did not complete"));
  }
  if (!response.ok) {
    logger.warn("GitHub App code exchange refused", { status: response.status });
    return err(githubError("GitHub App code exchange refused"));
  }
  // GitHub answers a bad code with 200 and an `error` field, not a 4xx.
  const body = await readJson(response);
  const token = isRecord(body) ? body.access_token : undefined;
  if (typeof token !== "string" || token.length === 0) {
    logger.warn("GitHub App code exchange returned no token", {
      reason: safeOAuthErrorCode(isRecord(body) ? body.error : undefined),
    });
    return err(githubError("GitHub App code exchange returned no token"));
  }
  return ok(token);
}

/** An installation as GitHub lists it for the token's user. */
export interface ListedInstallation {
  installationId: number;
  accountId: string;
  accountLogin: string;
  /** GitHub's account type: "User" or "Organization". */
  accountType: string;
}

/** Who the token belongs to and which installations GitHub lets them reach. */
export interface CurrentGitHubAccess {
  githubUserId: string;
  installations: ReadonlyMap<number, ListedInstallation>;
}

/** One entry of GitHub's installation list, or null when it lacks an id or an account. */
function toListedInstallation(value: unknown): ListedInstallation | null {
  if (!isRecord(value) || !isRecord(value.account)) return null;
  const { id } = value;
  const { id: accountId, login, type } = value.account;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  if (typeof accountId !== "number" || typeof login !== "string") return null;
  // `target_type` is the installation's own record of what it is installed on;
  // `account.type` is the fallback for payloads that omit it.
  const accountType = typeof value.target_type === "string" ? value.target_type : type;
  if (typeof accountType !== "string") return null;
  return { installationId: id, accountId: String(accountId), accountLogin: login, accountType };
}

/** The GitHub user id the token belongs to (`GET /user`). */
async function fetchTokenUserId(token: string, logger: Logger): Promise<Result<string, AppError>> {
  const response = await githubGet("/user", token);
  if (!response.success) return response;
  if (!response.data.ok) {
    logger.warn("GitHub refused to identify the authorizing user", {
      status: response.data.status,
    });
    return err(githubError("GitHub refused to identify the authorizing user"));
  }
  const body = await readJson(response.data);
  if (!isRecord(body) || typeof body.id !== "number") {
    return err(githubError("GitHub returned no user id"));
  }
  return ok(String(body.id));
}

/**
 * Every installation of the app GitHub lists for the token's user, read page
 * by page up to the page limit.
 */
async function fetchListedInstallations(
  token: string,
  logger: Logger,
): Promise<Result<Map<number, ListedInstallation>, AppError>> {
  const listed = new Map<number, ListedInstallation>();
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const response = await githubGet(
      `/user/installations?per_page=${INSTALLATIONS_PER_PAGE}&page=${page}`,
      token,
    );
    if (!response.success) return response;
    if (!response.data.ok) {
      logger.warn("GitHub refused to list the user's installations", {
        status: response.data.status,
        page,
      });
      return err(githubError("GitHub refused to list the user's installations"));
    }
    const body = await readJson(response.data);
    if (!isRecord(body) || !Array.isArray(body.installations)) {
      return err(githubError("GitHub returned an unreadable installation list"));
    }
    for (const item of body.installations) {
      const installation = toListedInstallation(item);
      if (installation) listed.set(installation.installationId, installation);
    }
    // Follow GitHub's own word on whether there is more. The page number is
    // ours to build, so a hostile `Link` target can never be dereferenced.
    const more = /rel="next"/.test(response.data.headers.get("link") ?? "");
    if (!more || body.installations.length === 0) return ok(listed);
  }
  logger.warn("Stopped paging the user's installations at the page limit", {
    pages: MAX_INSTALLATION_PAGES,
  });
  return ok(listed);
}

/**
 * Asks GitHub who the token's user is and which of the app's installations
 * they can reach right now.
 *
 * @param token - The user-to-server token from `exchangeGitHubAppCode`
 * @param logger - Request logger
 * @returns The user's GitHub id and their listed installations
 */
export async function fetchCurrentGitHubAccess(
  token: string,
  logger: Logger,
): Promise<Result<CurrentGitHubAccess, AppError>> {
  const [githubUserId, installations] = await Promise.all([
    fetchTokenUserId(token, logger),
    fetchListedInstallations(token, logger),
  ]);
  if (!githubUserId.success) return githubUserId;
  if (!installations.success) return installations;
  return ok({ githubUserId: githubUserId.data, installations: installations.data });
}

/** Memberships asked for per page; GitHub's maximum. */
const MEMBERSHIPS_PER_PAGE = 100;

/**
 * Is the token's user an active admin of the organization this installation
 * is on, according to GitHub now?
 *
 * Read from the user's own membership list (`GET /user/memberships/orgs`),
 * which a GitHub App user token may call with no permission granted to the
 * app. The single-organization form of the call needs the app to hold
 * "Members: read"; without it GitHub answers 403, which is also what a real
 * refusal looks like, so every organization link would be refused with
 * nothing to tell the two apart.
 *
 * The organization is matched by account id, never by login: logins are
 * reused, and the id is the account the installation is actually on.
 */
async function isActiveOrgAdmin(
  token: string,
  org: ListedInstallation,
  logger: Logger,
): Promise<Result<boolean, AppError>> {
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page++) {
    const response = await githubGet(
      `/user/memberships/orgs?state=active&per_page=${MEMBERSHIPS_PER_PAGE}&page=${page}`,
      token,
    );
    if (!response.success) return response;
    // GitHub declining to list memberships is not GitHub saying "admin", which
    // is the only thing that counts. Logged, because a refusal here is more
    // likely a misconfigured app than a person without access.
    if (response.data.status === 403) {
      logger.warn("GitHub refused to list the user's org memberships", { status: 403 });
      return ok(false);
    }
    if (!response.data.ok) {
      logger.warn("GitHub refused to report org memberships", { status: response.data.status });
      return err(githubError("GitHub refused to report org memberships"));
    }
    const body = await readJson(response.data);
    if (!Array.isArray(body)) return ok(false);
    for (const membership of body) {
      if (!isRecord(membership) || !isRecord(membership.organization)) continue;
      if (String(membership.organization.id) !== org.accountId) continue;
      return ok(membership.state === "active" && membership.role === "admin");
    }
    // Follow GitHub's own word on whether there is more, as for installations.
    const more = /rel="next"/.test(response.data.headers.get("link") ?? "");
    if (!more || body.length === 0) return ok(false);
  }
  logger.warn("Stopped paging the user's org memberships at the page limit", {
    pages: MAX_INSTALLATION_PAGES,
  });
  return ok(false);
}

/**
 * `allowed`: GitHub says this person manages the installation's account now.
 * `not_manager`: they can reach the installation but do not manage its account.
 * `not_listed`: GitHub does not list the installation for them at all.
 */
export type InstallationAccess = "allowed" | "not_manager" | "not_listed";

/**
 * Whether the token's user may link `installation`, judged only by what GitHub
 * reports at this moment.
 *
 * Being listed by `GET /user/installations` is necessary but not sufficient:
 * GitHub lists an installation for anyone with access to one of its
 * repositories, an outside collaborator included. So an organization's
 * installation also takes an active `admin` membership of that organization,
 * and a personal account's takes being that account.
 *
 * @param token - The user-to-server token
 * @param access - What `fetchCurrentGitHubAccess` returned for the same token
 * @param installation - The installation as Stratum recorded it
 * @param logger - Request logger
 * @returns The verdict, or an error when GitHub could not be asked
 */
export async function checkInstallationAccess(
  token: string,
  access: CurrentGitHubAccess,
  installation: Pick<GitHubInstallation, "installationId" | "accountId">,
  logger: Logger,
): Promise<Result<InstallationAccess, AppError>> {
  const listed = access.installations.get(installation.installationId);
  // An id GitHub lists on a different account than the one recorded means the
  // record is not describing the same installation; treat it as unknown.
  if (!listed || listed.accountId !== installation.accountId) return ok("not_listed");
  if (listed.accountType === "User") {
    return ok(listed.accountId === access.githubUserId ? "allowed" : "not_manager");
  }
  if (listed.accountType === "Organization") {
    const admin = await isActiveOrgAdmin(token, listed, logger);
    if (!admin.success) return admin;
    return ok(admin.data ? "allowed" : "not_manager");
  }
  // Any other target (an enterprise) has no rule here, so it has no way in.
  return ok("not_manager");
}

/**
 * Asks GitHub to invalidate the user token now that the check is done, so it
 * is as short-lived on GitHub's side as it is on ours. Best effort: a failure
 * leaves a token nobody holds, which expires on GitHub's own schedule.
 *
 * @param config - The app's OAuth credentials
 * @param token - The user-to-server token to revoke
 * @param logger - Request logger
 */
export async function revokeGitHubAppUserToken(
  config: GitHubAppOAuthConfig,
  token: string,
  logger: Logger,
): Promise<void> {
  try {
    const response = await fetch(
      `${GITHUB_API_BASE}/applications/${encodeURIComponent(config.clientId)}/token`,
      {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "stratum",
          "Content-Type": "application/json",
          Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
        },
        body: JSON.stringify({ access_token: token }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      logger.warn("GitHub did not revoke the link-check user token", { status: response.status });
    }
  } catch (error) {
    logger.warn("Could not ask GitHub to revoke the link-check user token", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
