import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ImportProgress, ProjectEntry } from "../src/types";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_: unknown, token: string) => {
    if (token === "stratum_user_userA_token000000000000000000") {
      return {
        success: true,
        data: {
          id: "user_A",
          email: "userA@example.com",
          username: "userA",
          tokenHash: "hashA",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    if (token === "stratum_user_userB_token000000000000000000") {
      return {
        success: true,
        data: {
          id: "user_B",
          email: "userB@example.com",
          username: "userB",
          tokenHash: "hashB",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
  getUser: vi.fn(async () => ({ success: false, error: { message: "User not found" } })),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({
    success: false,
    error: { message: "Agent not found" },
  })),
}));

/**
 * Keyed by job id, not by namespace:slug — a project legitimately owns several
 * import_jobs rows, and the delete route's whole contract is that it removes
 * exactly one of them.
 */
const jobs = new Map<string, ImportProgress>();

vi.mock("../src/storage/imports", () => ({
  getImportProgress: vi.fn(async (_db: unknown, namespace: string, slug: string) => {
    const matches = [...jobs.values()]
      .filter((j) => j.namespace === namespace && j.slug === slug)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return { success: true, data: matches[0] ?? null };
  }),
  deleteImportJobById: vi.fn(
    async (_db: unknown, id: string, allowedStatuses: readonly string[]) => {
      // Mirrors the real function's SQL guard: the status is re-checked at
      // delete time, not trusted from the route's earlier read.
      const job = jobs.get(id);
      if (!job || !allowedStatuses.includes(job.status)) {
        return { success: true, data: false };
      }
      jobs.delete(id);
      return { success: true, data: true };
    },
  ),
  deleteImportJob: vi.fn(async () => ({ success: true, data: undefined })),
  createImportJob: vi.fn(async () => ({ success: false, error: { message: "unused" } })),
  cancelImportJob: vi.fn(),
  isImportCancelled: vi.fn(async () => false),
  recoverStalledImport: vi.fn(async () => ({ success: true, data: false })),
  updateImportStatus: vi.fn(async () => ({ success: true, data: null })),
  getLatestImportDepth: vi.fn(async () => null),
  getImportById: vi.fn(async (_db: unknown, id: string) => ({
    success: true,
    data: jobs.get(id) ?? null,
  })),
  listActiveImports: vi.fn(async () => ({ success: true, data: [] })),
  STALLED_THRESHOLD_MS: 5 * 60 * 1000,
}));

// Recorded so the route's choice of limiter is assertable: the import limiter
// takes a per-project lock that only the import paths release. Hoisted because
// vi.mock factories are lifted above ordinary const declarations.
const { limitersUsed } = vi.hoisted(() => ({ limitersUsed: [] as string[] }));

vi.mock("../src/middleware/rate-limit", () => ({
  rateLimitMiddleware: vi.fn(() => {
    limitersUsed.push("rateLimitMiddleware");
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  }),
  checkImportRateLimit: vi.fn(async () => ({ allowed: true })),
  recordImportAttempt: vi.fn(),
  releaseImportLock: vi.fn(async () => {}),
  importRateLimitMiddleware: vi.fn(() => {
    limitersUsed.push("importRateLimitMiddleware");
    return async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
  }),
}));

const USER_A_HEADERS = { Authorization: "Bearer stratum_user_userA_token000000000000000000" };
const USER_B_HEADERS = { Authorization: "Bearer stratum_user_userB_token000000000000000000" };

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
  } as Env;
}

function request(method: string, path: string, headers?: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, { method, headers: headers ?? {} });
}

async function seedProject(env: Env, namespace: string, slug: string): Promise<ProjectEntry> {
  const project: ProjectEntry = {
    id: crypto.randomUUID(),
    name: slug,
    slug,
    namespace,
    ownerId: "user_A",
    ownerType: "user",
    remote: `https://artifacts.example.com/repos/${slug}`,
    createdAt: new Date().toISOString(),
    visibility: "private",
  };
  await env.STATE.put(`project:${namespace}:${slug}`, JSON.stringify(project));
  return project;
}

function seedJob(overrides: Partial<ImportProgress> & { id: string }): ImportProgress {
  const now = new Date().toISOString();
  const job: ImportProgress = {
    projectId: "prj_1",
    namespace: "@userA",
    slug: "widgets",
    status: "failed",
    sourceUrl: "https://github.com/test/repo",
    branch: "main",
    startedAt: now,
    updatedAt: now,
    version: 1,
    progress: { processedFiles: 0 },
    errors: [],
    logs: [],
    ...overrides,
  } as ImportProgress;
  jobs.set(job.id, job);
  return job;
}

describe("POST /import/delete", () => {
  beforeEach(() => {
    jobs.clear();
  });

  it("deletes a failed import", async () => {
    const env = makeEnv();
    await seedProject(env, "@userA", "widgets");
    seedJob({ id: "imp_1", status: "failed" });

    const res = await app.fetch(
      request("POST", "/api/projects/@userA/widgets/import/delete", USER_A_HEADERS),
      env,
    );

    expect(res.status).toBe(200);
    expect(jobs.has("imp_1")).toBe(false);
  });

  it("deletes a cancelled import", async () => {
    const env = makeEnv();
    await seedProject(env, "@userA", "widgets");
    seedJob({ id: "imp_1", status: "cancelled" });

    const res = await app.fetch(
      request("POST", "/api/projects/@userA/widgets/import/delete", USER_A_HEADERS),
      env,
    );

    expect(res.status).toBe(200);
    expect(jobs.has("imp_1")).toBe(false);
  });

  // A live consumer may still own the row; removing it would orphan the import.
  for (const status of ["queued", "cloning", "processing", "syncing", "cancelling"] as const) {
    it(`refuses to delete a job in '${status}' with 409`, async () => {
      const env = makeEnv();
      await seedProject(env, "@userA", "widgets");
      seedJob({ id: "imp_1", status });

      const res = await app.fetch(
        request("POST", "/api/projects/@userA/widgets/import/delete", USER_A_HEADERS),
        env,
      );

      expect(res.status).toBe(409);
      expect(jobs.has("imp_1")).toBe(true);
    });
  }

  // Deleting the completed record would take the clone-depth history with it.
  it("refuses to delete a completed import with 409", async () => {
    const env = makeEnv();
    await seedProject(env, "@userA", "widgets");
    seedJob({ id: "imp_1", status: "completed" });

    const res = await app.fetch(
      request("POST", "/api/projects/@userA/widgets/import/delete", USER_A_HEADERS),
      env,
    );

    expect(res.status).toBe(409);
    expect(jobs.has("imp_1")).toBe(true);
  });

  it("removes only the targeted job, leaving sibling rows intact", async () => {
    const env = makeEnv();
    await seedProject(env, "@userA", "widgets");
    seedJob({ id: "imp_old", status: "completed", startedAt: "2020-01-01T00:00:00.000Z" });
    seedJob({ id: "imp_recent", status: "failed", startedAt: "2026-01-01T00:00:00.000Z" });

    const res = await app.fetch(
      request("POST", "/api/projects/@userA/widgets/import/delete", USER_A_HEADERS),
      env,
    );

    expect(res.status).toBe(200);
    expect(jobs.has("imp_recent")).toBe(false);
    expect(jobs.has("imp_old")).toBe(true);
  });

  it("rejects a delete from another user's namespace", async () => {
    const env = makeEnv();
    await seedProject(env, "@userA", "widgets");
    seedJob({ id: "imp_1", status: "failed" });

    const res = await app.fetch(
      request("POST", "/api/projects/@userA/widgets/import/delete", USER_B_HEADERS),
      env,
    );

    expect(res.status).toBe(403);
    expect(jobs.has("imp_1")).toBe(true);
  });

  it("requires authentication", async () => {
    const env = makeEnv();
    await seedProject(env, "@userA", "widgets");
    seedJob({ id: "imp_1", status: "failed" });

    const res = await app.fetch(request("POST", "/api/projects/@userA/widgets/import/delete"), env);

    expect(res.status).toBe(401);
    expect(jobs.has("imp_1")).toBe(true);
  });

  it("returns 404 when there is no import job", async () => {
    const env = makeEnv();
    await seedProject(env, "@userA", "widgets");

    const res = await app.fetch(
      request("POST", "/api/projects/@userA/widgets/import/delete", USER_A_HEADERS),
      env,
    );

    expect(res.status).toBe(404);
  });

  // Regression: the route originally used importRateLimitMiddleware, which
  // takes a per-project import lock with a TTL that only the import paths
  // release — so clearing a dead job 429'd the retry the user was about to make.
  it("does not take the import concurrency lock", () => {
    expect(limitersUsed).toContain("rateLimitMiddleware");
  });

  it("is inert on a double submit", async () => {
    const env = makeEnv();
    await seedProject(env, "@userA", "widgets");
    seedJob({ id: "imp_1", status: "failed" });

    const first = await app.fetch(
      request("POST", "/api/projects/@userA/widgets/import/delete", USER_A_HEADERS),
      env,
    );
    const second = await app.fetch(
      request("POST", "/api/projects/@userA/widgets/import/delete", USER_A_HEADERS),
      env,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(404);
  });
});
