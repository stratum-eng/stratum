import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsMiddleware } from "../src/middleware/analytics";
import { authMiddleware } from "../src/middleware/auth";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
}));
vi.mock("../src/storage/sessions", () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));

import { getAgentByToken } from "../src/storage/agents";
import { getUser, getUserByToken } from "../src/storage/users";

interface CapturedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, string | number | boolean>;
}

/**
 * Registers the middleware in PRODUCTION ORDER — analytics BEFORE auth, as
 * `src/index.ts:54-55` does.
 *
 * This matters: `tests/analytics-middleware.test.ts` registers its
 * context-setting stub *before* `analyticsMiddleware`, which is the inverse of
 * production. A test cloned from that harness would pass even if the real
 * ordering were broken, because the var would already be set when analytics
 * started. Analytics only works because it reads context AFTER `await next()`,
 * and only a chain with the real `authMiddleware` in the real order proves it.
 */
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", analyticsMiddleware);
  app.use("*", authMiddleware);
  app.get("/api/changes", (c) => c.json({ ok: true }));
  return app;
}

const env = {
  ARTIFACTS: {} as Env["ARTIFACTS"],
  STATE: {} as KVNamespace,
  DB: {} as D1Database,
  POSTHOG_API_KEY: "phc_test",
  POSTHOG_HOST: "https://ph.example.com",
} as Env;

const liveUser = {
  id: "usr_1",
  email: "a@b.com",
  username: "alice",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

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
  // capture() is fired without awaiting (waitUntil falls back to a floating
  // promise outside workers); let it settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function tokenRequest(token: string): Request {
  return new Request("https://api.example.com/api/changes", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe("telemetry opt-out — request path", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("sends nothing for a user who has opted out", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: { ...liveUser, telemetryOptOut: true },
    });
    const captured = stubCapture();

    const res = await makeApp().fetch(tokenRequest("stratum_user_abc"), env);
    await flushCapture();

    expect(res.status).toBe(200);
    expect(captured).toEqual([]);
  });

  it("still sends for a user who has not opted out", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({ success: true, data: liveUser });
    const captured = stubCapture();

    await makeApp().fetch(tokenRequest("stratum_user_abc"), env);
    await flushCapture();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.event).toBe("api_request");
    expect(captured[0]?.distinct_id).toBe("usr_1");
    expect(captured[0]?.properties.route).toBe("/api/changes");
  });

  it("suppresses an agent's traffic when its OWNER has opted out", async () => {
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: true,
      data: { id: "agt_1", ownerId: "usr_1", name: "bot", tokenHash: "h", createdAt: "2026-01-01" },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: { ...liveUser, telemetryOptOut: true },
    });
    const captured = stubCapture();

    await makeApp().fetch(tokenRequest("stratum_agent_xyz"), env);
    await flushCapture();

    expect(captured).toEqual([]);
  });

  it("still sends an agent's traffic when its owner has not opted out", async () => {
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: true,
      data: { id: "agt_1", ownerId: "usr_1", name: "bot", tokenHash: "h", createdAt: "2026-01-01" },
    });
    vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });
    const captured = stubCapture();

    await makeApp().fetch(tokenRequest("stratum_agent_xyz"), env);
    await flushCapture();

    expect(captured).toHaveLength(1);
    // Attributed to the owner, not the agent: an agent token is a credential
    // acting under a person's account, and minting a person profile per token
    // would split that person's history and inflate the person count.
    expect(captured[0]?.distinct_id).toBe("usr_1");
    expect(captured[0]?.properties.agent_id).toBe("agt_1");
  });

  it("keeps capturing anonymous traffic personless — it carries no preference", async () => {
    const captured = stubCapture();

    await makeApp().fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.distinct_id).toBe("server");
    expect(captured[0]?.properties.$process_person_profile).toBe(false);
  });

  it("suppresses on the preference alone, with no identity in context", async () => {
    // git-http owns its own auth and publishes the preference WITHOUT setting
    // userId/agentId. If this gate is ever narrowed to attributed callers, git
    // clone/fetch/push by an opted-out user starts exporting again.
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", analyticsMiddleware);
    app.use("*", async (c, next) => {
      c.set("telemetryOptOut", true);
      await next();
    });
    app.get("/api/changes", (c) => c.json({ ok: true }));
    const captured = stubCapture();

    await app.fetch(new Request("https://api.example.com/api/changes"), env);
    await flushCapture();

    expect(captured).toEqual([]);
  });

  it("captures a rejected token's request as unattributed, not as the user's", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: false,
      error: new NotFoundError("User", "by-token"),
    });
    const captured = stubCapture();

    const res = await makeApp().fetch(tokenRequest("stratum_user_bad"), env);
    await flushCapture();

    expect(res.status).toBe(401);
    // A 401 never reaches the route, so no identity is known and none is sent.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.distinct_id).toBe("server");
  });
});
