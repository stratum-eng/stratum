import type { MiddlewareHandler } from "hono";
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

export function rateLimitMiddleware(opts?: RateLimitOptions): MiddlewareHandler<{
  Bindings: Env;
}> {
  return async (c, next) => {
    if (c.req.path === "/health") {
      await next();
      return;
    }

    const userId = c.get("userId");
    const agentId = c.get("agentId");
    const isAuthenticated = Boolean(userId ?? agentId);

    const defaultLimit = isAuthenticated ? 1000 : 60;
    const limit = opts?.requestsPerMinute ?? defaultLimit;

    const identifier = userId ?? agentId ?? c.req.header("CF-Connecting-IP") ?? "anonymous";
    const minuteBucket = Math.floor(Date.now() / 60000);
    const key = `ratelimit:${identifier}:${minuteBucket}`;

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
