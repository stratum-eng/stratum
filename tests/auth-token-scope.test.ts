/**
 * Issue #254: read-only tokens over the HTTP API.
 *
 * The rule lives in `authMiddleware`, before routing, so no write route has to
 * remember to check it and a route added later inherits it. It is an ALLOW-LIST
 * — only GET and HEAD are reads — because a deny-list of the four common write
 * verbs fails *open* on the fifth.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

const READ_TOKEN = "stratum_user_11111111111111111111111111111111";
const WRITE_TOKEN = "stratum_user_22222222222222222222222222222222";
const LEGACY_TOKEN = "stratum_user_33333333333333333333333333333333";

const touched = vi.fn(async () => {});

vi.mock("../src/storage/api-tokens", () => ({
  touchApiTokenLastUsed: (...args: unknown[]) => touched(...(args as [])),
  resolveApiToken: vi.fn(async (_db: unknown, token: string) => {
    const scope = token === READ_TOKEN ? "read" : token === WRITE_TOKEN ? "read_write" : null;
    if (scope === null) return { success: false, error: { code: "NOT_FOUND", statusCode: 404 } };
    return {
      success: true,
      data: {
        user: { id: "usr_1", email: "u@x.io", username: "u" },
        scope,
        tokenId: `tok_${scope}`,
      },
    };
  }),
}));

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db: unknown, token: string) =>
    token === LEGACY_TOKEN
      ? { success: true, data: { id: "usr_1", email: "u@x.io", username: "u" } }
      : { success: false, error: { message: "not found" } },
  ),
  getUser: vi.fn(),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: {} })),
}));
vi.mock("../src/storage/sessions", () => ({ getSession: vi.fn(), deleteSession: vi.fn() }));

import { authMiddleware } from "../src/middleware/auth";

const env = { DB: {} } as unknown as Env;

/** A tiny app that echoes the resolved scope, so each test can see what the
 * middleware decided rather than inferring it from a route's behaviour. */
function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.all("/probe", (c) =>
    c.json({
      userId: c.get("userId"),
      scope: c.get("tokenScope") ?? null,
      apiTokenId: c.get("apiTokenId") ?? null,
    }),
  );
  return app;
}

async function call(method: string, token: string): Promise<Response> {
  // `app.fetch` is typed `Response | Promise<Response>`; awaiting normalises it.
  return await makeApp().fetch(
    new Request("http://localhost/probe", {
      method,
      headers: { Authorization: `Bearer ${token}` },
      ...(method === "GET" || method === "HEAD" ? {} : { body: "" }),
    }),
    env,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("a read-only token", () => {
  it.each(["GET", "HEAD"])("passes on %s", async (method) => {
    const res = await call(method, READ_TOKEN);
    expect(res.status).toBe(200);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("is refused on %s", async (method) => {
    const res = await call(method, READ_TOKEN);
    expect(res.status).toBe(403);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "TOKEN_SCOPE_INSUFFICIENT",
    });
  });

  it("is refused on an UNRECOGNISED method, because the rule is an allow-list", async () => {
    // A deny-list of the four verbs above would let this through. The safe
    // direction to be wrong in is treating an unknown method as a write.
    const res = await call("PURGE", READ_TOKEN);
    expect(res.status).toBe(403);
  });
});

describe("write-capable credentials", () => {
  it.each(["POST", "DELETE"])("a read_write token passes on %s", async (method) => {
    const res = await call(method, WRITE_TOKEN);
    expect(res.status).toBe(200);
    expect((await res.json()) as { scope: string }).toMatchObject({ scope: "read_write" });
  });

  it("the legacy credential still writes, so this deploys without an outage", async () => {
    const res = await call("POST", LEGACY_TOKEN);
    expect(res.status).toBe(200);
    expect((await res.json()) as { scope: string }).toMatchObject({ scope: "read_write" });
  });
});

describe("last-used recording", () => {
  it("records for a scoped token", async () => {
    await call("GET", READ_TOKEN);
    expect(touched).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ tokenId: "tok_read" }),
    );
  });

  it("does not record for the legacy credential, which has no row", async () => {
    await call("GET", LEGACY_TOKEN);
    expect(touched).not.toHaveBeenCalled();
  });

  it("does not throw when no ExecutionContext was supplied", async () => {
    // `c.executionCtx` THROWS rather than returning undefined in this shape,
    // which is every `app.fetch(request, env)` test in this repo.
    await expect(call("GET", READ_TOKEN)).resolves.toBeDefined();
  });
});

describe("an invalid token", () => {
  it("is a 401, not a scope error", async () => {
    const res = await call("GET", "stratum_user_00000000000000000000000000000000");
    expect(res.status).toBe(401);
  });
});

describe("scoped tokens are distinguishable from the legacy credential", () => {
  // Both resolve to `read_write`, so `tokenScope` cannot tell them apart. The
  // routes that mint the never-expiring legacy key key on `apiTokenId` instead;
  // if the middleware stopped setting it, that guard would silently pass
  // everyone and the containment property would be gone with no test red.
  async function probe(
    token: string,
  ): Promise<{ scope: string | null; apiTokenId: string | null }> {
    const res = await makeApp().fetch(
      new Request("http://localhost/probe", { headers: { Authorization: `Bearer ${token}` } }),
      env,
    );
    return (await res.json()) as { scope: string | null; apiTokenId: string | null };
  }

  it("sets apiTokenId for a scoped token", async () => {
    await expect(probe(WRITE_TOKEN)).resolves.toMatchObject({
      scope: "read_write",
      apiTokenId: "tok_read_write",
    });
  });

  it("leaves apiTokenId unset for the legacy credential", async () => {
    await expect(probe(LEGACY_TOKEN)).resolves.toMatchObject({
      scope: "read_write",
      apiTokenId: null,
    });
  });
});
