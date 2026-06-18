import { Hono } from "hono";
import { getAgentByToken } from "../storage/agents";
import {
  artifactsRepoNameFromRemote,
  extractTokenSecret,
  freshRepoToken,
} from "../storage/git-ops";
import { getProjectByPath } from "../storage/state";
import { getUserByToken } from "../storage/users";
import type { Env, ProjectEntry } from "../types";
import { canReadProject } from "../utils/authz";
import { createLogger } from "../utils/logger";

/**
 * Git smart-HTTP proxy (ADR 005, slice 1: clone/fetch only).
 *
 * Lets a Stratum project be used as a git remote: `git clone <host>/@ns/slug.git`.
 * The router authenticates with the existing API-key system over HTTP Basic,
 * authorizes the caller, mints a short-lived Cloudflare Artifacts token, and
 * proxies the smart-HTTP request to the backing Artifacts remote. The Artifacts
 * token never leaves the Worker.
 *
 * Push (`git-receive-pack`) is intentionally refused — see `pushNotSupported`.
 */

/**
 * Whether a request path belongs to the git smart-HTTP surface. The global
 * `authMiddleware` (Bearer-only) would otherwise reject git's Basic-auth
 * requests before this router runs, so the middlewares consult this to step
 * aside and let the router own auth.
 *
 * Anchored to the exact `/<namespace>/<slug>/<git-suffix>` shape — a bare
 * `endsWith` would also exempt unrelated routes whose path merely ends in the
 * suffix (e.g. the UI `…/blob/<file>/info/refs`), stripping auth/CSRF/rate-limit
 * from them.
 */
const GIT_HTTP_PATH = /^\/[^/]+\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

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
 * Proxy a smart-HTTP request to the project's Artifacts remote with a freshly
 * minted read token. Buffers the request body (Workers silently drop streamed
 * outbound bodies — see `git-ops.ts`) and streams the response body back.
 */
async function proxyUpstream(
  c: { req: { header(name: string): string | undefined }; env: Env },
  project: ProjectEntry,
  upstreamUrl: string,
  method: "GET" | "POST",
  body: ArrayBuffer | undefined,
  logger: ReturnType<typeof createLogger>,
): Promise<Response> {
  const tokenResult = await freshRepoToken(c.env.ARTIFACTS, project.remote, "read", logger);
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
    return new Response("git protocol is not available for this project\n", {
      status: 501,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return project;
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
  return proxyUpstream(c, result, upstreamUrl, "GET", undefined, logger);
});

// POST /@:namespace/:slug.git/git-upload-pack — clone/fetch RPC
gitHttpRouter.post("/:namespace/:slug/git-upload-pack", async (c) => {
  const logger = createLogger({ requestId: crypto.randomUUID(), path: c.req.path, method: "POST" });
  const result = await authorizeRead(c, logger);
  if (result instanceof Response) return result;

  const body = await c.req.arrayBuffer();
  const upstreamUrl = `${result.remote}/${UPLOAD_PACK}`;
  return proxyUpstream(c, result, upstreamUrl, "POST", body, logger);
});

// POST /@:namespace/:slug.git/git-receive-pack — push (refused, slice 1)
gitHttpRouter.post("/:namespace/:slug/git-receive-pack", () => pushNotSupported());
