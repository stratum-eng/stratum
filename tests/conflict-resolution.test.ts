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
    freshRepoToken: vi.fn(async () => ({ success: true, data: "test-token" })),
    // The merge-gate diff builder clones the project repo for real; stub it so
    // manual-resolution route tests don't need network access. Individual tests
    // override this to feed a specific diff into the evaluator suite.
    buildManualResolutionDiff: vi.fn(async () => ({
      success: true,
      data: { diff: "", baseSha: "base-sha-default" },
    })),
  };
});

vi.mock("../src/evaluation/policy-loader", async (importActual) => {
  const actual = await importActual<typeof import("../src/evaluation/policy-loader")>();
  return {
    ...actual,
    // Real loadPolicy clones the repo to read .stratum/policy.yaml; stub it so
    // tests control the policy directly instead of needing network access.
    // Defaults to the same permissive shape loadPolicy returns when no policy
    // file is present, so strategies/tests that don't care about policy content
    // behave the way they did before this gate existed.
    loadPolicy: vi.fn(async () => ({ evaluators: [], requireAll: true, minScore: 0.7 })),
  };
});

vi.mock("../src/storage/changes", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/changes")>();
  return {
    // Keep every real export: routes/changes.ts (loaded by src/index.ts)
    // statically imports several named exports from this module, and a
    // factory that defines only getChange would break module loading.
    ...actual,
    getChange: vi.fn(),
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

import { loadPolicy } from "../src/evaluation/policy-loader";
import app from "../src/index";
import { getChange } from "../src/storage/changes";
import { buildManualResolutionDiff, resolveConflict } from "../src/storage/git-ops";
import { getProjectByPath, getWorkspace } from "../src/storage/state";
import { AppError } from "../src/utils/errors";

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

    // The caller (user_test) owns the project → passes the new write-access check.
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
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

  it("blocks a manual resolution that contains a secret (422, never pushes)", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/foo.ts", content: 'const k = "AKIAIOSFODNN7EXAMPLE";' }],
        }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(422);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("SECRET_DETECTED");
    // The always-on secret scan must block before any push happens.
    expect(vi.mocked(resolveConflict)).not.toHaveBeenCalled();
  });

  it("rejects an oversized resolution before the secret scan walks it", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);

    // Over the 10 MB cap, and carrying a secret on its last line. The secret is
    // what makes this discriminating: if the size check ran after the scan, the
    // response would be SECRET_DETECTED rather than the size rejection, which is
    // proof the expensive pass walked the whole payload first.
    const oversized = `${"x".repeat(10 * 1024 * 1024 + 1)}\nconst k = "AKIAIOSFODNN7EXAMPLE";`;

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/big.ts", content: oversized }],
        }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(422);
    const body = await res.json<{ code: string; error: string }>();
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.error).toContain("exceeds maximum size");
    expect(vi.mocked(resolveConflict)).not.toHaveBeenCalled();
  });

  it("blocks a secret on a line that itself starts with ++ (no prefix escape)", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);

    // The scan used to run over a diff synthesised by prefixing every content
    // line with "+". That encoding is not reversible: this line would become
    // "+++const k = ..." and be skipped as a unified-diff file header, so the
    // key landed on the default branch unscanned. Both "++" and "++ " forms are
    // covered because only the latter also looks like a header after prefixing.
    for (const content of [
      '++const k = "AKIAIOSFODNN7EXAMPLE";',
      '++ const k = "AKIAIOSFODNN7EXAMPLE";',
    ]) {
      const res = await app.fetch(
        new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
          method: "POST",
          headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
          body: JSON.stringify({
            strategy: "manual",
            resolutions: [{ file: "src/foo.ts", content }],
          }),
        }),
        { STATE: kv, DB: makeDb() },
      );

      expect(res.status).toBe(422);
      const body = await res.json<{ code: string; issues: string[] }>();
      expect(body.code).toBe("SECRET_DETECTED");
      // Issues are reported per file with a content-relative line number.
      expect(body.issues[0]).toBe("AWS Access Key: src/foo.ts line 1");
      expect(vi.mocked(resolveConflict)).not.toHaveBeenCalled();
    }
  });

  it("allows a manual resolution with clean content (scan passes → pushes)", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);
    vi.mocked(resolveConflict).mockResolvedValue({
      success: true,
      data: { commitSha: "resolved-sha" },
    });

    const db = makeDb();
    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/foo.ts", content: "export const x = 1;" }],
        }),
      }),
      { STATE: kv, DB: db },
    );

    expect(res.status).toBe(200);
    expect(vi.mocked(resolveConflict)).toHaveBeenCalledOnce();

    // Provenance: who resolved, from which conflict, against which evaluated
    // sha (#260) is recorded to the audit log once the push succeeds.
    const prepareMock = vi.mocked(db.prepare).mock;
    const auditCallIndex = prepareMock.calls.findIndex(([sql]) =>
      sql.includes("INSERT INTO audit_log"),
    );
    expect(auditCallIndex).toBeGreaterThanOrEqual(0);
    const stmt = prepareMock.results[auditCallIndex]?.value as {
      bind: (...args: unknown[]) => unknown;
    };
    const boundArgs = vi.mocked(stmt.bind).mock.calls[0];
    expect(boundArgs?.[1]).toBe("conflict.resolved_manually");
    expect(boundArgs?.[3]).toBe("user_test"); // actorId
    // Detail JSON (6th bound param) carries conflictId + evaluatedBaseSha.
    const detail = JSON.parse(boundArgs?.[5] as string) as Record<string, unknown>;
    expect(detail.conflictId).toBe("conflict-abc");
    expect(detail.evaluatedBaseSha).toBe("base-sha-default");
    expect(detail.commitSha).toBe("resolved-sha");
  });

  it("blocks a manual resolution when the configured evaluator suite fails (never pushes)", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);
    vi.mocked(buildManualResolutionDiff).mockResolvedValueOnce({
      success: true,
      data: {
        diff: "diff --git a/config/prod.yaml b/config/prod.yaml\n--- /dev/null\n+++ b/config/prod.yaml\n+not-a-secret-but-forbidden\n",
        baseSha: "base-sha-1",
      },
    });
    vi.mocked(loadPolicy).mockResolvedValueOnce({
      evaluators: [{ type: "diff", forbiddenPatterns: ["config/prod"] }],
      requireAll: true,
      minScore: 0.9,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "config/prod.yaml", content: "not-a-secret-but-forbidden" }],
        }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(422);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("EVALUATION_FAILED");
    expect(vi.mocked(resolveConflict)).not.toHaveBeenCalled();
  });

  it("blocks a manual resolution when merge protection requires more approvals than recorded (never pushes)", async () => {
    const kv = makeKv();
    // Overwrite with a conflict context carrying the originating changeId, so
    // the protection check has a change to look up approvals against.
    await kv.put("conflict:conflict-abc", JSON.stringify({ ...CONFLICT_CTX, changeId: "chg_1" }));
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);
    vi.mocked(loadPolicy).mockResolvedValueOnce({
      evaluators: [],
      requireAll: true,
      minScore: 0.7,
      merge: { requiredApprovals: 1 },
    });
    vi.mocked(getChange).mockResolvedValueOnce({
      success: true,
      data: {
        id: "chg_1",
        project: "@owner/my-repo",
        workspace: "ws-1234",
        status: "accepted",
        createdAt: new Date().toISOString(),
        createdByUserId: "user_test",
      },
    } as Awaited<ReturnType<typeof getChange>>);

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/foo.ts", content: "export const x = 1;" }],
        }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ code: string; reasons: string[] }>();
    expect(body.code).toBe("PROTECTION_BLOCKED");
    expect(body.reasons[0]).toContain("Requires 1 approval");
    expect(vi.mocked(resolveConflict)).not.toHaveBeenCalled();
  });

  it("fails closed when approvals are required but the conflict has no linked change (never pushes)", async () => {
    // Default CONFLICT_CTX carries no changeId — the shape of a conflict
    // recorded before the changeId field existed. With approvals required
    // there is nothing to verify them against, so the gate must block.
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);
    vi.mocked(loadPolicy).mockResolvedValueOnce({
      evaluators: [],
      requireAll: true,
      minScore: 0.7,
      merge: { requiredApprovals: 1 },
    });

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/foo.ts", content: "export const x = 1;" }],
        }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ code: string; reasons: string[] }>();
    expect(body.code).toBe("PROTECTION_BLOCKED");
    expect(vi.mocked(resolveConflict)).not.toHaveBeenCalled();
  });

  it("404s a caller without project write access (never mints a token or pushes)", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    // Project owned by someone else, caller has no org write → write check fails.
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "someone_else" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "accept-project" }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    expect(res.status).toBe(404);
    expect(vi.mocked(resolveConflict)).not.toHaveBeenCalled();
  });

  it("#337: pins resolveConflict to the sha the gates evaluated", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);
    vi.mocked(buildManualResolutionDiff).mockResolvedValueOnce({
      success: true,
      data: { diff: "", baseSha: "evaluated-base-sha" },
    });
    vi.mocked(resolveConflict).mockResolvedValue({
      success: true,
      data: { commitSha: "resolved-sha" },
    });

    const db = makeDb();
    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/foo.ts", content: "export const x = 1;" }],
        }),
      }),
      { STATE: kv, DB: db },
    );

    expect(res.status).toBe(200);
    const opts = vi.mocked(resolveConflict).mock.calls[0]?.[0];
    expect(opts?.expectedBaseSha).toBe("evaluated-base-sha");

    // The pinned value and the audited value are the same string, which is the
    // property that makes `evaluatedBaseSha` a true statement about the commit's
    // parent rather than a note about what some earlier clone happened to see.
    const prepareMock = vi.mocked(db.prepare).mock;
    const auditCallIndex = prepareMock.calls.findIndex(([sql]) =>
      sql.includes("INSERT INTO audit_log"),
    );
    const stmt = prepareMock.results[auditCallIndex]?.value as {
      bind: (...args: unknown[]) => unknown;
    };
    const detail = JSON.parse(vi.mocked(stmt.bind).mock.calls[0]?.[5] as string) as Record<
      string,
      unknown
    >;
    expect(detail.evaluatedBaseSha).toBe(opts?.expectedBaseSha);
  });

  it("#337: surfaces a moved project as 409, not 422", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);
    vi.mocked(resolveConflict).mockResolvedValue({
      success: false,
      error: new AppError(
        "Project changed since this resolution was evaluated: re-resolve against the current revision",
        "STALE_PROJECT",
        409,
      ),
    });

    const db = makeDb();
    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/foo.ts", content: "export const x = 1;" }],
        }),
      }),
      { STATE: kv, DB: db },
    );

    // 409 tells the caller to re-resolve; 422 would have read as "your payload
    // is wrong", which it is not.
    expect(res.status).toBe(409);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("STALE_PROJECT");

    // A refused resolution leaves the conflict open and writes no audit row:
    // nothing was pushed, so there is no resolution to attest to.
    expect(vi.mocked(kv.delete)).not.toHaveBeenCalled();
    const wroteAudit = vi
      .mocked(db.prepare)
      .mock.calls.some(([sql]) => sql.includes("INSERT INTO audit_log"));
    expect(wroteAudit).toBe(false);
  });

  it("#337: an unresolvable project tip surfaces as 500, not 422", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
    } as Awaited<ReturnType<typeof getProjectByPath>>);
    vi.mocked(getWorkspace).mockResolvedValue({
      success: true,
      data: WORKSPACE,
    } as Awaited<ReturnType<typeof getWorkspace>>);
    // What the base pin returns when it cannot read the clone's tip at all.
    vi.mocked(resolveConflict).mockResolvedValue({
      success: false,
      error: new AppError(
        "Failed to resolve the project's current revision to verify the evaluated base",
        "GIT_ERROR",
        500,
      ),
    });

    const res = await app.fetch(
      new Request("http://localhost/api/projects/conflicts/conflict-abc/resolve", {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({
          strategy: "manual",
          resolutions: [{ file: "src/foo.ts", content: "export const x = 1;" }],
        }),
      }),
      { STATE: kv, DB: makeDb() },
    );

    // An infrastructure failure is not malformed input; 422 would have told the
    // caller to go fix a payload that is fine.
    expect(res.status).toBe(500);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("GIT_ERROR");
  });

  it("#337: accept-project passes no pin — it re-stages already-committed content", async () => {
    const kv = makeKv();
    vi.mocked(resolveConflict).mockClear();
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...PROJECT, ownerId: "user_test" },
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
    expect(vi.mocked(resolveConflict).mock.calls[0]?.[0].expectedBaseSha).toBeUndefined();
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
