/**
 * Turning a requested token binding into a stored one, and a stored one back
 * into something a person can read (#323).
 *
 * Shared by `POST /api/users/me/tokens` and the settings form so the two doors
 * to token creation cannot drift on what they accept or who may bind to what.
 */
import type { ApiTokenSummary } from "../storage/api-tokens";
import { getOrg, getOrgAccessLevel, getOrgBySlug } from "../storage/orgs";
import { getProjectByPath, listProjects } from "../storage/state";
import type { BoundCredentialBinding, CredentialBinding, Env } from "../types";
import { canReadProject } from "../utils/authz";
import { AppError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { type Result, err, ok } from "../utils/result";

/** What a caller asked to bind a new token to, before it is checked. */
export type BindingRequest =
  | { kind: "none" }
  | { kind: "project"; path: string }
  | { kind: "org"; slug: string };

/**
 * Reads the two optional request fields. Both set is refused rather than one
 * silently winning: a caller who sent both has a mistake to fix, and guessing
 * which they meant could hand out a broader token than the one they wanted.
 */
export function parseBindingRequest(
  project: unknown,
  org: unknown,
): Result<BindingRequest, AppError> {
  const hasProject = project !== undefined && project !== null && project !== "";
  const hasOrg = org !== undefined && org !== null && org !== "";
  if (hasProject && hasOrg) {
    return err(validation("Bind a token to a project or an organization, not both"));
  }
  if (hasProject) {
    if (typeof project !== "string" || project.trim().length === 0) {
      return err(validation("project must be a path like @owner/repo"));
    }
    return ok({ kind: "project", path: project.trim() });
  }
  if (hasOrg) {
    if (typeof org !== "string" || org.trim().length === 0) {
      return err(validation("org must be an organization slug"));
    }
    return ok({ kind: "org", slug: org.trim() });
  }
  return ok({ kind: "none" });
}

/** A checked binding, with the label the token list shows for it. */
export interface ResolvedBinding {
  binding: BoundCredentialBinding;
  label: string;
}

/**
 * Resolves a binding request against what the creating user can actually
 * reach.
 *
 * A project must be one the user can read; an org must be one they belong to.
 * Anything else is a 404 indistinguishable from "does not exist", so minting a
 * token is not a way to probe for private projects or orgs. Read access is
 * enough — a binding only narrows, and what the token may do inside it is
 * still decided per request by the owner's own access and the token's scope.
 *
 * @param creatorBinding - The creating credential's own binding. Token
 * management is session-only today, so this is always unbound in practice; it
 * is threaded anyway so the check cannot widen if that ever changes.
 */
export async function resolveBindingRequest(
  env: Env,
  logger: Logger,
  opts: { userId: string; creatorBinding: CredentialBinding; request: BindingRequest },
): Promise<Result<ResolvedBinding | null, AppError>> {
  const { userId, creatorBinding, request } = opts;
  switch (request.kind) {
    case "none":
      return ok(null);
    case "project": {
      const parsed = parseProjectPath(request.path);
      if (parsed === null) return err(validation("project must be a path like @owner/repo"));
      const found = await getProjectByPath(env.STATE, parsed.namespace, parsed.slug, logger);
      if (!found.success) {
        if (found.error.code === "NOT_FOUND") return err(projectNotFound(request.path));
        return err(found.error);
      }
      const project = found.data;
      if (!(await canReadProject(env.DB, project, creatorBinding, userId))) {
        return err(projectNotFound(request.path));
      }
      return ok({
        binding: { kind: "project", projectId: project.id },
        label: `${project.namespace}/${project.slug}`,
      });
    }
    case "org": {
      const slug = request.slug.startsWith("@") ? request.slug.slice(1) : request.slug;
      const found = await getOrgBySlug(env.DB, logger, slug);
      if (!found.success) return err(orgNotFound(request.slug));
      // An org-bound creator may only re-mint for its own org; any other
      // binding kind on the creator cannot be widened into an org.
      if (creatorBinding.kind === "project") return err(orgNotFound(request.slug));
      if (creatorBinding.kind === "org" && creatorBinding.orgId !== found.data.id) {
        return err(orgNotFound(request.slug));
      }
      const level = await getOrgAccessLevel(env.DB, logger, found.data.id, userId);
      if (level === "none") return err(orgNotFound(request.slug));
      return ok({ binding: { kind: "org", orgId: found.data.id }, label: `@${found.data.slug}` });
    }
  }
}

/**
 * Labels for the bindings in a token list, keyed by token id. Unbound tokens
 * are absent. A binding whose target no longer exists is labelled as such
 * rather than dropped — dropping it would display an inert token as
 * account-wide.
 */
export async function describeTokenBindings(
  env: Env,
  logger: Logger,
  tokens: ApiTokenSummary[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const bound = tokens.filter(
    (token): token is ApiTokenSummary & { binding: BoundCredentialBinding } =>
      token.binding !== undefined,
  );
  if (bound.length === 0) return labels;

  // One scan for every project binding: `getProjectById` would scan per token.
  const projectPaths = new Map<string, string>();
  if (bound.some((token) => token.binding.kind === "project")) {
    const all = await listProjects(env.STATE, logger);
    if (all.success) {
      for (const project of all.data) {
        projectPaths.set(project.id, `${project.namespace}/${project.slug}`);
      }
    } else {
      logger.warn("Could not list projects to label token bindings", {
        error: all.error.message,
      });
    }
  }

  const orgSlugs = new Map<string, string | null>();
  for (const token of bound) {
    const binding = token.binding;
    if (binding.kind === "project") {
      labels.set(
        token.id,
        projectPaths.get(binding.projectId) ?? "a project that no longer exists",
      );
      continue;
    }
    if (!orgSlugs.has(binding.orgId)) {
      const org = await getOrg(env.DB, logger, binding.orgId);
      orgSlugs.set(binding.orgId, org.success ? org.data.slug : null);
    }
    const slug = orgSlugs.get(binding.orgId);
    labels.set(token.id, slug ? `@${slug}` : "an organization that no longer exists");
  }
  return labels;
}

/** `@owner/repo` (or `owner/repo`) to its two parts; `null` for anything else. */
function parseProjectPath(path: string): { namespace: string; slug: string } | null {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [owner, slug] = parts;
  if (!owner || !slug) return null;
  return { namespace: owner.startsWith("@") ? owner : `@${owner}`, slug };
}

function validation(message: string): AppError {
  return new AppError(message, "VALIDATION_ERROR", 400);
}

function projectNotFound(path: string): AppError {
  return new AppError(`Project '${path}' not found`, "NOT_FOUND", 404);
}

function orgNotFound(slug: string): AppError {
  return new AppError(`Organization '${slug}' not found`, "NOT_FOUND", 404);
}
