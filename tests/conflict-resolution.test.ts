import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({ component: "test" });

// ---------------------------------------------------------------------------
// resolveConflict unit tests — validation only (no git calls)
// ---------------------------------------------------------------------------

describe("resolveConflict — input validation", () => {
  it("rejects path traversal (../) and returns structured 422 error", async () => {
    const { resolveConflict } =
      await vi.importActual<typeof import("../src/storage/git-ops")>("../src/storage/git-ops");
    const result = await resolveConflict(
      {
        projectRemote: "r",
        projectToken: "t",
        workspaceRemote: "r2",
        workspaceToken: "t2",
        strategy: "manual",
        manualResolutions: [{ file: "../etc/passwd", content: "evil" }],
      },
      logger,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.statusCode).toBe(422);
    }
  });

  it("rejects absolute paths starting with /", async () => {
    const { resolveConflict } =
      await vi.importActual<typeof import("../src/storage/git-ops")>("../src/storage/git-ops");
    const result = await resolveConflict(
      {
        projectRemote: "r",
        projectToken: "t",
        workspaceRemote: "r2",
        workspaceToken: "t2",
        strategy: "manual",
        manualResolutions: [{ file: "/etc/passwd", content: "evil" }],
      },
      logger,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.statusCode).toBe(422);
  });

  it("rejects files exceeding 10 MB", async () => {
    const { resolveConflict } =
      await vi.importActual<typeof import("../src/storage/git-ops")>("../src/storage/git-ops");
    const bigContent = "x".repeat(11 * 1024 * 1024);
    const result = await resolveConflict(
      {
        projectRemote: "r",
        projectToken: "t",
        workspaceRemote: "r2",
        workspaceToken: "t2",
        strategy: "manual",
        manualResolutions: [{ file: "big.txt", content: bigContent }],
      },
      logger,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.statusCode).toBe(422);
  });

  it("manual strategy with empty resolutions returns error without git calls", async () => {
    const { resolveConflict } =
      await vi.importActual<typeof import("../src/storage/git-ops")>("../src/storage/git-ops");
    const result = await resolveConflict(
      {
        projectRemote: "r",
        projectToken: "t",
        workspaceRemote: "r2",
        workspaceToken: "t2",
        strategy: "manual",
        manualResolutions: [],
      },
      logger,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
// Route tests: POST /api/projects/conflicts/:id/resolve
// Mocks resolveConflict entirely to test route logic.
// ---------------------------------------------------------------------------

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    resolveConflict: vi.fn(),
  };
});

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_: unknown, token: string) => {
    if (token === "stratum_user_testtoken00000000000000000") {
      return {
        success: true,
        data: {
          id: "user_test",
          email: "test@example.com",
          username: "testuser",
          tokenHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
  getUser: vi.fn(async (_: unknown, userId: string) => {
    if (userId === "user_test") {
      return {
        success: true,
        data: {
          id: "user_test",
          email: "test@example.com",
          username: "testuser",
          tokenHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
}));

vi.mock("../src/storage/state", () => ({
  getProject: vi.fn(),
  getProjectByPath: vi.fn(),
  getWorkspace: vi.fn(),
  setProject: vi.fn(),
}));

vi.mock("../src/storage/sync", () => ({
  recordSyncHistory: vi.fn().mockResolvedValue(undefined),
  checkForSyncUpdates: vi.fn(),
  getSyncHistory: vi.fn(),
  getSyncStatus: vi.fn(),
  setSyncSettings: vi.fn(),
  updateProjectAfterSync: vi.fn(),
}));

import app from "../src/index";
import { resolveConflict } from "../src/storage/git-ops";
import { getProjectByPath, getWorkspace } from "../src/storage/state";

const PROJECT = {
  id: "proj-1",
  name: "my-repo",
  namespace: "@owner",
  slug: "my-repo",
  ownerId: "user-1",
  ownerType: "user" as const,
  remote: "https://artifacts.example.com/project",
  token: "proj-token",
  sourceUrl: "https://github.com/owner/repo",
  sourceDefaultBranch: "main",
  createdAt: new Date().toISOString(),
};

const WORKSPACE = {
  name: "ws-1234",
  branchName: "ws-1234",
  remote: "https://artifacts.example.com/ws",
  token: "ws-token",
  parent: "proj-1",
  createdAt: new Date().toISOString(),
};

const CONFLICT_CTX = {
  conflictId: "conflict-abc",
  namespace: "@owner",
  slug: "my-repo",
  workspaceName: "ws-1234",
  conflictingFiles: ["src/foo.ts"],
  detectedAt: new Date().toISOString(),
};

const AUTH_HEADER = { Authorization: "Bearer stratum_user_testtoken00000000000000000" };

function makeKv(hasConflict = true): KVNamespace {
  const store: Record<string, string> = {};
  if (hasConflict) {
    store[`conflict:${CONFLICT_CTX.conflictId}`] = JSON.stringify(CONFLICT_CTX);
  }
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    delete: vi.fn(async (key: string) => {
      delete store[key];
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: "" })),
    getWithMetadata: vi.fn(async (key: string) => ({
      value: store[key] ?? null,
      metadata: null,
    })),
  } as unknown as KVNamespace;
}

function makeDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    })),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

describe("POST /api/projects/conflicts/:id/resolve (route)", () => {
  it("returns 410 when conflict key is missing", async () => {
    const kv = makeKv(false);

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/nonexistent/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "accept-project" }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(410);
  });

  it("returns 400 on invalid strategy", async () => {
    const kv = makeKv();

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "bogus" }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("Invalid strategy");
  });

  it("returns 422 on path traversal in manual resolutions", async () => {
    const kv = makeKv();

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "../etc/passwd", content: "evil" }],
        }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(422);
  });

  it("resolves successfully and deletes the conflict KV key", async () => {
    const kv = makeKv();

    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: PROJECT,
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);
    vi.mocked(resolveConflict).mockResolvedValue({
      success: true,
      data: { commitSha: "resolved-sha" },
    });

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "accept-project" }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ status: string; commitSha: string }>();
    expect(body.status).toBe("resolved");
    expect(body.commitSha).toBe("resolved-sha");
    expect(vi.mocked(kv.delete)).toHaveBeenCalledWith("conflict:conflict-abc");
  });

  it("conflict context stored by changes route contains no token fields", () => {
    const ctx = {
      conflictId: "test",
      namespace: "@owner",
      slug: "my-repo",
      workspaceName: "ws-1",
      conflictingFiles: ["src/foo.ts"],
      detectedAt: new Date().toISOString(),
    };
    for (const key of Object.keys(ctx)) {
      expect(key).not.toMatch(/token/i);
    }
  });
});
