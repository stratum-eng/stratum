import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";
import { isExpired } from "./api-tokens";

/**
 * How many live credentials an org's "require a second factor" policy refuses
 * (#441): the ones its members hold that were not minted from a session that
 * satisfies the policy. An admin reads this before turning the policy on, so
 * that scripts and agents stopping is a decision and not a discovery.
 *
 * The same numbers describe the present when the policy is already on.
 */
export interface SecondFactorImpact {
  /** Members holding at least one refused token, agent or OAuth grant. */
  members: number;
  /** API tokens that are account-wide, bound to this org, or bound to one of
   * its projects. A token bound anywhere else never reaches the org. */
  apiTokens: number;
  /** Agents with their own token. An agent created for an MCP connection is
   * counted through its grant. */
  agents: number;
  /** OAuth grants: MCP connections and CLI sign-ins. */
  oauthGrants: number;
  /**
   * Members whose account API key was not minted with a satisfying factor.
   * Kept apart from the counts above because every account has such a key,
   * whether or not it is in use, and a key that has been disabled cannot be
   * told from a live one: the column holds an unknowable hash either way.
   */
  accountKeys: number;
}

/**
 * Members of the org, including its owner, whose accounts are live. Binds the
 * org id TWICE. Anonymous placeholders, not numbered ones: those are valid in
 * D1 but are bound differently by the `node:sqlite` of the oldest Node this
 * project supports, which the tests run on.
 */
const MEMBERS_CTE = `WITH members(user_id) AS (
    SELECT u.id FROM users u
     WHERE u.deleting_at IS NULL AND u.disabled_at IS NULL
       AND (u.id = (SELECT owner_id FROM orgs WHERE id = ?)
            OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ? AND m.user_id = u.id)))`;

/** A credential row's factors do not satisfy the org. Binds the org id once.
 * Mirrors `unmetPolicyOrgsSql`. */
function unsatisfied(secondFactor: string, ssoOrgId: string): string {
  return `${secondFactor} IS NULL AND (${ssoOrgId} IS NULL OR ${ssoOrgId} != ?)`;
}

/**
 * Count the credentials org `orgId`'s policy refuses.
 *
 * `orgProjectIds` are the ids of the projects the org owns. Projects live in
 * KV, not D1, so the caller supplies them and a project-bound token is matched
 * here rather than in SQL.
 *
 * Expiry is compared in JavaScript, never SQL: see `isExpired`.
 */
export async function countSecondFactorImpact(
  db: D1Database,
  logger: Logger,
  orgId: string,
  orgProjectIds: ReadonlySet<string>,
): Promise<Result<SecondFactorImpact, AppError>> {
  // Two for `MEMBERS_CTE`, one for `unsatisfied`, in the order they appear.
  const orgIdBinds = [orgId, orgId, orgId];
  try {
    const [tokens, agents, grants, keys] = await Promise.all([
      db
        .prepare(
          `${MEMBERS_CTE}
           SELECT t.user_id, t.expires_at, t.binding_kind, t.binding_id
             FROM api_tokens t JOIN members ON members.user_id = t.user_id
            WHERE t.purpose = 'api' AND t.revoked_at IS NULL
              AND ${unsatisfied("t.minted_second_factor", "t.minted_sso_org_id")}`,
        )
        .bind(...orgIdBinds)
        .all<{
          user_id: string;
          expires_at: string | null;
          binding_kind: string | null;
          binding_id: string | null;
        }>(),
      db
        .prepare(
          `${MEMBERS_CTE}
           SELECT a.owner_id AS user_id
             FROM agents a JOIN members ON members.user_id = a.owner_id
            WHERE a.credential != 'oauth_grant'
              AND ${unsatisfied("a.minted_second_factor", "a.minted_sso_org_id")}`,
        )
        .bind(...orgIdBinds)
        .all<{ user_id: string }>(),
      db
        .prepare(
          `${MEMBERS_CTE}
           SELECT t.user_id, t.refresh_expires_at, t.access_expires_at
             FROM oauth_tokens t JOIN members ON members.user_id = t.user_id
            WHERE t.revoked_at IS NULL
              AND ${unsatisfied("t.minted_second_factor", "t.minted_sso_org_id")}`,
        )
        .bind(...orgIdBinds)
        .all<{
          user_id: string;
          refresh_expires_at: string | null;
          access_expires_at: string;
        }>(),
      db
        .prepare(
          `${MEMBERS_CTE}
           SELECT COUNT(*) AS n
             FROM users u JOIN members ON members.user_id = u.id
            WHERE ${unsatisfied("u.token_minted_second_factor", "u.token_minted_sso_org_id")}`,
        )
        .bind(...orgIdBinds)
        .first<{ n: number }>(),
    ]);

    const reachingTokens = (tokens.results ?? []).filter((row) => {
      if (isExpired(row.expires_at)) return false;
      if (row.binding_kind === null) return true;
      if (row.binding_kind === "org") return row.binding_id === orgId;
      return row.binding_id !== null && orgProjectIds.has(row.binding_id);
    });
    // A grant lives as long as its refresh token; one issued without a refresh
    // token lives as long as its access token.
    const liveGrants = (grants.results ?? []).filter(
      (row) => !isExpired(row.refresh_expires_at ?? row.access_expires_at),
    );
    const agentRows = agents.results ?? [];

    const holders = new Set<string>();
    for (const row of [...reachingTokens, ...agentRows, ...liveGrants]) holders.add(row.user_id);

    return ok({
      members: holders.size,
      apiTokens: reachingTokens.length,
      agents: agentRows.length,
      oauthGrants: liveGrants.length,
      accountKeys: keys?.n ?? 0,
    });
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError(
            error instanceof Error ? error.message : "Failed to count affected credentials",
            "DATABASE_ERROR",
            500,
            { operation: "countSecondFactorImpact", orgId },
          );
    logger.error("Failed to count credentials affected by the second-factor policy", appError, {
      orgId,
    });
    return err(appError);
  }
}
