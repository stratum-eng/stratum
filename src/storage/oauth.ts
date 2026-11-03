/**
 * The OAuth 2.1 authorization server behind the remote MCP endpoint (#349).
 *
 * Stratum is an OAuth *client* elsewhere (GitHub and Google sign-in, in
 * routes/auth.ts). This file is the other half: Stratum as the authorization
 * *server*, because a remote MCP endpoint has no other way to let an editor the
 * user has never told us about act on their behalf.
 *
 * Three properties are load-bearing and every function here is written around
 * them:
 *
 *  1. **The client table is written by anonymous callers.** MCP clients
 *     self-register (RFC 7591) — an editor discovers the server from a pasted
 *     URL. So a registered client proves nothing about who registered it, and
 *     the only things standing between a hostile registration and someone's
 *     account are the exact redirect-URI match, PKCE, and the consent screen.
 *  2. **Every secret is stored hashed**, never in plaintext — codes included.
 *     A code is a bearer credential for the seconds it lives, and it is read by
 *     an unauthenticated endpoint.
 *  3. **Expiry is compared in JavaScript, never in SQL.** This codebase stores
 *     both `datetime('now')` (`"… 12:00:00"`) and ISO
 *     (`"…T12:00:00.000Z"`), and `' '` (0x20) sorts below `'T'` (0x54), so
 *     `WHERE expires_at > datetime('now')` against an ISO value reads every
 *     expired row as live. `api_tokens` dodges this the same way (see 042).
 */
import type { ApiTokenScope, User } from "../types";
import { constantTimeEqual, hashToken } from "../utils/crypto";
import {
  AppError,
  type CredentialRejection,
  NotFoundError,
  RejectedCredentialError,
} from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/**
 * The scope vocabulary, deliberately identical in power to `api_tokens.scope`.
 *
 * An OAuth grant introduces a new *way* to get a credential, and must not
 * introduce a new *kind* of authority: `mcp:write` is exactly a `read_write`
 * API token and `mcp:read` is exactly a `read` one, so nothing downstream has
 * to learn a third authority model. In particular this is why review verdicts
 * behave identically over MCP and over a user token — the human-approval gate
 * is enforced by actor type (agents are refused), and an OAuth grant is a user
 * acting through a client, not an agent identity.
 */
export const SCOPE_READ = "mcp:read";
export const SCOPE_WRITE = "mcp:write";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

/** Granted when a client asks for no scope at all. Least privilege: read. */
export const DEFAULT_SCOPE = SCOPE_READ;

/**
 * Lifetimes.
 *
 * The code lifetime is far below the 10 minutes RFC 6749 permits: it only has
 * to survive one redirect back to a localhost listener, and every second it
 * lives is a second it can be replayed from a browser history or a proxy log.
 */
export const AUTH_CODE_TTL_MS = 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The longest a grant may live, counted from when it was first issued.
 *
 * The refresh window above SLIDES: every rotation pushes it out another 30
 * days. Without a ceiling, a grant that is refreshed even once a month never
 * expires, and "connected six months ago, still connected" is indistinguishable
 * from a credential nobody remembers granting. This caps the slide, so every
 * grant eventually returns the user to the consent screen.
 */
export const REFRESH_GRANT_MAX_MS = 180 * 24 * 60 * 60 * 1000;

/** Registration bounds. A self-registering client picks all of these, so each
 * one is a size an anonymous caller would otherwise choose for us. */
export const MAX_REDIRECT_URIS = 10;
export const MAX_CLIENT_NAME_LENGTH = 120;
export const MAX_REDIRECT_URI_LENGTH = 2048;

/** Debounce on `last_used_at`, matching `api_tokens`: without it every
 * authenticated MCP call carries a D1 write. */
export const LAST_USED_DEBOUNCE_MS = 60 * 60 * 1000;

/** Has this timestamp passed? A `null` expiry never has. An unparseable one
 * counts as EXPIRED — a credential whose lifetime cannot be established must
 * not be honoured indefinitely. */
/**
 * The first 12 hex digits of a code's SHA-256, for log correlation (#355).
 *
 * "Authorization code issued" and "OAuth tokens issued" both carry it, so a
 * code that was minted and never redeemed is one log query away instead of a
 * guess. Not a secret: redemption needs the plaintext code, and the full hash
 * is never logged.
 */
function codeIdOf(codeHash: string): string {
  return codeHash.slice(0, 12);
}

export function isExpired(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  const at = Date.parse(expiresAt);
  return !Number.isFinite(at) || at <= Date.now();
}

/**
 * Narrow a stored scope string to the `api_tokens` vocabulary.
 *
 * Anything that does not explicitly carry `mcp:write` is read-only. A malformed
 * or unknown scope therefore *downgrades*; defaulting the other way would turn
 * a bad row into a privilege escalation.
 */
export function narrowOAuthScope(scope: string): ApiTokenScope {
  return scope.split(/\s+/).includes(SCOPE_WRITE) ? "read_write" : "read";
}

/**
 * Parse a space-delimited `scope` request into the subset we support.
 *
 * Returns an error for an unknown scope rather than silently dropping it: a
 * client that asked for something it did not get must find out at the
 * authorization step, not by discovering a 403 several tool calls later.
 * `mcp:write` implies `mcp:read`, and both are recorded so the consent screen
 * and the token response can state the grant exactly.
 */
export function parseScope(requested: string | undefined): Result<string, AppError> {
  if (requested === undefined || requested.trim() === "") return ok(DEFAULT_SCOPE);
  const asked = requested.trim().split(/\s+/);
  for (const scope of asked) {
    if (!SUPPORTED_SCOPES.includes(scope as (typeof SUPPORTED_SCOPES)[number])) {
      return err(
        new AppError(`Unsupported scope '${scope}'`, "INVALID_SCOPE", 400, {
          supported: SUPPORTED_SCOPES.join(" "),
        }),
      );
    }
  }
  // Normalized and de-duplicated so the stored string is comparable, and so
  // `mcp:write` alone still records the read authority it implies.
  return ok(asked.includes(SCOPE_WRITE) ? `${SCOPE_READ} ${SCOPE_WRITE}` : SCOPE_READ);
}

/** 128 bits of CSPRNG output, hex-encoded — the same shape and strength as
 * every other Stratum credential, so `secret-scanner.ts` can match them all
 * with one pattern family. */
function randomSecret(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
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

// ── Clients ─────────────────────────────────────────────────────────────────

export interface OAuthClient {
  id: string;
  clientName: string;
  redirectUris: string[];
  scope: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  createdAt: string;
  /** Present only for a confidential client. Never leaves this module except
   * through `verifyClientSecret`. */
  clientSecretHash?: string;
}

interface OAuthClientRow {
  id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string;
  scope: string;
  token_endpoint_auth_method: string;
  created_at: string;
}

/** Narrow a stored auth method to the union. Anything unrecognised is `none`,
 * which requires PKCE and no secret — the safe direction for a bad row. */
function narrowAuthMethod(value: string): OAuthClient["tokenEndpointAuthMethod"] {
  return value === "client_secret_post" || value === "client_secret_basic" ? value : "none";
}

function rowToClient(row: OAuthClientRow): OAuthClient {
  let redirectUris: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.redirect_uris);
    if (Array.isArray(parsed))
      redirectUris = parsed.filter((u): u is string => typeof u === "string");
  } catch {
    // A row whose redirect list will not parse registers ZERO usable redirect
    // URIs, so every authorization against it fails the exact-match check. That
    // is the safe direction: the alternative — throwing — would turn a bad row
    // into a 500 on an unauthenticated endpoint.
    redirectUris = [];
  }
  const client: OAuthClient = {
    id: row.id,
    clientName: row.client_name,
    redirectUris,
    scope: row.scope,
    tokenEndpointAuthMethod: narrowAuthMethod(row.token_endpoint_auth_method),
    createdAt: row.created_at,
  };
  if (row.client_secret_hash !== null) client.clientSecretHash = row.client_secret_hash;
  return client;
}

/**
 * Is this a redirect URI we will ever hand an authorization code to?
 *
 * MCP clients are overwhelmingly native apps that listen on an ephemeral
 * loopback port, so plaintext `http` has to be allowed there — RFC 8252 §7.3
 * prescribes it for native apps, and it is safe precisely because loopback
 * cannot be reached off the machine. Everything else must be https.
 *
 * `localhost` is accepted alongside the IP literals. RFC 8252 §8.3 prefers the
 * literals because a hostname nominally goes through DNS, but every current
 * browser resolves `localhost` to loopback internally without consulting a
 * resolver (RFC 6761 §6.3 requires it), and the clients that matter use the
 * name: Claude Code registers `http://localhost:<port>/callback` and offers no
 * way to change it. Refusing the name locked those clients out at registration
 * for no security gained.
 *
 * Rejected outright: a fragment (the redirect target would be rewritten),
 * credentials in the authority, and any non-loopback plaintext http.
 */
export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > MAX_REDIRECT_URI_LENGTH) return false;
  const url = parseUrl(value);
  if (url === null) return false;
  if (url.hash !== "") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/** `new URL` without the throw: the callers treat unparseable input as a policy failure, not an exception. */
function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The WHATWG parser keeps the brackets on an IPv6 hostname, hence both forms. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** One predicate shared by registration and authorization, so the two can never disagree about
 * what counts as loopback: it is the only thing that lets plaintext http through at all, and
 * the only thing that unlocks the port-only match exception. */
function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * Does a presented `redirect_uri` match one the client registered?
 *
 * Exact string equality, with one deliberate exception: a plaintext loopback
 * redirect may differ from its registration in PORT only. RFC 8252 §7.3
 * requires this of an authorization server — a native app binds whatever
 * ephemeral port is free when it starts, so the port in its registration is
 * merely the one it happened to get that day — and the relaxation is safe
 * because every loopback port on the user's machine is equally theirs.
 *
 * Nothing else is relaxed. Scheme, host, path and query must be identical;
 * `localhost` and `127.0.0.1` do not stand in for each other; an https URI
 * matches only itself; and the presented URI must still pass
 * `isAllowedRedirectUri`, so a fragment cannot ride in on the port exception.
 * Every broader comparison — prefix, subdirectory, ignored query — is a
 * published way to steal authorization codes.
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  if (!isAllowedRedirectUri(presented)) return false;
  const url = parseUrl(presented);
  if (url === null || url.protocol !== "http:" || !isLoopbackHost(url.hostname)) return false;
  return registered.some((candidate) => {
    const reg = parseUrl(candidate);
    return (
      reg !== null &&
      reg.protocol === "http:" &&
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    );
  });
}

export interface RegisteredClient {
  client: OAuthClient;
  /** Returned exactly once, and only for a confidential client. */
  clientSecret?: string;
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Unauthenticated by design — that is what makes "paste the URL into your
 * editor" work, and it is the model Cloudflare's own MCP guidance and the MCP
 * spec assume. The row it creates confers nothing on its own: a client_id is a
 * public identifier, and reaching a user's data still needs that user to
 * complete the consent screen in their own browser.
 */
export async function registerClient(
  db: D1Database,
  logger: Logger,
  opts: {
    clientName: string;
    redirectUris: string[];
    scope?: string;
    tokenEndpointAuthMethod?: string;
  },
): Promise<Result<RegisteredClient, AppError>> {
  const clientName = opts.clientName.trim();
  if (clientName === "" || clientName.length > MAX_CLIENT_NAME_LENGTH) {
    return err(
      new AppError(
        `client_name must be 1-${MAX_CLIENT_NAME_LENGTH} characters`,
        "INVALID_CLIENT_METADATA",
        400,
      ),
    );
  }
  if (opts.redirectUris.length === 0 || opts.redirectUris.length > MAX_REDIRECT_URIS) {
    return err(
      new AppError(
        `redirect_uris must contain between 1 and ${MAX_REDIRECT_URIS} entries`,
        "INVALID_REDIRECT_URI",
        400,
      ),
    );
  }
  for (const uri of opts.redirectUris) {
    if (!isAllowedRedirectUri(uri)) {
      return err(
        new AppError(
          `redirect_uri '${uri}' must be https, or http on loopback (localhost, 127.0.0.1 or [::1]), with no fragment or credentials`,
          "INVALID_REDIRECT_URI",
          400,
        ),
      );
    }
  }

  const scopeResult = parseScope(opts.scope);
  if (!scopeResult.success) return err(scopeResult.error);

  const authMethod = narrowAuthMethod(opts.tokenEndpointAuthMethod ?? "none");
  // Only a confidential client gets a secret. A public client that was handed
  // one would simply embed it in a distributed binary, where it authenticates
  // nobody — PKCE is what actually binds the exchange, and it is mandatory for
  // every client here.
  const clientSecret = authMethod === "none" ? undefined : randomSecret("stratum_mcpcs");

  try {
    const id = newId("mcpc");
    const createdAt = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO oauth_clients
           (id, client_secret_hash, client_name, redirect_uris, scope,
            token_endpoint_auth_method, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        clientSecret === undefined ? null : await hashToken(clientSecret),
        clientName,
        JSON.stringify(opts.redirectUris),
        scopeResult.data,
        authMethod,
        createdAt,
      )
      .run();

    logger.info("OAuth client registered", { clientId: id, clientName, authMethod });
    const client: OAuthClient = {
      id,
      clientName,
      redirectUris: opts.redirectUris,
      scope: scopeResult.data,
      tokenEndpointAuthMethod: authMethod,
      createdAt,
    };
    return ok(clientSecret === undefined ? { client } : { client, clientSecret });
  } catch (error) {
    const appError = toAppError(error, "registerClient", { clientName });
    logger.error("Failed to register OAuth client", appError, { clientName });
    return err(appError);
  }
}

/** Load a registered client by its `client_id`. A lookup failure is reported
 * as an error rather than as "no such client", so a D1 outage cannot read as a
 * deregistration. */
export async function getClient(
  db: D1Database,
  logger: Logger,
  clientId: string,
): Promise<Result<OAuthClient, NotFoundError | AppError>> {
  try {
    const row = await db
      .prepare("SELECT * FROM oauth_clients WHERE id = ?")
      .bind(clientId)
      .first<OAuthClientRow>();
    if (!row) return err(new NotFoundError("OAuth client", clientId));
    return ok(rowToClient(row));
  } catch (error) {
    const appError = toAppError(error, "getClient", { clientId });
    logger.warn("OAuth client lookup failed", { clientId, error: appError.message });
    return err(appError);
  }
}

/**
 * Authenticate a confidential client at the token endpoint.
 *
 * A public client (`token_endpoint_auth_method: none`) authenticates with PKCE
 * alone and must NOT present a secret — accepting one would let a caller pick
 * which mechanism to be judged by.
 */
export async function verifyClientSecret(
  client: OAuthClient,
  presented: string | undefined,
): Promise<boolean> {
  if (client.clientSecretHash === undefined) return presented === undefined;
  if (presented === undefined) return false;
  return constantTimeEqual(await hashToken(presented), client.clientSecretHash);
}

// ── Authorization codes ─────────────────────────────────────────────────────

export interface AuthCodeRecord {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource: string | null;
}

interface AuthCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string | null;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

/** Mints a single-use authorization code. The plaintext is returned once and
 * only its hash is stored. */
export async function issueAuthorizationCode(
  db: D1Database,
  logger: Logger,
  record: AuthCodeRecord,
): Promise<Result<{ code: string; expiresAt: string; codeId: string }, AppError>> {
  try {
    const code = randomSecret("stratum_mcpac");
    const codeHash = await hashToken(code);
    const codeId = codeIdOf(codeHash);
    const now = Date.now();
    const expiresAt = new Date(now + AUTH_CODE_TTL_MS).toISOString();
    await db
      .prepare(
        `INSERT INTO oauth_auth_codes
           (code_hash, client_id, user_id, redirect_uri, scope, code_challenge,
            code_challenge_method, resource, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'S256', ?, ?, ?)`,
      )
      .bind(
        codeHash,
        record.clientId,
        record.userId,
        record.redirectUri,
        record.scope,
        record.codeChallenge,
        record.resource,
        expiresAt,
        new Date(now).toISOString(),
      )
      .run();
    logger.info("Authorization code issued", {
      codeId,
      clientId: record.clientId,
      userId: record.userId,
      scope: record.scope,
    });
    return ok({ code, expiresAt, codeId });
  } catch (error) {
    const appError = toAppError(error, "issueAuthorizationCode", { clientId: record.clientId });
    logger.error("Failed to issue authorization code", appError, { clientId: record.clientId });
    return err(appError);
  }
}

/** Why a code redemption failed. `replayed` is separated from every other
 * cause because it is the one that means an attacker may hold the code. */
export type CodeRedemptionFailure = "not_found" | "expired" | "replayed" | "lookup_failed";

export interface RedeemedCode extends AuthCodeRecord {
  codeChallengeMethod: string;
  /** See `codeIdOf`. Carried so the token endpoint can log the same id the
   * consent step logged. */
  codeId: string;
}

/**
 * Look a code up WITHOUT consuming it.
 *
 * Split from the claim below on purpose. The obvious implementation — consume
 * first, then check the client binding, the redirect URI and PKCE — hands an
 * attacker who merely *observed* a code a way to hurt the legitimate client:
 * their doomed redemption burns the code, so the real client's exchange then
 * reports a replay, and the replay path revokes every grant that client holds
 * for that user. Validating first means a wrong-client or wrong-verifier
 * attempt changes nothing at all, and only a caller that has proven it may
 * redeem the code goes on to claim it.
 *
 * `alreadyConsumed` is reported rather than being folded into an error, because
 * the caller needs the record itself — the client and user on it are who the
 * revocation applies to.
 */
export async function readAuthorizationCode(
  db: D1Database,
  logger: Logger,
  code: string,
): Promise<Result<RedeemedCode & { alreadyConsumed: boolean }, CodeRedemptionFailure>> {
  const codeHash = await hashToken(code);
  let row: AuthCodeRow | null;
  try {
    row = await db
      .prepare("SELECT * FROM oauth_auth_codes WHERE code_hash = ?")
      .bind(codeHash)
      .first<AuthCodeRow>();
  } catch (error) {
    logger.warn("Authorization code lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return err("lookup_failed");
  }

  if (!row) return err("not_found");
  // Expiry outranks consumption: an expired code that was also used is simply
  // expired, and reporting it as a replay would revoke grants over a code
  // nobody could have redeemed anyway.
  if (isExpired(row.expires_at)) return err("expired");

  return ok({
    clientId: row.client_id,
    userId: row.user_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    resource: row.resource,
    alreadyConsumed: row.consumed_at !== null,
    codeId: codeIdOf(codeHash),
  });
}

/**
 * Claim a code, exactly once.
 *
 * A conditional UPDATE (`WHERE consumed_at IS NULL`), not a read-then-write:
 * two token requests racing with the same code would both pass a
 * read-then-check, and D1 gives us the atomic claim for free. Losing that race
 * is reported as `replayed`, which is exactly what it is.
 *
 * The row is retained after the claim rather than deleted, so a later
 * presentation of the same code is distinguishable from an expired or unknown
 * one — that difference is what triggers the revocation RFC 6749 §10.5 calls
 * for.
 */
export async function claimAuthorizationCode(
  db: D1Database,
  logger: Logger,
  code: string,
): Promise<Result<void, CodeRedemptionFailure>> {
  try {
    const claimed = await db
      .prepare(
        "UPDATE oauth_auth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL",
      )
      .bind(new Date().toISOString(), await hashToken(code))
      .run();
    if (claimed.meta.changes === 0) return err("replayed");
    return ok(undefined);
  } catch (error) {
    logger.warn("Authorization code claim failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return err("lookup_failed");
  }
}

/**
 * Verify a PKCE `code_verifier` against the stored S256 challenge.
 *
 * S256 only — `plain` is not accepted, and the schema's CHECK constraint means
 * a `plain` challenge cannot even be stored. The comparison is constant-time
 * because both sides are fixed-length base64url digests.
 */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  // RFC 7636 §4.1: 43-128 characters from the unreserved set. Enforced here so
  // a degenerate verifier (empty, or a single character) cannot be used to
  // brute-force a challenge.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const computed = base64UrlEncode(new Uint8Array(digest));
  return constantTimeEqual(computed, challenge);
}

/** base64url, per RFC 7636: the PKCE challenge is compared as an unpadded
 * base64url string, so the padding and the two substitutions both matter. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Shape check for an incoming `code_challenge`. A base64url SHA-256 digest is
 * always exactly 43 characters unpadded; anything else was not produced by the
 * S256 method the client claimed. */
export function isValidCodeChallenge(challenge: string): boolean {
  return /^[A-Za-z0-9\-._~]{43}$/.test(challenge);
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds, for the `expires_in` field of the token response. */
  expiresIn: number;
  scope: string;
}

interface OAuthTokenRow {
  id: string;
  access_token_hash: string;
  refresh_token_hash: string | null;
  previous_refresh_token_hash: string | null;
  client_id: string;
  user_id: string;
  scope: string;
  access_expires_at: string;
  refresh_expires_at: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Issues an access/refresh pair for a fresh grant. */
export async function issueTokens(
  db: D1Database,
  logger: Logger,
  opts: { clientId: string; userId: string; scope: string; codeId?: string },
): Promise<Result<IssuedTokens, AppError>> {
  try {
    const accessToken = randomSecret("stratum_mcp");
    const refreshToken = randomSecret("stratum_mcprt");
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO oauth_tokens
           (id, access_token_hash, refresh_token_hash, client_id, user_id, scope,
            access_expires_at, refresh_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        newId("mcpt"),
        await hashToken(accessToken),
        await hashToken(refreshToken),
        opts.clientId,
        opts.userId,
        opts.scope,
        new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
        new Date(now + REFRESH_TOKEN_TTL_MS).toISOString(),
        new Date(now).toISOString(),
      )
      .run();
    logger.info("OAuth tokens issued", {
      codeId: opts.codeId,
      clientId: opts.clientId,
      userId: opts.userId,
      scope: opts.scope,
    });
    return ok({
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: opts.scope,
    });
  } catch (error) {
    const appError = toAppError(error, "issueTokens", { clientId: opts.clientId });
    logger.error("Failed to issue OAuth tokens", appError, { clientId: opts.clientId });
    return err(appError);
  }
}

/**
 * Rotate a refresh token, returning a new pair.
 *
 * Rotation is mandatory in OAuth 2.1 for public clients, and it is done as an
 * UPDATE keyed on the OLD hash with `refresh_token_hash = ?` in the WHERE
 * clause. That makes the swap atomic: two concurrent refreshes with the same
 * token cannot both succeed, because the second one's WHERE no longer matches.
 *
 * The grant keeps its row and its id across rotations, so revoking a client's
 * access stays a single update rather than a walk of a token chain.
 */
export async function rotateRefreshToken(
  db: D1Database,
  logger: Logger,
  opts: { refreshToken: string; clientId: string },
): Promise<Result<IssuedTokens, AppError | NotFoundError>> {
  const oldHash = await hashToken(opts.refreshToken);
  let row: OAuthTokenRow | null;
  try {
    // Matched against the CURRENT hash or the one rotation last retired, so a
    // token that was already spent is recognised as this grant's rather than as
    // an unknown string.
    row = await db
      .prepare(
        `SELECT * FROM oauth_tokens
          WHERE refresh_token_hash = ? OR previous_refresh_token_hash = ?`,
      )
      .bind(oldHash, oldHash)
      .first<OAuthTokenRow>();
  } catch (error) {
    const appError = toAppError(error, "rotateRefreshToken", {});
    logger.warn("Refresh token lookup failed", { error: appError.message });
    return err(appError);
  }

  if (!row) return err(new NotFoundError("Refresh token", "by-token"));

  // REUSE DETECTION. Rotation retires a refresh token; presenting a retired one
  // means two parties hold the same credential, and only one of them is the
  // rightful client. OAuth 2.1 §4.3.1 and RFC 9700 §4.14 both prescribe
  // revoking the whole grant here — the legitimate client re-authorizes with a
  // consent screen, the thief's copy is worthless.
  //
  // This is the refresh-side counterpart of the authorization-code replay rule
  // this module already implements; leaving it out is what lets a stolen
  // refresh token grant silent access until someone notices by hand.
  if (row.previous_refresh_token_hash !== null && row.previous_refresh_token_hash === oldHash) {
    logger.warn("Retired refresh token replayed; revoking the grant", {
      grantId: row.id,
      clientId: row.client_id,
    });
    await revokeGrantsForClientUser(db, logger, {
      clientId: row.client_id,
      userId: row.user_id,
    });
    return err(new NotFoundError("Refresh token", "reused"));
  }

  if (row.revoked_at !== null) return err(new NotFoundError("Refresh token", "revoked"));
  if (isExpired(row.refresh_expires_at)) return err(new NotFoundError("Refresh token", "expired"));
  // A refresh token is bound to the client it was issued to. Without this check
  // any registered client could present a leaked refresh token and be handed a
  // working access token for someone else's account.
  if (row.client_id !== opts.clientId) {
    logger.warn("Refresh token presented by the wrong client", {
      tokenClientId: row.client_id,
      presentedClientId: opts.clientId,
    });
    return err(new NotFoundError("Refresh token", "client-mismatch"));
  }

  try {
    const accessToken = randomSecret("stratum_mcp");
    const refreshToken = randomSecret("stratum_mcprt");
    const now = Date.now();
    // The sliding window, clamped to the grant's absolute deadline. An
    // unparseable `created_at` falls back to the sliding value rather than
    // producing a NaN timestamp that `isExpired` would then read as expired —
    // a bad row must not silently disconnect a working editor.
    const createdAt = Date.parse(row.created_at);
    const slidingExpiry = now + REFRESH_TOKEN_TTL_MS;
    const refreshExpiry = Number.isFinite(createdAt)
      ? Math.min(slidingExpiry, createdAt + REFRESH_GRANT_MAX_MS)
      : slidingExpiry;

    const updated = await db
      .prepare(
        `UPDATE oauth_tokens
            SET access_token_hash = ?, refresh_token_hash = ?,
                previous_refresh_token_hash = ?,
                access_expires_at = ?, refresh_expires_at = ?
          WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
      )
      .bind(
        await hashToken(accessToken),
        await hashToken(refreshToken),
        // Retiring, not discarding: this is what makes the reuse check above
        // able to tell a stolen token from an unknown one.
        oldHash,
        new Date(now + ACCESS_TOKEN_TTL_MS).toISOString(),
        new Date(refreshExpiry).toISOString(),
        row.id,
        oldHash,
      )
      .run();
    if (updated.meta.changes === 0) {
      // Another refresh won the race, or the grant was revoked in between.
      return err(new NotFoundError("Refresh token", "already-rotated"));
    }
    logger.info("OAuth tokens rotated", { grantId: row.id, clientId: row.client_id });
    return ok({
      accessToken,
      refreshToken,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: row.scope,
    });
  } catch (error) {
    const appError = toAppError(error, "rotateRefreshToken", { grantId: row.id });
    logger.error("Failed to rotate refresh token", appError, { grantId: row.id });
    return err(appError);
  }
}

export interface ResolvedOAuthToken {
  user: User;
  scope: ApiTokenScope;
  grantId: string;
  clientId: string;
  lastUsedAt?: string;
}

interface ResolvedOAuthRow {
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
  grant_id: string;
  client_id: string;
  token_scope: string;
  access_expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** A refusal that names the account, for the auth-failure audit (#255). */
function rejected(reason: CredentialRejection, row: ResolvedOAuthRow): RejectedCredentialError {
  return new RejectedCredentialError(reason, row.user_id, row.grant_id);
}

/**
 * Resolve an OAuth access token to its user, for `authMiddleware`.
 *
 * Fails CLOSED on every branch, matching `resolveApiToken`: a missing row, a
 * revoked or expired grant, a deleting owner, or a D1 error all reject. A
 * transient storage failure must never authenticate an account the deletion
 * cascade is erasing.
 */
export async function resolveOAuthAccessToken(
  db: D1Database,
  plaintext: string,
  logger: Logger,
): Promise<Result<ResolvedOAuthToken, NotFoundError | AppError>> {
  const tokenHash = await hashToken(plaintext);

  let row: ResolvedOAuthRow | null;
  try {
    row = await db
      .prepare(
        `SELECT u.id AS user_id, u.email, u.username, u.github_id, u.github_username,
                u.token_hash AS user_token_hash, u.created_at AS user_created_at, u.deleting_at, u.disabled_at,
                u.telemetry_opt_out,
                t.id AS grant_id, t.client_id, t.scope AS token_scope,
                t.access_expires_at, t.last_used_at, t.revoked_at
           FROM oauth_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.access_token_hash = ?`,
      )
      .bind(tokenHash)
      .first<ResolvedOAuthRow>();
  } catch (error) {
    logger.warn("OAuth access-token lookup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return err(new AppError("Token lookup failed", "DATABASE_ERROR", 500));
  }

  if (!row) return err(new NotFoundError("Token", "by-token"));
  if (row.revoked_at !== null) return err(rejected("revoked", row));
  if (row.deleting_at !== null) return err(rejected("owner-deleting", row));
  // A SCIM-disabled owner is as inert as a deleting one (#253); the column is
  // NULL on enabled accounts, and `!= null` also tolerates a stub row without it.
  if (row.disabled_at != null) return err(rejected("owner-disabled", row));
  if (isExpired(row.access_expires_at)) return err(rejected("expired", row));

  const user: User = {
    id: row.user_id,
    email: row.email,
    username: row.username,
    tokenHash: row.user_token_hash,
    createdAt: row.user_created_at,
  };
  if (row.github_id !== null) user.githubId = row.github_id;
  if (row.github_username !== null) user.githubUsername = row.github_username;
  // Compared against 1 rather than read for truthiness, so a read that omits
  // the column means "opted in" instead of leaking `undefined` into a test.
  if (row.telemetry_opt_out === 1) user.telemetryOptOut = true;

  const resolved: ResolvedOAuthToken = {
    user,
    scope: narrowOAuthScope(row.token_scope),
    grantId: row.grant_id,
    clientId: row.client_id,
  };
  if (row.last_used_at !== null) resolved.lastUsedAt = row.last_used_at;
  return ok(resolved);
}

/** Debounced `last_used_at` write, so "is this grant still in use" is
 * answerable without a D1 write on every authenticated MCP call. */
export async function touchOAuthTokenLastUsed(
  db: D1Database,
  logger: Logger,
  opts: { grantId: string; lastUsedAt?: string },
): Promise<void> {
  const previous = opts.lastUsedAt === undefined ? 0 : Date.parse(opts.lastUsedAt);
  // An unparseable previous value reads as 0 and therefore rewrites, which is
  // the direction that repairs the row rather than freezing it.
  if (Number.isFinite(previous) && Date.now() - previous < LAST_USED_DEBOUNCE_MS) return;
  try {
    await db
      .prepare("UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), opts.grantId)
      .run();
  } catch (error) {
    // Best-effort telemetry on a background path; never fail a request for it.
    logger.debug("Failed to touch OAuth token last_used_at", {
      grantId: opts.grantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * RFC 7009 revocation. Accepts either half of a pair and revokes the whole
 * grant — revoking only the presented half would leave the other one working,
 * which is the opposite of what "revoke" means to the person clicking it.
 *
 * Idempotent and silent about whether the token existed: the RFC requires a 200
 * either way, so a caller cannot use this endpoint as a token oracle.
 */
export async function revokeToken(
  db: D1Database,
  logger: Logger,
  opts: { token: string; clientId?: string },
): Promise<Result<{ revoked: boolean }, AppError>> {
  const hash = await hashToken(opts.token);
  try {
    const bindings: unknown[] = [new Date().toISOString(), hash, hash];
    let sql = `UPDATE oauth_tokens SET revoked_at = ?
        WHERE (access_token_hash = ? OR refresh_token_hash = ?) AND revoked_at IS NULL`;
    // When the caller authenticated as a client, confine the revocation to that
    // client's own grants so one registered client cannot revoke another's.
    if (opts.clientId !== undefined) {
      sql += " AND client_id = ?";
      bindings.push(opts.clientId);
    }
    const result = await db
      .prepare(sql)
      .bind(...bindings)
      .run();
    return ok({ revoked: result.meta.changes > 0 });
  } catch (error) {
    const appError = toAppError(error, "revokeToken", {});
    logger.error("Failed to revoke OAuth token", appError, {});
    return err(appError);
  }
}

/** Revokes every live grant issued from a given authorization code's client to
 * a user. Used when a code replay is detected (RFC 6749 §10.5). */
export async function revokeGrantsForClientUser(
  db: D1Database,
  logger: Logger,
  opts: { clientId: string; userId: string },
): Promise<void> {
  try {
    await db
      .prepare(
        "UPDATE oauth_tokens SET revoked_at = ? WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .bind(new Date().toISOString(), opts.clientId, opts.userId)
      .run();
    logger.warn("Revoked all grants after authorization-code replay", opts);
  } catch (error) {
    logger.error(
      "Failed to revoke grants after code replay",
      error instanceof Error ? error : undefined,
      opts,
    );
  }
}

export interface OAuthGrantSummary {
  id: string;
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  lastUsedAt?: string;
  accessExpiresAt: string;
}

/** The connected-clients listing a user sees in settings, newest first.
 * Revoked and fully-expired grants are omitted — this answers "what can reach
 * my account right now", not "what ever could". */
export async function listGrantsForUser(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<OAuthGrantSummary[], AppError>> {
  try {
    const rows = await db
      .prepare(
        `SELECT t.id, t.client_id, t.scope, t.created_at, t.last_used_at,
                t.access_expires_at, t.refresh_expires_at, c.client_name
           FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id
          WHERE t.user_id = ? AND t.revoked_at IS NULL
          ORDER BY t.created_at DESC`,
      )
      .bind(userId)
      .all<{
        id: string;
        client_id: string;
        scope: string;
        created_at: string;
        last_used_at: string | null;
        access_expires_at: string;
        refresh_expires_at: string | null;
        client_name: string;
      }>();
    const live = (rows.results ?? []).filter(
      // A grant whose refresh token is still good remains live even once its
      // hour-old access token has lapsed — that is the whole point of refresh.
      (row) => !isExpired(row.refresh_expires_at) || !isExpired(row.access_expires_at),
    );
    return ok(
      live.map((row) => {
        const summary: OAuthGrantSummary = {
          id: row.id,
          clientId: row.client_id,
          clientName: row.client_name,
          scope: row.scope,
          createdAt: row.created_at,
          accessExpiresAt: row.access_expires_at,
        };
        if (row.last_used_at !== null) summary.lastUsedAt = row.last_used_at;
        return summary;
      }),
    );
  } catch (error) {
    const appError = toAppError(error, "listGrantsForUser", { userId });
    logger.error("Failed to list OAuth grants", appError, { userId });
    return err(appError);
  }
}

/** Revokes one grant on behalf of its owner. Scoped by `user_id` so a grant id
 * guessed or leaked from another account is a no-op, not a cross-account
 * revocation. */
export async function revokeGrantForUser(
  db: D1Database,
  logger: Logger,
  opts: { grantId: string; userId: string },
): Promise<Result<{ revoked: boolean }, AppError>> {
  try {
    const result = await db
      .prepare(
        "UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
      )
      .bind(new Date().toISOString(), opts.grantId, opts.userId)
      .run();
    if (result.meta.changes > 0) logger.info("OAuth grant revoked by owner", opts);
    return ok({ revoked: result.meta.changes > 0 });
  } catch (error) {
    const appError = toAppError(error, "revokeGrantForUser", opts);
    logger.error("Failed to revoke OAuth grant", appError, opts);
    return err(appError);
  }
}

/**
 * Erases a user's OAuth rows for the account-deletion cascade.
 *
 * Both tables carry a `user_id` REFERENCES users(id), so leaving either behind
 * makes the cascade's final `DELETE FROM users` throw and erasure never
 * completes for anyone who ever connected an editor — the same trap
 * `api_tokens` documents in storage/deletion.ts. They are credentials, so they
 * must go regardless of that.
 */
export async function deleteOAuthDataForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").bind(userId).run();
  await db.prepare("DELETE FROM oauth_auth_codes WHERE user_id = ?").bind(userId).run();
}

// ── Housekeeping ────────────────────────────────────────────────────────────

/** How many rows one sweep pass examines. Codes live 60 seconds and the sweep
 * runs every five minutes, so a healthy instance holds a handful; the cap only
 * bounds a pathological backlog, and the next tick takes the rest. */
const CODE_SWEEP_LIMIT = 500;

/** D1 allows 100 bound parameters per statement; deletes are chunked under it. */
const CODE_SWEEP_DELETE_CHUNK = 50;

export interface AuthCodeSweepResult {
  deleted: number;
  unredeemed: number;
  unredeemedByClient: Record<string, number>;
}

/**
 * Delete expired authorization codes, and count the ones nobody redeemed.
 *
 * The deletion is housekeeping; nothing else ever removed these rows. The
 * count is the signal: a code is minted only when a person clicks Allow, and a
 * client that receives it redeems it within seconds. A code that expires
 * unredeemed means consent succeeded and delivery failed — the browser refused
 * the redirect, or the client never reached `/oauth/token` (a client that
 * reached it and was refused is logged there). #355 was exactly this, and it
 * was invisible because nothing counted it. Any non-zero count is logged at
 * warn with the clients involved.
 *
 * Expiry is evaluated in JavaScript, per this module's rule. The query orders
 * by `expires_at` only so the oldest rows come first, which is safe because
 * every value in this table is ISO written by this module.
 */
export async function sweepExpiredAuthorizationCodes(
  db: D1Database,
  logger: Logger,
  now: number = Date.now(),
): Promise<Result<AuthCodeSweepResult, AppError>> {
  try {
    const { results } = await db
      .prepare(
        "SELECT code_hash, client_id, expires_at, consumed_at FROM oauth_auth_codes ORDER BY expires_at ASC LIMIT ?",
      )
      .bind(CODE_SWEEP_LIMIT)
      .all<{
        code_hash: string;
        client_id: string;
        expires_at: string;
        consumed_at: string | null;
      }>();

    const expired = results.filter((row) => {
      const at = Date.parse(row.expires_at);
      return !Number.isFinite(at) || at <= now;
    });
    const unredeemedByClient: Record<string, number> = {};
    for (const row of expired) {
      if (row.consumed_at === null) {
        unredeemedByClient[row.client_id] = (unredeemedByClient[row.client_id] ?? 0) + 1;
      }
    }
    const unredeemed = Object.values(unredeemedByClient).reduce((sum, n) => sum + n, 0);

    for (let i = 0; i < expired.length; i += CODE_SWEEP_DELETE_CHUNK) {
      const chunk = expired.slice(i, i + CODE_SWEEP_DELETE_CHUNK);
      const placeholders = chunk.map(() => "?").join(", ");
      await db
        .prepare(`DELETE FROM oauth_auth_codes WHERE code_hash IN (${placeholders})`)
        .bind(...chunk.map((row) => row.code_hash))
        .run();
    }

    if (unredeemed > 0) {
      logger.warn("Authorization codes expired unredeemed", { unredeemed, unredeemedByClient });
    }
    if (expired.length > 0) {
      logger.info("Swept expired authorization codes", { deleted: expired.length, unredeemed });
    }
    return ok({ deleted: expired.length, unredeemed, unredeemedByClient });
  } catch (error) {
    const appError = toAppError(error, "sweepExpiredAuthorizationCodes", {});
    logger.error("Failed to sweep expired authorization codes", appError, {});
    return err(appError);
  }
}
