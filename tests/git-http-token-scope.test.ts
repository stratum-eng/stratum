/**
 * Issue #254: a read-only API token must not be able to write over git.
 *
 * The four write entry points in `src/routes/git-http.ts` are covered here
 * because the check keys on the SCOPE each authorize function already resolves,
 * not on the request path. That distinction is the whole design:
 * `GET /info/refs?service=git-receive-pack` *looks* like a read and is not —
 * it authorizes with `canWriteProject` and proxies with a write-scoped
 * Artifacts token. A path-shaped rule allowing "info/refs" would have handed a
 * read-only token a write authorization and a minted write credential.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ProjectEntry } from "../src/types";

const READ_TOKEN = "stratum_user_11111111111111111111111111111111";
const WRITE_TOKEN = "stratum_user_22222222222222222222222222222222";
const LEGACY_TOKEN = "stratum_user_33333333333333333333333333333333";

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
      const scope = token === READ_TOKEN ? "read" : token === WRITE_TOKEN ? "read_write" : null;
      if (scope === null) return { success: false, error: { code: "NOT_FOUND", statusCode: 404 } };
      return {
        success: true,
        data: {
          user: { id: "user_owner", email: "o@x.io", username: "owner" },
          scope,
          tokenId: `tok_${scope}`,
        },
      };
    }),
  };
});

// Spread the real module: src/index.ts pulls other exports (createUser,
// getUserByEmail) from here, and a replacement object would leave them absent.
vi.mock("../src/storage/users", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/users")>()),
  getUserByToken: vi.fn(async (_db: unknown, token: string) =>
    token === LEGACY_TOKEN
      ? { success: true, data: { id: "user_owner", email: "o@x.io", username: "owner" } }
      : { success: false, error: { message: "not found" } },
  ),
  getUser: vi.fn(async (_db: unknown, id: string) => ({
    success: true,
    data: { id, email: "o@x.io", username: "owner" },
  })),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async () => ({ success: false, error: { message: "not found" } })),
}));

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

async function seed(env: Env): Promise<void> {
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
  };
  await env.STATE.put("project:@owner:repo", JSON.stringify(project));
  await env.STATE.put(
    "workspace:proj_1:myws",
    JSON.stringify({
      name: "myws",
      remote: WS_REMOTE,
      parent: "proj_1",
      createdAt: new Date().toISOString(),
      createdByUserId: "user_owner",
    }),
  );
}

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init);
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

/** Every path in this router that authorizes a WRITE. */
const WRITE_ENTRY_POINTS: Array<{ label: string; path: string; method: string }> = [
  {
    label: "project receive-pack advertisement",
    path: "/@owner/repo.git/info/refs?service=git-receive-pack",
    method: "GET",
  },
  { label: "project receive-pack RPC", path: "/@owner/repo.git/git-receive-pack", method: "POST" },
  {
    label: "workspace receive-pack advertisement",
    path: "/@owner/repo/workspaces/myws.git/info/refs?service=git-receive-pack",
    method: "GET",
  },
  {
    label: "workspace receive-pack RPC",
    path: "/@owner/repo/workspaces/myws/git-receive-pack",
    method: "POST",
  },
];

describe("read-only token over git smart-HTTP", () => {
  it.each(WRITE_ENTRY_POINTS)("is refused at the $label", async ({ path, method }) => {
    const env = makeEnv();
    await seed(env);

    const res = await app.fetch(
      req(path, { method, headers: basic(READ_TOKEN), ...(method === "POST" ? { body: "" } : {}) }),
      env,
    );

    // 404, matching every other authorization failure in this router: a token
    // that cannot write must not learn the repository exists.
    expect(res.status).toBe(404);
    // Nothing was proxied upstream, so no write-scoped Artifacts token was minted.
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("can still clone — upload-pack is a read even though the RPC is a POST", async () => {
    const env = makeEnv();
    await seed(env);

    const advertise = await app.fetch(
      req("/@owner/repo.git/info/refs?service=git-upload-pack", { headers: basic(READ_TOKEN) }),
      env,
    );
    expect(advertise.status).toBe(200);

    const rpc = await app.fetch(
      req("/@owner/repo.git/git-upload-pack", {
        method: "POST",
        headers: basic(READ_TOKEN),
        body: "",
      }),
      env,
    );
    // The whole point of the CI use case: a method-based rule would have
    // blocked this, since upload-pack and receive-pack are both POSTs.
    expect(rpc.status).toBe(200);
  });

  it("can still read the workspace remote", async () => {
    const env = makeEnv();
    await seed(env);
    const res = await app.fetch(
      req("/@owner/repo/workspaces/myws.git/info/refs?service=git-upload-pack", {
        headers: basic(READ_TOKEN),
      }),
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe("write-capable credentials are unaffected", () => {
  it.each(WRITE_ENTRY_POINTS)(
    "a read_write token is not refused at the $label",
    async ({ path, method }) => {
      const env = makeEnv();
      await seed(env);
      const res = await app.fetch(
        req(path, {
          method,
          headers: basic(WRITE_TOKEN),
          ...(method === "POST" ? { body: "" } : {}),
        }),
        env,
      );
      // Whatever the outcome of the push itself, it is not the scope refusal.
      expect(res.status).not.toBe(404);
    },
  );

  it("the legacy users.token_hash credential keeps full write access", async () => {
    const env = makeEnv();
    await seed(env);
    const res = await app.fetch(
      req("/@owner/repo.git/info/refs?service=git-receive-pack", { headers: basic(LEGACY_TOKEN) }),
      env,
    );
    // It predates scopes; this deploys without breaking anyone's push.
    expect(res.status).not.toBe(404);
  });
});
