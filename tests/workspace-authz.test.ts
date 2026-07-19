/**
 * Authorization on the workspace write/delete endpoints. These previously had
 * NO project-write check: any authenticated caller who knew a project id and a
 * workspace name could push commits into, or delete, another tenant's workspace.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { workspacesRouter } from "../src/routes/workspaces";
import type { Env } from "../src/types";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db: unknown, token: string) =>
    token === "stratum_user_writer000000000000000000"
      ? { success: true, data: { id: "user_writer", email: "w@x.com", username: "w" } }
      : { success: true, data: { id: "user_reader", email: "r@x.com", username: "r" } },
  ),
  getUser: vi.fn(async () => ({ success: false, error: { message: "nf" } })),
}));
vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "nf" } })),
}));

vi.mock("../src/storage/state", () => ({
  getProjectById: vi.fn(),
  getWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(async () => ({ success: true, data: undefined })),
  setWorkspace: vi.fn(),
  getProjectByPath: vi.fn(),
  listWorkspaces: vi.fn(),
}));
vi.mock("../src/utils/authz", () => ({
  canWriteProject: vi.fn(),
  canReadProject: vi.fn(),
}));
vi.mock("../src/storage/git-ops", () => ({
  artifactsRepoNameFromRemote: vi.fn(() => "fork-repo"),
  cloneRepo: vi.fn(async () => ({ success: true, data: { fs: {}, dir: "/" } })),
  commitAndPush: vi.fn(async () => ({ success: true, data: "sha_new" })),
  freshRepoToken: vi.fn(async () => ({ success: true, data: "tok" })),
  stageWorkspaceTree: vi.fn(),
}));
vi.mock("../src/queue/events", () => ({ emitEvent: vi.fn(async () => undefined) }));

import { commitAndPush } from "../src/storage/git-ops";
import { getProjectById, getWorkspace } from "../src/storage/state";
import { canWriteProject } from "../src/utils/authz";

const WRITER = { Authorization: "Bearer stratum_user_writer000000000000000000" };
const READER = { Authorization: "Bearer stratum_user_reader000000000000000000" };

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/workspaces", workspacesRouter);
  return app;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: { delete: vi.fn(async () => undefined) } as unknown as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
  } as unknown as Env;
}

const project = {
  id: "proj_1",
  name: "repo",
  slug: "repo",
  namespace: "@owner",
  ownerId: "user_writer",
  ownerType: "user" as const,
  remote: "https://artifacts.example.com/repos/fork-repo",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const workspace = {
  name: "fix-bug",
  remote: "https://artifacts.example.com/repos/fork-repo",
  parent: "proj_1",
  branchName: "fix-bug",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectById).mockResolvedValue({ success: true, data: project });
  vi.mocked(getWorkspace).mockResolvedValue({ success: true, data: workspace });
});

describe("POST /api/workspaces/:name/commit — authorization", () => {
  const body = { projectId: "proj_1", message: "m", files: { "a.txt": "hi" } };

  it("403s a caller without project write access; never pushes", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(false);
    const res = await makeApp().fetch(
      new Request("http://localhost/api/workspaces/fix-bug/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...READER },
        body: JSON.stringify(body),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(403);
    expect(commitAndPush).not.toHaveBeenCalled();
  });

  it("allows a writer to commit", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(true);
    const res = await makeApp().fetch(
      new Request("http://localhost/api/workspaces/fix-bug/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...WRITER },
        body: JSON.stringify(body),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(commitAndPush).toHaveBeenCalled();
  });

  it("rejects an oversized file map before doing any work", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(true);
    const files: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) files[`f${i}.txt`] = "x";
    const res = await makeApp().fetch(
      new Request("http://localhost/api/workspaces/fix-bug/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...WRITER },
        body: JSON.stringify({ projectId: "proj_1", message: "m", files }),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(commitAndPush).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/workspaces/:name — authorization", () => {
  it("403s a caller without project write access; never deletes", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(false);
    const env = makeEnv();
    const res = await makeApp().fetch(
      new Request("http://localhost/api/workspaces/fix-bug?projectId=proj_1", {
        method: "DELETE",
        headers: { ...READER },
      }),
      env,
    );
    expect(res.status).toBe(403);
    expect(
      (env.ARTIFACTS as unknown as { delete: ReturnType<typeof vi.fn> }).delete,
    ).not.toHaveBeenCalled();
  });

  it("allows a writer to delete, targeting the remote-derived repo name", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(true);
    const env = makeEnv();
    const res = await makeApp().fetch(
      new Request("http://localhost/api/workspaces/fix-bug?projectId=proj_1", {
        method: "DELETE",
        headers: { ...WRITER },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(
      (env.ARTIFACTS as unknown as { delete: ReturnType<typeof vi.fn> }).delete,
    ).toHaveBeenCalledWith("fork-repo");
  });
});
