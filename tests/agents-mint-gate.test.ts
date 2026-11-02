/**
 * `POST /api/agents` mints an agent token: a credential that never expires and
 * is not tied to whatever minted it. A scoped API token (#254) or an OAuth
 * grant (#349) that could call it would survive its own revocation — "revoke
 * the lost laptop" would leave the laptop holding an agent token. So the route
 * refuses those, as the legacy-key rotate routes do, while sessions and the
 * legacy key keep working for existing automation.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));
vi.mock("../src/storage/agents", () => ({
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
}));

import { agentsRouter } from "../src/routes/agents";
import { createAgent } from "../src/storage/agents";

const env = { DB: {} } as unknown as Env;

function makeApp(identity: {
  userId: string;
  authVia: "token" | "session";
  apiTokenId?: string;
  oauthGrantId?: string;
}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("userId", identity.userId);
    c.set("authVia", identity.authVia);
    if (identity.apiTokenId) c.set("apiTokenId", identity.apiTokenId);
    if (identity.oauthGrantId) c.set("oauthGrantId", identity.oauthGrantId);
    await next();
  });
  app.route("/api/agents", agentsRouter);
  return app;
}

const create = (app: ReturnType<typeof makeApp>) =>
  app.fetch(
    new Request("http://localhost/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bot" }),
    }),
    env,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createAgent).mockResolvedValue({
    success: true,
    data: {
      agent: {
        id: "agt_1",
        name: "bot",
        ownerId: "usr_1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      plaintext: "stratum_agent_x",
    },
  } as never);
});

describe("POST /api/agents: who may mint an agent token", () => {
  it("refuses a scoped API token", async () => {
    const res = await create(makeApp({ userId: "usr_1", authVia: "token", apiTokenId: "tok_1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "SESSION_REQUIRED" });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("refuses an OAuth grant", async () => {
    const res = await create(
      makeApp({ userId: "usr_1", authVia: "token", oauthGrantId: "grant_1" }),
    );
    expect(res.status).toBe(403);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("still allows the legacy key", async () => {
    const res = await create(makeApp({ userId: "usr_1", authVia: "token" }));
    expect(res.status).toBe(201);
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("still allows a browser session", async () => {
    const res = await create(makeApp({ userId: "usr_1", authVia: "session" }));
    expect(res.status).toBe(201);
  });
});
