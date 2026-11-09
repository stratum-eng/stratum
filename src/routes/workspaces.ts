import { Hono } from "hono";
import { type EventActor, emitEvent } from "../queue/events";
import { credentialMintRefused, orgBlockingCredentialMint } from "../services/org-second-factor";
import { recordAudit } from "../storage/audit";
import { isTargetDeleting } from "../storage/deletion";
import {
  MAX_FILE_BYTES,
  artifactsRepoNameFromRemote,
  cloneRepo,
  commitAndPush,
  freshRepoToken,
  stageWorkspaceTree,
  stagedTreeKey,
  stagedTreeShaKey,
} from "../storage/git-ops";
import {
  deleteWorkspace,
  getProjectById,
  getProjectByPath,
  getWorkspace,
  listWorkspaces,
  setWorkspace,
} from "../storage/state";
import {
  DEFAULT_WORKSPACE_GIT_TTL_MINUTES,
  MAX_WORKSPACE_GIT_TTL_MINUTES,
  MIN_WORKSPACE_GIT_TTL_MINUTES,
  type MintingCredential,
  mintWorkspaceGitCredential,
} from "../storage/workspace-git-credentials";
import type { Env } from "../types";
import { getArtifactsRepoName, projectDefaultBranch } from "../types";
import {
  canReadProject,
  canWriteProject,
  canWriteWorkspace,
  credentialBindingFrom,
  refuseProjectAccess,
} from "../utils/authz";
import { durableObjectNamespace } from "../utils/durable-objects";
import { createLogger } from "../utils/logger";
import { readJsonWithLimit } from "../utils/request-body";
import {
  appError,
  badRequest,
  created,
  internalError,
  notFound,
  ok,
  unauthorized,
} from "../utils/response";
import { isStringRecord, isTraversalPath, isValidSlug, isValidUuid } from "../utils/validation";

const app = new Hono<{ Bindings: Env }>();

// Commit payload bounds — the commit clones into an in-isolate MemoryFS.
const MAX_COMMIT_FILES = 2000;
const MAX_COMMIT_BYTES = 25 * 1024 * 1024;
// Pre-parse read ceiling: comfortably above the 25 MiB post-parse aggregate
// (JSON framing — quoting, escaping, keys — inflates the wire size above the
// raw file bytes) while still well short of the ~128 MB isolate budget once
// the parsed object graph is accounted for.
const MAX_COMMIT_BODY_BYTES = 32 * 1024 * 1024;
// The create-workspace body is just an optional name string.
const MAX_CREATE_WORKSPACE_BODY_BYTES = 1024 * 1024;

// POST /projects/:namespace/:slug/workspaces - Create a workspace
app.post("/:namespace/:slug/workspaces", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { namespace, slug } = c.req.param();

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", `${namespace}/${slug}`);
    }
    // S5 (#130): storage failures stay generic — echoing the storage error
    // (which can carry KV keys/ids) would let a caller distinguish states the
    // truth table deliberately collapses.
    logger.error("Failed to get project", projectResult.error);
    return internalError("Internal error");
  }
  const project = projectResult.data;

  if (!(await canWriteProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return refuseProjectAccess(credentialBindingFrom(c), project, () =>
      notFound("Project", `${namespace}/${slug}`),
    );

  // Refuse creating a workspace/fork while the project is being deleted — a new
  // fork the cascade never captured leaks as an orphan and wedges the job.
  if (await isTargetDeleting(c.env, project, logger)) {
    return c.json({ error: "Project is being deleted", code: "TARGET_DELETING" }, 409);
  }

  const body = await readJsonWithLimit<{ name?: unknown }>(
    c,
    MAX_CREATE_WORKSPACE_BODY_BYTES,
    logger,
  ).catch(() => ({ name: undefined }));
  if (body instanceof Response) return body;
  const workspaceName = isValidSlug(body.name) ? body.name : `ws-${Date.now()}`;

  // Get the Artifacts repo using the namespaced name
  const artifactsRepoName = getArtifactsRepoName(namespace, slug);
  const projectRepo = await c.env.ARTIFACTS.get(artifactsRepoName);
  const forked = await projectRepo.fork(workspaceName);

  const setResult = await setWorkspace(
    c.env.STATE,
    project.id, // Use project ID as namespace
    {
      name: workspaceName,
      remote: forked.remote,
      parent: project.id, // Store project ID instead of name
      createdAt: new Date().toISOString(),
      branchName: workspaceName, // Artifacts fork name IS the branch ref
      // Record the owning principal so write-authz can restrict push/commit to
      // the creator (or a project admin). For an agent, the effective owner is
      // its owning user; the agent id is kept as provenance only.
      createdByUserId: userId ?? agentOwnerId,
      ...(agentId !== undefined ? { createdByAgentId: agentId } : {}),
    },
    logger,
  );

  if (!setResult.success) {
    logger.error("Failed to set workspace", setResult.error);
    return internalError("Internal error");
  }

  logger.info("Workspace created", { workspaceName, namespace, slug, projectId: project.id });

  const actor: EventActor = agentId
    ? { type: "agent", id: agentId }
    : { type: "user", ...(userId !== undefined ? { id: userId } : {}) };
  await emitEvent(
    c.env.DB,
    c.env.EVENTS_QUEUE,
    // Canonical `namespace/slug` (the route's own params), matching the other
    // producer in services/change-flow.ts — not the mutable display name.
    { type: "workspace.created", project: `${namespace}/${slug}`, workspace: workspaceName },
    actor,
    logger,
    project.id,
  );

  return created({
    workspace: workspaceName,
    remote: forked.remote,
    namespace,
    slug,
    path: `/${namespace}/${slug}/workspaces/${workspaceName}`,
  });
});

// GET /projects/:namespace/:slug/workspaces - List workspaces
app.get("/:namespace/:slug/workspaces", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentOwnerId = c.get("agentOwnerId");
  const { namespace, slug } = c.req.param();

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") {
      return notFound("Project", `${namespace}/${slug}`);
    }
    // S5 (#130): this route collapses UNAUTHORIZED to the same 404 (below), so
    // a distinct 500 here would re-open exactly the gap that collapse closes.
    logger.error("Failed to get project", projectResult.error);
    return notFound("Project", `${namespace}/${slug}`);
  }
  const project = projectResult.data;

  if (!(await canReadProject(c.env.DB, project, credentialBindingFrom(c), userId, agentOwnerId)))
    return notFound("Project", `${project.namespace}/${project.slug}`);

  const workspacesResult = await listWorkspaces(c.env.STATE, project.id, logger);
  if (!workspacesResult.success) {
    logger.error("Failed to list workspaces", workspacesResult.error);
    return internalError("Internal error");
  }

  logger.info("Workspaces listed", {
    namespace,
    slug,
    projectId: project.id,
    count: workspacesResult.data.length,
  });
  return ok({
    namespace,
    slug,
    path: `/${namespace}/${slug}`,
    workspaces: workspacesResult.data.map(({ name, createdAt }) => ({
      name,
      createdAt,
      path: `/${namespace}/${slug}/workspaces/${name}`,
    })),
  });
});

/**
 * The minting credential, read off the auth context, or null when the caller
 * authenticated in a way that cannot mint one.
 *
 * A browser session is refused. Its revocation is "sign out", and nothing a
 * child could check on each use records which session minted it, so a
 * session-minted credential would outlive the sign-out. Everything else here
 * can be re-checked per use (see storage/workspace-git-credentials.ts).
 */
function mintingCredential(c: {
  get: (key: "apiTokenId" | "oauthGrantId" | "agentId" | "authVia" | "userId") => unknown;
}): MintingCredential | null {
  if (c.get("authVia") !== "token") return null;
  const grantId = c.get("oauthGrantId");
  if (typeof grantId === "string") return { kind: "oauth_grant", id: grantId };
  const tokenId = c.get("apiTokenId");
  if (typeof tokenId === "string") return { kind: "api_token", id: tokenId };
  const agentId = c.get("agentId");
  if (typeof agentId === "string") return { kind: "agent", id: agentId };
  if (typeof c.get("userId") === "string") return { kind: "legacy_token" };
  return null;
}

// The body is one optional integer.
const MAX_REMOTE_CREDENTIAL_BODY_BYTES = 1024;

// POST /workspaces/:namespace/:slug/workspaces/:name/remote-credential (#408)
//
// Mints a short-lived credential that works ONLY for git-upload-pack and
// git-receive-pack on this one workspace. Called by the MCP tool
// `stratum_workspace_remote`. The response is the only place the secret
// appears; it is never logged, and the audit row records only its id.
app.post("/:namespace/:slug/workspaces/:name/remote-credential", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  const ownerId = userId ?? agentOwnerId;
  if (!ownerId) return unauthorized("Authentication required");

  // The middleware already refuses a read-only credential on a POST, before
  // routing (and, over MCP, on the dispatched sub-request). Repeated here
  // because a read-only grant minting a PUSH credential would be an
  // escalation, and that should not rest on one check.
  if (c.get("tokenScope") === "read") {
    return c.json(
      {
        error: "A read-only credential cannot mint a push credential",
        code: "TOKEN_SCOPE_INSUFFICIENT",
      },
      403,
    );
  }

  const minter = mintingCredential(c);
  if (minter === null) {
    return c.json(
      {
        error:
          "A browser session cannot mint a workspace remote credential. Call this with an API token, an agent token or an MCP grant.",
        code: "TOKEN_REQUIRED",
      },
      403,
    );
  }

  const { namespace, slug, name: workspaceName } = c.req.param();
  if (!isValidSlug(workspaceName)) return badRequest("invalid workspace name");

  // An empty or unparseable body means "the default lifetime".
  const body = await readJsonWithLimit<{ expiresInMinutes?: unknown } | null>(
    c,
    MAX_REMOTE_CREDENTIAL_BODY_BYTES,
    logger,
  ).catch(() => null);
  if (body instanceof Response) return body;
  const requested = body !== null && typeof body === "object" ? body.expiresInMinutes : undefined;
  const ttl = requested ?? DEFAULT_WORKSPACE_GIT_TTL_MINUTES;
  if (
    typeof ttl !== "number" ||
    !Number.isInteger(ttl) ||
    ttl < MIN_WORKSPACE_GIT_TTL_MINUTES ||
    ttl > MAX_WORKSPACE_GIT_TTL_MINUTES
  ) {
    return badRequest(
      `expiresInMinutes must be an integer between ${MIN_WORKSPACE_GIT_TTL_MINUTES} and ${MAX_WORKSPACE_GIT_TTL_MINUTES}`,
    );
  }

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code !== "NOT_FOUND") {
      logger.error("Failed to get project", projectResult.error);
    }
    return notFound("Project", `${namespace}/${slug}`);
  }
  const project = projectResult.data;
  const binding = credentialBindingFrom(c);

  // A 404, not the 403 `refuseProjectAccess` gives a reader: like the commit
  // route, every refusal here reads as "no such workspace", so the endpoint
  // never confirms that a private project exists.
  if (!(await canWriteProject(c.env.DB, project, binding, userId, agentOwnerId))) {
    return notFound("Project", `${namespace}/${slug}`);
  }

  const workspaceResult = await getWorkspace(c.env.STATE, project.id, workspaceName, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code !== "NOT_FOUND") {
      logger.error("Failed to get workspace", workspaceResult.error);
    }
    return notFound("Workspace", workspaceName);
  }
  const workspace = workspaceResult.data;

  // Exactly the rule a push over git applies, so the credential is never
  // minted for a workspace it could not push to. Same 404 as a missing
  // workspace, as on the commit route, so ownership is not revealed.
  if (!(await canWriteWorkspace(c.env.DB, project, workspace, binding, userId, agentOwnerId))) {
    return notFound("Workspace", workspaceName);
  }

  // The org second-factor rule at mint (#428). The credential reaches one
  // project, so only the org that owns it can refuse.
  const blockingOrg = orgBlockingCredentialMint(
    c,
    project.ownerType === "org" ? { reachesOrgId: project.ownerId } : {},
  );
  if (blockingOrg) return credentialMintRefused(c, blockingOrg, { bindable: false });

  if (await isTargetDeleting(c.env, project, logger)) {
    return c.json({ error: "Project is being deleted", code: "TARGET_DELETING" }, 409);
  }

  const projectRef = `${project.namespace}/${project.slug}`;
  const minted = await mintWorkspaceGitCredential(c.env.DB, logger, {
    userId: ownerId,
    minter,
    projectId: project.id,
    projectRef,
    workspaceName: workspace.name,
    workspaceCreatedAt: workspace.createdAt,
    ttlMinutes: ttl,
  });
  if (!minted.success) return appError(minted.error);

  await recordAudit(c.env.DB, logger, {
    action: "workspace_remote.credential_minted",
    actorType: agentId !== undefined ? "agent" : "user",
    actorId: agentId ?? ownerId,
    subject: minted.data.id,
    project,
    detail: {
      workspace: workspace.name,
      expiresAt: minted.data.expiresAt,
      mintedBy: minter.kind,
      ...(c.get("oauthClientId") !== undefined ? { oauthClientId: c.get("oauthClientId") } : {}),
    },
  });

  const origin = new URL(c.req.url).origin;
  return c.json(
    {
      remote: `${origin}/${project.namespace}/${project.slug}/workspaces/${workspace.name}.git`,
      username: "stratum",
      token: minted.data.plaintext,
      expiresAt: minted.data.expiresAt,
      credentialId: minted.data.id,
      project: projectRef,
      workspace: workspace.name,
      allows: ["git-upload-pack", "git-receive-pack"],
      // The refs a workspace push may update (utils/git-protocol.ts
      // `checkWorkspacePushPolicy`), besides tags.
      branches: [
        ...new Set([projectDefaultBranch(project), workspace.branchName ?? workspace.name]),
      ],
    },
    201,
    { "Cache-Control": "no-store" },
  );
});

// POST /workspaces/:workspaceName/commit - Commit changes
// Note: Workspaces are still identified by name since they're scoped by project
app.post("/:name/commit", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();

  // S7 (#130): validate identifier shapes BEFORE they are interpolated into
  // KV keys. Workspace names are slugs by construction; project ids are
  // crypto.randomUUID() values — anything else (a ':', a path, an empty
  // string) is a key-injection probe and is rejected outright.
  //
  // Deliberately ahead of the body read: rejecting a malformed name costs
  // nothing, while reading the body — even bounded — spends the request's
  // budget on a caller already known to be probing.
  if (!isValidSlug(workspaceName)) return badRequest("invalid workspace name");

  const body = await readJsonWithLimit<{
    files?: unknown;
    message?: unknown;
    projectId?: unknown;
  }>(c, MAX_COMMIT_BODY_BYTES, logger);
  if (body instanceof Response) return body;
  if (!isStringRecord(body.files))
    return badRequest("files must be an object of string paths to string contents");
  if (typeof body.message !== "string" || !body.message.trim())
    return badRequest("message is required");
  if (!isValidUuid(body.projectId)) return badRequest("projectId must be a UUID");

  // Bound the payload: the commit clones the repo into a ~128MB isolate, so an
  // unbounded file map is a memory/CPU DoS lever.
  const fileCount = Object.keys(body.files).length;
  if (fileCount > MAX_COMMIT_FILES) {
    return badRequest(`too many files in one commit (max ${MAX_COMMIT_FILES})`);
  }
  // The message and the path keys are part of the payload the isolate holds, so
  // they count against the budget too — 2000 keys of a megabyte each is 2 GB
  // that an aggregate over VALUES alone would not see.
  let totalBytes = new TextEncoder().encode(body.message).byteLength;
  // Check the seed BEFORE iterating. The aggregate guard below only runs once
  // per file, so `{ files: {} }` with an oversized message skipped it entirely
  // and reached the token mint and the clone — the exact work this block exists
  // to avoid, reachable by any authenticated caller.
  if (totalBytes > MAX_COMMIT_BYTES) {
    return badRequest(`commit payload too large (max ${MAX_COMMIT_BYTES} bytes)`);
  }
  for (const [path, contents] of Object.entries(body.files)) {
    // S7 (#130): refuse traversal-shaped paths before any git work — the same
    // guard commitAndPush enforces (defense in depth), surfaced early here so
    // a hostile map doesn't cost a clone first.
    if (isTraversalPath(path)) {
      return badRequest("file paths must be repo-relative (no '..' segment or leading '/')");
    }
    // UTF-8 bytes, not UTF-16 code units: the cap is advertised in bytes and
    // commitAndPush measures per-file size the same way. `.length` undercounts
    // every multibyte character — a CJK payload is 3 bytes per unit counted as
    // one — so string length would let a commit past three times the limit.
    const fileBytes = new TextEncoder().encode(contents).byteLength;
    // Surface commitAndPush's PER-FILE cap here too. Only the aggregate was
    // checked, so a single 20 MiB file passed this loop, minted a token and
    // cloned the repo, and was refused afterwards — the expensive work this
    // block exists to avoid.
    if (fileBytes > MAX_FILE_BYTES) {
      return badRequest(`file ${path} exceeds the ${MAX_FILE_BYTES}-byte per-file limit`);
    }
    totalBytes += fileBytes + new TextEncoder().encode(path).byteLength;
    if (totalBytes > MAX_COMMIT_BYTES) {
      return badRequest(`commit payload too large (max ${MAX_COMMIT_BYTES} bytes)`);
    }
  }

  const workspaceResult = await getWorkspace(c.env.STATE, body.projectId, workspaceName, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return notFound("Workspace", workspaceName);
    }
    // S5 (#130): a corrupt/unreadable entry answers with the SAME 404 as a
    // missing one. A distinct 500 was itself the oracle: authorization needs
    // the workspace's parent id, so a read that fails cannot be authorized at
    // all — every caller reaching here is unauthenticated for this resource,
    // and telling them "exists but broken" versus "does not exist" confirms
    // existence. The failure is not lost, it moves to the log where only
    // operators see it.
    logger.error("Failed to get workspace", workspaceResult.error);
    return notFound("Workspace", workspaceName);
  }
  const workspace = workspaceResult.data;

  // Authorization: resolve the project from the workspace's authoritative parent
  // id (never trust the body's projectId for authz beyond the KV lookup key), and
  // require BOTH project-level write and workspace-level write (creator or admin).
  // Any failure collapses to the same 404 as a missing workspace so an
  // unauthorized caller cannot distinguish "denied" from "does not exist".
  const projectResult = await getProjectById(c.env.STATE, workspace.parent, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Workspace", workspaceName);
    // Same 404-on-unreadable rule as the workspace read above: this block's own
    // contract is that every failure is indistinguishable from "does not exist".
    logger.error("Failed to resolve project for commit authz", projectResult.error);
    return notFound("Workspace", workspaceName);
  }
  const project = projectResult.data;

  const canWriteProj = await canWriteProject(
    c.env.DB,
    project,
    credentialBindingFrom(c),
    userId,
    agentOwnerId,
  );
  const canWriteWs = await canWriteWorkspace(
    c.env.DB,
    project,
    workspace,
    credentialBindingFrom(c),
    userId,
    agentOwnerId,
  );
  if (!canWriteProj || !canWriteWs) {
    logger.warn("Commit denied — insufficient workspace write access", {
      workspaceName,
      projectId: project.id,
    });
    return notFound("Workspace", workspaceName);
  }

  // Committing clones then pushes to the workspace fork. Mint a fresh write token.
  const tokenResult = await freshRepoToken(c.env.ARTIFACTS, workspace.remote, "write", logger);
  if (!tokenResult.success) {
    logger.error("Failed to mint workspace token", tokenResult.error);
    return internalError(tokenResult.error.message);
  }
  const workspaceToken = tokenResult.data;

  // A workspace fork copies the project's default branch under the same name, so
  // commits must target that ref ("main" for native repos, master/trunk/… for imports).
  const workspaceBranch = projectDefaultBranch(project);
  const cloneResult = await cloneRepo(workspace.remote, workspaceToken, logger, {
    ref: workspaceBranch,
  });
  if (!cloneResult.success) {
    logger.error("Failed to clone repo", cloneResult.error);
    return badRequest(cloneResult.error.message);
  }

  const { fs, dir } = cloneResult.data;
  const commitResult = await commitAndPush(
    fs,
    dir,
    workspace.remote,
    workspaceToken,
    body.files,
    body.message,
    logger,
    undefined,
    workspaceBranch,
  );
  if (!commitResult.success) {
    logger.error("Failed to commit and push", commitResult.error);
    return badRequest(commitResult.error.message);
  }

  // Stage the tip tree to R2 for the fetch-free merge path (ADR 004). Best-effort:
  // a staging failure must not fail the commit — the merge falls back to the cold
  // path when no staged tree is present.
  if (c.env.REPO_DO_ENABLED === "true" && c.env.REPO_OBJECTS) {
    const stageResult = await stageWorkspaceTree(
      c.env.REPO_OBJECTS,
      stagedTreeKey(project.id, workspaceName),
      fs,
      dir,
      commitResult.data,
      logger,
    );
    if (!stageResult.success) {
      logger.warn("Failed to stage workspace tree to R2; merge will use cold path", {
        workspaceName,
      });
    } else {
      // #124: also store the tree under an immutable sha-keyed copy. The
      // latest-tip key above is overwritten by every commit; the merge path
      // reads the sha-keyed copy for the change's pinned workspace_head_sha, so
      // a re-push between evaluation and merge cannot change what gets merged.
      // Best-effort like the rest of staging: on failure the merge falls back
      // to the git-based pinned path.
      await c.env.REPO_OBJECTS.put(
        stagedTreeShaKey(project.id, workspaceName, commitResult.data),
        stageResult.data.value,
      ).catch((error) => {
        logger.warn("Failed to write sha-keyed staged tree; merge will use pinned git path", {
          workspaceName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      const repoDo = durableObjectNamespace(c.env, "REPO_DO");
      if (repoDo) {
        // Also seed the per-repo DO's local hot index so the batch-merge path reads
        // staged trees from SQLite (microseconds) instead of R2 (~30ms/change).
        const stub = repoDo.get(repoDo.idFromName(project.id)) as unknown as {
          stageTree(workspace: string, value: ArrayBuffer): Promise<void>;
        };
        await stub
          .stageTree(workspaceName, stageResult.data.value.buffer as ArrayBuffer)
          .catch((error) => {
            logger.warn("Failed to seed DO hot index; batch merge will skip this change", {
              workspaceName,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    }
  }

  logger.info("Changes committed", { workspaceName, commit: commitResult.data });
  return ok({
    workspace: workspaceName,
    commit: commitResult.data,
    filesChanged: Object.keys(body.files),
  });
});

app.post("/:name/merge", (c) => {
  return c.json(
    {
      error:
        "This endpoint is deprecated. Use POST /api/projects/:namespace/:slug/changes instead.",
    },
    410,
  );
});

// DELETE /workspaces/:name - Delete a workspace
app.delete("/:name", async (c) => {
  const logger = createLogger({
    requestId: crypto.randomUUID(),
    userId: c.get("userId"),
    path: c.req.path,
    method: c.req.method,
  });

  const userId = c.get("userId");
  const agentId = c.get("agentId");
  const agentOwnerId = c.get("agentOwnerId");
  if (!userId && !agentId) return unauthorized("Authentication required");

  const { name: workspaceName } = c.req.param();

  // S7 (#130): same identifier-shape validation as the commit route, before
  // the values reach a KV key.
  if (!isValidSlug(workspaceName)) return badRequest("invalid workspace name");

  const projectId = c.req.query("projectId");
  if (!projectId) {
    return badRequest("projectId query parameter is required");
  }
  if (!isValidUuid(projectId)) return badRequest("projectId must be a UUID");

  const workspaceResult = await getWorkspace(c.env.STATE, projectId, workspaceName, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code === "NOT_FOUND") {
      return notFound("Workspace", workspaceName);
    }
    // S5 (#130): same 404-on-unreadable rule as the commit route.
    logger.error("Failed to get workspace", workspaceResult.error);
    return notFound("Workspace", workspaceName);
  }
  const workspace = workspaceResult.data;

  // Authorization: same rule as commit — resolve the project from the workspace's
  // authoritative parent id and require project-write AND workspace-write (creator
  // or admin). Failures collapse to a 404 (no leak of existence/ownership).
  const projectResult = await getProjectById(c.env.STATE, workspace.parent, logger);
  if (!projectResult.success) {
    if (projectResult.error.code === "NOT_FOUND") return notFound("Workspace", workspaceName);
    // Same 404-on-unreadable rule as the commit route.
    logger.error("Failed to resolve project for delete authz", projectResult.error);
    return notFound("Workspace", workspaceName);
  }
  const project = projectResult.data;

  const canWriteProj = await canWriteProject(
    c.env.DB,
    project,
    credentialBindingFrom(c),
    userId,
    agentOwnerId,
  );
  const canWriteWs = await canWriteWorkspace(
    c.env.DB,
    project,
    workspace,
    credentialBindingFrom(c),
    userId,
    agentOwnerId,
  );
  if (!canWriteProj || !canWriteWs) {
    logger.warn("Delete denied — insufficient workspace write access", {
      workspaceName,
      projectId: project.id,
    });
    return notFound("Workspace", workspaceName);
  }

  // Delete the Artifacts fork by its remote-derived repo name (the workspace name
  // is NOT the Artifacts repo id). If the remote isn't a recognizable Artifacts
  // host, skip the delete rather than blindly deleting a bare name.
  const artifactsRepoName = artifactsRepoNameFromRemote(workspace.remote);
  if (artifactsRepoName) {
    await c.env.ARTIFACTS.delete(artifactsRepoName).catch((err: unknown) => {
      logger.warn(`[workspaces] Failed to delete Artifacts repo "${artifactsRepoName}"`, {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } else {
    logger.warn("[workspaces] Skipping Artifacts delete — remote is not an Artifacts host", {
      workspaceName,
      remote: workspace.remote,
    });
  }

  const deleteResult = await deleteWorkspace(c.env.STATE, projectId, workspaceName, logger);
  if (!deleteResult.success) {
    logger.error("Failed to delete workspace", deleteResult.error);
    return internalError("Internal error");
  }

  logger.info("Workspace deleted", { workspaceName, projectId });
  return ok({ deleted: true, workspace: workspaceName });
});

export { app as workspacesRouter };
