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
  // Unmatched routes are overwhelmingly internet scanners probing for
  // /.env, /.git/config, and the like — noise, not product traffic.
  if (c.res.status === 404) return;

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

  const distinctId = userId ?? agentId ?? "server";
  const client = createPostHogClient(c.env);
  const capture = client.capture({
    event: "api_request",
    distinctId,
    properties: {
      method: c.req.method,
      path,
      status: c.res.status,
      latency_ms: latency,
      // Unattributed events would otherwise accrete on a shared "server"
      // person profile; capture them personless instead.
      ...(distinctId === "server" ? { $process_person_profile: false } : {}),
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
