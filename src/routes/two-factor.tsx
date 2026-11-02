import { type Context, Hono } from "hono";
import { enforceSameOrigin } from "../middleware/csrf";
import {
  type PendingSignIn,
  clearPendingSignIn,
  hashRecoveryCode,
  mintBrowserSession,
  readPendingSignIn,
  recordPendingFailure,
} from "../services/second-factor";
import {
  type CeremonyFailure,
  finishAuthentication,
  isAuthenticationResponse,
  relyingParty,
  startAuthentication,
} from "../services/webauthn";
import { recordAudit } from "../storage/audit";
import { getUser } from "../storage/users";
import {
  advancePasskeyCounter,
  consumeRecoveryCode,
  getPasskeyByCredentialId,
  listPasskeys,
} from "../storage/webauthn";
import type { Env } from "../types";
import { SourceFooter } from "../ui/components/source-footer";
import { WEBAUTHN_CLIENT_SCRIPT } from "../ui/webauthn-client";
import { type Logger, createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";

/**
 * The second step of browser sign-in (#256), mounted at `/auth/2fa`.
 *
 * Reachable only while a parked sign-in exists (the `stratum_2fa` cookie set
 * by `completeBrowserSignIn`). The user proves possession of a registered
 * passkey — or spends a one-time recovery code — and only then is a session
 * minted. Every POST is same-origin-checked here: there is no session yet, so
 * the CSRF middleware (which guards session-cookie callers) does not apply.
 */
const app = new Hono<{ Bindings: Env }>();

const MAX_ASSERTION_BODY_BYTES = 64 * 1024;

type AppContext = Context<{ Bindings: Env }>;

function requestLogger(c: AppContext): Logger {
  return createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: c.req.method });
}

const PAGE_ERRORS: Record<string, string> = {
  invalid_code: "That recovery code is not valid, or has already been used.",
};

const PAGE_SCRIPT = `(function () {
  var btn = document.getElementById("passkey-btn");
  var status = document.getElementById("passkey-status");
  if (!btn || !status) return;
  function say(msg) { status.textContent = msg; }
  if (!window.StratumPasskey || !window.StratumPasskey.supported) {
    btn.disabled = true;
    say("This browser does not support passkeys. Use a recovery code below.");
    return;
  }
  btn.addEventListener("click", async function () {
    btn.disabled = true;
    say("Waiting for your passkey…");
    try {
      var optRes = await fetch("/auth/2fa/options", { method: "POST", credentials: "same-origin" });
      var opts = await optRes.json();
      if (!optRes.ok) throw opts;
      var response = await window.StratumPasskey.get(opts);
      var verRes = await fetch("/auth/2fa/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: response }),
      });
      var result = await verRes.json();
      if (verRes.ok && result.redirectTo) { window.location.assign(result.redirectTo); return; }
      throw result;
    } catch (e) {
      if (e && e.restart) { window.location.assign("/auth/login?error=second_factor_expired"); return; }
      say((e && e.error) || "The passkey check did not complete. Try again, or use a recovery code.");
      btn.disabled = false;
    }
  });
})();`;

function TwoFactorPage(props: { nonce: string; error?: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Verify it's you — Stratum</title>
        <link rel="stylesheet" href="/ui.css" />
        <style>{`
          .tf-page { min-height: 100vh; display: flex; flex-direction: column; background: var(--bg-primary); }
          .tf-main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem 1rem; }
          .tf-card { width: 100%; max-width: 420px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 2rem; }
          .tf-card h1 { font-size: 1.4rem; margin: 0 0 0.5rem; color: var(--text-primary); }
          .tf-card p { color: var(--text-secondary); line-height: 1.5; font-size: 0.9rem; }
          .tf-btn { width: 100%; padding: 0.75rem 1rem; background: var(--accent); border: 1px solid var(--accent); border-radius: 6px; color: white; font: inherit; font-weight: 500; cursor: pointer; }
          .tf-btn:disabled { opacity: 0.6; cursor: not-allowed; }
          .tf-btn-secondary { background: transparent; border-color: var(--border-hover); color: var(--text-primary); }
          .tf-status { min-height: 1.4em; margin: 0.75rem 0 0; font-size: 0.85rem; color: var(--text-secondary); }
          .tf-divider { margin: 1.5rem 0 1rem; border-top: 1px solid var(--border); }
          .tf-input { width: 100%; padding: 0.65rem 0.9rem; margin: 0.5rem 0 0.75rem; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); font-family: monospace; font-size: 1rem; box-sizing: border-box; }
          .tf-error { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; background: var(--error-bg); border: 1px solid var(--error-border); color: var(--error-text); font-size: 0.9rem; }
          .tf-foot { margin-top: 1.25rem; font-size: 0.85rem; text-align: center; }
        `}</style>
      </head>
      <body>
        <div class="tf-page">
          <main class="tf-main">
            <div class="tf-card">
              <h1>Verify it's you</h1>
              <p>Your account is protected by a passkey. Use it to finish signing in.</p>
              {props.error !== undefined && (
                <div class="tf-error" role="alert">
                  {props.error}
                </div>
              )}
              <button type="button" id="passkey-btn" class="tf-btn">
                Use passkey
              </button>
              <p id="passkey-status" class="tf-status" aria-live="polite">
                <noscript>Passkeys need JavaScript. Use a recovery code below instead.</noscript>
              </p>
              <div class="tf-divider" />
              <form method="post" action="/auth/2fa/recovery">
                <label for="recovery-code">Lost your passkey? Use a recovery code:</label>
                <input
                  id="recovery-code"
                  name="code"
                  class="tf-input"
                  autocomplete="one-time-code"
                  placeholder="xxxxx-xxxxx"
                  required
                />
                <button type="submit" class="tf-btn tf-btn-secondary">
                  Use recovery code
                </button>
              </form>
              <p class="tf-foot">
                <a href="/auth/login">Cancel and start over</a>
              </p>
            </div>
          </main>
          <SourceFooter />
        </div>
        <script
          nonce={props.nonce}
          dangerouslySetInnerHTML={{ __html: WEBAUTHN_CLIENT_SCRIPT + PAGE_SCRIPT }}
        />
      </body>
    </html>
  );
}

const EXPIRED_REDIRECT = "/auth/login?error=second_factor_expired";

// GET /auth/2fa — the assertion page.
app.get("/", async (c) => {
  const logger = requestLogger(c);
  const pending = await readPendingSignIn(c, logger);
  if (!pending) return c.redirect(EXPIRED_REDIRECT);
  const code = c.req.query("error") ?? "";
  const error = Object.hasOwn(PAGE_ERRORS, code) ? PAGE_ERRORS[code] : undefined;
  c.header("Cache-Control", "no-store");
  return c.html(
    <TwoFactorPage nonce={c.get("cspNonce") ?? ""} {...(error !== undefined ? { error } : {})} />,
  );
});

// POST /auth/2fa/options — issue an assertion challenge for the parked sign-in.
app.post("/options", async (c) => {
  const logger = requestLogger(c);
  const forged = enforceSameOrigin(c, logger);
  if (forged) return forged;
  const pending = await readPendingSignIn(c, logger);
  if (!pending) return c.json({ error: "Sign-in expired", restart: true }, 401);
  const passkeys = await listPasskeys(c.env.DB, logger, pending.signIn.userId);
  if (!passkeys.success) return c.json({ error: "Could not load passkeys" }, 500);
  if (passkeys.data.length === 0) {
    // The passkeys were removed after the primary factor passed. Start over
    // rather than let a stale pending record decide anything.
    await clearPendingSignIn(c, pending);
    return c.json({ error: "Sign-in expired", restart: true }, 409);
  }
  const options = await startAuthentication(
    c.env.STATE,
    relyingParty(c.env, c.req.url),
    pending.tokenHash,
    passkeys.data,
  );
  return c.json(options, 200, { "Cache-Control": "no-store" });
});

/**
 * Last gate before a session: the account may have been disabled or put into
 * deletion while the sign-in was parked.
 */
async function accountStillActive(c: AppContext, logger: Logger, userId: string): Promise<boolean> {
  const user = await getUser(c.env.DB, userId, logger);
  return user.success && !user.data.disabledAt && !user.data.deletingAt;
}

async function recordFailure(
  c: AppContext,
  logger: Logger,
  pending: PendingSignIn,
  detail: { method: "passkey" | "recovery_code"; reason: CeremonyFailure | "invalid_code" },
): Promise<boolean> {
  await recordAudit(c.env.DB, logger, {
    action: "second_factor.failed",
    actorType: "user",
    actorId: pending.signIn.userId,
    detail,
  });
  return recordPendingFailure(c, pending);
}

const FAILURE_MESSAGES: Record<CeremonyFailure, string> = {
  challenge_invalid: "The passkey request expired. Try again.",
  verification_failed: "That passkey could not be verified.",
  unknown_credential: "That passkey is not registered to this account.",
  counter_regression:
    "That passkey reported an out-of-date signature counter and was refused. If this keeps happening, the authenticator may have been cloned.",
};

// POST /auth/2fa/verify — check the assertion and, on success, mint the session.
app.post("/verify", async (c) => {
  const logger = requestLogger(c);
  const forged = enforceSameOrigin(c, logger);
  if (forged) return forged;
  const pending = await readPendingSignIn(c, logger);
  if (!pending) return c.json({ error: "Sign-in expired", restart: true }, 401);
  const userId = pending.signIn.userId;

  const body = await readJsonWithLimit<{ response?: unknown }>(c, MAX_ASSERTION_BODY_BYTES, logger);
  if (body instanceof Response) return body;
  const response = body && typeof body === "object" ? body.response : undefined;
  if (!isAuthenticationResponse(response)) {
    return c.json({ error: "response must be a WebAuthn authentication response" }, 400);
  }

  const fail = async (reason: CeremonyFailure): Promise<Response> => {
    const voided = await recordFailure(c, logger, pending, { method: "passkey", reason });
    return c.json({ error: FAILURE_MESSAGES[reason], restart: voided }, 400);
  };

  const passkey = await getPasskeyByCredentialId(c.env.DB, logger, userId, response.id);
  if (!passkey.success) {
    if (passkey.error.statusCode === 404) return fail("unknown_credential");
    return c.json({ error: "Could not verify passkey" }, 500);
  }

  const verified = await finishAuthentication(
    c.env.STATE,
    relyingParty(c.env, c.req.url),
    pending.tokenHash,
    passkey.data,
    response,
    logger,
  );
  if (!verified.ok) return fail(verified.reason);

  // Compare-and-swap: a replay racing this request against the same stored
  // counter loses here even though both passed the library's check.
  const advanced = await advancePasskeyCounter(c.env.DB, logger, passkey.data, verified.newCounter);
  if (!advanced.success) return c.json({ error: "Could not verify passkey" }, 500);
  if (!advanced.data) return fail("counter_regression");

  await clearPendingSignIn(c, pending);
  if (!(await accountStillActive(c, logger, userId))) {
    return c.json({ error: "This account has been disabled.", restart: true }, 403);
  }
  await recordAudit(c.env.DB, logger, {
    action: "second_factor.succeeded",
    actorType: "user",
    actorId: userId,
    subject: passkey.data.id,
    detail: { method: "passkey" },
  });
  const minted = await mintBrowserSession(c, logger, pending.signIn, "passkey");
  if (!minted.success) return c.json({ error: "Failed to create session" }, 500);
  return c.json({ redirectTo: minted.data }, 200, { "Cache-Control": "no-store" });
});

// POST /auth/2fa/recovery — spend a recovery code instead of a passkey (no JS needed).
app.post("/recovery", async (c) => {
  const logger = requestLogger(c);
  const forged = enforceSameOrigin(c, logger);
  if (forged) return forged;
  const pending = await readPendingSignIn(c, logger);
  if (!pending) return c.redirect(EXPIRED_REDIRECT);
  const userId = pending.signIn.userId;

  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const raw = typeof form.code === "string" ? form.code : "";
  const spent =
    raw.trim().length > 0 && raw.length <= 64
      ? await consumeRecoveryCode(c.env.DB, logger, userId, await hashRecoveryCode(raw))
      : { success: true as const, data: false };
  if (!spent.success) return c.redirect("/auth/login?error=verify_failed");
  if (!spent.data) {
    const voided = await recordFailure(c, logger, pending, {
      method: "recovery_code",
      reason: "invalid_code",
    });
    return c.redirect(
      voided ? "/auth/login?error=second_factor_failed" : "/auth/2fa?error=invalid_code",
    );
  }

  await clearPendingSignIn(c, pending);
  if (!(await accountStillActive(c, logger, userId))) {
    return c.redirect("/auth/login?error=account_disabled");
  }
  await recordAudit(c.env.DB, logger, {
    action: "recovery_code.used",
    actorType: "user",
    actorId: userId,
    detail: {},
  });
  await recordAudit(c.env.DB, logger, {
    action: "second_factor.succeeded",
    actorType: "user",
    actorId: userId,
    detail: { method: "recovery_code" },
  });
  const minted = await mintBrowserSession(c, logger, pending.signIn, "recovery_code");
  if (!minted.success) return c.redirect("/auth/login?error=verify_failed");
  return c.redirect(minted.data);
});

export { app as twoFactorRouter };
