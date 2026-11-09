import type { Context, MiddlewareHandler } from "hono";
import { secondFactorRequiredMessage, unmetOrgBySlug } from "../services/org-second-factor";
import type { Env } from "../types";
import { Layout } from "../ui/layout";

type AppContext = Context<{ Bindings: Env }>;

const ENROLL_PATH = "/settings/security";

/**
 * Enforces an org's "require a second factor" policy on THAT ORG'S resources
 * only (#256). Runs after `authMiddleware`, which records the orgs whose policy
 * the caller does not satisfy (`secondFactorUnmetOrgs`): for a session, from
 * the factors it passed at sign-in; for a token, agent or OAuth grant, from
 * the factors its minter had passed (#441).
 *
 * Two halves:
 * - Before routing: `/api/orgs/:slug/*` for such an org is refused outright.
 *   Two exits stay open so a member is never trapped by an org: reading the
 *   policy (`GET …/security`) and leaving the org
 *   (`DELETE …/members/<own id>`).
 * - After routing: org-owned projects are guarded in `src/utils/authz.ts`,
 *   which denies access and records which org's policy did it. A route answers
 *   that denial with its usual 403/404; this replaces it with an explicit
 *   `SECOND_FACTOR_REQUIRED`, so the member learns what to do instead of
 *   seeing "not found" for a project they can see in the org's listing.
 *
 * Nothing else is affected: personal projects, other orgs, account settings
 * and sign-out keep working. An org grants membership without the member's
 * consent, so its policy must never reach past what the org itself grants.
 */
export const orgSecondFactorMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.get("secondFactorUnmetOrgs") === undefined) {
    await next();
    return;
  }

  const blockedSlug = blockedOrgRoute(c);
  if (blockedSlug !== undefined) return secondFactorRequired(c, blockedSlug);

  await next();

  const denied = c.get("secondFactorDeniedOrg");
  if (denied !== undefined && (c.res.status === 403 || c.res.status === 404)) {
    c.res = undefined;
    c.res = await secondFactorRequired(c, denied);
  }
};

/** The org slug when this is an `/api/orgs/:slug/...` request the policy blocks. */
function blockedOrgRoute(c: AppContext): string | undefined {
  const match = /^\/api\/orgs\/([^/]+)(\/.*)?$/.exec(c.req.path);
  if (!match) return undefined;
  const slug = match[1] ?? "";
  const rest = match[2] ?? "";
  const org = unmetOrgBySlug(c, slug);
  if (org === undefined) return undefined;
  if (c.req.method === "GET" && rest === "/security") return undefined;
  if (c.req.method === "DELETE" && rest === `/members/${c.get("userId") ?? ""}`) return undefined;
  return org;
}

/**
 * The `SECOND_FACTOR_REQUIRED` refusal for `org`: JSON, or an HTML page for a
 * browser GET. Exported so a route that decides org authority itself (rather
 * than through the guarded paths above) answers in the same shape.
 */
export async function secondFactorRequired(c: AppContext, org: string): Promise<Response> {
  const viaSession = c.get("authVia") === "session";
  const message = secondFactorRequiredMessage(org, viaSession);
  // Only a browser session is shown the page: its call to action (set up a
  // passkey) does not fix a credential, which has to be minted again.
  const wantsHtml =
    viaSession &&
    (c.req.method === "GET" || c.req.method === "HEAD") &&
    (c.req.header("Accept") ?? "").includes("text/html");
  if (!wantsHtml) {
    return c.json(
      { error: message, code: "SECOND_FACTOR_REQUIRED", org, enroll: ENROLL_PATH },
      403,
    );
  }
  return c.html(
    <Layout title="Second factor required">
      <div class="error-page">
        <h1 class="error-page-title">Second factor required</h1>
        <p class="error-page-hint">
          The organization <strong>{org}</strong> requires a passkey to reach its projects and
          settings. Your other projects and organizations are not affected.
        </p>
        <div class="error-page-actions">
          <a class="btn btn-primary" href={ENROLL_PATH}>
            Set up a passkey
          </a>
        </div>
        <p class="error-page-hint">
          Already have one? Sign out, then sign in again and use your passkey.
        </p>
      </div>
    </Layout>,
    403,
  );
}
