import { NotFoundError } from "../utils/errors";
import { newId } from "../utils/ids";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

export interface Team {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  permissions: "read" | "write" | "admin";
  createdAt: string;
}

interface TeamRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  permissions: string;
  created_at: string;
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    permissions: row.permissions as Team["permissions"],
    createdAt: row.created_at,
  };
}

export async function createTeam(
  db: D1Database,
  logger: Logger,
  orgId: string,
  name: string,
  slug: string,
  permissions: Team["permissions"] = "read",
): Promise<Result<Team, Error>> {
  logger.info("Creating team", { orgId, name, slug, permissions });

  try {
    const id = newId("team");
    const createdAt = new Date().toISOString();

    await db
      .prepare(
        "INSERT INTO teams (id, org_id, name, slug, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, orgId, name, slug, permissions, createdAt)
      .run();

    const team: Team = { id, orgId, name, slug, permissions, createdAt };
    logger.info("Team created successfully", { teamId: id, orgId, slug });
    return ok(team);
  } catch (error) {
    logger.error("Failed to create team", error instanceof Error ? error : undefined, {
      orgId,
      name,
      slug,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function getTeam(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<Team, NotFoundError>> {
  logger.debug("Querying team by ID", { teamId: id });

  try {
    const row = await db.prepare("SELECT * FROM teams WHERE id = ?").bind(id).first<TeamRow>();

    if (!row) {
      logger.error("Team not found", undefined, { teamId: id });
      return err(new NotFoundError("Team", id));
    }

    logger.debug("Team found", { teamId: id });
    return ok(rowToTeam(row));
  } catch (error) {
    logger.error("Failed to get team", error instanceof Error ? error : undefined, { teamId: id });
    return err(new NotFoundError("Team", id));
  }
}

export async function listTeams(
  db: D1Database,
  logger: Logger,
  orgId: string,
): Promise<Result<Team[], Error>> {
  logger.debug("Listing teams", { orgId });

  try {
    const { results } = await db
      .prepare("SELECT * FROM teams WHERE org_id = ?")
      .bind(orgId)
      .all<TeamRow>();

    logger.debug("Teams listed", { orgId, count: results.length });
    return ok(results.map(rowToTeam));
  } catch (error) {
    logger.error("Failed to list teams", error instanceof Error ? error : undefined, { orgId });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function addTeamMember(
  db: D1Database,
  logger: Logger,
  teamId: string,
  userId: string,
): Promise<Result<void, Error>> {
  logger.info("Adding team member", { teamId, userId });

  try {
    const addedAt = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO team_members (team_id, user_id, added_at) VALUES (?, ?, ?) ON CONFLICT (team_id, user_id) DO NOTHING",
      )
      .bind(teamId, userId, addedAt)
      .run();

    logger.info("Team member added successfully", { teamId, userId });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to add team member", error instanceof Error ? error : undefined, {
      teamId,
      userId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function removeTeamMember(
  db: D1Database,
  logger: Logger,
  teamId: string,
  userId: string,
): Promise<Result<void, Error>> {
  logger.info("Removing team member", { teamId, userId });

  try {
    await db
      .prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
      .bind(teamId, userId)
      .run();

    logger.info("Team member removed successfully", { teamId, userId });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to remove team member", error instanceof Error ? error : undefined, {
      teamId,
      userId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function listTeamMembers(
  db: D1Database,
  logger: Logger,
  teamId: string,
): Promise<Result<string[], Error>> {
  logger.debug("Listing team members", { teamId });

  try {
    const { results } = await db
      .prepare("SELECT user_id FROM team_members WHERE team_id = ?")
      .bind(teamId)
      .all<{ user_id: string }>();

    const members = results.map((r) => r.user_id);
    logger.debug("Team members listed", { teamId, count: members.length });
    return ok(members);
  } catch (error) {
    logger.error("Failed to list team members", error instanceof Error ? error : undefined, {
      teamId,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function deleteTeam(
  db: D1Database,
  logger: Logger,
  id: string,
): Promise<Result<void, Error>> {
  logger.info("Deleting team", { teamId: id });

  try {
    await db.prepare("DELETE FROM team_members WHERE team_id = ?").bind(id).run();
    await db.prepare("DELETE FROM teams WHERE id = ?").bind(id).run();

    logger.info("Team deleted successfully", { teamId: id });
    return ok(undefined);
  } catch (error) {
    logger.error("Failed to delete team", error instanceof Error ? error : undefined, {
      teamId: id,
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
