/**
 * GitHub App installation-token auth for outbound GitHub calls.
 *
 * Every outbound GitHub call (REST and git push/fetch) resolves its credential
 * through {@link resolveGitHubToken}: an installation token for the repo when
 * the GitHub App is configured and installed there, otherwise the instance-wide
 * `GITHUB_TOKEN` PAT.
 *
 * Neither credential is handed out on the strength of a source URL, which a
 * project's owner sets freely. An installation token requires the call's
 * principal to be linked to that installation or bound to the repo's GitHub
 * owner by the operator; the PAT requires the binding. A principal the app
 * refused never falls through to the PAT. Writes additionally require the
 * project to be the repo's canonical target. All of it lives in
 * `./repo-authorization.ts`, shared with inbound webhook routing.
 *
 * KV layout (STATE namespace):
 *   - `github_installation:{owner}/{repo}` → installation id, or
 *     {@link NOT_INSTALLED_MARKER}. Installation webhooks invalidate both
 *     ({@link invalidateInstallationCache}); positive entries also expire after
 *     {@link INSTALLED_TTL_S}, so a missed webhook heals within a day.
 *   - `github_inst_token:{installationId}` → `{ token, expiresAt }`, expiring
 *     {@link TOKEN_EXPIRY_MARGIN_S} before GitHub does.
 */

import type { KVNamespace } from "@cloudflare/workers-types";
import type { GitHubPrincipal } from "../storage/github-installations";
import type { RepoLinkProject } from "../storage/github-repo-links";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { allowlistAdmits, authorizeForRepo, ensureCanonicalProject } from "./repo-authorization";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_TIMEOUT_MS = 10_000;

/** Backdates `iat` so a Worker clock slightly ahead of GitHub's isn't rejected. */
const JWT_CLOCK_SKEW_S = 60;
/** GitHub rejects app JWTs whose lifetime exceeds 10 minutes. */
const JWT_LIFETIME_S = 540;

/** Cached tokens expire this long before GitHub's own expiry, so a token
 * handed out from cache always has at least this much life left. */
const TOKEN_EXPIRY_MARGIN_S = 300;
/** KV rejects an `expirationTtl` below 60s. */
const KV_MIN_TTL_S = 60;

/**
 * A repo the app isn't installed on is cached briefly. Without it, every
 * outbound call for a PAT-backed repo would pay an extra GitHub round trip just
 * to relearn the answer; with no TTL, installing the app later would never be
 * noticed if the installation webhook were missed.
 */
const NOT_INSTALLED_TTL_S = 600;
/**
 * A positive installation id is re-checked daily. A repo can leave an
 * installation's scope (deselected, transferred) while the installation lives
 * on, so the token mint keeps succeeding; without an expiry, a missed
 * `installation_repositories` webhook would pin the repo to a token that can't
 * reach it.
 */
const INSTALLED_TTL_S = 24 * 60 * 60;
const NOT_INSTALLED_MARKER = "none";

const installationKey = (owner: string, repo: string) =>
  `github_installation:${owner.toLowerCase()}/${repo.toLowerCase()}`;
const tokenKey = (installationId: number) => `github_inst_token:${installationId}`;

export type GitHubAppEnv = Pick<Env, "STATE" | "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">;
export type GitHubAuthEnv = GitHubAppEnv &
  Pick<Env, "DB" | "GITHUB_TOKEN" | "GITHUB_ALLOWED_OWNERS" | "GITHUB_APP_ALLOWED_OWNERS">;

/** What an outbound GitHub call targets, and on whose behalf. */
export interface GitHubCallTarget {
  owner: string;
  repo: string;
  /**
   * The Stratum owner the call acts for — the project's owner, or the import's
   * target owner. `null` authorizes nothing.
   */
  principal: GitHubPrincipal | null;
  /**
   * The project a write acts for. When set, the call also requires that
   * project to be the repo's canonical target (migration 060), so two projects
   * naming the same repo cannot both push to it or report on it.
   */
  project?: RepoLinkProject;
}

export type InstallationLookup = { installed: true; installationId: number } | { installed: false };

export interface InstallationToken {
  token: string;
  /** ISO-8601, as GitHub reports it. */
  expiresAt: string;
}

export type GitHubCredentialSource = "app" | "pat";

export interface ResolvedGitHubToken {
  token: string;
  source: GitHubCredentialSource;
  /** Present for installation tokens only; the PAT doesn't expire on our clock. */
  expiresAt?: string;
}

const githubHeaders = (authorization: string): Record<string, string> => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "stratum",
  Authorization: authorization,
});

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const base64UrlEncodeJson = (value: unknown) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

/** Decodes a PKCS#8 PEM body. Rejects PKCS#1 (`BEGIN RSA PRIVATE KEY`) with a
 * message that says what to do, since WebCrypto can only import PKCS#8. */
function pemToPkcs8(pem: string): Result<ArrayBuffer, AppError> {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    return err(
      new AppError(
        "GITHUB_APP_PRIVATE_KEY is PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt`",
        "GITHUB_APP_KEY_INVALID",
        500,
      ),
    );
  }
  // Secrets pasted through some UIs arrive with literal "\n" sequences.
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  try {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return ok(bytes.buffer);
  } catch {
    return err(
      new AppError("GITHUB_APP_PRIVATE_KEY is not valid PEM", "GITHUB_APP_KEY_INVALID", 500),
    );
  }
}

/**
 * Mints a short-lived RS256 JWT that authenticates as the GitHub App itself
 * (not an installation). Only good for the `/app/...` and
 * `/repos/{owner}/{repo}/installation` endpoints.
 */
export async function createAppJwt(
  env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">,
  nowMs: number = Date.now(),
): Promise<Result<string, AppError>> {
  const appId = env.GITHUB_APP_ID?.trim();
  const pem = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !pem) {
    return err(new AppError("GitHub App is not configured", "GITHUB_APP_NOT_CONFIGURED", 500));
  }

  const der = pemToPkcs8(pem);
  if (!der.success) return der;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      der.data,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    return err(
      new AppError(
        `GITHUB_APP_PRIVATE_KEY could not be imported: ${error instanceof Error ? error.message : String(error)}`,
        "GITHUB_APP_KEY_INVALID",
        500,
      ),
    );
  }

  const now = Math.floor(nowMs / 1000);
  const header = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlEncodeJson({
    // GitHub accepts the numeric App ID or the client ID string.
    iss: /^\d+$/.test(appId) ? Number(appId) : appId,
    iat: now - JWT_CLOCK_SKEW_S,
    exp: now + JWT_LIFETIME_S,
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return ok(`${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`);
}

async function githubFetch(
  path: string,
  init: { method: "GET" | "POST"; authorization: string },
): Promise<Result<Response, AppError>> {
  try {
    const response = await fetch(`${GITHUB_API_BASE}${path}`, {
      method: init.method,
      headers: githubHeaders(init.authorization),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    return ok(response);
  } catch (error) {
    return err(
      new AppError(
        `GitHub API request failed: ${error instanceof Error ? error.message : String(error)}`,
        "GITHUB_ERROR",
        502,
      ),
    );
  }
}

async function githubErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && "message" in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // Non-JSON error body: fall through to the raw status.
  }
  return `HTTP ${response.status}`;
}

/**
 * Finds the app installation covering `owner/repo`, via KV then
 * `GET /repos/{owner}/{repo}/installation`. A 404 is an answer, not a failure:
 * the app simply isn't installed there.
 */
export async function getInstallationId(
  env: GitHubAppEnv,
  owner: string,
  repo: string,
  logger: Logger,
): Promise<Result<InstallationLookup, AppError>> {
  const key = installationKey(owner, repo);
  const cached = await env.STATE.get(key);
  if (cached === NOT_INSTALLED_MARKER) return ok({ installed: false });
  if (cached !== null) {
    const installationId = Number(cached);
    if (Number.isSafeInteger(installationId) && installationId > 0) {
      return ok({ installed: true, installationId });
    }
    logger.warn("Discarding malformed cached GitHub installation id", { owner, repo });
  }

  const jwt = await createAppJwt(env);
  if (!jwt.success) return jwt;

  const response = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    { method: "GET", authorization: `Bearer ${jwt.data}` },
  );
  if (!response.success) return response;

  if (response.data.status === 404) {
    await env.STATE.put(key, NOT_INSTALLED_MARKER, { expirationTtl: NOT_INSTALLED_TTL_S });
    return ok({ installed: false });
  }
  if (!response.data.ok) {
    const message = await githubErrorMessage(response.data);
    return err(
      new AppError(
        `GitHub installation lookup failed (${response.data.status}): ${message}`,
        "GITHUB_ERROR",
        502,
      ),
    );
  }

  const body: unknown = await response.data.json().catch(() => null);
  const installationId =
    typeof body === "object" && body !== null && "id" in body
      ? (body as { id: unknown }).id
      : undefined;
  if (typeof installationId !== "number" || !Number.isSafeInteger(installationId)) {
    return err(
      new AppError("GitHub installation lookup returned no id", "GITHUB_ERROR", 502, {
        owner,
        repo,
      }),
    );
  }

  await env.STATE.put(key, String(installationId), { expirationTtl: INSTALLED_TTL_S });
  return ok({ installed: true, installationId });
}

function parseCachedToken(raw: string | null): InstallationToken | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { token, expiresAt } = parsed as Record<string, unknown>;
    if (typeof token !== "string" || typeof expiresAt !== "string") return null;
    return { token, expiresAt };
  } catch {
    return null;
  }
}

/**
 * An access token for a known installation, from KV or freshly minted.
 * Deliberately not exported: the only way to a token is through
 * {@link resolveGitHubToken}, which decides first whether the caller may use
 * this installation.
 */
async function mintInstallationToken(
  env: GitHubAppEnv,
  installationId: number,
  owner: string,
  repo: string,
  nowMs: number = Date.now(),
): Promise<Result<InstallationToken, AppError>> {
  const cached = parseCachedToken(await env.STATE.get(tokenKey(installationId)));
  // KV expiry is eventually consistent, so the margin is re-checked here
  // rather than trusted to have evicted a near-dead token.
  if (cached && Date.parse(cached.expiresAt) - nowMs > TOKEN_EXPIRY_MARGIN_S * 1000) {
    return ok(cached);
  }

  const jwt = await createAppJwt(env, nowMs);
  if (!jwt.success) return jwt;

  const response = await githubFetch(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    authorization: `Bearer ${jwt.data}`,
  });
  if (!response.success) return response;

  if (!response.data.ok) {
    const message = await githubErrorMessage(response.data);
    if (response.data.status === 404) {
      // The cached installation was uninstalled without us seeing the webhook.
      // Drop it so the next call re-resolves instead of failing forever.
      await env.STATE.delete(installationKey(owner, repo));
    }
    return err(
      new AppError(
        `GitHub installation token request failed (${response.data.status}): ${message}`,
        "GITHUB_ERROR",
        502,
        { installationId },
      ),
    );
  }

  const body: unknown = await response.data.json().catch(() => null);
  const { token, expires_at: expiresAt } = (
    typeof body === "object" && body !== null ? body : {}
  ) as Record<string, unknown>;
  if (typeof token !== "string" || typeof expiresAt !== "string") {
    return err(
      new AppError("GitHub installation token response was malformed", "GITHUB_ERROR", 502, {
        installationId,
      }),
    );
  }

  const ttl = Math.floor((Date.parse(expiresAt) - nowMs) / 1000) - TOKEN_EXPIRY_MARGIN_S;
  if (ttl >= KV_MIN_TTL_S) {
    await env.STATE.put(tokenKey(installationId), JSON.stringify({ token, expiresAt }), {
      expirationTtl: ttl,
    });
  }
  return ok({ token, expiresAt });
}

/**
 * The credential for an outbound GitHub call against `target.owner/repo`.
 *
 * - App installed on the repo: an installation token, if the principal is
 *   linked to that installation or bound by the operator. A refusal, or a link
 *   lookup that failed, ends here: it never falls through to the PAT, which
 *   would hand the broader credential to exactly the caller just refused.
 * - App not configured, not installed, or failing to mint: the `GITHUB_TOKEN`
 *   PAT, but only for a principal the operator bound to the repo's owner.
 * - Either way, a call carrying `target.project` (a write) also needs that
 *   project to be the repo's canonical target.
 *
 * Logs the source used — never the token.
 */
export async function resolveGitHubToken(
  env: GitHubAuthEnv,
  target: GitHubCallTarget,
  logger: Logger,
): Promise<Result<ResolvedGitHubToken, AppError>> {
  const { owner, repo } = target;
  const appConfigured = Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);

  if (appConfigured) {
    const appToken = await resolveAppToken(env, target, logger);
    if (appToken.success) {
      logger.debug("Using GitHub App installation token", { owner, repo, source: "app" });
      return ok({ ...appToken.data, source: "app" });
    }
    const { code } = appToken.error;
    if (code === "GITHUB_APP_NOT_AUTHORIZED" || code === "GITHUB_REPO_NOT_CANONICAL") {
      return appToken;
    }
    if (code === "GITHUB_APP_NOT_INSTALLED") {
      logger.debug("GitHub App not installed on repo", { owner, repo });
    } else {
      logger.warn("GitHub App token unavailable", {
        owner,
        repo,
        error: appToken.error.message,
        code,
      });
    }
  }

  if (!env.GITHUB_TOKEN) {
    return err(
      new AppError("GitHub integration is not configured", "GITHUB_NOT_CONFIGURED", 400, {
        owner,
        repo,
        appConfigured,
      }),
    );
  }
  if (!(await allowlistAdmits(env, owner, target.principal, logger))) {
    logger.info("GITHUB_TOKEN not used: repo owner is not bound to this project's owner", {
      owner,
      repo,
      principalType: target.principal?.type,
    });
    return err(
      new AppError(
        `No GitHub credential may act on ${owner}/${repo} for this project's owner`,
        "GITHUB_NOT_AUTHORIZED",
        403,
      ),
    );
  }
  const canonical = await requireCanonical(env, target, logger);
  if (!canonical.success) return canonical;
  logger.debug("Using GITHUB_TOKEN for GitHub call", { owner, repo, source: "pat" });
  return ok({ token: env.GITHUB_TOKEN, source: "pat" });
}

/** For a write, require the project to be (or become) the repo's canonical target. */
async function requireCanonical(
  env: GitHubAuthEnv,
  target: GitHubCallTarget,
  logger: Logger,
): Promise<Result<void, AppError>> {
  if (!target.project) return ok(undefined);
  const canonical = await ensureCanonicalProject(
    env,
    target.owner,
    target.repo,
    target.project,
    logger,
  );
  if (!canonical.success) return canonical;
  if (canonical.data) return ok(undefined);
  logger.info("GitHub write refused: another project is this repo's canonical target", {
    owner: target.owner,
    repo: target.repo,
    projectId: target.project.id,
  });
  return err(
    new AppError(
      `${target.owner}/${target.repo} is already connected to another Stratum project`,
      "GITHUB_REPO_NOT_CANONICAL",
      409,
    ),
  );
}

async function resolveAppToken(
  env: GitHubAuthEnv,
  target: GitHubCallTarget,
  logger: Logger,
): Promise<Result<InstallationToken, AppError>> {
  const { owner, repo } = target;
  const installation = await getInstallationId(env, owner, repo, logger);
  if (!installation.success) return installation;
  if (!installation.data.installed) {
    return err(
      new AppError(
        `GitHub App is not installed on ${owner}/${repo}`,
        "GITHUB_APP_NOT_INSTALLED",
        404,
      ),
    );
  }
  const { installationId } = installation.data;

  const decision = await authorizeForRepo(env, owner, target.principal, installationId, logger);
  if (!decision.allowed) {
    // Info, not debug: this is the line an operator needs when a repo they
    // expected to use the app is quietly on the PAT.
    logger.info("GitHub App installation not authorized for this caller", {
      owner,
      repo,
      installationId,
      principalType: target.principal?.type,
      reason: decision.reason,
    });
    return err(
      new AppError(
        `GitHub App installation for ${owner} is not linked to this project's owner`,
        "GITHUB_APP_NOT_AUTHORIZED",
        403,
      ),
    );
  }
  const canonical = await requireCanonical(env, target, logger);
  if (!canonical.success) return canonical;
  return mintInstallationToken(env, installationId, owner, repo);
}

/**
 * Drops cached installation ids (and, when known, the installation's cached
 * token) after an installation webhook says the mapping changed. Best-effort
 * by design: a stale entry is also self-healing (see mintInstallationToken).
 */
export async function invalidateInstallationCache(
  kv: KVNamespace,
  opts: { repoFullNames: string[]; installationId?: number },
): Promise<void> {
  const deletions: Promise<void>[] = [];
  for (const fullName of opts.repoFullNames) {
    const [owner, repo] = fullName.split("/");
    if (owner && repo) deletions.push(kv.delete(installationKey(owner, repo)));
  }
  if (opts.installationId !== undefined) deletions.push(kv.delete(tokenKey(opts.installationId)));
  await Promise.all(deletions);
}
