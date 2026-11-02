import { renderToString } from "hono/jsx/dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
  freshRepoToken,
  listFilesInRepo,
  listRepoBranches,
  resolveBranchRef,
} from "../src/storage/git-ops";
import { readRepoSnapshot } from "../src/storage/repo-snapshot";
import type { Env, ProjectEntry } from "../src/types";
import { FileTree } from "../src/ui/components/file-tree";
import { getFileContent } from "../src/ui/file-content";
import { buildFileTree } from "../src/ui/file-tree";
import { BranchSwitcher, BranchesPage } from "../src/ui/pages/branches";
import { AppError } from "../src/utils/errors";
import { err } from "../src/utils/result";

// Ref-scoped browsing (#181, task 6): the branches page, the no-JS switcher, and
// `?ref=` on the repo and blob views. The git leg is mocked at the git-ops
// boundary — it has its own suite (tests/git-branches.test.ts).

const DEFAULT_TIP = "a".repeat(40);
const FEATURE_TIP = "b".repeat(40);

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "mock-token" })),
    listRepoBranches: vi.fn(async () => ({
      success: true,
      data: {
        branches: [
          { name: "main", oid: "a".repeat(40) },
          { name: "release/2.x", oid: "b".repeat(40) },
        ],
        truncated: false,
        totalBranchCount: 2,
      },
    })),
    resolveBranchRef: vi.fn(
      async (_remote: string, _token: string, _logger: unknown, name: string) => ({
        success: true,
        data: { name, oid: "b".repeat(40) },
      }),
    ),
    listFilesInRepo: vi.fn(async () => ({ success: true, data: ["src/index.ts"] })),
    getCommitLog: vi.fn(async () => ({ success: true, data: [] })),
    readFileFromRepo: vi.fn(async () => ({ success: false, error: new Error("no readme") })),
  };
});

vi.mock("../src/storage/repo-snapshot", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/repo-snapshot")>();
  return {
    ...actual,
    readRepoSnapshot: vi.fn(async () => ({
      success: true,
      data: {
        v: 1 as const,
        files: ["SNAPSHOT_ONLY.md"],
        commits: [],
        readme: null,
        readmeTruncated: false,
        snapshotAt: "2026-01-01T00:00:00.000Z",
      },
    })),
  };
});

vi.mock("../src/ui/file-content", async (importActual) => {
  const actual = await importActual<typeof import("../src/ui/file-content")>();
  return {
    ...actual,
    getFileContent: vi.fn(async () => ({
      success: true,
      data: { kind: "content" as const, value: "console.log(1);\n" },
    })),
  };
});

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
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

async function seedProject(env: Env, overrides: Partial<ProjectEntry> = {}): Promise<ProjectEntry> {
  const project: ProjectEntry = {
    id: "proj_1",
    name: "repo",
    slug: "repo",
    namespace: "@owner",
    ownerId: "user_test",
    ownerType: "user",
    remote: "https://acct.artifacts.cloudflare.net/git/@owner/repo.git",
    createdAt: new Date().toISOString(),
    visibility: "public",
    ...overrides,
  };
  await env.STATE.put(`project:${project.namespace}:${project.slug}`, JSON.stringify(project));
  return project;
}

function req(path: string): Request {
  return new Request(`http://localhost${path}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BranchesPage", () => {
  const project = { name: "repo", namespace: "@owner", slug: "repo" };

  it("renders every branch with its short tip sha, a browse link, and the default marked", () => {
    const html = renderToString(
      <BranchesPage
        project={project}
        branches={[
          { name: "main", oid: DEFAULT_TIP },
          { name: "release/2.x", oid: FEATURE_TIP },
        ]}
        defaultBranch="main"
        truncated={false}
        totalBranchCount={2}
      />,
    );

    expect(html).toContain("main");
    expect(html).toContain("release/2.x");
    expect(html).toContain(DEFAULT_TIP.slice(0, 7));
    expect(html).toContain(FEATURE_TIP.slice(0, 7));
    expect(html).toContain("default");
    // The default branch keeps its bare URL; every other branch carries the ref.
    expect(html).toContain('href="/@owner/repo"');
    expect(html).toContain('href="/@owner/repo?ref=release%2F2.x"');
  });

  it("says so in place when the listing was truncated, never passing it off as complete", () => {
    const html = renderToString(
      <BranchesPage
        project={project}
        branches={[{ name: "main", oid: DEFAULT_TIP }]}
        defaultBranch="main"
        truncated={true}
        totalBranchCount={640}
      />,
    );

    expect(html).toContain("640");
    expect(html.toLowerCase()).toContain("not listed");
  });

  it("renders an empty state for a repo that advertises no branches", () => {
    const html = renderToString(
      <BranchesPage
        project={project}
        branches={[]}
        defaultBranch="main"
        truncated={false}
        totalBranchCount={0}
      />,
    );

    expect(html).toContain("No branches yet");
  });
});

describe("BranchSwitcher", () => {
  it("is a GET form over a select, with the current ref selected and no script", () => {
    const html = renderToString(
      <BranchSwitcher
        action="/@owner/repo"
        branchNames={["main", "release/2.x"]}
        currentRef="release/2.x"
      />,
    );

    expect(html).toContain('method="get"');
    expect(html).toContain('action="/@owner/repo"');
    expect(html).toContain('name="ref"');
    expect(html).toContain('<option value="release/2.x" selected');
    expect(html).not.toContain('<option value="main" selected');
    // No client-side JavaScript in this UI (AGENTS.md) — the browser's own GET
    // form serialisation is the whole mechanism.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onchange");
  });

  it("renders nothing at all when no branches are known", () => {
    const html = renderToString(
      <BranchSwitcher action="/@owner/repo" branchNames={[]} currentRef="main" />,
    );

    expect(html).not.toContain("<select");
  });

  it("keeps the branch on screen selectable when a truncated listing omitted it", () => {
    const html = renderToString(
      <BranchSwitcher action="/@owner/repo" branchNames={["main"]} currentRef="zz-experiment" />,
    );

    expect(html).toContain('<option value="zz-experiment" selected');
  });
});

describe("FileTree ref threading", () => {
  const nodes = buildFileTree(["src/index.ts"]);

  it("carries the ref on every blob link when browsing a non-default branch", () => {
    const html = renderToString(
      <FileTree
        nodes={nodes}
        namespace="@owner"
        slug="repo"
        nonce="test-nonce"
        refName="release/2.x"
      />,
    );

    expect(html).toContain('href="/@owner/repo/blob/src/index.ts?ref=release%2F2.x"');
  });

  it("omits the parameter on the default branch so existing URLs are unchanged", () => {
    const html = renderToString(
      <FileTree nodes={nodes} namespace="@owner" slug="repo" nonce="test-nonce" />,
    );

    expect(html).toContain('href="/@owner/repo/blob/src/index.ts"');
    expect(html).not.toContain("?ref=");
  });
});

describe("UI GET /:namespace/:slug/branches", () => {
  it("renders the branch table with tips and the default marked", async () => {
    const env = makeEnv();
    await seedProject(env);

    const res = await app.fetch(req("/@owner/repo/branches"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Branches");
    expect(html).toContain("release/2.x");
    expect(html).toContain(DEFAULT_TIP.slice(0, 7));
    expect(html).toContain("default");
  });

  it("lists against the project's own default branch, not a hardcoded 'main'", async () => {
    const env = makeEnv();
    await seedProject(env, { sourceDefaultBranch: "trunk" });

    await app.fetch(req("/@owner/repo/branches"), env);

    expect(vi.mocked(listRepoBranches)).toHaveBeenCalledWith(
      expect.any(String),
      "mock-token",
      expect.anything(),
      "trunk",
    );
  });

  it("404s a missing project and a private one seen anonymously", async () => {
    const env = makeEnv();
    const missing = await app.fetch(req("/@owner/nope/branches"), env);
    expect(missing.status).toBe(404);

    await seedProject(env, { visibility: "private" });
    const hidden = await app.fetch(req("/@owner/repo/branches"), env);
    expect(hidden.status).toBe(404);
  });

  it("400s an invalid project path", async () => {
    const env = makeEnv();
    const res = await app.fetch(req("/@bad__ns!/repo/branches"), env);
    expect(res.status).toBe(400);
  });

  it("500s when the advertisement fails", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(listRepoBranches).mockResolvedValueOnce(
      err(new AppError("Failed to read remote refs", "EXTERNAL_SERVICE_ERROR", 502)),
    );

    const res = await app.fetch(req("/@owner/repo/branches"), env);

    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Error loading branches");
  });
});

describe("UI GET /:namespace/:slug — ?ref=", () => {
  it("serves the KV snapshot on the default branch, as before", async () => {
    const env = makeEnv();
    await seedProject(env);

    const res = await app.fetch(req("/@owner/repo"), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SNAPSHOT_ONLY.md");
    expect(vi.mocked(listFilesInRepo)).not.toHaveBeenCalled();
  });

  it("does no git work at all when the snapshot serves the default branch", async () => {
    const env = makeEnv();
    await seedProject(env);

    const res = await app.fetch(req("/@owner/repo"), env);
    expect(res.status).toBe(200);

    // This is the busiest page in the product and, on a snapshot hit, it made
    // zero git calls before multi-branch support. Minting a read token or
    // advertising refs for the switcher would add a fixed round trip to every
    // view for a control most readers never touch.
    expect(vi.mocked(freshRepoToken)).not.toHaveBeenCalled();
    expect(vi.mocked(listRepoBranches)).not.toHaveBeenCalled();
  });

  it("treats an empty ?ref= as unspecified rather than an invalid name", async () => {
    const env = makeEnv();
    await seedProject(env);

    // A GET form submitted with nothing chosen sends exactly this. Answering a
    // browser's own default submission with a 400 would be a worse contract
    // than reading it as "no preference" — which is what the API route does.
    const res = await app.fetch(req("/@owner/repo?ref="), env);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("SNAPSHOT_ONLY.md");
    expect(vi.mocked(resolveBranchRef)).not.toHaveBeenCalled();
  });

  it("bypasses the snapshot for a non-default ref and clones that branch instead", async () => {
    const env = makeEnv();
    await seedProject(env);

    const res = await app.fetch(req("/@owner/repo?ref=release/2.x"), env);

    expect(res.status).toBe(200);
    const html = await res.text();
    // The snapshot is keyed by project alone and only describes the default
    // branch, so it must not be read at all for another ref.
    expect(vi.mocked(readRepoSnapshot)).not.toHaveBeenCalled();
    expect(html).not.toContain("SNAPSHOT_ONLY.md");
    expect(vi.mocked(listFilesInRepo)).toHaveBeenCalledWith(
      expect.any(String),
      "mock-token",
      expect.anything(),
      "release/2.x",
    );
    // File links stay on the branch the reader chose.
    expect(html).toContain('href="/@owner/repo/blob/src/index.ts?ref=release%2F2.x"');
  });

  it("round-trips the percent-encoded ref its own links generate", async () => {
    const env = makeEnv();
    await seedProject(env);

    // The branches page and file tree emit `?ref=release%2F2.x`; hierarchical
    // branch names only work if that arrives back as a real slash.
    const res = await app.fetch(req("/@owner/repo?ref=release%2F2.x"), env);

    expect(res.status).toBe(200);
    expect(vi.mocked(resolveBranchRef)).toHaveBeenCalledWith(
      expect.any(String),
      "mock-token",
      expect.anything(),
      "release/2.x",
    );
  });

  it("renders the switcher with the requested ref selected", async () => {
    const env = makeEnv();
    await seedProject(env);

    const res = await app.fetch(req("/@owner/repo?ref=release/2.x"), env);

    const html = await res.text();
    expect(html).toContain('name="ref"');
    expect(html).toContain('<option value="release/2.x" selected');
  });

  it("404s an unknown ref, naming it, rather than falling back to the default", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(resolveBranchRef).mockResolvedValueOnce(err({ kind: "not-found", name: "nope" }));

    const res = await app.fetch(req("/@owner/repo?ref=nope"), env);

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("nope");
    expect(vi.mocked(listFilesInRepo)).not.toHaveBeenCalled();
  });

  it("409s a ref that names both a branch and a tag, naming both namespaces", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(resolveBranchRef).mockResolvedValueOnce(err({ kind: "ambiguous", name: "v1" }));

    const res = await app.fetch(req("/@owner/repo?ref=v1"), env);

    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("refs/heads/v1");
    expect(html).toContain("refs/tags/v1");
  });

  it("400s an invalid ref name", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(resolveBranchRef).mockResolvedValueOnce(err({ kind: "invalid", name: "../etc" }));

    const res = await app.fetch(req("/@owner/repo?ref=../etc"), env);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Invalid branch name");
  });
});

describe("UI GET /:namespace/:slug/blob/* — ?ref=", () => {
  it("reads the file from the requested branch and keeps its links on it", async () => {
    const env = makeEnv();
    await seedProject(env);

    const res = await app.fetch(req("/@owner/repo/blob/src/index.ts?ref=release/2.x"), env);

    expect(res.status).toBe(200);
    expect(vi.mocked(getFileContent)).toHaveBeenCalledWith(
      expect.any(String),
      "mock-token",
      "src/index.ts",
      expect.anything(),
      "release/2.x",
    );
    const html = await res.text();
    // The query string never leaks into the wildcard file path.
    expect(html).toContain('href="/@owner/repo?ref=release%2F2.x"');
    expect(html).toContain('<option value="release/2.x" selected');
  });

  it("reads the default branch when no ref is given", async () => {
    const env = makeEnv();
    await seedProject(env, { sourceDefaultBranch: "trunk" });

    const res = await app.fetch(req("/@owner/repo/blob/src/index.ts"), env);

    expect(res.status).toBe(200);
    expect(vi.mocked(getFileContent)).toHaveBeenCalledWith(
      expect.any(String),
      "mock-token",
      "src/index.ts",
      expect.anything(),
      "trunk",
    );
    expect(vi.mocked(resolveBranchRef)).not.toHaveBeenCalled();
  });

  it("404s an unknown ref before reading any file", async () => {
    const env = makeEnv();
    await seedProject(env);
    vi.mocked(resolveBranchRef).mockResolvedValueOnce(err({ kind: "not-found", name: "nope" }));

    const res = await app.fetch(req("/@owner/repo/blob/src/index.ts?ref=nope"), env);

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("nope");
    expect(vi.mocked(getFileContent)).not.toHaveBeenCalled();
  });
});

describe("RepoPage branches link", () => {
  it("offers the branches page beside Tags", async () => {
    const env = makeEnv();
    await seedProject(env);

    const res = await app.fetch(req("/@owner/repo"), env);

    const html = await res.text();
    expect(html).toContain('href="/@owner/repo/branches"');
    expect(html).toContain('href="/@owner/repo/tags"');
  });
});
