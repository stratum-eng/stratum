/**
 * Integration Tests for Queue Processing
 *
 * These tests verify the queue consumer logic without requiring
 * an actual Cloudflare Queue environment.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleImportQueue, queueImportJob, queueSyncJob } from "../../src/queue/import-queue";
import type { Env, ImportJobMessage, ImportProgress, ProjectEntry, SyncJobMessage } from "../../src/types";
import type { Message, MessageBatch } from "../../src/types";

// ============================================================================
// Mocks
// ============================================================================

const mockImportJobs = new Map<string, ImportProgress>();
let mockJobIdCounter = 0;

vi.mock("../../src/storage/imports", () => ({
  createImportJob: vi.fn(async (_db, params, _logger) => {
    mockJobIdCounter++;
    const job: ImportProgress = {
      id: `import_${mockJobIdCounter}`,
      projectId: params.projectId,
      namespace: params.namespace,
      slug: params.slug,
      status: "queued",
      sourceUrl: params.sourceUrl,
      branch: params.branch,
      startedAt: new Date().toISOString(),
      version: 1,
      progress: { processedFiles: 0 },
      errors: [],
      logs: [{ message: "Import queued", level: "info" as const, timestamp: new Date().toISOString() }],
    };
    const key = `${params.namespace}:${params.slug}`;
    mockImportJobs.set(key, job);
    return { success: true, data: job };
  }),

  getImportProgress: vi.fn(async (_db, namespace: string, slug: string) => {
    const key = `${namespace}:${slug}`;
    const job = mockImportJobs.get(key);
    return { success: true, data: job || null };
  }),

  updateImportStatus: vi.fn(async (_db, namespace, slug, status, _logger, message) => {
    const key = `${namespace}:${slug}`;
    const existing = mockImportJobs.get(key);
    if (!existing) {
      return { success: false, error: new Error("Import job not found") };
    }

    const updated: ImportProgress = {
      ...existing,
      status,
      version: existing.version + 1,
      completedAt: ["completed", "failed", "cancelled"].includes(status) ? new Date().toISOString() : undefined,
      logs: message
        ? [...existing.logs, { message, level: status === "failed" ? "error" : "info", timestamp: new Date().toISOString() }].slice(-100)
        : existing.logs,
    };

    mockImportJobs.set(key, updated);
    return { success: true, data: updated };
  }),

  updateImportProgress: vi.fn(async (_db, namespace, slug, updates) => {
    const key = `${namespace}:${slug}`;
    const existing = mockImportJobs.get(key);
    if (!existing) {
      return { success: false, error: new Error("Import job not found") };
    }

    const updated: ImportProgress = {
      ...existing,
      ...updates,
      version: existing.version + 1,
      progress: { ...existing.progress, ...updates.progress },
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

  cancelImportJob: vi.fn(async (_db, namespace, slug, _logger) => {
    const key = `${namespace}:${slug}`;
    const existing = mockImportJobs.get(key);
    if (!existing) {
      return { success: false, error: new Error("Import job not found") };
    }

    if (["completed", "failed", "cancelled"].includes(existing.status)) {
      return {
        success: false,
        error: new Error(`Cannot cancel import with status: ${existing.status}`),
      };
    }

    const updated: ImportProgress = {
      ...existing,
      status: "cancelling",
      version: existing.version + 1,
    };

    mockImportJobs.set(key, updated);
    return { success: true, data: updated };
  }),
}));

const mockProjects = new Map<string, ProjectEntry>();

vi.mock("../../src/storage/state", () => ({
  getProjectByPath: vi.fn(async (_state, namespace: string, slug: string) => {
    const key = `${namespace}:${slug}`;
    const project = mockProjects.get(key);
    return project ? { success: true, data: project } : { success: true, data: null };
  }),

  setProject: vi.fn(async (_state, project: ProjectEntry) => {
    const key = `${project.namespace}:${project.slug}`;
    mockProjects.set(key, project);
    return { success: true, data: project };
  }),

  getProject: vi.fn(async (_state, name: string) => {
    for (const project of mockProjects.values()) {
      if (project.name === name) {
        return { success: true, data: project };
      }
    }
    return { success: true, data: null };
  }),
}));

vi.mock("../../src/storage/git-ops", () => ({
  importFromGitHub: vi.fn(),
}));

// ============================================================================
// Test Helpers
// ============================================================================

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => store.set(key, value),
    delete: async (key: string) => store.delete(key),
    list: async ({ prefix }: { prefix?: string }) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      import: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
    IMPORT_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
    EVENTS_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
  };
}

function createMockMessage<T>(body: T): Message<T> {
  return {
    id: `msg_${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<T>;
}

function createMockBatch<T>(messages: Message<T>[], queueName: string): MessageBatch<T> {
  return {
    queue: queueName,
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<T>;
}

async function createTestProject(env: Env, namespace: string, slug: string, projectId: string): Promise<ProjectEntry> {
  const project: ProjectEntry = {
    id: projectId,
    name: slug,
    slug,
    namespace,
    ownerId: "user_test",
    ownerType: "user",
    remote: `https://artifacts.example.com/repos/${namespace.replace("@", "")}__${slug}`,
    token: `tok_${namespace.replace("@", "")}_${slug}`,
    createdAt: new Date().toISOString(),
  };

  await env.STATE.put(`project:${namespace}:${slug}`, JSON.stringify(project));
  mockProjects.set(`${namespace}:${slug}`, project);
  return project;
}

async function createTestImportJob(
  env: Env,
  params: { namespace: string; slug: string; status: ImportProgress["status"]; projectId: string },
): Promise<ImportProgress> {
  const { createImportJob } = await import("../../src/storage/imports");
  const { createLogger } = await import("../../src/utils/logger");
  const logger = createLogger({ component: "Test" });

  // Create project first
  await createTestProject(env, params.namespace, params.slug, params.projectId);

  const result = await createImportJob(
    env.DB,
    {
      id: `import_${++mockJobIdCounter}`,
      projectId: params.projectId,
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
    const { updateImportStatus } = await import("../../src/storage/imports");
    const updateResult = await updateImportStatus(env.DB, params.namespace, params.slug, params.status, logger);
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

describe("Queue Processing Integration Tests", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
    vi.clearAllMocks();
    mockImportJobs.clear();
    mockProjects.clear();
    mockJobIdCounter = 0;
  });

  describe("Import Job Processing", () => {
    it("should process a valid import job and mark it as completed", async () => {
      const { importFromGitHub } = await import("../../src/storage/git-ops");
      vi.mocked(importFromGitHub).mockResolvedValue({
        success: true,
        data: {
          remote: "https://artifacts.example.com/repos/test__repo",
          token: "tok_abc123",
        },
      });

      const projectId = "proj_123";
      await createTestImportJob(env, {
        namespace: "@test",
        slug: "repo",
        status: "queued",
        projectId,
      });

      const importMessage: ImportJobMessage = {
        type: "github.import",
        importId: "import_1",
        projectId,
        namespace: "@test",
        slug: "repo",
        githubUrl: "https://github.com/test/repo",
        branch: "main",
        depth: 10,
        timestamp: new Date().toISOString(),
      };

      const message = createMockMessage(importMessage);
      const batch = createMockBatch([message], "stratum-imports");

      await handleImportQueue(batch, env);

      // Verify the message was acknowledged
      expect(message.ack).toHaveBeenCalled();

      // Verify import status was updated to completed
      const { getImportProgress } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });
      const progress = await getImportProgress(env.DB, "@test", "repo", logger);

      expect(progress.success).toBe(true);
      if (progress.success && progress.data) {
        expect(progress.data.status).toBe("completed");
      }
    });

    it("should handle import job for non-existent project", async () => {
      const importMessage: ImportJobMessage = {
        type: "github.import",
        importId: "import_1",
        projectId: "nonexistent",
        namespace: "@test",
        slug: "nonexistent",
        githubUrl: "https://github.com/test/nonexistent",
        branch: "main",
        depth: 10,
        timestamp: new Date().toISOString(),
      };

      const message = createMockMessage(importMessage);
      const batch = createMockBatch([message], "stratum-imports");

      await handleImportQueue(batch, env);

      // Should ack the message since we don't want to retry for missing project
      expect(message.ack).toHaveBeenCalled();
    });

    it("should handle cancelled import jobs", async () => {
      const projectId = "proj_123";
      await createTestImportJob(env, {
        namespace: "@test",
        slug: "repo",
        status: "cancelling",
        projectId,
      });

      const importMessage: ImportJobMessage = {
        type: "github.import",
        importId: "import_1",
        projectId,
        namespace: "@test",
        slug: "repo",
        githubUrl: "https://github.com/test/repo",
        branch: "main",
        depth: 10,
        timestamp: new Date().toISOString(),
      };

      const message = createMockMessage(importMessage);
      const batch = createMockBatch([message], "stratum-imports");

      await handleImportQueue(batch, env);

      // Should ack and not process
      expect(message.ack).toHaveBeenCalled();

      const { getImportProgress } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });
      const progress = await getImportProgress(env.DB, "@test", "repo", logger);

      expect(progress.success).toBe(true);
      if (progress.success && progress.data) {
        expect(progress.data.status).toBe("cancelled");
      }
    });

    it("should handle import failures and mark as failed", async () => {
      const { importFromGitHub } = await import("../../src/storage/git-ops");
      vi.mocked(importFromGitHub).mockResolvedValue({
        success: false,
        error: new Error("Git clone failed"),
      });

      const projectId = "proj_123";
      await createTestImportJob(env, {
        namespace: "@test",
        slug: "repo",
        status: "queued",
        projectId,
      });

      const importMessage: ImportJobMessage = {
        type: "github.import",
        importId: "import_1",
        projectId,
        namespace: "@test",
        slug: "repo",
        githubUrl: "https://github.com/test/repo",
        branch: "main",
        depth: 10,
        timestamp: new Date().toISOString(),
      };

      const message = createMockMessage(importMessage);
      const batch = createMockBatch([message], "stratum-imports");

      await handleImportQueue(batch, env);

      // Should ack (not retry) since we handle the error
      expect(message.ack).toHaveBeenCalled();

      const { getImportProgress } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });
      const progress = await getImportProgress(env.DB, "@test", "repo", logger);

      expect(progress.success).toBe(true);
      if (progress.success && progress.data) {
        expect(progress.data.status).toBe("failed");
        // Error is recorded in logs, not errors array in this mock
        expect(progress.data.logs.some((log: { message: string }) => log.message.includes("failed"))).toBe(true);
      }
    });
  });

  describe("Sync Job Processing", () => {
    it("should process a valid sync job", async () => {
      const { importFromGitHub } = await import("../../src/storage/git-ops");
      vi.mocked(importFromGitHub).mockResolvedValue({
        success: true,
        data: {
          remote: "https://artifacts.example.com/repos/test__repo",
          token: "tok_abc123",
        },
      });

      const projectId = "proj_123";
      await createTestImportJob(env, {
        namespace: "@test",
        slug: "repo",
        status: "completed",
        projectId,
      });

      const syncMessage: SyncJobMessage = {
        type: "github.sync",
        importId: "sync_1",
        projectId,
        namespace: "@test",
        slug: "repo",
        githubUrl: "https://github.com/test/repo",
        branch: "main",
        depth: 10,
        timestamp: new Date().toISOString(),
      };

      const message = createMockMessage(syncMessage);
      const batch = createMockBatch([message], "stratum-imports");

      await handleImportQueue(batch, env);

      expect(message.ack).toHaveBeenCalled();

      const { getImportProgress } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });
      const progress = await getImportProgress(env.DB, "@test", "repo", logger);

      expect(progress.success).toBe(true);
      if (progress.success && progress.data) {
        expect(progress.data.status).toBe("completed");
      }
    });
  });

  describe("Batch Processing", () => {
    it("should process multiple messages in a batch", async () => {
      const { importFromGitHub } = await import("../../src/storage/git-ops");
      vi.mocked(importFromGitHub).mockResolvedValue({
        success: true,
        data: {
          remote: "https://artifacts.example.com/repos/test__repo",
          token: "tok_abc123",
        },
      });

      // Create two projects
      await createTestImportJob(env, {
        namespace: "@test",
        slug: "repo1",
        status: "queued",
        projectId: "proj_1",
      });

      await createTestImportJob(env, {
        namespace: "@test",
        slug: "repo2",
        status: "queued",
        projectId: "proj_2",
      });

      const messages = [
        createMockMessage<ImportJobMessage>({
          type: "github.import",
          importId: "import_1",
          projectId: "proj_1",
          namespace: "@test",
          slug: "repo1",
          githubUrl: "https://github.com/test/repo1",
          branch: "main",
          depth: 10,
          timestamp: new Date().toISOString(),
        }),
        createMockMessage<ImportJobMessage>({
          type: "github.import",
          importId: "import_2",
          projectId: "proj_2",
          namespace: "@test",
          slug: "repo2",
          githubUrl: "https://github.com/test/repo2",
          branch: "main",
          depth: 10,
          timestamp: new Date().toISOString(),
        }),
      ];

      const batch = createMockBatch(messages, "stratum-imports");
      await handleImportQueue(batch, env);

      // Both messages should be acknowledged
      expect(messages[0].ack).toHaveBeenCalled();
      expect(messages[1].ack).toHaveBeenCalled();
    });
  });

  describe("Invalid Messages", () => {
    it("should ack invalid messages to prevent infinite retries", async () => {
      const message = createMockMessage({ invalid: "message" });
      const batch = createMockBatch([message], "stratum-imports");

      await handleImportQueue(batch, env);

      expect(message.ack).toHaveBeenCalled();
    });

    it("should handle empty batches", async () => {
      const batch = createMockBatch([], "stratum-imports");

      // Should not throw
      await expect(handleImportQueue(batch, env)).resolves.not.toThrow();
    });
  });
});

describe("Queue Job Enqueuing", () => {
  it("should queue an import job", async () => {
    const mockQueue = { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue<ImportJobMessage>;

    await queueImportJob(mockQueue, {
      importId: "import_1",
      projectId: "proj_1",
      namespace: "@test",
      slug: "repo",
      githubUrl: "https://github.com/test/repo",
      branch: "main",
      depth: 10,
    });

    expect(mockQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "github.import",
        importId: "import_1",
        projectId: "proj_1",
      }),
    );
  });

  it("should queue a sync job", async () => {
    const mockQueue = { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue<SyncJobMessage>;

    await queueSyncJob(mockQueue, {
      importId: "sync_1",
      projectId: "proj_1",
      namespace: "@test",
      slug: "repo",
      githubUrl: "https://github.com/test/repo",
      branch: "main",
      depth: 10,
    });

    expect(mockQueue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "github.sync",
        importId: "sync_1",
        projectId: "proj_1",
      }),
    );
  });

  it("should throw if queue is not configured", async () => {
    await expect(
      queueImportJob(undefined, {
        importId: "import_1",
        projectId: "proj_1",
        namespace: "@test",
        slug: "repo",
        githubUrl: "https://github.com/test/repo",
        branch: "main",
      }),
    ).rejects.toThrow("IMPORT_QUEUE not configured");
  });
});
