import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { completeBrowserSignIn } from "../services/second-factor";
import { getIdentityByIssuerSubject, upsertIdentity } from "../storage/identities";
import { deleteSession, getSession } from "../storage/sessions";
import { getUser, getUserByEmail, getUserByGitHubId, signInGitHubUser } from "../storage/users";
import type { Env } from "../types";
import { constantTimeEqual } from "../utils/crypto";
import { NotFoundError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { createLogger } from "../utils/logger";
import { consumePostLoginRedirect, isSafeRedirectTarget } from "../utils/post-login-redirect";
import { beginPendingSignup, suggestUsername } from "./oauth-signup";

const app = new Hono<{ Bindings: Env }>();

const OAUTH_STATE_COOKIE = "stratum_oauth_state";
const OAUTH_STATE_TTL_SECONDS = 600;

// Canonical issuer values for the identities table (see src/storage/identities.ts).
// RESERVED: the OIDC connection-registration flow (org SSO) must reject these
// issuers — an org-supplied connection claiming either could re-point rows in
// the GitHub/Google identity namespace via upsertIdentity's ON CONFLICT.
const GITHUB_ISSUER = "https://github.com";
const GOOGLE_ISSUER = "https://accounts.google.com";

/**
 * Record the external identity for a completed OAuth sign-in. Non-fatal by
 * design: identity rows are forward-provisioning for SSO (backfilled lazily at
 * login), while GitHub login is still keyed off users.github_id and Google
 * falls back to email match — so a storage blip here must not lock anyone out.
 * The next successful login retries the upsert.
 */
async function recordOAuthIdentity(
  db: D1Database,
  logger: Logger,
  input: {
    userId: string;
    provider: "github" | "google";
    issuer: string;
    subject: string;
    email: string;
  },
): Promise<void> {
  const result = await upsertIdentity(db, logger, input);
  if (!result.success) {
    logger.error("Failed to upsert OAuth identity; continuing login", result.error, {
      provider: input.provider,
      userId: input.userId,
    });
  }
}

/**
 * Mint an OAuth state, persist it in KV (replay prevention), and bind it to
 * the initiating browser via a short-lived cookie (login-CSRF prevention).
 *
 * The KV record is also where a requested post-login destination rides out
 * the round trip: the provider sends back only `code` and `state`, so a
 * `next` on the start URL survives only if it is stored under the state and
 * read back when the state is consumed. It is validated before storage, so
 * the callback can trust whatever it finds there.
 */
async function issueOAuthState(
  c: Parameters<typeof setCookie>[0],
  kv: KVNamespace,
  next?: string,
): Promise<string> {
  const state = crypto.randomUUID().replace(/-/g, "");
  const record = next === undefined ? "1" : JSON.stringify({ next });
  await kv.put(`oauth_state:${state}`, record, { expirationTtl: OAUTH_STATE_TTL_SECONDS });
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: OAUTH_STATE_TTL_SECONDS,
    path: "/auth",
  });
  return state;
}

/**
 * Validate a callback's state: it must match the browser's state cookie
 * (constant-time) AND exist in KV. Consumes both on success, returning the
 * destination stored with the state (if any); null when the state is bad.
 */
async function consumeOAuthState(
  c: Parameters<typeof getCookie>[0] & Parameters<typeof deleteCookie>[0],
  kv: KVNamespace,
  state: string,
): Promise<{ next?: string } | null> {
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  if (!cookieState || !constantTimeEqual(cookieState, state)) {
    return null;
  }
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/auth" });

  const stateKey = `oauth_state:${state}`;
  const stored = await kv.get(stateKey);
  if (!stored) return null;
  await kv.delete(stateKey);
  // A bare "1" is a state with nothing attached (the historical shape).
  if (!stored.startsWith("{")) return {};
  try {
    const parsed = JSON.parse(stored) as { next?: unknown };
    return typeof parsed.next === "string" ? { next: parsed.next } : {};
  } catch {
    return {};
  }
}

/**
 * A `next` from the request, reduced to a same-origin path — or undefined
 * when it is missing or unsafe, so an open redirect never gets stored.
 */
function safeNextPath(next: string | undefined, requestUrl: string): string | undefined {
  if (!next || !isSafeRedirectTarget(next, requestUrl)) return undefined;
  const url = new URL(next, new URL(requestUrl).origin);
  return url.pathname + url.search + url.hash;
}

app.get("/github", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const clientId = c.env.GITHUB_CLIENT_ID;
  const redirectUri = c.env.OAUTH_REDIRECT_URI;

  if (!clientId || !c.env.GITHUB_CLIENT_SECRET) {
    logger.warn("GitHub OAuth not configured");
    return c.json({ error: "GitHub OAuth is not configured" }, 501);
  }

  const state = await issueOAuthState(c, c.env.STATE, safeNextPath(c.req.query("next"), c.req.url));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri ?? "",
    scope: "user:email",
    state,
  });

  logger.debug("Redirecting to GitHub OAuth");
  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get("/github/callback", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const clientId = c.env.GITHUB_CLIENT_ID;
  const clientSecret = c.env.GITHUB_CLIENT_SECRET;
  const redirectUri = c.env.OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret) {
    logger.warn("GitHub OAuth not configured");
    return c.json({ error: "GitHub OAuth is not configured" }, 501);
  }

  const { code, state, next } = c.req.query();

  if (!state) {
    logger.warn("Missing state parameter");
    return c.json({ error: "Missing state parameter" }, 400);
  }

  const consumed = await consumeOAuthState(c, c.env.STATE, state);
  if (consumed === null) {
    logger.warn("Invalid, expired, or unbound state", { statePrefix: state.slice(0, 8) });
    return c.json({ error: "Invalid or expired state" }, 400);
  }

  if (!code) {
    logger.warn("Missing code parameter");
    return c.json({ error: "Missing code parameter" }, 400);
  }

  logger.debug("Exchanging code for token");
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "stratum",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    logger.error("Failed to exchange code for token");
    return c.json({ error: "Failed to exchange code for token" }, 502);
  }

  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    logger.error("GitHub OAuth error", undefined, { error: tokenData.error });
    return c.json({ error: "GitHub OAuth error" }, 502);
  }

  const accessToken = tokenData.access_token;

  logger.debug("Fetching GitHub user data");
  const [userRes, emailsRes] = await Promise.all([
    fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "stratum",
        Accept: "application/vnd.github+json",
      },
    }),
    fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "stratum",
        Accept: "application/vnd.github+json",
      },
    }),
  ]);

  if (!userRes.ok || !emailsRes.ok) {
    logger.error("Failed to fetch GitHub user data");
    return c.json({ error: "Failed to fetch GitHub user data" }, 502);
  }

  const githubUser = await userRes.json<{ id: number; login: string }>();
  const emailsBody = await emailsRes.json<unknown>();
  // A 200 with a non-array body (proxy error page, API drift) must not throw —
  // the empty list already has correct semantics below.
  const emails = (Array.isArray(emailsBody) ? emailsBody : []) as {
    email: string;
    primary: boolean;
    verified: boolean;
  }[];

  // Only an address the provider has verified may identify an account. GitHub
  // lets a user list any address unverified, so matching on one would let
  // anyone reach an existing account by adding its owner's email to their own
  // profile — and would create new accounts under emails nobody has proven.
  // Lowercased so the match hits accounts stored via the magic-link flow,
  // which normalizes.
  const verifiedEmail = (
    emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email
  )
    ?.trim()
    .toLowerCase();

  const githubId = String(githubUser.id);

  // A returning, already-linked user's credential is the GitHub account id
  // itself, so they are not locked out because GitHub currently lists no
  // verified address. That path only ever matches by id — it links and creates
  // nothing — so the verified-email rule still governs every email match.
  let signInEmail = verifiedEmail;
  if (!signInEmail) {
    const linked = await getUserByGitHubId(c.env.DB, githubId, logger);
    if (!linked.success) {
      logger.warn("No verified email found on GitHub account", { githubId: githubUser.id });
      return c.json({ error: "No verified email found on GitHub account" }, 422);
    }
    signInEmail = linked.data.email;
  }

  // A `next` given to /auth/github rides in the state record, since GitHub
  // returns only `code` and `state`; one on the callback URL itself is still
  // honoured so existing links keep behaving as they did. Either wins over the
  // post-login cookie, which is the fallback a flow that started somewhere
  // else — the MCP consent screen, say — uses to get back to its request.
  const nextPath = consumed.next ?? safeNextPath(next, c.req.url);

  // Finds by GitHub id or links by verified email, and creates nothing: an
  // identity with no account comes back as `null`. That decision is made once,
  // inside `signInGitHubUser`, rather than duplicated here — a second copy of
  // the lookup is how a signup slips past the closed-beta gate the moment the
  // two disagree.
  const userResult = await signInGitHubUser(
    c.env.DB,
    { githubId, email: signInEmail, username: githubUser.login },
    logger,
  );

  if (!userResult.success) {
    logger.error("Failed to resolve GitHub user", userResult.error, { githubId });
    return c.json({ error: "Failed to sign in" }, 500);
  }

  if (userResult.data === null) {
    // Only reachable without a verified email if the id-linked account vanished
    // between the two lookups; never park a signup on an unproven address.
    if (!verifiedEmail) {
      logger.warn("No verified email found on GitHub account", { githubId: githubUser.id });
      return c.json({ error: "No verified email found on GitHub account" }, 422);
    }
    // First time we have seen this person: nothing is created until they have
    // chosen a username (and, under the closed beta, presented an invite code).
    logger.info("New GitHub identity; asking for a username", { githubId });
    return beginPendingSignup(c, {
      provider: "github",
      email: verifiedEmail,
      suggestedUsername: suggestUsername(githubUser.login),
      github: { id: githubId, login: githubUser.login },
      ...(nextPath !== undefined ? { next: nextPath } : {}),
    });
  }

  const user = userResult.data;

  // A disabled (or deleting) account must not sign in: refuse BEFORE minting a
  // session, so no stratum_session cookie and no session.created audit row
  // exist for it. `signInGitHubUser` already declined to link a GitHub id onto
  // such a row, so re-enabling it later does not hand it a new credential.
  if (user.disabledAt || user.deletingAt) {
    logger.warn("Blocked GitHub sign-in — account disabled", { userId: user.id });
    return c.redirect("/auth/login?error=account_disabled");
  }

  logger.info("Signing in GitHub user", { githubId });
  const sessionLogger = logger.child({ userId: user.id });

  await recordOAuthIdentity(c.env.DB, sessionLogger, {
    userId: user.id,
    provider: "github",
    issuer: GITHUB_ISSUER,
    subject: githubId,
    // The account's own email when GitHub lists no verified one — an
    // unverified address is never recorded.
    email: signInEmail,
  });

  // Consumed unconditionally, even when `next` won, so a stale destination is
  // never left in the jar for the next sign-in to pick up.
  const remembered = consumePostLoginRedirect(c, "/");
  const signedIn = await completeBrowserSignIn(c, sessionLogger, {
    userId: user.id,
    method: "github-oauth",
    rememberMe: true,
    redirectTo: nextPath ?? remembered,
    // `signin`, never `signup`: a first-time GitHub identity was diverted to
    // the username step above and is counted there, once the account exists.
    analytics: { kind: "signin", provider: "github" },
  });
  if (!signedIn.success) {
    sessionLogger.error("Failed to create session", signedIn.error);
    return c.json({ error: "Failed to create session" }, 500);
  }
  sessionLogger.info("GitHub OAuth successful");
  return signedIn.data;
});

app.get("/google", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !c.env.GOOGLE_CLIENT_SECRET || !redirectUri) {
    logger.warn("Google OAuth not configured");
    return c.json({ error: "Google OAuth is not configured" }, 501);
  }

  const state = await issueOAuthState(c, c.env.STATE, safeNextPath(c.req.query("next"), c.req.url));

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
  });

  logger.debug("Redirecting to Google OAuth");
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/google/callback", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    logger.warn("Google OAuth not configured");
    return c.json({ error: "Google OAuth is not configured" }, 501);
  }

  const { code, state } = c.req.query();

  if (!state) {
    return c.json({ error: "Missing state parameter" }, 400);
  }
  const consumed = await consumeOAuthState(c, c.env.STATE, state);
  if (consumed === null) {
    logger.warn("Invalid, expired, or unbound state", { statePrefix: state.slice(0, 8) });
    return c.json({ error: "Invalid or expired state" }, 400);
  }

  if (!code) {
    return c.json({ error: "Missing code parameter" }, 400);
  }

  logger.debug("Exchanging code for Google token");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    logger.error("Failed to exchange code for Google token");
    return c.json({ error: "Failed to exchange code for token" }, 502);
  }

  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) {
    logger.error("Google OAuth error", undefined, { error: tokenData.error });
    return c.json({ error: "Google OAuth error" }, 502);
  }

  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) {
    logger.error("Failed to fetch Google user data");
    return c.json({ error: "Failed to fetch Google user data" }, 502);
  }

  const googleUser = await userRes.json<{
    sub?: string;
    email?: string;
    email_verified?: boolean;
  }>();

  if (!googleUser.sub) {
    logger.error("Google userinfo response missing sub");
    return c.json({ error: "Failed to fetch Google user data" }, 502);
  }

  // Lowercased so matching hits accounts stored via the magic-link flow, which
  // normalizes; identities.email is normalized the same way in storage.
  const googleEmail = googleUser.email?.trim().toLowerCase();

  // Resolve by the stable (issuer, sub) pair first — the identity persisted at
  // a prior login. The sub, not the email, is the credential for a returning
  // linked user (mirroring github_id-first above), so the verified-email
  // requirement applies only to the email-match/create paths below. Only
  // NotFound falls through to email matching; a storage failure fails the
  // login closed, because falling through could email-match (or JIT-create) a
  // duplicate account for an already-linked subject.
  const identityLookup = await getIdentityByIssuerSubject(
    c.env.DB,
    logger,
    GOOGLE_ISSUER,
    googleUser.sub,
  );
  if (!identityLookup.success && !(identityLookup.error instanceof NotFoundError)) {
    logger.error("Google identity lookup failed", identityLookup.error);
    return c.json({ error: "Failed to sign in" }, 500);
  }

  let userId: string;
  let identityEmail: string;
  if (identityLookup.success) {
    // An identity row must point at a live user (account deletion cascades
    // through deleteIdentitiesForUser) — treat a dangling row as an error, not
    // as license to fall through and start a duplicate signup.
    const identityUser = await getUser(c.env.DB, identityLookup.data.userId, logger);
    if (!identityUser.success) {
      logger.error("Google identity points at a missing user", identityUser.error, {
        identityId: identityLookup.data.id,
      });
      return c.json({ error: "Failed to sign in" }, 500);
    }
    // A disabled (or deleting) account must not sign in: refuse BEFORE minting
    // a session, so no stratum_session cookie and no session.created audit row
    // exist for it.
    if (identityUser.data.disabledAt || identityUser.data.deletingAt) {
      logger.warn("Blocked Google sign-in — account disabled", { userId: identityUser.data.id });
      return c.redirect("/auth/login?error=account_disabled");
    }
    userId = identityUser.data.id;
    // Refresh the identity email only from a verified claim; otherwise keep
    // the account's stored email.
    identityEmail =
      googleEmail && googleUser.email_verified === true ? googleEmail : identityUser.data.email;
  } else {
    // Email match and account creation trust the Google email only when
    // verified — an unverified address is attacker-claimable.
    if (!googleEmail || googleUser.email_verified !== true) {
      logger.warn("Google account has no verified email");
      return c.json({ error: "No verified email on Google account" }, 422);
    }
    identityEmail = googleEmail;
    // Unlinked Google identity maps onto the email-based account model: an
    // existing account with this (verified) email is reused — the same
    // semantics as magic-link sign-in. A new one is created only once its
    // owner has chosen a username.
    const existing = await getUserByEmail(c.env.DB, googleEmail, logger);
    if (!existing.success) {
      logger.info("New Google identity; asking for a username");
      return beginPendingSignup(c, {
        provider: "google",
        email: googleEmail,
        suggestedUsername: suggestUsername(googleEmail.split("@")[0] ?? ""),
        ...(consumed.next !== undefined ? { next: consumed.next } : {}),
      });
    }
    if (existing.data.disabledAt || existing.data.deletingAt) {
      logger.warn("Blocked Google sign-in — account disabled", { userId: existing.data.id });
      return c.redirect("/auth/login?error=account_disabled");
    }
    userId = existing.data.id;
  }

  await recordOAuthIdentity(c.env.DB, logger.child({ userId }), {
    userId,
    provider: "google",
    issuer: GOOGLE_ISSUER,
    subject: googleUser.sub,
    email: identityEmail,
  });

  const sessionLogger = logger.child({ userId });
  // As for GitHub: a `next` carried on the state wins, and the post-login
  // cookie is consumed regardless so it cannot outlive this sign-in.
  const remembered = consumePostLoginRedirect(c, "/");
  const signedIn = await completeBrowserSignIn(c, sessionLogger, {
    userId,
    method: "google-oauth",
    rememberMe: true,
    redirectTo: consumed.next ?? remembered,
    // Reached only for an email that already has an account; a new Google
    // identity is diverted to the username step and counted there.
    analytics: { kind: "signin", provider: "google" },
  });
  if (!signedIn.success) {
    sessionLogger.error("Failed to create session", signedIn.error);
    return c.json({ error: "Failed to create session" }, 500);
  }
  sessionLogger.info("Google OAuth successful");
  return signedIn.data;
});

// Logout is state-changing, so it happens on POST (the nav renders a form and
// the CSRF middleware's same-origin check applies). A GET — old bookmarks,
// prefetchers, or a cross-site <img> — must not end the session; it just goes home.
app.get("/logout", (c) => c.redirect("/"));

app.post("/logout", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const sessionId = getCookie(c, "stratum_session");

  if (sessionId) {
    logger.debug("Deleting session", { sessionId: `${sessionId.slice(0, 8)}...` });

    // Get session to verify ownership and get userId
    const sessionResult = await getSession(c.env.DB, sessionId, logger);
    if (sessionResult.success) {
      const userId = sessionResult.data.userId;
      await deleteSession(c.env.DB, sessionId, userId, logger);
    }
  }

  deleteCookie(c, "stratum_session", { path: "/" });
  logger.info("User logged out");

  return c.redirect("/");
});

export { app as authRouter };
