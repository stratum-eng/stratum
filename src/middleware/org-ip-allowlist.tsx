import type { Context, MiddlewareHandler } from "hono";
import {
  IP_NOT_ALLOWED,
  type IpDenial,
  ipDenialFor,
  ipNotAllowedMessage,
  orgIpAllowsFor,
} from "../services/org-ip-allowlist";
import { getOrgAccess, getOrgBySlug } from "../storage/orgs";
import type { Env } from "../types";
import { Layout } from "../ui/layout";
import { createLogger } from "../utils/logger";

type AppContext = Context<{ Bindings: Env }>;

/**
 * Enforces an org's IP allowlist (#399) on THAT ORG'S resources only. Runs
 * after `authMiddleware`, because the rule is resource-scoped: the same caller
 * may be on an allowed network for one org and not for another, so nothing is
 * decided about the session as a whole.
 *
 * Two halves, mirroring `orgSecondFactorMiddleware`:
 * - Before routing: `/api/orgs/:slug/*` (members, teams, SSO config,
 *   security policy, audit log, …) is refused for a member of a restricted
 *   org calling from outside its ranges. One exit stays open: a member may
 *   always leave the org (`DELETE …/members/<own id>`), since an org grants
 *   membership without asking. A caller who is not a member is let through to
 *   the route, which answers with its usual 404 — so the refusal never tells a
 *   stranger that an org exists or is restricted.
 * - After routing: org-owned projects are guarded in `src/utils/authz.ts`,
 *   which denies access and records which org's allowlist did it. A route
 *   answers that with its usual 403/404; this replaces it with an explicit
 *   `IP_NOT_ALLOWED`, so a member learns what to do instead of seeing "not
 *   found" for a project they can see from the office.
 *
 * Deliberately NOT covered: the SSO sign-in flow (`/auth/sso/*` — signing in
 * is not acting on org resources, and the IdP may be off-network), SCIM
 * (`/scim/v2`, see docs/user-guide/org-ip-allowlist.md), webhooks and deploy
 * callbacks, and anonymous reads of public projects.
 */
export const orgIpAllowlistMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const refusal = await guardOrgAdminRoute(c);
  if (refusal !== undefined) return refusal;

  await next();

  const deniedOrgId = c.get("ipDeniedOrgId");
  if (deniedOrgId !== undefined && (c.res.status === 403 || c.res.status === 404)) {
    const denial = await ipDenialFor(c, { id: deniedOrgId });
    c.res = undefined;
    c.res = await ipNotAllowedResponse(c, denial);
  }
};

async function guardOrgAdminRoute(c: AppContext): Promise<Response | undefined> {
  const match = /^\/api\/orgs\/([^/]+)(\/.*)?$/.exec(c.req.path);
  if (!match) return undefined;
  const actor = c.get("userId") ?? c.get("agentOwnerId");
  if (actor === undefined) return undefined;
  let slug: string;
  try {
    slug = decodeURIComponent(match[1] ?? "");
  } catch {
    // A malformed escape names no org; the route answers it.
    return undefined;
  }
  const rest = match[2] ?? "";
  if (c.req.method === "DELETE" && rest === `/members/${c.get("userId") ?? ""}`) return undefined;

  const logger = createLogger({ component: "OrgIpAllowlist", path: c.req.path });
  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  // A missing org (or a failed lookup) is the route's to answer.
  if (!orgResult.success) return undefined;
  const org = orgResult.data;
  if (orgIpAllowsFor(c, org.id, org.ipAllowlist, false)) return undefined;

  // Only someone the org would let in learns about the allowlist. The owner
  // counts even without a member row (see `requireOrgAdmin`).
  if (org.ownerId !== actor) {
    const access = await getOrgAccess(c.env.DB, logger, org.id, actor);
    // Unknown is not "not a member": the route's own membership query could
    // still succeed and serve the restricted org to this address.
    if (access.lookupFailed) {
      return c.json(
        { error: "Could not check access to this organization", code: "ORG_ACCESS_LOOKUP_FAILED" },
        503,
      );
    }
    if (access.level === "none") return undefined;
  }
  return ipNotAllowedResponse(c, await ipDenialFor(c, org));
}

/** 403 `IP_NOT_ALLOWED`: JSON for API clients, a page for a browser GET. */
export async function ipNotAllowedResponse(c: AppContext, denial: IpDenial): Promise<Response> {
  const message = ipNotAllowedMessage(denial);
  const wantsHtml =
    (c.req.method === "GET" || c.req.method === "HEAD") &&
    (c.req.header("Accept") ?? "").includes("text/html");
  if (!wantsHtml) {
    return c.json(
      {
        error: message,
        code: IP_NOT_ALLOWED,
        org: denial.slug,
        ip: denial.ip === "" ? null : denial.ip,
      },
      403,
    );
  }
  return c.html(
    <Layout title="Network not allowed">
      <div class="error-page">
        <h1 class="error-page-title">Network not allowed</h1>
        <p class="error-page-hint">
          The organization <strong>{denial.slug}</strong> only allows access to its projects and
          settings from its own networks. This request came from{" "}
          <code>{denial.ip === "" ? "an unidentified address" : denial.ip}</code>, which is not one
          of them.
        </p>
        <p class="error-page-hint">
          Connect from an allowed network (for example, your company VPN), or ask an org admin to
          update the allowlist. Your own projects and other organizations are not affected.
        </p>
      </div>
    </Layout>,
    403,
  );
}
