import { type Context, Hono } from "hono";
import { recordAudit } from "../storage/audit";
import { getOrgBySlug, isOrgAdmin, isOrgMember, setOrgRequireSecondFactor } from "../storage/orgs";
import { countPasskeys } from "../storage/webauthn";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { badRequest, forbidden, internalError, notFound, ok } from "../utils/response";

/**
 * Org security policy (#256), mounted under `/api/orgs/:slug/security`.
 *
 * One setting today: `requireSecondFactor`. When on, every member's browser
 * session must have passed a passkey check (or, for a session that signed in
 * through THIS org's SSO, the IdP's own MFA is trusted). Enforced per session
 * in `authMiddleware`; tokens are unaffected.
 *
 * Any member may read the policy (they are subject to it); only an org admin
 * or the owner may change it.
 */
const app = new Hono<{ Bindings: Env }>();

const MAX_BODY_BYTES = 4 * 1024;

type AppContext = Context<{ Bindings: Env }>;

async function loadOrgFor(c: AppContext, needAdmin: boolean) {
  const userId = c.get("userId");
  if (!userId) return { response: c.json({ error: "Unauthorized" }, 401) };
  const slug = c.req.param("slug") ?? "";
  const logger = createLogger({ path: c.req.path, userId, slug });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) return { response: notFound("Org", slug) };
  const org = orgResult.data;

  const admin = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  const isAdmin = (admin.success && admin.data) || org.ownerId === userId;
  if (!isAdmin) {
    const member = await isOrgMember(c.env.DB, logger, org.id, userId);
    const isMember = member.success && member.data;
    // Non-members (and lookup failures) get the missing-org 404: no existence leak.
    if (!isMember) return { response: notFound("Org", slug) };
    if (needAdmin) return { response: forbidden("Only an org admin can change security policy") };
  }
  return { org, userId, logger };
}

app.get("/:slug/security", async (c) => {
  const ctx = await loadOrgFor(c, false);
  if ("response" in ctx) return ctx.response;
  return ok({ requireSecondFactor: ctx.org.requireSecondFactor });
});

app.put("/:slug/security", async (c) => {
  const ctx = await loadOrgFor(c, true);
  if ("response" in ctx) return ctx.response;
  const { org, userId, logger } = ctx;

  const body = await readJsonWithLimit<{ requireSecondFactor?: unknown }>(
    c,
    MAX_BODY_BYTES,
    logger,
  );
  if (body instanceof Response) return body;
  if (!body || typeof body !== "object" || typeof body.requireSecondFactor !== "boolean") {
    return badRequest("requireSecondFactor must be a boolean");
  }
  const required = body.requireSecondFactor;

  // An admin turning the policy on must satisfy it themselves — otherwise the
  // very next request they make with their session is blocked, and an org whose
  // only admin is locked out cannot turn it back off. A session that signed in
  // through this org's SSO already satisfies it (IdP MFA is delegated).
  if (required && !org.requireSecondFactor && c.get("sessionSsoOrgId") !== org.id) {
    const passkeys = await countPasskeys(c.env.DB, logger, userId);
    if (!passkeys.success) return internalError("Could not check your passkeys");
    if (passkeys.data === 0) {
      return c.json(
        {
          error:
            "Register a passkey for your own account (/settings/security) before requiring one for the organization.",
          code: "ADMIN_SECOND_FACTOR_REQUIRED",
        },
        409,
      );
    }
  }

  const changed = await setOrgRequireSecondFactor(c.env.DB, logger, org.id, required);
  if (!changed.success) return internalError("Failed to update security policy");
  if (changed.data) {
    await recordAudit(c.env.DB, logger, {
      action: "org.second_factor_policy_changed",
      actorType: "user",
      actorId: userId,
      subject: org.id,
      detail: { slug: org.slug, requireSecondFactor: required },
    });
  }
  return ok({ requireSecondFactor: required });
});

export { app as orgSecurityRouter };
