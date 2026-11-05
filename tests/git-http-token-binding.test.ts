/**
 * Issue #323: a token bound to one project or org over git smart-HTTP.
 *
 * git-http authenticates for itself (the global middleware steps aside for git
 * paths), so the binding has to be threaded through its own `Identity` into
 * authz. These pin that it is: a bound token clones and pushes its own project
 * and is answered with the router's no-leak 404 everywhere else — including on
 * the write entry points, where a missed binding would mint a write-scoped
 * Artifacts credential for the wrong repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { CredentialBinding, Env, ProjectEntry } from "../src/types";

const PROJECT_BOUND = "stratum_user_11111111111111111111111111111111";
const ORG_BOUND = "stratum_user_22222222222222222222222222222222";
const UNBOUND_TOKEN = "stratum_user_33333333333333333333333333333333";

const BINDINGS: Record<string, CredentialBinding> = {
  [PROJECT_BOUND]: { kind: "project", projectId: "proj_mine" },
  [ORG_BOUND]: { kind: "org", orgId: "org_acme" },
  [UNBOUND_TOKEN]: { kind: "unbound" },
};

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "secret?expires=9999999999" })),
  };
});

vi.mock("../src/storage/api-tokens", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/api-tokens")>();
  return {
    ...actual,
    touchApiTokenLastUsed: vi.fn(async () => {}),
    resolveApiToken: vi.fn(async (_db: unknown, token: string) => {
      const binding = BINDINGS[token];
      if (binding === undefined) {
        return { success: false, error: { code: "NOT_FOUND", statusCode: 404 } };
      }
      return {
        success: true,
        data: {
          user: { id: "user_owner", email: "o@x.io", username: "owner" },
          scope: "read_write",
          binding,
          tokenId: "tok_1",
        },
      };
    }),
  };
});

vi.mock("../src/storage/users", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/users")>()),
  getUserByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
  getUser: vi.fn(async (_db: unknown, id: string) => ({
    success: true,
    data: { id, email: "o@x.io", username: "owner" },
  })),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

// The caller administers every org it is asked about, so the only thing that
// can refuse an org project below is the binding itself.
vi.mock("../src/storage/orgs", async (importActual) =>
  (await import("./helpers/org-access-mock")).withOrgAccess({
    ...(await importActual<typeof import("../src/storage/orgs")>()),
    getOrgAccessLevel: vi.fn(async () => "admin" as const),
  }),
);

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
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: { delete: vi.fn(async () => {}) } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
    GIT_PUSH_GATED_ENABLED: "true",
  } as Env;
}

function project(overrides: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: "proj_x",
    name: "x",
    slug: "x",
    namespace: "@owner",
    ownerId: "user_owner",
    ownerType: "user",
    remote: "https://acct.artifacts.cloudflare.net/git/@owner/x.git",
    createdAt: new Date().toISOString(),
    visibility: "private",
    ...overrides,
  };
}

async function seed(env: Env): Promise<void> {
  const entries = [
    project({ id: "proj_mine", slug: "mine", name: "mine" }),
    project({ id: "proj_other", slug: "other", name: "other" }),
    project({
      id: "proj_acme",
      slug: "app",
      name: "app",
      namespace: "@acme",
      ownerId: "org_acme",
      ownerType: "org",
    }),
    project({
      id: "proj_globex",
      slug: "app",
      name: "app",
      namespace: "@globex",
      ownerId: "org_globex",
      ownerType: "org",
    }),
  ];
  for (const entry of entries) {
    await env.STATE.put(`project:${entry.namespace}:${entry.slug}`, JSON.stringify(entry));
    await env.STATE.put(
      `workspace:${entry.id}:ws`,
      JSON.stringify({
        name: "ws",
        remote: `https://acct.artifacts.cloudflare.net/git/${entry.namespace}/ws-${entry.slug}.git`,
        parent: entry.id,
        createdAt: new Date().toISOString(),
        createdByUserId: "user_owner",
      }),
    );
  }
}

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(
    async () =>
      new Response("PACKDATA", {
        status: 200,
        headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
      }),
  ) as unknown as typeof fetch;
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Read and write entry points, project and workspace, for a repo path. */
function entryPoints(repo: string): Array<{ label: string; path: string; method: string }> {
  return [
    {
      label: "clone advertisement",
      path: `${repo}.git/info/refs?service=git-upload-pack`,
      method: "GET",
    },
    { label: "clone RPC", path: `${repo}.git/git-upload-pack`, method: "POST" },
    {
      label: "push advertisement",
      path: `${repo}.git/info/refs?service=git-receive-pack`,
      method: "GET",
    },
    {
      label: "workspace clone",
      path: `${repo}/workspaces/ws.git/info/refs?service=git-upload-pack`,
      method: "GET",
    },
    {
      label: "workspace push advertisement",
      path: `${repo}/workspaces/ws.git/info/refs?service=git-receive-pack`,
      method: "GET",
    },
    { label: "workspace push RPC", path: `${repo}/workspaces/ws/git-receive-pack`, method: "POST" },
  ];
}

async function hit(token: string, path: string, method: string): Promise<Response> {
  const env = makeEnv();
  await seed(env);
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: basic(token),
      ...(method === "POST" ? { body: "" } : {}),
    }),
    env,
  );
}

describe("a project-bound token over git", () => {
  it.each(entryPoints("/@owner/mine").filter((e) => e.method === "GET"))(
    "reaches its own project: $label",
    async ({ path, method }) => {
      const res = await hit(PROJECT_BOUND, path, method);
      expect(res.status).toBe(200);
    },
  );

  it.each(entryPoints("/@owner/other"))(
    "is a 404 on another project of the same owner: $label",
    async ({ path, method }) => {
      const res = await hit(PROJECT_BOUND, path, method);
      expect(res.status).toBe(404);
      // Nothing proxied, so no Artifacts credential was minted for the repo.
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    },
  );

  it("is a 404 on an org project its owner administers", async () => {
    const res = await hit(PROJECT_BOUND, "/@acme/app.git/info/refs?service=git-upload-pack", "GET");
    expect(res.status).toBe(404);
  });
});

describe("an org-bound token over git", () => {
  it.each(entryPoints("/@acme/app").filter((e) => e.method === "GET"))(
    "reaches its org's project: $label",
    async ({ path, method }) => {
      const res = await hit(ORG_BOUND, path, method);
      expect(res.status).toBe(200);
    },
  );

  it.each([...entryPoints("/@globex/app"), ...entryPoints("/@owner/mine")])(
    "is a 404 outside its org: $path",
    async ({ path, method }) => {
      const res = await hit(ORG_BOUND, path, method);
      expect(res.status).toBe(404);
      expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    },
  );
});

describe("an unbound token over git is unchanged", () => {
  it.each(["/@owner/mine", "/@owner/other", "/@acme/app", "/@globex/app"])(
    "clones %s",
    async (repo) => {
      const res = await hit(UNBOUND_TOKEN, `${repo}.git/info/refs?service=git-upload-pack`, "GET");
      expect(res.status).toBe(200);
    },
  );
});
