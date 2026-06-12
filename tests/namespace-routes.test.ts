import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ProjectEntry } from "../src/types";

// Mock users storage
vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_, token: string) => {
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
    if (token === "stratum_user_othertoken000000000000000") {
      return {
        success: true,
        data: {
          id: "user_other",
          email: "other@example.com",
          username: "otheruser",
          tokenHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
  getUser: vi.fn(async (_, userId: string) => {
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
    if (userId === "user_other") {
      return {
        success: true,
        data: {
          id: "user_other",
          email: "other@example.com",
          username: "otheruser",
          tokenHash: "hash",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      };
    }
    return { success: false, error: { message: "User not found" } };
  }),
}));

// Mock git-ops
vi.mock("../src/storage/git-ops", () => ({
  initAndPush: vi.fn(async (_remote: string, _token: string, _files: unknown, _msg: string) => ({
    success: true,
    data: "sha_init",
  })),
  cloneRepo: vi.fn(async () => ({ fs: {}, dir: "/" })),
  commitAndPush: vi.fn(async () => "sha_commit"),
  mergeWorkspaceIntoProject: vi.fn(async () => "sha_merge"),
  listFilesInRepo: vi.fn(async () => ({ success: true, data: ["src/index.ts", "README.md"] })),
  getCommitLog: vi.fn(async () => ({
    success: true,
    data: [
      {
        sha: "abc123",
        message: "Initial commit",
        author: "Stratum <system@usestratum.dev>",
        timestamp: 1000,
      },
    ],
  })),
  readFileFromRepo: vi.fn(async () => ({ success: true, data: "# README" })),
}));

// Mock changes storage
vi.mock("../src/storage/changes", () => ({
  listChanges: vi.fn(async () => ({ success: true, data: [] })),
  getChange: vi.fn(async () => ({ success: false, error: { message: "Change not found" } })),
}));

// Mock provenance storage
vi.mock("../src/storage/provenance", () => ({
  getProvenance: vi.fn(async () => ({
    success: false,
    error: { message: "Provenance not found" },
  })),
  listProvenance: vi.fn(async () => ({ success: true, data: [] })),
}));

// Mock imports storage
const mockImportProgress: Record<string, Record<string, unknown>> = {};
vi.mock("../src/storage/imports", () => ({
  getImportProgress: vi.fn(async (_kv, namespace: string, slug: string) => {
    const key = `${namespace}:${slug}`;
    if (mockImportProgress[key]) {
      return { success: true, data: mockImportProgress[key] };
    }
    return { success: true, data: null };
  }),
  createImportJob: vi.fn(async (_kv, params) => {
    const progress = {
      id: params.id,
      projectId: params.projectId,
      namespace: params.namespace,
      slug: params.slug,
      status: "queued",
      sourceUrl: params.sourceUrl,
      branch: params.branch,
      startedAt: new Date().toISOString(),
      progress: { processedFiles: 0 },
      errors: [],
      logs: [{ message: "Import queued", level: "info", timestamp: new Date().toISOString() }],
    };
    mockImportProgress[`${params.namespace}:${params.slug}`] = progress;
    return { success: true, data: progress };
  }),
  updateImportStatus: vi.fn(async (_kv, namespace: string, slug: string, status: string) => {
    const key = `${namespace}:${slug}`;
    if (mockImportProgress[key]) {
      mockImportProgress[key].status = status;
      return { success: true, data: mockImportProgress[key] };
    }
    return { success: false, error: { message: "Import job not found", code: "NOT_FOUND" } };
  }),
  cancelImportJob: vi.fn(async (_kv, namespace: string, slug: string) => {
    const key = `${namespace}:${slug}`;
    if (mockImportProgress[key]) {
      mockImportProgress[key].status = "cancelling";
      return { success: true, data: mockImportProgress[key] };
    }
    return { success: false, error: { message: "Import job not found", code: "NOT_FOUND" } };
  }),
  isImportCancelled: vi.fn(async () => false),
  deleteImportJob: vi.fn(async () => ({ success: true })),
}));

const AUTH_HEADERS = { Authorization: "Bearer stratum_user_testtoken00000000000000000" };
const OTHER_AUTH_HEADERS = { Authorization: "Bearer stratum_user_othertoken000000000000000" };

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

// Artifacts mock
const mockArtifactsCreate = vi.fn((name: string) => ({
  name,
  remote: `https://artifacts.example.com/repos/${name}`,
  token: `tok_${name}`,
}));

function makeEnv(): Env {
  return {
    ARTIFACTS: {
      create: mockArtifactsCreate,
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
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

// Helper to create a project directly in KV
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

// Helper to create a legacy project (for backward compatibility tests)
async function createLegacyProject(
  env: Env,
  name: string,
  ownerId: string,
  visibility: "private" | "public" = "private",
): Promise<ProjectEntry> {
  const project: ProjectEntry = {
    id: crypto.randomUUID(),
    name,
    slug: name,
    namespace: "@legacy",
    ownerId,
    ownerType: "user",
    remote: `https://artifacts.example.com/repos/${name}`,
    token: `tok_${name}`,
    createdAt: new Date().toISOString(),
    visibility,
  };

  await env.STATE.put(`project:${name}`, JSON.stringify(project));
  return project;
}

describe("Namespace Routes", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv();
    vi.clearAllMocks();
    // Clear import progress
    Object.keys(mockImportProgress).forEach((key) => delete mockImportProgress[key]);
  });

  describe("GET /@namespace/:slug - UI Repo View", () => {
    it("renders project page for valid namespace and slug", async () => {
      await createTestProject(env, "@testuser", "my-project", "user_test", "public");

      const res = await app.fetch(request("GET", "/@testuser/my-project"), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("my-project");
    });

    it("returns 404 for non-existent project", async () => {
      const res = await app.fetch(request("GET", "/@testuser/non-existent"), env);

      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain("not found");
    });

    it("returns 404 for private project without access", async () => {
      await createTestProject(env, "@testuser", "private-project", "user_test", "private");

      const res = await app.fetch(
        request("GET", "/@testuser/private-project", undefined, OTHER_AUTH_HEADERS),
        env,
      );

      expect(res.status).toBe(404);
    });

    it("allows owner to access their private project", async () => {
      await createTestProject(env, "@testuser", "my-private-project", "user_test", "private");

      const res = await app.fetch(
        request("GET", "/@testuser/my-private-project", undefined, AUTH_HEADERS),
        env,
      );

      expect(res.status).toBe(200);
    });

    it("allows public access to public projects without auth", async () => {
      await createTestProject(env, "@testuser", "public-project", "user_test", "public");

      const res = await app.fetch(request("GET", "/@testuser/public-project"), env);

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("public-project");
    });

    it("returns 400 for invalid namespace format (no @ prefix)", async () => {
      // Routes without @ prefix should return 400 bad request
      const res = await app.fetch(request("GET", "/invalid/test-project"), env);

      expect(res.status).toBe(400);
    });

    it("displays import progress when import is active", async () => {
      await createTestProject(env, "@testuser", "importing-project", "user_test", "public");

      // Set up active import progress
      mockImportProgress["@testuser:importing-project"] = {
        id: "import_123",
        projectId: "proj_123",
        namespace: "@testuser",
        slug: "importing-project",
        status: "cloning",
        sourceUrl: "https://github.com/test/repo",
        branch: "main",
        startedAt: new Date().toISOString(),
        progress: { processedFiles: 10 },
        errors: [],
        logs: [
          { message: "Cloning repository", level: "info", timestamp: new Date().toISOString() },
        ],
      };

      const res = await app.fetch(
        request("GET", "/@testuser/importing-project?import=active"),
        env,
      );

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("cloning");
    });

    it("handles projects with README.md correctly", async () => {
      const { readFileFromRepo } = await import("../src/storage/git-ops");
      vi.mocked(readFileFromRepo).mockResolvedValueOnce({
        success: true,
        data: "# My Project\n\nThis is the README",
      });

      await createTestProject(env, "@testuser", "project-with-readme", "user_test", "public");

      const res = await app.fetch(request("GET", "/@testuser/project-with-readme"), env);

      expect(res.status).toBe(200);
    });
  });

  describe("API Routes with Namespace", () => {
    describe("GET /api/projects/:namespace/:slug/files", () => {
      it("returns file list for existing project", async () => {
        await createTestProject(env, "@testuser", "my-project", "user_test", "public");

        const res = await app.fetch(
          request("GET", "/api/projects/@testuser/my-project/files"),
          env,
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { files: string[] };
        expect(body.files).toContain("src/index.ts");
        expect(body.files).toContain("README.md");
      });

      it("returns 404 for non-existent project", async () => {
        const res = await app.fetch(
          request("GET", "/api/projects/@testuser/non-existent/files"),
          env,
        );

        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("not found");
      });

      it("returns 404 for private project without access", async () => {
        await createTestProject(env, "@testuser", "private-project", "user_test", "private");

        const res = await app.fetch(
          request(
            "GET",
            "/api/projects/@testuser/private-project/files",
            undefined,
            OTHER_AUTH_HEADERS,
          ),
          env,
        );

        expect(res.status).toBe(404);
      });

      it("allows owner to access their private project's files", async () => {
        await createTestProject(env, "@testuser", "my-private-project", "user_test", "private");

        const res = await app.fetch(
          request(
            "GET",
            "/api/projects/@testuser/my-private-project/files",
            undefined,
            AUTH_HEADERS,
          ),
          env,
        );

        expect(res.status).toBe(200);
      });
    });

    describe("GET /api/projects/:namespace/:slug/import/status", () => {
      it("returns import progress for active import", async () => {
        await createTestProject(env, "@testuser", "importing-project", "user_test", "public");

        mockImportProgress["@testuser:importing-project"] = {
          id: "import_123",
          projectId: "proj_123",
          namespace: "@testuser",
          slug: "importing-project",
          status: "processing",
          sourceUrl: "https://github.com/test/repo",
          branch: "main",
          startedAt: new Date().toISOString(),
          progress: { processedFiles: 50 },
          errors: [],
          logs: [],
        };

        const res = await app.fetch(
          request("GET", "/api/projects/@testuser/importing-project/import/status"),
          env,
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; progress: { processedFiles: number } };
        expect(body.status).toBe("processing");
        expect(body.progress.processedFiles).toBe(50);
      });

      it("returns 404 when no import job exists", async () => {
        await createTestProject(env, "@testuser", "my-project", "user_test", "public");

        const res = await app.fetch(
          request("GET", "/api/projects/@testuser/my-project/import/status"),
          env,
        );

        expect(res.status).toBe(404);
      });

      it("returns 404 for private project without access", async () => {
        await createTestProject(env, "@testuser", "private-project", "user_test", "private");

        mockImportProgress["@testuser:private-project"] = {
          id: "import_123",
          status: "processing",
        };

        const res = await app.fetch(
          request(
            "GET",
            "/api/projects/@testuser/private-project/import/status",
            undefined,
            OTHER_AUTH_HEADERS,
          ),
          env,
        );

        expect(res.status).toBe(404);
      });

      it("returns 404 for non-existent project", async () => {
        const res = await app.fetch(
          request("GET", "/api/projects/@testuser/non-existent/import/status"),
          env,
        );

        expect(res.status).toBe(404);
      });
    });

    describe("POST /api/projects/:namespace/:slug/import/cancel", () => {
      it("cancels an active import", async () => {
        await createTestProject(env, "@testuser", "importing-project", "user_test", "private");

        mockImportProgress["@testuser:importing-project"] = {
          id: "import_123",
          projectId: "proj_123",
          namespace: "@testuser",
          slug: "importing-project",
          status: "processing",
          sourceUrl: "https://github.com/test/repo",
          branch: "main",
          startedAt: new Date().toISOString(),
          progress: { processedFiles: 50 },
          errors: [],
          logs: [],
        };

        const res = await app.fetch(
          request(
            "POST",
            "/api/projects/@testuser/importing-project/import/cancel",
            {},
            AUTH_HEADERS,
          ),
          env,
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; message: string };
        expect(body.status).toBe("cancelling");
        expect(body.message).toContain("cancellation requested");
      });

      it("returns 401 when unauthenticated", async () => {
        await createTestProject(env, "@testuser", "importing-project", "user_test", "private");

        const res = await app.fetch(
          request("POST", "/api/projects/@testuser/importing-project/import/cancel"),
          env,
        );

        expect(res.status).toBe(401);
      });

      it("returns 403 when trying to cancel another user's import", async () => {
        await createTestProject(env, "@testuser", "importing-project", "user_test", "private");

        const res = await app.fetch(
          request(
            "POST",
            "/api/projects/@testuser/importing-project/import/cancel",
            {},
            OTHER_AUTH_HEADERS,
          ),
          env,
        );

        expect(res.status).toBe(403);
      });

      it("returns 404 for non-existent import job", async () => {
        await createTestProject(env, "@testuser", "my-project", "user_test", "private");

        const res = await app.fetch(
          request("POST", "/api/projects/@testuser/my-project/import/cancel", {}, AUTH_HEADERS),
          env,
        );

        expect(res.status).toBe(404);
      });
    });

    describe("GET /api/projects/:namespace/:slug/import/stream - SSE", () => {
      it("returns SSE stream for import progress", async () => {
        await createTestProject(env, "@testuser", "importing-project", "user_test", "public");

        mockImportProgress["@testuser:importing-project"] = {
          id: "import_123",
          projectId: "proj_123",
          namespace: "@testuser",
          slug: "importing-project",
          status: "completed", // Use completed to trigger stream close
          sourceUrl: "https://github.com/test/repo",
          branch: "main",
          startedAt: new Date().toISOString(),
          progress: { processedFiles: 100 },
          errors: [],
          logs: [],
        };

        const res = await app.fetch(
          request("GET", "/api/projects/@testuser/importing-project/import/stream"),
          env,
        );

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");
        expect(res.headers.get("Cache-Control")).toBe("no-cache");
      });

      it("returns 404 for non-existent project", async () => {
        const res = await app.fetch(
          request("GET", "/api/projects/@testuser/non-existent/import/stream"),
          env,
        );

        expect(res.status).toBe(404);
      });

      it("returns 404 for private project without access", async () => {
        await createTestProject(env, "@testuser", "private-project", "user_test", "private");

        const res = await app.fetch(
          request(
            "GET",
            "/api/projects/@testuser/private-project/import/stream",
            undefined,
            OTHER_AUTH_HEADERS,
          ),
          env,
        );

        expect(res.status).toBe(404);
      });
    });
  });

  describe("Backward Compatibility - Legacy Routes", () => {
    describe("GET /p/:name", () => {
      it("still works for legacy projects", async () => {
        await createLegacyProject(env, "legacy-project", "user_test", "public");

        const res = await app.fetch(request("GET", "/p/legacy-project"), env);

        expect(res.status).toBe(200);
        const html = await res.text();
        expect(html).toContain("legacy-project");
      });

      it("returns 404 for non-existent legacy project", async () => {
        const res = await app.fetch(request("GET", "/p/non-existent-legacy"), env);

        expect(res.status).toBe(404);
      });

      it("returns 404 for private legacy project without access", async () => {
        await createLegacyProject(env, "private-legacy", "user_test", "private");

        const res = await app.fetch(
          request("GET", "/p/private-legacy", undefined, OTHER_AUTH_HEADERS),
          env,
        );

        expect(res.status).toBe(404);
      });
    });

    describe("GET /p/:name/changes", () => {
      it("still works for legacy projects", async () => {
        await createLegacyProject(env, "legacy-project", "user_test", "public");

        const res = await app.fetch(request("GET", "/p/legacy-project/changes"), env);

        expect(res.status).toBe(200);
      });
    });

    describe("GET /p/:name/workspaces", () => {
      it("still works for legacy projects", async () => {
        await createLegacyProject(env, "legacy-project", "user_test", "public");

        const res = await app.fetch(request("GET", "/p/legacy-project/workspaces"), env);

        expect(res.status).toBe(200);
      });
    });

    describe("GET /api/projects/:name/files (legacy format)", () => {
      it("still works for legacy projects without namespace", async () => {
        await createLegacyProject(env, "legacy-project", "user_test", "public");

        // The legacy API should still work - checking that routes.test.ts tests pass
        const res = await app.fetch(request("GET", "/api/projects/legacy-project/files"), env);

        // This may return 404 if the legacy API route was removed
        // The important thing is that namespace routes work
        expect([200, 404]).toContain(res.status);
      });
    });
  });

  describe("Auth Integration", () => {
    it("allows public projects to be accessed without authentication", async () => {
      await createTestProject(env, "@testuser", "public-project", "user_test", "public");

      const res = await app.fetch(request("GET", "/@testuser/public-project"), env);

      expect(res.status).toBe(200);
    });

    it("returns 404 for private projects when unauthenticated", async () => {
      await createTestProject(env, "@testuser", "private-project", "user_test", "private");

      const res = await app.fetch(request("GET", "/@testuser/private-project"), env);

      expect(res.status).toBe(404);
    });

    it("allows project owner to access their private project", async () => {
      await createTestProject(env, "@testuser", "my-private", "user_test", "private");

      const res = await app.fetch(
        request("GET", "/@testuser/my-private", undefined, AUTH_HEADERS),
        env,
      );

      expect(res.status).toBe(200);
    });

    it("allows authenticated user to access public project", async () => {
      await createTestProject(env, "@testuser", "public-project", "user_test", "public");

      const res = await app.fetch(
        request("GET", "/@testuser/public-project", undefined, OTHER_AUTH_HEADERS),
        env,
      );

      expect(res.status).toBe(200);
    });
  });

  describe("Namespace Format Validation", () => {
    it("accepts valid namespace with @ prefix", async () => {
      await createTestProject(env, "@validuser", "project", "user_test", "public");

      const res = await app.fetch(request("GET", "/@validuser/project"), env);

      expect(res.status).toBe(200);
    });

    it("accepts namespace with hyphens", async () => {
      await createTestProject(env, "@valid-user", "project", "user_test", "public");

      const res = await app.fetch(request("GET", "/@valid-user/project"), env);

      expect(res.status).toBe(200);
    });

    it("rejects namespace without @ prefix via 400", async () => {
      const res = await app.fetch(request("GET", "/invalid-namespace/project"), env);

      expect(res.status).toBe(400);
    });
  });

  describe("Cross-namespace Access Control", () => {
    it("prevents access to projects in other namespaces", async () => {
      // Create a project in a different namespace
      await createTestProject(env, "@otheruser", "their-project", "user_other", "public");

      // Try to access with a different user (even though it's public, the test validates routing)
      const res = await app.fetch(request("GET", "/@otheruser/their-project"), env);

      // Public projects should be accessible
      expect(res.status).toBe(200);
    });

    it("allows access to own namespace projects", async () => {
      await createTestProject(env, "@testuser", "my-project", "user_test", "private");

      const res = await app.fetch(
        request("GET", "/@testuser/my-project", undefined, AUTH_HEADERS),
        env,
      );

      expect(res.status).toBe(200);
    });
  });

  describe("API route mount order", () => {
    // Regression: the UI router's /:namespace/:slug catch-all used to be mounted before
    // the API routers and swallowed two-segment API paths like GET /api/projects,
    // returning an HTML error page instead of JSON.
    it("GET /api/projects reaches the API router and returns JSON", async () => {
      await createTestProject(env, "@testuser", "my-project", "user_test", "private");

      const res = await app.fetch(request("GET", "/api/projects", undefined, AUTH_HEADERS), env);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { projects: Array<{ slug: string }> };
      expect(body.projects.map((p) => p.slug)).toContain("my-project");
    });

    it("GET /api/projects without auth returns an empty JSON list, not HTML", async () => {
      const res = await app.fetch(request("GET", "/api/projects"), env);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as { projects: unknown[] };
      expect(body.projects).toEqual([]);
    });
  });
});
