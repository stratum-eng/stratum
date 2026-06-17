/**
 * Tests for Task 2: UI route handlers pass syncStatus and canSync to RepoPage.
 *
 * Verifies that:
 * - /:namespace/:slug passes canSync:true when the logged-in user is the project owner
 *   AND the project has a sourceUrl.
 * - /:namespace/:slug passes canSync:false when the user is not the owner.
 * - syncStatus is null (not an error) when getSyncStatus returns a failure.
 * - The deprecated /p/:name handler also passes the upstream fields through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ProjectEntry } from "../src/types";

// ---------------------------------------------------------------------------
// Auth mocks
// ---------------------------------------------------------------------------

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === "stratum_user_owner_token0000000000000000") {
      return {
        success: true,
        data: {
          id: "user_owner",
          email: "owner@example.com",
          username: "owner",
          tokenHash: "hashOwner",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    if (token === "stratum_user_other_token0000000000000000") {
      return {
        success: true,
        data: {
          id: "user_other",
          email: "other@example.com",
          username: "other",
          tokenHash: "hashOther",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
  getUser: vi.fn(async (_db: unknown, userId: string) => {
    if (userId === "user_owner") {
      return {
        success: true,
        data: {
          id: "user_owner",
          email: "owner@example.com",
          username: "owner",
          tokenHash: "hashOwner",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    if (userId === "user_other") {
      return {
        success: true,
        data: {
          id: "user_other",
          email: "other@example.com",
          username: "other",
          tokenHash: "hashOther",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
  getUserByEmail: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  createUser: vi.fn(),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({
    success: false,
    error: { message: "Agent not found" },
  })),
}));

// ---------------------------------------------------------------------------
// Rate-limit pass-through
// ---------------------------------------------------------------------------

vi.mock("../src/middleware/rate-limit", () => ({
  rateLimitMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  checkImportRateLimit: vi.fn(async () => ({ allowed: true })),
  recordImportAttempt: vi.fn(),
  importRateLimitMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  releaseImportLock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Analytics pass-through
// ---------------------------------------------------------------------------

vi.mock("../src/middleware/analytics", () => ({
  analyticsMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

// ---------------------------------------------------------------------------
// Sync storage mock — controllable per test
// ---------------------------------------------------------------------------

const mockGetSyncStatus = vi.fn();
const mockGetProjectSourceUrl = vi.fn();

vi.mock("../src/storage/sync", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage/sync")>();
  return {
    ...original,
    getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
    getProjectSourceUrl: (...args: unknown[]) => mockGetProjectSourceUrl(...args),
  };
});

// ---------------------------------------------------------------------------
// Git-ops mock (used in fallback path when snapshot is absent)
// ---------------------------------------------------------------------------

vi.mock("../src/storage/git-ops", () => ({
  initAndPush: vi.fn(async () => ({ success: true, data: "sha_init" })),
  cloneRepo: vi.fn(async () => ({ fs: {}, dir: "/" })),
  commitAndPush: vi.fn(async () => "sha_commit"),
  mergeWorkspaceIntoProject: vi.fn(async () => "sha_merge"),
  listFilesInRepo: vi.fn(async () => ({ success: true, data: ["src/index.ts"] })),
  getCommitLog: vi.fn(async () => ({
    success: true,
    data: [
      {
        sha: "abc1234",
        message: "Initial commit",
        author: "Stratum <system@usestratum.dev>",
        timestamp: 1000,
      },
    ],
  })),
  readFileFromRepo: vi.fn(async () => ({ success: false, error: { message: "Not found" } })),
}));

// ---------------------------------------------------------------------------
// Other storage mocks
// ---------------------------------------------------------------------------

vi.mock("../src/storage/changes", () => ({
  listChanges: vi.fn(async () => ({ success: true, data: [] })),
  getChange: vi.fn(async () => ({ success: false, error: { message: "Change not found" } })),
}));

vi.mock("../src/storage/provenance", () => ({
  getProvenance: vi.fn(async () => ({
    success: false,
    error: { message: "Provenance not found" },
  })),
  listProvenance: vi.fn(async () => ({ success: true, data: [] })),
}));

vi.mock("../src/storage/imports", () => ({
  getImportProgress: vi.fn(async () => ({ success: true, data: null })),
  createImportJob: vi.fn(async () => ({ success: true, data: { id: "import-001" } })),
  updateImportStatus: vi.fn(async () => ({ success: true, data: undefined })),
  isImportCancelled: vi.fn(async () => false),
  deleteImportJob: vi.fn(async () => ({ success: true, data: undefined })),
  getImportById: vi.fn(async () => ({ success: true, data: null })),
  listActiveImports: vi.fn(async () => ({ success: true, data: [] })),
  cancelImportJob: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("../src/queue/import-queue", () => ({
  queueSyncJob: vi.fn(async () => undefined),
  queueImportJob: vi.fn(async () => undefined),
  handleImportQueue: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OWNER_HEADERS = {
  Authorization: "Bearer stratum_user_owner_token0000000000000000",
};
const OTHER_HEADERS = {
  Authorization: "Bearer stratum_user_other_token0000000000000000",
};

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
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function makeEnv(kv?: KVNamespace): Env {
  return {
    ARTIFACTS: {
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      import: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: kv ?? makeKV(),
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true, results: [], meta: {} }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        first: vi.fn().mockResolvedValue(null),
      })),
    } as unknown as D1Database,
    IMPORT_QUEUE: {
      send: vi.fn(),
      sendBatch: vi.fn(),
    } as unknown as Queue,
  };
}

function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "proj-001",
    name: "my-repo",
    slug: "my-repo",
    namespace: "@owner",
    ownerId: "user_owner",
    ownerType: "user",
    remote: "https://artifacts.example.com/repos/owner-my-repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    visibility: "public",
    sourceUrl: "https://github.com/acme/api",
    sourceProvider: "github",
    sourceOwner: "acme",
    sourceRepo: "api",
    ...overrides,
  };
}

function seedProject(kv: KVNamespace, project: ProjectEntry): void {
  void (kv as unknown as { put: (k: string, v: string) => Promise<void> }).put(
    `project:${project.namespace}:${project.slug}`,
    JSON.stringify(project),
  );
}

function seedLegacyProject(kv: KVNamespace, project: ProjectEntry): void {
  void (kv as unknown as { put: (k: string, v: string) => Promise<void> }).put(
    `project:${project.name}`,
    JSON.stringify(project),
  );
}

function getRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Task 2: UI route handlers pass syncStatus and canSync to RepoPage", () => {
  let env: Env;
  let kv: KVNamespace;

  beforeEach(() => {
    kv = makeKV();
    env = makeEnv(kv);
    vi.clearAllMocks();

    // Default: getSyncStatus returns a status object with hasUpdates
    mockGetSyncStatus.mockResolvedValue({
      success: true,
      data: {
        hasUpdates: true,
        commitsBehind: 3,
        latestCommit: "abc1234",
        lastCheckedAt: "2026-01-01T12:00:00.000Z",
      },
    });
    // Default: getProjectSourceUrl returns the sourceUrl
    mockGetProjectSourceUrl.mockImplementation(
      (project: ProjectEntry) => project.sourceUrl ?? project.githubUrl,
    );
  });

  describe("GET /:namespace/:slug", () => {
    it("passes canSync:true when logged-in user is project owner and project has sourceUrl", async () => {
      const project = makeProject();
      seedProject(kv, project);

      const res = await app.fetch(getRequest("/@owner/my-repo", OWNER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      // The sync form action is only rendered when hasSource && canSync
      // Form action points to the sync endpoint
      expect(html).toContain("/api/projects/@owner/my-repo/sync");
    });

    it("does not render sync button when user is not the owner (canSync:false)", async () => {
      const project = makeProject();
      seedProject(kv, project);

      const res = await app.fetch(getRequest("/@owner/my-repo", OTHER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      // The sync form/button should NOT be present for non-owners
      expect(html).not.toContain("/api/projects/@owner/my-repo/sync");
    });

    it("does not render sync button when unauthenticated (canSync:false)", async () => {
      const project = makeProject();
      seedProject(kv, project);

      const res = await app.fetch(getRequest("/@owner/my-repo"), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("/api/projects/@owner/my-repo/sync");
    });

    it("renders sync status card with sourceUrl even for non-owners", async () => {
      const project = makeProject();
      seedProject(kv, project);

      // Non-owner can still see the upstream link
      const res = await app.fetch(getRequest("/@owner/my-repo", OTHER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      // The sync card link to the sourceUrl should be present
      expect(html).toContain("github.com/acme/api");
    });

    it("syncStatus is null (not an error) when getSyncStatus returns a failure", async () => {
      const project = makeProject();
      seedProject(kv, project);

      // Simulate getSyncStatus KV failure
      mockGetSyncStatus.mockResolvedValue({
        success: false,
        error: { message: "KV read failed", code: "STORAGE_ERROR", status: 500 },
      });

      // Should not throw or 500 — renders the page normally
      const res = await app.fetch(getRequest("/@owner/my-repo", OWNER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      // Page still renders with the project data
      expect(html).toContain("my-repo");
      // syncStatus is null: "last checked" detail should not appear since syncStatus is null
      expect(html).not.toContain("Last checked:");
    });

    it("does not render sync card for projects without sourceUrl", async () => {
      const project = makeProject({ sourceUrl: undefined, sourceProvider: undefined });
      seedProject(kv, project);

      // getProjectSourceUrl returns undefined for projects without sourceUrl
      mockGetProjectSourceUrl.mockReturnValue(undefined);

      const res = await app.fetch(getRequest("/@owner/my-repo", OWNER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      // No sync card or sync button for scratch projects
      expect(html).not.toContain("/api/projects/@owner/my-repo/sync");
      expect(html).not.toContain("sync-status-card");
    });

    it("passes sourceUrl to render the upstream link in the sync card", async () => {
      const project = makeProject({
        sourceUrl: "https://github.com/acme/api",
        sourceOwner: "acme",
        sourceRepo: "api",
      });
      seedProject(kv, project);

      const res = await app.fetch(getRequest("/@owner/my-repo", OWNER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("https://github.com/acme/api");
    });
  });

  describe("GET /p/:name (deprecated handler)", () => {
    it("passes canSync:true for a legacy project with namespace and sourceUrl owned by user", async () => {
      const project = makeProject({
        name: "legacy-repo",
        slug: "legacy-repo",
        namespace: "@owner",
        visibility: "public",
      });
      // Legacy projects are stored by name key
      seedLegacyProject(kv, project);

      const res = await app.fetch(getRequest("/p/legacy-repo", OWNER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      // Sync button rendered when owner & has sourceUrl
      expect(html).toContain("/api/projects/@owner/legacy-repo/sync");
    });

    it("passes canSync:false for a legacy project without namespace", async () => {
      const project: ProjectEntry = {
        id: "proj-legacy",
        name: "old-project",
        slug: "old-project",
        // namespace intentionally absent (legacy)
        namespace: undefined as unknown as string,
        ownerId: "user_owner",
        ownerType: "user",
        remote: "https://artifacts.example.com/repos/old-project",
        createdAt: "2026-01-01T00:00:00.000Z",
        visibility: "public",
        sourceUrl: "https://github.com/acme/api",
        sourceProvider: "github",
      };
      seedLegacyProject(kv, project);

      const res = await app.fetch(getRequest("/p/old-project", OWNER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      // No namespace → canSync must be false → no sync button
      expect(html).not.toContain("/sync");
    });

    it("syncStatus is null when getSyncStatus fails for deprecated handler", async () => {
      const project = makeProject({
        name: "legacy-repo",
        slug: "legacy-repo",
        namespace: "@owner",
        visibility: "public",
      });
      seedLegacyProject(kv, project);

      mockGetSyncStatus.mockResolvedValue({
        success: false,
        error: { message: "KV read failed", code: "STORAGE_ERROR", status: 500 },
      });

      const res = await app.fetch(getRequest("/p/legacy-repo", OWNER_HEADERS), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("legacy-repo");
      // No "Last checked:" since syncStatus is null
      expect(html).not.toContain("Last checked:");
    });
  });
});
