import type { MiddlewareHandler } from "hono";
import { enforcementBinding } from "../billing/enforcement";
import { RemoteEntitlements, UNLIMITED, entitlementsEnabled } from "../billing/entitlements";
import { isGitHttpPath } from "../routes/git-http";
import { isPostHogProxyPath, isPostHogSdkPath } from "../routes/posthog-proxy";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "RateLimit" });

export interface RateLimitOptions {
  requestsPerMinute?: number;
}

export interface ImportRateLimitOptions {
  /** Maximum imports per user per time window (default: 1) */
  importsPerWindow?: number;
  /** Time window in seconds (default: 60) */
  windowSeconds?: number;
  /** Maximum concurrent imports per project (default: 1) */
  maxConcurrentPerProject?: number;
  /** How long to lock a project during import in seconds (default: 300 = 5 minutes) */
  projectLockSeconds?: number;
}

/**
 * Whether a git smart-HTTP request is a READ (clone/fetch) that should skip the
 * rate limiter. Reads must be exempt because a 429 mid-clone corrupts the stream;
 * writes (`git-receive-pack`, incl. its `info/refs?service=git-receive-pack`
 * advertise) must flow through the limiter so pushes are metered. Assumes the
 * caller has already confirmed the path is a git path via `isGitHttpPath`.
 */
function isExemptGitRead(path: string, service: string | undefined): boolean {
  // Clone/fetch RPC path — always a read.
  if (path.endsWith("/git-upload-pack")) return true;
  // info/refs advertise: exempt ONLY the upload-pack (read) advertise. A
  // receive-pack advertise precedes a push, and a missing/unknown service stays
  // metered (fail closed) rather than slipping past the limiter.
  if (path.endsWith("/info/refs")) return service === "git-upload-pack";
  return false;
}

export function rateLimitMiddleware(opts?: RateLimitOptions): MiddlewareHandler<{
  Bindings: Env;
}> {
  return async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }

    // Git clone/fetch is one long request (or many subrequests); a 429 mid-clone
    // corrupts it, so the read side is exempt. Push (git-receive-pack) is a
    // metered WRITE and must NOT be exempt — otherwise writes bypass the limiter
    // entirely. Exempt only upload-pack RPCs and the upload-pack ref advertise.

    // Analytics gets its own bucket rather than an exemption. The problem is a
    // SHARED budget — a pageview costs a `/flags` call plus a capture POST,
    // keyed on the same user or IP as their API traffic, so a busy session
    // could rate-limit itself out of the app being measured — and an absent
    // budget is not the fix for that. The proxy's path allowlist, method
    // allowlist and body cap bound the shape of each request, not how many
    // arrive, and it is unauthenticated by nature.
    //
    // The SDK bundle route is not included: it is a cached GET on the ordinary
    // budget, and exempting it would leave an unauthenticated route that makes
    // an outbound fetch with no ceiling.
    const isAnalyticsIngest = isPostHogProxyPath(c.req.path) && !isPostHogSdkPath(c.req.path);

    if (isGitHttpPath(c.req.path) && isExemptGitRead(c.req.path, c.req.query("service"))) {
      await next();
      return;
    }

    const userId = c.get("userId");
    const agentId = c.get("agentId");
    const isAuthenticated = Boolean(userId ?? agentId);

    const defaultLimit = isAuthenticated ? 1000 : 60;
    // A plan's own request rate, when we hold one. Deliberately narrow:
    //
    // - **Users only.** Today's limiter keys on `userId ?? agentId ?? IP` while
    //   entitlements key on a billing subject, and resolving an agent to its
    //   owner needs a D1 hop inside this middleware. Folding a user's agents
    //   into one bucket is also a user-visible TIGHTENING (a user plus five
    //   agents get 6x1000 rpm today), so agents keep their own bucket at
    //   today's numbers and that change gets its own CHANGELOG entry.
    // - **Cached read only.** `forOwner` never fetches; the auth middleware's
    //   warm is what makes it hit. A miss falls back to today's numbers rather
    //   than blocking the request on a billing round trip.
    // - **`-1` is not a number to enforce.** Unlimited is the FAIL-OPEN default
    //   of the entitlements layer, so honouring it literally would let one
    //   uncached miss (or one billing outage) uncap a user's request rate. The
    //   default cap stands instead.
    // - **Read only where it is used.** Analytics ingest and any route passing
    //   its own `requestsPerMinute` (`POST /projects` sets 20) discard this
    //   value, and paying a KV round trip on the request path for a number
    //   thrown away is a cost with no decision behind it.
    //
    // Observe-only never tightens: with `ENTITLEMENTS_ENFORCE` off a plan may
    // raise this ceiling but not lower it, so the month of measurement PRD §8
    // asks for cannot start 429-ing anybody.
    const subjectLimit = async (): Promise<number> => {
      const planLimit = await entitledRequestsPerMinute(c.env, userId);
      if (planLimit === null) return defaultLimit;
      return enforcementBinding(c.env) ? planLimit : Math.max(planLimit, defaultLimit);
    };
    // Far above what a real session produces and far below anything worth
    // relaying through someone else's Worker.
    const analyticsLimit = 600;
    const limit = isAnalyticsIngest
      ? analyticsLimit
      : (opts?.requestsPerMinute ?? (await subjectLimit()));

    const identifier = userId ?? agentId ?? c.req.header("CF-Connecting-IP") ?? "anonymous";
    const minuteBucket = Math.floor(Date.now() / 60000);
    // A distinct key prefix, so analytics and API traffic cannot exhaust each
    // other's allowance.
    const key = isAnalyticsIngest
      ? `ratelimit:analytics:${identifier}:${minuteBucket}`
      : `ratelimit:${identifier}:${minuteBucket}`;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const nextMinuteSeconds = (minuteBucket + 1) * 60;
    const retryAfter = nextMinuteSeconds - nowSeconds;

    try {
      const raw = await c.env.STATE.get(key);
      const count = raw !== null ? Number.parseInt(raw, 10) : 0;

      if (count >= limit) {
        logger.warn("Rate limit exceeded", {
          identifier:
            identifier === userId
              ? `user:${userId}`
              : identifier === agentId
                ? `agent:${agentId}`
                : identifier.slice(0, 8),
          path: c.req.path,
          limit,
          count,
        });
        return c.json({ error: "Too many requests" }, 429, {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(limit),
          "X-RateLimit-Remaining": "0",
        });
      }

      await c.env.STATE.put(key, String(count + 1), { expirationTtl: 120 });

      const remaining = limit - count - 1;
      c.header("X-RateLimit-Limit", String(limit));
      c.header("X-RateLimit-Remaining", String(remaining));
      c.header("X-RateLimit-Reset", String(nextMinuteSeconds));

      logger.debug("Rate limit check passed", {
        identifier: userId
          ? `user:${userId}`
          : agentId
            ? `agent:${agentId}`
            : identifier.slice(0, 8),
        path: c.req.path,
        limit,
        remaining,
      });
    } catch (err) {
      logger.warn("Rate limit check failed - allowing request", {
        error: err instanceof Error ? err.message : String(err),
        path: c.req.path,
      });
      // KV unavailable — allow request through
    }

    await next();
  };
}

/**
 * The user's own `requests_per_minute`, or `null` when there is none to use.
 *
 * `null` covers every case the caller must fall back to today's numbers for: the
 * billing service is unconfigured (every self-hoster), the caller is not a user,
 * the cache is cold, or the plan says "unlimited" — which here means "we do not
 * know", because unlimited is what this layer fails open to.
 */
async function entitledRequestsPerMinute(
  env: Env,
  userId: string | undefined,
): Promise<number | null> {
  if (!userId) return null;
  if (!entitlementsEnabled(env)) return null;
  const resolved = await new RemoteEntitlements(env, logger).forOwner(userId, "user");
  if (!resolved.success) return null;
  // "default" is a cache miss, not a plan. Only a value somebody actually sent
  // us gets to move a limit.
  if (resolved.data.source === "default") return null;
  const limit = resolved.data.entitlements.rates.requests_per_minute;
  if (!Number.isInteger(limit) || limit < 0 || limit === UNLIMITED) return null;
  return limit;
}

/**
 * Rate limiting middleware specifically for import endpoints.
 * Provides both per-user and per-project rate limiting to prevent resource exhaustion.
 */
export function importRateLimitMiddleware(opts?: ImportRateLimitOptions): MiddlewareHandler<{
  Bindings: Env;
}> {
  const {
    importsPerWindow = 1,
    windowSeconds = 60,
    maxConcurrentPerProject = 1,
    projectLockSeconds = 300,
  } = opts ?? {};

  return async (c, next) => {
    const userId = c.get("userId");
    const agentId = c.get("agentId");
    const identifier = userId ?? agentId;

    // Only apply to authenticated requests (imports require auth)
    if (!identifier) {
      logger.warn("Import rate limit: unauthenticated request blocked");
      return c.json({ error: "Authentication required" }, 401);
    }

    const params = c.req.param() as { namespace?: string; slug?: string };
    const namespace = params.namespace;
    const slug = params.slug;
    if (!namespace || !slug) {
      logger.error("Import rate limit: missing namespace or slug");
      return c.json({ error: "Invalid request parameters" }, 400);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowBucket = Math.floor(nowSeconds / windowSeconds);
    const userKey = `ratelimit:import:user:${identifier}:${windowBucket}`;
    const projectKey = `ratelimit:import:project:${namespace}:${slug}`;

    try {
      // Check per-user rate limit
      const userRaw = await c.env.STATE.get(userKey);
      const userCount = userRaw !== null ? Number.parseInt(userRaw, 10) : 0;

      if (userCount >= importsPerWindow) {
        const nextWindowSeconds = (windowBucket + 1) * windowSeconds;
        const retryAfter = nextWindowSeconds - nowSeconds;

        logger.warn("Import rate limit exceeded: user quota", {
          identifier: String(identifier),
          namespace,
          slug,
          userCount,
          importsPerWindow,
        });

        return c.json(
          {
            error: "Import rate limit exceeded",
            message: `You can only start ${importsPerWindow} import(s) per ${windowSeconds} seconds. Please wait before trying again.`,
            retryAfter,
          },
          429,
          {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(importsPerWindow),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(nextWindowSeconds),
          },
        );
      }

      // Check per-project rate limit (prevent duplicate imports)
      const projectRaw = await c.env.STATE.get(projectKey);
      if (projectRaw !== null) {
        const projectCount = Number.parseInt(projectRaw, 10);

        if (projectCount >= maxConcurrentPerProject) {
          const projectTtl = await c.env.STATE.getWithMetadata(projectKey);
          const metadata = projectTtl.metadata as { expiration?: number } | null;
          const retryAfter = metadata?.expiration
            ? Math.ceil((metadata.expiration - Date.now()) / 1000)
            : projectLockSeconds;

          logger.warn("Import rate limit exceeded: project already importing", {
            identifier: String(identifier),
            namespace,
            slug,
          });

          return c.json(
            {
              error: "Project import in progress",
              message:
                "This project is already being imported. Please wait for the current import to complete before starting a new one.",
              retryAfter,
            },
            429,
            {
              "Retry-After": String(Math.max(1, retryAfter)),
              "X-RateLimit-Limit": String(maxConcurrentPerProject),
              "X-RateLimit-Remaining": "0",
            },
          );
        }
      }

      // Increment user counter
      await c.env.STATE.put(userKey, String(userCount + 1), {
        expirationTtl: windowSeconds * 2, // 2x window for safety
      });

      // Increment project counter (acts as a lock during import)
      await c.env.STATE.put(
        projectKey,
        String((projectRaw !== null ? Number.parseInt(projectRaw, 10) : 0) + 1),
        {
          expirationTtl: projectLockSeconds,
        },
      );

      // Set rate limit headers on the response
      const remaining = importsPerWindow - userCount - 1;
      c.header("X-RateLimit-Limit", String(importsPerWindow));
      c.header("X-RateLimit-Remaining", String(Math.max(0, remaining)));
      c.header("X-RateLimit-Reset", String((windowBucket + 1) * windowSeconds));

      logger.debug("Import rate limit check passed", {
        identifier: String(identifier),
        namespace,
        slug,
        userCount: userCount + 1,
        importsPerWindow,
      });
    } catch (err) {
      logger.warn("Import rate limit check failed - allowing request", {
        error: err instanceof Error ? err.message : String(err),
        namespace,
        slug,
      });
      // KV unavailable — allow request through (fail open for safety)
    }

    await next();
  };
}

/**
 * Release the import lock for a project.
 * Should be called when an import completes, fails, or is cancelled.
 */
export async function releaseImportLock(
  kv: KVNamespace,
  namespace: string,
  slug: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const projectKey = `ratelimit:import:project:${namespace}:${slug}`;

  try {
    await kv.delete(projectKey);
    logger.debug("Import lock released", { namespace, slug });
  } catch (err) {
    logger.warn("Failed to release import lock", {
      error: err instanceof Error ? err.message : String(err),
      namespace,
      slug,
    });
    // Non-fatal: lock will expire naturally via TTL
  }
}
