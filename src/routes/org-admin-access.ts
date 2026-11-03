import type { Context } from "hono";
import { type Org, getOrgBySlug, isOrgAdmin, isOrgMember } from "../storage/orgs";
import type { Env } from "../types";
import { type Logger, createLogger } from "../utils/logger";
import { forbidden, notFound } from "../utils/response";

export interface OrgAdminContext {
  org: Org;
  userId: string;
  logger: Logger;
}

/**
 * Org-admin gate for the `/api/orgs/:slug/...` admin surfaces (SSO config,
 * audit log). Admin is role 'admin' OR the orgs.owner_id column — no code path
 * ever writes an 'owner' role, and the owner's member row may have been
 * removed. Non-members (and membership-lookup failures) get the same 404 as a
 * missing org, so org existence isn't disclosed cross-tenant; members without
 * admin get 403. Requires a user: agents and anonymous callers get 401.
 */
export async function requireOrgAdmin(
  c: Context<{ Bindings: Env }>,
): Promise<OrgAdminContext | Response> {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const slug = c.req.param("slug") ?? "";
  const logger = createLogger({ path: c.req.path, userId, slug });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for admin request", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  const isAdmin = (adminResult.success && adminResult.data) || org.ownerId === userId;
  if (!isAdmin) {
    const memberResult = await isOrgMember(c.env.DB, logger, org.id, userId);
    if (memberResult.success && memberResult.data) {
      logger.warn("Non-admin member denied org admin access", { orgId: org.id, userId });
      return forbidden("Forbidden");
    }
    logger.debug("Org admin access denied (non-member or lookup failure)", { orgId: org.id });
    return notFound("Org", slug);
  }

  return { org, userId, logger };
}
