/**
 * #257: the per-user opt-out surface.
 *
 * `vitest.config.ts` restricts coverage to `src/**\/*.ts`, so the `.tsx` route
 * and the Settings page contribute nothing to the ratchet. These assertions are
 * the only thing policing this half of the feature — keep them explicit.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";
import { AppError } from "../src/utils/errors";

vi.mock("../src/storage/users", () => ({
  getUser: vi.fn(),
  rotateUserToken: vi.fn(),
  disableLegacyToken: vi.fn(),
  setUserTelemetryOptOut: vi.fn(),
}));
// Spread the real module and override only what touches D1. Listing the
// exports by hand silently drops any added later — `isExpired`, which the page
// calls to count active tokens, would arrive as undefined and 500 the render.
vi.mock("../src/storage/api-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/api-tokens")>()),
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(async () => ({ success: true, data: [] })),
  revokeApiToken: vi.fn(),
}));
vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));
vi.mock("../src/storage/agents", () => ({
  listAgents: vi.fn(async () => ({ success: true, data: [] })),
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  getAgent: vi.fn(),
}));

import { uiRouter } from "../src/routes/ui";
import { recordAudit } from "../src/storage/audit";
import { getUser, setUserTelemetryOptOut } from "../src/storage/users";

const liveUser = {
  id: "usr_1",
  email: "a@b.com",
  username: "alice",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const env = {
  ARTIFACTS: {} as Env["ARTIFACTS"],
  STATE: {} as KVNamespace,
  DB: {} as D1Database,
} as Env;

/**
 * Mounts the UI router behind a stub that supplies an authenticated userId.
 *
 * `authVia` is part of the stub because #254 made `GET /settings` session-only:
 * the page lists token metadata, so an API token that could render it would be
 * a weaker second door to what the JSON routes already refuse it. `via` is
 * separate from `userId` so a test can authenticate as a token caller.
 */
// `null`, not `undefined`, marks the anonymous case: `undefined` would trigger
// the default parameter and silently authenticate the request.
function makeApp(userId: string | null = "usr_1", via: "session" | "token" = "session") {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (userId) {
      c.set("userId", userId);
      c.set("authVia", via);
    }
    await next();
  });
  app.route("/", uiRouter);
  return app;
}

function post(body: Record<string, string> | null): Request {
  return new Request("http://localhost/settings/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body ? new URLSearchParams(body).toString() : "",
  });
}

describe("POST /settings/telemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUser).mockResolvedValue({ success: true, data: liveUser });
    vi.mocked(setUserTelemetryOptOut).mockResolvedValue({ success: true, data: undefined });
  });

  it("opts the user IN when the checkbox is checked", async () => {
    const res = await makeApp().fetch(post({ analytics: "on" }), env);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings");
    expect(setUserTelemetryOptOut).toHaveBeenCalledWith(env.DB, "usr_1", false, expect.anything());
  });

  it("opts the user OUT when the checkbox is absent — an unchecked box submits nothing", async () => {
    await makeApp().fetch(post({}), env);

    expect(setUserTelemetryOptOut).toHaveBeenCalledWith(env.DB, "usr_1", true, expect.anything());
  });

  it("opts OUT rather than IN on an unexpected field value", async () => {
    // A renderer that grew a `value="1"` attribute must not silently read as
    // opted in; the affirmative is spelled exactly "on".
    await makeApp().fetch(post({ analytics: "1" }), env);

    expect(setUserTelemetryOptOut).toHaveBeenCalledWith(env.DB, "usr_1", true, expect.anything());
  });

  it("opts OUT on an empty body", async () => {
    await makeApp().fetch(post(null), env);

    expect(setUserTelemetryOptOut).toHaveBeenCalledWith(env.DB, "usr_1", true, expect.anything());
  });

  it("leaves the preference untouched when the body cannot be parsed at all", async () => {
    // Hono's parseBody calls formData(), which rejects on a malformed multipart
    // payload. That propagates past the handler — so an unreadable body is
    // REJECTED, not silently read as an opt-out. Worth pinning: the opposite
    // (writing opt-out on garbage input) would let any malformed request mutate
    // a user's stored preference.
    const app = makeApp();
    app.onError((_err, c) => c.text("boom", 500));
    const res = await app.fetch(
      new Request("http://localhost/settings/telemetry", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=----nope" },
        body: "not actually multipart",
      }),
      env,
    );

    expect(res.status).toBe(500);
    expect(setUserTelemetryOptOut).not.toHaveBeenCalled();
  });

  it("records an audit entry carrying which way the preference went", async () => {
    await makeApp().fetch(post({}), env);

    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.anything(),
      expect.objectContaining({
        action: "telemetry.preference_changed",
        actorType: "user",
        actorId: "usr_1",
        detail: { optOut: true },
      }),
    );
  });

  it("renders 500 instead of redirecting when the write fails", async () => {
    vi.mocked(setUserTelemetryOptOut).mockResolvedValue({
      success: false,
      error: new AppError("nope", "STORAGE_ERROR", 500, {}),
    });

    const res = await makeApp().fetch(post({ analytics: "on" }), env);

    // A redirect would re-render Settings from the unchanged row, showing the
    // old value as though the save had succeeded.
    expect(res.status).toBe(500);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("redirects an unauthenticated caller to login without touching storage", async () => {
    const res = await makeApp(null).fetch(post({ analytics: "on" }), env);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/login");
    expect(setUserTelemetryOptOut).not.toHaveBeenCalled();
  });
});

describe("GET /settings — privacy card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setUserTelemetryOptOut).mockResolvedValue({ success: true, data: undefined });
  });

  async function renderSettings(telemetryOptOut: boolean | undefined): Promise<string> {
    vi.mocked(getUser).mockResolvedValue({
      success: true,
      data: telemetryOptOut === undefined ? liveUser : { ...liveUser, telemetryOptOut },
    });
    const res = await makeApp().fetch(new Request("http://localhost/settings"), env);
    expect(res.status).toBe(200);
    return await res.text();
  }

  it("checks the box for a user who has not opted out", async () => {
    const html = await renderSettings(undefined);

    expect(html).toContain('name="analytics"');
    expect(html).toContain("checked");
  });

  it("unchecks the box for a user who has opted out", async () => {
    const html = await renderSettings(true);

    expect(html).toContain('name="analytics"');
    expect(html).not.toContain("checked");
  });

  it("omits a value attribute so browsers submit the expected 'on'", async () => {
    const html = await renderSettings(undefined);

    const checkbox = /<input[^>]*name="analytics"[^>]*>/.exec(html)?.[0] ?? "";
    expect(checkbox).not.toContain("value=");
  });

  it("discloses what is sent and does not promise deletion", async () => {
    const html = await renderSettings(undefined);

    expect(html).toContain("api_request");
    expect(html).toContain("route pattern");
    expect(html).toContain("does not delete events already sent");
  });

  it("reads the row once — the page identity and the preference share a lookup", async () => {
    await renderSettings(undefined);

    expect(getUser).toHaveBeenCalledTimes(1);
  });
});
