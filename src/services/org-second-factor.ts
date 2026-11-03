import type { Context } from "hono";
import { tryGetContext } from "hono/context-storage";
import type { Env } from "../types";

declare module "hono" {
  interface ContextVariableMap {
    /**
     * Slug of the org whose "require a second factor" policy denied this
     * request's access to one of its resources (#256). Set by the authz check;
     * read by `orgSecondFactorMiddleware`, which turns the route's generic
     * 403/404 into an explicit `SECOND_FACTOR_REQUIRED`.
     */
    secondFactorDeniedOrg?: string;
  }
}

/**
 * Does an org's "require a second factor" policy deny the CURRENT request
 * access to that org's resources?
 *
 * Scoped to the org on purpose. Org membership is granted by the org, without
 * the member's consent — so if a policy could restrict a session as a whole,
 * anyone could create an org, add a victim, turn the policy on, and lock the
 * victim out of their own projects. Instead the policy only ever removes access
 * that the org itself granted: its projects, and its admin/member/team/SSO
 * endpoints. Personal projects, other orgs and account settings are untouched.
 *
 * Reads the request through Hono's context storage, so the dozens of authz
 * call sites need no new parameter. Outside a request (queue consumers,
 * scheduled jobs) or for non-session callers (tokens, agents, OAuth grants)
 * there is no unmet set and the answer is always false — those credentials are
 * not subject to the second factor.
 *
 * @param record When true (single-resource checks), remember the denial so the
 *   response can say why. List filters pass false: silently omitting a
 *   project from a listing is not an error.
 */
export function orgBlockedBySecondFactor(orgId: string, record = true): boolean {
  const c = tryGetContext<{ Bindings: Env }>();
  return c ? orgBlockedFor(c, orgId, record) : false;
}

/** As {@link orgBlockedBySecondFactor}, for a caller that already holds the context. */
export function orgBlockedFor(
  c: Context<{ Bindings: Env }>,
  orgId: string,
  record = true,
): boolean {
  const unmet = c.get("secondFactorUnmetOrgs");
  const org = unmet?.find((o) => o.id === orgId);
  if (!org) return false;
  if (record) c.set("secondFactorDeniedOrg", org.slug);
  return true;
}

/** Same, by slug — for routes addressed as `/api/orgs/:slug/...`. */
export function unmetOrgBySlug(c: Context<{ Bindings: Env }>, slug: string): string | undefined {
  return c.get("secondFactorUnmetOrgs")?.find((o) => o.slug === slug)?.slug;
}
