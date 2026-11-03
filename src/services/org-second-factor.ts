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

/** Where a member adds the passkey an org's policy asks for. */
export const SECOND_FACTOR_ENROLL_PATH = "/settings/security";

/**
 * The org whose second-factor policy refuses minting a credential that could
 * reach it, from this request — or undefined when nothing does.
 *
 * The org-resource checks above run per request, against the session's own
 * factors. A credential minted by that session is not a session: tokens,
 * agents and OAuth grants carry no record of how their minter signed in, so
 * once issued they reach the org's resources with no policy check at all. The
 * policy therefore has to hold at the moment of minting. A session that has
 * not met some org's policy may not mint a credential that could reach that
 * org.
 *
 * What "could reach" means depends on the credential:
 * - **Unbound credentials** (unbound API tokens, agent tokens, OAuth grants,
 *   the legacy key) can reach every org the user belongs to. Any unmet org
 *   refuses them.
 * - **A token bound to one project or org** reaches only that target. The
 *   binding check (`resolveBindingRequest`) refuses a target the policy
 *   blocks, so pass `bound: true` once that check has passed, and this
 *   function admits it.
 *
 * This keeps the policy scoped to what the org grants. A member added to a
 * policy org without their consent can still mint a token bound to their own
 * projects, add a passkey, or leave the org. All other access is untouched.
 *
 * Only sessions carry an unmet set; any other caller gets undefined here.
 * Scoped tokens and OAuth grants cannot mint at all (`cannotMintLegacyCredential`).
 *
 * @param c - Request context
 * @param opts - `bound` when the credential is limited to a target the binding check admitted
 * @returns The blocking org, or undefined
 */
export function orgBlockingCredentialMint(
  c: Context<{ Bindings: Env }>,
  opts: { bound?: boolean } = {},
): { id: string; slug: string } | undefined {
  if (opts.bound) return undefined;
  return c.get("secondFactorUnmetOrgs")?.[0];
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
