import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { admitUser, betaGateEnabled, validateInviteCode } from "../beta/gate";
import { getInviteCodesEmail, getMagicLinkEmail } from "../email/templates";
import { enforceSameOrigin } from "../middleware/csrf";
import { recordAudit } from "../storage/audit";
import { consumeMagicLink, createMagicLink } from "../storage/magic-links";
import { createSession } from "../storage/sessions";
import { createUser, getUserByEmail, getUserByUsername } from "../storage/users";
import type { Env } from "../types";
import { escapeHtml } from "../utils/html";
import { type Logger, createLogger } from "../utils/logger";
import { validateUsername } from "../utils/username-validation";
import { validateEmail } from "../utils/validation";

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
  invalid_username:
    "Please enter a valid username (2-39 characters, lowercase alphanumeric with hyphens).",
  username_taken: "This username is already taken. Please choose another.",
  email_exists: "An account with this email already exists. Please sign in instead.",
  email_not_found: "No account found with this email. Please sign up first.",
  auth_config_missing: "Email authentication is not configured. Please contact the administrator.",
  auth_config_incomplete:
    "Email authentication is not fully configured. Please contact the administrator.",
  send_failed: "Failed to send email. Please try again later.",
  invalid_link: "Invalid or expired link.",
  link_expired: "This link has expired or already been used.",
  verify_failed: "Failed to sign in. Please try again.",
  signup_failed: "Failed to create account. Please try again.",
  rate_limited: "Too many requests. Please try again in an hour.",
};

const SUCCESS_MESSAGES: Record<string, string> = {
  email_sent: "Check your email. We sent a magic link that expires in 15 minutes.",
};

function emailAuthRedirect(
  c: { redirect(path: string): Response },
  kind: "error" | "success",
  code: string,
  redirectPath = "/auth/email",
): Response {
  const params = new URLSearchParams({ [kind]: code });
  return c.redirect(`${redirectPath}?${params.toString()}`);
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

// GET /auth/email - Show auth choice page (Sign Up or Sign In)
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
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='6'%20fill='%230d0d0d'/%3E%3Ctext%20x='16'%20y='23'%20font-family='monospace'%20font-size='20'%20font-weight='700'%20fill='%237ca9f7'%20text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E"
        />
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
          .auth-sections {
            display: grid;
            gap: 1.5rem;
          }
          .auth-section {
            padding: 1.5rem;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 6px;
            text-align: center;
          }
          .auth-section-title {
            font-size: 1.1rem;
            margin-bottom: 0.5rem;
            color: var(--text-primary);
          }
          .auth-section-desc {
            font-size: 0.85rem;
            color: var(--text-secondary);
            margin-bottom: 1rem;
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
            text-decoration: none;
            display: inline-block;
            box-sizing: border-box;
          }
          .btn:hover {
            opacity: 0.9;
          }
          .btn-secondary {
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-primary);
          }
          .btn-secondary:hover {
            background: var(--bg-secondary);
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
            <h1 class="auth-title">Welcome to Stratum</h1>
            <p class="auth-subtitle">Choose an option to continue</p>

            {error && <div class="alert alert-error">{error}</div>}
            {success && <div class="alert alert-success">{success}</div>}

            <div class="auth-sections">
              <div class="auth-section">
                <h2 class="auth-section-title">Create Account</h2>
                <p class="auth-section-desc">New here? Sign up to get started with Stratum.</p>
                <a href="/auth/signup" class="btn">
                  Sign Up
                </a>
              </div>

              <div class="auth-section">
                <h2 class="auth-section-title">Sign In</h2>
                <p class="auth-section-desc">Already have an account? Sign in to continue.</p>
                <a href="/auth/login" class="btn btn-secondary">
                  Sign In
                </a>
              </div>
            </div>

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
              <strong>No password required.</strong> We'll send you a secure magic link to sign in
              instantly. The link expires in 15 minutes.
            </div>
          </div>
        </main>
      </body>
    </html>,
  );
});

// POST /auth/email/send-signup - Send magic link for signup
app.post("/send-signup", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const rememberMe = body.rememberMe === "true";
  const inviteCode =
    typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";

  // Validate email format
  const emailValidation = validateEmail(email, logger);
  if (!emailValidation.success) {
    logger.warn("Invalid email provided", { emailPrefix: email.slice(0, 5) });
    return emailAuthRedirect(c, "error", "invalid_email", "/auth/signup");
  }

  // Validate username format
  const usernameValidation = validateUsername(username, logger);
  if (!usernameValidation.success) {
    logger.warn("Invalid username provided", { username });
    return emailAuthRedirect(c, "error", "invalid_username", "/auth/signup");
  }

  const emailHash = hashEmail(email);
  logger.info("Processing signup request", { emailHash, username });

  // Closed-beta gate: require a valid invite code before sending the magic link
  // (fast feedback). The code is re-checked and consumed at verify time.
  if (betaGateEnabled(c.env)) {
    if (!inviteCode) {
      return emailAuthRedirect(c, "error", "invite_required", "/auth/signup");
    }
    const inviteCheck = await validateInviteCode(c.env, inviteCode, logger);
    if (!inviteCheck.valid) {
      logger.warn("Invalid invite code at signup", { emailHash });
      return emailAuthRedirect(c, "error", "invalid_invite", "/auth/signup");
    }
  }

  // Check if email sending is configured
  if (!c.env.EMAIL) {
    logger.error("Email sending not configured");
    return emailAuthRedirect(c, "error", "auth_config_missing", "/auth/signup");
  }

  const fromAddress = c.env.EMAIL_FROM_ADDRESS;
  if (!fromAddress) {
    logger.error("EMAIL_FROM_ADDRESS secret not set");
    return emailAuthRedirect(c, "error", "auth_config_incomplete", "/auth/signup");
  }

  // Check if email already exists
  const existingUserByEmail = await getUserByEmail(c.env.DB, email, logger);
  if (existingUserByEmail.success) {
    logger.warn("Email already exists", { emailHash });
    return emailAuthRedirect(c, "error", "email_exists", "/auth/signup");
  }

  // Check if username is available
  const existingUserByUsername = await getUserByUsername(c.env.DB, username, logger);
  if (existingUserByUsername.success) {
    logger.warn("Username already taken", { username });
    return emailAuthRedirect(c, "error", "username_taken", "/auth/signup");
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
    return emailAuthRedirect(c, "error", "rate_limited", "/auth/signup");
  }

  try {
    // Increment rate limit counter
    await c.env.STATE.put(rateLimitKey, String(currentCount + 1), {
      expirationTtl: MAGIC_LINK_RATE_WINDOW,
    });

    // Generate secure magic link token
    const token = generateSecureToken();
    // Store token in D1 (atomic single-use at verify time) with signup intent.
    const stored = await createMagicLink(
      c.env.DB,
      token,
      { email, username, intent: "signup", createdAt: Date.now(), rememberMe, inviteCode },
      15 * 60,
      logger,
    );
    if (!stored.success) {
      return emailAuthRedirect(c, "error", "send_failed", "/auth/signup");
    }

    // Build magic link URL
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const magicLink = `${baseUrl}/auth/email/verify?token=${token}`;

    // Send email using template
    const emailContent = getMagicLinkEmail({ magicLink, email });
    await c.env.EMAIL.send({
      to: email,
      from: { email: fromAddress, name: "Stratum" },
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });

    logger.info("Signup magic link sent", { emailHash, username });

    return emailAuthRedirect(c, "success", "email_sent", "/auth/signup");
  } catch (err) {
    logger.error("Failed to send signup magic link", err instanceof Error ? err : undefined, {
      emailHash,
      username,
    });
    return emailAuthRedirect(c, "error", "send_failed", "/auth/signup");
  }
});

// POST /auth/email/send-login - Send magic link for login
app.post("/send-login", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const rememberMe = body.rememberMe === "true";

  // Validate email format
  const emailValidation = validateEmail(email, logger);
  if (!emailValidation.success) {
    logger.warn("Invalid email provided", { emailPrefix: email.slice(0, 5) });
    return emailAuthRedirect(c, "error", "invalid_email", "/auth/login");
  }

  const emailHash = hashEmail(email);
  logger.info("Processing login request", { emailHash });

  // Check if email sending is configured
  if (!c.env.EMAIL) {
    logger.error("Email sending not configured");
    return emailAuthRedirect(c, "error", "auth_config_missing", "/auth/login");
  }

  const fromAddress = c.env.EMAIL_FROM_ADDRESS;
  if (!fromAddress) {
    logger.error("EMAIL_FROM_ADDRESS secret not set");
    return emailAuthRedirect(c, "error", "auth_config_incomplete", "/auth/login");
  }

  // Check if email exists in database
  const existingUser = await getUserByEmail(c.env.DB, email, logger);
  if (!existingUser.success) {
    logger.warn("Email not found for login", { emailHash });
    return emailAuthRedirect(c, "error", "email_not_found", "/auth/login");
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
    return emailAuthRedirect(c, "error", "rate_limited", "/auth/login");
  }

  try {
    // Increment rate limit counter
    await c.env.STATE.put(rateLimitKey, String(currentCount + 1), {
      expirationTtl: MAGIC_LINK_RATE_WINDOW,
    });

    // Generate secure magic link token
    const token = generateSecureToken();
    // Store token in D1 (atomic single-use at verify time) with login intent.
    const stored = await createMagicLink(
      c.env.DB,
      token,
      { email, intent: "login", createdAt: Date.now(), rememberMe },
      15 * 60,
      logger,
    );
    if (!stored.success) {
      return emailAuthRedirect(c, "error", "send_failed", "/auth/login");
    }

    // Build magic link URL
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const magicLink = `${baseUrl}/auth/email/verify?token=${token}`;

    // Send email using template
    const emailContent = getMagicLinkEmail({ magicLink, email });
    await c.env.EMAIL.send({
      to: email,
      from: { email: fromAddress, name: "Stratum" },
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });

    logger.info("Login magic link sent", { emailHash });

    return emailAuthRedirect(c, "success", "email_sent", "/auth/login");
  } catch (err) {
    logger.error("Failed to send login magic link", err instanceof Error ? err : undefined, {
      emailHash,
    });
    return emailAuthRedirect(c, "error", "send_failed", "/auth/login");
  }
});

// Legacy POST /auth/email/send - Redirect to login flow for backward compatibility
app.post("/send", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  const body = await c.req.parseBody();
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const rememberMe = body.rememberMe === "true";

  // Validate email format
  const emailValidation = validateEmail(email, logger);
  if (!emailValidation.success) {
    logger.warn("Invalid email provided", { emailPrefix: email.slice(0, 5) });
    return emailAuthRedirect(c, "error", "invalid_email");
  }

  const emailHash = hashEmail(email);
  logger.info("Processing legacy magic link request", { emailHash });

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

    // Check if user exists to determine intent
    const existingUser = await getUserByEmail(c.env.DB, email, logger);
    const intent = existingUser.success ? "login" : "signup";
    let username: string | undefined;
    if (!existingUser.success) {
      // Generate and validate username from email
      const candidate = (email.split("@")[0] ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^[-0-9]+/, "")
        .replace(/-+$/, "");
      const validation = validateUsername(candidate, logger);
      if (!validation.success) {
        // Fall through to explicit signup so the user can choose a valid name
        return emailAuthRedirect(c, "error", "invalid_username", "/auth/signup");
      }
      username = validation.data;
    }

    // Generate secure magic link token
    const token = generateSecureToken();
    // Store token in D1 (atomic single-use at verify time).
    const stored = await createMagicLink(
      c.env.DB,
      token,
      {
        email,
        intent: intent === "signup" ? "signup" : "login",
        createdAt: Date.now(),
        rememberMe,
        ...(username ? { username } : {}),
      },
      15 * 60,
      logger,
    );
    if (!stored.success) {
      return emailAuthRedirect(c, "error", "send_failed");
    }

    // Build magic link URL
    const url = new URL(c.req.url);
    const baseUrl = `${url.protocol}//${url.host}`;
    const magicLink = `${baseUrl}/auth/email/verify?token=${token}`;

    // Send email using template
    const emailContent = getMagicLinkEmail({ magicLink, email });
    await c.env.EMAIL.send({
      to: email,
      from: { email: fromAddress, name: "Stratum" },
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });

    logger.info("Legacy magic link sent", { emailHash, intent });

    return emailAuthRedirect(c, "success", "email_sent");
  } catch (err) {
    logger.error("Failed to send legacy magic link", err instanceof Error ? err : undefined, {
      emailHash,
    });
    return emailAuthRedirect(c, "error", "send_failed");
  }
});

// GET /auth/email/verify — render a same-origin confirm page rather than logging
// in on the GET itself. A raw GET verify is login-CSRF: an attacker embeds their
// own magic link in an <img>/<a> and the victim's browser silently gets a session
// for the ATTACKER's account. Requiring an explicit same-origin POST (below) means
// the sign-in is a deliberate action, not a drive-by, and cross-site auto-submits
// are blocked by the CSRF middleware's Origin check.
app.get("/verify", (c) => {
  const token = c.req.query("token");
  if (!token) {
    return emailAuthRedirect(c, "error", "invalid_link");
  }
  const safeToken = escapeHtml(token);
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Complete sign-in</title></head>
<body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center">
<h1 style="font-size:1.25rem">Complete your sign-in</h1>
<p style="color:#555">Click below to finish signing in to Stratum.</p>
<form method="POST" action="/auth/email/verify">
<input type="hidden" name="token" value="${safeToken}">
<button type="submit" style="padding:0.6rem 1.4rem;font-size:1rem;border:0;border-radius:0.5rem;background:#111;color:#fff;cursor:pointer">Continue</button>
</form>
</body></html>`,
  );
});

// POST /auth/email/verify - consume the magic link and handle signup/login
app.post("/verify", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  // This endpoint is unauthenticated (it MINTS the session), so csrfMiddleware —
  // which only guards session-cookie auth — skips it. Enforce same-origin here,
  // BEFORE consuming the token, so a cross-site auto-submitting form can't POST an
  // attacker's magic-link token and log a victim into the attacker's account
  // (login CSRF). Rejecting before consume leaves the token usable for the real
  // same-origin flow.
  const csrf = enforceSameOrigin(c, logger);
  if (csrf) return csrf;

  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : undefined;

  if (!token) {
    logger.warn("Missing token in verify request");
    return emailAuthRedirect(c, "error", "invalid_link");
  }

  try {
    // Atomically consume the token: single-use is enforced by a conditional D1
    // UPDATE, so two concurrent verifies can't both succeed.
    const consumed = await consumeMagicLink(c.env.DB, token, logger);
    if (!consumed.success) {
      return emailAuthRedirect(c, "error", "link_expired");
    }
    const tokenData = consumed.data;
    if (!tokenData) {
      logger.warn("Token not found, expired, or already used", { tokenPrefix: token.slice(0, 8) });
      return emailAuthRedirect(c, "error", "link_expired");
    }

    const { email, intent, rememberMe = true } = tokenData;
    const emailHash = hashEmail(email);

    if (intent === "signup") {
      // Signup flow
      const { inviteCode = "" } = tokenData;
      const { username } = tokenData;
      if (!username) {
        logger.warn("Signup magic link missing username", { emailHash });
        return emailAuthRedirect(c, "error", "invalid_link", "/auth/signup");
      }
      logger.info("Processing signup verification", { emailHash, username });

      // Double-check email doesn't already exist (race condition protection)
      const existingUserByEmail = await getUserByEmail(c.env.DB, email, logger);
      if (existingUserByEmail.success) {
        logger.warn("Email already exists during signup verification", { emailHash });
        // User already exists, treat as login
        const userId = existingUserByEmail.data.id;
        return await createSessionAndRedirect(c, userId, emailHash, rememberMe, logger);
      }

      // Closed-beta gate: re-validate the invite code before creating the account.
      if (betaGateEnabled(c.env)) {
        const inviteCheck = await validateInviteCode(c.env, inviteCode, logger);
        if (!inviteCheck.valid) {
          logger.warn("Invite code no longer valid at verification", { emailHash });
          return emailAuthRedirect(c, "error", "invalid_invite", "/auth/signup");
        }
      }

      // Double-check username is still available (race condition protection)
      const existingUserByUsername = await getUserByUsername(c.env.DB, username, logger);
      if (existingUserByUsername.success) {
        logger.error("Username taken during signup verification", undefined, { username });
        return emailAuthRedirect(c, "error", "username_taken", "/auth/signup");
      }

      // Create new user with selected username
      const createResult = await createUser(c.env.DB, email, logger, username);
      if (!createResult.success) {
        logger.error("Failed to create user", undefined, { emailHash, username });
        return emailAuthRedirect(c, "error", "signup_failed", "/auth/signup");
      }

      const userId = createResult.data.user.id;
      logger.info("New user created via signup", { userId, emailHash, username });

      // Beta program: record the redemption, mint this user's 5 codes, and email
      // them. Best-effort — never blocks the now-created account.
      if (betaGateEnabled(c.env)) {
        await admitAndDeliverCodes(c, { userId, email, inviteCode, source: "magic_link" }, logger);
      }

      // Create session and redirect to welcome/onboarding
      return await createSessionAndRedirect(c, userId, emailHash, rememberMe, logger, "/welcome");
    }

    if (intent === "login") {
      // Login flow
      logger.info("Processing login verification", { emailHash });

      // Verify email exists
      const existingUser = await getUserByEmail(c.env.DB, email, logger);
      if (!existingUser.success) {
        logger.warn("Email not found during login verification", { emailHash });
        return emailAuthRedirect(c, "error", "email_not_found", "/auth/login");
      }

      const userId = existingUser.data.id;
      logger.info("User signed in via login", { userId, emailHash });

      // Create session and redirect to dashboard
      return await createSessionAndRedirect(c, userId, emailHash, rememberMe, logger, "/");
    }

    // Unknown intent
    logger.error("Unknown intent in token", undefined, { intent });
    return emailAuthRedirect(c, "error", "invalid_link");
  } catch (err) {
    logger.error("Failed to verify magic link", err instanceof Error ? err : undefined);
    return emailAuthRedirect(c, "error", "verify_failed");
  }
});

// Beta program: redeem the invite code, mint the user's 5 shareable codes, and
// email them. Best-effort — failures are logged and swallowed so a created
// account is never left in a broken state by a referral-service hiccup.
async function admitAndDeliverCodes(
  c: Context<{ Bindings: Env }>,
  params: { userId: string; email: string; inviteCode: string; source: string },
  logger: Logger,
): Promise<void> {
  try {
    const result = await admitUser(
      c.env,
      {
        userId: params.userId,
        email: params.email,
        code: params.inviteCode,
        source: params.source,
      },
      logger,
    );
    if (result.codes.length === 0) {
      logger.warn("No invite codes minted for new user", { userId: params.userId });
      return;
    }
    const fromAddress = c.env.EMAIL_FROM_ADDRESS;
    if (!c.env.EMAIL || !fromAddress) return;
    const emailContent = getInviteCodesEmail({
      email: params.email,
      codes: result.codes,
      shareBaseUrl: c.env.REFERRAL_SERVICE_URL,
    });
    await c.env.EMAIL.send({
      to: params.email,
      from: { email: fromAddress, name: "Stratum" },
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html,
    });
  } catch (err) {
    logger.error("Failed to deliver invite codes", err instanceof Error ? err : undefined, {
      userId: params.userId,
    });
  }
}

// Helper function to create session and redirect
async function createSessionAndRedirect(
  c: Context<{ Bindings: Env }>,
  userId: string,
  _emailHash: string,
  rememberMe: boolean,
  logger: ReturnType<typeof createLogger>,
  defaultRedirect = "/",
): Promise<Response> {
  const sessionLogger = logger.child({ userId });
  const sessionResult = await createSession(c.env.DB, userId, sessionLogger, rememberMe);
  if (sessionResult.success) {
    await recordAudit(c.env.DB, sessionLogger, {
      action: "session.created",
      actorType: "user",
      actorId: userId,
      detail: { method: "magic-link" },
    });
  }

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

  sessionLogger.info("Session created, redirecting user");

  // Validate redirect to prevent open redirects - only allow same-origin relative paths
  const rawRedirect = getCookie(c, "redirect_after_login") ?? "";
  let redirectTo = defaultRedirect;
  try {
    const candidate = new URL(rawRedirect, new URL(c.req.url).origin);
    if (
      candidate.origin === new URL(c.req.url).origin &&
      /^\/[^/\\]/.test(rawRedirect) // disallow //, /\, etc.
    ) {
      redirectTo = candidate.pathname + candidate.search + candidate.hash;
    }
  } catch {
    // ignore, use defaultRedirect
  }
  deleteCookie(c, "redirect_after_login", { path: "/" });

  return c.redirect(redirectTo);
}

export { app as emailAuthRouter };
