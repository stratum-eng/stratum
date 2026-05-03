import { Hono } from "hono";
import {
  addOrgMember,
  createOrg,
  getOrgBySlug,
  isOrgAdmin,
  listOrgsForUser,
  removeOrgMember,
} from "../storage/orgs";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  removeTeamMember,
} from "../storage/teams";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";
import { badRequest, created, notFound, ok } from "../utils/response";
import { isValidSlug } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const logger = createLogger({
    path: c.req.path,
    userId,
  });

  const body = await c.req.json<{ name?: unknown; slug?: unknown }>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    return badRequest("name is required");
  }
  if (!isValidSlug(body.slug)) {
    return badRequest("slug must be a 1-64 char alphanumeric slug");
  }

  const orgResult = await createOrg(c.env.DB, logger, userId, body.name, body.slug);
  if (!orgResult.success) {
    logger.error("Failed to create org", orgResult.error, { name: body.name, slug: body.slug });
    return c.json({ error: "Failed to create organization" }, 500);
  }
  const org = orgResult.data;

  const memberResult = await addOrgMember(c.env.DB, logger, org.id, userId, "admin");
  if (!memberResult.success) {
    logger.error("Failed to add org member", memberResult.error, { orgId: org.id, userId });
    return c.json({ error: "Failed to add organization member" }, 500);
  }

  logger.info("Org created successfully", { orgId: org.id, slug: org.slug });
  return created({ org });
});

app.get("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const logger = createLogger({
    path: c.req.path,
    userId,
  });

  const result = await listOrgsForUser(c.env.DB, logger, userId);
  if (!result.success) {
    logger.error("Failed to list orgs", result.error, { userId });
    return c.json({ error: "Failed to list organizations" }, 500);
  }

  logger.debug("Orgs listed", { count: result.data.length });
  return ok({ orgs: result.data });
});

app.get("/:slug", async (c) => {
  const { slug } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    slug,
  });

  const result = await getOrgBySlug(c.env.DB, logger, slug);
  if (!result.success) {
    logger.warn("Org not found", { slug });
    return notFound("Org", slug);
  }

  logger.debug("Org retrieved", { slug, orgId: result.data.id });
  return ok({ org: result.data });
});

app.post("/:slug/members", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    userId,
    slug,
  });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for member addition", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  if (!adminResult.success || !adminResult.data) {
    logger.warn("User not authorized to add org member", { orgId: org.id, userId });
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ userId?: unknown; role?: unknown }>();
  if (typeof body.userId !== "string" || !body.userId.trim()) {
    return badRequest("userId is required");
  }

  const role = body.role === "admin" ? "admin" : "member";

  const addResult = await addOrgMember(c.env.DB, logger, org.id, body.userId, role);
  if (!addResult.success) {
    logger.error("Failed to add org member", addResult.error, {
      orgId: org.id,
      userId: body.userId,
    });
    return c.json({ error: "Failed to add organization member" }, 500);
  }

  logger.info("Org member added", { orgId: org.id, userId: body.userId, role });
  return ok({ added: true, orgId: org.id, userId: body.userId, role });
});

app.delete("/:slug/members/:uid", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug, uid } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    userId,
    slug,
    targetUserId: uid,
  });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for member removal", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  if (!adminResult.success || !adminResult.data) {
    logger.warn("User not authorized to remove org member", { orgId: org.id, userId });
    return c.json({ error: "Forbidden" }, 403);
  }

  const removeResult = await removeOrgMember(c.env.DB, logger, org.id, uid);
  if (!removeResult.success) {
    logger.error("Failed to remove org member", removeResult.error, { orgId: org.id, userId: uid });
    return c.json({ error: "Failed to remove organization member" }, 500);
  }

  logger.info("Org member removed", { orgId: org.id, userId: uid });
  return ok({ removed: true, orgId: org.id, userId: uid });
});

app.post("/:slug/teams", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    userId,
    slug,
  });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for team creation", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  if (!adminResult.success || !adminResult.data) {
    logger.warn("User not authorized to create team", { orgId: org.id, userId });
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ name?: unknown; slug?: unknown; permissions?: unknown }>();
  if (typeof body.name !== "string" || !body.name.trim()) {
    return badRequest("name is required");
  }
  if (!isValidSlug(body.slug)) {
    return badRequest("slug must be a 1-64 char alphanumeric slug");
  }

  const validPerms = ["read", "write", "admin"] as const;
  const permissions =
    typeof body.permissions === "string" &&
    (validPerms as readonly string[]).includes(body.permissions)
      ? (body.permissions as "read" | "write" | "admin")
      : "read";

  const teamResult = await createTeam(c.env.DB, logger, org.id, body.name, body.slug, permissions);
  if (!teamResult.success) {
    logger.error("Failed to create team", teamResult.error, { orgId: org.id, slug: body.slug });
    return c.json({ error: "Failed to create team" }, 500);
  }

  logger.info("Team created", { teamId: teamResult.data.id, orgId: org.id, slug: body.slug });
  return created({ team: teamResult.data });
});

app.get("/:slug/teams", async (c) => {
  const { slug } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    slug,
  });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for team listing", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const result = await listTeams(c.env.DB, logger, org.id);
  if (!result.success) {
    logger.error("Failed to list teams", result.error, { orgId: org.id });
    return c.json({ error: "Failed to list teams" }, 500);
  }

  logger.debug("Teams listed", { orgId: org.id, count: result.data.length });
  return ok({ teams: result.data });
});

app.delete("/:slug/teams/:id", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug, id } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    userId,
    slug,
    teamId: id,
  });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for team deletion", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  if (!adminResult.success || !adminResult.data) {
    logger.warn("User not authorized to delete team", { orgId: org.id, userId });
    return c.json({ error: "Forbidden" }, 403);
  }

  const teamResult = await getTeam(c.env.DB, logger, id);
  if (!teamResult.success) {
    logger.warn("Team not found for deletion", { teamId: id });
    return notFound("Team", id);
  }
  const team = teamResult.data;

  if (team.orgId !== org.id) {
    logger.warn("Team does not belong to org", { teamId: id, orgId: org.id });
    return notFound("Team", id);
  }

  const deleteResult = await deleteTeam(c.env.DB, logger, id);
  if (!deleteResult.success) {
    logger.error("Failed to delete team", deleteResult.error, { teamId: id });
    return c.json({ error: "Failed to delete team" }, 500);
  }

  logger.info("Team deleted", { teamId: id, orgId: org.id });
  return ok({ deleted: true, id });
});

app.post("/:slug/teams/:id/members", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug, id } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    userId,
    slug,
    teamId: id,
  });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for team member addition", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  if (!adminResult.success || !adminResult.data) {
    logger.warn("User not authorized to add team member", { orgId: org.id, userId });
    return c.json({ error: "Forbidden" }, 403);
  }

  const teamResult = await getTeam(c.env.DB, logger, id);
  if (!teamResult.success) {
    logger.warn("Team not found for member addition", { teamId: id });
    return notFound("Team", id);
  }
  const team = teamResult.data;

  if (team.orgId !== org.id) {
    logger.warn("Team does not belong to org", { teamId: id, orgId: org.id });
    return notFound("Team", id);
  }

  const body = await c.req.json<{ userId?: unknown }>();
  if (typeof body.userId !== "string" || !body.userId.trim()) {
    return badRequest("userId is required");
  }

  const addResult = await addTeamMember(c.env.DB, logger, id, body.userId);
  if (!addResult.success) {
    logger.error("Failed to add team member", addResult.error, { teamId: id, userId: body.userId });
    return c.json({ error: "Failed to add team member" }, 500);
  }

  logger.info("Team member added", { teamId: id, userId: body.userId });
  return ok({ added: true, teamId: id, userId: body.userId });
});

app.delete("/:slug/teams/:id/members/:uid", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const { slug, id, uid } = c.req.param();
  const logger = createLogger({
    path: c.req.path,
    userId,
    slug,
    teamId: id,
    targetUserId: uid,
  });

  const orgResult = await getOrgBySlug(c.env.DB, logger, slug);
  if (!orgResult.success) {
    logger.warn("Org not found for team member removal", { slug });
    return notFound("Org", slug);
  }
  const org = orgResult.data;

  const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
  if (!adminResult.success || !adminResult.data) {
    logger.warn("User not authorized to remove team member", { orgId: org.id, userId });
    return c.json({ error: "Forbidden" }, 403);
  }

  const teamResult = await getTeam(c.env.DB, logger, id);
  if (!teamResult.success) {
    logger.warn("Team not found for member removal", { teamId: id });
    return notFound("Team", id);
  }
  const team = teamResult.data;

  if (team.orgId !== org.id) {
    logger.warn("Team does not belong to org", { teamId: id, orgId: org.id });
    return notFound("Team", id);
  }

  const removeResult = await removeTeamMember(c.env.DB, logger, id, uid);
  if (!removeResult.success) {
    logger.error("Failed to remove team member", removeResult.error, { teamId: id, userId: uid });
    return c.json({ error: "Failed to remove team member" }, 500);
  }

  logger.info("Team member removed", { teamId: id, userId: uid });
  return ok({ removed: true, teamId: id, userId: uid });
});

export { app as orgsRouter };
