/**
 * S5 (#130): REST workspace error taxonomy. Unauthorized-vs-missing must be
 * indistinguishable across tenants (both 404, byte-identical), and storage
 * failures must never echo messages that embed tenant identifiers (project id,
 * KV keys) — a corrupt entry must not confirm a resource exists.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { getWorkspace } from "../src/storage/state";
import type { Env, ProjectEntry } from "../src/types";
import { createLogger } from "../src/utils/logger";

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
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

// A real (UUID) project id: the commit/delete routes validate the shape (S7).
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

function makeEnv(): Env {
  return {
    ARTIFACTS: { delete: vi.fn(async () => true) } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
  } as Env;
}

async function seedProject(env: Env): Promise<void> {
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
}

async function seedWorkspace(env: Env, raw?: string): Promise<void> {
  await env.STATE.put(
    `workspace:${PROJECT_ID}:myws`,
    raw ??
      JSON.stringify({
        name: "myws",
        remote: WS_REMOTE,
        parent: PROJECT_ID,
        createdAt: new Date().toISOString(),
        createdByUserId: "user_owner",
      }),
  );
}

function commitReq(token: string): Request {
  return new Request("http://localhost/api/workspaces/myws/commit", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: PROJECT_ID, message: "m", files: { "a.txt": "hi" } }),
  });
}

function deleteReq(token: string): Request {
  return new Request(`http://localhost/api/workspaces/myws?projectId=${PROJECT_ID}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("S5 — unauthorized vs missing are byte-identical 404s", () => {
  it("commit: stranger-on-existing and owner-on-missing get the same response", async () => {
    const envExisting = makeEnv();
    await seedProject(envExisting);
    await seedWorkspace(envExisting);
    const denied = await app.fetch(commitReq(OTHER_TOKEN), envExisting);
    expect(denied.status).toBe(404);

    const envMissing = makeEnv();
    await seedProject(envMissing);
    // no workspace seeded
    const missing = await app.fetch(commitReq(OWNER_TOKEN), envMissing);
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
  });

  it("delete: stranger-on-existing and owner-on-missing get the same response", async () => {
    const envExisting = makeEnv();
    await seedProject(envExisting);
    await seedWorkspace(envExisting);
    const denied = await app.fetch(deleteReq(OTHER_TOKEN), envExisting);
    expect(denied.status).toBe(404);

    const envMissing = makeEnv();
    await seedProject(envMissing);
    const missing = await app.fetch(deleteReq(OWNER_TOKEN), envMissing);
    expect(missing.status).toBe(404);
    expect(await denied.text()).toBe(await missing.text());
  });
});

describe("S5 — storage failures do not echo tenant identifiers", () => {
  it("commit against a CORRUPT workspace entry → generic 500, no project id, no KV key", async () => {
    const env = makeEnv();
    await seedProject(env);
    await seedWorkspace(env, "{not json");
    const res = await app.fetch(commitReq(OTHER_TOKEN), env);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(PROJECT_ID);
    expect(text).not.toContain("workspace:");
    expect(text).not.toContain("parse");
    expect(JSON.parse(text)).toEqual({ error: "Internal error" });
  });

  it("workspace CREATE against a corrupt project entry → generic 500", async () => {
    const env = makeEnv();
    await env.STATE.put("project:@owner:repo", "{not json");
    const res = await app.fetch(
      new Request("http://localhost/api/workspaces/@owner/repo/workspaces", {
        method: "POST",
        headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      env,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("project:");
    expect(JSON.parse(text)).toEqual({ error: "Internal error" });
  });

  it("workspace LIST against a corrupt project entry → generic 500", async () => {
    const env = makeEnv();
    await env.STATE.put("project:@owner:repo", "{not json");
    const res = await app.fetch(
      new Request("http://localhost/api/workspaces/@owner/repo/workspaces", {
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
      }),
      env,
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(await res.text())).toEqual({ error: "Internal error" });
  });

  it("workspace LIST when the KV list itself fails → generic 500", async () => {
    const env = makeEnv();
    await seedProject(env);
    const state = env.STATE as unknown as { list: () => Promise<never> };
    state.list = async () => {
      throw new Error(`kv outage near workspace:${PROJECT_ID}`);
    };
    const res = await app.fetch(
      new Request("http://localhost/api/workspaces/@owner/repo/workspaces", {
        headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
      }),
      env,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(PROJECT_ID);
    expect(JSON.parse(text)).toEqual({ error: "Internal error" });
  });

  it("delete against a CORRUPT workspace entry → generic 500", async () => {
    const env = makeEnv();
    await seedProject(env);
    await seedWorkspace(env, "{not json");
    const res = await app.fetch(deleteReq(OTHER_TOKEN), env);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(PROJECT_ID);
    expect(JSON.parse(text)).toEqual({ error: "Internal error" });
  });
});

describe("S5 — state.ts error messages carry no project id", () => {
  const logger = createLogger({ component: "test" });

  it("getWorkspace NOT_FOUND message names only the workspace", async () => {
    const result = await getWorkspace(makeKV(), PROJECT_ID, "myws", logger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).not.toContain(PROJECT_ID);
      // The id is still available for logs via context.
      expect(result.error.context?.projectId).toBe(PROJECT_ID);
    }
  });

  it("getWorkspace parse failure message names neither the key nor the project id", async () => {
    const kv = makeKV();
    await kv.put(`workspace:${PROJECT_ID}:myws`, "{corrupt");
    const result = await getWorkspace(kv, PROJECT_ID, "myws", logger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("PARSE_ERROR");
      expect(result.error.message).not.toContain(PROJECT_ID);
      expect(result.error.message).not.toContain("workspace:");
      expect(result.error.context?.key).toContain(PROJECT_ID);
    }
  });
});
