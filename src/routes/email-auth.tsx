import type { Context } from "hono";
import { Hono } from "hono";
import type { AuthKind } from "../analytics/events";
import { admitAndDeliverCodes, betaGateEnabled, validateInviteCode } from "../beta/gate";
import { getMagicLinkEmail } from "../email/templates";
import { enforceSameOrigin } from "../middleware/csrf";
import { completeBrowserSignIn } from "../services/second-factor";
import { consumeMagicLink, createMagicLink } from "../storage/magic-links";
import { usernameNamespaceTaken } from "../storage/project-namespace";
import { createUser, getUserByEmail, getUserByUsername } from "../storage/users";
import type { Env } from "../types";
import { SOURCE_FOOTER_HTML_INLINE } from "../ui/components/source-footer";
import { hashToken } from "../utils/crypto";
import { getWaitUntil } from "../utils/execution-ctx";
import { escapeHtml } from "../utils/html";
import { type Logger, createLogger } from "../utils/logger";
import { consumePostLoginRedirect } from "../utils/post-login-redirect";
import { validateUsername } from "../utils/username-validation";
import { validateEmail } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

// Rate limiting constants
export const MAGIC_LINK_RATE_LIMIT = 5; // max 5 requests per hour per email
// Per-IP cap so one client can't mail links to unlimited addresses (the
// per-email limit alone leaves a mail-bombing / send-cost amplification vector).
export const MAGIC_LINK_IP_RATE_LIMIT = 20; // max 20 magic-link sends per hour per IP
const MAGIC_LINK_RATE_WINDOW = 60 * 60; // 1 hour in seconds

// Generate a secure random token (32 bytes = 64 hex chars)
function generateSecureToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Durable Object name for an email address's send counter.
 *
 * SHA-256 rather than hashEmail(): that helper is a 32-bit Java-style string
 * hash, and collisions in it are constructible rather than merely possible —
 * a collider for a chosen address turns up within a few thousand candidates
 * ("cg1@acme.com" collides with "ceo@acme.com"). Sharing a bucket with an
 * address the attacker picks is a targeted lockout: five POSTs to
 * /auth/send-login naming the collider exhaust the victim's five sends for the
 * hour. Those five requests cost nothing and send no mail, because the counter
 * is committed even when no such user exists — deliberately, so the endpoint is
 * not an account-enumeration oracle.
 *
 * The digest is unsalted, which makes it a collision-resistant bucket key and
 * not a secret: anyone holding a candidate address can confirm whether it maps
 * here. Salting would need a key that is always configured, and every secret on
 * Env is optional today. hashEmail() stays for log lines, where a short opaque
 * token is all that is wanted and a collision costs nothing.
 *
 * The hour is no longer part of the name — the window now lives inside the
 * object, which is what lets it erase itself on an alarm. Changing the name
 * shape resets in-flight hourly counters once, on deploy.
 */
async function emailLimiterName(email: string): Promise<string> {
  return `email:${await hashToken(email)}`;
}

/**
 * Distinct prefix from the email buckets, so an IP literal can never be made to
 * name an address's counter (or the reverse).
 */
function ipLimiterName(ip: string): string {
  return `ip:${ip}`;
}

/** `unavailable` is a storage/binding failure, which is treated as an admission. */
type ReserveResult = "admitted" | "blocked" | "unavailable";

/**
 * Takes one reservation from a subject's counter.
 *
 * @param namespace - The MagicLinkRateLimiter binding, absent in a deploy that predates it
 * @param name - Subject name, from emailLimiterName/ipLimiterName
 * @param limit - Cap for this subject, per window
 * @param nowMs - One clock reading per request, so both counters land in the same window
 * @param logger - Request logger
 * @returns Whether the reservation was taken, refused, or could not be attempted
 */
async function reserveSend(
  namespace: Env["MAGIC_LINK_LIMITER"],
  name: string,
  limit: number,
  nowMs: number,
  logger: Logger,
): Promise<ReserveResult> {
  if (!namespace) {
    // Only reachable on a deploy whose wrangler.toml predates the binding. Loud,
    // because it means this endpoint is running with no cap at all.
    logger.error("MAGIC_LINK_LIMITER is not bound; magic-link rate limiting is disabled");
    return "unavailable";
  }
  try {
    const stub = namespace.get(namespace.idFromName(name));
    const outcome = await stub.reserve(limit, MAGIC_LINK_RATE_WINDOW, nowMs);
    return outcome.admitted ? "admitted" : "blocked";
  } catch (err) {
    logger.warn("Magic-link rate limit reservation failed, allowing request", { error: err });
    return "unavailable";
  }
}

/**
 * Gives back a reservation taken from a subject that then failed the other cap.
 *
 * Best-effort: a failure here leaks one count against the window, which
 * over-counts the subject and can only refuse sends, never admit extra ones.
 *
 * @param namespace - The MagicLinkRateLimiter binding
 * @param name - Subject name whose reservation is being returned
 * @param nowMs - The same clock reading the reservation used
 * @param logger - Request logger
 */
async function refundSend(
  namespace: Env["MAGIC_LINK_LIMITER"],
  name: string,
  nowMs: number,
  logger: Logger,
): Promise<void> {
  if (!namespace) return;
  try {
    const stub = namespace.get(namespace.idFromName(name));
    await stub.refund(MAGIC_LINK_RATE_WINDOW, nowMs);
  } catch (err) {
    logger.warn("Magic-link rate limit refund failed", { error: err });
  }
}

/**
 * Enforce both magic-link caps: per-email AND per-IP. The per-email limit alone
 * lets a single client mail links to unlimited addresses (one per email), so we
 * also bound sends per source IP.
 *
 * This both decides *and* commits: a reservation is taken as part of the
 * decision, so there is no window between "am I under the cap" and "count me".
 * That is the whole point of issue #283 — the Workers KV counters this replaces
 * read and wrote from the Worker, so N concurrent sends all read the same value
 * and the cap only ever bound sequential traffic. Every call site already
 * committed as its first statement after an unblocked check, so collapsing the
 * two loses no caller flexibility.
 *
 * The two caps live in separate objects (one per email digest, one per IP),
 * because a shared instance would serialize every magic-link send on the
 * planet behind one thread. They are therefore reserved in sequence, and an
 * email reservation is refunded when the IP cap then refuses. A concurrent
 * request can observe the un-refunded count and be turned away; over-refusing
 * for a few milliseconds is the safe direction, and neither cap is ever
 * exceeded.
 *
 * **Storage-error policy: fail open, deliberately.** A reservation that cannot
 * be attempted — the binding is missing, or the object throws — admits the
 * request and logs. Failing closed would turn a transient storage fault into a
 * total login outage, which is a worse failure than the bounded over-sending a
 * fault-window bypass allows; both caps re-apply on the next request once
 * storage recovers. This is the same policy the KV implementation had, restated
 * here rather than changed silently.
 *
 * @param c - Request context, for the binding and the client IP
 * @param email - The address a link would be sent to
 * @param logger - Request logger
 * @returns Whether the send is refused; when it is not, the send is already counted
 */
async function checkMagicLinkRateLimits(
  c: Context<{ Bindings: Env }>,
  email: string,
  logger: Logger,
): Promise<{ blocked: boolean }> {
  const namespace = c.env.MAGIC_LINK_LIMITER;
  // One reading for both counters, so a request that straddles an hour boundary
  // cannot land its two reservations in different windows.
  const nowMs = Date.now();
  const emailName = await emailLimiterName(email);
  const ipName = ipLimiterName(c.req.header("CF-Connecting-IP") ?? "unknown");

  const emailResult = await reserveSend(namespace, emailName, MAGIC_LINK_RATE_LIMIT, nowMs, logger);
  if (emailResult === "blocked") return { blocked: true };

  const ipResult = await reserveSend(namespace, ipName, MAGIC_LINK_IP_RATE_LIMIT, nowMs, logger);
  if (ipResult === "blocked") {
    if (emailResult === "admitted") await refundSend(namespace, emailName, nowMs, logger);
    return { blocked: true };
  }
  return { blocked: false };
}

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

// GET /auth/email — the old Sign Up / Sign In chooser page is retired: it was
// an extra decision screen in front of two pages that already cross-link.
// Query params (error/success codes from the legacy /send flow) carry over.
app.get("/", (c) => {
  const query = new URL(c.req.url).search;
  return c.redirect(`/auth/login${query}`);
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
  // An org slug or a namespace still holding projects is taken too: `@name`
  // is one namespace space shared by users and orgs.
  const namespaceTaken = await usernameNamespaceTaken(c.env, username, logger);
  if (!namespaceTaken.success) {
    logger.error("Failed to check username namespace", namespaceTaken.error, { username });
    return emailAuthRedirect(c, "error", "signup_failed", "/auth/signup");
  }
  if (namespaceTaken.data) {
    logger.warn("Username namespace unavailable", { username });
    return emailAuthRedirect(c, "error", "username_taken", "/auth/signup");
  }

  const rateLimit = await checkMagicLinkRateLimits(c, email, logger);
  if (rateLimit.blocked) {
    logger.warn("Magic link rate limit exceeded", { emailHash });
    return emailAuthRedirect(c, "error", "rate_limited", "/auth/signup");
  }

  try {
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

  // Do NOT reveal whether the email has an account (enumeration): the endpoint
  // returns the same `login_link_sent` response either way. A magic link is only
  // minted + sent when the account actually exists; a missing account skips the
  // send silently. Rate limiting is applied first, to every request, so the
  // send-only-for-real-accounts branch isn't a cheap oracle.
  const existingUser = await getUserByEmail(c.env.DB, email, logger);

  const rateLimit = await checkMagicLinkRateLimits(c, email, logger);
  if (rateLimit.blocked) {
    logger.warn("Magic link rate limit exceeded", { emailHash });
    return emailAuthRedirect(c, "error", "rate_limited", "/auth/login");
  }

  try {
    // A disabled or deleting account gets the same enumeration-safe
    // `login_link_sent` response as an unknown one, but no mail: a link would
    // only lead to a hard `account_disabled` rejection at verify time, and
    // refusing loudly here would leak which addresses have (disabled or
    // mid-erasure) accounts.
    if (existingUser.success && (existingUser.data.disabledAt || existingUser.data.deletingAt)) {
      logger.info("Login requested for disabled or deleting account; skipping send", {
        emailHash,
      });
      return emailAuthRedirect(c, "success", "login_link_sent", "/auth/login");
    }

    if (existingUser.success) {
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
        // A real send failure for a real account is worth surfacing; it is not a
        // reliable enumeration oracle (it only fires on genuine infra errors).
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
    } else {
      logger.info("Login requested for unknown email; returning uniform response", { emailHash });
    }

    return emailAuthRedirect(c, "success", "login_link_sent", "/auth/login");
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

  const rateLimit = await checkMagicLinkRateLimits(c, email, logger);
  if (rateLimit.blocked) {
    logger.warn("Magic link rate limit exceeded", { emailHash });
    return emailAuthRedirect(c, "error", "rate_limited");
  }

  try {
    // Check if user exists to determine intent
    const existingUser = await getUserByEmail(c.env.DB, email, logger);

    // Same silent refusal as /send-login: a disabled or deleting account gets
    // the uniform success response but no mail (a link could only fail at
    // verify time).
    if (existingUser.success && (existingUser.data.disabledAt || existingUser.data.deletingAt)) {
      logger.info("Legacy magic link requested for disabled or deleting account; skipping send", {
        emailHash,
      });
      return emailAuthRedirect(c, "success", "email_sent");
    }

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
${SOURCE_FOOTER_HTML_INLINE}
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
        // User already exists, treat as login — which a disabled (or deleting)
        // account must not slip through (no session mint, no audit row).
        if (existingUserByEmail.data.disabledAt || existingUserByEmail.data.deletingAt) {
          logger.warn("Rejected signup-as-login for disabled account", { emailHash });
          return emailAuthRedirect(c, "error", "account_disabled", "/auth/login");
        }
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
      const namespaceTaken = await usernameNamespaceTaken(c.env, username, logger);
      if (!namespaceTaken.success) {
        logger.error(
          "Failed to check username namespace at signup verification",
          namespaceTaken.error,
          { username },
        );
        return emailAuthRedirect(c, "error", "signup_failed", "/auth/signup");
      }
      if (namespaceTaken.data) {
        logger.warn("Username namespace unavailable at signup verification", { username });
        return emailAuthRedirect(c, "error", "username_taken", "/auth/signup");
      }

      // Create new user with selected username
      const createResult = await createUser(c.env.DB, email, logger, username);
      if (!createResult.success && createResult.error.statusCode === 409) {
        logger.warn("Username taken at insert during signup verification", { username });
        return emailAuthRedirect(c, "error", "username_taken", "/auth/signup");
      }
      if (!createResult.success) {
        logger.error("Failed to create user", undefined, { emailHash, username });
        return emailAuthRedirect(c, "error", "signup_failed", "/auth/signup");
      }

      const userId = createResult.data.user.id;
      logger.info("New user created via signup", { userId, emailHash, username });

      // Beta program: record the redemption, mint this user's 5 codes, and email
      // them. Best-effort — never blocks the now-created account, and no longer
      // delays its first redirect either: scheduled past the response where an
      // ExecutionContext exists, awaited inline where none does (tests).
      if (betaGateEnabled(c.env)) {
        const delivery = admitAndDeliverCodes(
          c.env,
          { userId, email, inviteCode, source: "magic_link" },
          logger,
        );
        const waitUntil = getWaitUntil(c);
        if (waitUntil) waitUntil(delivery);
        else await delivery;
      }

      // Create session and redirect to welcome/onboarding
      return await createSessionAndRedirect(
        c,
        userId,
        emailHash,
        rememberMe,
        logger,
        "/welcome",
        "signup",
      );
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

      // A disabled (or deleting) account is hard-rejected here, BEFORE any
      // session mint — send-login is enumeration-safe, so this is where the
      // clear refusal lands (e.g. a link minted before the account was
      // disabled).
      if (existingUser.data.disabledAt || existingUser.data.deletingAt) {
        logger.warn("Rejected login for disabled account", {
          emailHash,
          userId: existingUser.data.id,
        });
        return emailAuthRedirect(c, "error", "account_disabled", "/auth/login");
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

// Helper function to create session and redirect
async function createSessionAndRedirect(
  c: Context<{ Bindings: Env }>,
  userId: string,
  _emailHash: string,
  rememberMe: boolean,
  logger: ReturnType<typeof createLogger>,
  defaultRedirect = "/",
  // What this link did to the account, for the acquisition funnel. Not
  // inferable here: the signup branch reaches this function twice, once having
  // created the account and once having found it already present.
  kind: AuthKind = "signin",
): Promise<Response> {
  const sessionLogger = logger.child({ userId });
  // Same-origin validation and the one-shot clear both live in the shared
  // helper, so all three sign-in paths agree on where "back where I was" is.
  const redirectTo = consumePostLoginRedirect(c, defaultRedirect);
  // Mints the session — or, when the account has a passkey, parks the sign-in
  // behind the second factor (#256) and sends the browser to /auth/2fa.
  const signedIn = await completeBrowserSignIn(c, sessionLogger, {
    userId,
    method: "magic-link",
    rememberMe,
    redirectTo,
    analytics: { kind, provider: "email" },
  });
  if (!signedIn.success) {
    sessionLogger.error("Failed to create session", signedIn.error);
    return emailAuthRedirect(c, "error", "verify_failed");
  }
  sessionLogger.info("Primary sign-in complete, redirecting user");
  return signedIn.data;
}

export { app as emailAuthRouter };
