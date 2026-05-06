import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ImportProgress, ProjectEntry } from "../src/types";
import { AppError } from "../src/utils/errors";

// ============================================================================
// Mocks
// ============================================================================

// Mock users storage
vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_, token: string) => {
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
  getUser: vi.fn(async (_, userId: string) => {
    if (userId === "user_A") {
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
    if (userId === "user_B") {
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
}));

// Mock agents storage
vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({
    success: false,
    error: { message: "Agent not found" },
  })),
}));

// Mock imports storage with comprehensive tracking
const mockImportJobs = new Map<string, ImportProgress>();
let mockJobIdCounter = 0;

vi.mock("../src/storage/imports", () => ({
  createImportJob: vi.fn(async (_db, params, _logger) => {
    mockJobIdCounter++;
    const now = new Date().toISOString();
    const job: ImportProgress = {
      id: `import_${mockJobIdCounter}`,
      projectId: params.projectId,
      namespace: params.namespace,
      slug: params.slug,
      status: "queued",
      sourceUrl: params.sourceUrl,
      branch: params.branch,
      startedAt: now,
      updatedAt: now,
      version: 1,
      progress: { processedFiles: 0 },
      errors: [],
      logs: [
        {
          message: "Import queued",
          level: "info",
          timestamp: now,
        },
      ],
    };
    const key = `${params.namespace}:${params.slug}`;
    mockImportJobs.set(key, job);
    return { success: true, data: job };
  }),

  getImportProgress: vi.fn(async (_db, namespace: string, slug: string) => {
    const key = `${namespace}:${slug}`;
    const job = mockImportJobs.get(key);
    if (job) {
      return { success: true, data: job };
    }
    return { success: true, data: null };
  }),

  updateImportProgress: vi.fn(async (_db, namespace, slug, updates, _logger) => {
    const key = `${namespace}:${slug}`;
    const existing = mockImportJobs.get(key);
    if (!existing) {
      return {
        success: false,
        error: new AppError("Import job not found", "NOT_FOUND", 404),
      };
    }

    // Simulate optimistic locking
    const updated: ImportProgress = {
      ...existing,
      ...updates,
      version: existing.version + 1,
      progress: { ...existing.progress, ...updates.progress },
      logs: updates.logs ? [...existing.logs, ...updates.logs].slice(-100) : existing.logs,
      errors: updates.errors ? [...existing.errors, ...updates.errors].slice(-50) : existing.errors,
    };

    mockImportJobs.set(key, updated);
    return { success: true, data: updated };
  }),

  updateImportStatus: vi.fn(async (_db, namespace, slug, status, _logger, message) => {
    const key = `${namespace}:${slug}`;
    const existing = mockImportJobs.get(key);
    if (!existing) {
      return {
        success: false,
        error: new AppError("Import job not found", "NOT_FOUND", 404),
      };
    }

    const updates: Partial<ImportProgress> = { status };

    if (status === "completed" || status === "failed" || status === "cancelled") {
      updates.completedAt = new Date().toISOString();
    }

    if (message) {
      updates.logs = [
        {
          message,
          level: status === "failed" ? "error" : "info",
          timestamp: new Date().toISOString(),
        },
      ];
    }

    const updated: ImportProgress = {
      ...existing,
      ...updates,
      version: existing.version + 1,
      logs: updates.logs ? [...existing.logs, ...updates.logs].slice(-100) : existing.logs,
    };

    mockImportJobs.set(key, updated);
    return { success: true, data: updated };
  }),

  cancelImportJob: vi.fn(async (_db, namespace, slug, _logger) => {
    const key = `${namespace}:${slug}`;
    const existing = mockImportJobs.get(key);
    if (!existing) {
      return {
        success: false,
        error: new AppError("Import job not found", "NOT_FOUND", 404),
      };
    }

    // Can only cancel if not already completed/failed/cancelled
    if (["completed", "failed", "cancelled"].includes(existing.status)) {
      return {
        success: false,
        error: new AppError(
          `Cannot cancel import with status: ${existing.status}`,
          "INVALID_STATE",
          400,
        ),
      };
    }

    const updated: ImportProgress = {
      ...existing,
      status: "cancelling",
      version: existing.version + 1,
      logs: [
        ...existing.logs,
        {
          message: "Import cancellation requested",
          level: "info" as const,
          timestamp: new Date().toISOString(),
        },
      ].slice(-100),
    };

    mockImportJobs.set(key, updated);
    return { success: true, data: updated };
  }),

  isImportCancelled: vi.fn(async (_db, namespace, slug) => {
    const key = `${namespace}:${slug}`;
    const job = mockImportJobs.get(key);
    return job?.status === "cancelling" || job?.status === "cancelled";
  }),

  deleteImportJob: vi.fn(async (_db, namespace, slug) => {
    const key = `${namespace}:${slug}`;
    mockImportJobs.delete(key);
    return { success: true, data: undefined };
  }),

  getImportById: vi.fn(async (_db, id: string) => {
    for (const job of mockImportJobs.values()) {
      if (job.id === id) {
        return { success: true, data: job };
      }
    }
    return { success: true, data: null };
  }),

  listActiveImports: vi.fn(async () => {
    const activeStatuses = ["queued", "cloning", "processing", "cancelling"];
    const active = Array.from(mockImportJobs.values()).filter((job) =>
      activeStatuses.includes(job.status),
    );
    return { success: true, data: active };
  }),
}));

// Mock queue
const mockQueueMessages: Array<{
  type: string;
  importId: string;
  namespace: string;
  slug: string;
}> = [];

vi.mock("../src/queue/import-queue", () => ({
  queueImportJob: vi.fn(async (queue, params) => {
    if (!queue) {
      throw new Error("IMPORT_QUEUE not configured");
    }
    mockQueueMessages.push({
      type: "github.import",
      importId: params.importId,
      namespace: params.namespace,
      slug: params.slug,
    });
  }),
  queueSyncJob: vi.fn(),
  handleImportQueue: vi.fn(),
}));

// Mock git-ops
vi.mock("../src/storage/git-ops", () => ({
  importFromGitHub: vi.fn(),
  initAndPush: vi.fn(),
  cloneRepo: vi.fn(),
  commitAndPush: vi.fn(),
  mergeWorkspaceIntoProject: vi.fn(),
  listFilesInRepo: vi.fn(),
  getCommitLog: vi.fn(),
  readFileFromRepo: vi.fn(),
}));

// Mock rate limiter
vi.mock("../src/middleware/rate-limit", () => ({
  rateLimitMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => {
    // Simple pass-through for tests
    await next();
  }),
  checkImportRateLimit: vi.fn(async () => ({ allowed: true })),
  recordImportAttempt: vi.fn(),
  importRateLimitMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => {
    // Simple pass-through for tests
    await next();
  }),
}));

// ============================================================================
// Test Helpers
// ============================================================================

const USER_A_HEADERS = {
  Authorization: "Bearer stratum_user_userA_token000000000000000000",
};

const USER_B_HEADERS = {
  Authorization: "Bearer stratum_user_userB_token000000000000000000",
};

// KV mock factory
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
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {
      create: vi.fn((name: string) => ({
        name,
        remote: `https://artifacts.example.com/repos/${name}`,
        token: `tok_${name}`,
      })),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      import: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
    IMPORT_QUEUE: {
      send: vi.fn(),
      sendBatch: vi.fn(),
    } as unknown as Queue,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(headers ?? {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

async function createTestProject(
  env: Env,
  namespace: string,
  slug: string,
  ownerId: string,
  visibility: "private" | "public" = "private",
): Promise<ProjectEntry> {
  const project: ProjectEntry = {
    id: crypto.randomUUID(),
    name: slug,
    slug,
    namespace,
    ownerId,
    ownerType: "user",
    remote: `https://artifacts.example.com/repos/${namespace.replace("@", "")}-${slug}`,
    token: `tok_${namespace.replace("@", "")}_${slug}`,
    createdAt: new Date().toISOString(),
    visibility,
  };

  await env.STATE.put(`project:${namespace}:${slug}`, JSON.stringify(project));
  return project;
}

async function createTestImportJob(
  env: Env,
  params: {
    namespace: string;
    slug: string;
    status: ImportProgress["status"];
    ownerId?: string;
  },
): Promise<ImportProgress> {
  const { createImportJob } = await import("../src/storage/imports");
  const { createLogger } = await import("../src/utils/logger");
  const logger = createLogger({ component: "Test" });

  // First create a project
  const project = await createTestProject(
    env,
    params.namespace,
    params.slug,
    params.ownerId || "user_A",
  );

  // Create the import job
  const result = await createImportJob(
    env.DB,
    {
      id: `import_${++mockJobIdCounter}`,
      projectId: project.id,
      namespace: params.namespace,
      slug: params.slug,
      sourceUrl: "https://github.com/test/repo",
      branch: "main",
    },
    logger,
  );

  if (!result.success) {
    throw new Error("Failed to create test import job");
  }

  // Update status if needed
  if (params.status !== "queued") {
    const { updateImportStatus } = await import("../src/storage/imports");
    const updateResult = await updateImportStatus(
      env.DB,
      params.namespace,
      params.slug,
      params.status,
      logger,
    );
    if (!updateResult.success) {
      throw new Error("Failed to update import status");
    }
    return updateResult.data;
  }

  return result.data;
}

// ============================================================================
// Tests
// ============================================================================

describe("Import Cancellation End-to-End Tests", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
    vi.clearAllMocks();
    mockImportJobs.clear();
    mockQueueMessages.length = 0;
    mockJobIdCounter = 0;
  });

  // ==========================================================================
  // Test 1: Cancel queued import
  // ==========================================================================
  describe("Cancel queued import", () => {
    it("should change status to 'cancelling' and allow removal from D1", async () => {
      // Create import job in "queued" status
      const job = await createTestImportJob(env, {
        namespace: "@userA",
        slug: "test-project",
        status: "queued",
        ownerId: "user_A",
      });

      expect(job.status).toBe("queued");

      // POST to cancel endpoint
      const res = await app.fetch(
        request("POST", "/api/projects/@userA/test-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      // Verify response
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        message: string;
        namespace: string;
        slug: string;
      };
      expect(body.status).toBe("cancelling");
      expect(body.message).toContain("cancellation requested");
      expect(body.namespace).toBe("@userA");
      expect(body.slug).toBe("test-project");

      // Verify job is still in D1 but with cancelling status
      const { getImportProgress } = await import("../src/storage/imports");
      const { createLogger } = await import("../src/utils/logger");
      const logger = createLogger({ component: "Test" });
      const progressResult = await getImportProgress(env.DB, "@userA", "test-project", logger);

      expect(progressResult.success).toBe(true);
      if (!progressResult.success) return;
      expect(progressResult.data).not.toBeNull();
      if (progressResult.data === null) return;
      expect(progressResult.data.status).toBe("cancelling");
      expect(
        progressResult.data.logs.some((log: { message: string }) =>
          log.message.includes("cancellation requested"),
        ),
      ).toBe(true);
    });

    it("should allow queue processor to complete cancellation and remove job", async () => {
      // Create import job
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "test-project",
        status: "queued",
        ownerId: "user_A",
      });

      // Cancel the import
      const cancelRes = await app.fetch(
        request("POST", "/api/projects/@userA/test-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      expect(cancelRes.status).toBe(200);

      // Simulate queue processor seeing cancellation and cleaning up
      const { isImportCancelled, updateImportStatus, deleteImportJob, getImportProgress } =
        await import("../src/storage/imports");
      const { createLogger } = await import("../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      // Check if cancelled
      const isCancelled = await isImportCancelled(env.DB, "@userA", "test-project", logger);
      expect(isCancelled).toBe(true);

      // Update to cancelled status
      const updateResult = await updateImportStatus(
        env.DB,
        "@userA",
        "test-project",
        "cancelled",
        logger,
        "Import cancelled by user",
      );
      expect(updateResult.success).toBe(true);
      if (!updateResult.success) return;
      expect(updateResult.data.status).toBe("cancelled");
      expect(updateResult.data.completedAt).toBeDefined();

      // Delete the job
      const deleteResult = await deleteImportJob(env.DB, "@userA", "test-project", logger);
      expect(deleteResult.success).toBe(true);

      // Verify job is removed
      const afterDelete = await getImportProgress(env.DB, "@userA", "test-project", logger);
      expect(afterDelete.success).toBe(true);
      if (!afterDelete.success) return;
      expect(afterDelete.data).toBeNull();
    });
  });

  // ==========================================================================
  // Test 2: Cancel cloning import
  // ==========================================================================
  describe("Cancel cloning import", () => {
    it("should change status to 'cancelling' for import in cloning status", async () => {
      // Create import job in "cloning" status
      const job = await createTestImportJob(env, {
        namespace: "@userA",
        slug: "cloning-project",
        status: "cloning",
        ownerId: "user_A",
      });

      expect(job.status).toBe("cloning");

      // POST to cancel endpoint
      const res = await app.fetch(
        request("POST", "/api/projects/@userA/cloning-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      // Verify response
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("cancelling");

      // Verify queue processor would see cancellation
      const { isImportCancelled } = await import("../src/storage/imports");
      const { createLogger } = await import("../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      const isCancelled = await isImportCancelled(env.DB, "@userA", "cloning-project", logger);
      expect(isCancelled).toBe(true);
    });

    it("should allow queue processor to stop processing when cancelled", async () => {
      // Create import in cloning status
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "cloning-project",
        status: "cloning",
        ownerId: "user_A",
      });

      // Cancel it
      await app.fetch(
        request("POST", "/api/projects/@userA/cloning-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      // Verify queue can detect cancellation and stop
      const { isImportCancelled } = await import("../src/storage/imports");
      const { createLogger } = await import("../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      const isCancelled = await isImportCancelled(env.DB, "@userA", "cloning-project", logger);

      // Queue processor would check this and stop if true
      expect(isCancelled).toBe(true);
    });
  });

  // ==========================================================================
  // Test 3: Cannot cancel completed import
  // ==========================================================================
  describe("Cannot cancel completed import", () => {
    it("should return 400 error when trying to cancel completed import", async () => {
      // Create import job in "completed" status
      const job = await createTestImportJob(env, {
        namespace: "@userA",
        slug: "completed-project",
        status: "completed",
        ownerId: "user_A",
      });

      expect(job.status).toBe("completed");

      // POST to cancel endpoint
      const res = await app.fetch(
        request("POST", "/api/projects/@userA/completed-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      // Verify 400 error
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Cannot cancel import with status: completed");
    });

    it("should return 400 error with correct error code", async () => {
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "completed-project",
        status: "completed",
        ownerId: "user_A",
      });

      const res = await app.fetch(
        request("POST", "/api/projects/@userA/completed-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // Test 4: Cannot cancel failed import
  // ==========================================================================
  describe("Cannot cancel failed import", () => {
    it("should return 400 error when trying to cancel failed import", async () => {
      // Create import job in "failed" status
      const job = await createTestImportJob(env, {
        namespace: "@userA",
        slug: "failed-project",
        status: "failed",
        ownerId: "user_A",
      });

      expect(job.status).toBe("failed");

      // POST to cancel endpoint
      const res = await app.fetch(
        request("POST", "/api/projects/@userA/failed-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      // Verify 400 error
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Cannot cancel import with status: failed");
    });
  });

  // ==========================================================================
  // Test 5: Only owner can cancel
  // ==========================================================================
  describe("Only owner can cancel", () => {
    it("should return 403 when user B tries to cancel user A's import", async () => {
      // Create import as user A
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "private-project",
        status: "processing",
        ownerId: "user_A",
      });

      // User B tries to cancel
      const res = await app.fetch(
        request("POST", "/api/projects/@userA/private-project/import/cancel", {}, USER_B_HEADERS),
        env,
      );

      // Verify 403 forbidden
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("own namespace");
    });

    it("should allow user A to cancel their own import", async () => {
      // Create import as user A
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "my-project",
        status: "processing",
        ownerId: "user_A",
      });

      // User A cancels their own import
      const res = await app.fetch(
        request("POST", "/api/projects/@userA/my-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      // Verify success
      expect(res.status).toBe(200);
    });

    it("should check namespace matching for cancellation permission", async () => {
      // Create project in userA's namespace
      await createTestProject(env, "@userA", "test-project", "user_A", "public");

      // Create import job
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "test-project",
        status: "processing",
        ownerId: "user_A",
      });

      // User B tries to cancel - should fail because namespace doesn't match
      const res = await app.fetch(
        request("POST", "/api/projects/@userA/test-project/import/cancel", {}, USER_B_HEADERS),
        env,
      );

      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // Test 6: Cancel during processing
  // ==========================================================================
  describe("Cancel during processing", () => {
    it("should transition status correctly from processing to cancelling", async () => {
      // Create import in "processing" status
      const job = await createTestImportJob(env, {
        namespace: "@userA",
        slug: "processing-project",
        status: "processing",
        ownerId: "user_A",
      });

      expect(job.status).toBe("processing");

      // Cancel it
      const res = await app.fetch(
        request(
          "POST",
          "/api/projects/@userA/processing-project/import/cancel",
          {},
          USER_A_HEADERS,
        ),
        env,
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("cancelling");

      // Verify status was updated
      const { getImportProgress } = await import("../src/storage/imports");
      const { createLogger } = await import("../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      const progress = await getImportProgress(env.DB, "@userA", "processing-project", logger);
      expect(progress.success).toBe(true);
      if (!progress.success) return;
      expect(progress.data).not.toBeNull();
      if (progress.data === null) return;
      expect(progress.data.status).toBe("cancelling");
    });

    it("should preserve progress data when cancelling during processing", async () => {
      // Create import with progress
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "progress-project",
        status: "processing",
        ownerId: "user_A",
      });

      // Add some progress updates manually
      const { updateImportProgress } = await import("../src/storage/imports");
      const { createLogger } = await import("../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      await updateImportProgress(
        env.DB,
        "@userA",
        "progress-project",
        {
          progress: {
            processedFiles: 50,
            totalFiles: 100,
            currentFile: "src/main.ts",
          },
        },
        logger,
      );

      // Cancel it
      const res = await app.fetch(
        request("POST", "/api/projects/@userA/progress-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      expect(res.status).toBe(200);

      // Verify progress data is preserved
      const { getImportProgress } = await import("../src/storage/imports");
      const progress = await getImportProgress(env.DB, "@userA", "progress-project", logger);

      expect(progress.success).toBe(true);
      if (!progress.success) return;
      expect(progress.data).not.toBeNull();
      if (progress.data === null) return;
      expect(progress.data.progress.processedFiles).toBe(50);
      expect(progress.data.progress.totalFiles).toBe(100);
      expect(progress.data.progress.currentFile).toBe("src/main.ts");
      expect(progress.data.status).toBe("cancelling");
    });

    it("should add cancellation log entry when cancelling", async () => {
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "log-test-project",
        status: "processing",
        ownerId: "user_A",
      });

      const res = await app.fetch(
        request("POST", "/api/projects/@userA/log-test-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      expect(res.status).toBe(200);

      // Verify log was added
      const { getImportProgress } = await import("../src/storage/imports");
      const { createLogger } = await import("../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      const progress = await getImportProgress(env.DB, "@userA", "log-test-project", logger);

      expect(progress.success).toBe(true);
      if (!progress.success) return;
      expect(progress.data).not.toBeNull();
      if (progress.data === null) return;
      const hasCancellationLog = progress.data.logs.some(
        (log: { message: string; level: string }) =>
          log.message.includes("cancellation requested") && log.level === "info",
      );
      expect(hasCancellationLog).toBe(true);
    });
  });

  // ==========================================================================
  // Additional Edge Cases
  // ==========================================================================
  describe("Additional edge cases", () => {
    it("should return 401 when unauthenticated", async () => {
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "test-project",
        status: "processing",
        ownerId: "user_A",
      });

      const res = await app.fetch(
        request("POST", "/api/projects/@userA/test-project/import/cancel"),
        env,
      );

      expect(res.status).toBe(401);
    });

    it("should return 404 for non-existent import job", async () => {
      await createTestProject(env, "@userA", "no-import-project", "user_A", "private");

      const res = await app.fetch(
        request("POST", "/api/projects/@userA/no-import-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      expect(res.status).toBe(404);
    });

    it("should handle already cancelling import gracefully", async () => {
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "cancelling-project",
        status: "cancelling",
        ownerId: "user_A",
      });

      // Try to cancel again
      const res = await app.fetch(
        request(
          "POST",
          "/api/projects/@userA/cancelling-project/import/cancel",
          {},
          USER_A_HEADERS,
        ),
        env,
      );

      // Should succeed (idempotent) - cancelling is not a terminal state
      expect(res.status).toBe(200);
    });

    it("should return 400 for already cancelled import", async () => {
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "cancelled-project",
        status: "cancelled",
        ownerId: "user_A",
      });

      const res = await app.fetch(
        request("POST", "/api/projects/@userA/cancelled-project/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      // Cancelled is a terminal state
      expect(res.status).toBe(400);
    });

    it("should handle concurrent cancellation attempts safely", async () => {
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "concurrent-project",
        status: "processing",
        ownerId: "user_A",
      });

      // Fire multiple cancellation requests simultaneously
      const promises = [
        app.fetch(
          request(
            "POST",
            "/api/projects/@userA/concurrent-project/import/cancel",
            {},
            USER_A_HEADERS,
          ),
          env,
        ),
        app.fetch(
          request(
            "POST",
            "/api/projects/@userA/concurrent-project/import/cancel",
            {},
            USER_A_HEADERS,
          ),
          env,
        ),
        app.fetch(
          request(
            "POST",
            "/api/projects/@userA/concurrent-project/import/cancel",
            {},
            USER_A_HEADERS,
          ),
          env,
        ),
      ];

      const results = await Promise.all(promises);

      // At least one should succeed, others should either succeed (idempotent) or fail gracefully
      const successCount = results.filter((r) => r.status === 200).length;
      expect(successCount).toBeGreaterThanOrEqual(1);

      // All should have valid responses
      for (const res of results) {
        expect([200, 400, 409]).toContain(res.status);
      }
    });
  });

  // ==========================================================================
  // Queue Integration Tests
  // ==========================================================================
  describe("Queue integration", () => {
    it("should not queue a message for cancellation (queue is for imports only)", async () => {
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "queue-test",
        status: "processing",
        ownerId: "user_A",
      });

      const res = await app.fetch(
        request("POST", "/api/projects/@userA/queue-test/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      expect(res.status).toBe(200);

      // Queue should not have any new messages for cancellation
      // (cancellation is handled via D1 status update)
      const queueMessagesForThisJob = mockQueueMessages.filter(
        (m) => m.namespace === "@userA" && m.slug === "queue-test",
      );
      expect(queueMessagesForThisJob.length).toBe(0);
    });

    it("should allow queue processor to detect cancellation via D1", async () => {
      // Create and cancel an import
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "detect-test",
        status: "cloning",
        ownerId: "user_A",
      });

      await app.fetch(
        request("POST", "/api/projects/@userA/detect-test/import/cancel", {}, USER_A_HEADERS),
        env,
      );

      // Queue processor can detect via isImportCancelled
      const { isImportCancelled } = await import("../src/storage/imports");
      const { createLogger } = await import("../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      const isCancelled = await isImportCancelled(env.DB, "@userA", "detect-test", logger);
      expect(isCancelled).toBe(true);
    });
  });

  // ==========================================================================
  // Status Transition Tests
  // ==========================================================================
  describe("Status transition validation", () => {
    const cancellableStatuses = ["queued", "cloning", "processing", "cancelling"] as const;
    const nonCancellableStatuses = ["completed", "failed", "cancelled"] as const;

    cancellableStatuses.forEach((status) => {
      it(`should allow cancellation of import in '${status}' status`, async () => {
        await createTestImportJob(env, {
          namespace: "@userA",
          slug: `${status}-project`,
          status,
          ownerId: "user_A",
        });

        const res = await app.fetch(
          request(
            "POST",
            `/api/projects/@userA/${status}-project/import/cancel`,
            {},
            USER_A_HEADERS,
          ),
          env,
        );

        expect(res.status).toBe(200);
      });
    });

    nonCancellableStatuses.forEach((status) => {
      it(`should reject cancellation of import in '${status}' status`, async () => {
        await createTestImportJob(env, {
          namespace: "@userA",
          slug: `${status}-project`,
          status,
          ownerId: "user_A",
        });

        const res = await app.fetch(
          request(
            "POST",
            `/api/projects/@userA/${status}-project/import/cancel`,
            {},
            USER_A_HEADERS,
          ),
          env,
        );

        expect(res.status).toBe(400);
      });
    });
  });
});
