/**
 * #257: git smart-HTTP owns its own Basic auth — `authMiddleware` steps aside
 * for these paths (`src/middleware/auth.ts`, `isGitHttpPath`). Without the
 * preference being published from `git-http.ts`'s own `authenticate`, every
 * clone, fetch, and push by an opted-out user would keep producing an
 * `api_request` event, contradicting the Settings copy ("stops future events
 * for your account") and the deployment docs ("Both streams are suppressed").
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsMiddleware } from "../src/middleware/analytics";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("../src/storage/agents", () => ({ getAgentByToken: vi.fn() }));
// The scoped-token lookup runs before the legacy one, so it has to be stubbed
// or it would reach the `{}` D1 binding. Spread the real module: listing the
// exports by hand drops any added later.
vi.mock("../src/storage/api-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/api-tokens")>()),
  resolveApiToken: vi.fn(),
}));
// A public project so the request gets past the no-leak 404 truth table:
// analyticsMiddleware deliberately skips 404s, so a missing project would
// capture nothing regardless of the preference and prove nothing.
vi.mock("../src/storage/state", () => ({
  getProjectByPath: vi.fn(async () => ({
    success: true,
    data: {
      name: "web",
      namespace: "@acme",
      slug: "web",
      remote: "https://acct.artifacts.cloudflare.net/git/@acme/web.git",
      createdAt: "2026-01-01T00:00:00.000Z",
      visibility: "public",
    },
  })),
  getWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));
// Minting an Artifacts token needs the binding; fail it so the route returns a
// non-404 error status. Which status does not matter — only that it is captured.
vi.mock("../src/storage/git-ops", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/git-ops")>()),
  freshRepoToken: vi.fn(async () => ({ success: false, error: { message: "no binding" } })),
}));

import { gitHttpRouter } from "../src/routes/git-http";
import { getAgentByToken } from "../src/storage/agents";
import { resolveApiToken } from "../src/storage/api-tokens";
import { getUser, getUserByToken } from "../src/storage/users";

interface CapturedEvent {
  distinct_id: string;
  properties: Record<string, string | number | boolean>;
}

const env = {
  ARTIFACTS: {} as Env["ARTIFACTS"],
  STATE: {} as KVNamespace,
  DB: {} as D1Database,
  POSTHOG_API_KEY: "phc_test",
  POSTHOG_HOST: "https://ph.example.com",
} as Env;

const OWNER_TOKEN = "stratum_user_owner000000000000000000";

/** Production shape: analytics wraps the git router, which authenticates itself. */
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", analyticsMiddleware);
  app.route("/", gitHttpRouter);
  return app;
}

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
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function cloneRequest(token: string): Request {
  return new Request("https://host/@acme/web/info/refs?service=git-upload-pack", {
    headers: { Authorization: `Basic ${btoa(`x:${token}`)}` },
  });
}

describe("telemetry opt-out — git smart-HTTP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no scoped token matches, so the cases below exercise the
    // credential each is actually about.
    vi.mocked(resolveApiToken).mockResolvedValue({
      success: false,
      error: new NotFoundError("Token", "by-token"),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends nothing for a clone by a user who has opted out", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: {
        id: "usr_1",
        email: "a@b.com",
        username: "alice",
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
        telemetryOptOut: true,
      },
    });
    const captured = stubCapture();

    await makeApp().fetch(cloneRequest(OWNER_TOKEN), env);
    await flushCapture();

    expect(captured).toEqual([]);
  });

  it("still sends for a clone by a user who has not opted out", async () => {
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: {
        id: "usr_1",
        email: "a@b.com",
        username: "alice",
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const captured = stubCapture();

    await makeApp().fetch(cloneRequest(OWNER_TOKEN), env);
    await flushCapture();

    expect(captured).toHaveLength(1);
  });

  /**
   * A scoped token (#254) resolves through its own join, not `getUserByToken`,
   * so it needs the preference published on that branch too — otherwise the
   * one credential this feature exists for (CI) is exactly the one whose clones
   * keep being exported after its owner opts out.
   */
  it("sends nothing for a clone by a scoped token whose owner has opted out", async () => {
    vi.mocked(resolveApiToken).mockResolvedValue({
      success: true,
      data: {
        user: {
          id: "usr_1",
          email: "a@b.com",
          username: "alice",
          tokenHash: "h",
          createdAt: "2026-01-01T00:00:00.000Z",
          telemetryOptOut: true,
        },
        scope: "read",
        tokenId: "tok_1",
      },
    });
    const captured = stubCapture();

    await makeApp().fetch(cloneRequest(OWNER_TOKEN), env);
    await flushCapture();

    expect(captured).toEqual([]);
    // The legacy fallback must not run: the scoped token already answered.
    expect(getUserByToken).not.toHaveBeenCalled();
  });

  it("still sends for a clone by a scoped token whose owner has not opted out", async () => {
    vi.mocked(resolveApiToken).mockResolvedValue({
      success: true,
      data: {
        user: {
          id: "usr_1",
          email: "a@b.com",
          username: "alice",
          tokenHash: "h",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        scope: "read",
        tokenId: "tok_1",
      },
    });
    const captured = stubCapture();

    await makeApp().fetch(cloneRequest(OWNER_TOKEN), env);
    await flushCapture();

    expect(captured.length).toBeGreaterThan(0);
  });

  it("suppresses an agent's git traffic when its owner has opted out", async () => {
    vi.mocked(getAgentByToken).mockResolvedValue({
      success: true,
      data: { id: "agt_1", ownerId: "usr_1", name: "bot", tokenHash: "h", createdAt: "2026-01-01" },
    });
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: {
        id: "usr_1",
        email: "a@b.com",
        username: "alice",
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
        telemetryOptOut: true,
      },
    });
    const captured = stubCapture();

    await makeApp().fetch(cloneRequest("stratum_agent_bot0000000000000000000"), env);
    await flushCapture();

    expect(captured).toEqual([]);
  });
});
