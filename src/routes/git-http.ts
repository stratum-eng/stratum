import { Hono } from "hono";
import { getAgentByToken } from "../storage/agents";
import {
  artifactsRepoNameFromRemote,
  extractTokenSecret,
  freshRepoToken,
} from "../storage/git-ops";
import { getProjectByPath, getWorkspace } from "../storage/state";
import { getUserByToken } from "../storage/users";
import type { Env, ProjectEntry } from "../types";
import { canReadProject, canWriteProject, canWriteWorkspace } from "../utils/authz";
import { createLogger } from "../utils/logger";

/**
 * Git smart-HTTP proxy (ADR 005).
 *
 * Lets a Stratum project be used as a git remote. Two surfaces:
 *  - Project URL `/@ns/slug.git` — clone/fetch (read). Pushing to the project
 *    URL is refused (`pushNotSupported`); the gated `push → change → eval →
 *    merge` path is a separate slice (Phase B / #115).
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
    return result.success ? { userId: result.data.id } : null;
  }
  const result = await getAgentByToken(c.env.DB, token, logger);
  return result.success ? { agentOwnerId: result.data.ownerId } : null;
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

function pushNotSupported(): Response {
  return new Response(
    "push over git is not yet supported — use 'stratum commit' or the change flow\n",
    { status: 403, headers: { "Content-Type": "text/plain" } },
  );
}

/** Strip a trailing `.git` so both `/@ns/slug.git` and `/@ns/slug` resolve. */
function normalizeSlug(slug: string): string {
  return slug.endsWith(".git") ? slug.slice(0, -".git".length) : slug;
}

/**
 * Resolve + authorize a project for a read, applying the no-leak truth table.
 * Returns the project on success, or a `Response` to return as-is.
 */
async function authorizeRead(
  c: { req: { header(name: string): string | undefined; param(name: string): string }; env: Env },
  logger: ReturnType<typeof createLogger>,
): Promise<ProjectEntry | Response> {
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
  const canRead = await canReadProject(c.env.DB, project, identity?.userId, identity?.agentOwnerId);
  if (!canRead) {
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

  return project;
}

const gitUnavailable = (resource: "project" | "workspace"): Response =>
  new Response(`git protocol is not available for this ${resource}\n`, {
    status: 501,
    headers: { "Content-Type": "text/plain" },
  });

/**
 * Resolve + authorize a workspace for clone/fetch (read) or push (write),
 * applying the same no-leak truth table as `authorizeRead`. Returns the
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
  if (service === RECEIVE_PACK) return pushNotSupported();
  if (service !== UPLOAD_PACK) {
    return new Response("only the smart-HTTP git-upload-pack service is supported\n", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const result = await authorizeRead(c, logger);
  if (result instanceof Response) return result;

  const upstreamUrl = `${result.remote}/info/refs?service=${UPLOAD_PACK}`;
  return proxyUpstream(c, result.remote, "read", upstreamUrl, "GET", undefined, logger);
});

// POST /@:namespace/:slug.git/git-upload-pack — clone/fetch RPC
gitHttpRouter.post("/:namespace/:slug/git-upload-pack", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: "POST" });
  const result = await authorizeRead(c, logger);
  if (result instanceof Response) return result;

  const body = await readCappedBody(c, logger);
  if (body instanceof Response) return body;
  const upstreamUrl = `${result.remote}/${UPLOAD_PACK}`;
  return proxyUpstream(c, result.remote, "read", upstreamUrl, "POST", body, logger);
});

// POST /@:namespace/:slug.git/git-receive-pack — push to the project ref.
// Refused: the gated push path (open a change + eval + merge) is a separate
// slice (#115 / ADR 005 Phase B). Push to a workspace URL instead.
gitHttpRouter.post("/:namespace/:slug/git-receive-pack", () => pushNotSupported());

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
