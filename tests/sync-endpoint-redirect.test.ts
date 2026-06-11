/**
 * Tests for Task 1: sync endpoint redirect on non-JSON requests.
 *
 * Verifies that:
 * - A form-encoded POST (no JSON content-type) gets a 302 redirect to the project page.
 * - A JSON POST still returns a JSON response body.
 * - The "no updates" path also redirects for form POSTs.
 * - Error paths redirect for form POSTs with a reason query param.
 *
 * The real handler lives in projects.ts, mounted at /api/projects.
 * The UI form action is /api/projects/:namespace/:slug/sync.
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
// Sync storage mocks (controllable per-test)
// ---------------------------------------------------------------------------

const mockCheckForSyncUpdates = vi.fn();
const mockGetProjectSourceUrl = vi.fn();
const mockGetProjectProvider = vi.fn();
const mockGetSyncStatus = vi.fn();
const mockSetSyncInProgress = vi.fn();
const mockUpdateProjectSyncError = vi.fn();
const mockUpdateProjectAfterSync = vi.fn();

vi.mock("../src/storage/sync", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage/sync")>();
  return {
    ...original,
    checkForSyncUpdates: (...args: unknown[]) => mockCheckForSyncUpdates(...args),
    getProjectSourceUrl: (...args: unknown[]) => mockGetProjectSourceUrl(...args),
    getProjectProvider: (...args: unknown[]) => mockGetProjectProvider(...args),
    getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
    setSyncInProgress: (...args: unknown[]) => mockSetSyncInProgress(...args),
    updateProjectSyncError: (...args: unknown[]) => mockUpdateProjectSyncError(...args),
    updateProjectAfterSync: (...args: unknown[]) => mockUpdateProjectAfterSync(...args),
  };
});

// ---------------------------------------------------------------------------
// imports storage mock (createImportJob, updateImportStatus)
// ---------------------------------------------------------------------------

vi.mock("../src/storage/imports", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage/imports")>();
  return {
    ...original,
    createImportJob: vi.fn(async () => ({
      success: true,
      data: { id: "import-001" },
    })),
    updateImportStatus: vi.fn(async () => ({ success: true, data: undefined })),
    getImportProgress: vi.fn(async () => ({ success: true, data: null })),
    isImportCancelled: vi.fn(async () => false),
    deleteImportJob: vi.fn(async () => ({ success: true, data: undefined })),
    getImportById: vi.fn(async () => ({ success: true, data: null })),
    listActiveImports: vi.fn(async () => ({ success: true, data: [] })),
  };
});

// ---------------------------------------------------------------------------
// import-queue mock (queueSyncJob)
// ---------------------------------------------------------------------------

vi.mock("../src/queue/import-queue", () => ({
  queueSyncJob: vi.fn(async () => undefined),
  queueImportJob: vi.fn(async () => undefined),
  handleImportQueue: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// analytics pass-through
// ---------------------------------------------------------------------------

vi.mock("../src/middleware/analytics", () => ({
  analyticsMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OWNER_HEADERS = {
  Authorization: "Bearer stratum_user_owner_token0000000000000000",
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
    token: "tok_owner_my_repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    visibility: "private",
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

// Build a POST Request to the sync endpoint
function makeSyncRequest(
  namespace: string,
  slug: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/api/projects/${namespace}/${slug}/sync`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      ...OWNER_HEADERS,
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/projects/:namespace/:slug/sync — content-type redirect behaviour", () => {
  let env: Env;
  let kv: KVNamespace;

  beforeEach(() => {
    kv = makeKV();
    env = makeEnv(kv);
    vi.clearAllMocks();

    const project = makeProject();
    seedProject(kv, project);

    // Default: project has a source URL and a valid provider
    mockGetProjectSourceUrl.mockReturnValue("https://github.com/acme/api");
    mockGetProjectProvider.mockReturnValue("github");
    // Default: no sync currently in progress
    mockGetSyncStatus.mockResolvedValue({ success: true, data: { lastSyncStatus: "idle" } });
    mockSetSyncInProgress.mockResolvedValue(undefined);
    mockUpdateProjectSyncError.mockResolvedValue(undefined);
  });

  // -----------------------------------------------------------------------
  // 1.2  Successful sync → JSON returns JSON, form returns redirect
  // -----------------------------------------------------------------------

  describe("successful sync path (updates available)", () => {
    beforeEach(() => {
      mockCheckForSyncUpdates.mockResolvedValue({
        success: true,
        data: {
          hasUpdates: true,
          commitsBehind: 3,
          latestCommit: "abc1234",
          currentCommit: "old1234",
        },
      });
    });

    it("JSON POST returns 200 with JSON body", async () => {
      const res = await app.fetch(makeSyncRequest("@owner", "my-repo", "application/json"), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string };
      expect(body.status).toBe("queued");
    });

    it("form POST returns 302 redirect to project page with ?sync=queued", async () => {
      const res = await app.fetch(
        makeSyncRequest("@owner", "my-repo", "application/x-www-form-urlencoded"),
        env,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBe("/@owner/my-repo?sync=queued");
    });
  });

  // -----------------------------------------------------------------------
  // 1.1  "No updates" path
  // -----------------------------------------------------------------------

  describe("no updates path (already up to date)", () => {
    beforeEach(() => {
      mockCheckForSyncUpdates.mockResolvedValue({
        success: true,
        data: {
          hasUpdates: false,
          currentCommit: "abc1234",
        },
      });
    });

    it("JSON POST returns 200 with hasUpdates:false", async () => {
      const res = await app.fetch(makeSyncRequest("@owner", "my-repo", "application/json"), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hasUpdates?: boolean };
      expect(body.hasUpdates).toBe(false);
    });

    it("form POST returns 302 redirect to project page (no query params)", async () => {
      const res = await app.fetch(
        makeSyncRequest("@owner", "my-repo", "application/x-www-form-urlencoded"),
        env,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location");
      expect(location).toBe("/@owner/my-repo");
    });
  });

  // -----------------------------------------------------------------------
  // 1.3  Error path: no source URL
  // -----------------------------------------------------------------------

  describe("error path — no source URL", () => {
    beforeEach(() => {
      mockGetProjectSourceUrl.mockReturnValue(undefined);
    });

    it("JSON POST returns 400 JSON error", async () => {
      const res = await app.fetch(makeSyncRequest("@owner", "my-repo", "application/json"), env);
      expect(res.status).toBe(400);
    });

    it("form POST returns 302 redirect with sync=error&reason=no-source-url", async () => {
      const res = await app.fetch(
        makeSyncRequest("@owner", "my-repo", "application/x-www-form-urlencoded"),
        env,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toBe("/@owner/my-repo?sync=error&reason=no-source-url");
    });
  });

  // -----------------------------------------------------------------------
  // 1.3  Error path: unsupported provider
  // -----------------------------------------------------------------------

  describe("error path — unsupported provider", () => {
    beforeEach(() => {
      mockGetProjectProvider.mockReturnValue(null);
    });

    it("JSON POST returns 400", async () => {
      const res = await app.fetch(makeSyncRequest("@owner", "my-repo", "application/json"), env);
      expect(res.status).toBe(400);
    });

    it("form POST returns 302 redirect with sync=error&reason=unsupported-provider", async () => {
      const res = await app.fetch(
        makeSyncRequest("@owner", "my-repo", "application/x-www-form-urlencoded"),
        env,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toBe("/@owner/my-repo?sync=error&reason=unsupported-provider");
    });
  });

  // -----------------------------------------------------------------------
  // 1.3  Error path: sync already in progress
  // -----------------------------------------------------------------------

  describe("error path — sync already in progress", () => {
    beforeEach(() => {
      mockGetSyncStatus.mockResolvedValue({
        success: true,
        data: { lastSyncStatus: "in_progress" },
      });
    });

    it("JSON POST returns 400", async () => {
      const res = await app.fetch(makeSyncRequest("@owner", "my-repo", "application/json"), env);
      expect(res.status).toBe(400);
    });

    it("form POST returns 302 redirect with sync=error&reason=sync-in-progress", async () => {
      const res = await app.fetch(
        makeSyncRequest("@owner", "my-repo", "application/x-www-form-urlencoded"),
        env,
      );
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toBe("/@owner/my-repo?sync=error&reason=sync-in-progress");
    });
  });
});
