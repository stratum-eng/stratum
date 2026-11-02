/**
 * The "choose your username" step of a GitHub or Google signup.
 *
 * A username is the account's namespace: it is in every project URL, every
 * clone URL, and the name of every backing repository, and it cannot be changed
 * afterwards. Magic-link signup has always asked for one; the OAuth callbacks
 * used to invent one from the GitHub handle or the email's local part, so an
 * account created with a single click was stuck with a name nobody chose.
 *
 * The callbacks now stop short of creating an account they have never seen
 * before. The verified identity is parked in KV under a random token, the token
 * is handed to the browser as a short-lived cookie, and the user lands here to
 * pick a name (and, under the closed beta, to present an invite code — which is
 * also why OAuth signup no longer has to be refused outright while the gate is
 * on). Nothing is written to D1 until the form comes back. Sign-in for an
 * existing account is untouched: the callbacks still finish those themselves.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { captureAuthCompleted } from "../analytics/auth";
import type { AuthKind } from "../analytics/events";
import { admitAndDeliverCodes, betaGateEnabled, validateInviteCode } from "../beta/gate";
import { enforceSameOrigin } from "../middleware/csrf";
import { recordAudit } from "../storage/audit";
import { usernameNamespaceTaken } from "../storage/project-namespace";
import { createSession, getSession } from "../storage/sessions";
import { createUser, getUserByEmail, getUserByUsername, linkGitHub } from "../storage/users";
import type { Env } from "../types";
import { SourceFooter } from "../ui/components/source-footer";
import { getWaitUntil } from "../utils/execution-ctx";
import { type Logger, createLogger } from "../utils/logger";
import { consumePostLoginRedirect } from "../utils/post-login-redirect";
import { sanitizeUsername, validateUsername } from "../utils/username-validation";
import { SIGNUP_PAGE_CSS } from "./signup";

export type OAuthProvider = "github" | "google";

/** What the callback learned about a first-time visitor, parked until they pick a name. */
export interface PendingSignup {
  provider: OAuthProvider;
  /** Verified by the provider — an unverified address must never reach here. */
  email: string;
  /** Prefilled into the form; null when nothing usable could be derived. */
  suggestedUsername: string | null;
  /** Present for GitHub, so the account is linked as it is created. */
  github?: { id: string; login: string };
  /** Same-origin path to land on afterwards (the OAuth start URL's `next`), already validated. */
  next?: string;
  createdAt: number;
}

export const COMPLETE_SIGNUP_PATH = "/auth/signup/complete";
const PENDING_SIGNUP_COOKIE = "stratum_pending_signup";
// Long enough to read the page and type a name, short enough that a parked
// identity on a shared machine does not outlive the person who parked it.
const PENDING_SIGNUP_TTL_SECONDS = 15 * 60;

const ERROR_MESSAGES: Record<string, string> = {
  invalid_username:
    "Username must be 3-39 characters, lowercase letters, numbers, and hyphens only.",
  username_taken: "This username is already taken. Please choose another.",
  invite_required: "Stratum is in closed beta — an invite code is required to sign up.",
  invalid_invite: "That invite code isn't valid or has already been used.",
  signup_failed: "Failed to create account. Please try again.",
};

const PROVIDER_LABEL: Record<OAuthProvider, string> = { github: "GitHub", google: "Google" };

function pendingKey(token: string): string {
  return `pending_signup:${token}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A username to prefill from a provider handle or an email's local part. The
 * same coercion the GitHub callback applied when it still invented names; here
 * it is only a suggestion, so an unusable result is simply no suggestion.
 */
export function suggestUsername(candidate: string): string | null {
  const sanitized = sanitizeUsername(candidate).replace(/^[0-9]+/, "");
  return validateUsername(sanitized).success ? sanitized : null;
}

/**
 * Park a verified identity and send the browser to the username form. The
 * token lives only in KV and in an httpOnly cookie scoped to `/auth`, so the
 * form itself carries no secret and a cross-site POST cannot name a record.
 */
export async function beginPendingSignup(
  c: Context<{ Bindings: Env }>,
  record: Omit<PendingSignup, "createdAt">,
): Promise<Response> {
  const token = randomToken();
  const stored: PendingSignup = { ...record, createdAt: Date.now() };
  await c.env.STATE.put(pendingKey(token), JSON.stringify(stored), {
    expirationTtl: PENDING_SIGNUP_TTL_SECONDS,
  });
  setCookie(c, PENDING_SIGNUP_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: PENDING_SIGNUP_TTL_SECONDS,
    path: "/auth",
  });
  return c.redirect(COMPLETE_SIGNUP_PATH);
}

function isProvider(value: unknown): value is OAuthProvider {
  return value === "github" || value === "google";
}

/** The parked record named by the browser's cookie, or null when there is none. */
async function loadPendingSignup(
  c: Context<{ Bindings: Env }>,
): Promise<{ token: string; record: PendingSignup } | null> {
  const token = getCookie(c, PENDING_SIGNUP_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const raw = await c.env.STATE.get(pendingKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSignup>;
    if (!isProvider(parsed.provider) || typeof parsed.email !== "string") return null;
    return { token, record: parsed as PendingSignup };
  } catch {
    return null;
  }
}

async function clearPendingSignup(c: Context<{ Bindings: Env }>, token: string): Promise<void> {
  await c.env.STATE.delete(pendingKey(token));
  deleteCookie(c, PENDING_SIGNUP_COOKIE, { path: "/auth" });
}

/** Back to the form with a message, keeping what the user typed. */
function formError(c: Context<{ Bindings: Env }>, code: string, username: string): Response {
  const params = new URLSearchParams({ error: code });
  if (username) params.set("username", username);
  return c.redirect(`${COMPLETE_SIGNUP_PATH}?${params.toString()}`);
}

/**
 * Nothing to complete: the cookie or the record is gone. A browser that is
 * already signed in most likely just finished this form (a double-click with
 * JavaScript off, or a back-button re-POST spent the record moments ago), so
 * it goes home rather than being told its signup expired.
 */
async function nothingPending(c: Context<{ Bindings: Env }>, logger: Logger): Promise<Response> {
  deleteCookie(c, PENDING_SIGNUP_COOKIE, { path: "/auth" });
  if (await hasLiveSession(c, logger)) return c.redirect("/");
  return c.redirect("/auth/signup?error=signup_expired");
}

/** Whether the request carries a session cookie that still resolves and has not expired. */
async function hasLiveSession(c: Context<{ Bindings: Env }>, logger: Logger): Promise<boolean> {
  const sessionId = getCookie(c, "stratum_session");
  if (!sessionId) return false;
  const session = await getSession(c.env.DB, sessionId, logger);
  return session.success && new Date(session.data.expiresAt) > new Date();
}

/**
 * Mint the session and send the user on. Mirrors the cookie the magic-link
 * flow sets, including the shorter lifetime when "keep me signed in" is off.
 */
async function issueSessionAndRedirect(
  c: Context<{ Bindings: Env }>,
  userId: string,
  record: PendingSignup,
  rememberMe: boolean,
  logger: Logger,
  // Both callers land here, but they mean different things to the funnel: one
  // arrives with an account that already existed, the other just created one.
  // Inferring it from the record is not possible — by this point they look
  // identical — so the caller states it.
  kind: AuthKind,
): Promise<Response> {
  const sessionLogger = logger.child({ userId });
  const sessionResult = await createSession(c.env.DB, userId, sessionLogger, rememberMe);
  if (!sessionResult.success) {
    sessionLogger.error("Failed to create session after OAuth signup");
    return c.json({ error: "Failed to create session" }, 500);
  }
  await recordAudit(c.env.DB, sessionLogger, {
    action: "session.created",
    actorType: "user",
    actorId: userId,
    detail: { method: `${record.provider}-oauth` },
  });
  await captureAuthCompleted(c, sessionLogger, { kind, provider: record.provider, userId });
  setCookie(c, "stratum_session", sessionResult.data.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: rememberMe ? 2592000 : 86400,
    path: "/",
  });
  sessionLogger.info("OAuth signup complete, session created", { provider: record.provider });
  // Consumed unconditionally so a stale destination never survives into the
  // next sign-in; a `next` from the OAuth start URL still wins when given.
  const remembered = consumePostLoginRedirect(c, "/");
  return c.redirect(record.next ?? remembered);
}

const app = new Hono<{ Bindings: Env }>();

// GET /auth/signup/complete — the username form for a parked OAuth identity
app.get("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });
  const pending = await loadPendingSignup(c);
  if (!pending) return nothingPending(c, logger);
  const { record } = pending;

  const errorCode = c.req.query("error");
  const error =
    errorCode !== undefined
      ? (ERROR_MESSAGES[errorCode] ?? "Signup failed. Please try again.")
      : undefined;
  // What they typed last time beats the suggestion, so a rejected name is not
  // silently replaced by one they already decided against.
  const typed = c.req.query("username");
  const username = typed !== undefined ? typed : (record.suggestedUsername ?? "");
  const betaGate = betaGateEnabled(c.env);
  const providerLabel = PROVIDER_LABEL[record.provider];

  return c.html(
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Choose your username — Stratum</title>
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='6'%20fill='%230d0d0d'/%3E%3Ctext%20x='16'%20y='23'%20font-family='monospace'%20font-size='20'%20font-weight='700'%20fill='%237ca9f7'%20text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E"
        />
        <link rel="stylesheet" href="/ui.css" />
        <style>{SIGNUP_PAGE_CSS}</style>
      </head>
      <body>
        <main class="signup-container">
          <div class="signup-header">
            <h1 class="signup-title">Choose your username</h1>
            <p class="signup-subtitle">
              Signing up with {providerLabel}
              {record.github ? ` as @${record.github.login}` : ""} using{" "}
              <strong>{record.email}</strong>. One more thing: pick the name your projects will live
              under.
            </p>
          </div>

          {error && <div class="alert alert-error">{error}</div>}

          <form class="signup-form" action={COMPLETE_SIGNUP_PATH} method="post" id="signupForm">
            <div class="form-group">
              <label class="form-label" for="username">
                Username <span>(your namespace — fixed while you own projects)</span>
              </label>
              <input
                type="text"
                id="username"
                name="username"
                class="form-input"
                placeholder="johndoe"
                value={username}
                required
                autocomplete="username"
                autofocus
                minLength={3}
                maxLength={39}
                pattern="^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,38}$"
                title="3-39 characters, lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen."
              />
              <div class="input-hint" id="usernameHint">
                Your projects will be at @{username || "username"}/… — 3-39 characters, lowercase
                letters, numbers, and hyphens
              </div>
              <div class="username-status" id="usernameStatus" />
            </div>

            {betaGate ? (
              <div class="form-group">
                <label class="form-label" for="inviteCode">
                  Invite code <span>(required during beta)</span>
                </label>
                <input
                  type="text"
                  id="inviteCode"
                  name="inviteCode"
                  class="form-input"
                  placeholder="ABCDE12345"
                  required
                  autocomplete="off"
                  spellcheck={false}
                />
              </div>
            ) : null}

            <div class="checkbox-group">
              <input
                type="checkbox"
                id="rememberMe"
                name="rememberMe"
                value="true"
                class="checkbox-input"
                checked
              />
              <label class="checkbox-label" for="rememberMe">
                Keep me signed in for 30 days
              </label>
            </div>

            <div class="submit-status" id="submitStatus" />
            <button type="submit" class="submit-btn" id="submitBtn">
              Create account
            </button>
          </form>

          <div class="auth-footer">
            Not you? <a href="/auth/login">Sign in with a different account</a>
          </div>
        </main>

        <SourceFooter />
        <script
          nonce={c.get("cspNonce") ?? ""}
          dangerouslySetInnerHTML={{ __html: COMPLETE_SIGNUP_SCRIPT }}
        />
      </body>
    </html>,
  );
});

// POST /auth/signup/complete — create the account under the chosen username
app.post("/", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
  });

  // No session exists yet, so csrfMiddleware (session-cookie auth only) does
  // not cover this POST. The pending cookie is the credential being spent, and
  // a cross-site form must not be able to spend it.
  const csrf = enforceSameOrigin(c, logger);
  if (csrf) return csrf;

  const pending = await loadPendingSignup(c);
  if (!pending) return nothingPending(c, logger);
  const { token, record } = pending;

  const body = await c.req.parseBody();
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const rememberMe = body.rememberMe === "true";
  const inviteCode =
    typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : "";

  const validation = validateUsername(username, logger);
  if (!validation.success) {
    logger.warn("Invalid username at OAuth signup", { provider: record.provider });
    return formError(c, "invalid_username", username);
  }

  // The account may have come into being while the form was open — a magic
  // link finished in another tab, say. The identity is verified either way, so
  // this is a sign-in, not a second account; the parked record is spent.
  const existing = await getUserByEmail(c.env.DB, record.email, logger);
  if (existing.success) {
    // That account may be frozen — SCIM can provision a user already
    // deactivated (#253). Refuse before linking GitHub or minting a session,
    // exactly as the OAuth callbacks do for an account they find directly.
    if (existing.data.disabledAt || existing.data.deletingAt) {
      logger.warn("Blocked OAuth signup completion — account disabled", {
        userId: existing.data.id,
        provider: record.provider,
      });
      await clearPendingSignup(c, token);
      return c.redirect("/auth/login?error=account_disabled");
    }
    logger.info("Email registered while username was being chosen; signing in", {
      userId: existing.data.id,
      provider: record.provider,
    });
    if (record.github) {
      const linked = await linkGitHub(
        c.env.DB,
        existing.data.id,
        record.github.id,
        record.github.login,
        logger,
      );
      if (!linked.success) logger.error("Failed to link GitHub account", linked.error);
    }
    await clearPendingSignup(c, token);
    return issueSessionAndRedirect(c, existing.data.id, record, rememberMe, logger, "signin");
  }

  // Closed beta: the gate is enforced here rather than in the callback, which is
  // what lets an OAuth signup present a code at all.
  if (betaGateEnabled(c.env)) {
    if (!inviteCode) return formError(c, "invite_required", username);
    const inviteCheck = await validateInviteCode(c.env, inviteCode, logger);
    if (!inviteCheck.valid) {
      logger.warn("Invalid invite code at OAuth signup", { provider: record.provider });
      return formError(c, "invalid_invite", username);
    }
  }

  const taken = await getUserByUsername(c.env.DB, username, logger);
  if (taken.success) return formError(c, "username_taken", username);
  // Shared `@name` space: an org slug or a namespace with projects is taken too.
  const namespaceTaken = await usernameNamespaceTaken(c.env, username, logger);
  if (!namespaceTaken.success || namespaceTaken.data) {
    return formError(c, "username_taken", username);
  }

  const created = await createUser(c.env.DB, record.email, logger, username);
  if (!created.success && created.error.statusCode === 409) {
    return formError(c, "username_taken", username);
  }
  if (!created.success) {
    logger.error("Failed to create user from OAuth signup", created.error, {
      provider: record.provider,
    });
    return formError(c, "signup_failed", username);
  }
  const userId = created.data.user.id;
  logger.info("New user created via OAuth signup", {
    userId,
    username,
    provider: record.provider,
  });

  if (record.github) {
    // The account exists now, so a link failure is logged rather than fatal:
    // `signInGitHubUser` will link by verified email on the next sign-in.
    const linked = await linkGitHub(
      c.env.DB,
      userId,
      record.github.id,
      record.github.login,
      logger,
    );
    if (!linked.success) logger.error("Failed to link GitHub account", linked.error, { userId });
  }

  if (betaGateEnabled(c.env)) {
    // Best-effort and already error-swallowing, so the redirect need not wait
    // on the referral service and the mail provider; inline only where there
    // is no ExecutionContext to hand it to (tests, non-Workers runtimes).
    const delivery = admitAndDeliverCodes(
      c.env,
      { userId, email: record.email, inviteCode, source: `${record.provider}_oauth` },
      logger,
    );
    const waitUntil = getWaitUntil(c);
    if (waitUntil) waitUntil(delivery);
    else await delivery;
  }

  await clearPendingSignup(c, token);
  return issueSessionAndRedirect(c, userId, record, rememberMe, logger, "signup");
});

/**
 * Progressive enhancement only: live format and availability feedback against
 * `/api/users/check-username`, the same endpoint the signup page uses. The
 * server re-validates everything, so the form submits fine with this disabled.
 */
const COMPLETE_SIGNUP_SCRIPT = `
(function() {
	var form = document.getElementById('signupForm');
	var input = document.getElementById('username');
	var hint = document.getElementById('usernameHint');
	var status = document.getElementById('usernameStatus');
	var submitBtn = document.getElementById('submitBtn');
	var USERNAME_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
	var debounceTimer = null;
	var activeRequestId = 0;
	var taken = false;

	function formatError(username) {
		if (!username || username.length < 3) return 'At least 3 characters required';
		if (username.length > 39) return 'Maximum 39 characters allowed';
		if (username.charAt(0) === '-') return 'Cannot start with a hyphen';
		if (username.charAt(username.length - 1) === '-') return 'Cannot end with a hyphen';
		if (username.indexOf('--') !== -1) return 'No consecutive hyphens allowed';
		if (!USERNAME_REGEX.test(username)) return 'Only lowercase letters, numbers, and hyphens allowed';
		return '';
	}

	function setStatus(kind, message) {
		status.className = 'username-status ' + kind;
		status.textContent = '';
		if (kind === 'checking') {
			var spinner = document.createElement('span');
			spinner.className = 'spinner';
			status.appendChild(spinner);
			status.appendChild(document.createTextNode(' Checking availability...'));
		} else if (kind) {
			var icon = document.createElement('span');
			icon.className = 'status-icon';
			icon.textContent = kind === 'available' ? '\\u2713' : '\\u2717';
			status.appendChild(icon);
			status.appendChild(document.createTextNode(' ' + message));
		}
		input.className = 'form-input ' + (kind === 'available' ? 'success' : kind === 'checking' || !kind ? '' : 'error');
	}

	function updateHint(username) {
		hint.textContent = 'Your projects will be at @' + (username || 'username') + '/\\u2026 \\u2014 3-39 characters, lowercase letters, numbers, and hyphens';
	}

	function check(username) {
		taken = false;
		setStatus('checking', '');
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(function () {
			var requestId = ++activeRequestId;
			fetch('/api/users/check-username?username=' + encodeURIComponent(username))
				.then(function (r) { return r.json(); })
				.then(function (data) {
					if (requestId !== activeRequestId || input.value.trim().toLowerCase() !== username) return;
					if (data.available) {
						setStatus('available', 'Username is available!');
					} else {
						taken = true;
						setStatus('taken', data.message || 'Username is already taken');
					}
				})
				.catch(function () {
					// The server validates on submit, so a failed lookup is not a block.
					if (requestId !== activeRequestId) return;
					setStatus('', '');
				});
		}, 300);
	}

	function onInput() {
		var username = input.value.trim().toLowerCase();
		updateHint(username);
		if (!username) { setStatus('', ''); return; }
		var error = formatError(username);
		if (error) { setStatus('error', error); return; }
		check(username);
	}

	input.addEventListener('input', onInput);
	// A prefilled suggestion may already be taken: say so before they submit.
	if (input.value) onInput();

	form.addEventListener('submit', function (e) {
		var username = input.value.trim().toLowerCase();
		var error = formatError(username);
		if (error) {
			e.preventDefault();
			setStatus('error', error);
			input.focus();
			return;
		}
		if (taken) {
			e.preventDefault();
			setStatus('taken', 'Username is already taken');
			input.focus();
			return;
		}
		input.value = username;
		submitBtn.disabled = true;
		submitBtn.textContent = 'Creating account...';
	});
})();
`;

export { app as oauthSignupRouter };
