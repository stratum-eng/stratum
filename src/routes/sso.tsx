import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { readBodyCapped } from "../services/oidc-discovery";
import { completeBrowserSignIn } from "../services/second-factor";
import { deriveUsernameBase, findAvailableUsername, randomHex } from "../services/sso-usernames";
import { getIdentityByIssuerSubject, upsertIdentity } from "../storage/identities";
import { ensureOrgMember, getOrg } from "../storage/orgs";
import {
  OIDC_STATE_TTL_SECONDS,
  type OidcLoginState,
  type SsoConnection,
  consumeOidcLoginState,
  createOidcLoginState,
  ensureScimMember,
  getScimMember,
  getSsoConnectionById,
  getSsoConnectionByOrgSlug,
  getSsoConnectionByVerifiedDomain,
  purgeExpiredOidcStates,
} from "../storage/sso";
import { createUser, getUser, getUserByEmail } from "../storage/users";
import type { Env, User } from "../types";
import { SourceFooter } from "../ui/components/source-footer";
import { SSO_SECRET_SALT, constantTimeEqual, decryptToken } from "../utils/crypto";
import { NotFoundError } from "../utils/errors";
import { type Logger, createLogger } from "../utils/logger";

/**
 * OIDC single sign-on login flow (#253 Task 5), mounted at /auth/sso.
 * The picker resolves an org slug or work-email domain to a connection, /start
 * begins the authorization-code + PKCE flow, and /callback verifies the
 * id_token (jose, RS256/ES256 only) and signs the user in — linking, adopting,
 * or JIT-creating the account under the connection's verified email domains.
 */

const app = new Hono<{ Bindings: Env }>();

const SSO_STATE_COOKIE = "stratum_sso_state";
const SSO_STATE_COOKIE_PATH = "/auth/sso";
// Starts are cheap (one D1 insert + a redirect), but each mints a state row —
// bound them per source IP like magic-link sends are.
const SSO_START_IP_RATE_LIMIT = 30;
const SSO_START_RATE_WINDOW_SECONDS = 60 * 60;
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
// Asymmetric signatures only: accepting HS256 would let anyone holding the
// (shared) client secret forge id_tokens.
const ID_TOKEN_ALGORITHMS = ["RS256", "ES256"];
const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;

// Codes the /callback redirects back to the picker page with. Raw IdP error
// strings are never reflected — they map to the generic idp_error.
const ERROR_MESSAGES: Record<string, string> = {
  idp_error: "The identity provider returned an error. Please try signing in again.",
  invalid_state: "Sign-in session is invalid or has expired. Please try again.",
  no_email: "Your identity provider did not share an email address. Contact your administrator.",
  unverified_email:
    "Your email address is not verified with your identity provider. Contact your administrator.",
  domain_not_allowed:
    "Your email domain is not registered for this organization's single sign-on. " +
    "Guest accounts cannot sign in here — contact your administrator.",
  account_disabled:
    "This account has been disabled. Contact your organization's administrator to restore access.",
  rate_limited: "Too many sign-in attempts. Please try again in an hour.",
  sso_failed: "Single sign-on failed. Please try again or contact your administrator.",
};

const NO_CONNECTION_MESSAGE = "No SSO configuration found for that organization or email domain.";

type SsoContext = Context<{ Bindings: Env }>;

function requestLogger(c: SsoContext): Logger {
  return createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });
}

/** All /auth/sso endpoints require the server-wide SSO secret, like org-sso.ts. */
function ssoUnconfigured(c: SsoContext): Response | null {
  if (!c.env.SSO_ENCRYPTION_SECRET) {
    return c.json({ error: "SSO is not configured on this server" }, 501);
  }
  return null;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RFC 7636 code_verifier: 32 random bytes base64url-encoded (43 chars). */
function makeCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * A safe post-login destination is a same-origin absolute path: it must start
 * with "/" but not "//" or "/\" (both of which browsers treat as
 * scheme-relative, i.e. an open redirect). C0 controls and DEL are rejected
 * outright — browsers strip ASCII tab/newline before parsing a Location per
 * the WHATWG URL spec, so "/\t/evil.com" would navigate to "//evil.com".
 * Anything else is treated as absent.
 */
function validateRedirectTo(raw: string | undefined | null): string | null {
  if (!raw || !raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return raw;
}

function loginUsable(connection: SsoConnection): boolean {
  return connection.enabled && connection.domainsVerifiedAt !== null;
}

/**
 * Per-IP hourly cap on /start: reads fail open (an auth path must not lock
 * users out on a KV blip) and the counter is committed only once the request
 * is actually going to redirect to the IdP. KV read-then-write is best-effort
 * under concurrency; unlike magic-link sends (#283) a /start admits no email,
 * so an atomic Durable Object counter isn't warranted here.
 */
async function checkSsoStartRateLimit(
  c: SsoContext,
  logger: Logger,
): Promise<{ blocked: boolean; commit: () => Promise<void> }> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const hour = Math.floor(Date.now() / 1000 / SSO_START_RATE_WINDOW_SECONDS);
  const key = `sso_start_ip_rate:${ip}:${hour}`;
  let count = 0;
  try {
    count = Number.parseInt((await c.env.STATE.get(key)) ?? "0");
  } catch (err) {
    count = 0;
    logger.warn("Failed to read SSO start rate limit, allowing request", { error: err });
  }
  const blocked = count >= SSO_START_IP_RATE_LIMIT;
  const commit = async () => {
    try {
      await c.env.STATE.put(key, String(count + 1), {
        expirationTtl: SSO_START_RATE_WINDOW_SECONDS,
      });
    } catch (err) {
      logger.warn("Failed to commit SSO start rate limit", { error: err });
    }
  };
  return { blocked, commit };
}

function ssoErrorRedirect(c: SsoContext, code: keyof typeof ERROR_MESSAGES): Response {
  return c.redirect(`/auth/sso?error=${code}`);
}

interface PickerPageOptions {
  error?: string;
  identifier?: string;
  redirectTo?: string | null;
  status?: 200 | 404 | 429;
}

/** The SSO picker page, styled to match src/routes/login.tsx (shared /ui.css tokens). */
function renderPickerPage(
  c: SsoContext,
  opts: PickerPageOptions = {},
): Response | Promise<Response> {
  const { error, identifier = "", redirectTo = null, status = 200 } = opts;
  return c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Single Sign-On — Stratum</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='6'%20fill='%230d0d0d'/%3E%3Ctext%20x='16'%20y='23'%20font-family='monospace'%20font-size='20'%20font-weight='700'%20fill='%237ca9f7'%20text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E"
        />
        <link rel="stylesheet" href="/ui.css" />
        <style>{`
          /* Color tokens come from the shared stylesheet (/ui.css). */

          .auth-page {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            background: var(--bg-primary);
          }

          .auth-container {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem 1rem;
          }

          .auth-card {
            width: 100%;
            max-width: 400px;
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 2rem;
          }

          .auth-header {
            text-align: center;
            margin-bottom: 1.5rem;
          }

          .auth-title {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--text-primary);
            margin-bottom: 0.5rem;
          }

          .auth-subtitle {
            font-size: 0.9rem;
            color: var(--text-secondary);
            line-height: 1.5;
          }

          .alert {
            padding: 0.875rem 1rem;
            border-radius: 6px;
            margin-bottom: 1rem;
            font-size: 0.9rem;
            line-height: 1.5;
          }

          .alert-error {
            background: var(--error-bg);
            border: 1px solid var(--error-border);
            color: var(--error-text);
          }

          .form-group {
            margin-bottom: 1.25rem;
          }

          .form-label {
            display: block;
            font-size: 0.85rem;
            font-weight: 500;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
          }

          .form-input {
            width: 100%;
            padding: 0.75rem 1rem;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 6px;
            color: var(--text-primary);
            font-family: inherit;
            font-size: 1rem;
            transition: border-color 0.15s, box-shadow 0.15s;
          }

          .form-input:focus {
            outline: none;
            border-color: var(--accent);
            box-shadow: 0 0 0 3px rgba(26, 58, 110, 0.3);
          }

          .form-input::placeholder {
            color: var(--text-tertiary);
          }

          .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            padding: 0.75rem 1rem;
            background: var(--accent);
            border: 1px solid var(--accent);
            border-radius: 6px;
            color: white;
            font-family: inherit;
            font-size: 1rem;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
            text-decoration: none;
          }

          .btn:hover {
            background: var(--accent-hover);
            border-color: var(--accent-hover);
            text-decoration: none;
          }

          .btn:focus {
            outline: none;
            box-shadow: 0 0 0 3px rgba(26, 58, 110, 0.3);
          }

          .auth-help {
            margin-top: 1rem;
            font-size: 0.85rem;
            color: var(--text-tertiary);
            text-align: center;
            line-height: 1.5;
          }

          .auth-footer {
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border);
            text-align: center;
          }

          .auth-footer-text {
            font-size: 0.9rem;
            color: var(--text-secondary);
          }

          .auth-footer a {
            color: var(--accent-text);
            font-weight: 500;
          }

          .auth-footer a:hover {
            color: var(--accent-text-hover);
            text-decoration: underline;
          }

          @media (max-width: 480px) {
            .auth-card {
              padding: 1.5rem;
            }

            .auth-title {
              font-size: 1.25rem;
            }
          }
        `}</style>
      </head>
      <body class="auth-page">
        <nav class="nav">
          <a class="nav-brand" href="/">
            stratum
          </a>
        </nav>
        <main class="auth-container">
          <div class="auth-card">
            <div class="auth-header">
              <h1 class="auth-title">Single sign-on</h1>
              <p class="auth-subtitle">
                Sign in with your organization's identity provider. Enter your organization name or
                your work email address.
              </p>
            </div>

            {error && <div class="alert alert-error">{error}</div>}

            <form action="/auth/sso" method="get">
              <div class="form-group">
                <label class="form-label" for="identifier">
                  Organization or work email
                </label>
                <input
                  class="form-input"
                  type="text"
                  id="identifier"
                  name="identifier"
                  placeholder="acme or you@acme.com"
                  value={identifier}
                  required
                  autoComplete="email"
                />
              </div>
              {redirectTo && <input type="hidden" name="redirect_to" value={redirectTo} />}
              <button type="submit" class="btn">
                Continue
              </button>
            </form>

            <div class="auth-help">
              Your organization's administrator sets up single sign-on. If you're not sure whether
              your organization uses it, ask your administrator.
            </div>

            <div class="auth-footer">
              <p class="auth-footer-text">
                Prefer email? <a href="/auth/login">Sign in with a magic link</a>
              </p>
            </div>
          </div>
        </main>
        <SourceFooter />
      </body>
    </html>,
    status,
  );
}

// GET /auth/sso — picker: resolve an org slug or work-email domain to a
// connection and bounce to its /start. Accepted disclosure: this reveals
// whether a domain has SSO configured (industry-standard discovery behavior).
app.get("/", async (c) => {
  const unconfigured = ssoUnconfigured(c);
  if (unconfigured) return unconfigured;

  const logger = requestLogger(c);
  const errorCode = c.req.query("error");
  const redirectTo = validateRedirectTo(c.req.query("redirect_to"));
  const identifier = (c.req.query("identifier") ?? "").trim().toLowerCase();

  if (!identifier) {
    const error =
      errorCode !== undefined ? (ERROR_MESSAGES[errorCode] ?? "Sign-in failed.") : undefined;
    return renderPickerPage(c, { error, redirectTo });
  }

  // Slug first for bare identifiers (falling back to treating the input as a
  // domain); an email routes by its domain. Misses and lookup failures render
  // the same generic message (fail closed, no oracle beyond configured-or-not).
  let connection: SsoConnection | null = null;
  if (!identifier.includes("@")) {
    const bySlug = await getSsoConnectionByOrgSlug(c.env.DB, logger, identifier);
    if (bySlug.success && loginUsable(bySlug.data)) connection = bySlug.data;
  }
  if (!connection) {
    const domain = identifier.split("@").pop() ?? "";
    const byDomain = await getSsoConnectionByVerifiedDomain(c.env.DB, logger, domain);
    if (byDomain.success && loginUsable(byDomain.data)) connection = byDomain.data;
  }

  if (!connection) {
    return renderPickerPage(c, { error: NO_CONNECTION_MESSAGE, identifier, redirectTo });
  }

  const orgResult = await getOrg(c.env.DB, logger, connection.orgId);
  if (!orgResult.success) {
    logger.error("SSO connection points at a missing org", orgResult.error, {
      connectionId: connection.id,
    });
    return renderPickerPage(c, { error: NO_CONNECTION_MESSAGE, identifier, redirectTo });
  }

  const params = new URLSearchParams();
  if (redirectTo) params.set("redirect_to", redirectTo);
  const query = params.toString();
  return c.redirect(`/auth/sso/${orgResult.data.slug}/start${query ? `?${query}` : ""}`);
});

// GET /auth/sso/:slug/start — begin the authorization-code + PKCE flow.
app.get("/:slug/start", async (c) => {
  const unconfigured = ssoUnconfigured(c);
  if (unconfigured) return unconfigured;

  const logger = requestLogger(c);
  const slug = c.req.param("slug");

  const connectionResult = await getSsoConnectionByOrgSlug(c.env.DB, logger, slug);
  if (!connectionResult.success || !loginUsable(connectionResult.data)) {
    // Same generic message for unknown slug, disabled, and unverified — a
    // probe learns only "not usable for login".
    logger.warn("SSO start for unusable connection", { slug });
    return renderPickerPage(c, { error: NO_CONNECTION_MESSAGE, status: 404 });
  }
  const connection = connectionResult.data;

  const rateLimit = await checkSsoStartRateLimit(c, logger);
  if (rateLimit.blocked) {
    logger.warn("SSO start rate limit exceeded", { slug });
    return renderPickerPage(c, { error: ERROR_MESSAGES.rate_limited, status: 429 });
  }

  // Opportunistic cleanup — best-effort, never blocks the login.
  await purgeExpiredOidcStates(c.env.DB, logger);

  const redirectTo = validateRedirectTo(c.req.query("redirect_to"));
  const nonce = randomHex(32);
  const codeVerifier = makeCodeVerifier();
  const codeChallenge = await codeChallengeS256(codeVerifier);

  const stateResult = await createOidcLoginState(c.env.DB, logger, {
    connectionId: connection.id,
    nonce,
    codeVerifier,
    redirectTo,
  });
  if (!stateResult.success) {
    logger.error("Failed to persist OIDC login state", stateResult.error, { slug });
    return c.json({ error: "Failed to start sign-in" }, 500);
  }
  const state = stateResult.data;

  await rateLimit.commit();

  // Browser-binding cookie: the callback's state must match it (constant-time)
  // — the D1 row's atomic consumption handles replay, the cookie handles
  // login-CSRF / session fixation (same double-submit binding as auth.ts).
  setCookie(c, SSO_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: OIDC_STATE_TTL_SECONDS,
    path: SSO_STATE_COOKIE_PATH,
  });

  // One canonical callback for all connections, derived from the request
  // origin so start and callback always agree.
  const redirectUri = `${new URL(c.req.url).origin}/auth/sso/callback`;
  const authorizeUrl = new URL(connection.authorizationEndpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", connection.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  logger.info("Redirecting to IdP authorization endpoint", {
    connectionId: connection.id,
    orgId: connection.orgId,
  });
  return c.redirect(authorizeUrl.toString());
});

interface IdTokenClaims {
  subject: string;
  email: string;
}

type ClaimRefusal = "no_email" | "unverified_email" | "domain_not_allowed" | "sso_failed";

/**
 * Apply the PRD email-claim rules to a verified id_token payload: `sub` and
 * `email` required; `email_verified` present as boolean false OR string
 * "false" (Entra emits string booleans) → reject; the (normalized) email's
 * domain must be one of the connection's verified domains — IdP guests
 * outside those domains are refused.
 */
function extractClaims(
  payload: Record<string, unknown>,
  connection: SsoConnection,
  logger: Logger,
): { claims: IdTokenClaims } | { refusal: ClaimRefusal } {
  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length === 0) {
    logger.warn("id_token missing sub claim", { connectionId: connection.id });
    return { refusal: "sso_failed" };
  }
  const rawEmail = payload.email;
  if (typeof rawEmail !== "string" || rawEmail.trim().length === 0) {
    logger.warn("id_token missing email claim", { connectionId: connection.id });
    return { refusal: "no_email" };
  }
  const emailVerified = payload.email_verified;
  if (emailVerified === false || emailVerified === "false") {
    logger.warn("id_token email is unverified", { connectionId: connection.id });
    return { refusal: "unverified_email" };
  }
  const email = rawEmail.trim().toLowerCase();
  const domain = email.split("@").pop() ?? "";
  if (!connection.emailDomains.includes(domain)) {
    logger.warn("id_token email outside verified domains", { connectionId: connection.id });
    return { refusal: "domain_not_allowed" };
  }
  return { claims: { subject, email } };
}

/** Exchange the authorization code (client_secret_post + PKCE); null on any failure. */
async function exchangeCodeForIdToken(
  connection: SsoConnection,
  clientSecret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  logger: Logger,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(connection.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: connection.clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      }),
      // Same policy as discovery: the endpoint passed validateOidcUrl, a
      // redirect target did not — and a 307/308 would re-send client_secret
      // and code_verifier to it.
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    logger.warn("OIDC token exchange request failed", { connectionId: connection.id });
    return null;
  }
  if (!res.ok) {
    logger.warn("OIDC token exchange returned non-OK status", {
      connectionId: connection.id,
      status: res.status,
    });
    return null;
  }
  const body = await readBodyCapped(res, MAX_TOKEN_RESPONSE_BYTES);
  if (body === null) {
    logger.warn("OIDC token response exceeded size cap", { connectionId: connection.id });
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return null;
    const idToken = (parsed as Record<string, unknown>).id_token;
    return typeof idToken === "string" && idToken.length > 0 ? idToken : null;
  } catch {
    logger.warn("OIDC token response is not valid JSON", { connectionId: connection.id });
    return null;
  }
}

type ResolutionFailure =
  | { kind: "redirect"; code: keyof typeof ERROR_MESSAGES }
  | { kind: "server_error" };

type ResolutionResult = { userId: string } | ResolutionFailure;

function isDisabled(user: User): boolean {
  return Boolean(user.disabledAt || user.deletingAt);
}

/**
 * PRD identity resolution: (1) (issuer, sub) identity → sign in; (2) existing
 * user by verified-domain email → adopt (org membership + scim_members +
 * identity link); (3) JIT create. Disabled/deleting accounts are refused on
 * every branch BEFORE any membership or session write. Storage failures fail
 * the login closed — falling through could provision a duplicate account.
 */
async function resolveSsoUser(
  db: D1Database,
  logger: Logger,
  connection: SsoConnection,
  claims: IdTokenClaims,
): Promise<ResolutionResult> {
  const identityLookup = await getIdentityByIssuerSubject(
    db,
    logger,
    connection.issuer,
    claims.subject,
  );
  if (identityLookup.success) {
    const userResult = await getUser(db, identityLookup.data.userId, logger);
    if (!userResult.success) {
      logger.error("SSO identity points at a missing user", userResult.error, {
        identityId: identityLookup.data.id,
      });
      return { kind: "server_error" };
    }
    if (isDisabled(userResult.data)) {
      logger.warn("Blocked SSO sign-in — account disabled", { userId: userResult.data.id });
      return { kind: "redirect", code: "account_disabled" };
    }
    // For this connection, a sub-match signs in only: membership and the
    // scim_members row were established at adopt/JIT time and are SCIM's to
    // manage from then on. But when the identity was established via a
    // DIFFERENT connection (one IdP issuer serving several orgs, each with
    // its own verified domains — extractClaims already enforced this org's),
    // this org's membership was never written: establish it now. The identity
    // row keeps its original connection_id, so the scim_members row — not the
    // identity's connection — is what records "already established here":
    // without that check, every later login would re-add a user an org admin
    // had removed.
    if (identityLookup.data.connectionId !== connection.id) {
      const userId = userResult.data.id;
      const managed = await getScimMember(db, logger, connection.id, userId);
      if (!managed.success) return { kind: "server_error" };
      if (managed.data !== null) return { userId };
      const memberResult = await ensureOrgMember(db, logger, connection.orgId, userId, "member");
      if (!memberResult.success) {
        logger.error("Failed to add SSO user to org", memberResult.error, { userId });
        return { kind: "server_error" };
      }
      const scimResult = await ensureScimMember(db, logger, connection.id, userId);
      if (!scimResult.success) return { kind: "server_error" };
    }
    return { userId: userResult.data.id };
  }
  if (!(identityLookup.error instanceof NotFoundError)) {
    logger.error("SSO identity lookup failed", identityLookup.error);
    return { kind: "server_error" };
  }

  const byEmail = await getUserByEmail(db, claims.email, logger);
  let userId: string;
  if (byEmail.success) {
    if (isDisabled(byEmail.data)) {
      logger.warn("Blocked SSO sign-in — account disabled", { userId: byEmail.data.id });
      return { kind: "redirect", code: "account_disabled" };
    }
    userId = byEmail.data.id;
    logger.info("Adopting existing account into SSO", { userId, orgId: connection.orgId });
  } else {
    // JIT creation deliberately bypasses the beta gate: the verified email
    // domain (DNS-proven org ownership) substitutes for an invite code.
    const base = deriveUsernameBase(claims.email);
    let username = await findAvailableUsername(db, logger, base);
    let created = await createUser(db, claims.email, logger, username);
    if (!created.success) {
      // A concurrent first login (or username claim) can win the UNIQUE race;
      // re-derive and retry exactly once before failing.
      username = await findAvailableUsername(db, logger, base);
      created = await createUser(db, claims.email, logger, username);
    }
    if (!created.success) {
      // The email UNIQUE race: the racing login created the account — adopt it.
      // Residual: a username-UNIQUE loss on both attempts (double random-suffix
      // collision) lands here too and 500s; the user's retry succeeds.
      const raced = await getUserByEmail(db, claims.email, logger);
      if (!raced.success || isDisabled(raced.data)) {
        logger.error("Failed to JIT-create SSO user", created.error);
        return { kind: "server_error" };
      }
      userId = raced.data.id;
    } else {
      userId = created.data.user.id;
      logger.info("JIT-created SSO user", { userId, orgId: connection.orgId });
    }
  }

  // ensureOrgMember, never addOrgMember: adopting an org owner/admin into SSO
  // must not demote their existing role to 'member'.
  const memberResult = await ensureOrgMember(db, logger, connection.orgId, userId, "member");
  if (!memberResult.success) {
    logger.error("Failed to add SSO user to org", memberResult.error, { userId });
    return { kind: "server_error" };
  }
  const scimResult = await ensureScimMember(db, logger, connection.id, userId);
  if (!scimResult.success) return { kind: "server_error" };

  const identityResult = await upsertIdentity(db, logger, {
    userId,
    provider: "oidc",
    issuer: connection.issuer,
    subject: claims.subject,
    email: claims.email,
    connectionId: connection.id,
  });
  if (!identityResult.success) {
    // Fail closed (unlike the best-effort OAuth backfill): for SSO the
    // identity row IS the credential, and a Conflict here means the pair was
    // concurrently linked to another account.
    logger.error("Failed to link SSO identity", identityResult.error, { userId });
    return { kind: "server_error" };
  }

  return { userId };
}

// GET /auth/sso/callback — the single redirect URI for all connections.
app.get("/callback", async (c) => {
  const unconfigured = ssoUnconfigured(c);
  if (unconfigured) return unconfigured;

  const logger = requestLogger(c);
  const query = c.req.query();

  if (query.error) {
    // Never reflect raw IdP strings into HTML; log them truncated instead.
    logger.warn("IdP returned an error on callback", {
      error: String(query.error).slice(0, 100),
      description: String(query.error_description ?? "").slice(0, 200),
    });
    return ssoErrorRedirect(c, "idp_error");
  }

  const state = query.state;
  if (!state) {
    logger.warn("SSO callback missing state parameter");
    return ssoErrorRedirect(c, "invalid_state");
  }

  const cookieState = getCookie(c, SSO_STATE_COOKIE);
  deleteCookie(c, SSO_STATE_COOKIE, { path: SSO_STATE_COOKIE_PATH });
  if (!cookieState || !constantTimeEqual(cookieState, state)) {
    logger.warn("SSO callback state not bound to this browser", {
      statePrefix: state.slice(0, 8),
    });
    return ssoErrorRedirect(c, "invalid_state");
  }

  // Atomic single-use: exactly one callback per state wins, even under a race.
  const consumed = await consumeOidcLoginState(c.env.DB, logger, state);
  if (!consumed.success) {
    logger.error("Failed to consume SSO login state", consumed.error);
    return c.json({ error: "Failed to sign in" }, 500);
  }
  const loginState: OidcLoginState | null = consumed.data;
  if (!loginState) {
    logger.warn("SSO state unknown, expired, or replayed", { statePrefix: state.slice(0, 8) });
    return ssoErrorRedirect(c, "invalid_state");
  }

  const code = query.code;
  if (!code) {
    logger.warn("SSO callback missing code parameter");
    return ssoErrorRedirect(c, "sso_failed");
  }

  const connectionResult = await getSsoConnectionById(c.env.DB, logger, loginState.connectionId);
  if (!connectionResult.success) {
    if (connectionResult.error instanceof NotFoundError) {
      logger.warn("SSO connection deleted mid-login", { connectionId: loginState.connectionId });
      return ssoErrorRedirect(c, "sso_failed");
    }
    return c.json({ error: "Failed to sign in" }, 500);
  }
  const connection = connectionResult.data;
  // Re-check at callback time: an admin may have disabled the connection (or
  // its verification may have been cleared) after /start issued the state.
  if (!loginUsable(connection)) {
    logger.warn("SSO connection no longer usable at callback", { connectionId: connection.id });
    return ssoErrorRedirect(c, "sso_failed");
  }

  // ssoUnconfigured guarantees the secret is set.
  const encryptionSecret = c.env.SSO_ENCRYPTION_SECRET as string;
  const clientSecret = await decryptToken(
    connection.clientSecretCiphertext,
    encryptionSecret,
    SSO_SECRET_SALT,
  );
  if (clientSecret === null) {
    logger.error("Failed to decrypt SSO client secret", undefined, {
      connectionId: connection.id,
    });
    return c.json({ error: "Failed to sign in" }, 500);
  }

  const redirectUri = `${new URL(c.req.url).origin}/auth/sso/callback`;
  const idToken = await exchangeCodeForIdToken(
    connection,
    clientSecret,
    code,
    loginState.codeVerifier,
    redirectUri,
    logger,
  );
  if (idToken === null) return ssoErrorRedirect(c, "sso_failed");

  // JWKS is fetched per login in practice (Workers isolates are ephemeral;
  // jose's in-isolate cache is best-effort) — accepted latency cost.
  let payload: Record<string, unknown>;
  try {
    const jwks = createRemoteJWKSet(new URL(connection.jwksUri));
    const verified = await jwtVerify(idToken, jwks, {
      issuer: connection.issuer,
      audience: connection.clientId,
      algorithms: ID_TOKEN_ALGORITHMS,
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
    });
    payload = verified.payload;
  } catch (err) {
    logger.warn("id_token verification failed", {
      connectionId: connection.id,
      reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
    return ssoErrorRedirect(c, "sso_failed");
  }

  // Multi-audience tokens require azp per OIDC Core §3.1.3.7. jose only
  // checks that our client_id is AMONG the audiences — pin azp so a token
  // minted for a different party in the same audience list is refused.
  if (Array.isArray(payload.aud) && payload.azp !== connection.clientId) {
    logger.warn("id_token azp missing or mismatched on multi-audience token", {
      connectionId: connection.id,
    });
    return ssoErrorRedirect(c, "sso_failed");
  }

  if (typeof payload.nonce !== "string" || payload.nonce !== loginState.nonce) {
    logger.warn("id_token nonce mismatch", { connectionId: connection.id });
    return ssoErrorRedirect(c, "invalid_state");
  }

  const extraction = extractClaims(payload, connection, logger);
  if ("refusal" in extraction) return ssoErrorRedirect(c, extraction.refusal);

  const resolution = await resolveSsoUser(c.env.DB, logger, connection, extraction.claims);
  if ("kind" in resolution) {
    if (resolution.kind === "redirect") return ssoErrorRedirect(c, resolution.code);
    return c.json({ error: "Failed to sign in" }, 500);
  }
  const { userId } = resolution;

  const sessionLogger = logger.child({ userId });
  // The session records which org's IdP authenticated it: that org's own
  // "require a second factor" policy is delegated to its IdP (#256). A user who
  // has enrolled a passkey is still asked for it — the passkey protects the
  // whole account, not only this org's resources.
  const signedIn = await completeBrowserSignIn(c, sessionLogger, {
    userId,
    method: "oidc",
    // Matches the 30-day cookie this flow has always set.
    rememberMe: true,
    // Re-validate on read: the stored value went through validateRedirectTo at
    // /start, but a DB value must not be trusted as a redirect target.
    redirectTo: validateRedirectTo(loginState.redirectTo) ?? "/",
    ssoOrgId: connection.orgId,
    auditDetail: { orgId: connection.orgId },
  });
  if (!signedIn.success) {
    sessionLogger.error("Failed to create session", signedIn.error);
    return c.json({ error: "Failed to create session" }, 500);
  }
  sessionLogger.info("OIDC SSO sign-in successful", { orgId: connection.orgId });
  return signedIn.data;
});

export { app as ssoRouter };
