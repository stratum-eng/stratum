import type { Context } from "hono";
import { tryGetContext } from "hono/context-storage";
import type { CredentialPolicy, MintFactors } from "../storage/credential-factors";
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
 * scheduled jobs) there is no unmet set and the answer is always false.
 *
 * Every kind of caller carries an unmet set. A session's is computed from the
 * factors it passed at sign-in. A credential's (API token, legacy key, agent
 * token, OAuth grant, workspace git credential) is computed from the factors
 * its MINTER had passed, recorded on the credential when it was minted (#441):
 * see {@link applyCredentialPolicy}.
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

/** Where a member adds the passkey an org's policy asks for. */
export const SECOND_FACTOR_ENROLL_PATH = "/settings/security";

/**
 * Publish an authenticated credential's second-factor policy on the request
 * (#441). Called by every credential branch of `authMiddleware`, and by git
 * smart-HTTP, which owns its own authentication.
 *
 * Two things are recorded. The unmet orgs go where a session's do, so the one
 * enforcement path (authz, and the org-route middleware) covers credentials
 * with no second code path to keep in step. The credential's own factors are
 * kept so that anything it mints inherits exactly them and no more: see
 * {@link mintFactorsOf}.
 */
export function applyCredentialPolicy(
  c: { set: Context<{ Bindings: Env }>["set"] },
  policy: CredentialPolicy | undefined,
): void {
  // Undefined only from a test double: every real resolver sets it.
  if (policy === undefined) return;
  c.set("credentialMintFactors", policy.factors);
  if (policy.unmetOrgs.length > 0) c.set("secondFactorUnmetOrgs", policy.unmetOrgs);
}

/**
 * {@link applyCredentialPolicy} for a router whose narrowed context type has no
 * `set` (git smart-HTTP). It reaches the request the same way the authz check
 * that enforces the policy does, through Hono's context storage, so the two
 * are present or absent together.
 */
export function applyCredentialPolicyToCurrentRequest(policy: CredentialPolicy | undefined): void {
  const c = tryGetContext<{ Bindings: Env }>();
  if (c !== undefined) applyCredentialPolicy(c, policy);
}

/**
 * The factors a credential minted by the current request should record (#441).
 *
 * A session passes on what it passed at sign-in. A credential passes on what
 * it was itself minted with, so an agent created with an API key, or a
 * workspace git credential minted over MCP, satisfies exactly the policies its
 * minter does. An unauthenticated caller (agent signup) passes on nothing.
 */
export function mintFactorsOf(c: Context<{ Bindings: Env }>): MintFactors {
  if (c.get("authVia") !== "session") return c.get("credentialMintFactors") ?? {};
  const factors: MintFactors = {};
  const secondFactor = c.get("sessionSecondFactor");
  if (secondFactor !== undefined) factors.secondFactor = secondFactor;
  const ssoOrgId = c.get("sessionSsoOrgId");
  if (ssoOrgId !== undefined) factors.ssoOrgId = ssoOrgId;
  return factors;
}

/**
 * What a refused caller is told, by kind of caller. A session can fix it by
 * adding or using a passkey. A credential cannot change how it was minted, so
 * its holder is told to mint it again.
 */
export function secondFactorRequiredMessage(org: string, viaSession: boolean): string {
  if (viaSession) {
    return `The organization '${org}' requires a second factor. Add a passkey at ${SECOND_FACTOR_ENROLL_PATH} — or, if you already have one, sign out and sign in again with it.`;
  }
  return `The organization '${org}' requires a second factor, and this credential was not created from a session that had passed one. Sign in with a passkey (add one at ${SECOND_FACTOR_ENROLL_PATH}) and create the credential again. Access to anything outside '${org}' is not affected.`;
}

/**
 * The org whose second-factor policy authz refused on the current request, if
 * any, for routers (git smart-HTTP) whose narrowed context type has no `get`.
 */
export function recordedSecondFactorDenial(): string | undefined {
  return tryGetContext<{ Bindings: Env }>()?.get("secondFactorDeniedOrg");
}

/**
 * The org whose second-factor policy refuses minting this credential from the
 * current request, or undefined when nothing does.
 *
 * A session that has not met some org's policy may not mint a credential that
 * could reach that org. Since #441 such a credential would be refused by that
 * org on use anyway, because it records its minter's factors. Refusing here
 * as well tells the person at the moment they can act on it, in a browser,
 * instead of leaving a script to find out later.
 *
 * This is the single decision point, and it decides on what the credential
 * can reach:
 * - `binding` null or omitted: the credential is unbound. Unbound API tokens,
 *   agent tokens, OAuth grants and the legacy key reach every org the user
 *   belongs to, so any unmet org refuses them.
 * - A resolved binding: the credential reaches only `reachesOrgId` (the bound
 *   org, or the org that owns the bound project), or no org at all for a
 *   personal project. It is refused exactly when that org is unmet, whatever
 *   the project's visibility.
 *
 * This keeps the policy scoped to what the org grants. A member added to a
 * policy org without their consent can still mint a token bound to their own
 * projects, add a passkey, or leave the org. All other access is untouched.
 *
 * Only a session is ever refused here. A credential that mints another one
 * (the legacy key creating an agent, a grant minting a workspace git
 * credential) hands its own factors on through {@link mintFactorsOf}, so the
 * new credential reaches nothing its minter cannot. Refusing that mint would
 * stop a member of a policy org creating an agent for their own projects,
 * which is further than an org's policy is allowed to reach.
 *
 * @param c - Request context
 * @param binding - The resolved binding, or null/omitted for an unbound credential
 * @returns The blocking org, or undefined
 */
export function orgBlockingCredentialMint(
  c: Context<{ Bindings: Env }>,
  binding: { reachesOrgId?: string } | null = null,
): { id: string; slug: string } | undefined {
  if (c.get("authVia") !== "session") return undefined;
  const unmet = c.get("secondFactorUnmetOrgs");
  if (!unmet || unmet.length === 0) return undefined;
  if (binding === null) return unmet[0];
  if (binding.reachesOrgId === undefined) return undefined;
  return unmet.find((org) => org.id === binding.reachesOrgId);
}

/**
 * Human-readable refusal for {@link orgBlockingCredentialMint}, naming every
 * way out. `bindable` adds the "limit it to a project" option where the
 * credential supports bindings (API tokens).
 */
export function credentialMintRefusalMessage(slug: string, opts: { bindable: boolean }): string {
  const bind = opts.bindable ? " limit the token to a project or organization outside it, or" : "";
  return `The organization '${slug}' requires a second factor, and a credential created from this session could reach it. Add a passkey at ${SECOND_FACTOR_ENROLL_PATH} (or, if you already have one, sign out and sign in again with it), or${bind} leave the organization.`;
}

/**
 * JSON 403 for an API route refusing to mint under
 * {@link orgBlockingCredentialMint}. It has the same shape as the org-resource
 * refusal, so clients handle `SECOND_FACTOR_REQUIRED` in one place.
 */
export function credentialMintRefused(
  c: Context<{ Bindings: Env }>,
  org: { slug: string },
  opts: { bindable: boolean },
): Response {
  return c.json(
    {
      error: credentialMintRefusalMessage(org.slug, opts),
      code: "SECOND_FACTOR_REQUIRED",
      org: org.slug,
      enroll: SECOND_FACTOR_ENROLL_PATH,
    },
    403,
  );
}
