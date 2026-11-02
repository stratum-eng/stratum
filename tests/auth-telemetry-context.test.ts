import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
// Spread the real module and override only what touches D1, so an export added
// later cannot arrive as undefined. `resolveApiToken` defaults to a miss, which
// is what sends every non-scoped case down the legacy path below.
vi.mock("../src/storage/api-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/api-tokens")>()),
  resolveApiToken: vi.fn(),
  touchApiTokenLastUsed: vi.fn(async () => undefined),
}));

import { getAgentByToken } from "../src/storage/agents";
import { resolveApiToken } from "../src/storage/api-tokens";
import { getSession } from "../src/storage/sessions";
import { getUser, getUserByToken } from "../src/storage/users";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.get("/test", (c) => c.json({ telemetryOptOut: c.get("telemetryOptOut") ?? null }));
  return app;
}

const env = {
  ARTIFACTS: {} as Env["ARTIFACTS"],
  STATE: {} as KVNamespace,
  DB: {} as D1Database,
} as Env;

const liveUser = {
  id: "usr_1",
  email: "a@b.com",
  username: "alice",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const agent = {
  id: "agt_1",
  ownerId: "usr_1",
  name: "bot",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

async function optOutFor(request: Request): Promise<boolean | null> {
  const res = await makeApp().fetch(request, env);
  const body = (await res.json()) as { telemetryOptOut: boolean | null };
  return body.telemetryOptOut;
}

function bearer(token: string): Request {
  return new Request("http://localhost/test", { headers: { Authorization: `Bearer ${token}` } });
}

function cookie(sessionId: string): Request {
  return new Request("http://localhost/test", {
    headers: { Cookie: `stratum_session=${sessionId}` },
  });
}

/**
 * The preference must ride the `users` row auth already loads. If any of these
 * ever needs a second lookup to answer, the "zero added D1 round-trips on the
 * hot path" guarantee in the #257 PRD has quietly been lost.
 */
describe("telemetry preference in the auth context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no scoped token matches, so each case below exercises the
    // credential it is actually about.
    vi.mocked(resolveApiToken).mockResolvedValue({
      success: false,
      error: new NotFoundError("Token", "by-token"),
    });
  });

  describe("user token", () => {
    it("carries the flag through without a second user lookup", async () => {
      vi.mocked(getUserByToken).mockResolvedValue({
        success: true,
        data: { ...liveUser, telemetryOptOut: true },
      });

      expect(await optOutFor(bearer("stratum_user_abc"))).toBe(true);
      expect(getUserByToken).toHaveBeenCalledTimes(1);
      expect(getUser).not.toHaveBeenCalled();
    });

    it("reports opted in as false, never undefined", async () => {
      vi.mocked(getUserByToken).mockResolvedValue({ success: true, data: liveUser });

      expect(await optOutFor(bearer("stratum_user_abc"))).toBe(false);
    });
  });

  describe("scoped token (#254)", () => {
    /**
     * The scoped-token path resolves its own owner row, so the preference has
     * to be selected by that join. Without it, opting out would be defeated by
     * authenticating with a scoped token instead of the legacy key — silently,
     * because every other scoped-token behaviour would still be correct.
     */
    it("carries the owner's opt-out from the token's own join", async () => {
      vi.mocked(resolveApiToken).mockResolvedValue({
        success: true,
        data: {
          user: { ...liveUser, telemetryOptOut: true },
          scope: "read_write",
          tokenId: "tok_1",
        },
      });

      expect(await optOutFor(bearer("stratum_user_abc"))).toBe(true);
      // The legacy fallback must not run: the scoped token already answered.
      expect(getUserByToken).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
    });

    it("reports opted in as false, never undefined", async () => {
      vi.mocked(resolveApiToken).mockResolvedValue({
        success: true,
        data: { user: liveUser, scope: "read", tokenId: "tok_1" },
      });

      expect(await optOutFor(bearer("stratum_user_abc"))).toBe(false);
    });
  });

  describe("agent token", () => {
    it("inherits the owner's opt-out from the row already fetched to check deletion", async () => {
      vi.mocked(getAgentByToken).mockResolvedValue({ success: true, data: agent });
      vi.mocked(getUser).mockResolvedValue({
        success: true,
        data: { ...liveUser, telemetryOptOut: true },
      });

      expect(await optOutFor(bearer("stratum_agent_xyz"))).toBe(true);
      // Exactly one owner lookup: the deleting-owner check, reused here.
      expect(getUser).toHaveBeenCalledTimes(1);
    });

    it("reports opted in when the owner has not opted out", async () => {
      vi.mocked(getAgentByToken).mockResolvedValue({ success: true, data: agent });
      vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });

      expect(await optOutFor(bearer("stratum_agent_xyz"))).toBe(false);
    });
  });

  describe("session cookie", () => {
    it("carries the flag from the session's user row", async () => {
      vi.mocked(getSession).mockResolvedValue({
        success: true,
        data: {
          id: "sess_1",
          userId: "usr_1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      vi.mocked(getUser).mockResolvedValue({
        success: true,
        data: { ...liveUser, telemetryOptOut: true },
      });

      expect(await optOutFor(cookie("sess_1"))).toBe(true);
      expect(getUser).toHaveBeenCalledTimes(1);
    });
  });

  it("sets nothing for an unauthenticated caller — no identity, no preference", async () => {
    expect(await optOutFor(new Request("http://localhost/test"))).toBeNull();
  });
});
