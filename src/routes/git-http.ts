import { Hono } from "hono";
import { type EventActor, emitEvent } from "../queue/events";
import { createChangeWithEvaluation, createWorkspaceFork } from "../services/change-flow";
import { getAgentByToken } from "../storage/agents";
import { resolveApiToken } from "../storage/api-tokens";
import { updateChangeStatus } from "../storage/changes";
import { isTargetDeleting } from "../storage/deletion";
import {
  artifactsRepoNameFromRemote,
  extractTokenSecret,
  freshRepoToken,
} from "../storage/git-ops";
import { deleteWorkspace, getProjectByPath, getWorkspace } from "../storage/state";
import { getUser, getUserByToken } from "../storage/users";
import {
  WORKSPACE_GIT_TOKEN_PREFIX,
  resolveWorkspaceGitCredential,
} from "../storage/workspace-git-credentials";
import type { ApiTokenScope, CredentialBinding, Env, ProjectEntry, WorkspaceEntry } from "../types";
import { projectDefaultBranch } from "../types";
import { type AuthFailure, recordAuthFailure } from "../utils/auth-audit";
import {
  UNBOUND,
  bindingCoversProject,
  canReadProject,
  canWriteProject,
  canWriteWorkspace,
} from "../utils/authz";
import { RejectedCredentialError } from "../utils/errors";
import { getWaitUntil } from "../utils/execution-ctx";
import {
  ZERO_OID,
  buildReportStatus,
  checkWorkspacePushPolicy,
  parseReceivePackRequest,
  parseReportStatus,
  wantsSideband,
} from "../utils/git-protocol";
import { createLogger } from "../utils/logger";

/**
 * Git smart-HTTP proxy (ADR 005).
 *
 * Lets a Stratum project be used as a git remote. Two surfaces:
 *  - Project URL `/@ns/slug.git` — clone/fetch (read). A push to the default
 *    branch is routed through the change gate when GIT_PUSH_GATED_ENABLED
 *    (ADR 005 slice 2b): pack lands on a server-managed workspace fork, a
 *    change is created + evaluated, and the client gets a truthful per-ref
 *    `ng` carrying the change id (main only moves through the merge gate).
 *    With the flag off — and for multi-ref/delete/non-default pushes — the
 *    push is refused in-protocol with sideband guidance. Refs are proxied
 *    unfiltered on the read path, so refs/tags/* are advertised and fetchable;
 *    tag pushes to the project remote are refused with tag-specific guidance
 *    (#182 — the change gate cannot represent a tag).
 *  - Workspace URL `/@ns/slug/workspaces/<ws>.git` — clone/fetch (read) AND
 *    `git push` (write), proxied to the workspace's Artifacts fork. The push's
 *    command list is parsed first and held to a ref policy (S3, #130): only
 *    the fork's working branch may be updated and ref deletion is refused;
 *    a passing pack is then forwarded unmodified. The client clones the
 *    workspace, so ref/old-oid semantics line up and Artifacts' own
 *    report-status is the truthful outcome for forwarded pushes.
 *
 * The router authenticates with the existing API-key system over HTTP Basic,
 * authorizes the caller, mints a short-lived Cloudflare Artifacts token (read or
 * write), and proxies upstream. The Artifacts token never leaves the Worker.
 */

// Cap on a buffered push/clone request body. Enforced while reading so an
// oversized (or unauthorized, pre-auth) request can't force us to buffer it all.
const MAX_GIT_BODY_BYTES = 50 * 1024 * 1024;

/**
 * Whether a request path belongs to the git smart-HTTP surface. The global
 * `authMiddleware` (Bearer-only) would otherwise reject git's Basic-auth
 * requests before this router runs, so the middlewares consult this to step
 * aside and let the router own auth.
 *
 * Anchored to the exact project (`/<ns>/<slug>/<suffix>`) and workspace
 * (`/<ns>/<slug>/workspaces/<ws>/<suffix>`) shapes — a bare `endsWith` would
 * also exempt unrelated routes whose path merely ends in the suffix (e.g. the UI
 * `…/blob/<file>/info/refs`), stripping auth/CSRF/rate-limit from them.
 */
const GIT_HTTP_PATH =
  /^\/[^/]+\/[^/]+(?:\/workspaces\/[^/]+)?\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

export function isGitHttpPath(path: string): boolean {
  return GIT_HTTP_PATH.test(path);
}

const UPLOAD_PACK = "git-upload-pack";
const RECEIVE_PACK = "git-receive-pack";

// Response headers git expects on a smart-HTTP reply. We forward these verbatim
// from Artifacts and deliberately drop framing headers (Content-Length /
// Transfer-Encoding) so the runtime re-frames the re-streamed body, and never
// copy anything auth-related.
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-encoding",
  "cache-control",
  "pragma",
  "expires",
];

function authChallenge(): Response {
  return new Response("Authentication required\n", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Stratum"',
      "Content-Type": "text/plain",
    },
  });
}

// Identical response for "not found" and "found but unauthorized" so an
// authenticated caller cannot probe private-repo existence.
function gitNotFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
}

function upstreamError(): Response {
  return new Response("Upstream git error\n", {
    status: 502,
    headers: { "Content-Type": "text/plain" },
  });
}

function serverError(): Response {
  return new Response("Internal error\n", {
    status: 500,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Extract a Stratum API key from an HTTP Basic header. git clients place the
 * credential in either field (`https://TOKEN@host` lands it in the username
 * with an empty password), so accept whichever field carries a recognized
 * prefix, preferring the password.
 */
function parseBasicToken(header: string | undefined): string | null {
  if (!header || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  const username = sep >= 0 ? decoded.slice(0, sep) : decoded;
  const password = sep >= 0 ? decoded.slice(sep + 1) : "";
  for (const candidate of [password, username]) {
    if (
      candidate.startsWith("stratum_user_") ||
      candidate.startsWith("stratum_agent_") ||
      candidate.startsWith(`${WORKSPACE_GIT_TOKEN_PREFIX}_`)
    ) {
      return candidate;
    }
  }
  return null;
}

interface Identity {
  userId?: string;
  agentId?: string;
  agentOwnerId?: string;
  /** What the authenticating API token may do (#254). Absent for an anonymous
   * caller and for an agent token, neither of which is scope-limited. */
  tokenScope?: ApiTokenScope;
  /** Which projects the credential may reach (#323). Required, so every branch
   * of `authenticate` has to say — `UNBOUND` for agents and the legacy key. */
  binding: CredentialBinding;
  /**
   * Set ONLY for a workspace git credential (#408): the one workspace it may
   * reach. `authorizeProject` refuses any identity carrying it, and
   * `authorizeWorkspace` refuses it on every workspace but this one, so the
   * restriction cannot be dropped by a route that forgets to look.
   */
  workspaceOnly?: WorkspaceRestriction;
}

interface WorkspaceRestriction {
  projectId: string;
  workspaceName: string;
  workspaceCreatedAt: string;
  /** The minting credential's binding, which must also cover the project. */
  parentBinding: CredentialBinding;
}

/** An anonymous caller has no credential, so nothing narrows it. */
function bindingOf(identity: Identity | null): CredentialBinding {
  return identity?.binding ?? UNBOUND;
}

/**
 * The subset of the Hono context the git auth path needs. `set` is optional so
 * the narrow stubs in tests keep type-checking; it is always present on a real
 * request.
 */
interface GitAuthContext {
  req: { header(name: string): string | undefined };
  env: Env;
  set?: (key: "telemetryOptOut", value: boolean) => void;
}

/**
 * Audit a git credential that identified an account but was refused (#255).
 * `authenticate` promises never to 500, so a failed audit is swallowed here
 * (recordAudit has already logged it).
 */
async function auditGitAuthFailure(
  db: D1Database,
  logger: ReturnType<typeof createLogger>,
  failure: AuthFailure,
): Promise<void> {
  try {
    await recordAuthFailure(db, logger, { ...failure, detail: { ...failure.detail, via: "git" } });
  } catch (error) {
    logger.warn("Failed to audit git authentication failure", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Resolve the caller's identity from Basic credentials. Returns `null` for
 * anonymous *or* unrecognized/invalid credentials — both collapse to "no
 * identity" for the access truth table, never a 500.
 *
 * Also publishes the caller's telemetry preference (#257) into the context.
 * This router owns its own auth — `authMiddleware` steps aside for git paths —
 * so without this, `analyticsMiddleware` would keep exporting an `api_request`
 * for every clone, fetch, and push by a user who has opted out. The rows are
 * already loaded here for the deleting-account checks.
 */
async function authenticate(
  c: GitAuthContext,
  logger: ReturnType<typeof createLogger>,
): Promise<Identity | null> {
  const token = parseBasicToken(c.req.header("Authorization"));
  if (!token) return null;

  if (token.startsWith(`${WORKSPACE_GIT_TOKEN_PREFIX}_`)) {
    const resolved = await resolveWorkspaceGitCredential(c.env.DB, token, logger);
    if (!resolved.success) {
      if (resolved.error instanceof RejectedCredentialError) {
        await auditGitAuthFailure(c.env.DB, logger, {
          method: "workspace_git_token",
          reason: resolved.error.reason,
          actorType: "user",
          actorId: resolved.error.userId,
          subject: resolved.error.credentialId,
        });
      }
      return null;
    }
    const credential = resolved.data;
    c.set?.("telemetryOptOut", credential.user.telemetryOptOut === true);
    const restriction: WorkspaceRestriction = {
      projectId: credential.projectId,
      workspaceName: credential.workspaceName,
      workspaceCreatedAt: credential.workspaceCreatedAt,
      parentBinding: credential.parentBinding,
    };
    const binding: CredentialBinding = { kind: "project", projectId: credential.projectId };
    // Minted by an agent: act as that agent again, so workspace ownership and
    // provenance read exactly as they would for the agent's own token.
    if (credential.agentId !== undefined) {
      return {
        agentId: credential.agentId,
        agentOwnerId: credential.user.id,
        binding,
        workspaceOnly: restriction,
      };
    }
    return {
      userId: credential.user.id,
      tokenScope: "read_write",
      binding,
      workspaceOnly: restriction,
    };
  }

  if (token.startsWith("stratum_user_")) {
    // Scoped tokens first, then the legacy credential — the same order and the
    // same reasoning as `authMiddleware`. A scoped token that resolves is
    // answered here; a miss or a storage failure falls through to the legacy
    // lookup, which the caller still has to satisfy on its own hash.
    const scoped = await resolveApiToken(c.env.DB, token, logger);
    if (scoped.success) {
      c.set?.("telemetryOptOut", scoped.data.user.telemetryOptOut === true);
      return {
        userId: scoped.data.user.id,
        tokenScope: scoped.data.scope,
        binding: scoped.data.binding,
      };
    }
    if (scoped.error instanceof RejectedCredentialError) {
      await auditGitAuthFailure(c.env.DB, logger, {
        method: "api_token",
        reason: scoped.error.reason,
        actorType: "user",
        actorId: scoped.error.userId,
        subject: scoped.error.credentialId,
      });
    }
    const result = await getUserByToken(c.env.DB, token, logger);
    // A soft-deleting or disabled account's credentials stop working
    // immediately over git too — the HTTP middleware rejects them, but git
    // smart-HTTP owns its own auth and must apply the same gate, or a
    // deprovisioned user keeps clone/push access to private code.
    if (!result.success) return null;
    if (result.data.deletingAt || result.data.disabledAt) {
      await auditGitAuthFailure(c.env.DB, logger, {
        method: "legacy_token",
        reason: result.data.deletingAt ? "owner-deleting" : "owner-disabled",
        actorType: "user",
        actorId: result.data.id,
        subject: result.data.id,
      });
      return null;
    }
    c.set?.("telemetryOptOut", result.data.telemetryOptOut === true);
    // The legacy credential predates scopes and carries full account power.
    return { userId: result.data.id, tokenScope: "read_write", binding: UNBOUND };
  }
  const result = await getAgentByToken(c.env.DB, token, logger);
  if (!result.success) return null;
  // An agent inherits its owner's access, so a deleting or disabled owner's
  // agent must stop working too — otherwise it's an authenticated git write
  // channel that outlives the account's access. Fail CLOSED on the owner
  // lookup: an unresolved, deleting, or disabled owner yields no identity.
  // getUser can reject on a D1 error, which would otherwise escape
  // authenticate's documented no-500 contract, so catch it.
  let owner: Awaited<ReturnType<typeof getUser>>;
  try {
    owner = await getUser(c.env.DB, result.data.ownerId, logger);
  } catch (err) {
    logger.warn("Agent owner lookup threw during git auth; failing closed", {
      ownerId: result.data.ownerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!owner.success || owner.data.deletingAt || owner.data.disabledAt) {
    await auditGitAuthFailure(c.env.DB, logger, {
      method: "agent_token",
      reason: !owner.success
        ? "owner-missing"
        : owner.data.deletingAt
          ? "owner-deleting"
          : "owner-disabled",
      actorType: "agent",
      actorId: result.data.id,
      subject: result.data.id,
      detail: { ownerId: result.data.ownerId },
    });
    return null;
  }
  // An agent's git traffic inherits its owner's telemetry choice, matching the
  // way it inherits the owner's access.
  c.set?.("telemetryOptOut", owner.data.telemetryOptOut === true);
  return { agentId: result.data.id, agentOwnerId: result.data.ownerId, binding: UNBOUND };
}

function basicAuthHeader(artifactsToken: string): string {
  return `Basic ${btoa(`x:${extractTokenSecret(artifactsToken)}`)}`;
}

/**
 * Proxy a smart-HTTP request to an Artifacts remote with a freshly minted token
 * (read for clone/fetch, write for push). The caller passes a pre-buffered body
 * (Workers silently drop streamed outbound bodies — see `git-ops.ts`); the
 * response body is streamed back. `remote` must already be validated as an
 * Artifacts host (`freshRepoToken` re-derives the repo name and refuses
 * otherwise, so the write token is never minted against a foreign host).
 */
async function proxyUpstream(
  c: { req: { header(name: string): string | undefined }; env: Env },
  remote: string,
  scope: "read" | "write",
  upstreamUrl: string,
  method: "GET" | "POST",
  body: ArrayBuffer | undefined,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const tokenResult = await freshRepoToken(c.env.ARTIFACTS, remote, scope, logger);
  if (!tokenResult.success) {
    logger.error("Failed to mint Artifacts token for git proxy", tokenResult.error);
    return upstreamError();
  }

  const headers: Record<string, string> = { Authorization: basicAuthHeader(tokenResult.data) };
  // Forward the bits of the request that affect protocol negotiation. Never
  // forward the inbound Authorization — it is replaced by the Artifacts token.
  for (const name of ["Git-Protocol", "Content-Type", "Content-Encoding"]) {
    const value = c.req.header(name);
    if (value) headers[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method, headers, body, redirect: "manual" });
  } catch (error) {
    logger.error("Git upstream fetch failed", error instanceof Error ? error : undefined, {
      upstreamUrl,
      method,
    });
    return upstreamError();
  }

  // Only a clean 2xx is streamed through. A redirect (manual) or upstream error
  // is failed closed — never follow a redirect carrying the Artifacts token.
  if (upstream.status < 200 || upstream.status >= 300) {
    logger.error("Git upstream returned non-2xx", undefined, {
      upstreamUrl,
      status: upstream.status,
    });
    return upstreamError();
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: 200, headers: responseHeaders });
}

/**
 * Guidance streamed to a pushing client (as `remote:` lines) when its push to
 * the project URL cannot be gated (flag off, multi-ref, delete, non-default
 * ref). The refusal happens in-protocol so `git push` fails legibly instead of
 * with an opaque HTTP error.
 */
function pushGuidance(namespace: string, slug: string): string[] {
  return [
    "Pushes to a project's protected refs are gated by Stratum's change flow.",
    `Push to a workspace remote instead: /${namespace}/${slug}/workspaces/<ws>.git`,
    "then open a change (stratum change create) to run evaluations and merge.",
  ];
}

/** Strip a trailing `.git` so both `/@ns/slug.git` and `/@ns/slug` resolve. */
function normalizeSlug(slug: string): string {
  return slug.endsWith(".git") ? slug.slice(0, -".git".length) : slug;
}

/**
 * Resolve + authorize a project for a read (clone/fetch) or write (push),
 * applying the no-leak truth table. Returns the project on success, or a
 * `Response` to return as-is.
 */
/**
 * Refuses a read-only API token on a write-scoped git request (#254).
 *
 * Keyed on the SCOPE the caller already resolved, not on the request path — and
 * that distinction is the whole point. `GET /info/refs?service=git-receive-pack`
 * is a *write*: it authorizes with `canWriteProject` and proxies with a
 * write-scoped Artifacts token, so a path rule that allowed "info/refs" would
 * hand a read-only token a write authorization and a minted write credential.
 *
 * Checking the resolved scope instead covers all four write entry points in this
 * router — project and workspace `git-receive-pack`, and both of their
 * advertisements — and a fifth added later inherits it for free.
 *
 * The refusal is `gitNotFound`, matching every other authorization failure here:
 * a token that cannot write must not be able to distinguish "no permission" from
 * "no such repository" any more than an unauthorized user can.
 */
function refuseReadOnlyToken(
  scope: "read" | "write",
  identity: Identity | null,
  logger: ReturnType<typeof createLogger>,
): Response | null {
  if (scope !== "write" || identity?.tokenScope !== "read") return null;
  logger.warn("Refusing write git request from a read-only token", { userId: identity.userId });
  return gitNotFound();
}

async function authorizeProject(
  c: GitAuthContext & { req: { param(name: string): string } },
  scope: "read" | "write",
  logger: ReturnType<typeof createLogger>,
): Promise<{ project: ProjectEntry; identity: Identity | null } | Response> {
  const namespace = c.req.param("namespace");
  const slug = normalizeSlug(c.req.param("slug"));

  const identity = await authenticate(c, logger);
  const isAnonymous = identity === null;

  // A workspace git credential (#408) reaches its workspace URL and nothing
  // else — not even a public project's clone.
  if (identity?.workspaceOnly !== undefined) {
    logger.warn("Refusing workspace git credential on a project URL", { namespace, slug });
    return gitNotFound();
  }

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    // Only a genuine miss enters the truth table. A KV outage or corrupt entry
    // (5xx) must surface as an error, not a bogus auth/404 that loops the client
    // through credential retries.
    if (projectResult.error.code !== "NOT_FOUND") {
      logger.error("Project lookup failed for git request", projectResult.error);
      return serverError();
    }
    // Missing repo: challenge the anonymous caller (so git retries with creds),
    // 404 the authenticated one — neither path reveals existence.
    return isAnonymous ? authChallenge() : gitNotFound();
  }

  const project = projectResult.data;
  const allowed =
    scope === "write"
      ? await canWriteProject(
          c.env.DB,
          project,
          bindingOf(identity),
          identity?.userId,
          identity?.agentOwnerId,
        )
      : await canReadProject(
          c.env.DB,
          project,
          bindingOf(identity),
          identity?.userId,
          identity?.agentOwnerId,
        );
  if (!allowed) {
    return isAnonymous ? authChallenge() : gitNotFound();
  }
  const scopeRefusal = refuseReadOnlyToken(scope, identity, logger);
  if (scopeRefusal) return scopeRefusal;

  if (!artifactsRepoNameFromRemote(project.remote)) {
    logger.warn("Git proxy requested for non-Artifacts remote", {
      namespace,
      slug,
      project: project.id,
    });
    return gitUnavailable("project");
  }

  return { project, identity };
}

const gitUnavailable = (resource: "project" | "workspace"): Response =>
  new Response(`git protocol is not available for this ${resource}\n`, {
    status: 501,
    headers: { "Content-Type": "text/plain" },
  });

/**
 * Resolve + authorize a workspace for clone/fetch (read) or push (write),
 * applying the same no-leak truth table as `authorizeProject`. Returns the
 * workspace's Artifacts remote on success, or a `Response` to return as-is.
 */
async function authorizeWorkspace(
  c: GitAuthContext & { req: { param(name: string): string } },
  scope: "read" | "write",
  logger: ReturnType<typeof createLogger>,
): Promise<{ remote: string; workspace: WorkspaceEntry; project: ProjectEntry } | Response> {
  const namespace = c.req.param("namespace");
  const slug = normalizeSlug(c.req.param("slug"));
  const workspaceName = normalizeSlug(c.req.param("workspace"));

  const identity = await authenticate(c, logger);
  const isAnonymous = identity === null;

  const projectResult = await getProjectByPath(c.env.STATE, namespace, slug, logger);
  if (!projectResult.success) {
    if (projectResult.error.code !== "NOT_FOUND") {
      logger.error("Project lookup failed for workspace git request", projectResult.error);
      return serverError();
    }
    return isAnonymous ? authChallenge() : gitNotFound();
  }
  const project = projectResult.data;

  const restriction = identity?.workspaceOnly;
  if (
    restriction !== undefined &&
    (project.id !== restriction.projectId ||
      !bindingCoversProject(restriction.parentBinding, project))
  ) {
    logger.warn("Refusing workspace git credential outside its project", { namespace, slug });
    return gitNotFound();
  }

  const allowed =
    scope === "write"
      ? await canWriteProject(
          c.env.DB,
          project,
          bindingOf(identity),
          identity?.userId,
          identity?.agentOwnerId,
        )
      : await canReadProject(
          c.env.DB,
          project,
          bindingOf(identity),
          identity?.userId,
          identity?.agentOwnerId,
        );
  if (!allowed) return isAnonymous ? authChallenge() : gitNotFound();
  const scopeRefusal = refuseReadOnlyToken(scope, identity, logger);
  if (scopeRefusal) return scopeRefusal;

  const workspaceResult = await getWorkspace(c.env.STATE, project.id, workspaceName, logger);
  if (!workspaceResult.success) {
    if (workspaceResult.error.code !== "NOT_FOUND") {
      logger.error("Workspace lookup failed for git request", workspaceResult.error);
      return serverError();
    }
    // A missing workspace is indistinguishable from unauthorized — no leak.
    return isAnonymous ? authChallenge() : gitNotFound();
  }
  const workspace = workspaceResult.data;

  // Same name is not enough: a workspace deleted and re-created under it is a
  // different workspace, and the credential must not follow the name.
  if (
    restriction !== undefined &&
    (workspace.name !== restriction.workspaceName ||
      workspace.createdAt !== restriction.workspaceCreatedAt)
  ) {
    logger.warn("Refusing workspace git credential on another workspace", {
      projectId: project.id,
      workspace: workspaceName,
    });
    return gitNotFound();
  }

  // Project-level write is necessary but not sufficient: a workspace fork is
  // owned by its creator, so a project-writer who did not create it must be
  // refused (only the creator or a project admin may push). Same no-leak
  // response as unauthorized so ownership isn't revealed. Read/clone is
  // unaffected — canReadProject already gated it above.
  if (scope === "write") {
    const canWrite = await canWriteWorkspace(
      c.env.DB,
      project,
      workspace,
      bindingOf(identity),
      identity?.userId,
      identity?.agentOwnerId,
    );
    if (!canWrite) return isAnonymous ? authChallenge() : gitNotFound();
  }

  // Validate the host before a (possibly write-scoped) token is minted against it.
  if (!artifactsRepoNameFromRemote(workspace.remote)) {
    logger.warn("Workspace git proxy requested for non-Artifacts remote", {
      namespace,
      slug,
      workspace: workspaceName,
      project: project.id,
    });
    return gitUnavailable("workspace");
  }

  return { remote: workspace.remote, workspace, project };
}

/**
 * Read a request body into memory, enforcing `MAX_GIT_BODY_BYTES` *while
 * reading* (not a post-hoc length check) so an oversized push is aborted before
 * it is fully buffered. Returns the buffer, or a `413` Response.
 */
async function readCappedBody(
  c: { req: { raw: Request } },
  logger: ReturnType<typeof createLogger>,
): Promise<ArrayBuffer | Response> {
  const stream = c.req.raw.body;
  if (!stream) return new ArrayBuffer(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_GIT_BODY_BYTES) {
      await reader.cancel();
      logger.warn("git request body exceeds cap", { cap: MAX_GIT_BODY_BYTES });
      return new Response("git request too large\n", {
        status: 413,
        headers: { "Content-Type": "text/plain" },
      });
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

// The command section of a receive-pack request is one small pkt-line per ref.
// When the body arrives compressed, only this bounded prefix is inflated to
// read the commands (the pack that follows is never inflated), so a
// decompression bomb cannot balloon memory here.
const MAX_COMMAND_SECTION_BYTES = 1024 * 1024;

/**
 * The formats DecompressionStream accepts here. Declared locally: the Workers
 * type surface does not export a name for it.
 */
type DecompressFormat = "gzip" | "deflate" | "deflate-raw";

/**
 * The bytes the receive-pack command list is parsed from: the body itself when
 * it is plain, or a bounded inflated prefix when the client sent
 * `Content-Encoding: gzip|deflate` (git can compress request bodies; the proxy
 * forwards them upstream still compressed). Returns `null` when the body
 * cannot be inspected (unknown encoding, corrupt stream) — the caller MUST
 * fail closed, because forwarding an uninspected body would let a compressed
 * command list bypass the ref policy.
 */
async function commandSectionBytes(
  body: ArrayBuffer,
  contentEncoding: string | undefined,
): Promise<Uint8Array | null> {
  const encoding = contentEncoding?.trim().toLowerCase();
  // Cap the uncompressed path too. The compressed branch below stops inflating
  // at MAX_COMMAND_SECTION_BYTES, so returning the whole body here left the
  // budget enforced for gzip/deflate senders and unenforced for everyone else.
  // Truncation is safe for the same reason it is safe there: the command
  // section ends at the flush-pkt, the parser reads no further, and the
  // ORIGINAL bytes are what gets forwarded upstream — this view is inspection
  // only.
  if (!encoding || encoding === "identity") {
    return new Uint8Array(body, 0, Math.min(body.byteLength, MAX_COMMAND_SECTION_BYTES));
  }
  if (encoding !== "gzip" && encoding !== "x-gzip" && encoding !== "deflate") return null;

  // `Content-Encoding: deflate` is defined as zlib-wrapped (RFC 9110), but real
  // clients also send RAW deflate under that name. DecompressionStream("deflate")
  // rejects the raw form outright, and this helper fails closed, so a legitimate
  // push from such a client was refused as unreadable. Try the wrapped format
  // first (the spec-correct one), then the raw one.
  const formats: DecompressFormat[] =
    encoding === "deflate" ? ["deflate", "deflate-raw"] : ["gzip"];
  for (const format of formats) {
    const inflated = await inflateBounded(body, format);
    if (inflated) return inflated;
  }
  return null;
}

/**
 * Inflate at most `MAX_COMMAND_SECTION_BYTES` of `body` under one format, or
 * `null` if the stream is not that format. Each attempt builds its own stream:
 * a ReadableStream is single-use, so a retry cannot reuse the failed one.
 */
async function inflateBounded(
  body: ArrayBuffer,
  format: DecompressFormat,
): Promise<Uint8Array | null> {
  try {
    // A ReadableStream over the existing buffer, not `new Blob([body]).stream()`
    // — the Blob constructor COPIES, so inspecting a 50 MiB push cost a second
    // 50 MiB. This route exists to bound request resource use; allocating a
    // full duplicate to enforce that bound defeats the point.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    });
    const stream = source.pipeThrough(new DecompressionStream(format));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_COMMAND_SECTION_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    // Stop inflating once the (generous) command-section budget is read; the
    // parser only consumes up to the flush-pkt anyway.
    await reader.cancel().catch(() => {});
    const out = new Uint8Array(Math.min(total, MAX_COMMAND_SECTION_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= out.byteLength) break;
      // Advance by what was actually copied, not the chunk's full length. The
      // two only differ on the final, truncated chunk — after which the loop
      // exits — so the emitted bytes were already correct either way. Keeping
      // `offset` equal to "bytes written" makes that an invariant rather than
      // something that happens to hold because of the break.
      const copied = Math.min(chunk.byteLength, out.byteLength - offset);
      out.set(chunk.subarray(0, copied), offset);
      offset += copied;
    }
    return out;
  } catch {
    return null;
  }
}

function malformedPush(message: string): Response {
  return new Response(`${message}\n`, {
    status: 400,
    headers: { "Content-Type": "text/plain" },
  });
}

export const gitHttpRouter = new Hono<{ Bindings: Env }>();

// GET /@:namespace/:slug.git/info/refs?service=git-(upload|receive)-pack
gitHttpRouter.get("/:namespace/:slug/info/refs", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: "GET" });
  const service = c.req.query("service");
  const scope = service === RECEIVE_PACK ? "write" : service === UPLOAD_PACK ? "read" : null;
  if (!scope) {
    return new Response("unsupported git service\n", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // The receive-pack advertisement is proxied (write-authorized) so `git push`
  // proceeds to the RPC below, where the outcome is delivered in-protocol
  // instead of as an opaque HTTP error at the advertise step.
  const result = await authorizeProject(c, scope, logger);
  if (result instanceof Response) return result;

  const upstreamUrl = `${result.project.remote}/info/refs?service=${service}`;
  return proxyUpstream(c, result.project.remote, scope, upstreamUrl, "GET", undefined, logger);
});

// POST /@:namespace/:slug.git/git-upload-pack — clone/fetch RPC
gitHttpRouter.post("/:namespace/:slug/git-upload-pack", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: "POST" });
  const result = await authorizeProject(c, "read", logger);
  if (result instanceof Response) return result;

  const body = await readCappedBody(c, logger);
  if (body instanceof Response) return body;
  const upstreamUrl = `${result.project.remote}/${UPLOAD_PACK}`;
  return proxyUpstream(c, result.project.remote, "read", upstreamUrl, "POST", body, logger);
});

/** The report-status Content-Type git expects on the receive-pack reply. */
function receivePackResult(body: Uint8Array): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-git-receive-pack-result" },
  });
}

/**
 * Forward a buffered receive-pack request to a workspace fork's remote and
 * return the buffered upstream result, or null on transport failure. The
 * response is buffered (not streamed) because the gated flow must inspect the
 * outcome before deciding what to tell the client.
 */
async function forwardPackToWorkspace(
  c: { req: { header(name: string): string | undefined }; env: Env },
  workspaceRemote: string,
  body: ArrayBuffer,
  logger: ReturnType<typeof createLogger>,
): Promise<{ ok: boolean; landed: boolean; body: Uint8Array } | null> {
  const tokenResult = await freshRepoToken(c.env.ARTIFACTS, workspaceRemote, "write", logger);
  if (!tokenResult.success) {
    logger.error("Failed to mint Artifacts token for gated push", tokenResult.error);
    return null;
  }
  const headers: Record<string, string> = { Authorization: basicAuthHeader(tokenResult.data) };
  for (const name of ["Git-Protocol", "Content-Type", "Content-Encoding"]) {
    const value = c.req.header(name);
    if (value) headers[name] = value;
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${workspaceRemote}/${RECEIVE_PACK}`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
  } catch (error) {
    logger.error("Gated push upstream fetch failed", error instanceof Error ? error : undefined);
    return null;
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    logger.error("Gated push upstream returned non-2xx", undefined, { status: upstream.status });
    return null;
  }
  const responseBody = new Uint8Array(await upstream.arrayBuffer());
  // Parse the report-status properly rather than substring-scanning the body:
  // sideband progress text ("Counting objects…", or anything containing "ng ")
  // is not a ref verdict, and misreading it would tell the pusher their pack
  // failed after it had already landed. An unparseable reply fails closed.
  const report = parseReportStatus(responseBody);
  if (!report.success) {
    logger.error("Gated push: unparseable workspace report-status", report.error);
    // HTTP 200 means Artifacts processed the request, so the pack may already
    // be in the fork even though the verdict is unreadable. Fail closed on
    // success, but flag the outcome as "may have landed" so the caller never
    // treats it as a proven rejection and deletes the client's commits.
    return { ok: false, landed: true, body: responseBody };
  }
  const pushOk = report.data.unpack === "ok" && report.data.results.every((r) => r.ok);
  // A parsed `ng`/failed-unpack proves the ref never moved, so the fork holds
  // nothing of the client's; only then is `landed` false.
  return { ok: pushOk, landed: pushOk, body: responseBody };
}

/**
 * Best-effort teardown of the server-managed fork when a gated push ends
 * without a change anyone can act on -- it died before the change existed, or
 * the change gate rejected it permanently. Nothing owner-visible depends on
 * the workspace in either case, so leaving it would leak an Artifacts repo +
 * KV entry per failed push, once per retry. Failures are logged with enough
 * coordinates to find the orphan by hand.
 */
async function cleanupPushWorkspace(
  env: Env,
  projectId: string,
  workspaceName: string,
  remote: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const repoName = artifactsRepoNameFromRemote(remote);
  if (repoName) {
    await env.ARTIFACTS.delete(repoName).catch((error: unknown) => {
      logger.warn("Gated push cleanup: could not delete Artifacts fork", {
        repoName,
        remote,
        workspaceName,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  const deleteResult = await deleteWorkspace(env.STATE, projectId, workspaceName, logger);
  if (!deleteResult.success) {
    logger.warn("Gated push cleanup: could not delete workspace entry", {
      workspaceName,
      projectId,
      error: deleteResult.error.message,
    });
  }
}

/**
 * Close the change a gated push created after the change gate has rejected it
 * for good.
 *
 * A deterministic rejection (submodule content, #258) is decided AFTER the
 * change row exists, and no retry can make that change pass -- so leaving it
 * `open` would put a change in the owner's queue that only ever wastes their
 * time, and every retried push would add another. It is closed as `rejected`
 * rather than deleted because the storage layer has no change-delete path and
 * because the refusal is worth keeping in the audit trail; the accompanying
 * `change.rejected` event keeps consumers that saw `change.created` from
 * tracking it as open forever.
 *
 * Every failure here is logged and swallowed: the pusher must still get the
 * protocol-level rejection, which is the part that actually protects them.
 */
async function closeRejectedChange(
  env: Env,
  logger: ReturnType<typeof createLogger>,
  args: {
    changeId: string;
    projectId: string;
    projectName: string;
    reason: string;
    actor: EventActor;
  },
): Promise<void> {
  const updateResult = await updateChangeStatus(env.DB, logger, args.changeId, "rejected", {
    evalPassed: false,
    evalReason: args.reason,
  });
  if (!updateResult.success) {
    logger.warn("Gated push cleanup: could not close the rejected change", {
      changeId: args.changeId,
      projectId: args.projectId,
      error: updateResult.error.message,
    });
    return;
  }
  await emitEvent(
    env.DB,
    env.EVENTS_QUEUE,
    { type: "change.rejected", project: args.projectName, changeId: args.changeId },
    args.actor,
    logger,
    args.projectId,
  );
}

// POST /@:namespace/:slug.git/git-receive-pack — push to the project ref.
//
// With GIT_PUSH_GATED_ENABLED, a single-ref push to the project's default
// branch is routed through the change gate (ADR 005 slice 2b): the pack lands
// on a fresh server-managed workspace fork, a change is created and evaluated,
// and the client gets a truthful per-ref `ng` — the default branch does NOT
// move until the change is approved and merged, so reporting `ok` would
// corrupt the client's remote-tracking ref. The change id and eval verdict
// stream back as sideband messages. Everything else (flag off, multi-ref,
// deletes, non-default refs) is refused in-protocol as before.
gitHttpRouter.post("/:namespace/:slug/git-receive-pack", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: "POST" });
  const result = await authorizeProject(c, "write", logger);
  if (result instanceof Response) return result;
  const { project, identity } = result;

  const body = await readCappedBody(c, logger);
  if (body instanceof Response) return body;

  const section = await commandSectionBytes(body, c.req.header("Content-Encoding"));
  if (section === null) {
    logger.warn("Unreadable receive-pack request body (encoding)");
    return malformedPush("unreadable git-receive-pack request body");
  }
  const parsed = parseReceivePackRequest(section);
  if (!parsed.success) {
    logger.warn("Malformed receive-pack request", { error: parsed.error.message });
    return malformedPush(parsed.error.message);
  }

  const { commands, capabilities } = parsed.data;
  const sideband = wantsSideband(capabilities);
  const namespace = c.req.param("namespace");
  const slug = normalizeSlug(c.req.param("slug"));

  const refuseAll = (reason: string, messages: string[]): Response =>
    receivePackResult(
      buildReportStatus({
        unpack: "ok",
        results: commands.map((cmd) => ({ ref: cmd.ref, ok: false, reason })),
        messages,
        sideband,
      }),
    );

  // Tag policy (#182): tag READS work everywhere — info/refs and upload-pack are
  // proxied unfiltered, so refs/tags/* are advertised and fetchable on both the
  // project and workspace remotes, and tag PUSHES to workspace forks proxy
  // verbatim. A tag push to the PROJECT remote, however, is refused explicitly:
  // the project repo's refs only move through Stratum's gates, and the change
  // gate cannot represent a tag (a change is an evaluated diff against the
  // default branch; a tag ref has nothing to evaluate or merge). Refusing with a
  // tag-specific reason beats the generic branch guidance, which would
  // misleadingly suggest the gate could carry the tag through.
  const tagRefs = commands.filter((cmd) => cmd.ref.startsWith("refs/tags/"));
  if (tagRefs.length > 0) {
    logger.info("Refusing project tag push in-protocol", {
      refs: tagRefs.map((cmd) => cmd.ref),
    });
    return refuseAll(
      "tag pushes to the project remote are not supported — push tags to a workspace remote",
      [
        "Project tags are read-only over this remote (clone/fetch delivers them).",
        `Push tags to a workspace remote instead: /${namespace}/${slug}/workspaces/<ws>.git`,
      ],
    );
  }

  const gatedEnabled = c.env.GIT_PUSH_GATED_ENABLED === "true";
  // Same default-branch resolution the merge/sync paths use — a repo imported
  // with a `master` or `trunk` default must gate pushes to THAT ref, not to a
  // literal refs/heads/main it doesn't have.
  const defaultBranch = projectDefaultBranch(project);
  const defaultRef = `refs/heads/${defaultBranch}`;
  const command = commands[0];
  const isGateablePush =
    gatedEnabled &&
    commands.length === 1 &&
    command !== undefined &&
    command.ref === defaultRef &&
    command.newOid !== ZERO_OID;

  if (!isGateablePush) {
    logger.info("Refusing project push in-protocol", {
      gatedEnabled,
      defaultRef,
      refs: commands.map((cmd) => cmd.ref),
    });
    return refuseAll(
      gatedEnabled
        ? `only a single push to ${defaultRef} can be gated — push other refs to a workspace remote`
        : "project pushes are gated — push to a workspace remote and open a change",
      pushGuidance(namespace, slug),
    );
  }

  if (await isTargetDeleting(c.env, project, logger)) {
    return refuseAll("project is being deleted", []);
  }

  // Land the pack on a fresh server-managed workspace fork. The fork's main is
  // at the project tip, so the client's old-oid (computed against the project
  // advertisement) lines up and Artifacts' own ref check stays truthful.
  // Full UUID: an 8-hex prefix is only 32 bits, and a name collision would
  // make setWorkspace overwrite an existing workspace entry with this fork.
  const workspaceName = `push-${crypto.randomUUID()}`;
  const actor = {
    ...(identity?.userId !== undefined ? { userId: identity.userId } : {}),
    ...(identity?.agentId !== undefined ? { agentId: identity.agentId } : {}),
    ...(identity?.agentOwnerId !== undefined ? { agentOwnerId: identity.agentOwnerId } : {}),
  };
  const forkResult = await createWorkspaceFork(c.env, logger, {
    project,
    workspaceName,
    actor,
  });
  if (!forkResult.success) {
    logger.error("Gated push could not fork workspace", forkResult.error);
    return refuseAll(`could not create workspace for push: ${forkResult.error.message}`, []);
  }

  // The service's returned name is authoritative from here on.
  const forkedName = forkResult.data.name;

  const forwarded = await forwardPackToWorkspace(c, forkResult.data.remote, body, logger);
  if (forwarded === null) {
    // No change exists yet, so the fresh fork has no owner-visible value —
    // tear it down rather than leaking one per failed push.
    await cleanupPushWorkspace(c.env, project.id, forkedName, forkResult.data.remote, logger);
    return refuseAll("upstream git error while landing the pack — try again", []);
  }
  if (!forwarded.ok) {
    logger.warn("Gated push rejected by workspace remote", { workspaceName: forkedName });
    if (forwarded.landed) {
      // Unknown outcome (HTTP 200, unreadable verdict): the pack may be in the
      // fork, so deleting it could destroy the client's commits. Preserve it
      // and log its coordinates for manual triage.
      logger.error("Gated push: unknown upstream outcome; preserving fork", undefined, {
        workspaceName: forkedName,
        remote: forkResult.data.remote,
        projectId: project.id,
      });
    } else {
      // A parsed rejection (non-fast-forward, corrupt pack, …) proves the ref
      // never moved — the empty fork can be torn down. The upstream's own
      // report-status is relayed verbatim below; the framing matches because
      // it negotiated the same capabilities we were sent.
      await cleanupPushWorkspace(c.env, project.id, forkedName, forkResult.data.remote, logger);
    }
    return receivePackResult(forwarded.body);
  }

  const outcome = await createChangeWithEvaluation(c.env, logger, {
    project,
    projectName: `${namespace}/${slug}`,
    workspaceName: forkedName,
    workspaceRemote: forkResult.data.remote,
    actor,
    waitUntil: getWaitUntil(c),
  });
  if (!outcome.success) {
    logger.error("Gated push change creation failed", outcome.error);
    // Submodules (#258) fail closed deterministically -- re-evaluating never
    // helps, unlike a transient diff/eval hiccup, so this gets its own
    // permanent-rejection message instead of the generic "re-evaluate it"
    // guidance below.
    if (outcome.error.code === "SUBMODULES_UNSUPPORTED") {
      // The change already exists by the time the scan runs (it is created
      // before the diff), so refusing without releasing it would leave an open
      // change, a workspace entry and an Artifacts fork behind on every retry.
      const rejectedChangeId = outcome.error.context?.changeId;
      if (typeof rejectedChangeId === "string") {
        await closeRejectedChange(c.env, logger, {
          changeId: rejectedChangeId,
          projectId: project.id,
          projectName: `${namespace}/${slug}`,
          reason: outcome.error.message,
          actor: identity?.agentId
            ? { type: "agent", id: identity.agentId }
            : { type: "user", ...(identity?.userId !== undefined ? { id: identity.userId } : {}) },
        });
      }
      await cleanupPushWorkspace(c.env, project.id, forkedName, forkResult.data.remote, logger);
      return refuseAll(`push rejected: ${outcome.error.message}`, [
        "Git submodules are not supported. Remove submodules (or flatten them into the repo) and push again.",
      ]);
    }
    // Post-creation failures carry the open change's id in the error context;
    // naming it steers the user to re-evaluate rather than open a duplicate.
    const stuckChangeId = outcome.error.context?.changeId;
    if (typeof stuckChangeId === "string") {
      return refuseAll(
        `change ${stuckChangeId} created but processing failed: ${outcome.error.message} — re-evaluate it in Stratum`,
        [
          `Change ${stuckChangeId} exists (workspace '${forkedName}') but evaluation/recording did not complete.`,
          `Re-run evaluation at /changes/${stuckChangeId} — do not open a duplicate change.`,
        ],
      );
    }
    return refuseAll(
      `pack landed in workspace ${forkedName} but change creation failed: ${outcome.error.message}`,
      [`Your commits are safe in workspace '${forkedName}' — open a change from it manually.`],
    );
  }

  // The gated push evaluates inline (no `queueRun`), so a verdict is always
  // here; the push's own response is how the pusher learns it (#412 keeps
  // this path synchronous — see ADR 009).
  if (outcome.data.mode !== "evaluated") {
    return refuseAll(`gated: change ${outcome.data.change.id} created — evaluation pending`, [
      `Review and merge: /changes/${outcome.data.change.id}`,
    ]);
  }
  const { change, evalResult } = outcome.data;
  logger.info("Gated push created change", {
    changeId: change.id,
    workspaceName: forkedName,
    evalPassed: evalResult.passed,
  });
  return refuseAll(
    `gated: change ${change.id} created (eval ${evalResult.passed ? "passed" : "failed"}) — review and merge in Stratum`,
    [
      `Change ${change.id} created from this push (workspace '${forkedName}').`,
      `Evaluation ${evalResult.passed ? "PASSED" : "FAILED"}: ${evalResult.reason}`,
      `Review and merge: /changes/${change.id}`,
      `'${defaultBranch}' is updated by the merge gate, not the push — your local branch is unchanged.`,
    ],
  );
});

// ── Workspace URLs: /@:namespace/:slug/workspaces/:workspace.git ─────────────
// Clone/fetch (read) and push (write), proxied verbatim to the workspace fork.

gitHttpRouter.get("/:namespace/:slug/workspaces/:workspace/info/refs", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: "GET" });
  const service = c.req.query("service");
  const scope = service === RECEIVE_PACK ? "write" : service === UPLOAD_PACK ? "read" : null;
  if (!scope) {
    return new Response("unsupported git service\n", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const result = await authorizeWorkspace(c, scope, logger);
  if (result instanceof Response) return result;

  const upstreamUrl = `${result.remote}/info/refs?service=${service}`;
  return proxyUpstream(c, result.remote, scope, upstreamUrl, "GET", undefined, logger);
});

gitHttpRouter.post("/:namespace/:slug/workspaces/:workspace/git-upload-pack", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: "POST" });
  const result = await authorizeWorkspace(c, "read", logger);
  if (result instanceof Response) return result;

  const body = await readCappedBody(c, logger);
  if (body instanceof Response) return body;
  const upstreamUrl = `${result.remote}/${UPLOAD_PACK}`;
  return proxyUpstream(c, result.remote, "read", upstreamUrl, "POST", body, logger);
});

gitHttpRouter.post("/:namespace/:slug/workspaces/:workspace/git-receive-pack", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: "POST" });
  // Authorize for write BEFORE reading the body so an unauthorized caller can't
  // force us to buffer the whole pack.
  const result = await authorizeWorkspace(c, "write", logger);
  if (result instanceof Response) return result;

  const body = await readCappedBody(c, logger);
  if (body instanceof Response) return body;

  // S3 (#130): inspect the client's ref-update commands BEFORE anything is
  // forwarded — the proxy previously relayed the body verbatim, letting the
  // fork's owner delete refs or push arbitrary refs/*. An empty body carries
  // no commands (nothing to police) and is proxied as before; anything else
  // must parse, pass the ref policy, or be refused without touching upstream.
  if (body.byteLength > 0) {
    const section = await commandSectionBytes(body, c.req.header("Content-Encoding"));
    if (section === null) {
      logger.warn("Unreadable workspace receive-pack body (encoding)");
      return malformedPush("unreadable git-receive-pack request body");
    }
    const parsed = parseReceivePackRequest(section);
    if (!parsed.success) {
      logger.warn("Malformed workspace receive-pack request", { error: parsed.error.message });
      return malformedPush(parsed.error.message);
    }

    const branch = result.workspace.branchName || result.workspace.name;
    // The fork's working branch is the PROJECT's default, not necessarily
    // `main` — an imported project keeps its source default (master/trunk/...).
    const verdict = checkWorkspacePushPolicy(
      parsed.data.commands,
      branch,
      projectDefaultBranch(result.project),
    );
    if (!verdict.allowed) {
      logger.warn("Workspace push refused by ref policy", {
        ref: verdict.ref,
        reason: verdict.reason,
      });
      // In-protocol refusal (same shape as the gated project path): per-ref ng
      // so `git push` fails legibly, and the pack is never forwarded.
      return receivePackResult(
        buildReportStatus({
          unpack: "ok",
          results: parsed.data.commands.map((cmd) => ({
            ref: cmd.ref,
            ok: false,
            reason: verdict.reason,
          })),
          messages: [
            `Refused: ${verdict.reason} (ref ${verdict.ref}).`,
            "A workspace remote accepts updates to its working branch only.",
          ],
          sideband: wantsSideband(parsed.data.capabilities),
        }),
      );
    }
  }

  const upstreamUrl = `${result.remote}/${RECEIVE_PACK}`;
  return proxyUpstream(c, result.remote, "write", upstreamUrl, "POST", body, logger);
});
