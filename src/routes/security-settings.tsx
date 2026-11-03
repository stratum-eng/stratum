import { type Context, Hono } from "hono";
import {
  checkSensitiveSession,
  loadSecurityOverview,
  regenerateUserRecoveryCodes,
  removeUserPasskey,
  renameUserPasskey,
  sensitiveRefusalMessage,
} from "../services/passkey-management";
import { getUser } from "../storage/users";
import type { Env } from "../types";
import { ErrorPage } from "../ui/pages/error";
import { SecurityPage } from "../ui/pages/security";
import type { SettingsNotice, SettingsUser } from "../ui/pages/settings";
import { type Logger, createLogger } from "../utils/logger";

/**
 * `/settings/security` — the server-rendered passkey page (#256). Mounted
 * ahead of `uiRouter`. Browser sessions only, like every account page: a token
 * must not be able to read or change the account's second factor.
 *
 * This is also the one page (with its JSON API) that a session blocked by an
 * org's "require a second factor" policy may still reach — see
 * `isSecondFactorEnrollmentPath` in `middleware/auth.ts`.
 */
const app = new Hono<{ Bindings: Env }>();

type AppContext = Context<{ Bindings: Env }>;

/** A closed vocabulary — the query string is attacker-controlled. */
const NOTICES: Record<string, SettingsNotice> = {
  "passkey-added": { kind: "success", message: "Passkey added." },
  "passkey-renamed": { kind: "success", message: "Passkey renamed." },
  "passkey-removed": { kind: "success", message: "Passkey removed." },
};

async function requireUser(
  c: AppContext,
  logger: Logger,
): Promise<{ user: SettingsUser } | { response: Response | Promise<Response> }> {
  const userId = c.get("userId");
  if (!userId) return { response: c.redirect("/auth/login") };
  if (c.get("authVia") !== "session") {
    return {
      response: c.html(
        <ErrorPage
          status={403}
          message="Account pages require a signed-in browser session, not an API token."
          user={null}
        />,
        403,
      ),
    };
  }
  const result = await getUser(c.env.DB, userId, logger);
  if (!result.success) return { response: c.redirect("/auth/login") };
  const { id, email, username, displayName, createdAt, githubUsername } = result.data;
  return { user: { id, email, username, displayName, createdAt, githubUsername } };
}

async function render(
  c: AppContext,
  logger: Logger,
  user: SettingsUser,
  extras: { notice?: SettingsNotice; freshRecoveryCodes?: string[] } = {},
  status: 200 | 400 | 403 | 404 | 409 | 500 = 200,
): Promise<Response> {
  const overview = await loadSecurityOverview(c.env.DB, logger, user.id);
  if (!overview.success) {
    return c.html(
      <ErrorPage
        status={500}
        message="Your passkeys could not be loaded. Try again shortly."
        user={user}
      />,
      500,
    );
  }
  const requiringOrgs = (c.get("secondFactorUnmetOrgs") ?? []).map((org) => org.slug);
  c.header("Cache-Control", "no-store");
  return c.html(
    <SecurityPage
      user={user}
      passkeys={overview.data.passkeys}
      recoveryCodesRemaining={overview.data.recoveryCodesRemaining}
      canChange={checkSensitiveSession(c, overview.data.passkeys.length > 0) === null}
      nonce={c.get("cspNonce") ?? ""}
      requiringOrgs={requiringOrgs}
      {...(extras.notice !== undefined ? { notice: extras.notice } : {})}
      {...(extras.freshRecoveryCodes !== undefined
        ? { freshRecoveryCodes: extras.freshRecoveryCodes }
        : {})}
    />,
    status,
  );
}

function requestLogger(c: AppContext): Logger {
  return createLogger({ path: c.req.path, userId: c.get("userId") });
}

app.get("/", async (c) => {
  const logger = requestLogger(c);
  const access = await requireUser(c, logger);
  if ("response" in access) return access.response;
  const key = c.req.query("notice") ?? "";
  const notice = Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined;
  return render(c, logger, access.user, notice !== undefined ? { notice } : {});
});

app.post("/passkeys/:id/rename", async (c) => {
  const logger = requestLogger(c);
  const access = await requireUser(c, logger);
  if ("response" in access) return access.response;
  const form = await c.req.parseBody();
  const result = await renameUserPasskey(
    c.env.DB,
    logger,
    access.user.id,
    c.req.param("id"),
    form.name,
  );
  if (!result.success) {
    return render(c, logger, access.user, { notice: error("Could not rename that passkey.") }, 500);
  }
  if (result.data === "invalid_name") {
    return render(
      c,
      logger,
      access.user,
      { notice: error("Enter a name of at most 64 characters.") },
      400,
    );
  }
  if (result.data === "not_found") {
    return render(c, logger, access.user, { notice: error("No such passkey.") }, 404);
  }
  return c.redirect("/settings/security?notice=passkey-renamed");
});

app.post("/passkeys/:id/delete", async (c) => {
  const logger = requestLogger(c);
  const access = await requireUser(c, logger);
  if ("response" in access) return access.response;
  const outcome = await removeUserPasskey(c, logger, access.user.id, c.req.param("id"));
  switch (outcome.kind) {
    case "removed":
      return c.redirect("/settings/security?notice=passkey-removed");
    case "not_found":
      return render(c, logger, access.user, { notice: error("No such passkey.") }, 404);
    case "refused":
      return render(
        c,
        logger,
        access.user,
        { notice: error(sensitiveRefusalMessage(outcome.refusal)) },
        403,
      );
    case "error":
      return render(
        c,
        logger,
        access.user,
        { notice: error("Could not remove that passkey.") },
        500,
      );
  }
});

app.post("/recovery-codes", async (c) => {
  const logger = requestLogger(c);
  const access = await requireUser(c, logger);
  if ("response" in access) return access.response;
  const outcome = await regenerateUserRecoveryCodes(c, logger, access.user.id);
  switch (outcome.kind) {
    case "ok":
      // Rendered, not redirected: the plaintext exists only in this response.
      return render(c, logger, access.user, { freshRecoveryCodes: outcome.codes }, 200);
    case "no_passkey":
      return render(c, logger, access.user, { notice: error("Add a passkey first.") }, 409);
    case "refused":
      return render(
        c,
        logger,
        access.user,
        { notice: error(sensitiveRefusalMessage(outcome.refusal)) },
        403,
      );
    case "error":
      return render(
        c,
        logger,
        access.user,
        { notice: error("Could not generate recovery codes.") },
        500,
      );
  }
});

function error(message: string): SettingsNotice {
  return { kind: "error", message };
}

export { app as securitySettingsRouter };
