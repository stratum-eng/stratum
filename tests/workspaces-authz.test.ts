import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ProjectEntry } from "../src/types";

// The commit/delete write paths clone+push via git-ops. We only need to prove
// authorization gates the request BEFORE any git work, so the git primitives are
// stubbed to a benign success and we assert on whether they were reached.
vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "secret?expires=9999999999" })),
    cloneRepo: vi.fn(async () => ({ success: true, data: { fs: {}, dir: "/tmp/x" } })),
    commitAndPush: vi.fn(async () => ({ success: true, data: "abc123" })),
    stageWorkspaceTree: vi.fn(async () => ({ success: false, error: { message: "skip" } })),
  };
});

const OWNER_TOKEN = "stratum_user_owner000000000000000000";
const OTHER_TOKEN = "stratum_user_other000000000000000000";
const AGENT_TOKEN = "stratum_agent_agent00000000000000000";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === OWNER_TOKEN)
      return { success: true, data: { id: "user_owner", email: "o@x.io", username: "owner" } };
    if (token === OTHER_TOKEN)
      return { success: true, data: { id: "user_other", email: "t@x.io", username: "other" } };
    return { success: false, error: { message: "not found" } };
  }),
  getUser: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === AGENT_TOKEN)
      return { success: true, data: { id: "agent_1", ownerId: "user_owner" } };
    return { success: false, error: { message: "not found" } };
  }),
}));

// Org access: user_owner → admin, user_other → write (project write, not admin).
vi.mock("../src/storage/orgs", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/orgs")>();
  return {
    ...actual,
    getOrgAccessLevel: vi.fn(
      async (_db: unknown, _logger: unknown, _orgId: string, uid: string) => {
        if (uid === "user_owner") return "admin";
        if (uid === "user_other") return "write";
        return "none";
      },
    ),
  };
});

import { commitAndPush } from "../src/storage/git-ops";

const ARTIFACTS_REMOTE = "https://acct.artifacts.cloudflare.net/git/@owner/repo.git";
const WS_REMOTE = "https://acct.artifacts.cloudflare.net/git/@owner/myws.git";

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
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
  return { kv, store };
}

let artifactsDelete: ReturnType<typeof vi.fn>;

function makeEnv(): Env {
  artifactsDelete = vi.fn(async () => true);
  return {
    ARTIFACTS: { delete: artifactsDelete } as unknown as Env["ARTIFACTS"],
    STATE: makeKV().kv,
    DB: {} as D1Database,
  } as Env;
}

async function seed(
  env: Env,
  opts: {
    projectOverrides?: Partial<ProjectEntry>;
    workspace?: { createdByUserId?: string; remote?: string };
  } = {},
): Promise<void> {
  const project: ProjectEntry = {
    id: "proj_1",
    name: "repo",
    slug: "repo",
    namespace: "@owner",
    ownerId: "user_owner",
    ownerType: "user",
    remote: ARTIFACTS_REMOTE,
    createdAt: new Date().toISOString(),
    visibility: "private",
    ...opts.projectOverrides,
  };
  await env.STATE.put(`project:${project.namespace}:${project.slug}`, JSON.stringify(project));
  await env.STATE.put(
    "workspace:proj_1:myws",
    JSON.stringify({
      name: "myws",
      remote: opts.workspace?.remote ?? WS_REMOTE,
      parent: "proj_1",
      createdAt: new Date().toISOString(),
      ...(opts.workspace?.createdByUserId !== undefined
        ? { createdByUserId: opts.workspace.createdByUserId }
        : {}),
    }),
  );
}

function commitReq(token: string): Request {
  return new Request("http://localhost/api/workspaces/myws/commit", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "proj_1", message: "m", files: { "a.txt": "hi" } }),
  });
}

function deleteReq(token: string): Request {
  return new Request("http://localhost/api/workspaces/myws?projectId=proj_1", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/workspaces/:name/commit — write authorization (S0/S1)", () => {
  it("cross-tenant: a caller with no access to the workspace's project is denied (404)", async () => {
    // Org project; a stranger (org level 'none') attempts to commit.
    const env = makeEnv();
    await seed(env, {
      projectOverrides: { ownerId: "org_1", ownerType: "org" },
      workspace: { createdByUserId: "user_owner" },
    });
    // A token that resolves to a user with no org access at all.
    const res = await app.fetch(commitReq("stratum_user_stranger00000000000000"), env);
    // Unknown token → treated as unauthenticated by authMiddleware → 401.
    expect(res.status).toBe(401);
    expect(vi.mocked(commitAndPush)).not.toHaveBeenCalled();
  });

  it("non-creator project-writer (org write, not admin) is denied (404)", async () => {
    const env = makeEnv();
    await seed(env, {
      projectOverrides: { ownerId: "org_1", ownerType: "org" },
      workspace: { createdByUserId: "user_owner" },
    });
    const res = await app.fetch(commitReq(OTHER_TOKEN), env);
    expect(res.status).toBe(404);
    expect(vi.mocked(commitAndPush)).not.toHaveBeenCalled();
  });

  it("the creator is allowed and the commit reaches git", async () => {
    const env = makeEnv();
    await seed(env, {
      projectOverrides: { ownerId: "org_1", ownerType: "org" },
      workspace: { createdByUserId: "user_other" },
    });
    const res = await app.fetch(commitReq(OTHER_TOKEN), env);
    expect(res.status).toBe(200);
    expect(vi.mocked(commitAndPush)).toHaveBeenCalledOnce();
  });

  it("the project admin (owner) is allowed even on a workspace they did not create", async () => {
    const env = makeEnv();
    await seed(env, { workspace: { createdByUserId: "user_other" } });
    const res = await app.fetch(commitReq(OWNER_TOKEN), env);
    expect(res.status).toBe(200);
    expect(vi.mocked(commitAndPush)).toHaveBeenCalledOnce();
  });
});

describe("DELETE /api/workspaces/:name — write authorization + Artifacts name", () => {
  it("a non-owner (org write, not creator/admin) is denied (404), no Artifacts delete", async () => {
    const env = makeEnv();
    await seed(env, {
      projectOverrides: { ownerId: "org_1", ownerType: "org" },
      workspace: { createdByUserId: "user_owner" },
    });
    const res = await app.fetch(deleteReq(OTHER_TOKEN), env);
    expect(res.status).toBe(404);
    expect(artifactsDelete).not.toHaveBeenCalled();
  });

  it("the creator deletes and the Artifacts delete uses the remote-derived repo name", async () => {
    const env = makeEnv();
    await seed(env, { workspace: { createdByUserId: "user_owner" } });
    const res = await app.fetch(deleteReq(OWNER_TOKEN), env);
    expect(res.status).toBe(200);
    // remote "…/git/@owner/myws.git" → repo name "myws", NOT the workspace key.
    expect(artifactsDelete).toHaveBeenCalledWith("myws");
  });

  it("skips the Artifacts delete when the remote is not an Artifacts host", async () => {
    const env = makeEnv();
    await seed(env, {
      workspace: { createdByUserId: "user_owner", remote: "https://github.com/foo/bar.git" },
    });
    const res = await app.fetch(deleteReq(OWNER_TOKEN), env);
    expect(res.status).toBe(200);
    expect(artifactsDelete).not.toHaveBeenCalled();
  });
});
