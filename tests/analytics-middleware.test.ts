import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsMiddleware } from "../src/middleware/analytics";
import type { Env } from "../src/types";

interface CapturedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, string | number | boolean>;
}

function makeApp(vars: { userId?: string; agentId?: string; agentOwnerId?: string } = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (vars.userId) c.set("userId", vars.userId);
    if (vars.agentId) c.set("agentId", vars.agentId);
    // `authMiddleware` publishes the owner alongside the agent, because it has
    // to load the owner anyway to read their telemetry preference.
    if (vars.agentOwnerId) c.set("agentOwnerId", vars.agentOwnerId);
    await next();
  });
  app.use("*", analyticsMiddleware);
  app.get("/api/changes", (c) => c.json({ ok: true }));
  app.get("/api/changes/:changeId", (c) => c.json({ ok: true }));
  app.get("/login", (c) => c.json({ ok: true }));
  app.get("/:ns/:slug/blob/*", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}

const env = { POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "https://ph.example.com" } as Env;

function stubCapture(): CapturedEvent[] {
  const captured: CapturedEvent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      captured.push(JSON.parse(init?.body as string) as CapturedEvent);
      return new Response("ok");
    }),
  );
  return captured;
}

async function flushCapture() {
  // The middleware fires capture without awaiting it (waitUntil outside
  // workers falls back to a floating promise); let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("analyticsMiddleware", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures matched requests with method, route, status, and latency", async () => {
    const captured = stubCapture();
    const res = await makeApp().fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe("api_request");
    expect(captured[0]?.properties.method).toBe("GET");
    expect(captured[0]?.properties.route).toBe("/api/changes");
    expect(captured[0]?.properties.status).toBe(200);
    expect(typeof captured[0]?.properties.latency_ms).toBe("number");
  });

  it("sends the route pattern for blob paths, never the namespace, slug, or file path", async () => {
    const captured = stubCapture();
    const res = await makeApp().fetch(
      new Request("https://api.example.com/@acme/secret-repo/blob/src/deep/private.ts"),
      env,
    );
    await flushCapture();

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.properties.route).toBe("/:ns/:slug/blob/*");
    expect(captured[0]?.properties.path).toBeUndefined();
    const body = JSON.stringify(captured[0]);
    expect(body).not.toContain("acme");
    expect(body).not.toContain("secret-repo");
    expect(body).not.toContain("private.ts");
  });

  it("sends the route pattern for change-id paths, never the concrete id", async () => {
    const captured = stubCapture();
    await makeApp().fetch(new Request("https://api.example.com/api/changes/ch_8f3a2b1c"), env);
    await flushCapture();

    expect(captured[0]?.properties.route).toBe("/api/changes/:changeId");
    expect(JSON.stringify(captured[0])).not.toContain("ch_8f3a2b1c");
  });

  it("sends static routes as-is", async () => {
    const captured = stubCapture();
    await makeApp().fetch(new Request("https://api.example.com/login"), env);
    await flushCapture();

    expect(captured[0]?.properties.route).toBe("/login");
  });

  it("defers the capture through waitUntil when an execution context is present", async () => {
    const captured = stubCapture();
    const waitUntil = vi.fn();
    const executionCtx = { waitUntil, passThroughOnException: () => undefined, props: {} };
    await makeApp().fetch(
      new Request("https://api.example.com/api/changes"),
      env,
      executionCtx as ExecutionContext,
    );
    await flushCapture();

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
  });

  it("captures nothing when telemetry is disabled", async () => {
    const captured = stubCapture();
    const res = await makeApp().fetch(
      new Request("https://api.example.com/@acme/secret-repo/blob/src/deep/private.ts"),
      { ...env, STRATUM_TELEMETRY_DISABLED: "true" } as Env,
    );
    await flushCapture();

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(0);
  });

  it("does not capture 404s (scanner probes on unmatched routes)", async () => {
    const captured = stubCapture();
    const res = await makeApp().fetch(new Request("https://api.example.com/.env"), env);
    await flushCapture();

    expect(res.status).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it("does not capture /health", async () => {
    const captured = stubCapture();
    await makeApp().fetch(new Request("https://api.example.com/health"), env);
    await flushCapture();

    expect(captured).toHaveLength(0);
  });

  it("attributes events to the authenticated user", async () => {
    const captured = stubCapture();
    await makeApp({ userId: "user-123" }).fetch(
      new Request("https://api.example.com/api/changes"),
      env,
    );
    await flushCapture();

    expect(captured[0]?.distinct_id).toBe("user-123");
    expect(captured[0]?.properties.$process_person_profile).toBeUndefined();
  });

  it("prefers the user over the agent when both are set", async () => {
    const captured = stubCapture();
    await makeApp({ userId: "user-123", agentId: "agent-42" }).fetch(
      new Request("https://api.example.com/api/changes"),
      env,
    );
    await flushCapture();

    expect(captured[0]?.distinct_id).toBe("user-123");
  });

  // An agent is a credential, not a person. Attributing it to itself would mint
  // a person profile per token, splitting one human's history across several.
  it("attributes an agent's request to its owner, keeping the agent as a property", async () => {
    const captured = stubCapture();
    await makeApp({ agentId: "agent-42", agentOwnerId: "user-123" }).fetch(
      new Request("https://api.example.com/api/changes"),
      env,
    );
    await flushCapture();

    expect(captured[0]?.distinct_id).toBe("user-123");
    expect(captured[0]?.properties.agent_id).toBe("agent-42");
    expect(captured[0]?.properties.actor_type).toBe("agent");
  });

  it("captures an agent personless when its owner cannot be resolved", async () => {
    const captured = stubCapture();
    await makeApp({ agentId: "agent-42" }).fetch(
      new Request("https://api.example.com/api/changes"),
      env,
    );
    await flushCapture();

    // No person to attribute to, so no profile is minted for the credential.
    expect(captured[0]?.distinct_id).toBe("server");
    expect(captured[0]?.properties.$process_person_profile).toBe(false);
    expect(captured[0]?.properties.agent_id).toBe("agent-42");
  });

  it("captures unattributed events personless under the server id", async () => {
    const captured = stubCapture();
    await makeApp().fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();

    expect(captured[0]?.distinct_id).toBe("server");
    expect(captured[0]?.properties.$process_person_profile).toBe(false);
  });
});

describe("analyticsMiddleware — segmentation properties", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("labels the surface that served the request", async () => {
    const captured = stubCapture();
    await makeApp().fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();

    expect(captured[0]?.properties.surface).toBe("api");
  });

  it("labels a UI page distinctly from the API", async () => {
    const captured = stubCapture();
    await makeApp().fetch(
      new Request("https://api.example.com/@acme/secret-repo/blob/src/a.ts"),
      env,
    );
    await flushCapture();

    expect(captured[0]?.properties.surface).toBe("ui");
  });

  it("records how the caller was identified", async () => {
    const captured = stubCapture();
    await makeApp({ userId: "user-123" }).fetch(
      new Request("https://api.example.com/api/changes"),
      env,
    );
    await flushCapture();
    expect(captured[0]?.properties.actor_type).toBe("user");

    const agentCaptured = stubCapture();
    await makeApp({ agentId: "agent-42", agentOwnerId: "user-123" }).fetch(
      new Request("https://api.example.com/api/changes"),
      env,
    );
    await flushCapture();
    expect(agentCaptured[0]?.properties.actor_type).toBe("agent");

    const anonCaptured = stubCapture();
    await makeApp().fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();
    expect(anonCaptured[0]?.properties.actor_type).toBe("anonymous");
  });

  it("stamps the operator's environment label", async () => {
    const captured = stubCapture();
    await makeApp().fetch(new Request("https://api.example.com/api/changes"), {
      ...env,
      STRATUM_ENVIRONMENT: "production",
    } as Env);
    await flushCapture();

    expect(captured[0]?.properties.environment).toBe("production");
  });

  // The per-user opt-out now lives in the tracker rather than in this
  // middleware. Pinned here because the middleware is where it used to live,
  // and a refactor that loses it would otherwise fail no test in this file.
  it("still honours the caller's opt-out", async () => {
    const captured = stubCapture();
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("userId", "user-123");
      c.set("telemetryOptOut", true);
      await next();
    });
    app.use("*", analyticsMiddleware);
    app.get("/api/changes", (c) => c.json({ ok: true }));

    await app.fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();

    expect(captured).toHaveLength(0);
  });
});
