import { AppError, NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface Org {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: string;
  /** Members must use a second factor (passkey) to reach the app (#256). */
  requireSecondFactor: boolean;
  /**
   * Allowed client networks, as canonical CIDR strings (#399). Empty means no
   * restriction. See `src/services/org-ip-allowlist.ts`.
   */
  ipAllowlist: string[];
}

export interface OrgMember {
  orgId: string;
  userId: string;
  role: "member" | "admin";
  joinedAt: string;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
  require_second_factor?: number | null;
  ip_allowlist?: string | null;
}

interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

function rowToOrg(row: OrgRow): Org {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    requireSecondFactor: row.require_second_factor === 1,
    ipAllowlist: parseStoredIpAllowlist(row.ip_allowlist),
  };
}

/**
 * The stored `orgs.ip_allowlist` column as a list. NULL is "no restriction".
 *
 * A value that is not a JSON array of strings cannot have been written by
 * `setOrgIpAllowlist`, so it is corruption — and corruption of a security
 * restriction fails CLOSED: it comes back as a non-empty list whose entry
 * matches no address, so the org stays restricted (to nothing) rather than
 * silently opening up. An operator clears it by writing NULL.
 */
export function parseStoredIpAllowlist(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed as string[];
    }
  } catch {
    // Fall through to the fail-closed value below.
  }
  return [CORRUPT_IP_ALLOWLIST];
}

/** Stands in for an unreadable stored allowlist; parses as no range at all. */
export const CORRUPT_IP_ALLOWLIST = "<unreadable>";

export async function createOrg(
  db: D1Database,
  logger: Logger,
  ownerId: string,
  name: string,
  slug: string,
): Promise<Result<Org, Error>> {
  logger.info("Creating org", { name, slug, ownerId });

  try {
    const id = newId("org");
    const createdAt = new Date().toISOString();

    // Users and orgs share the `@name` namespace. The username check sits in
    // the INSERT itself so a concurrent rename onto this slug cannot slip in
    // between a route-level preflight and the write (renameUser does the same
    // in reverse).
    const result = await db
      .prepare(
        "INSERT INTO orgs (id, name, slug, owner_id, created_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = ?)",
      )
      .bind(id, name, slug, ownerId, createdAt, slug)
      .run();
    if ((result.meta?.changes ?? 0) === 0) {
      return err(new AppError("slug is already taken", "CONFLICT", 409, { slug }));
    }

    const org: Org = {
      id,
      name,
      slug,
      ownerId,
      createdAt,
      requireSecondFactor: false,
      ipAllowlist: [],
    };
    logger.info("Org created successfully", { orgId: id, slug });
    return ok(org);
  } catch (error) {
    logger.error("Failed to create org", error instanceof Error ? error : undefined, {
      name,
      slug,
      ownerId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function getOrg(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<Org, NotFoundError>> {
  logger.debug("Querying org by ID", { orgId: id });

  try {
    const row = await db.prepare("SELECT * FROM orgs WHERE id = ?").bind(id).first<OrgRow>();

    if (!row) {
      logger.error("Org not found", undefined, { orgId: id });
      return err(new NotFoundError("Org", id));
    }

    logger.debug("Org found", { orgId: id });
    return ok(rowToOrg(row));
  } catch (error) {
    logger.error("Failed to get org", error instanceof Error ? error : undefined, { orgId: id });
    return err(new NotFoundError("Org", id));
  }
}

/**
 * An org's slug by id, telling "no such org" (`ok(null)`) apart from "could
 * not ask" (`err`). `getOrg` cannot: it reports a D1 failure as not-found,
 * which is fine for an authorization path that fails closed either way but
 * wrong for anything that tells a person the org is gone.
 */
export async function findOrgSlugById(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<string | null, AppError>> {
  try {
    const row = await db
      .prepare("SELECT slug FROM orgs WHERE id = ?")
      .bind(id)
      .first<{ slug: string }>();
    return ok(row?.slug ?? null);
  } catch (error) {
    logger.warn("Failed to look up org slug", {
      orgId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(new AppError("Failed to look up org", "DATABASE_ERROR", 500, { orgId: id }));
  }
}

export async function getOrgBySlug(
  db: D1Database,
  logger: Logger,
  slug: string,
): Promise<Result<Org, NotFoundError>> {
  logger.debug("Querying org by slug", { slug });

  try {
    const row = await db.prepare("SELECT * FROM orgs WHERE slug = ?").bind(slug).first<OrgRow>();

    if (!row) {
      logger.error("Org not found by slug", undefined, { slug });
      return err(new NotFoundError("Org", slug));
    }

    logger.debug("Org found by slug", { slug, orgId: row.id });
    return ok(rowToOrg(row));
  } catch (error) {
    logger.error("Failed to get org by slug", error instanceof Error ? error : undefined, { slug });
    return err(new NotFoundError("Org", slug));
  }
}

export async function listOrgsForUser(
  db: D1Database,
  logger: Logger,
  userId: string,
): Promise<Result<Org[], Error>> {
  logger.debug("Listing orgs for user", { userId });

  try {
    const { results } = await db
      .prepare("SELECT o.* FROM orgs o JOIN org_members m ON o.id = m.org_id WHERE m.user_id = ?")
      .bind(userId)
      .all<OrgRow>();

    logger.debug("Orgs listed for user", { userId, count: results.length });
    return ok(results.map(rowToOrg));
  } catch (error) {
    logger.error("Failed to list orgs for user", error instanceof Error ? error : undefined, {
      userId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function addOrgMember(
  db: D1Database,
  logger: Logger,
  orgId: string,
  userId: string,
  role: "member" | "admin" = "member",
): Promise<Result<void, Error>> {
  logger.info("Adding org member", { orgId, userId, role });

  try {
    const joinedAt = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role",
      )
      .bind(orgId, userId, role, joinedAt)
      .run();

    logger.info("Org member added successfully", { orgId, userId, role });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to add org member", error instanceof Error ? error : undefined, {
      orgId,
      userId,
      role,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Add a user to an org only if they are not already a member (`ON CONFLICT DO
 * NOTHING`). Exists for the SSO adopt/JIT login path: unlike `addOrgMember`,
 * which overwrites the stored role on conflict, a sign-in must never downgrade
 * an existing owner/admin to the default role.
 */
export async function ensureOrgMember(
  db: D1Database,
  logger: Logger,
  orgId: string,
  userId: string,
  role: "member" | "admin" = "member",
): Promise<Result<void, Error>> {
  logger.info("Ensuring org member", { orgId, userId, role });

  try {
    const joinedAt = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO NOTHING",
      )
      .bind(orgId, userId, role, joinedAt)
      .run();

    logger.info("Org member ensured", { orgId, userId, role });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to ensure org member", error instanceof Error ? error : undefined, {
      orgId,
      userId,
      role,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * A member's stored role, or null when they are not a member. Lets the
 * membership routes tell an add from a role change from a no-op, so the audit
 * trail records what actually happened (#255).
 */
export async function getOrgMemberRole(
  db: D1Database,
  logger: Logger,
  orgId: string,
  userId: string,
): Promise<Result<string | null, Error>> {
  try {
    const row = await db
      .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(orgId, userId)
      .first<{ role: string }>();
    return ok(row?.role ?? null);
  } catch (error) {
    logger.error("Failed to read org member role", error instanceof Error ? error : undefined, {
      orgId,
      userId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function removeOrgMember(
  db: D1Database,
  logger: Logger,
  orgId: string,
  userId: string,
): Promise<Result<void, Error>> {
  logger.info("Removing org member", { orgId, userId });

  try {
    await db
      .prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(orgId, userId)
      .run();

    logger.info("Org member removed successfully", { orgId, userId });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to remove org member", error instanceof Error ? error : undefined, {
      orgId,
      userId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function isOrgMember(
  db: D1Database,
  logger: Logger,
  orgId: string,
  userId: string,
): Promise<Result<boolean, Error>> {
  logger.debug("Checking org membership", { orgId, userId });

  try {
    const row = await db
      .prepare("SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(orgId, userId)
      .first<OrgMemberRow>();

    const isMember = row !== null;
    logger.debug("Org membership checked", { orgId, userId, isMember });
    return ok(isMember);
  } catch (error) {
    logger.error("Failed to check org membership", error instanceof Error ? error : undefined, {
      orgId,
      userId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export type OrgAccessLevel = "none" | "read" | "write" | "admin";

interface AccessRow {
  org_role: string;
  team_level: number | null;
  ip_allowlist?: string | null;
}

/**
 * A user's effective access to an org's projects:
 * - org owner/admin → admin
 * - member of a team with write/admin permissions → write
 * - plain org member → read
 * - not a member → none
 *
 * Team permissions are org-wide (no per-project team grants yet).
 * Fails closed: database errors report "none".
 */
export async function getOrgAccessLevel(
  db: D1Database,
  logger: Logger,
  orgId: string,
  userId: string,
): Promise<OrgAccessLevel> {
  return (await getOrgAccess(db, logger, orgId, userId)).level;
}

/** {@link getOrgAccessLevel}, plus the org's IP allowlist from the same row. */
export interface OrgAccess {
  level: OrgAccessLevel;
  /** The org's allowlist (#399); empty for non-members, whose level is none anyway. */
  ipAllowlist: string[];
  /**
   * The lookup failed, so `none` means "unknown", not "not a member". Most
   * callers can ignore it, as none already fails closed; one that lets a
   * confirmed non-member through (for the route's own 404) must not.
   */
  lookupFailed?: true;
}

/**
 * {@link getOrgAccessLevel} and the org's IP allowlist in ONE query, so the
 * authz path enforces the allowlist (#399) without a second D1 round-trip per
 * org-project check. Same fail-closed contract: a database error is "none".
 */
export async function getOrgAccess(
  db: D1Database,
  logger: Logger,
  orgId: string,
  userId: string,
): Promise<OrgAccess> {
  try {
    const row = await db
      .prepare(
        `SELECT om.role AS org_role,
                MAX(CASE t.permissions WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END) AS team_level,
                o.ip_allowlist AS ip_allowlist
         FROM org_members om
         JOIN orgs o ON o.id = om.org_id
         LEFT JOIN team_members tm ON tm.user_id = om.user_id
         LEFT JOIN teams t ON t.id = tm.team_id AND t.org_id = om.org_id
         WHERE om.org_id = ? AND om.user_id = ?
         GROUP BY om.role, o.ip_allowlist`,
      )
      .bind(orgId, userId)
      .first<AccessRow>();

    if (!row) return { level: "none", ipAllowlist: [] };
    const ipAllowlist = parseStoredIpAllowlist(row.ip_allowlist);
    if (row.org_role === "owner" || row.org_role === "admin")
      return { level: "admin", ipAllowlist };
    if ((row.team_level ?? 0) >= 2) return { level: "write", ipAllowlist };
    return { level: "read", ipAllowlist };
  } catch (error) {
    logger.error("Failed to resolve org access level", error instanceof Error ? error : undefined, {
      orgId,
      userId,
    });
    return { level: "none", ipAllowlist: [], lookupFailed: true };
  }
}

export async function isOrgAdmin(
  db: D1Database,
  logger: Logger,
  orgId: string,
  userId: string,
): Promise<Result<boolean, Error>> {
  logger.debug("Checking org admin status", { orgId, userId });

  try {
    const row = await db
      .prepare("SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ? AND role = 'admin'")
      .bind(orgId, userId)
      .first<OrgMemberRow>();

    const isAdmin = row !== null;
    logger.debug("Org admin status checked", { orgId, userId, isAdmin });
    return ok(isAdmin);
  } catch (error) {
    logger.error("Failed to check org admin status", error instanceof Error ? error : undefined, {
      orgId,
      userId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Turn the org's "require a second factor" policy on or off (#256). Returns
 * whether a row changed, so a caller can tell a no-op toggle from a real one.
 */
export async function setOrgRequireSecondFactor(
  db: D1Database,
  logger: Logger,
  orgId: string,
  required: boolean,
): Promise<Result<boolean, Error>> {
  try {
    const result = await db
      .prepare(
        "UPDATE orgs SET require_second_factor = ? WHERE id = ? AND require_second_factor != ?",
      )
      .bind(required ? 1 : 0, orgId, required ? 1 : 0)
      .run();
    return ok((result.meta?.changes ?? 0) > 0);
  } catch (error) {
    logger.error(
      "Failed to set org second-factor policy",
      error instanceof Error ? error : undefined,
      {
        orgId,
      },
    );
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Replace the org's IP allowlist (#399). `entries` must already be validated
 * and canonical; an empty list clears the restriction (stored as NULL).
 * Returns the previous list and whether anything changed, for the audit entry.
 */
export async function setOrgIpAllowlist(
  db: D1Database,
  logger: Logger,
  orgId: string,
  entries: string[],
): Promise<Result<{ changed: boolean; previous: string[] }, Error>> {
  try {
    const before = await db
      .prepare("SELECT ip_allowlist FROM orgs WHERE id = ?")
      .bind(orgId)
      .first<{ ip_allowlist: string | null }>();
    const previous = parseStoredIpAllowlist(before?.ip_allowlist);
    const next = entries.length === 0 ? null : JSON.stringify(entries);
    const result = await db
      .prepare("UPDATE orgs SET ip_allowlist = ? WHERE id = ? AND ip_allowlist IS NOT ?")
      .bind(next, orgId, next)
      .run();
    return ok({ changed: (result.meta?.changes ?? 0) > 0, previous });
  } catch (error) {
    logger.error("Failed to set org IP allowlist", error instanceof Error ? error : undefined, {
      orgId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
