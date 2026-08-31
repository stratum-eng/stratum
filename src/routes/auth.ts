import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { captureAuthCompleted } from "../analytics/auth";
import { recordAudit } from "../storage/audit";
import { createSession, deleteSession, getSession } from "../storage/sessions";
import { getUserByEmail, signInGitHubUser } from "../storage/users";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { consumePostLoginRedirect, isSafeRedirectTarget } from "../utils/post-login-redirect";
import { beginPendingSignup, suggestUsername } from "./oauth-signup";

const app = new Hono<{ Bindings: Env }>();

const OAUTH_STATE_COOKIE = "stratum_oauth_state";
const OAUTH_STATE_TTL_SECONDS = 600;

/** Constant-time string equality — OAuth state values are attacker-influenced. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
  if (!cookieState || !timingSafeEqual(cookieState, state)) {
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
  const emails = await emailsRes.json<{ email: string; primary: boolean; verified: boolean }[]>();

  // Only an address the provider has verified may identify an account. GitHub
  // lets a user list any address unverified, so matching on one would let
  // anyone reach an existing account by adding its owner's email to their own
  // profile — and would create new accounts under emails nobody has proven.
  const verifiedEmail =
    emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email;

  if (!verifiedEmail) {
    logger.warn("No verified email found on GitHub account", { githubId: githubUser.id });
    return c.json({ error: "No verified email found on GitHub account" }, 422);
  }

  // A `next` given to /auth/github rides in the state record, since GitHub
  // returns only `code` and `state`; one on the callback URL itself is still
  // honoured so existing links keep behaving as they did. Either wins over the
  // post-login cookie, which is the fallback a flow that started somewhere
  // else — the MCP consent screen, say — uses to get back to its request.
  const nextPath = consumed.next ?? safeNextPath(next, c.req.url);

  const githubId = String(githubUser.id);
  // Finds by GitHub id or links by verified email, and creates nothing: an
  // identity with no account comes back as `null`. That decision is made once,
  // inside `signInGitHubUser`, rather than duplicated here — a second copy of
  // the lookup is how a signup slips past the closed-beta gate the moment the
  // two disagree.
  const userResult = await signInGitHubUser(
    c.env.DB,
    { githubId, email: verifiedEmail, username: githubUser.login },
    logger,
  );

  if (!userResult.success) {
    logger.error("Failed to resolve GitHub user", userResult.error, { githubId });
    return c.json({ error: "Failed to sign in" }, 500);
  }

  if (userResult.data === null) {
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

  logger.info("Signing in GitHub user", { githubId });
  const user = userResult.data;
  const sessionLogger = logger.child({ userId: user.id });

  const sessionResult = await createSession(c.env.DB, user.id, sessionLogger);
  if (sessionResult.success) {
    await recordAudit(c.env.DB, sessionLogger, {
      action: "session.created",
      actorType: "user",
      actorId: user.id,
      detail: { method: "github-oauth" },
    });
    // `signin`, never `signup`: a first-time GitHub identity was diverted to
    // the username step above and is counted there, once the account exists.
    await captureAuthCompleted(c, sessionLogger, {
      kind: "signin",
      provider: "github",
      userId: user.id,
    });
  }
  if (!sessionResult.success) {
    sessionLogger.error("Failed to create session");
    return c.json({ error: "Failed to create session" }, 500);
  }

  const session = sessionResult.data;
  setCookie(c, "stratum_session", session.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 2592000,
    path: "/",
  });

  sessionLogger.info("GitHub OAuth successful, session created");

  // Consumed unconditionally, even when `next` won, so a stale destination is
  // never left in the jar for the next sign-in to pick up.
  const remembered = consumePostLoginRedirect(c, "/");
  return c.redirect(nextPath ?? remembered);
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
    sub: string;
    email?: string;
    email_verified?: boolean;
  }>();

  if (!googleUser.email || googleUser.email_verified !== true) {
    logger.warn("Google account has no verified email");
    return c.json({ error: "No verified email on Google account" }, 422);
  }

  // Google identity maps onto the email-based account model: an existing
  // account with this email is reused — the same semantics as magic-link
  // sign-in. A new one is created only once its owner has chosen a username.
  const existing = await getUserByEmail(c.env.DB, googleUser.email, logger);
  if (!existing.success) {
    logger.info("New Google identity; asking for a username");
    return beginPendingSignup(c, {
      provider: "google",
      email: googleUser.email,
      suggestedUsername: suggestUsername(googleUser.email.split("@")[0] ?? ""),
      ...(consumed.next !== undefined ? { next: consumed.next } : {}),
    });
  }
  const userId = existing.data.id;

  const sessionLogger = logger.child({ userId });
  const sessionResult = await createSession(c.env.DB, userId, sessionLogger);
  if (!sessionResult.success) {
    sessionLogger.error("Failed to create session");
    return c.json({ error: "Failed to create session" }, 500);
  }
  await recordAudit(c.env.DB, sessionLogger, {
    action: "session.created",
    actorType: "user",
    actorId: userId,
    detail: { method: "google-oauth" },
  });
  // Reached only for an email that already has an account; a new Google
  // identity is diverted to the username step and counted there.
  await captureAuthCompleted(c, sessionLogger, {
    kind: "signin",
    provider: "google",
    userId,
  });

  setCookie(c, "stratum_session", sessionResult.data.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 2592000,
    path: "/",
  });

  sessionLogger.info("Google OAuth successful, session created");
  // As for GitHub: a `next` carried on the state wins, and the post-login
  // cookie is consumed regardless so it cannot outlive this sign-in.
  const remembered = consumePostLoginRedirect(c, "/");
  return c.redirect(consumed.next ?? remembered);
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
