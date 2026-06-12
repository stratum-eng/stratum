import { NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface Org {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: string;
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
  };
}

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

    await db
      .prepare("INSERT INTO orgs (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, name, slug, ownerId, createdAt)
      .run();

    const org: Org = { id, name, slug, ownerId, createdAt };
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
  try {
    const row = await db
      .prepare(
        `SELECT om.role AS org_role,
                MAX(CASE t.permissions WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END) AS team_level
         FROM org_members om
         LEFT JOIN team_members tm ON tm.user_id = om.user_id
         LEFT JOIN teams t ON t.id = tm.team_id AND t.org_id = om.org_id
         WHERE om.org_id = ? AND om.user_id = ?
         GROUP BY om.role`,
      )
      .bind(orgId, userId)
      .first<AccessRow>();

    if (!row) return "none";
    if (row.org_role === "owner" || row.org_role === "admin") return "admin";
    if ((row.team_level ?? 0) >= 2) return "write";
    return "read";
  } catch (error) {
    logger.error("Failed to resolve org access level", error instanceof Error ? error : undefined, {
      orgId,
      userId,
    });
    return "none";
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
