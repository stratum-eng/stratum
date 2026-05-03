import type { MiddlewareHandler } from "hono";
import { createPostHogClient } from "../analytics/posthog";
import type { Env } from "../types";
import { createLogger } from "../utils/logger";

const logger = createLogger({ component: "Analytics" });

export const analyticsMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const start = Date.now();
  await next();
  const path = c.req.path;
  if (path === "/health") return;

  const latency = Date.now() - start;
  const userId = c.get("userId");
  const agentId = c.get("agentId");

  logger.debug("Recording analytics", {
    method: c.req.method,
    path,
    status: c.res.status,
    latency_ms: latency,
    userId,
    agentId,
  });

  const client = createPostHogClient(c.env);
  const capture = client.capture({
    event: "api_request",
    distinctId: "server",
    properties: {
      method: c.req.method,
      path,
      status: c.res.status,
      latency_ms: latency,
    },
  });
  try {
    const ctx = c.executionCtx;
    if (ctx?.waitUntil) {
      ctx.waitUntil(capture);
    }
  } catch {
    capture.catch(() => undefined);
  }
};
