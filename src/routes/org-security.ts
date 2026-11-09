import { type Context, Hono } from "hono";
import {
  clientIpOf,
  ipAllowedByList,
  validateIpAllowlistInput,
} from "../services/org-ip-allowlist";
import { recordAudit } from "../storage/audit";
import {
  getOrgBySlug,
  isOrgAdmin,
  isOrgMember,
  setOrgIpAllowlist,
  setOrgRequireSecondFactor,
} from "../storage/orgs";
import { countSecondFactorImpact } from "../storage/second-factor-impact";
import { listProjectsByNamespace } from "../storage/state";
import { countPasskeys } from "../storage/webauthn";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { badRequest, forbidden, internalError, notFound, ok } from "../utils/response";

/**
 * Org security policy (#256), mounted under `/api/orgs/:slug/security`.
 *
 * Two settings:
 * - `requireSecondFactor`: every member's browser session must have passed a
 *   passkey check (or, for a session that signed in through THIS org's SSO,
 *   the IdP's own MFA is trusted). A token, agent or OAuth grant is held to
 *   the same rule by how the session that minted it had signed in (#441).
 * - `ipAllowlist` (#399): CIDR ranges the org's resources may be reached from,
 *   by any credential. Empty means no restriction. Enforced in authz and
 *   `orgIpAllowlistMiddleware`.
 *
 * Any member may read the policy (they are subject to it); only an org admin
 * or the owner may change it.
 */
const app = new Hono<{ Bindings: Env }>();

// Room for a full allowlist (100 IPv6 ranges) with whitespace.
const MAX_BODY_BYTES = 16 * 1024;

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
  return { org, userId, logger, isAdmin };
}

/**
 * The credentials the second-factor policy refuses (#441), for an admin
 * deciding whether to turn it on. Undefined on a failed count: the policy
 * itself is still readable, and a wrong zero would be worse than no number.
 */
async function secondFactorImpactFor(
  c: AppContext,
  org: { id: string; slug: string },
  logger: ReturnType<typeof createLogger>,
) {
  const projects = await listProjectsByNamespace(c.env.STATE, `@${org.slug}`, logger);
  if (!projects.success) return undefined;
  const orgProjectIds = new Set(
    projects.data
      .filter((project) => project.ownerType === "org" && project.ownerId === org.id)
      .map((project) => project.id),
  );
  const impact = await countSecondFactorImpact(c.env.DB, logger, org.id, orgProjectIds);
  return impact.success ? impact.data : undefined;
}

function policyBody(org: { requireSecondFactor: boolean; ipAllowlist: string[] }) {
  return { requireSecondFactor: org.requireSecondFactor, ipAllowlist: org.ipAllowlist };
}

app.get("/:slug/security", async (c) => {
  const ctx = await loadOrgFor(c, false);
  if ("response" in ctx) return ctx.response;
  // Admins only: the counts describe other members' credentials.
  const impact = ctx.isAdmin ? await secondFactorImpactFor(c, ctx.org, ctx.logger) : undefined;
  return ok({
    ...policyBody(ctx.org),
    ...(impact !== undefined ? { secondFactorImpact: impact } : {}),
  });
});

interface PolicyUpdate {
  requireSecondFactor?: unknown;
  ipAllowlist?: unknown;
  allowSelfLockout?: unknown;
}

app.put("/:slug/security", async (c) => {
  const ctx = await loadOrgFor(c, true);
  if ("response" in ctx) return ctx.response;
  const { org, userId, logger } = ctx;

  const body = await readJsonWithLimit<PolicyUpdate>(c, MAX_BODY_BYTES, logger);
  if (body instanceof Response) return body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("Body must be a JSON object");
  }
  if (body.requireSecondFactor === undefined && body.ipAllowlist === undefined) {
    return badRequest("Provide requireSecondFactor (boolean) and/or ipAllowlist (array)");
  }
  if (body.requireSecondFactor !== undefined && typeof body.requireSecondFactor !== "boolean") {
    return badRequest("requireSecondFactor must be a boolean");
  }
  if (body.allowSelfLockout !== undefined && typeof body.allowSelfLockout !== "boolean") {
    return badRequest("allowSelfLockout must be a boolean");
  }

  let ipAllowlist: string[] | undefined;
  if (body.ipAllowlist !== undefined) {
    const validated = validateIpAllowlistInput(body.ipAllowlist);
    if (!validated.success) return badRequest(validated.error);
    ipAllowlist = validated.data;

    // Self-lockout guard: a list that excludes the admin's own address would
    // refuse the very next request they make, including the one that would
    // fix it — and nobody outside the listed networks could fix it either.
    // Saving it anyway takes an explicit `allowSelfLockout: true` (an admin
    // configuring the list from home for an office network, say).
    const ip = clientIpOf(c);
    if (!ipAllowedByList(ipAllowlist, ip) && body.allowSelfLockout !== true) {
      return c.json(
        {
          error: `This allowlist does not include your current address (${ip === "" ? "unknown" : ip}), so saving it would lock you out of the organization. Add your address, or resend with "allowSelfLockout": true to save it anyway.`,
          code: "IP_ALLOWLIST_SELF_LOCKOUT",
          ip: ip === "" ? null : ip,
        },
        409,
      );
    }
  }

  const required =
    typeof body.requireSecondFactor === "boolean" ? body.requireSecondFactor : undefined;
  if (required !== undefined) {
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
  }

  if (ipAllowlist !== undefined) {
    const changed = await setOrgIpAllowlist(c.env.DB, logger, org.id, ipAllowlist);
    if (!changed.success) return internalError("Failed to update IP allowlist");
    if (changed.data.changed) {
      await recordAudit(c.env.DB, logger, {
        action: "org.ip_allowlist_changed",
        actorType: "user",
        actorId: userId,
        subject: org.id,
        orgId: org.id,
        detail: {
          slug: org.slug,
          ipAllowlist,
          previous: changed.data.previous,
          ...(body.allowSelfLockout === true ? { allowSelfLockout: true } : {}),
        },
      });
    }
  }

  if (required !== undefined) {
    const changed = await setOrgRequireSecondFactor(c.env.DB, logger, org.id, required);
    if (!changed.success) return internalError("Failed to update security policy");
    if (changed.data) {
      await recordAudit(c.env.DB, logger, {
        action: "org.second_factor_policy_changed",
        actorType: "user",
        actorId: userId,
        subject: org.id,
        orgId: org.id,
        detail: { slug: org.slug, requireSecondFactor: required },
      });
    }
  }

  return ok(
    policyBody({
      requireSecondFactor: required ?? org.requireSecondFactor,
      ipAllowlist: ipAllowlist ?? org.ipAllowlist,
    }),
  );
});

export { app as orgSecurityRouter };
