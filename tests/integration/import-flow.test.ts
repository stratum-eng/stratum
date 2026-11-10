// @ts-nocheck
/**
 * End-to-End Import Flow Integration Tests
 *
 * These tests verify the complete import flow from job creation through
 * queue processing to completion, using mocked external dependencies.
 *
 * Note: These tests mock the storage layer and focus on the import job
 * lifecycle through the queue system.
 */

import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleImportQueue, queueImportJob, queueSyncJob } from "../../src/queue/import-queue";
import { blobObject, commitObject, treeObject } from "../../src/storage/git-objects";
import { MemoryFS } from "../../src/storage/memory-fs";
import { placeLooseObject } from "../../src/storage/object-loader";
import type {
  Env,
  ImportJobMessage,
  ImportProgress,
  ProjectEntry,
  SyncJobMessage,
} from "../../src/types";
import type { Message, MessageBatch } from "../../src/types";
import { AppError } from "../../src/utils/errors";

// ============================================================================
// Mocks
// ============================================================================

const mockImportJobs = new Map<string, ImportProgress>();
let mockJobIdCounter = 0;

// These suites run against a stub database with no `push_mirrors` table. The
// layer-mode guards refuse when a project's mirror state cannot be read (#417),
// so the lookup is answered here: none of these projects has a mirror.
vi.mock("../../src/storage/push-mirrors", async (importActual) => ({
  ...(await importActual<typeof import("../../src/storage/push-mirrors")>()),
  pushMirrorMode: vi.fn(async () => "layer" as const),
}));

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
      logs: [
        { message: "Import queued", level: "info" as const, timestamp: new Date().toISOString() },
      ],
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
      return { success: false, error: new AppError("Import job not found", "NOT_FOUND", 404) };
    }

    const updated: ImportProgress = {
      ...existing,
      status,
      version: existing.version + 1,
      completedAt: ["completed", "failed", "cancelled"].includes(status)
        ? new Date().toISOString()
        : undefined,
      logs: message
        ? [
            ...existing.logs,
            {
              message,
              level: status === "failed" ? "error" : "info",
              timestamp: new Date().toISOString(),
            },
          ].slice(-100)
        : existing.logs,
    };

    mockImportJobs.set(key, updated);
    return { success: true, data: updated };
  }),

  updateImportProgress: vi.fn(async (_db, namespace, slug, updates) => {
    const key = `${namespace}:${slug}`;
    const existing = mockImportJobs.get(key);
    if (!existing) {
      return { success: false, error: new AppError("Import job not found", "NOT_FOUND", 404) };
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
      return { success: false, error: new AppError("Import job not found", "NOT_FOUND", 404) };
    }

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
          level: "info",
          timestamp: new Date().toISOString(),
        },
      ].slice(-100),
    };

    mockImportJobs.set(key, updated);
    return { success: true, data: updated };
  }),

  listActiveImports: vi.fn(async () => {
    const activeStatuses = ["queued", "cloning", "processing", "cancelling"];
    const active = Array.from(mockImportJobs.values()).filter((job) =>
      activeStatuses.includes(job.status),
    );
    return { success: true, data: active };
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

vi.mock("../../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../../src/storage/git-ops")>();
  return {
    ...actual,
    importFromGitHub: vi.fn(),
    syncFromGitHub: vi.fn(),
    // Real network cloning has no place in this suite; the submodule-rejection
    // tests below drive this mock to hand back a fully local MemoryFS clone
    // (real git objects, no HTTP) so the REAL `scanForSubmoduleContent` runs
    // against it exactly as it would against a genuine clone.
    freshRepoToken: vi.fn(),
    cloneRepo: vi.fn(),
  };
});

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
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      import: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
    IMPORT_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
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

async function createTestProject(
  env: Env,
  namespace: string,
  slug: string,
  projectId: string,
): Promise<ProjectEntry> {
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

describe("End-to-End Import Flow", () => {
  let env: Env;

  beforeEach(async () => {
    env = makeEnv();
    vi.clearAllMocks();
    mockImportJobs.clear();
    mockProjects.clear();
    mockJobIdCounter = 0;

    // Default the post-import submodule scan's token mint to "fails" so
    // existing tests that never touch it keep exercising the pre-#258
    // behavior (the scan is best-effort and skips itself on a mint failure —
    // see processImportJob). Tests below override this per-case.
    const { freshRepoToken } = await import("../../src/storage/git-ops");
    vi.mocked(freshRepoToken).mockResolvedValue({
      success: false,
      error: new AppError("no token in this suite", "EXTERNAL_SERVICE_ERROR", 502),
    });
  });

  describe("Happy Path - Successful Import", () => {
    it("should complete full import flow from queued to completed", async () => {
      const { importFromGitHub } = await import("../../src/storage/git-ops");
      vi.mocked(importFromGitHub).mockResolvedValue({
        success: true,
        data: {
          remote: "https://artifacts.example.com/repos/test__repo",
          token: "tok_abc123",
        },
      });

      const projectId = "proj_123";
      const job = await createTestImportJob(env, {
        namespace: "@userA",
        slug: "my-project",
        status: "queued",
        projectId,
      });

      expect(job.status).toBe("queued");

      // Process the import through the queue
      const importMessage: ImportJobMessage = {
        type: "github.import",
        importId: job.id,
        projectId,
        namespace: "@userA",
        slug: "my-project",
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
      const progress = await getImportProgress(env.DB, "@userA", "my-project", logger);

      expect(progress.success).toBe(true);
      if (progress.success && progress.data) {
        expect(progress.data.status).toBe("completed");
        expect(progress.data.completedAt).toBeDefined();
      }
    });

    it("should track import progress through all stages", async () => {
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
        namespace: "@userA",
        slug: "progress-project",
        status: "queued",
        projectId,
      });

      const { getImportProgress, updateImportProgress, updateImportStatus } = await import(
        "../../src/storage/imports"
      );
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      // Track through status transitions
      const stages = [
        { status: "cloning" as const, message: "Cloning repository" },
        { status: "processing" as const, message: "Processing files" },
        { status: "completed" as const, message: "Import completed" },
      ];

      for (const stage of stages) {
        await updateImportStatus(
          env.DB,
          "@userA",
          "progress-project",
          stage.status,
          logger,
          stage.message,
        );

        // Simulate progress updates during processing
        if (stage.status === "processing") {
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
        }

        const progress = await getImportProgress(env.DB, "@userA", "progress-project", logger);
        expect(progress.data?.status).toBe(stage.status);
      }

      // Verify final progress
      const finalProgress = await getImportProgress(env.DB, "@userA", "progress-project", logger);
      expect(finalProgress.data?.progress.processedFiles).toBe(50);
      expect(finalProgress.data?.progress.totalFiles).toBe(100);
    });
  });

  describe("Import Cancellation Flow", () => {
    it("should handle import cancellation during processing", async () => {
      const projectId = "proj_123";
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "cancel-project",
        status: "processing",
        projectId,
      });

      const { cancelImportJob, getImportProgress, isImportCancelled } = await import(
        "../../src/storage/imports"
      );
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      // Cancel the import
      const cancelResult = await cancelImportJob(env.DB, "@userA", "cancel-project", logger);

      expect(cancelResult.success).toBe(true);
      if (cancelResult.success) {
        expect(cancelResult.data.status).toBe("cancelling");
      }

      // Verify cancellation
      const progress = await getImportProgress(env.DB, "@userA", "cancel-project", logger);
      expect(progress.data?.status).toBe("cancelling");

      // Queue processor would detect this
      const isCancelled = await isImportCancelled(env.DB, "@userA", "cancel-project", logger);
      expect(isCancelled).toBe(true);
    });

    it("should reject cancellation for completed imports", async () => {
      const projectId = "proj_123";
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "completed-project",
        status: "completed",
        projectId,
      });

      const { cancelImportJob } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      // Try to cancel
      const cancelResult = await cancelImportJob(env.DB, "@userA", "completed-project", logger);

      expect(cancelResult.success).toBe(false);
      if (!cancelResult.success) {
        expect(cancelResult.error.message).toContain("Cannot cancel");
      }
    });
  });

  describe("Import Failure Handling", () => {
    it("should handle import failures gracefully", async () => {
      const { importFromGitHub } = await import("../../src/storage/git-ops");
      vi.mocked(importFromGitHub).mockResolvedValue({
        success: false,
        error: new Error("Git clone failed"),
      });

      const projectId = "proj_123";
      await createTestImportJob(env, {
        namespace: "@userA",
        slug: "fail-project",
        status: "queued",
        projectId,
      });

      // Process the import
      const importMessage: ImportJobMessage = {
        type: "github.import",
        importId: "import_1",
        projectId,
        namespace: "@userA",
        slug: "fail-project",
        githubUrl: "https://github.com/test/repo",
        branch: "main",
        depth: 10,
        timestamp: new Date().toISOString(),
      };

      const message = createMockMessage(importMessage);
      const batch = createMockBatch([message], "stratum-imports");

      await handleImportQueue(batch, env);

      const { getImportProgress } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });
      const progress = await getImportProgress(env.DB, "@userA", "fail-project", logger);

      expect(progress.data?.status).toBe("failed");
      expect(progress.data?.logs.some((log) => log.message.includes("failed"))).toBe(true);
    });
  });

  describe("Sync Job Flow", () => {
    // Generous timeout: the full queue round-trip is fast locally but has
    // blown the default 5s budget on contended CI runners.
    it("should process a sync job successfully", { timeout: 20_000 }, async () => {
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
        namespace: "@userA",
        slug: "sync-project",
        status: "completed",
        projectId,
      });

      const syncMessage: SyncJobMessage = {
        type: "github.sync",
        importId: "sync_1",
        projectId,
        namespace: "@userA",
        slug: "sync-project",
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
      const progress = await getImportProgress(env.DB, "@userA", "sync-project", logger);

      expect(progress.data?.status).toBe("completed");
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

  describe("Concurrent Import Handling", () => {
    it("should handle multiple concurrent imports through queue", async () => {
      const { importFromGitHub } = await import("../../src/storage/git-ops");
      vi.mocked(importFromGitHub).mockResolvedValue({
        success: true,
        data: {
          remote: "https://artifacts.example.com/repos/test__repo",
          token: "tok_abc123",
        },
      });

      // Create multiple projects and jobs
      const projects = ["project-1", "project-2", "project-3"];
      const messages: Message<ImportJobMessage>[] = [];

      for (let i = 0; i < projects.length; i++) {
        const slug = projects[i];
        const projectId = `proj_${i}`;
        await createTestImportJob(env, {
          namespace: "@userA",
          slug,
          status: "queued",
          projectId,
        });

        messages.push(
          createMockMessage<ImportJobMessage>({
            type: "github.import",
            importId: `import_${i}`,
            projectId,
            namespace: "@userA",
            slug,
            githubUrl: `https://github.com/test/${slug}`,
            branch: "main",
            depth: 10,
            timestamp: new Date().toISOString(),
          }),
        );
      }

      const batch = createMockBatch(messages, "stratum-imports");
      await handleImportQueue(batch, env);

      // All messages should be acknowledged
      for (const message of messages) {
        expect(message.ack).toHaveBeenCalled();
      }

      // All jobs should be completed
      const { getImportProgress } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });

      for (const slug of projects) {
        const progress = await getImportProgress(env.DB, "@userA", slug, logger);
        expect(progress.data?.status).toBe("completed");
      }
    });
  });

  describe("Submodule rejection (#258)", () => {
    const enc = (s: string) => new TextEncoder().encode(s);

    /**
     * Builds a fully local "clone" (real git objects in a fresh MemoryFS, no
     * network) with `main` at a single commit, optionally containing a gitlink
     * tree entry and/or a `.gitmodules` file. Wired in as `cloneRepo`'s mock
     * implementation so `processImportJob`'s real `scanForSubmoduleContent`
     * runs against genuine tree objects exactly as it would against a real
     * clone of the just-imported repo.
     */
    async function buildScannedRepo(opts: {
      gitlink?: boolean;
      gitmodules?: boolean;
      branch?: string;
    }) {
      const branch = opts.branch ?? "main";
      const raw = new MemoryFS();
      const fs = raw.toNodeFS();
      const gitfs = fs;
      const dir = "/";
      const gitdir = "/.git";
      await git.init({ fs: gitfs, dir, defaultBranch: "main" });

      const entries: { mode: string; name: string; oid: string }[] = [];
      const objects: { oid: string; bytes: Uint8Array }[] = [];

      const readme = await blobObject(enc("hello\n"));
      objects.push(readme);
      entries.push({ mode: "100644", name: "README.md", oid: readme.oid });

      if (opts.gitlink) {
        // A gitlink lives inside a real subtree because a tree entry name
        // cannot contain a slash (mirrors tests/squash-merge-modes.test.ts).
        const vendorTree = await treeObject([{ mode: "160000", name: "lib", oid: "a".repeat(40) }]);
        objects.push(vendorTree);
        entries.push({ mode: "40000", name: "vendor", oid: vendorTree.oid });
      }
      if (opts.gitmodules) {
        const gitmodules = await blobObject(
          enc('[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://example.test/lib.git\n'),
        );
        objects.push(gitmodules);
        entries.push({ mode: "100644", name: ".gitmodules", oid: gitmodules.oid });
      }

      const tree = await treeObject(entries);
      objects.push(tree);
      const commit = await commitObject({
        tree: tree.oid,
        parents: [],
        message: "seed",
        timestamp: 1700000000,
      });
      objects.push(commit);

      for (const o of objects) await placeLooseObject(fs, gitdir, o.oid, o.bytes);
      await git.writeRef({
        fs: gitfs,
        dir,
        ref: `refs/heads/${branch}`,
        value: commit.oid,
        force: true,
      });

      return { fs, dir };
    }

    /**
     * Drives one whole import job through the queue consumer and hands back
     * the stored progress record — the only externally visible verdict on
     * whether the submodule guard rejected, skipped, or passed the repo.
     * `branch` is the branch the user selected for the import, which the
     * guard is required to scan (a repo imported from `trunk` has no `main`).
     */
    async function runImport(slug: string, branch = "main") {
      const { importFromGitHub } = await import("../../src/storage/git-ops");
      vi.mocked(importFromGitHub).mockResolvedValue({
        success: true,
        data: {
          remote: `https://artifacts.example.com/repos/test__${slug}`,
          token: "tok_abc123",
        },
      });

      const projectId = "proj_submodule";
      await createTestImportJob(env, { namespace: "@userA", slug, status: "queued", projectId });

      const message = createMockMessage<ImportJobMessage>({
        type: "github.import",
        importId: "import_1",
        projectId,
        namespace: "@userA",
        slug,
        githubUrl: "https://github.com/test/repo",
        branch,
        depth: 10,
        timestamp: new Date().toISOString(),
      });
      await handleImportQueue(createMockBatch([message], "stratum-imports"), env);

      const { getImportProgress } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const logger = createLogger({ component: "Test" });
      return getImportProgress(env.DB, "@userA", slug, logger);
    }

    it("rejects an import whose tree contains a gitlink entry", async () => {
      const { freshRepoToken, cloneRepo } = await import("../../src/storage/git-ops");
      vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "scan-token" });
      vi.mocked(cloneRepo).mockResolvedValue({
        success: true,
        data: await buildScannedRepo({ gitlink: true }),
      });

      const progress = await runImport("gitlink-project");

      expect(progress.data?.status).toBe("failed");
      expect(
        progress.data?.logs.some(
          (log) => log.message.includes("submodule") || log.message.includes("gitlink"),
        ),
      ).toBe(true);
    });

    it("rejects an import whose tree contains only a .gitmodules file", async () => {
      const { freshRepoToken, cloneRepo } = await import("../../src/storage/git-ops");
      vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "scan-token" });
      vi.mocked(cloneRepo).mockResolvedValue({
        success: true,
        data: await buildScannedRepo({ gitmodules: true }),
      });

      const progress = await runImport("gitmodules-only-project");

      expect(progress.data?.status).toBe("failed");
      expect(progress.data?.logs.some((log) => log.message.includes("submodule"))).toBe(true);
    });

    it("skips the guard without blocking the import when the scan cannot run", async () => {
      // The guard is best-effort: an infra failure must not turn a healthy
      // repo into a failed import. Each of the three ways the scan can fail
      // to produce a report takes that path. processImportJob also warns that
      // the guard was skipped, so "did not scan" is not silently
      // indistinguishable from "scanned, found nothing" -- that line goes to
      // the pino logger, which this suite has no seam to capture, so only the
      // skip-does-not-block contract is asserted here.
      const { freshRepoToken, cloneRepo } = await import("../../src/storage/git-ops");
      const failure = new AppError("scan unavailable", "EXTERNAL_SERVICE_ERROR", 502);
      const cases = [
        {
          name: "token mint fails",
          arrange: async () => {
            vi.mocked(freshRepoToken).mockResolvedValue({ success: false, error: failure });
          },
        },
        {
          name: "clone fails",
          arrange: async () => {
            vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "scan-token" });
            vi.mocked(cloneRepo).mockResolvedValue({ success: false, error: failure });
          },
        },
        {
          // The scan reads the tree at the imported branch. A clone that comes
          // back without that ref at all (a half-written fork, a fetch that
          // dropped the branch) makes the walk itself fail, so the guard never
          // produces a report.
          name: "tree walk fails (cloned tree has no such ref)",
          arrange: async () => {
            vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "scan-token" });
            vi.mocked(cloneRepo).mockResolvedValue({
              success: true,
              data: await buildScannedRepo({ branch: "master", gitlink: true }),
            });
          },
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        await testCase.arrange();
        const progress = await runImport(`scan-unavailable-${index}`);
        expect(progress.data?.status, testCase.name).toBe("completed");
      }
    });

    it("scans the imported branch, so a non-`main` repo is still rejected (#258)", async () => {
      // An imported repo keeps its source branch name, and nothing in it is
      // called `main`. Scanning `main` regardless would fail to resolve the
      // ref, collapse to "could not scan", and wave the repo through — the
      // guard silently unenforced for every project not on `main`.
      const { freshRepoToken, cloneRepo } = await import("../../src/storage/git-ops");
      vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "scan-token" });
      vi.mocked(cloneRepo).mockResolvedValue({
        success: true,
        data: await buildScannedRepo({ gitlink: true, branch: "trunk" }),
      });

      const progress = await runImport("trunk-gitlink-project", "trunk");

      expect(progress.data?.status).toBe("failed");
      expect(
        progress.data?.logs.some(
          (log) => log.message.includes("submodule") || log.message.includes("gitlink"),
        ),
      ).toBe(true);
      // The clone has to be pinned to that branch too — a clone of `main`
      // would leave the scan nothing correct to read.
      expect(vi.mocked(cloneRepo)).toHaveBeenCalledWith(
        expect.any(String),
        "scan-token",
        expect.anything(),
        { ref: "trunk" },
      );
    });

    it("reports a cancellation that lands during the scan as cancelled, not as a submodule failure", async () => {
      // The scan clones and walks a tree, so it is wide enough for a user's
      // cancel to arrive mid-flight. Reporting that as "failed: submodules"
      // would blame the repo for something the user chose, and would fire a
      // failure notification for an import nobody was still waiting on.
      const { freshRepoToken, cloneRepo } = await import("../../src/storage/git-ops");
      const { cancelImportJob } = await import("../../src/storage/imports");
      const { createLogger } = await import("../../src/utils/logger");
      const cancelLogger = createLogger({ component: "Test" });
      vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "scan-token" });
      vi.mocked(cloneRepo).mockImplementation(async () => {
        // Cancel while the scan is in flight — the window this guards.
        await cancelImportJob(env.DB, "@userA", "cancelled-mid-scan", cancelLogger);
        return { success: true, data: await buildScannedRepo({ gitlink: true }) };
      });

      const { updateImportStatus } = await import("../../src/storage/imports");
      await runImport("cancelled-mid-scan");

      // A cancelled import is marked "cancelled" and then deleted, so assert
      // on the status transition rather than on the (now absent) job.
      const statuses = vi
        .mocked(updateImportStatus)
        .mock.calls.filter((call) => call[2] === "cancelled-mid-scan")
        .map((call) => call[3]);
      expect(statuses).toContain("cancelled");
      // The point of the guard: the gitlink in the tree must NOT turn the
      // user's cancellation into a submodule rejection.
      expect(statuses).not.toContain("failed");
    });

    it("completes normally when the tree has neither a gitlink nor .gitmodules", async () => {
      const { freshRepoToken, cloneRepo } = await import("../../src/storage/git-ops");
      vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "scan-token" });
      vi.mocked(cloneRepo).mockResolvedValue({ success: true, data: await buildScannedRepo({}) });

      const progress = await runImport("clean-project");

      expect(progress.data?.status).toBe("completed");
    });
  });
});
