import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { warmEntitlements } from "../billing/entitlements";
import { isGitHttpPath } from "../routes/git-http";
import { isOAuthClientEndpoint } from "../routes/mcp-oauth";
import { getAgentByToken } from "../storage/agents";
import { resolveApiToken, touchApiTokenLastUsed } from "../storage/api-tokens";
import { SCOPE_WRITE, resolveOAuthAccessToken, touchOAuthTokenLastUsed } from "../storage/oauth";
import { deleteSession, getSession } from "../storage/sessions";
import { getUser, getUserByToken } from "../storage/users";
import type { ApiTokenScope, Env, User } from "../types";
import { getWaitUntil } from "../utils/execution-ctx";
import { isWriteMethod } from "../utils/http-methods";
import { type Logger, createLogger } from "../utils/logger";
import { buildAuthenticateChallenge, isMcpPath } from "../utils/oauth-challenge";

declare module "hono" {
  interface ContextVariableMap {
    userId?: string;
    username: string;
    agentId?: string;
    agentOwnerId?: string;
    /** How the caller authenticated — CSRF checks apply to "session" only. */
    authVia?: "token" | "session";
    /** What the authenticating API token may do (#254). Absent for session and
     * agent callers, whose authority is not token-scoped. */
    tokenScope?: ApiTokenScope;
    /** Row id of the authenticating scoped token (#254). Present for scoped
     * tokens ONLY — the legacy credential also resolves to `read_write`, so
     * `tokenScope` cannot tell the two apart and anything that must treat them
     * differently has to key on this. */
    apiTokenId?: string;
    /** Row id of the authenticating OAuth grant (#349). Present ONLY for a
     * caller holding an `stratum_mcp_` access token — i.e. one acting through
     * a client the user consented to, rather than a credential they hold
     * themselves. Anything that must treat a delegated credential differently
     * keys on this. */
    oauthGrantId?: string;
    /** The OAuth client the grant was issued to (#349). Carried for logging and
     * audit attribution: "which editor did this" is not answerable from the
     * user id alone. */
    oauthClientId?: string;
    /**
     * The caller's product-analytics preference (#257), read from the same
     * `users` row this middleware already loads. Absent for unauthenticated
     * callers, who have no preference to honor.
     */
    telemetryOptOut?: boolean;
    logger: Logger;
  }
}

function sanitizeToken(token: string): string {
  // Only show first 8 characters of token for logging
  if (token.length <= 12) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * Did this request authenticate with a narrow, revocable credential — a scoped
 * API token (#254) or an OAuth grant (#349)?
 *
 * Gates the endpoints that mint the LEGACY credential. That key never expires
 * and cannot be revoked one-at-a-time, so a credential able to rotate it could
 * outlive its own revocation: "revoke the lost laptop" would leave the laptop
 * holding a permanent key it minted on the way out. An OAuth grant is the same
 * hazard one step worse — it lives inside software the user does not control,
 * so "disconnect this editor" has to actually disconnect it.
 *
 * Session callers and legacy-token callers are unaffected, which is what keeps
 * existing automation working.
 */
export function cannotMintLegacyCredential(c: {
  get: (key: "apiTokenId" | "oauthGrantId") => string | undefined;
}): boolean {
  return c.get("apiTokenId") !== undefined || c.get("oauthGrantId") !== undefined;
}

/**
 * Resolve the caller's identity from an agent token, a user token, or a session
 * cookie, and populate the auth context the routes read.
 *
 * Every account lookup here fails CLOSED (#236, mirroring #229 in git-http):
 * the caller is authenticated only when the lookup succeeds AND returns a live
 * account. A lookup that errors, rejects, or finds no row is a 401, never a
 * pass — otherwise a transient D1 failure would authenticate an account the
 * deletion cascade is erasing.
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const requestId = crypto.randomUUID();
  const logger = createLogger({
    requestId,
    path: c.req.path,
    method: c.req.method,
  });

  c.set("logger", logger);

  /**
   * Pre-fetch the caller's plan limits for LATER requests (PRD §4).
   *
   * Called at every point below where an identity is established, because this
   * is the only place that knows who is paying before the routes run. It is
   * inert unless the cloud billing vars are set, never awaited (it schedules on
   * `waitUntil` and is skipped outright when there is none), and nothing in this
   * request reads the result — a warm that fails costs a later reader nothing
   * but a fail-open default.
   *
   * An agent warms its OWNER, not itself: agents are not billing subjects.
   */
  const warmOwner = (ownerId: string): void => {
    warmEntitlements(c.env, getWaitUntil(c), { ownerId, ownerType: "user" }, logger);
  };

  // The git smart-HTTP router authenticates over HTTP Basic itself; let it own
  // the challenge instead of rejecting the non-Bearer header here.
  if (isGitHttpPath(c.req.path)) {
    await next();
    return;
  }

  // Same deal for the OAuth endpoints that authenticate a CLIENT rather than a
  // user (#349): `client_secret_basic` sends `Authorization: Basic …`, which
  // the non-Bearer rejection below would turn into a 401 before routing. They
  // are also reachable before the caller holds any Stratum credential at all.
  if (isOAuthClientEndpoint(c.req.path)) {
    await next();
    return;
  }

  /**
   * A 401 that carries the OAuth challenge when it is answering the MCP
   * endpoint.
   *
   * Every rejection on `/mcp` has to say where to re-authorize, not just that
   * the caller failed — a client whose stored token was revoked or expired
   * otherwise gets a bare 401 and no way to tell "refresh me" from "you are not
   * welcome here". That applies whichever credential kind was presented, so it
   * lives here rather than only in the OAuth branch: someone whose
   * `stratum_user_` token stopped working should still be pointed at the flow
   * that would get them a working one.
   */
  const rejectToken = (message: string): Response =>
    c.json(
      { error: message },
      401,
      isMcpPath(c.req.path)
        ? {
            "WWW-Authenticate": buildAuthenticateChallenge(
              c.req.url,
              "invalid_token",
              "The access token is expired, revoked, or unknown",
            ),
          }
        : {},
    );

  /**
   * Does the method-based read-only rule apply to this request?
   *
   * Everywhere except `/mcp`, yes: a `read` credential is refused on anything
   * that is not a GET or HEAD, before routing, so no write route has to
   * remember the rule and a route added later inherits it.
   *
   * `/mcp` is the one place where the method genuinely says nothing about the
   * operation. Every MCP call is a POST — `tools/list` and `stratum_get_file`
   * as much as `stratum_commit` — so applying the rule here would not restrict
   * a read-only credential, it would lock it out of the endpoint entirely, and
   * `mcp:read` would be a scope no client could use.
   *
   * This is not a hole, and it is emphatically not a per-route exception that
   * some future write route could forget: the tool call is re-dispatched as a
   * real API sub-request (`src/mcp/dispatch.ts`) carrying this same credential,
   * and THAT request runs this middleware again with the method the operation
   * actually uses. So a read-only caller is refused at exactly the same check,
   * one layer in, where the method finally means something.
   */
  const scopeRuleApplies = !isMcpPath(c.req.path);

  const authHeader = c.req.header("Authorization");

  if (authHeader) {
    if (!authHeader.startsWith("Bearer ")) {
      logger.warn("Auth failed - invalid Authorization header format", {
        path: c.req.path,
      });
      return rejectToken("Invalid token");
    }

    const token = authHeader.slice(7);

    if (token.startsWith("stratum_user_")) {
      // Scoped tokens first (#254), then the legacy `users.token_hash`.
      //
      // A scoped token that resolves is answered here — revoked, expired, or a
      // soft-deleting owner all reject rather than falling through, so the
      // fallback can never launder a rejected credential.
      //
      // Anything else — no such scoped token, or a storage failure reading the
      // table — tries the legacy path. That is NOT failing open: the caller
      // still has to present a credential that matches `users.token_hash`,
      // which a scoped token never does (distinct tables, distinct hashes). The
      // degraded behaviour when D1 is unwell is that a scoped-token holder gets
      // 401 while a legacy one still works, which is the safe direction.
      const scopedToken = await resolveApiToken(c.env.DB, token, logger);

      let user: User;
      let scope: ApiTokenScope;
      let tokenId: string | null;
      let lastUsedAt: string | undefined;

      if (scopedToken.success) {
        user = scopedToken.data.user;
        scope = scopedToken.data.scope;
        tokenId = scopedToken.data.tokenId;
        lastUsedAt = scopedToken.data.lastUsedAt;
      } else {
        const userResult = await getUserByToken(c.env.DB, token, logger);
        if (!userResult.success) {
          logger.warn("Auth failed - invalid user token", {
            path: c.req.path,
            tokenHint: sanitizeToken(token),
          });
          return rejectToken("Invalid token");
        }
        // A soft-`deleting` account's credentials stop working immediately — the
        // deleting_at flag rides on the same user row (no second round-trip) and
        // we reject BEFORE setting any context so nothing downstream trusts it.
        if (userResult.data.deletingAt) {
          logger.warn("Auth rejected - user is deleting", {
            path: c.req.path,
            userId: userResult.data.id,
          });
          return rejectToken("Invalid token");
        }
        user = userResult.data;
        // The legacy credential predates scopes and carries the full account
        // power it always had. Time-boxed: it can be disabled explicitly.
        scope = "read_write";
        tokenId = null;
      }

      // See `scopeRuleApplies`: refused before ROUTING everywhere the method
      // describes the operation, and re-checked one layer in for `/mcp`, where
      // it does not.
      if (scopeRuleApplies && scope === "read" && isWriteMethod(c.req.method)) {
        logger.warn("Auth rejected - read-only token on a write request", {
          path: c.req.path,
          method: c.req.method,
          userId: user.id,
        });
        return c.json(
          {
            error: "This token is read-only and cannot perform write operations",
            code: "TOKEN_SCOPE_INSUFFICIENT",
          },
          403,
        );
      }

      c.set("userId", user.id);
      c.set("username", user.username);
      c.set("authVia", "token");
      c.set("tokenScope", scope);
      if (tokenId !== null) c.set("apiTokenId", tokenId);
      // Read off `user`, which both branches above populate — the scoped-token
      // join selects `telemetry_opt_out` for exactly this reason, so opting out
      // is not defeated by authenticating with a scoped token instead of the
      // legacy key.
      c.set("telemetryOptOut", user.telemetryOptOut === true);

      // Off the response path, and debounced inside `touchApiTokenLastUsed` so
      // this is not a write per request. `getWaitUntil` rather than
      // `c.executionCtx`, which THROWS when none was supplied — as in every
      // `app.fetch(request, env)` test.
      if (tokenId !== null) {
        const waitUntil = getWaitUntil(c);
        const touch = touchApiTokenLastUsed(c.env.DB, logger, {
          tokenId,
          ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
        });
        if (waitUntil) waitUntil(touch);
        else await touch;
      }

      warmOwner(user.id);

      logger.debug("Auth success - user", { userId: user.id, username: user.username, scope });
      await next();
      return;
    }

    if (token.startsWith("stratum_agent_")) {
      const agentResult = await getAgentByToken(c.env.DB, token, logger);
      if (!agentResult.success) {
        logger.warn("Auth failed - invalid agent token", {
          path: c.req.path,
          tokenHint: sanitizeToken(token),
        });
        return rejectToken("Invalid token");
      }
      // An agent inherits its owner's access, so a deleting owner's agent must
      // stop working too — otherwise it's an authenticated write channel that
      // re-creates rows the account cascade is erasing. Fail CLOSED on the
      // owner lookup: an unresolved lookup or a deleting owner rejects the
      // agent token. getUser can reject on a D1 error, so catch it rather
      // than letting it propagate past this middleware.
      let ownerResult: Awaited<ReturnType<typeof getUser>>;
      try {
        ownerResult = await getUser(c.env.DB, agentResult.data.ownerId, logger);
      } catch (error) {
        logger.warn("Agent owner lookup threw during auth; failing closed", {
          ownerId: agentResult.data.ownerId,
          error: error instanceof Error ? error.message : String(error),
        });
        return rejectToken("Invalid token");
      }
      if (!ownerResult.success || ownerResult.data.deletingAt) {
        logger.warn("Auth failed - agent owner is deleting", { path: c.req.path });
        return rejectToken("Invalid token");
      }
      c.set("agentId", agentResult.data.id);
      c.set("agentOwnerId", agentResult.data.ownerId);
      c.set("authVia", "token");
      // An agent acts under its owner's account, so the owner's telemetry
      // choice governs it — otherwise opting out could be defeated by routing
      // traffic through an agent. The owner row is already in hand.
      c.set("telemetryOptOut", ownerResult.data.telemetryOptOut === true);
      warmOwner(agentResult.data.ownerId);

      logger.debug("Auth success - agent", {
        agentId: agentResult.data.id,
        ownerId: agentResult.data.ownerId,
      });
      await next();
      return;
    }

    // OAuth access tokens issued to an MCP client (#349).
    //
    // Deliberately a peer of the two branches above rather than something the
    // /mcp route resolves for itself: the MCP endpoint reuses the real API
    // handlers, so an OAuth credential has to authenticate everywhere a user
    // token does, or the tools would diverge from the API they wrap.
    //
    // The `stratum_mcp_` prefix is exact, so the sibling credentials this
    // server also mints — `stratum_mcprt_` (refresh), `stratum_mcpac_` (code),
    // `stratum_mcpcs_` (client secret) — fall through to the rejection below
    // instead of being tried as access tokens.
    if (token.startsWith("stratum_mcp_")) {
      const grant = await resolveOAuthAccessToken(c.env.DB, token, logger);
      if (!grant.success) {
        logger.warn("Auth failed - invalid OAuth access token", {
          path: c.req.path,
          tokenHint: sanitizeToken(token),
        });
        return rejectToken("Invalid token");
      }

      // Refused before ROUTING, in the same spirit as the read-only rule below
      // it: an OAuth grant is delegated to software the user does not control,
      // and `resolveAdminAuth` grants admin authority on a bare `userId` +
      // ADMIN_EMAIL match. Without this, an instance admin connecting an editor
      // would hand that editor the admin API. Carving per-route exceptions is
      // how a structural rule stops being structural.
      if (c.req.path.startsWith("/api/admin/")) {
        logger.warn("Auth rejected - OAuth grant on an admin route", {
          path: c.req.path,
          userId: grant.data.user.id,
          clientId: grant.data.clientId,
        });
        return c.json(
          {
            error: "OAuth grants cannot reach the admin API",
            code: "ADMIN_REQUIRES_DIRECT_CREDENTIAL",
          },
          403,
        );
      }

      // Identical rule, identical reasoning, to the scoped-token check above —
      // including the `/mcp` carve-out, where the sub-request re-checks it
      // against the method the tool actually uses.
      if (scopeRuleApplies && grant.data.scope === "read" && isWriteMethod(c.req.method)) {
        logger.warn("Auth rejected - read-only OAuth grant on a write request", {
          path: c.req.path,
          method: c.req.method,
          userId: grant.data.user.id,
        });
        return c.json(
          {
            error: `This OAuth grant is read-only. Re-authorize requesting the '${SCOPE_WRITE}' scope.`,
            code: "TOKEN_SCOPE_INSUFFICIENT",
          },
          403,
        );
      }

      c.set("userId", grant.data.user.id);
      c.set("username", grant.data.user.username);
      c.set("authVia", "token");
      c.set("tokenScope", grant.data.scope);
      c.set("oauthGrantId", grant.data.grantId);
      c.set("oauthClientId", grant.data.clientId);
      c.set("telemetryOptOut", grant.data.user.telemetryOptOut === true);

      // Off the response path and debounced inside the helper, exactly as the
      // scoped-token touch below. `getWaitUntil` rather than `c.executionCtx`,
      // which THROWS when none was supplied — as in every `app.fetch(request,
      // env)` test.
      const waitUntil = getWaitUntil(c);
      const touch = touchOAuthTokenLastUsed(c.env.DB, logger, {
        grantId: grant.data.grantId,
        ...(grant.data.lastUsedAt !== undefined ? { lastUsedAt: grant.data.lastUsedAt } : {}),
      });
      if (waitUntil) waitUntil(touch);
      else await touch;

      warmOwner(grant.data.user.id);

      logger.debug("Auth success - OAuth grant", {
        userId: grant.data.user.id,
        clientId: grant.data.clientId,
        scope: grant.data.scope,
      });
      await next();
      return;
    }

    logger.warn("Auth failed - unsupported token type", {
      path: c.req.path,
      tokenHint: sanitizeToken(token),
    });
    return rejectToken("Invalid token");
  }

  const sessionId = getCookie(c, "stratum_session");
  if (sessionId) {
    const sessionResult = await getSession(c.env.DB, sessionId, logger);
    if (sessionResult.success) {
      const userId = sessionResult.data.userId;
      if (new Date(sessionResult.data.expiresAt) <= new Date()) {
        logger.debug("Session expired, deleting", { userId });
        await deleteSession(c.env.DB, sessionId, userId, logger);
      } else {
        // Fetch the user row FIRST so a soft-`deleting` account is rejected
        // before any auth context is set (the deleting_at flag rides on the
        // same row, so this is not an extra round-trip beyond the username
        // lookup this path already did). Fail CLOSED: an unresolved lookup
        // (missing row, or getUser rejecting on a D1 error) must not end up
        // authenticated any more than a deleting account should.
        let userResult: Awaited<ReturnType<typeof getUser>>;
        try {
          userResult = await getUser(c.env.DB, sessionResult.data.userId, logger);
        } catch (error) {
          logger.warn("Session user lookup threw during auth; failing closed", {
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
          return c.json({ error: "Unauthorized" }, 401);
        }
        if (!userResult.success || userResult.data.deletingAt) {
          logger.warn("Auth rejected - session user missing or deleting", { userId });
          return c.json({ error: "Unauthorized" }, 401);
        }

        c.set("userId", sessionResult.data.userId);
        c.set("authVia", "session");
        c.set("telemetryOptOut", userResult.data.telemetryOptOut === true);

        // Generate username from email if missing (backward compatibility)
        const username =
          userResult.data.username ||
          (userResult.data.email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        c.set("username", username);
        warmOwner(sessionResult.data.userId);

        logger.debug("Auth success - session", { userId: sessionResult.data.userId, username });
      }
    } else {
      logger.debug("Session not found", { sessionId: sanitizeToken(sessionId) });
    }
  } else {
    logger.debug("No auth token or session", { path: c.req.path });
  }

  await next();
};
