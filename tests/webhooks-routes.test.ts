import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { webhooksRouter } from "../src/routes/webhooks";
import type { Env, ProjectEntry } from "../src/types";

// Keep the real webhookBelongsToProject (the route's ownership logic under test);
// stub only the D1-backed storage calls.
vi.mock("../src/storage/webhooks", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/webhooks")>();
  return {
    ...actual,
    createWebhook: vi.fn(),
    listWebhooks: vi.fn(),
    getWebhook: vi.fn(),
    listDeliveries: vi.fn(),
    deleteWebhook: vi.fn(),
    setWebhookActive: vi.fn(),
  };
});
vi.mock("../src/storage/state", () => ({ getProjectByPath: vi.fn() }));
vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../src/storage/users", () => ({ getUserByToken: vi.fn(), getUser: vi.fn() }));

import { getProjectByPath } from "../src/storage/state";
import { getUserByToken } from "../src/storage/users";
import {
  type Webhook,
  createWebhook,
  deleteWebhook,
  getWebhook,
  listDeliveries,
  listWebhooks,
} from "../src/storage/webhooks";

const AUTH = { Authorization: "Bearer stratum_user_testtoken00000000000000000" };

// Two same-named projects in different namespaces — the cross-tenant collision.
const ALICE: ProjectEntry = {
  id: "proj_alice",
  name: "api",
  slug: "api",
  namespace: "@alice",
  ownerId: "user_test",
  ownerType: "user",
  remote: "https://acct.artifacts.cloudflare.net/git/@alice/api.git",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function webhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: "wh_1",
    project: "api",
    projectId: "proj_alice",
    url: "https://alice.example.com/hook",
    secret: "stm_whsec_abcdef",
    events: "*",
    active: true,
    createdBy: "user_test",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/", webhooksRouter);
  return app;
}

const env = { DB: {} as D1Database, STATE: {} as KVNamespace } as Env;

describe("webhook management routes — project-id scoping (SA-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: {
        id: "user_test",
        email: "t@x.io",
        username: "test",
        tokenHash: "h",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: ALICE });
  });

  it("lists webhooks scoped by project id and strips the signing secret", async () => {
    vi.mocked(listWebhooks).mockResolvedValue({ success: true, data: [webhook()] });

    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks", { headers: AUTH }),
      env,
    );

    expect(res.status).toBe(200);
    // The list must be scoped by the unique project id. The name is not passed
    // at all (#235 step 3), so a name-scoped lookup is not expressible.
    expect(listWebhooks).toHaveBeenCalledWith(env.DB, expect.any(Object), "proj_alice");
    const body = (await res.json()) as { webhooks: Array<Record<string, unknown>> };
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0]).not.toHaveProperty("secret");
  });

  it("404s a delete of a webhook that belongs to a same-named project in another namespace", async () => {
    // Victim's webhook: same project name "api", different id.
    vi.mocked(getWebhook).mockResolvedValue({
      success: true,
      data: webhook({ id: "wh_victim", projectId: "proj_bob" }),
    });

    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks/wh_victim", {
        method: "DELETE",
        headers: AUTH,
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it("404s reading deliveries of a cross-tenant webhook", async () => {
    vi.mocked(getWebhook).mockResolvedValue({
      success: true,
      data: webhook({ id: "wh_victim", projectId: "proj_bob" }),
    });

    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks/wh_victim/deliveries", { headers: AUTH }),
      env,
    );

    expect(res.status).toBe(404);
    expect(listDeliveries).not.toHaveBeenCalled();
  });

  it("deletes a webhook that genuinely belongs to the project", async () => {
    vi.mocked(getWebhook).mockResolvedValue({ success: true, data: webhook() });
    vi.mocked(deleteWebhook).mockResolvedValue({ success: true, data: undefined });

    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks/wh_1", {
        method: "DELETE",
        headers: AUTH,
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(deleteWebhook).toHaveBeenCalledWith(env.DB, expect.any(Object), "wh_1");
  });

  it("404s a toggle of a cross-tenant webhook", async () => {
    vi.mocked(getWebhook).mockResolvedValue({
      success: true,
      data: webhook({ id: "wh_victim", projectId: "proj_bob" }),
    });

    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks/wh_victim/toggle", {
        method: "POST",
        headers: AUTH,
      }),
      env,
    );

    expect(res.status).toBe(404);
  });

  it("404s a form-post delete of a cross-tenant webhook", async () => {
    vi.mocked(getWebhook).mockResolvedValue({
      success: true,
      data: webhook({ id: "wh_victim", projectId: "proj_bob" }),
    });

    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks/wh_victim/delete", {
        method: "POST",
        headers: AUTH,
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it("shows the signing secret once when a webhook is created via the HTML form", async () => {
    vi.mocked(createWebhook).mockResolvedValue({
      success: true,
      data: webhook({ secret: "stm_whsec_deadbeefdeadbeefdeadbeefdeadbeef" }),
    });

    const form = new URLSearchParams({ url: "https://hooks.example.com/x" });
    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      env,
    );

    expect(res.status).toBe(201);
    const html = await res.text();
    // The secret is delivered exactly once on creation, not via a redirect to the
    // redacted management page.
    expect(html).toContain("stm_whsec_deadbeefdeadbeefdeadbeefdeadbeef");
    expect(html).toContain("will not be shown again");
    // The only response that ever carries the secret must not be storable —
    // `no-store`, not merely `no-cache`, which still permits storage.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("marks the JSON creation response no-store too — it also returns the secret", async () => {
    vi.mocked(createWebhook).mockResolvedValue({
      success: true,
      data: webhook({ secret: "stm_whsec_0123456789abcdef0123456789abcdef" }),
    });

    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://hooks.example.com/x" }),
      }),
      env,
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { webhook: { secret?: string } };
    // The JSON body carries the secret, which is why the header cannot live on
    // the HTML branch alone.
    expect(body.webhook.secret).toBe("stm_whsec_0123456789abcdef0123456789abcdef");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("#235: rejects a legacy webhook with no project_id instead of name-matching it", async () => {
    vi.mocked(getWebhook).mockResolvedValue({
      success: true,
      data: webhook({ id: "wh_legacy", projectId: undefined }),
    });
    vi.mocked(deleteWebhook).mockResolvedValue({ success: true, data: undefined });

    const res = await makeApp().fetch(
      new Request("http://localhost/@alice/api/webhooks/wh_legacy", {
        method: "DELETE",
        headers: AUTH,
      }),
      env,
    );

    // The name fallback is gone: an unstamped row belongs to no project, so it
    // is unreachable rather than reachable by whoever shares the name. The
    // admin backfill exists to stamp these before they get here.
    expect(res.status).toBe(404);
    expect(deleteWebhook).not.toHaveBeenCalled();
  });
});
