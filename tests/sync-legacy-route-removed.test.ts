/**
 * SEC-1 regression: the unauthenticated legacy sync route
 * `POST /api/projects/:name/sync` (single path segment, no namespace) was
 * removed. It previously let any unauthenticated caller repoint a project's
 * githubUrl and trigger a destructive re-import.
 *
 * This asserts the legacy name-based path is no longer routable, and that no
 * other `/api` router accidentally re-defines the pattern. The authenticated,
 * namespaced route `/api/projects/:namespace/:slug/sync` is exercised
 * elsewhere (sync-endpoint-redirect.test.ts).
 */
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  getUserByEmail: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  createUser: vi.fn(),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

function makeEnv(): Env {
  return {
    ARTIFACTS: {
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      // If the removed handler were still wired, an import would fire here.
      import: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
    } as unknown as KVNamespace,
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true, results: [], meta: {} }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
      })),
    } as unknown as D1Database,
  } as unknown as Env;
}

describe("SEC-1: legacy unauthenticated sync route is removed", () => {
  it("POST /api/projects/:name/sync is not routable (404) and imports nothing", async () => {
    const env = makeEnv();
    const res = await app.fetch(
      new Request("http://localhost/api/projects/somename/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUrl: "https://github.com/attacker/evil" }),
      }),
      env,
    );

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(200);
    expect(
      (env.ARTIFACTS as unknown as { import: ReturnType<typeof vi.fn> }).import,
    ).not.toHaveBeenCalled();
  });
});
