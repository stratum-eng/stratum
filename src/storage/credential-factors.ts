import type { SessionSecondFactor, UnmetSecondFactorOrg } from "./sessions";

/**
 * How the minter of a credential had authenticated (#441), in the same two
 * terms a session records about itself (#256). Stored on the credential when
 * it is minted and evaluated against an org's "require a second factor" policy
 * every time the credential is used.
 *
 * Empty means nothing is known, which is what every credential minted before
 * migration 072 carries: such a credential satisfies no org's policy.
 */
export interface MintFactors {
  secondFactor?: SessionSecondFactor;
  /** The org whose IdP authenticated the minter. Satisfies that org only. */
  ssoOrgId?: string;
}

/** A credential's recorded factors, and the orgs whose policy they fall short of. */
export interface CredentialPolicy {
  factors: MintFactors;
  /** Orgs the credential's owner belongs to that require a second factor the
   * credential was not minted with. Empty when it satisfies all of them. */
  unmetOrgs: UnmetSecondFactorOrg[];
}

/**
 * SQL for "the orgs this principal belongs to whose second-factor policy it
 * does not satisfy", as one `id:slug,id:slug` column.
 *
 * The single definition of the rule, shared by the session lookup and every
 * credential lookup so they cannot drift apart: a recorded second factor
 * satisfies every org, an SSO sign-in satisfies the org whose IdP it was, and
 * anything else satisfies none. It is a correlated subquery on the lookup the
 * caller already makes, so the policy costs no extra round-trip, and it is
 * only evaluated for a principal with no second factor.
 *
 * The arguments are column references written by this codebase (`s.user_id`),
 * never request input.
 */
export function unmetPolicyOrgsSql(columns: {
  userId: string;
  secondFactor: string;
  ssoOrgId: string;
}): string {
  const { userId, secondFactor, ssoOrgId } = columns;
  // "No second factor" is anything but a known kind, not only NULL. A value
  // this version does not recognise (a restored row, a column written by a
  // newer release) must not read as a factor: `parseSecondFactor` already
  // drops it, and if the SQL kept it the unmet set would silently be empty.
  return `CASE WHEN ${unknownFactorSql(secondFactor)} THEN (
            SELECT group_concat(o.id || ':' || o.slug, ',') FROM orgs o
             WHERE o.require_second_factor = 1
               AND (${ssoOrgId} IS NULL OR o.id != ${ssoOrgId})
               AND (o.owner_id = ${userId}
                    OR EXISTS (SELECT 1 FROM org_members m
                                WHERE m.org_id = o.id AND m.user_id = ${userId}))
          ) END`;
}

/**
 * SQL for "this column does not hold a second factor this version knows".
 * The list is the SQL twin of {@link parseSecondFactor}; keep them in step.
 */
export function unknownFactorSql(secondFactor: string): string {
  return `COALESCE(${secondFactor}, '') NOT IN ('passkey', 'recovery_code')`;
}

/** `id:slug,id:slug` (ids are `org_<hex>`, slugs are `[a-z0-9-]`, so both
 * separators are unambiguous). */
export function parseUnmetOrgs(raw: string | null | undefined): UnmetSecondFactorOrg[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((pair) => {
      const at = pair.indexOf(":");
      return { id: pair.slice(0, at), slug: pair.slice(at + 1) };
    })
    .filter((org) => org.id.length > 0 && org.slug.length > 0);
}

/** Narrow a stored factor column to a known kind. Anything else, including a
 * value written by a newer version, reads as no factor: the safe direction. */
export function parseSecondFactor(
  value: string | null | undefined,
): SessionSecondFactor | undefined {
  return value === "passkey" || value === "recovery_code" ? value : undefined;
}

/** The two stored columns for a credential's factors, in insert order. */
export function mintFactorColumns(
  factors: MintFactors | undefined,
): [string | null, string | null] {
  return [factors?.secondFactor ?? null, factors?.ssoOrgId ?? null];
}

/**
 * Read a credential's policy off a lookup row that selected its two factor
 * columns and {@link unmetPolicyOrgsSql}. Every field is optional because a
 * stub row in a test may omit them, which reads as "nothing recorded, nothing
 * unmet"; a real lookup always selects all three.
 */
export function credentialPolicyFromRow(row: {
  minted_second_factor?: string | null;
  minted_sso_org_id?: string | null;
  unmet_policy_orgs?: string | null;
}): CredentialPolicy {
  const secondFactor = parseSecondFactor(row.minted_second_factor);
  const factors: MintFactors = {};
  if (secondFactor !== undefined) factors.secondFactor = secondFactor;
  if (row.minted_sso_org_id) factors.ssoOrgId = row.minted_sso_org_id;
  return { factors, unmetOrgs: parseUnmetOrgs(row.unmet_policy_orgs) };
}
