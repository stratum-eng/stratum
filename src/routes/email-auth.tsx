import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createSession } from "../storage/sessions";
import { createUser, getUserByEmail } from "../storage/users";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const app = new Hono<{ Bindings: Env }>();

// Rate limiting constants
const MAGIC_LINK_RATE_LIMIT = 5; // max 5 requests per hour per email
const MAGIC_LINK_RATE_WINDOW = 60 * 60; // 1 hour in seconds

// Generate a secure random token (32 bytes = 64 hex chars)
function generateSecureToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Get rate limit key for an email (uses hashed email for privacy)
function getRateLimitKey(email: string): string {
  const hour = Math.floor(Date.now() / 1000 / MAGIC_LINK_RATE_WINDOW);
  const emailHash = hashEmail(email);
  return `magic_link_rate:${emailHash}:${hour}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  auth_config_missing: "Email authentication is not configured. Please contact the administrator.",
  auth_config_incomplete:
    "Email authentication is not fully configured. Please contact the administrator.",
  send_failed: "Failed to send email. Please try again later.",
  invalid_link: "Invalid or expired link.",
  link_expired: "This link has expired or already been used.",
  verify_failed: "Failed to sign in. Please try again.",
  rate_limited: "Too many requests. Please try again in an hour.",
};

const SUCCESS_MESSAGES: Record<string, string> = {
  email_sent: "Check your email. We sent a magic link that expires in 15 minutes.",
};

function emailAuthRedirect(
  c: { redirect(path: string): Response },
  kind: "error" | "success",
  code: string,
): Response {
  const params = new URLSearchParams({ [kind]: code });
  return c.redirect(`/auth/email?${params.toString()}`);
}

// Helper function to hash email for logging (privacy)
function hashEmail(email: string): string {
  // Simple hash - take first 8 chars of a basic hash
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    const char = email.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

// GET /auth/email - Show login form
app.get("/", (c) => {
  const errorCode = c.req.query("error");
  const successCode = c.req.query("success");
  const error =
    errorCode !== undefined
      ? (ERROR_MESSAGES[errorCode] ?? "Email authentication failed.")
      : undefined;
  const success = successCode !== undefined ? SUCCESS_MESSAGES[successCode] : undefined;

  return c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Sign In — Stratum</title>
        <link rel="stylesheet" href="/ui.css" />
        <style>{`
          .auth-container {
            max-width: 400px;
            margin: 4rem auto;
            padding: 2rem;
            background: var(--bg-secondary);
            border-radius: 8px;
            border: 1px solid var(--border);
          }
          .auth-title {
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
            color: var(--text-primary);
          }
          .auth-subtitle {
            color: var(--text-secondary);
            margin-bottom: 2rem;
            font-size: 0.9rem;
          }
          .form-group {
            margin-bottom: 1.5rem;
          }
          .form-label {
            display: block;
            margin-bottom: 0.5rem;
            color: var(--text-secondary);
            font-size: 0.9rem;
          }
          .form-input {
            width: 100%;
            padding: 0.75rem;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--text-primary);
            font-size: 1rem;
            box-sizing: border-box;
          }
          .form-input:focus {
            outline: none;
            border-color: var(--accent);
          }
          .btn {
            width: 100%;
            padding: 0.75rem;
            background: var(--accent);
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 1rem;
            cursor: pointer;
            font-weight: 500;
          }
          .btn:hover {
            opacity: 0.9;
          }
          .alert {
            padding: 1rem;
            border-radius: 4px;
            margin-bottom: 1rem;
            font-size: 0.9rem;
          }
          .alert-error {
            background: rgba(248, 113, 113, 0.1);
            border: 1px solid rgba(248, 113, 113, 0.3);
            color: #f87171;
          }
          .alert-success {
            background: rgba(74, 222, 128, 0.1);
            border: 1px solid rgba(74, 222, 128, 0.3);
            color: #4ade80;
          }
          .auth-divider {
            text-align: center;
            margin: 1.5rem 0;
            color: var(--text-secondary);
            font-size: 0.85rem;
            position: relative;
          }
          .auth-divider::before,
          .auth-divider::after {
            content: "";
            position: absolute;
            top: 50%;
            width: 40%;
            height: 1px;
            background: var(--border);
          }
          .auth-divider::before { left: 0; }
          .auth-divider::after { right: 0; }
          .auth-link {
            color: var(--accent);
            text-decoration: none;
          }
          .auth-link:hover {
            text-decoration: underline;
          }
          .auth-note {
            margin-top: 1.5rem;
            padding-top: 1.5rem;
            border-top: 1px solid var(--border);
            font-size: 0.85rem;
            color: var(--text-secondary);
            line-height: 1.5;
          }
        `}</style>
      </head>
      <body>
        <nav class="nav">
          <a class="nav-brand" href="/">
            stratum
          </a>
        </nav>
        <main class="main">
          <div class="auth-container">
            <h1 class="auth-title">Sign in to Stratum</h1>
            <p class="auth-subtitle">Enter your email to receive a magic link</p>

            {error && <div class="alert alert-error">{error}</div>}

            {success && <div class="alert alert-success">{success}</div>}

            <form method="post" action="/auth/email/send">
              <div class="form-group">
                <label class="form-label" for="email">
                  Email address
                </label>
                <input
                  class="form-input"
                  type="email"
                  id="email"
                  name="email"
                  placeholder="you@example.com"
                  required
                />
              </div>
              <div class="form-group" style={{ marginTop: "1rem" }}>
                <label
                  class="form-label"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    fontWeight: "normal",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    name="rememberMe"
                    value="true"
                    checked
                    style={{ width: "auto", cursor: "pointer" }}
                  />
                  Keep me signed in for 30 days
                </label>
              </div>
              <button type="submit" class="btn" style={{ marginTop: "1rem" }}>
                Send Magic Link
              </button>
            </form>

            <div class="auth-divider">or</div>

            <a
              href="/auth/github"
              class="btn"
              style={{
                background: "#333",
                display: "block",
                textAlign: "center",
                textDecoration: "none",
              }}
            >
              Continue with GitHub
            </a>

            <div class="auth-note">
              <strong>No password required.</strong> We'll send you a secure link to sign in
              instantly. The link expires in 15 minutes.
            </div>
          </div>
        </main>
      </body>
    </html>,
  );
});

// POST /auth/email/send - Send magic link
app.post("/send", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const rememberMe = body.rememberMe === "true";

  // Validate email format with regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    logger.warn("Invalid email provided", { emailPrefix: email.slice(0, 5) });
    return emailAuthRedirect(c, "error", "invalid_email");
  }

  const emailHash = hashEmail(email);
  logger.info("Processing magic link request", { emailHash });

  // Check if email sending is configured
  if (!c.env.EMAIL) {
    logger.error("Email sending not configured");
    return emailAuthRedirect(c, "error", "auth_config_missing");
  }

  const fromAddress = c.env.EMAIL_FROM_ADDRESS;
  if (!fromAddress) {
    logger.error("EMAIL_FROM_ADDRESS secret not set");
    return emailAuthRedirect(c, "error", "auth_config_incomplete");
  }

  // Check rate limit (fail open if KV fails)
  const rateLimitKey = getRateLimitKey(email);
  let currentCount = 0;
  try {
    currentCount = Number.parseInt((await c.env.STATE.get(rateLimitKey)) ?? "0");
  } catch (err) {
    logger.warn("Failed to check rate limit, allowing request", { emailHash, error: err });
  }

  if (currentCount >= MAGIC_LINK_RATE_LIMIT) {
    logger.warn("Magic link rate limit exceeded", { emailHash });
    return emailAuthRedirect(c, "error", "rate_limited");
  }

  try {
    // Increment rate limit counter
    await c.env.STATE.put(rateLimitKey, String(currentCount + 1), {
      expirationTtl: MAGIC_LINK_RATE_WINDOW,
    });

    // Generate secure magic link token (32 bytes = 64 hex chars)
    const token = generateSecureToken();
    // Store token in KV with remember me preference
    await c.env.STATE.put(
      `magic_link:${token}`,
      JSON.stringify({ email, createdAt: Date.now(), rememberMe }),
      { expirationTtl: 15 * 60 }, // 15 minutes TTL
    );

    // Build magic link URL
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const magicLink = `${baseUrl}/auth/email/verify?token=${token}`;

    // Send email
    await c.env.EMAIL.send({
      to: email,
      from: { email: fromAddress, name: "Stratum" },
      subject: "Sign in to Stratum",
      text: `Click this link to sign in to Stratum:\n\n${magicLink}\n\nThis link expires in 15 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
      html: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to Stratum</title>
</head>
<body style="margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f0f0f; color: #e5e5e5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: #0f0f0f;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table width="100%" max-width="400" cellpadding="0" cellspacing="0" style="max-width: 400px; background: #1a1a1a; border-radius: 8px; border: 1px solid #333;">
          <tr>
            <td style="padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0 0 10px; font-size: 24px; color: #e5e5e5;">Sign in to Stratum</h1>
              <p style="margin: 0 0 30px; color: #888; font-size: 14px;">Click the button below to sign in instantly.</p>
              
              <a href="${magicLink}" style="display: inline-block; padding: 14px 28px; background: #3b82f6; color: white; text-decoration: none; border-radius: 4px; font-weight: 500; font-size: 16px;">Sign In to Stratum</a>
              
              <p style="margin: 30px 0 0; color: #666; font-size: 12px; line-height: 1.5;">
                This link expires in 15 minutes.<br>
                If you didn't request this, you can safely ignore this email.
              </p>
              
              <p style="margin: 20px 0 0; color: #444; font-size: 11px;">
                Or copy and paste this URL:<br>
                <code style="color: #666; word-break: break-all;">${magicLink}</code>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    });

    logger.info("Magic link sent", { emailHash });

    return emailAuthRedirect(c, "success", "email_sent");
  } catch (err) {
    logger.error("Failed to send magic link", err instanceof Error ? err : undefined, {
      emailHash,
    });
    return emailAuthRedirect(c, "error", "send_failed");
  }
});

// GET /auth/email/verify - Verify magic link and create session
app.get("/verify", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const token = c.req.query("token");

  if (!token) {
    logger.warn("Missing token in verify request");
    return emailAuthRedirect(c, "error", "invalid_link");
  }

  try {
    // Retrieve token data from KV
    const tokenData = await c.env.STATE.get(`magic_link:${token}`);

    if (!tokenData) {
      logger.warn("Token not found or expired", { tokenPrefix: token.slice(0, 8) });
      return emailAuthRedirect(c, "error", "link_expired");
    }

    const { email, rememberMe = true } = JSON.parse(tokenData);
    const emailHash = hashEmail(email);

    // Delete the token so it can't be reused
    await c.env.STATE.delete(`magic_link:${token}`);

    // Get or create user
    const userResult = await getUserByEmail(c.env.DB, email, logger);

    let userId: string;
    if (!userResult.success) {
      // Create new user
      const createResult = await createUser(c.env.DB, email, logger);
      if (!createResult.success) {
        logger.error("Failed to create user", undefined, { emailHash });
        return emailAuthRedirect(c, "error", "verify_failed");
      }
      userId = createResult.data.user.id;
      logger.info("Created new user", { userId, emailHash });
    } else {
      userId = userResult.data.id;
      logger.info("Existing user signed in", { userId, emailHash });
    }

    // Create session with remember me preference
    const sessionLogger = logger.child({ userId });
    const sessionResult = await createSession(c.env.DB, userId, sessionLogger, rememberMe);

    if (!sessionResult.success) {
      sessionLogger.error("Failed to create session");
      return emailAuthRedirect(c, "error", "verify_failed");
    }

    const session = sessionResult.data;

    // Set session cookie with appropriate expiration
    const cookieMaxAge = rememberMe ? 2592000 : 86400; // 30 days or 1 day
    setCookie(c, "stratum_session", session.id, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: cookieMaxAge,
      path: "/",
    });

    sessionLogger.info("User signed in via magic link");

    // Redirect to home or the page they were trying to access
    // Validate redirect to prevent open redirects - only allow same-origin relative paths
    const rawRedirect = getCookie(c, "redirect_after_login") ?? "";
    const redirectTo =
      rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/";
    deleteCookie(c, "redirect_after_login", { path: "/" });

    return c.redirect(redirectTo);
  } catch (err) {
    logger.error("Failed to verify magic link", err instanceof Error ? err : undefined);
    return emailAuthRedirect(c, "error", "verify_failed");
  }
});

export { app as emailAuthRouter };
