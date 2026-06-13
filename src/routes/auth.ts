import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { betaGateEnabled } from "../beta/gate";
import { recordAudit } from "../storage/audit";
import { createSession, deleteSession, getSession } from "../storage/sessions";
import { createUser, getUserByEmail, getUserByGitHubId, upsertGitHubUser } from "../storage/users";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

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
 */
async function issueOAuthState(
  c: Parameters<typeof setCookie>[0],
  kv: KVNamespace,
): Promise<string> {
  const state = crypto.randomUUID().replace(/-/g, "");
  await kv.put(`oauth_state:${state}`, "1", { expirationTtl: OAUTH_STATE_TTL_SECONDS });
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
 * (constant-time) AND exist in KV. Consumes both on success.
 */
async function consumeOAuthState(
  c: Parameters<typeof getCookie>[0] & Parameters<typeof deleteCookie>[0],
  kv: KVNamespace,
  state: string,
): Promise<boolean> {
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  if (!cookieState || !timingSafeEqual(cookieState, state)) {
    return false;
  }
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/auth" });

  const stateKey = `oauth_state:${state}`;
  const stored = await kv.get(stateKey);
  if (!stored) return false;
  await kv.delete(stateKey);
  return true;
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

  const state = await issueOAuthState(c, c.env.STATE);

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

  if (!(await consumeOAuthState(c, c.env.STATE, state))) {
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

  const primaryEmail =
    emails.find((e) => e.primary && e.verified)?.email ??
    emails.find((e) => e.verified)?.email ??
    emails[0]?.email;

  if (!primaryEmail) {
    logger.warn("No verified email found on GitHub account", { githubId: githubUser.id });
    return c.json({ error: "No verified email found on GitHub account" }, 422);
  }

  const emailPrefix = primaryEmail.split("@")[0];
  logger.info("Upserting GitHub user", { githubId: githubUser.id, emailPrefix });

  // Closed beta: OAuth is login-only. A brand-new account (no match by GitHub id
  // or email) must be created through the invite-gated magic-link flow first.
  if (betaGateEnabled(c.env)) {
    const byGithub = await getUserByGitHubId(c.env.DB, String(githubUser.id), logger);
    const byEmail = await getUserByEmail(c.env.DB, primaryEmail, logger);
    if (!byGithub.success && !byEmail.success) {
      logger.warn("Blocked GitHub signup — closed beta", { githubId: githubUser.id });
      return c.redirect("/auth/signup?error=invite_required");
    }
  }

  const userResult = await upsertGitHubUser(
    c.env.DB,
    {
      githubId: String(githubUser.id),
      email: primaryEmail,
      username: githubUser.login,
    },
    logger,
  );

  if (!userResult.success) {
    logger.error("Failed to upsert GitHub user", undefined, { githubId: githubUser.id });
    return c.json({ error: "Failed to create user" }, 500);
  }

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

  let redirectTo = "/";
  if (next && typeof next === "string") {
    try {
      const url = new URL(next, "http://localhost");
      if (url.hostname === "localhost" || url.hostname === "") {
        redirectTo = url.pathname + url.search;
      }
    } catch {
      // invalid next param — fall back to /
    }
  }

  return c.redirect(redirectTo);
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

  const state = await issueOAuthState(c, c.env.STATE);

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
  if (!(await consumeOAuthState(c, c.env.STATE, state))) {
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
  // account with this email is reused, otherwise one is created — the same
  // semantics as magic-link sign-in.
  const existing = await getUserByEmail(c.env.DB, googleUser.email, logger);
  let userId: string;
  if (existing.success) {
    userId = existing.data.id;
  } else {
    // Closed beta: OAuth is login-only — new accounts require an invite code.
    if (betaGateEnabled(c.env)) {
      logger.warn("Blocked Google signup — closed beta");
      return c.redirect("/auth/signup?error=invite_required");
    }
    const createdResult = await createUser(c.env.DB, googleUser.email, logger);
    if (!createdResult.success) {
      logger.error("Failed to create user from Google sign-in", createdResult.error);
      return c.json({ error: "Failed to create user" }, 500);
    }
    userId = createdResult.data.user.id;
  }

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

  setCookie(c, "stratum_session", sessionResult.data.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 2592000,
    path: "/",
  });

  sessionLogger.info("Google OAuth successful, session created");
  return c.redirect("/");
});

app.get("/logout", async (c) => {
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
