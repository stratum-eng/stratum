import { Hono } from "hono";
import { createChangeWithEvaluation, createWorkspaceFork } from "../services/change-flow";
import { getAgentByToken } from "../storage/agents";
import { isTargetDeleting } from "../storage/deletion";
import {
  artifactsRepoNameFromRemote,
  extractTokenSecret,
  freshRepoToken,
} from "../storage/git-ops";
import { deleteWorkspace, getProjectByPath, getWorkspace } from "../storage/state";
import { getUser, getUserByToken } from "../storage/users";
import type { Env, ProjectEntry } from "../types";
import { canReadProject, canWriteProject, canWriteWorkspace } from "../utils/authz";
import {
  buildReportStatus,
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
 *    `git push` (write), proxied verbatim to the workspace's Artifacts fork.
 *    The client clones the workspace, so ref/old-oid semantics line up and
 *    Artifacts' own report-status is the truthful outcome — no parsing or
 *    synthesis needed here.
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
    if (candidate.startsWith("stratum_user_") || candidate.startsWith("stratum_agent_")) {
      return candidate;
    }
  }
  return null;
}

interface Identity {
  userId?: string;
  agentId?: string;
  agentOwnerId?: string;
}

/**
 * Resolve the caller's identity from Basic credentials. Returns `null` for
 * anonymous *or* unrecognized/invalid credentials — both collapse to "no
 * identity" for the access truth table, never a 500.
 */
async function authenticate(
  c: { req: { header(name: string): string | undefined }; env: Env },
  logger: ReturnType<typeof createLogger>,
): Promise<Identity | null> {
  const token = parseBasicToken(c.req.header("Authorization"));
  if (!token) return null;

  if (token.startsWith("stratum_user_")) {
    const result = await getUserByToken(c.env.DB, token, logger);
    // A soft-deleting account's credentials stop working immediately over git
    // too — the HTTP middleware rejects it, but git smart-HTTP owns its own auth
    // and must apply the same gate, or an erasure-requested user keeps clone/push
    // access until the cascade lands.
    if (!result.success || result.data.deletingAt) return null;
    return { userId: result.data.id };
  }
  const result = await getAgentByToken(c.env.DB, token, logger);
  if (!result.success) return null;
  // An agent inherits its owner's access, so a deleting owner's agent must stop
  // working too — otherwise it's an authenticated git write channel that outlives
  // the account it belongs to. Fail CLOSED on the owner lookup: an unresolved or
  // deleting owner yields no identity. getUser can reject on a D1 error, which
  // would otherwise escape authenticate's documented no-500 contract, so catch it.
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
  if (!owner.success || owner.data.deletingAt) return null;
  return { agentId: result.data.id, agentOwnerId: result.data.ownerId };
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
async function authorizeProject(
  c: { req: { header(name: string): string | undefined; param(name: string): string }; env: Env },
  scope: "read" | "write",
  logger: ReturnType<typeof createLogger>,
): Promise<{ project: ProjectEntry; identity: Identity | null } | Response> {
  const namespace = c.req.param("namespace");
  const slug = normalizeSlug(c.req.param("slug"));

  const identity = await authenticate(c, logger);
  const isAnonymous = identity === null;

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
      ? await canWriteProject(c.env.DB, project, identity?.userId, identity?.agentOwnerId)
      : await canReadProject(c.env.DB, project, identity?.userId, identity?.agentOwnerId);
  if (!allowed) {
    return isAnonymous ? authChallenge() : gitNotFound();
  }

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
  c: { req: { header(name: string): string | undefined; param(name: string): string }; env: Env },
  scope: "read" | "write",
  logger: ReturnType<typeof createLogger>,
): Promise<{ remote: string } | Response> {
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

  const allowed =
    scope === "write"
      ? await canWriteProject(c.env.DB, project, identity?.userId, identity?.agentOwnerId)
      : await canReadProject(c.env.DB, project, identity?.userId, identity?.agentOwnerId);
  if (!allowed) return isAnonymous ? authChallenge() : gitNotFound();

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

  return { remote: workspace.remote };
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

const ZERO_OID = "0".repeat(40);

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
 * Best-effort teardown of the server-managed fork when a gated push dies
 * before its change exists: nothing references the workspace yet, so leaving
 * it would leak an Artifacts repo + KV entry per failed push. Failures are
 * logged with enough coordinates to find the orphan by hand.
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

  const parsed = parseReceivePackRequest(new Uint8Array(body));
  if (!parsed.success) {
    logger.warn("Malformed receive-pack request", { error: parsed.error.message });
    return new Response(`${parsed.error.message}\n`, {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
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
  const defaultBranch = project.sourceDefaultBranch || project.githubDefaultBranch || "main";
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
  });
  if (!outcome.success) {
    logger.error("Gated push change creation failed", outcome.error);
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
  const upstreamUrl = `${result.remote}/${RECEIVE_PACK}`;
  return proxyUpstream(c, result.remote, "write", upstreamUrl, "POST", body, logger);
});
