import { type Context, Hono } from "hono";
import {
  type SensitiveRefusal,
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  loadSecurityOverview,
  regenerateUserRecoveryCodes,
  removeUserPasskey,
  renameUserPasskey,
  sensitiveRefusalMessage,
} from "../services/passkey-management";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { badRequest, internalError, notFound, ok } from "../utils/response";

/**
 * Passkey (WebAuthn) management for the signed-in user (#256), mounted at
 * `/api/users/me/passkeys`.
 *
 * Browser sessions only. A passkey is the second factor of INTERACTIVE
 * sign-in, so the credentials that bypass interactive sign-in (API tokens,
 * agent tokens, OAuth grants) can neither read nor change it.
 */
const app = new Hono<{ Bindings: Env }>();

// A WebAuthn registration response is a few KB (attestation "none").
const MAX_PASSKEY_BODY_BYTES = 64 * 1024;

type AppContext = Context<{ Bindings: Env }>;

function requestLogger(c: AppContext): Logger {
  return createLogger({
    requestId: crypto.randomUUID(),
    path: c.req.path,
    method: c.req.method,
    userId: c.get("userId"),
  });
}

function requireSessionUser(c: AppContext): { userId: string } | { response: Response } {
  const userId = c.get("userId");
  if (!userId) return { response: c.json({ error: "Unauthorized" }, 401) };
  if (c.get("authVia") !== "session") {
    return { response: refused(c, "session_required") };
  }
  return { userId };
}

function refused(c: AppContext, refusal: SensitiveRefusal): Response {
  return c.json(
    {
      error: sensitiveRefusalMessage(refusal),
      code: refusal === "session_required" ? "SESSION_REQUIRED" : "REAUTHENTICATION_REQUIRED",
    },
    403,
  );
}

/** Responses carrying a ceremony challenge or recovery codes must not be cached. */
function noStore(c: AppContext, body: unknown, status: 200 | 201 = 200): Response {
  return c.json(body, status, { "Cache-Control": "no-store" });
}

// GET /api/users/me/passkeys — the caller's passkeys and remaining recovery codes.
app.get("/", async (c) => {
  const logger = requestLogger(c);
  const access = requireSessionUser(c);
  if ("response" in access) return access.response;
  const overview = await loadSecurityOverview(c.env.DB, logger, access.userId);
  if (!overview.success) return internalError(overview.error.message);
  return ok(overview.data);
});

// POST /api/users/me/passkeys/registration/options — begin a registration ceremony.
app.post("/registration/options", async (c) => {
  const logger = requestLogger(c);
  const access = requireSessionUser(c);
  if ("response" in access) return access.response;
  const outcome = await beginPasskeyRegistration(c, logger, access.userId);
  if (outcome.kind === "refused") return refused(c, outcome.refusal);
  if (outcome.kind === "error") return internalError(outcome.error.message);
  return noStore(c, outcome.options);
});

// POST /api/users/me/passkeys/registration/verify — finish it and save the passkey.
app.post("/registration/verify", async (c) => {
  const logger = requestLogger(c);
  const access = requireSessionUser(c);
  if ("response" in access) return access.response;
  const body = await readJsonWithLimit<{ name?: unknown; response?: unknown }>(
    c,
    MAX_PASSKEY_BODY_BYTES,
    logger,
  );
  if (body instanceof Response) return body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("Request body must be a JSON object");
  }
  const outcome = await finishPasskeyRegistration(c, logger, access.userId, body);
  switch (outcome.kind) {
    case "refused":
      return refused(c, outcome.refusal);
    case "invalid":
      return c.json({ error: outcome.message }, outcome.status);
    case "error":
      return internalError(outcome.error.message);
    case "ok":
      return noStore(
        c,
        {
          passkey: outcome.passkey,
          ...(outcome.recoveryCodes !== undefined ? { recoveryCodes: outcome.recoveryCodes } : {}),
          ...(outcome.recoveryCodesFailed
            ? {
                recoveryCodesError:
                  "Your passkey was added, but recovery codes could not be generated. Generate them now at /settings/security.",
              }
            : {}),
        },
        201,
      );
  }
});

// POST /api/users/me/passkeys/recovery-codes — replace the recovery codes.
app.post("/recovery-codes", async (c) => {
  const logger = requestLogger(c);
  const access = requireSessionUser(c);
  if ("response" in access) return access.response;
  const outcome = await regenerateUserRecoveryCodes(c, logger, access.userId);
  switch (outcome.kind) {
    case "refused":
      return refused(c, outcome.refusal);
    case "no_passkey":
      return c.json(
        { error: "Register a passkey before generating recovery codes", code: "NO_PASSKEY" },
        409,
      );
    case "error":
      return internalError(outcome.error.message);
    case "ok":
      return noStore(c, { recoveryCodes: outcome.codes }, 201);
  }
});

// PATCH /api/users/me/passkeys/:id — rename.
app.patch("/:id", async (c) => {
  const logger = requestLogger(c);
  const access = requireSessionUser(c);
  if ("response" in access) return access.response;
  const body = await readJsonWithLimit<{ name?: unknown }>(c, MAX_PASSKEY_BODY_BYTES, logger);
  if (body instanceof Response) return body;
  const id = c.req.param("id");
  const result = await renameUserPasskey(
    c.env.DB,
    logger,
    access.userId,
    id,
    body && typeof body === "object" ? body.name : undefined,
  );
  if (!result.success) return internalError(result.error.message);
  if (result.data === "invalid_name") {
    return badRequest("name must be a non-empty string of at most 64 characters");
  }
  if (result.data === "not_found") return notFound("Passkey", id);
  return ok({ renamed: id });
});

// DELETE /api/users/me/passkeys/:id — remove.
app.delete("/:id", async (c) => {
  const logger = requestLogger(c);
  const access = requireSessionUser(c);
  if ("response" in access) return access.response;
  const id = c.req.param("id");
  const outcome = await removeUserPasskey(c, logger, access.userId, id);
  switch (outcome.kind) {
    case "refused":
      return refused(c, outcome.refusal);
    case "not_found":
      return notFound("Passkey", id);
    case "error":
      return internalError(outcome.error.message);
    case "removed":
      return ok({ removed: id, remaining: outcome.remaining });
  }
});

export { app as passkeysRouter };
