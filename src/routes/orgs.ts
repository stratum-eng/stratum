import { Hono } from "hono";
import { recordAudit } from "../storage/audit";
import {
  addOrgMember,
  createOrg,
  getOrgBySlug,
  getOrgMemberRole,
  isOrgAdmin,
  isOrgMember,
  listOrgsForUser,
  removeOrgMember,
} from "../storage/orgs";
import { usernameNamespaceTaken } from "../storage/project-namespace";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  removeTeamMember,
} from "../storage/teams";
import { getUserByUsername } from "../storage/users";
import type { Env } from "../types";
import { AppError } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import { badRequest, created, notFound, ok } from "../utils/response";
import { isValidSlug } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

// Org/team management bodies are a handful of short strings.
const MAX_ORG_BODY_BYTES = 1024 * 1024;
const MAX_ORG_MEMBER_BODY_BYTES = 1024 * 1024;
const MAX_TEAM_BODY_BYTES = 1024 * 1024;
const MAX_TEAM_MEMBER_BODY_BYTES = 1024 * 1024;

app.post("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const logger = createLogger({
    path: c.req.path,
    userId,
  });

  const body = await readJsonWithLimit<{ name?: unknown; slug?: unknown }>(
    c,
    MAX_ORG_BODY_BYTES,
    logger,
  );
  if (body instanceof Response) return body;
  if (typeof body.name !== "string" || !body.name.trim()) {
    return badRequest("name is required");
  }
  if (!isValidSlug(body.slug)) {
    return badRequest("slug must be a 1-64 char alphanumeric slug");
  }

  // Org projects live under the @slug namespace; a slug that matches an
  // existing username would collide with that user's namespace.
  const existingUser = await getUserByUsername(c.env.DB, body.slug, logger);
  if (existingUser.success) {
    return badRequest("slug is already taken by a user namespace");
  }
  // The same `@name` space can still hold another account's projects or a live
  // claim after that account moved off the name; an org landing there would
  // own a namespace full of someone else's work.
  const namespaceTaken = await usernameNamespaceTaken(c.env, body.slug, logger);
  if (!namespaceTaken.success) {
    logger.error("Could not check the org slug's namespace", namespaceTaken.error);
    return c.json({ error: "Failed to create organization" }, 500);
  }
  if (namespaceTaken.data) {
    return badRequest("slug is already taken");
  }

  const orgResult = await createOrg(c.env.DB, logger, userId, body.name, body.slug);
  if (!orgResult.success) {
    // 409 from createOrg: a user took the name between the checks above and
    // the INSERT. A UNIQUE failure: another org did.
    const lost =
      (orgResult.error instanceof AppError && orgResult.error.statusCode === 409) ||
      /UNIQUE|constraint/i.test(orgResult.error.message);
    if (lost) return badRequest("slug is already taken");
    logger.error("Failed to create org", orgResult.error, { name: body.name, slug: body.slug });
    return c.json({ error: "Failed to create organization" }, 500);
  }
  const org = orgResult.data;

  const memberResult = await addOrgMember(c.env.DB, logger, org.id, userId, "admin");
  if (!memberResult.success) {
    logger.error("Failed to add org member", memberResult.error, { orgId: org.id, userId });
    return c.json({ error: "Failed to add organization member" }, 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "org.created",
    actorType: "user",
    actorId: userId,
    subject: org.id,
    orgId: org.id,
    detail: { slug: org.slug, name: org.name },
  });

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
  const org = result.data;

  // Org records are visible to members only — a non-member (or anonymous
  // caller) gets the same 404 as a missing org, so org existence and the owner
  // id aren't disclosed cross-tenant.
  const callerId = c.get("userId") ?? c.get("agentOwnerId");
  const memberResult = callerId
    ? await isOrgMember(c.env.DB, logger, org.id, callerId)
    : { success: true as const, data: false };
  if (!memberResult.success || !memberResult.data) {
    // Fail closed on either a genuine non-member or a membership-lookup error
    // (the error itself is logged inside isOrgMember).
    logger.debug("Org read denied (non-member or lookup failure)", { slug, orgId: org.id });
    return notFound("Org", slug);
  }

  logger.debug("Org retrieved", { slug, orgId: org.id });
  return ok({ org });
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

  const body = await readJsonWithLimit<{ userId?: unknown; role?: unknown }>(
    c,
    MAX_ORG_MEMBER_BODY_BYTES,
    logger,
  );
  if (body instanceof Response) return body;
  if (typeof body.userId !== "string" || !body.userId.trim()) {
    return badRequest("userId is required");
  }

  const role = body.role === "admin" ? "admin" : "member";

  // addOrgMember is an upsert, so the same request is an add, a role change,
  // or a no-op depending on the prior row; the audit says which (#255).
  const priorRole = await getOrgMemberRole(c.env.DB, logger, org.id, body.userId);

  const addResult = await addOrgMember(c.env.DB, logger, org.id, body.userId, role);
  if (!addResult.success) {
    logger.error("Failed to add org member", addResult.error, {
      orgId: org.id,
      userId: body.userId,
    });
    return c.json({ error: "Failed to add organization member" }, 500);
  }

  const previousRole = priorRole.success ? priorRole.data : "unknown";
  if (previousRole !== role) {
    await recordAudit(c.env.DB, logger, {
      action: previousRole === null ? "org.member.added" : "org.member.role_changed",
      actorType: "user",
      actorId: userId,
      subject: org.id,
      orgId: org.id,
      detail:
        previousRole === null
          ? { userId: body.userId, role }
          : { userId: body.userId, role, previousRole },
    });
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

  // A member may always remove THEMSELVES. Membership is granted by the org
  // without the member's consent, so leaving must never depend on the org —
  // including on its second-factor policy (#256), which this route is exempt
  // from for exactly this case. The owner cannot leave: ownership lives on the
  // org row and would outlive the membership.
  const isSelf = uid === userId;
  if (isSelf && org.ownerId === userId) {
    return c.json(
      { error: "The org owner cannot leave the organization", code: "OWNER_CANNOT_LEAVE" },
      409,
    );
  }
  if (isSelf) {
    // A non-member "leaving" must not get a success, and must not learn the
    // org exists: answered like every other non-member org request (404). A
    // lookup failure fails closed the same way.
    const memberResult = await isOrgMember(c.env.DB, logger, org.id, userId);
    if (!memberResult.success || !memberResult.data) {
      logger.debug("Self-removal by a non-member", { orgId: org.id });
      return notFound("Org", slug);
    }
  } else {
    const adminResult = await isOrgAdmin(c.env.DB, logger, org.id, userId);
    if (!adminResult.success || !adminResult.data) {
      logger.warn("User not authorized to remove org member", { orgId: org.id, userId });
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const priorRole = await getOrgMemberRole(c.env.DB, logger, org.id, uid);
  const removeResult = await removeOrgMember(c.env.DB, logger, org.id, uid);
  if (!removeResult.success) {
    logger.error("Failed to remove org member", removeResult.error, { orgId: org.id, userId: uid });
    return c.json({ error: "Failed to remove organization member" }, 500);
  }

  // A DELETE for someone who was not a member changed nothing; don't record it.
  if (!priorRole.success || priorRole.data !== null) {
    await recordAudit(c.env.DB, logger, {
      action: "org.member.removed",
      actorType: "user",
      actorId: userId,
      subject: org.id,
      orgId: org.id,
      detail: { userId: uid, previousRole: priorRole.success ? priorRole.data : "unknown" },
    });
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

  const body = await readJsonWithLimit<{
    name?: unknown;
    slug?: unknown;
    permissions?: unknown;
  }>(c, MAX_TEAM_BODY_BYTES, logger);
  if (body instanceof Response) return body;
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

  await recordAudit(c.env.DB, logger, {
    action: "team.created",
    actorType: "user",
    actorId: userId,
    subject: teamResult.data.id,
    orgId: org.id,
    detail: { slug: body.slug, permissions },
  });

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

  // Team structure is member-only; non-members get a 404 (no existence leak).
  const callerId = c.get("userId") ?? c.get("agentOwnerId");
  const memberResult = callerId
    ? await isOrgMember(c.env.DB, logger, org.id, callerId)
    : { success: true as const, data: false };
  if (!memberResult.success || !memberResult.data) {
    // Fail closed on non-member or membership-lookup error (logged in isOrgMember).
    logger.debug("Team listing denied (non-member or lookup failure)", { slug, orgId: org.id });
    return notFound("Org", slug);
  }

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

  await recordAudit(c.env.DB, logger, {
    action: "team.deleted",
    actorType: "user",
    actorId: userId,
    subject: id,
    orgId: org.id,
    detail: { slug: team.slug },
  });

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

  const body = await readJsonWithLimit<{ userId?: unknown }>(c, MAX_TEAM_MEMBER_BODY_BYTES, logger);
  if (body instanceof Response) return body;
  if (typeof body.userId !== "string" || !body.userId.trim()) {
    return badRequest("userId is required");
  }

  const addResult = await addTeamMember(c.env.DB, logger, id, body.userId);
  if (!addResult.success) {
    logger.error("Failed to add team member", addResult.error, { teamId: id, userId: body.userId });
    return c.json({ error: "Failed to add team member" }, 500);
  }

  await recordAudit(c.env.DB, logger, {
    action: "team.member.added",
    actorType: "user",
    actorId: userId,
    subject: id,
    orgId: org.id,
    detail: { userId: body.userId, teamId: id, teamSlug: team.slug },
  });

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

  await recordAudit(c.env.DB, logger, {
    action: "team.member.removed",
    actorType: "user",
    actorId: userId,
    subject: id,
    orgId: org.id,
    detail: { userId: uid, teamId: id, teamSlug: team.slug },
  });

  logger.info("Team member removed", { teamId: id, userId: uid });
  return ok({ removed: true, teamId: id, userId: uid });
});

export { app as orgsRouter };
