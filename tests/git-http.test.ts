import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { isGitHttpPath } from "../src/routes/git-http";
import type { Env, ProjectEntry } from "../src/types";

// Real `artifactsRepoNameFromRemote` + `extractTokenSecret` (pure) are kept so
// the tests exercise the genuine URL validation; only `freshRepoToken` (which
// needs the ARTIFACTS binding) is stubbed.
vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "secret?expires=9999999999" })),
  };
});

const OWNER_TOKEN = "stratum_user_owner000000000000000000";
const OTHER_TOKEN = "stratum_user_other000000000000000000";
const AGENT_TOKEN = "stratum_agent_agent00000000000000000";
const INVALID_TOKEN = "stratum_user_invalid0000000000000000";

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

const ARTIFACTS_REMOTE = "https://acct.artifacts.cloudflare.net/git/@owner/repo.git";

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
    ARTIFACTS: {} as unknown as Env["ARTIFACTS"],
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
    ownerId: "user_owner",
    ownerType: "user",
    remote: ARTIFACTS_REMOTE,
    createdAt: new Date().toISOString(),
    visibility: "private",
    ...overrides,
  };
  await env.STATE.put(`project:${project.namespace}:${project.slug}`, JSON.stringify(project));
  return project;
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init);
}

function basic(token: string, inUsername = false): Record<string, string> {
  const pair = inUsername ? `${token}:` : `x:${token}`;
  return { Authorization: `Basic ${btoa(pair)}` };
}

const ADVERTISE = "/@owner/repo.git/info/refs?service=git-upload-pack";

let originalFetch: typeof fetch;

function stubFetch(impl: (url: string, init: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
    impl(String(input), init),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function okUpstream(): Response {
  return new Response("PACKDATA", {
    status: 200,
    headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("isGitHttpPath — matches only the git route shape", () => {
  it("matches real git endpoints", () => {
    expect(isGitHttpPath("/@owner/repo.git/info/refs")).toBe(true);
    expect(isGitHttpPath("/@owner/repo/git-upload-pack")).toBe(true);
    expect(isGitHttpPath("/org-slug/repo.git/git-receive-pack")).toBe(true);
  });

  it("does NOT match routes that merely end in a git suffix", () => {
    // The UI blob route would otherwise lose auth/CSRF/rate-limit.
    expect(isGitHttpPath("/@owner/repo.git/blob/x/info/refs")).toBe(false);
    expect(isGitHttpPath("/@owner/repo/blob/dir/git-upload-pack")).toBe(false);
    expect(isGitHttpPath("/info/refs")).toBe(false);
    expect(isGitHttpPath("/api/projects")).toBe(false);
  });
});

describe("git smart-HTTP proxy — routing & middleware exemption (Task 1)", () => {
  it("a Basic-auth git request reaches the router, not authMiddleware's JSON 401", async () => {
    const env = makeEnv();
    await seedProject(env);
    const res = await app.fetch(req(ADVERTISE, { headers: basic(INVALID_TOKEN) }), env);
    // authMiddleware would have returned {"error":"Invalid token"} with no challenge.
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="Stratum"');
    expect(await res.text()).not.toContain("Invalid token");
  });

  it("dispatches GET info/refs on the service param: 400 when absent", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    const res = await app.fetch(req("/@owner/repo.git/info/refs"), env);
    expect(res.status).toBe(400);
  });

  it("git path does not fall through to the UI catch-all", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE), env);
    expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
  });
});

describe("git smart-HTTP proxy — auth & authorization truth table (Task 2)", () => {
  it("anonymous + public → proxied (200)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE), env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("anonymous + private → 401 challenge, no upstream call", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="Stratum"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anonymous + missing → 401 challenge, byte-identical to private-exists", async () => {
    const env = makeEnv();
    // no project seeded
    const res = await app.fetch(req("/@owner/missing.git/info/refs?service=git-upload-pack"), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="Stratum"');

    const env2 = makeEnv();
    await seedProject(env2, { visibility: "private" });
    const privateRes = await app.fetch(req(ADVERTISE), env2);
    expect(await res.text()).toBe(await privateRes.text());
  });

  it("owner token + private → proxied (200)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE, { headers: basic(OWNER_TOKEN) }), env);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("agent owned by the user + private → proxied (200)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE, { headers: basic(AGENT_TOKEN) }), env);
    expect(res.status).toBe(200);
  });

  it("non-owner token + private → 404, byte-identical to authed+missing", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const res = await app.fetch(req(ADVERTISE, { headers: basic(OTHER_TOKEN) }), env);
    expect(res.status).toBe(404);

    const env2 = makeEnv();
    const missingRes = await app.fetch(
      req("/@owner/missing.git/info/refs?service=git-upload-pack", {
        headers: basic(OTHER_TOKEN),
      }),
      env2,
    );
    expect(missingRes.status).toBe(404);
    expect(await res.text()).toBe(await missingRes.text());
  });

  it("invalid token + private → treated as anonymous (401)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const res = await app.fetch(req(ADVERTISE, { headers: basic(INVALID_TOKEN) }), env);
    expect(res.status).toBe(401);
  });

  it("token in the username field is accepted", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    stubFetch(() => okUpstream());
    const res = await app.fetch(
      req(ADVERTISE, { headers: basic(OWNER_TOKEN, /* inUsername */ true) }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("non-Artifacts remote → 501 (post-authorization)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public", remote: "https://github.com/foo/bar.git" });
    const res = await app.fetch(req(ADVERTISE), env);
    expect(res.status).toBe(501);
  });

  it("non-Artifacts remote + private + anonymous → 401, never 501 (no leak)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private", remote: "https://github.com/foo/bar.git" });
    const res = await app.fetch(req(ADVERTISE), env);
    expect(res.status).toBe(401);
  });

  it.each([
    ["empty payload", "Basic "],
    ["non-base64", "Basic !!!notbase64"],
    ["no colon", `Basic ${btoa("nocolon")}`],
    ["empty token", `Basic ${btoa(":")}`],
  ])(
    "malformed Authorization (%s) is treated as anonymous → 401 on private",
    async (_label, header) => {
      const env = makeEnv();
      await seedProject(env, { visibility: "private" });
      const res = await app.fetch(req(ADVERTISE, { headers: { Authorization: header } }), env);
      expect(res.status).toBe(401);
    },
  );
});

describe("git smart-HTTP proxy — upstream proxy (Task 3)", () => {
  it("builds the upstream URL and Artifacts Basic auth; never forwards the client token", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    const fetchMock = stubFetch(() => okUpstream());

    await app.fetch(req(ADVERTISE, { headers: { "Git-Protocol": "version=2" } }), env);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${ARTIFACTS_REMOTE}/info/refs?service=git-upload-pack`);
    const headers = init.headers as Record<string, string>;
    // x:<extractTokenSecret("secret?expires=...")> = x:secret
    expect(headers.Authorization).toBe(`Basic ${btoa("x:secret")}`);
    expect(headers["Git-Protocol"]).toBe("version=2");
    expect(init.redirect).toBe("manual");
  });

  it("does not leak the Artifacts token in any response header", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    stubFetch(
      () =>
        new Response("PACK", {
          status: 200,
          headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
        }),
    );
    const res = await app.fetch(req(ADVERTISE), env);
    for (const [, value] of res.headers) {
      expect(value).not.toContain("secret");
    }
  });

  it("POST git-upload-pack buffers and forwards the request body", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    const fetchMock = stubFetch(
      () =>
        new Response("PACK", {
          status: 200,
          headers: { "Content-Type": "application/x-git-upload-pack-result" },
        }),
    );

    await app.fetch(
      req("/@owner/repo.git/git-upload-pack", {
        method: "POST",
        body: "0032want abc\n",
        headers: { "Content-Type": "application/x-git-upload-pack-request" },
      }),
      env,
    );

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${ARTIFACTS_REMOTE}/git-upload-pack`);
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("0032want abc\n");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-git-upload-pack-request",
    );
  });

  it("POST git-upload-pack with an empty body still proxies (0-length buffer)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    const fetchMock = stubFetch(() => new Response("PACK", { status: 200 }));
    const res = await app.fetch(req("/@owner/repo.git/git-upload-pack", { method: "POST" }), env);
    expect(res.status).toBe(200);
    const body = fetchMock.mock.calls[0]?.[1]?.body as ArrayBuffer;
    expect(body.byteLength).toBe(0);
  });

  it("maps an upstream 5xx to 502", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    stubFetch(() => new Response("boom", { status: 500 }));
    const res = await app.fetch(req(ADVERTISE), env);
    expect(res.status).toBe(502);
  });

  it("fails closed on an upstream redirect (no token-bearing follow)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    stubFetch(
      () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
    );
    const res = await app.fetch(req(ADVERTISE), env);
    expect(res.status).toBe(502);
  });
});

describe("git smart-HTTP proxy — receive-pack rejection (Task 4)", () => {
  it("POST git-receive-pack → 403 naming stratum commit, no upstream call", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req("/@owner/repo.git/git-receive-pack", { method: "POST" }), env);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("stratum commit");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("info/refs?service=git-receive-pack → 403", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    const res = await app.fetch(req("/@owner/repo.git/info/refs?service=git-receive-pack"), env);
    expect(res.status).toBe(403);
  });
});
