/**
 * GitHub import fidelity tests (issue #187):
 * - default-branch resolution (provider consulted only when the caller omits
 *   the branch; explicit branch wins; provider failure fails open to "main")
 * - configurable clone depth (1..1000, 0/"full" = full history, default 10)
 * - real progress signals (phase transitions + imported file counts)
 * - failure notifications to the triggering user (plus the admin copy)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ImportJobMessage, ImportProgress } from "../src/types";
import type { Message, MessageBatch } from "../src/types";
import { AppError } from "../src/utils/errors";
import { makeSqliteD1 } from "./helpers/sqlite-d1";

// ============================================================================
// Mocks
// ============================================================================

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db, token: string) => {
    if (token === "stratum_user_userA_token000000000000000000") {
      return {
        success: true,
        data: {
          id: "user_A",
          email: "userA@example.com",
          username: "usera",
          tokenHash: "hashA",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
  getUser: vi.fn(async (_db, userId: string) => {
    if (userId === "user_A") {
      return {
        success: true,
        data: {
          id: "user_A",
          email: "userA@example.com",
          username: "usera",
          tokenHash: "hashA",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({
    success: false,
    error: { message: "Agent not found" },
  })),
}));

// Map-based import-job store, with a per-job status history so tests can
// assert the phase transitions the progress UI would see.
const mockImportJobs = new Map<string, ImportProgress>();
const statusHistory = new Map<string, string[]>();
let mockJobIdCounter = 0;

function recordStatus(key: string, status: string): void {
  const history = statusHistory.get(key) ?? [];
  history.push(status);
  statusHistory.set(key, history);
}

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
      ...(params.depth !== undefined ? { depth: params.depth } : {}),
      startedAt: now,
      updatedAt: now,
      version: 1,
      progress: { processedFiles: 0 },
      errors: [],
      logs: [{ message: "Import queued", level: "info", timestamp: now }],
    };
    const key = `${params.namespace}:${params.slug}`;
    mockImportJobs.set(key, job);
    recordStatus(key, "queued");
    return { success: true, data: job };
  }),

  getImportProgress: vi.fn(async (_db, namespace: string, slug: string) => {
    const job = mockImportJobs.get(`${namespace}:${slug}`);
    return { success: true, data: job ?? null };
  }),

  getLatestImportDepth: vi.fn(
    async (_db, namespace: string, slug: string) =>
      mockImportJobs.get(`${namespace}:${slug}`)?.depth,
  ),

  updateImportProgress: vi.fn(async (_db, namespace, slug, updates, _logger) => {
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
      logs: updates.logs ? [...existing.logs, ...updates.logs].slice(-100) : existing.logs,
      errors: updates.errors ? [...existing.errors, ...updates.errors].slice(-50) : existing.errors,
    };
    mockImportJobs.set(key, updated);
    if (updates.status) recordStatus(key, updates.status);
    return { success: true, data: updated };
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
      logs: message
        ? [
            ...existing.logs,
            {
              message,
              level: (status === "failed" ? "error" : "info") as "error" | "info",
              timestamp: new Date().toISOString(),
            },
          ].slice(-100)
        : existing.logs,
    };
    if (["completed", "failed", "cancelled"].includes(status)) {
      updated.completedAt = new Date().toISOString();
    }
    mockImportJobs.set(key, updated);
    recordStatus(key, status);
    return { success: true, data: updated };
  }),

  cancelImportJob: vi.fn(),
  isImportCancelled: vi.fn(async (_db, namespace, slug) => {
    const job = mockImportJobs.get(`${namespace}:${slug}`);
    return job?.status === "cancelling" || job?.status === "cancelled";
  }),
  deleteImportJob: vi.fn(async (_db, namespace, slug) => {
    mockImportJobs.delete(`${namespace}:${slug}`);
    return { success: true, data: undefined };
  }),
  getImportById: vi.fn(async () => ({ success: true, data: null })),
  listActiveImports: vi.fn(async () => ({ success: true, data: [] })),
  recoverStalledImport: vi.fn(async () => ({ success: true, data: false })),
  cleanupOldImports: vi.fn(async () => ({ success: true, data: 0 })),
}));

vi.mock("../src/middleware/rate-limit", () => ({
  rateLimitMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  }),
  importRateLimitMiddleware: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  }),
  checkImportRateLimit: vi.fn(async () => ({ allowed: true })),
  recordImportAttempt: vi.fn(),
  releaseImportLock: vi.fn(async () => undefined),
}));

vi.mock("../src/storage/git-ops", () => ({
  importFromGitHub: vi.fn(),
  initAndPush: vi.fn(),
  cloneRepo: vi.fn(),
  commitAndPush: vi.fn(),
  mergeWorkspaceIntoProject: vi.fn(),
  listFilesInRepo: vi.fn(),
  getCommitLog: vi.fn(),
  readFileFromRepo: vi.fn(),
  freshRepoToken: vi.fn(),
  // The post-import submodule guard (#258). Left unconfigured it rejects the
  // token mint the way every other mock in this suite does nothing, so the
  // guard skips itself and the pre-existing tests below are unaffected; the
  // rejection test drives it explicitly. The real scan is covered against
  // genuine tree objects in tests/integration/import-flow.test.ts.
  scanForSubmoduleContent: vi.fn(),
  submoduleUnsupportedError: vi.fn(
    () =>
      new Error(
        "Repository uses git submodules (found gitlink entry at vendor/lib), which Stratum does not support yet. Remove submodules and retry.",
      ),
  ),
}));

vi.mock("../src/storage/repo-snapshot", () => ({
  SNAPSHOT_COMMIT_LIMIT: 20,
  writeRepoSnapshot: vi.fn(async () => ({ success: true, data: undefined })),
  readRepoSnapshot: vi.fn(async () => ({ success: true, data: null })),
  writeSnapshotFromRepo: vi.fn(async () => ({ fileCount: 3 })),
}));

// ============================================================================
// Helpers
// ============================================================================

const USER_A_HEADERS = {
  Authorization: "Bearer stratum_user_userA_token000000000000000000",
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

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: {
      create: vi.fn(async (name: string) => ({
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
    // Real schema: the import route records a namespace claim in D1 before it
    // writes the project.
    DB: makeSqliteD1().db,
    IMPORT_QUEUE: { send: vi.fn(), sendBatch: vi.fn() } as unknown as Queue,
    ...overrides,
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

/** GitHub-style repo metadata response used by default-branch resolution. */
function githubRepoMetadata(defaultBranch: string): Response {
  return new Response(
    JSON.stringify({
      name: "repo",
      full_name: "test/repo",
      description: null,
      private: false,
      default_branch: defaultBranch,
      clone_url: "https://github.com/test/repo.git",
      ssh_url: "git@github.com:test/repo.git",
      html_url: "https://github.com/test/repo",
      stargazers_count: 1,
      forks_count: 0,
      updated_at: "2026-01-01T00:00:00Z",
      size: 100,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function stubFetch(
  impl: (input: RequestInfo | URL) => Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
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

function createMockBatch<T>(messages: Message<T>[]): MessageBatch<T> {
  return {
    queue: "stratum-imports",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<T>;
}

async function seedImportJob(params: {
  namespace: string;
  slug: string;
  projectId: string;
  depth?: number;
}): Promise<ImportProgress> {
  const { createImportJob } = await import("../src/storage/imports");
  const { createLogger } = await import("../src/utils/logger");
  const logger = createLogger({ component: "Test" });
  const result = await createImportJob(
    {} as D1Database,
    {
      id: `import_${mockJobIdCounter + 1}`,
      projectId: params.projectId,
      namespace: params.namespace,
      slug: params.slug,
      sourceUrl: "https://github.com/test/repo",
      branch: "main",
      ...(params.depth !== undefined ? { depth: params.depth } : {}),
    },
    logger,
  );
  if (!result.success) throw new Error("failed to seed import job");
  return result.data;
}

async function seedProject(
  env: Env,
  params: { namespace: string; slug: string; projectId: string },
): Promise<void> {
  await env.STATE.put(
    `project:${params.namespace}:${params.slug}`,
    JSON.stringify({
      id: params.projectId,
      name: params.slug,
      slug: params.slug,
      namespace: params.namespace,
      ownerId: "user_A",
      ownerType: "user",
      remote: `https://artifacts.example.com/repos/${params.namespace.replace("@", "")}-${params.slug}`,
      createdAt: new Date().toISOString(),
    }),
  );
}

function importMessage(overrides: Partial<ImportJobMessage> = {}): ImportJobMessage {
  return {
    type: "github.import",
    importId: "import_1",
    projectId: "proj_1",
    namespace: "@usera",
    slug: "repo",
    githubUrl: "https://github.com/test/repo",
    branch: "main",
    depth: 10,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  mockImportJobs.clear();
  statusHistory.clear();
  mockJobIdCounter = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ----------------------------------------------------------------------------
// validateCloneDepth
// ----------------------------------------------------------------------------

/**
 * Assert the file-count progress write landed before the status flipped to
 * "completed". Ordering is load-bearing, not cosmetic: the progress stream
 * (GET /projects/:ns/:slug/import/stream) closes itself on a terminal status
 * and the browser closes its EventSource with it, so counts written after the
 * flip are never delivered to anyone watching the import.
 */
async function expectCountsBeforeCompletion(expectedFiles: number) {
  const { updateImportProgress, updateImportStatus } = await import("../src/storage/imports");
  const progressCalls = vi.mocked(updateImportProgress).mock;
  const statusCalls = vi.mocked(updateImportStatus).mock;

  const progressIndex = progressCalls.calls.findIndex(
    (call) =>
      (call[3] as { progress?: { processedFiles?: number } } | undefined)?.progress
        ?.processedFiles === expectedFiles,
  );
  const completedIndex = statusCalls.calls.findIndex((call) => call[3] === "completed");
  expect(progressIndex).toBeGreaterThanOrEqual(0);
  expect(completedIndex).toBeGreaterThanOrEqual(0);
  expect(progressCalls.invocationCallOrder[progressIndex]).toBeLessThan(
    statusCalls.invocationCallOrder[completedIndex] as number,
  );
}

describe("validateCloneDepth", () => {
  it("defaults to DEFAULT_CLONE_DEPTH when absent", async () => {
    const { DEFAULT_CLONE_DEPTH, validateCloneDepth } = await import("../src/utils/validation");
    for (const value of [undefined, null, ""]) {
      expect(validateCloneDepth(value)).toEqual({ valid: true, depth: DEFAULT_CLONE_DEPTH });
    }
    expect(DEFAULT_CLONE_DEPTH).toBe(10);
  });

  it("accepts 0 and 'full' as full history", async () => {
    const { FULL_HISTORY_DEPTH, validateCloneDepth } = await import("../src/utils/validation");
    for (const value of [0, "0", "full", "FULL", " full "]) {
      expect(validateCloneDepth(value)).toEqual({ valid: true, depth: FULL_HISTORY_DEPTH });
    }
  });

  it("accepts integers within 1..1000 (numbers and numeric strings)", async () => {
    const { validateCloneDepth } = await import("../src/utils/validation");
    expect(validateCloneDepth(1)).toEqual({ valid: true, depth: 1 });
    expect(validateCloneDepth(1000)).toEqual({ valid: true, depth: 1000 });
    expect(validateCloneDepth("25")).toEqual({ valid: true, depth: 25 });
  });

  it("rejects out-of-range and malformed values", async () => {
    const { validateCloneDepth } = await import("../src/utils/validation");
    for (const value of [-1, 1001, 2.5, Number.NaN, "abc", "-5", "1.5", {}, [], true]) {
      const result = validateCloneDepth(value);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toMatch(/depth/);
    }
  });
});

// ----------------------------------------------------------------------------
// resolveDefaultBranch
// ----------------------------------------------------------------------------

describe("resolveDefaultBranch", () => {
  it("returns the provider's default branch", async () => {
    const fetchMock = stubFetch(async () => githubRepoMetadata("develop"));
    const { resolveDefaultBranch } = await import("../src/storage/git-providers");
    const { createLogger } = await import("../src/utils/logger");
    const branch = await resolveDefaultBranch(
      "https://github.com/test/repo",
      {},
      createLogger({ component: "Test" }),
    );
    expect(branch).toBe("develop");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("falls back to 'main' when the provider API fails", async () => {
    stubFetch(async () => new Response("boom", { status: 500 }));
    const { resolveDefaultBranch } = await import("../src/storage/git-providers");
    const { createLogger } = await import("../src/utils/logger");
    const branch = await resolveDefaultBranch(
      "https://github.com/test/repo",
      {},
      createLogger({ component: "Test" }),
    );
    expect(branch).toBe("main");
  });

  it("falls back to 'main' when the network is down", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });
    const { resolveDefaultBranch } = await import("../src/storage/git-providers");
    const { createLogger } = await import("../src/utils/logger");
    const branch = await resolveDefaultBranch(
      "https://github.com/test/repo",
      {},
      createLogger({ component: "Test" }),
    );
    expect(branch).toBe("main");
  });

  it("falls back to 'main' when the provider client throws outright", async () => {
    const { githubProvider, resolveDefaultBranch } = await import("../src/storage/git-providers");
    const { createLogger } = await import("../src/utils/logger");
    const spy = vi
      .spyOn(githubProvider, "getDefaultBranch")
      .mockRejectedValue(new Error("provider exploded"));
    try {
      const branch = await resolveDefaultBranch(
        "https://github.com/test/repo",
        {},
        createLogger({ component: "Test" }),
      );
      expect(branch).toBe("main");
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to 'main' for unrecognized URLs without calling the network", async () => {
    const fetchMock = stubFetch(async () => githubRepoMetadata("develop"));
    const { resolveDefaultBranch } = await import("../src/storage/git-providers");
    const { createLogger } = await import("../src/utils/logger");
    const branch = await resolveDefaultBranch(
      "https://example.com/not/a-provider",
      {},
      createLogger({ component: "Test" }),
    );
    expect(branch).toBe("main");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------
// Import route: default branch + depth + initiator
// ----------------------------------------------------------------------------

describe("POST /api/projects/:namespace/:slug/import", () => {
  async function postImport(env: Env, slug: string, body: Record<string, unknown>) {
    const { default: app } = await import("../src/index");
    return app.fetch(
      request("POST", `/api/projects/@usera/${slug}/import`, body, USER_A_HEADERS),
      env,
    );
  }

  it("uses the caller-specified branch verbatim without consulting the provider", async () => {
    const fetchMock = stubFetch(async () => githubRepoMetadata("develop"));
    const env = makeEnv();

    const res = await postImport(env, "explicit-branch", {
      url: "https://github.com/test/repo",
      branch: "release-1",
    });
    expect(res.status).toBe(201);

    // Provider API never consulted
    expect(fetchMock).not.toHaveBeenCalled();

    // Queue message carries the explicit branch
    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "release-1", initiatedBy: "user_A" }),
    );

    // Import job + persisted project both carry the explicit branch
    expect(mockImportJobs.get("@usera:explicit-branch")?.branch).toBe("release-1");
    const stored = JSON.parse((await env.STATE.get("project:@usera:explicit-branch")) as string);
    expect(stored.sourceDefaultBranch).toBe("release-1");
    expect(stored.githubDefaultBranch).toBe("release-1");
  });

  it("resolves the provider's default branch when the caller omits branch", async () => {
    const fetchMock = stubFetch(async () => githubRepoMetadata("develop"));
    const env = makeEnv();

    const res = await postImport(env, "resolved-branch", { url: "https://github.com/test/repo" });
    expect(res.status).toBe(201);

    expect(fetchMock).toHaveBeenCalled();
    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ branch: "develop" }));
    expect(mockImportJobs.get("@usera:resolved-branch")?.branch).toBe("develop");
    const stored = JSON.parse((await env.STATE.get("project:@usera:resolved-branch")) as string);
    expect(stored.sourceDefaultBranch).toBe("develop");
  });

  it("falls back to 'main' when default-branch resolution fails (fail-open)", async () => {
    stubFetch(async () => new Response("rate limited", { status: 429 }));
    const env = makeEnv();

    const res = await postImport(env, "fallback-branch", { url: "https://github.com/test/repo" });
    expect(res.status).toBe(201);

    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ branch: "main" }));
  });

  it("defaults depth to 10 and threads a custom depth into the queue message", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const env = makeEnv();

    await postImport(env, "depth-default", { url: "https://github.com/test/repo", branch: "main" });
    let send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ depth: 10 }));

    const env2 = makeEnv();
    await postImport(env2, "depth-custom", {
      url: "https://github.com/test/repo",
      branch: "main",
      depth: 250,
    });
    send = vi.mocked(env2.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ depth: 250 }));
  });

  it("accepts depth 0 and 'full' as full history (depth 0 in the message)", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    for (const depth of [0, "full"]) {
      const env = makeEnv();
      const res = await postImport(env, `depth-full-${depth}`, {
        url: "https://github.com/test/repo",
        branch: "main",
        depth,
      });
      expect(res.status).toBe(201);
      const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ depth: 0 }));
    }
  });

  it("rejects out-of-bounds or malformed depth with 400", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    for (const depth of [-1, 1001, 2.5, "abc"]) {
      const env = makeEnv();
      const res = await postImport(env, "depth-invalid", {
        url: "https://github.com/test/repo",
        branch: "main",
        depth,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/depth/);
      const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
      expect(send).not.toHaveBeenCalled();
    }
  });
});

// ----------------------------------------------------------------------------
// Import route: re-trigger, direct fallback, and form-encoded depth
// ----------------------------------------------------------------------------

describe("import route edge paths", () => {
  it("re-queues an incomplete import with the default depth and the initiator", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const env = makeEnv();

    await seedProject(env, { namespace: "@usera", slug: "retrig", projectId: "proj_r" });
    await seedImportJob({ namespace: "@usera", slug: "retrig", projectId: "proj_r" });
    const { updateImportStatus } = await import("../src/storage/imports");
    const { createLogger } = await import("../src/utils/logger");
    await updateImportStatus(
      {} as D1Database,
      "@usera",
      "retrig",
      "failed",
      createLogger({ component: "Test" }),
    );

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/@usera/retrig/import",
        { url: "https://github.com/test/repo" },
        USER_A_HEADERS,
      ),
      env,
    );
    expect(res.status).toBe(200);

    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 10, initiatedBy: "user_A", branch: "main" }),
    );
  });

  /**
   * The dedicated retry endpoint is a separate path from the re-trigger above,
   * and it was the one case that still hardcoded depth 10 and sent no
   * initiatedBy — so a user who retried a failed import got no failure email,
   * which is exactly the gap this PR set out to close.
   */
  it("carries the initiator and the default depth through the retry endpoint", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const env = makeEnv();

    await seedProject(env, { namespace: "@usera", slug: "retryep", projectId: "proj_re" });
    await seedImportJob({ namespace: "@usera", slug: "retryep", projectId: "proj_re" });
    const { updateImportStatus } = await import("../src/storage/imports");
    const { createLogger } = await import("../src/utils/logger");
    await updateImportStatus(
      {} as D1Database,
      "@usera",
      "retryep",
      "failed",
      createLogger({ component: "Test" }),
    );

    const { DEFAULT_CLONE_DEPTH } = await import("../src/utils/validation");
    const res = await app.fetch(
      request("POST", "/api/projects/@usera/retryep/import/retry", {}, USER_A_HEADERS),
      env,
    );
    expect(res.status).toBe(200);

    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ depth: DEFAULT_CLONE_DEPTH, initiatedBy: "user_A" }),
    );
  });

  /**
   * The issue's headline case (#279): a user imports with full history, hits a
   * transient failure, and retries. The retry used to rebuild the job from the
   * stored row and re-derive a hardcoded depth, so a deliberate "full" became a
   * depth-10 clone — silently, with no error and nothing saying the depth had
   * changed.
   *
   * 0 is the value most likely to be eaten on the way through, since every
   * consumer reads `depth ?? DEFAULT_CLONE_DEPTH`.
   */
  it("retries a full-history import at full history, not the default depth", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const env = makeEnv();

    await seedProject(env, { namespace: "@usera", slug: "fullhist", projectId: "proj_fh" });
    await seedImportJob({
      namespace: "@usera",
      slug: "fullhist",
      projectId: "proj_fh",
      depth: 0,
    });
    const { updateImportStatus } = await import("../src/storage/imports");
    const { createLogger } = await import("../src/utils/logger");
    await updateImportStatus(
      {} as D1Database,
      "@usera",
      "fullhist",
      "failed",
      createLogger({ component: "Test" }),
    );

    const { DEFAULT_CLONE_DEPTH } = await import("../src/utils/validation");
    const res = await app.fetch(
      request("POST", "/api/projects/@usera/fullhist/import/retry", {}, USER_A_HEADERS),
      env,
    );
    expect(res.status).toBe(200);

    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ depth: 0 }));
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ depth: DEFAULT_CLONE_DEPTH }));
  });

  it("retries a deep-but-shallow import at the depth it was created with", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const env = makeEnv();

    await seedProject(env, { namespace: "@usera", slug: "deepish", projectId: "proj_di" });
    await seedImportJob({
      namespace: "@usera",
      slug: "deepish",
      projectId: "proj_di",
      depth: 500,
    });
    const { updateImportStatus } = await import("../src/storage/imports");
    const { createLogger } = await import("../src/utils/logger");
    await updateImportStatus(
      {} as D1Database,
      "@usera",
      "deepish",
      "failed",
      createLogger({ component: "Test" }),
    );

    const res = await app.fetch(
      request("POST", "/api/projects/@usera/deepish/import/retry", {}, USER_A_HEADERS),
      env,
    );
    expect(res.status).toBe(200);

    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ depth: 500 }));
  });

  it("re-triggers via direct processing when no queue is configured", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });

    const env = makeEnv({ IMPORT_QUEUE: undefined });
    await seedProject(env, { namespace: "@usera", slug: "retrig2", projectId: "proj_r2" });
    await seedImportJob({ namespace: "@usera", slug: "retrig2", projectId: "proj_r2" });
    const { updateImportStatus } = await import("../src/storage/imports");
    const { createLogger } = await import("../src/utils/logger");
    await updateImportStatus(
      {} as D1Database,
      "@usera",
      "retrig2",
      "failed",
      createLogger({ component: "Test" }),
    );

    const background: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => background.push(p),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/@usera/retrig2/import",
        { url: "https://github.com/test/repo" },
        USER_A_HEADERS,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await Promise.all(background);

    // Direct path uses the default depth (no stored depth on the import job)
    expect(vi.mocked(importFromGitHub).mock.calls[0]?.[5]).toBe(10);
    expect(mockImportJobs.get("@usera:retrig2")?.status).toBe("completed");
  });

  /**
   * The queue-less twin of the retry case. This branch called processImportJob
   * without a depth argument at all, so it silently took the parameter's own
   * DEFAULT_CLONE_DEPTH — invisible to a grep for depth literals, and it meant
   * a full-history project was re-imported shallow whenever the queue was
   * absent.
   */
  it("re-triggers via direct processing at the recorded depth, not the default", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });

    const env = makeEnv({ IMPORT_QUEUE: undefined });
    await seedProject(env, { namespace: "@usera", slug: "retrig3", projectId: "proj_r3" });
    await seedImportJob({
      namespace: "@usera",
      slug: "retrig3",
      projectId: "proj_r3",
      depth: 0,
    });
    const { updateImportStatus } = await import("../src/storage/imports");
    const { createLogger } = await import("../src/utils/logger");
    await updateImportStatus(
      {} as D1Database,
      "@usera",
      "retrig3",
      "failed",
      createLogger({ component: "Test" }),
    );

    const background: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => background.push(p),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/@usera/retrig3/import",
        { url: "https://github.com/test/repo" },
        USER_A_HEADERS,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await Promise.all(background);

    expect(vi.mocked(importFromGitHub).mock.calls[0]?.[5]).toBe(0);
  });

  it("falls back to direct processing for a new import when no queue is configured", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    const { writeSnapshotFromRepo } = await import("../src/storage/repo-snapshot");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });
    vi.mocked(writeSnapshotFromRepo).mockResolvedValue({ fileCount: 5 });

    const env = makeEnv({ IMPORT_QUEUE: undefined });
    const background: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => background.push(p),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/@usera/direct/import",
        { url: "https://github.com/test/repo", branch: "main", depth: 7 },
        USER_A_HEADERS,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    await Promise.all(background);

    expect(vi.mocked(importFromGitHub).mock.calls[0]?.[5]).toBe(7);
    const job = mockImportJobs.get("@usera:direct");
    expect(job?.status).toBe("completed");
    expect(job?.progress.processedFiles).toBe(5);
    expect(job?.progress.totalFiles).toBe(5);
    expect(statusHistory.get("@usera:direct")).toContain("processing");

    await expectCountsBeforeCompletion(5);
  });

  it("does not report completion when the project write fails in direct processing", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    const { writeSnapshotFromRepo } = await import("../src/storage/repo-snapshot");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });
    vi.mocked(writeSnapshotFromRepo).mockResolvedValue({ fileCount: 5 });

    const env = makeEnv({ IMPORT_QUEUE: undefined });

    // Fail only the completion write. The route creates the project first with
    // `importCompleted: false`, so keying on the serialized `true` singles out
    // the one write under test and leaves creation intact.
    const originalPut = env.STATE.put.bind(env.STATE) as (k: string, v: string) => Promise<void>;
    (env.STATE as unknown as { put: (k: string, v: string) => Promise<void> }).put = async (
      key,
      value,
    ) => {
      if (typeof value === "string" && value.includes('"importCompleted":true')) {
        throw new Error("kv down");
      }
      return originalPut(key, value);
    };

    const background: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => background.push(p),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/@usera/direct-setfail/import",
        { url: "https://github.com/test/repo", branch: "main" },
        USER_A_HEADERS,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    await Promise.all(background);

    expect(mockImportJobs.get("@usera:direct-setfail")?.status).toBe("failed");
    expect(statusHistory.get("@usera:direct-setfail")).not.toContain("completed");
  });

  it("logs (and survives) an unexpected rejection from direct background processing", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    const { releaseImportLock } = await import("../src/middleware/rate-limit");
    vi.mocked(importFromGitHub).mockRejectedValue(new Error("boom"));
    // Make the failure-path lock release itself reject so the background
    // promise rejects and the route's defensive .catch handler runs.
    vi.mocked(releaseImportLock).mockRejectedValueOnce(new Error("lock release failed"));

    const env = makeEnv({ IMPORT_QUEUE: undefined });
    const background: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => background.push(p),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    const res = await app.fetch(
      request(
        "POST",
        "/api/projects/@usera/direct-fail/import",
        { url: "https://github.com/test/repo", branch: "main" },
        USER_A_HEADERS,
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    // Must resolve (not reject): the route's .catch swallows the rejection
    await Promise.all(background);

    expect(mockImportJobs.get("@usera:direct-fail")?.status).toBe("failed");
  });

  it("accepts form-encoded submissions with depth 'full'", async () => {
    stubFetch(async () => githubRepoMetadata("main"));
    const { default: app } = await import("../src/index");
    const env = makeEnv();

    const res = await app.fetch(
      new Request("http://localhost/api/projects/@usera/form-full/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...USER_A_HEADERS,
        },
        body: new URLSearchParams({
          url: "https://github.com/test/repo",
          branch: "main",
          depth: "full",
          visibility: "private",
        }).toString(),
        redirect: "manual",
      }),
      env,
    );
    expect([302, 303]).toContain(res.status);

    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ depth: 0 }));
  });
});

// ----------------------------------------------------------------------------
// Queue consumer: depth threading, progress, failure notification
// ----------------------------------------------------------------------------

describe("import queue consumer", () => {
  it("threads the message depth through to importFromGitHub (including 0 = full)", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });

    const env = makeEnv();
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage({ depth: 0 }));
    await handleImportQueue(createMockBatch([message]), env);

    expect(message.ack).toHaveBeenCalled();
    const call = vi.mocked(importFromGitHub).mock.calls[0];
    expect(call?.[4]).toBe("main"); // branch
    expect(call?.[5]).toBe(0); // depth: full history sentinel
  });

  it("sanitizes an out-of-range depth in the queue message back to the default", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });

    const env = makeEnv();
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage({ depth: 99999 }));
    await handleImportQueue(createMockBatch([message]), env);

    expect(vi.mocked(importFromGitHub).mock.calls[0]?.[5]).toBe(10);
  });

  it("reports phase transitions and the real file count in job progress", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    const { writeSnapshotFromRepo } = await import("../src/storage/repo-snapshot");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });
    vi.mocked(writeSnapshotFromRepo).mockResolvedValue({ fileCount: 42 });

    const env = makeEnv();
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage());
    await handleImportQueue(createMockBatch([message]), env);

    const job = mockImportJobs.get("@usera:repo");
    expect(job?.status).toBe("completed");
    expect(job?.progress.processedFiles).toBe(42);
    expect(job?.progress.totalFiles).toBe(42);

    // Phases in order: queued -> cloning -> processing -> completed
    const history = statusHistory.get("@usera:repo") ?? [];
    expect(history).toEqual(["queued", "cloning", "processing", "completed"]);

    await expectCountsBeforeCompletion(42);
  });

  /**
   * The snapshot walk clones the repository, so it is long enough for a user to
   * hit cancel inside it. Moving the walk ahead of the terminal status (so the
   * file count reaches the progress stream before it closes) put that slow step
   * between the cancellation check and the "completed" write — so a cancel
   * landing during finalization was silently overwritten.
   */
  it("honours a cancel that lands during snapshot finalization", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    const { writeSnapshotFromRepo } = await import("../src/storage/repo-snapshot");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });

    const env = makeEnv();
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    // Cancel *while* the walk is running, which is the window under test.
    vi.mocked(writeSnapshotFromRepo).mockImplementationOnce(async () => {
      const key = "@usera:repo";
      const job = mockImportJobs.get(key);
      if (job) mockImportJobs.set(key, { ...job, status: "cancelling" });
      return { fileCount: 7 };
    });

    const message = createMockMessage(importMessage());
    await handleImportQueue(createMockBatch([message]), env);

    // The cancel path removes the job row, so the status history is the record.
    const history = statusHistory.get("@usera:repo") ?? [];
    expect(history.at(-1)).toBe("cancelled");
    expect(history).not.toContain("completed");

    // The stored entry has to agree with that status. Persisting
    // `importCompleted: true` before the re-check would leave a project that
    // reads as imported behind an import the user cancelled.
    const stored = await env.STATE.get("project:@usera:repo");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string).importCompleted).not.toBe(true);
  });

  it("leaves progress at completion without counts when the snapshot walk fails", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    const { writeSnapshotFromRepo } = await import("../src/storage/repo-snapshot");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });
    vi.mocked(writeSnapshotFromRepo).mockResolvedValue(null);

    const env = makeEnv();
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage());
    await handleImportQueue(createMockBatch([message]), env);

    const job = mockImportJobs.get("@usera:repo");
    expect(job?.status).toBe("completed");
    expect(job?.progress.processedFiles).toBe(0);
    expect(job?.progress.totalFiles).toBeUndefined();
  });

  it("emails the triggering user AND the admin on import failure", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("Git clone failed", "GIT_ERROR", 500),
    });

    const emailSend = vi.fn(async () => ({ messageId: "m1" }));
    const env = makeEnv({
      EMAIL: { send: emailSend },
      ADMIN_EMAIL: "admin@example.com",
      EMAIL_FROM_ADDRESS: "alerts@stratum.dev",
    });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage({ initiatedBy: "user_A" }));
    await handleImportQueue(createMockBatch([message]), env);

    expect(mockImportJobs.get("@usera:repo")?.status).toBe("failed");
    expect(emailSend).toHaveBeenCalledTimes(2);
    const recipients = emailSend.mock.calls.map(
      (call) => (call as unknown as [{ to: string }])[0].to,
    );
    expect(recipients).toContain("userA@example.com");
    expect(recipients).toContain("admin@example.com");
  });

  it("emails the triggering user when the import is rejected for submodules (#258)", async () => {
    // The submodule rejection is a terminal import failure like any other, and
    // the person who started the import is the only one who can act on it —
    // dropping the initiator here would leave them staring at a stalled import
    // while only the instance admin learns why.
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub, freshRepoToken, cloneRepo, scanForSubmoduleContent } = await import(
      "../src/storage/git-ops"
    );
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: {
        name: "usera__repo",
        remote: "https://artifacts.example.com/repos/usera__repo",
        token: "tok_x",
      },
    });
    vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "scan-token" });
    vi.mocked(cloneRepo).mockResolvedValue({
      success: true,
      data: { fs: {} as never, dir: "/" },
    });
    vi.mocked(scanForSubmoduleContent).mockResolvedValue({
      success: true,
      data: { gitlinkPaths: ["vendor/lib"], hasGitmodules: false },
    });

    const emailSend = vi.fn(async () => ({ messageId: "m1" }));
    const env = makeEnv({
      EMAIL: { send: emailSend },
      ADMIN_EMAIL: "admin@example.com",
      EMAIL_FROM_ADDRESS: "alerts@stratum.dev",
    });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage({ initiatedBy: "user_A" }));
    await handleImportQueue(createMockBatch([message]), env);

    expect(mockImportJobs.get("@usera:repo")?.status).toBe("failed");
    const recipients = emailSend.mock.calls.map(
      (call) => (call as unknown as [{ to: string }])[0].to,
    );
    expect(recipients).toContain("userA@example.com");
    expect(recipients).toContain("admin@example.com");
  });

  it("still sends the admin copy when the message carries no initiator", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("Git clone failed", "GIT_ERROR", 500),
    });

    const emailSend = vi.fn(async () => ({ messageId: "m1" }));
    const env = makeEnv({
      EMAIL: { send: emailSend },
      ADMIN_EMAIL: "admin@example.com",
    });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage());
    await handleImportQueue(createMockBatch([message]), env);

    expect(emailSend).toHaveBeenCalledTimes(1);
    expect((emailSend.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe(
      "admin@example.com",
    );
  });

  it("falls back to the admin copy when the initiator cannot be resolved", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("Git clone failed", "GIT_ERROR", 500),
    });

    const emailSend = vi.fn(async () => ({ messageId: "m1" }));
    const env = makeEnv({
      EMAIL: { send: emailSend },
      ADMIN_EMAIL: "admin@example.com",
    });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage({ initiatedBy: "user_deleted" }));
    await handleImportQueue(createMockBatch([message]), env);

    expect(emailSend).toHaveBeenCalledTimes(1);
    expect((emailSend.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe(
      "admin@example.com",
    );
  });

  it("still notifies the admin when the initiator lookup throws", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    const { getUser } = await import("../src/storage/users");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("Git clone failed", "GIT_ERROR", 500),
    });
    vi.mocked(getUser).mockRejectedValueOnce(new Error("D1 unavailable"));

    const emailSend = vi.fn(async () => ({ messageId: "m1" }));
    const env = makeEnv({
      EMAIL: { send: emailSend },
      ADMIN_EMAIL: "admin@example.com",
    });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage({ initiatedBy: "user_A" }));
    await handleImportQueue(createMockBatch([message]), env);

    expect(message.ack).toHaveBeenCalled();
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect((emailSend.mock.calls[0] as unknown as [{ to: string }])[0].to).toBe(
      "admin@example.com",
    );
  });

  it("skips notification when no recipients are configured", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("Git clone failed", "GIT_ERROR", 500),
    });

    const emailSend = vi.fn(async () => ({ messageId: "m1" }));
    // EMAIL binding present, but no ADMIN_EMAIL / EMAIL_FROM_ADDRESS and no initiator
    const env = makeEnv({ EMAIL: { send: emailSend } });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage());
    await handleImportQueue(createMockBatch([message]), env);

    expect(emailSend).not.toHaveBeenCalled();
    expect(mockImportJobs.get("@usera:repo")?.status).toBe("failed");
  });

  it("keeps processing when one notification send fails", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("Git clone failed", "GIT_ERROR", 500),
    });

    const emailSend = vi.fn(async () => {
      throw new Error("SMTP down");
    });
    const env = makeEnv({
      EMAIL: { send: emailSend },
      ADMIN_EMAIL: "admin@example.com",
    });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage({ initiatedBy: "user_A" }));
    await handleImportQueue(createMockBatch([message]), env);

    // Both sends attempted despite the first throwing; job still marked failed and acked
    expect(emailSend).toHaveBeenCalledTimes(2);
    expect(mockImportJobs.get("@usera:repo")?.status).toBe("failed");
    expect(message.ack).toHaveBeenCalled();
  });

  it("notifies the initiator when the import throws unexpectedly", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockRejectedValue(new Error("isolate crashed"));

    const emailSend = vi.fn(async () => ({ messageId: "m1" }));
    const env = makeEnv({
      EMAIL: { send: emailSend },
      ADMIN_EMAIL: "admin@example.com",
    });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    const message = createMockMessage(importMessage({ initiatedBy: "user_A" }));
    await handleImportQueue(createMockBatch([message]), env);

    expect(message.ack).toHaveBeenCalled();
    expect(mockImportJobs.get("@usera:repo")?.status).toBe("failed");
    const recipients = emailSend.mock.calls.map(
      (call) => (call as unknown as [{ to: string }])[0].to,
    );
    expect(recipients).toContain("userA@example.com");
  });

  it("notifies the initiator when persisting the project fails after a clone", async () => {
    const { handleImportQueue } = await import("../src/queue/import-queue");
    const { importFromGitHub } = await import("../src/storage/git-ops");
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { name: "r", remote: "https://artifacts.example.com/repos/r", token: "t" },
    });

    const emailSend = vi.fn(async () => ({ messageId: "m1" }));
    const env = makeEnv({
      EMAIL: { send: emailSend },
      ADMIN_EMAIL: "admin@example.com",
    });
    await seedProject(env, { namespace: "@usera", slug: "repo", projectId: "proj_1" });
    await seedImportJob({ namespace: "@usera", slug: "repo", projectId: "proj_1" });

    // Break KV writes AFTER seeding so setProject fails
    (env.STATE as unknown as { put: () => Promise<never> }).put = async () => {
      throw new Error("kv down");
    };

    const message = createMockMessage(importMessage({ initiatedBy: "user_A" }));
    await handleImportQueue(createMockBatch([message]), env);

    expect(mockImportJobs.get("@usera:repo")?.status).toBe("failed");
    const recipients = emailSend.mock.calls.map(
      (call) => (call as unknown as [{ to: string }])[0].to,
    );
    expect(recipients).toContain("userA@example.com");
  });

  it("carries initiatedBy through queueImportJob into the message", async () => {
    const { queueImportJob } = await import("../src/queue/import-queue");
    const send = vi.fn();
    await queueImportJob({ send, sendBatch: vi.fn() } as unknown as Queue<ImportJobMessage>, {
      importId: "i1",
      projectId: "p1",
      namespace: "@usera",
      slug: "repo",
      githubUrl: "https://github.com/test/repo",
      branch: "main",
      depth: 0,
      initiatedBy: "user_A",
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 0, initiatedBy: "user_A", type: "github.import" }),
    );
  });
});

// ----------------------------------------------------------------------------
// importFromGitHub: depth omission for full history
// ----------------------------------------------------------------------------

describe("importFromGitHub depth handling (real implementation)", () => {
  it("omits depth from the Artifacts import call when depth is 0 (full history)", async () => {
    const gitOps =
      await vi.importActual<typeof import("../src/storage/git-ops")>("../src/storage/git-ops");
    const { createLogger } = await import("../src/utils/logger");
    const importSpy = vi.fn(async (_params: unknown) => ({
      name: "r",
      remote: "https://artifacts.example.com/repos/r",
      token: "t",
    }));
    const artifacts = { import: importSpy, delete: vi.fn() } as unknown as Env["ARTIFACTS"];

    const result = await gitOps.importFromGitHub(
      artifacts,
      "r",
      "https://github.com/test/repo",
      createLogger({ component: "Test" }),
      "main",
      0,
    );

    expect(result.success).toBe(true);
    const arg = importSpy.mock.calls[0]?.[0] as unknown as {
      source: Record<string, unknown>;
    };
    expect(arg.source).not.toHaveProperty("depth");
    expect(arg.source.branch).toBe("main");
  });

  it("passes a positive depth through to the Artifacts import call", async () => {
    const gitOps =
      await vi.importActual<typeof import("../src/storage/git-ops")>("../src/storage/git-ops");
    const { createLogger } = await import("../src/utils/logger");
    const importSpy = vi.fn(async (_params: unknown) => ({
      name: "r",
      remote: "https://artifacts.example.com/repos/r",
      token: "t",
    }));
    const artifacts = { import: importSpy, delete: vi.fn() } as unknown as Env["ARTIFACTS"];

    await gitOps.importFromGitHub(
      artifacts,
      "r",
      "https://github.com/test/repo",
      createLogger({ component: "Test" }),
      "main",
      25,
    );

    const arg = importSpy.mock.calls[0]?.[0] as unknown as {
      source: Record<string, unknown>;
    };
    expect(arg.source.depth).toBe(25);
  });
});

// ----------------------------------------------------------------------------
// writeSnapshotFromRepo: file-count signal (real implementation)
// ----------------------------------------------------------------------------

describe("writeSnapshotFromRepo file-count signal (real implementation)", () => {
  const project = {
    remote: "https://artifacts.example.com/repos/r",
    namespace: "@usera",
    slug: "repo",
  };

  async function realSnapshot() {
    return vi.importActual<typeof import("../src/storage/repo-snapshot")>(
      "../src/storage/repo-snapshot",
    );
  }

  it("returns null when the read token cannot be minted", async () => {
    const { freshRepoToken } = await import("../src/storage/git-ops");
    vi.mocked(freshRepoToken).mockResolvedValue({
      success: false,
      error: new AppError("token mint failed", "STORAGE_ERROR", 500),
    });
    const { writeSnapshotFromRepo } = await realSnapshot();
    const { createLogger } = await import("../src/utils/logger");
    const env = makeEnv();
    const result = await writeSnapshotFromRepo(
      env.STATE,
      env.ARTIFACTS,
      project,
      createLogger({ component: "Test" }),
    );
    expect(result).toBeNull();
  });

  it("returns null when the snapshot clone fails", async () => {
    const { cloneRepo, freshRepoToken } = await import("../src/storage/git-ops");
    vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "tok" });
    vi.mocked(cloneRepo).mockResolvedValue({
      success: false,
      error: new AppError("clone failed", "GIT_ERROR", 500),
    });
    const { writeSnapshotFromRepo } = await realSnapshot();
    const { createLogger } = await import("../src/utils/logger");
    const env = makeEnv();
    const result = await writeSnapshotFromRepo(
      env.STATE,
      env.ARTIFACTS,
      project,
      createLogger({ component: "Test" }),
    );
    expect(result).toBeNull();
  });

  it("returns the walked file count on success", async () => {
    const { cloneRepo, freshRepoToken } = await import("../src/storage/git-ops");
    vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "tok" });
    const fakeFs = {
      promises: {
        readdir: async (path: string) => (path === "/" ? ["a.txt", "b.txt"] : []),
        stat: async () => ({ isDirectory: () => false, isFile: () => true }),
        readFile: async () => {
          throw new Error("not readable");
        },
      },
    };
    vi.mocked(cloneRepo).mockResolvedValue({
      success: true,
      data: { fs: fakeFs, dir: "/" },
    } as never);
    const { writeSnapshotFromRepo } = await realSnapshot();
    const { createLogger } = await import("../src/utils/logger");
    const env = makeEnv();
    const result = await writeSnapshotFromRepo(
      env.STATE,
      env.ARTIFACTS,
      project,
      createLogger({ component: "Test" }),
    );
    expect(result).toEqual({ fileCount: 2 });
  });

  it("returns null on unexpected errors", async () => {
    const { cloneRepo, freshRepoToken } = await import("../src/storage/git-ops");
    vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "tok" });
    // success:true with null data makes the destructure throw -> outer catch
    vi.mocked(cloneRepo).mockResolvedValue({ success: true, data: null } as never);
    const { writeSnapshotFromRepo } = await realSnapshot();
    const { createLogger } = await import("../src/utils/logger");
    const env = makeEnv();
    const result = await writeSnapshotFromRepo(
      env.STATE,
      env.ARTIFACTS,
      project,
      createLogger({ component: "Test" }),
    );
    expect(result).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// Bulk import: default branch, depth, initiator
// ----------------------------------------------------------------------------

describe("bulk import repo processing", () => {
  it("resolves the provider default branch when the request omits branch", async () => {
    stubFetch(async () => githubRepoMetadata("develop"));
    const { processRepoImport } = await import("../src/routes/bulk-import");

    const env = makeEnv();
    const result = await processRepoImport(
      env,
      "job_1",
      { url: "https://github.com/test/repo" },
      "user_A",
      "usera",
      0,
      1,
    );

    expect(result.success).toBe(true);
    expect(mockImportJobs.get("@usera:repo")?.branch).toBe("develop");
    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "develop", depth: 10, initiatedBy: "user_A" }),
    );
  });

  it("keeps an explicit branch and depth", async () => {
    const fetchMock = stubFetch(async () => githubRepoMetadata("develop"));
    const { processRepoImport } = await import("../src/routes/bulk-import");

    const env = makeEnv();
    const result = await processRepoImport(
      env,
      "job_2",
      { url: "https://github.com/test/repo", branch: "release-2", depth: "full" },
      "user_A",
      "usera",
      0,
      1,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const send = vi.mocked(env.IMPORT_QUEUE?.send as unknown as ReturnType<typeof vi.fn>);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ branch: "release-2", depth: 0 }));
  });

  it("rejects an invalid depth before any storage I/O", async () => {
    const { processRepoImport } = await import("../src/routes/bulk-import");

    const env = makeEnv();
    const result = await processRepoImport(
      env,
      "job_3",
      { url: "https://github.com/test/repo", branch: "main", depth: 5000 },
      "user_A",
      "usera",
      0,
      1,
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/depth/);
    expect(env.ARTIFACTS.create).not.toHaveBeenCalled();
  });
});
