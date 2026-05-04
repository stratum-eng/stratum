import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createSession, deleteSession, getSession } from "../storage/sessions";
import { upsertGitHubUser } from "../storage/users";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const app = new Hono<{ Bindings: Env }>();

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

  const state = crypto.randomUUID().replace(/-/g, "");
  await c.env.STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

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

  const stateKey = `oauth_state:${state}`;
  const storedState = await c.env.STATE.get(stateKey);
  if (!storedState) {
    logger.warn("Invalid or expired state", { statePrefix: state.slice(0, 8) });
    return c.json({ error: "Invalid or expired state" }, 400);
  }
  await c.env.STATE.delete(stateKey);

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
