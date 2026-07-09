import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsMiddleware } from "../src/middleware/analytics";
import type { Env } from "../src/types";

interface CapturedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, string | number | boolean>;
}

function makeApp(vars: { userId?: string; agentId?: string } = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (vars.userId) c.set("userId", vars.userId);
    if (vars.agentId) c.set("agentId", vars.agentId);
    await next();
  });
  app.use("*", analyticsMiddleware);
  app.get("/api/changes", (c) => c.json({ ok: true }));
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

  it("captures matched requests with method, path, status, and latency", async () => {
    const captured = stubCapture();
    const res = await makeApp().fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe("api_request");
    expect(captured[0]?.properties.method).toBe("GET");
    expect(captured[0]?.properties.path).toBe("/api/changes");
    expect(captured[0]?.properties.status).toBe(200);
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

  it("attributes events to the agent when no user is set", async () => {
    const captured = stubCapture();
    await makeApp({ agentId: "agent-42" }).fetch(
      new Request("https://api.example.com/api/changes"),
      env,
    );
    await flushCapture();

    expect(captured[0]?.distinct_id).toBe("agent-42");
  });

  it("captures unattributed events personless under the server id", async () => {
    const captured = stubCapture();
    await makeApp().fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();

    expect(captured[0]?.distinct_id).toBe("server");
    expect(captured[0]?.properties.$process_person_profile).toBe(false);
  });
});
