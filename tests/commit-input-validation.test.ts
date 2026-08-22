/**
 * S7 (#130): input validation on the workspace commit/delete surface —
 * projectId must be a UUID, workspace names must be slugs (both are
 * interpolated into KV keys), and commit file maps must be repo-relative and
 * size-capped (guards mirrored from resolveConflict into commitAndPush so
 * every caller gets them).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { type NodeFS, commitAndPush } from "../src/storage/git-ops";
import type { Env, ProjectEntry } from "../src/types";
import { createLogger } from "../src/utils/logger";

// Keep commitAndPush REAL (its own guards are under test); stub the pieces
// that would touch the network. All route-level rejections below must happen
// BEFORE any git work, proven via cloneRepo never being called.
vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "secret?expires=9999999999" })),
    cloneRepo: vi.fn(async () => ({ success: true, data: { fs: {}, dir: "/tmp/x" } })),
    stageWorkspaceTree: vi.fn(async () => ({ success: false, error: { message: "skip" } })),
  };
});

const OWNER_TOKEN = "stratum_user_owner000000000000000000";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === OWNER_TOKEN)
      return { success: true, data: { id: "user_owner", email: "o@x.io", username: "owner" } };
    return { success: false, error: { message: "not found" } };
  }),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

import { cloneRepo } from "../src/storage/git-ops";

const PROJECT_ID = "0f1e2d3c-4b5a-4978-8765-43210fedcba9";
const ARTIFACTS_REMOTE = "https://acct.artifacts.cloudflare.net/git/@owner/repo.git";
const WS_REMOTE = "https://acct.artifacts.cloudflare.net/git/@owner/myws.git";

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
        .filter((k) => (prefix ? k.startsWith(prefix) : true))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

async function makeSeededEnv(): Promise<Env> {
  const env = {
    ARTIFACTS: { delete: vi.fn(async () => true) } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
  } as Env;
  const project: ProjectEntry = {
    id: PROJECT_ID,
    name: "repo",
    slug: "repo",
    namespace: "@owner",
    ownerId: "user_owner",
    ownerType: "user",
    remote: ARTIFACTS_REMOTE,
    createdAt: new Date().toISOString(),
    visibility: "private",
  };
  await env.STATE.put(`project:${project.namespace}:${project.slug}`, JSON.stringify(project));
  await env.STATE.put(
    `workspace:${PROJECT_ID}:myws`,
    JSON.stringify({
      name: "myws",
      remote: WS_REMOTE,
      parent: PROJECT_ID,
      createdAt: new Date().toISOString(),
      createdByUserId: "user_owner",
    }),
  );
  return env;
}

function commitReq(
  overrides: { name?: string; projectId?: unknown; files?: Record<string, string> } = {},
): Request {
  return new Request(`http://localhost/api/workspaces/${overrides.name ?? "myws"}/commit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: "projectId" in overrides ? overrides.projectId : PROJECT_ID,
      message: "m",
      files: overrides.files ?? { "a.txt": "hi" },
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("S7 — commit route identifier validation", () => {
  it.each([
    ["legacy-style id", "proj_1"],
    ["kv separator injection", "a:b"],
    ["uuid with extra", `${PROJECT_ID}:extra`],
    ["number", 42],
    ["null", null],
  ])("rejects a non-UUID projectId (%s) with 400 before any git work", async (_label, pid) => {
    const env = await makeSeededEnv();
    const res = await app.fetch(commitReq({ projectId: pid }), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("UUID");
    expect(vi.mocked(cloneRepo)).not.toHaveBeenCalled();
  });

  it("rejects a non-slug workspace name (colon) with 400", async () => {
    const env = await makeSeededEnv();
    const res = await app.fetch(commitReq({ name: "a%3Ab" }), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("workspace name");
    expect(vi.mocked(cloneRepo)).not.toHaveBeenCalled();
  });

  it("rejects an over-long workspace name with 400", async () => {
    const env = await makeSeededEnv();
    const res = await app.fetch(commitReq({ name: "x".repeat(65) }), env);
    expect(res.status).toBe(400);
    expect(vi.mocked(cloneRepo)).not.toHaveBeenCalled();
  });

  it.each([
    ["dot-dot traversal", "../evil.txt"],
    ["nested traversal", "src/../../evil.txt"],
    ["absolute path", "/etc/passwd"],
  ])("rejects a traversal-shaped file key (%s) before cloning", async (_label, key) => {
    const env = await makeSeededEnv();
    const res = await app.fetch(commitReq({ files: { [key]: "x" } }), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("repo-relative");
    expect(vi.mocked(cloneRepo)).not.toHaveBeenCalled();
  });

  it("rejects a payload over the total byte cap before cloning", async () => {
    const env = await makeSeededEnv();
    const res = await app.fetch(
      commitReq({ files: { "big.bin": "x".repeat(25 * 1024 * 1024 + 1) } }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("too large");
    expect(vi.mocked(cloneRepo)).not.toHaveBeenCalled();
  });
});

describe("S7 — delete route identifier validation", () => {
  function deleteReq(name: string, projectId: string): Request {
    return new Request(`http://localhost/api/workspaces/${name}?projectId=${projectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
  }

  it("rejects a non-UUID projectId with 400; nothing deleted", async () => {
    const env = await makeSeededEnv();
    const res = await app.fetch(deleteReq("myws", "proj_1"), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("UUID");
    expect(
      (env.ARTIFACTS as unknown as { delete: ReturnType<typeof vi.fn> }).delete,
    ).not.toHaveBeenCalled();
    expect(await env.STATE.get(`workspace:${PROJECT_ID}:myws`)).not.toBeNull();
  });

  it("rejects a non-slug workspace name with 400", async () => {
    const env = await makeSeededEnv();
    const res = await app.fetch(deleteReq("a%3Ab", PROJECT_ID), env);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("workspace name");
  });
});

describe("S7 — commitAndPush guards (every caller, not just the route)", () => {
  const logger = createLogger({ component: "test" });
  // Guards run before any fs/git access, so an empty stub suffices.
  const fs = {} as NodeFS;

  it.each([
    ["dot-dot traversal", "../evil.txt"],
    ["nested traversal", "a/../../b.txt"],
    ["absolute path", "/etc/passwd"],
  ])("refuses %s with INVALID_INPUT 422", async (_label, key) => {
    const result = await commitAndPush(fs, "/", WS_REMOTE, "tok", { [key]: "x" }, "msg", logger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.statusCode).toBe(422);
      expect(result.error.message).toContain("traversal");
    }
  });

  it("refuses a single file over 10 MB with INVALID_INPUT 422", async () => {
    const result = await commitAndPush(
      fs,
      "/",
      WS_REMOTE,
      "tok",
      { "big.bin": "x".repeat(10 * 1024 * 1024 + 1) },
      "msg",
      logger,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_INPUT");
      expect(result.error.message).toContain("maximum size");
    }
  });

  it("accepts ordinary repo-relative paths (guard does not overfire)", async () => {
    // A benign map passes the guards and then fails on the stub fs — proving
    // the rejection above came from the guard, not the stub.
    const result = await commitAndPush(
      fs,
      "/",
      WS_REMOTE,
      "tok",
      { "src/ok..txt": "x", "docs/..hidden": "y" },
      "msg",
      logger,
    );
    if (!result.success) {
      expect(result.error.code).not.toBe("INVALID_INPUT");
    }
  });
});
