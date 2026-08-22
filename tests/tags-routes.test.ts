import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { freshRepoToken, listRepoTags } from "../src/storage/git-ops";
import type { Env, ProjectEntry } from "../src/types";
import { AppError } from "../src/utils/errors";
import { err } from "../src/utils/result";

// Tags listing surfaces (#182): REST GET /api/projects/:ns/:slug/tags and the
// UI page GET /:ns/:slug/tags. The git leg (clone + tag fetch) is mocked at the
// git-ops boundary — it has its own suite (tests/git-tags-ops.test.ts).

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "mock-token" })),
    listRepoTags: vi.fn(async () => ({
      success: true,
      data: [
        {
          name: "v1.0.0",
          oid: "c".repeat(40),
          targetSha: "b".repeat(40),
          annotated: true,
          message: "First stable release",
          tagger: "tagger <tag@x.com>",
          timestamp: 1_700_000_100,
          unresolvable: false,
        },
        {
          name: "v0.9.0",
          oid: "b".repeat(40),
          targetSha: "b".repeat(40),
          annotated: false,
          unresolvable: false,
        },
        {
          name: "ancient",
          oid: "d".repeat(40),
          targetSha: null,
          annotated: false,
          unresolvable: true,
        },
        {
          // Annotated tag whose TARGET is outside the shallow window: the
          // intended target sha is known, but the commit itself is missing.
          name: "deep",
          oid: "e".repeat(40),
          targetSha: "a".repeat(40),
          annotated: true,
          message: "too deep",
          unresolvable: true,
        },
      ],
    })),
  };
});

const USER_TOKEN = "stratum_user_testtoken00000000000000000";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === USER_TOKEN)
      return {
        success: true,
        data: { id: "user_test", email: "t@x.io", username: "testuser" },
      };
    return { success: false, error: { message: "not found" } };
  }),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

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

async function seedProject(
  env: Env,
  visibility: "public" | "private" = "public",
): Promise<ProjectEntry> {
  const project: ProjectEntry = {
    id: "proj_1",
    name: "repo",
    slug: "repo",
    namespace: "@owner",
    ownerId: "user_test",
    ownerType: "user",
    remote: "https://acct.artifacts.cloudflare.net/git/@owner/repo.git",
    createdAt: new Date().toISOString(),
    visibility,
  };
  await env.STATE.put(`project:${project.namespace}:${project.slug}`, JSON.stringify(project));
  return project;
}

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("REST GET /api/projects/:namespace/:slug/tags", () => {
  it("lists tags for a public project (annotated, lightweight, unresolvable)", async () => {
    const env = makeEnv();
    await seedProject(env);
    const res = await app.fetch(req("/api/projects/@owner/repo/tags"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      namespace: string;
      slug: string;
      tags: Array<Record<string, unknown>>;
    };
    expect(body.namespace).toBe("@owner");
    expect(body.slug).toBe("repo");
    expect(body.tags).toHaveLength(4);

    const annotated = body.tags.find((t) => t.name === "v1.0.0");
    expect(annotated?.annotated).toBe(true);
    expect(annotated?.targetSha).toBe("b".repeat(40));
    expect(annotated?.message).toBe("First stable release");

    const lightweight = body.tags.find((t) => t.name === "v0.9.0");
    expect(lightweight?.annotated).toBe(false);

    // The shallow-degraded tag is delivered, flagged — never an error.
    const unresolvable = body.tags.find((t) => t.name === "ancient");
    expect(unresolvable?.unresolvable).toBe(true);
    expect(unresolvable?.targetSha).toBeNull();
  });

  it("authorizes like the other repo reads: private project hides from anonymous", async () => {
    const env = makeEnv();
    await seedProject(env, "private");
    const res = await app.fetch(req("/api/projects/@owner/repo/tags"), env);
    expect(res.status).toBe(404);
    expect(vi.mocked(listRepoTags)).not.toHaveBeenCalled();
  });

  it("serves the owner of a private project", async () => {
    const env = makeEnv();
    await seedProject(env, "private");
    const res = await app.fetch(
      req("/api/projects/@owner/repo/tags", { Authorization: `Bearer ${USER_TOKEN}` }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("404s a missing project", async () => {
    const env = makeEnv();
    const res = await app.fetch(req("/api/projects/@owner/nope/tags"), env);
    expect(res.status).toBe(404);
  });

  it("maps a git failure to 500", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(listRepoTags).mockResolvedValueOnce(
      err(new AppError("Failed to list tags", "GIT_ERROR", 500)),
    );
    const res = await app.fetch(req("/api/projects/@owner/repo/tags"), env);
    expect(res.status).toBe(500);
  });

  it("maps a corrupt project entry (non-NOT_FOUND lookup error) to 500, not 404", async () => {
    const env = makeEnv();
    await env.STATE.put("project:@owner:repo", "{corrupt json");
    const res = await app.fetch(req("/api/projects/@owner/repo/tags"), env);
    expect(res.status).toBe(500);
  });
});

describe("UI GET /:namespace/:slug/tags", () => {
  it("renders the tags table with names, badges, target shas, messages, and taggers", async () => {
    const env = makeEnv();
    await seedProject(env);
    const res = await app.fetch(req("/@owner/repo/tags"), env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Tags");
    expect(html).toContain("v1.0.0");
    expect(html).toContain("annotated");
    expect(html).toContain("First stable release");
    expect(html).toContain("b".repeat(40).slice(0, 7)); // short target sha
    expect(html).toContain("v0.9.0");
    expect(html).toContain("lightweight");
    // The shallow-degraded tags render, marked — the page does not error.
    expect(html).toContain("ancient");
    expect(html).toContain("unresolvable");
    expect(html).toContain("deep");
    // The collector preserves the annotated tagger, so the page must show it.
    expect(html).toContain("Tagger");
    expect(html).toContain("tag@x.com");
  });

  it("renders an empty state when the repo has no tags", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(listRepoTags).mockResolvedValueOnce({ success: true, data: [] });
    const res = await app.fetch(req("/@owner/repo/tags"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No tags yet");
  });

  it("404s a missing or unreadable project", async () => {
    const env = makeEnv();
    const missing = await app.fetch(req("/@owner/nope/tags"), env);
    expect(missing.status).toBe(404);

    await seedProject(env, "private");
    const hidden = await app.fetch(req("/@owner/repo/tags"), env);
    expect(hidden.status).toBe(404);
  });

  it("400s an invalid project path", async () => {
    const env = makeEnv();
    const res = await app.fetch(req("/@bad__ns!/repo/tags"), env);
    expect(res.status).toBe(400);
  });

  it("500s when the read token cannot be minted", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(freshRepoToken).mockResolvedValueOnce(
      err(new AppError("token mint failed", "EXTERNAL_SERVICE_ERROR", 502)),
    );
    const res = await app.fetch(req("/@owner/repo/tags"), env);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Error loading tags");
  });

  it("500s when the tag listing fails", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(listRepoTags).mockResolvedValueOnce(
      err(new AppError("Failed to list tags", "GIT_ERROR", 500)),
    );
    const res = await app.fetch(req("/@owner/repo/tags"), env);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Error loading tags");
  });
});

describe("formatTagDate", () => {
  it("formats an epoch-seconds timestamp and degrades on bad input", async () => {
    const { formatTagDate } = await import("../src/ui/pages/tags");
    expect(formatTagDate(1_700_000_100)).toContain("2023");
    expect(formatTagDate(undefined)).toBe("");
    expect(formatTagDate(Number.NaN)).toBe("");
  });
});
