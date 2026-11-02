import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { isGitHttpPath } from "../src/routes/git-http";
import { updateChangeStatus } from "../src/storage/changes";
import { freshRepoToken } from "../src/storage/git-ops";
import type { Env, ProjectEntry } from "../src/types";
import { AppError } from "../src/utils/errors";
import { err } from "../src/utils/result";

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
// A soft-deleting owner (SA-8) and an agent owned by them: both must lose git access.
const DELETING_TOKEN = "stratum_user_deleting00000000000000";
const DELETING_AGENT_TOKEN = "stratum_agent_deleting0000000000000";
// An agent whose owner cannot be resolved — auth must fail closed.
const GHOST_AGENT_TOKEN = "stratum_agent_ghost000000000000000";
// A disabled owner (reversible, SCIM deprovisioning) and their agent: both must
// lose git access while disabled_at is set.
const DISABLED_TOKEN = "stratum_user_disabled00000000000000";
const DISABLED_AGENT_TOKEN = "stratum_agent_disabled0000000000000";

// The gated-push handler calls the change-flow service; mock its two entry
// points so these tests exercise the wire protocol, not the eval pipeline
// (which has its own suite via the REST route).
vi.mock("../src/services/change-flow", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/change-flow")>();
  return {
    ...actual,
    createWorkspaceFork: vi.fn(async () => ({
      success: true,
      data: {
        name: "push-abcd1234",
        remote: "https://acct.artifacts.cloudflare.net/git/@owner/push-abcd1234.git",
      },
    })),
    createChangeWithEvaluation: vi.fn(async () => ({
      success: true,
      data: {
        change: { id: "chg_push1", status: "accepted" },
        evalResult: { score: 0.9, passed: true, reason: "clean" },
        evalRuns: [],
      },
    })),
  };
});

// The gated-push submodule path closes the change it created (#258); the
// storage call is stubbed so the assertion is about WHAT the route does with
// the rejected change, not about D1.
vi.mock("../src/storage/changes", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/changes")>();
  return {
    ...actual,
    updateChangeStatus: vi.fn(async () => ({ success: true, data: undefined })),
  };
});

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === OWNER_TOKEN)
      return { success: true, data: { id: "user_owner", email: "o@x.io", username: "owner" } };
    if (token === OTHER_TOKEN)
      return { success: true, data: { id: "user_other", email: "t@x.io", username: "other" } };
    if (token === DELETING_TOKEN)
      return {
        success: true,
        data: { id: "user_owner", email: "o@x.io", username: "owner", deletingAt: "2026-01-01" },
      };
    if (token === DISABLED_TOKEN)
      return {
        success: true,
        data: { id: "user_owner", email: "o@x.io", username: "owner", disabledAt: "2026-01-01" },
      };
    return { success: false, error: { message: "not found" } };
  }),
  getUser: vi.fn(async (_db: unknown, id: string) => {
    if (id === "user_owner")
      return { success: true, data: { id, email: "o@x.io", username: "owner" } };
    if (id === "user_deleting_owner")
      return {
        success: true,
        data: { id, email: "d@x.io", username: "deleter", deletingAt: "2026-01-01" },
      };
    if (id === "user_disabled_owner")
      return {
        success: true,
        data: { id, email: "s@x.io", username: "suspended", disabledAt: "2026-01-01" },
      };
    return { success: false, error: { message: "not found" } };
  }),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(async (_db: unknown, token: string) => {
    if (token === AGENT_TOKEN)
      return { success: true, data: { id: "agent_1", ownerId: "user_owner" } };
    if (token === DELETING_AGENT_TOKEN)
      return { success: true, data: { id: "agent_2", ownerId: "user_deleting_owner" } };
    if (token === GHOST_AGENT_TOKEN)
      return { success: true, data: { id: "agent_3", ownerId: "user_ghost" } };
    if (token === DISABLED_AGENT_TOKEN)
      return { success: true, data: { id: "agent_4", ownerId: "user_disabled_owner" } };
    return { success: false, error: { message: "not found" } };
  }),
}));

// Org access is mocked so we can exercise the "org writer who is NOT the
// workspace creator" case (S1): user_other is an org writer (project write),
// user_owner is the org admin.
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
    // `delete` is real-ish so gated-push cleanup paths can run and be asserted.
    ARTIFACTS: { delete: vi.fn(async () => {}) } as unknown as Env["ARTIFACTS"],
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

const WS_REMOTE = "https://acct.artifacts.cloudflare.net/git/@owner/myws.git";

async function seedWorkspace(
  env: Env,
  name = "myws",
  remote = WS_REMOTE,
  extra: { createdByUserId?: string; createdByAgentId?: string } = {},
): Promise<void> {
  // Project id from seedProject is "proj_1"; workspace KV key is project-scoped.
  await env.STATE.put(
    `workspace:proj_1:${name}`,
    JSON.stringify({
      name,
      remote,
      parent: "proj_1",
      createdAt: new Date().toISOString(),
      ...extra,
    }),
  );
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

  it("matches workspace git endpoints", () => {
    expect(isGitHttpPath("/@owner/repo/workspaces/myws.git/info/refs")).toBe(true);
    expect(isGitHttpPath("/@owner/repo/workspaces/myws/git-upload-pack")).toBe(true);
    expect(isGitHttpPath("/@owner/repo/workspaces/myws/git-receive-pack")).toBe(true);
  });

  it("does NOT match routes that merely end in a git suffix", () => {
    // The UI blob route would otherwise lose auth/CSRF/rate-limit.
    expect(isGitHttpPath("/@owner/repo.git/blob/x/info/refs")).toBe(false);
    expect(isGitHttpPath("/@owner/repo/blob/dir/git-upload-pack")).toBe(false);
    expect(isGitHttpPath("/@owner/repo/workspaces/myws/blob/x/info/refs")).toBe(false);
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

  it("soft-deleting owner token + private → treated as anonymous (401), no upstream call", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE, { headers: basic(DELETING_TOKEN) }), env);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("agent whose owner is soft-deleting + private → treated as anonymous (401)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE, { headers: basic(DELETING_AGENT_TOKEN) }), env);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disabled owner token + private → treated as anonymous (401), no upstream call", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE, { headers: basic(DISABLED_TOKEN) }), env);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("agent whose owner is disabled + private → treated as anonymous (401)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE, { headers: basic(DISABLED_AGENT_TOKEN) }), env);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("agent whose owner cannot be resolved + private → fails closed (401)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(ADVERTISE, { headers: basic(GHOST_AGENT_TOKEN) }), env);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
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

describe("git smart-HTTP proxy — receive-pack in-protocol rejection (Task 4)", () => {
  const OID_A = "a".repeat(40);
  const OID_B = "b".repeat(40);

  function pushBody(caps: string): Uint8Array {
    const line = pktLine(`${OID_A} ${OID_B} refs/heads/main\0${caps}`);
    const flush = new TextEncoder().encode("0000");
    const out = new Uint8Array(line.byteLength + flush.byteLength);
    out.set(line, 0);
    out.set(flush, line.byteLength);
    return out;
  }

  it("POST git-receive-pack → 200 report-status with per-ref ng, pack never forwarded", async () => {
    const env = makeEnv();
    await seedProject(env);
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: pushBody("report-status"),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-git-receive-pack-result");
    const text = await res.text();
    expect(text).toContain("unpack ok\n");
    expect(text).toContain("ng refs/heads/main");
    expect(text).toContain("gated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sideband push gets remote guidance messages naming the workspace remote", async () => {
    const env = makeEnv();
    await seedProject(env);
    stubFetch(() => okUpstream());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: pushBody("report-status side-band-64k"),
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("workspaces/<ws>.git");
    expect(text).toContain("ng refs/heads/main");
  });

  it("push requires write: anonymous → 401 challenge, non-writer → 404", async () => {
    const env = makeEnv();
    await seedProject(env);
    stubFetch(() => okUpstream());
    const anon = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", { method: "POST", body: pushBody("") }),
      env,
    );
    expect(anon.status).toBe(401);
    const other = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OTHER_TOKEN),
        body: pushBody("report-status"),
      }),
      env,
    );
    expect(other.status).toBe(404);
  });

  it("malformed push body → 400, not a synthesized report", async () => {
    const env = makeEnv();
    await seedProject(env);
    stubFetch(() => okUpstream());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: "zzzz garbage",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("info/refs?service=git-receive-pack advertises for a writer (write-scoped proxy)", async () => {
    const env = makeEnv();
    await seedProject(env);
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(
      req("/@owner/repo.git/info/refs?service=git-receive-pack", { headers: basic(OWNER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("service=git-receive-pack");
    expect(vi.mocked(freshRepoToken).mock.calls[0]?.[2]).toBe("write");
  });

  it("info/refs?service=git-receive-pack challenges the anonymous caller", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    stubFetch(() => okUpstream());
    const res = await app.fetch(req("/@owner/repo.git/info/refs?service=git-receive-pack"), env);
    expect(res.status).toBe(401);
  });
});

const WS_UPLOAD_ADV = "/@owner/repo/workspaces/myws.git/info/refs?service=git-upload-pack";
const WS_RECV_ADV = "/@owner/repo/workspaces/myws.git/info/refs?service=git-receive-pack";
const WS_RECV = "/@owner/repo/workspaces/myws.git/git-receive-pack";
const WS_UPLOAD = "/@owner/repo/workspaces/myws.git/git-upload-pack";

// A correctly framed receive-pack body: command pkt-lines, flush, then (fake)
// pack bytes. The workspace proxy now parses the command section (S3), so
// tests that expect a FORWARDED push must send a body that passes the policy.
const OID_X = "a".repeat(40);
const OID_Y = "b".repeat(40);
const ZERO_OID = "0".repeat(40);

/** pkt-line framing: 4-byte hex length prefix (inclusive) + payload. */
function pktLine(payload: string): Uint8Array {
  const data = new TextEncoder().encode(payload);
  const header = new TextEncoder().encode((data.byteLength + 4).toString(16).padStart(4, "0"));
  const out = new Uint8Array(data.byteLength + 4);
  out.set(header, 0);
  out.set(data, 4);
  return out;
}

function wsPushBody(lines: string[], pack = "PACKDATA"): Uint8Array {
  const parts = lines.map((l) => pktLine(l));
  parts.push(new TextEncoder().encode("0000"));
  parts.push(new TextEncoder().encode(pack));
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const WS_MAIN_PUSH = wsPushBody([`${OID_X} ${OID_Y} refs/heads/main\0report-status`]);

describe("git smart-HTTP proxy — workspace clone+push (Phase A)", () => {
  it("anonymous clone of a workspace in a public project → proxied (200)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    await seedWorkspace(env);
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(WS_UPLOAD_ADV), env);
    expect(res.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${WS_REMOTE}/info/refs?service=git-upload-pack`);
    expect(vi.mocked(freshRepoToken)).toHaveBeenCalledWith(
      expect.anything(),
      WS_REMOTE,
      "read",
      expect.anything(),
    );
  });

  it("receive-pack advertise requires auth: anonymous → 401 challenge", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    await seedWorkspace(env);
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(req(WS_RECV_ADV), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="Stratum"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("owner push → proxied to the workspace fork with a WRITE token, body forwarded", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    await seedWorkspace(env);
    const fetchMock = stubFetch(
      () =>
        new Response("000eunpack ok\n0000", {
          status: 200,
          headers: { "Content-Type": "application/x-git-receive-pack-result" },
        }),
    );
    const res = await app.fetch(
      req(WS_RECV, {
        method: "POST",
        body: WS_MAIN_PUSH,
        headers: {
          ...basic(OWNER_TOKEN),
          "Content-Type": "application/x-git-receive-pack-request",
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${WS_REMOTE}/git-receive-pack`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${btoa("x:secret")}`,
    );
    // The ORIGINAL body is forwarded byte-for-byte (parse-only inspection).
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(WS_MAIN_PUSH);
    expect(vi.mocked(freshRepoToken)).toHaveBeenCalledWith(
      expect.anything(),
      WS_REMOTE,
      "write",
      expect.anything(),
    );
  });

  it("agent owned by the project owner can push (200)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    await seedWorkspace(env);
    stubFetch(() => okUpstream());
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: WS_MAIN_PUSH, headers: basic(AGENT_TOKEN) }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("non-owner push → 404 (no leak), no upstream call", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    await seedWorkspace(env);
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: "PACK", headers: basic(OTHER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("anonymous push → 401 challenge", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    await seedWorkspace(env);
    const res = await app.fetch(req(WS_RECV, { method: "POST", body: "PACK" }), env);
    expect(res.status).toBe(401);
  });

  it("push to a missing workspace → 404", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    // no workspace seeded
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: "PACK", headers: basic(OWNER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("non-Artifacts workspace remote → 501 (post-authorization)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    await seedWorkspace(env, "myws", "https://github.com/foo/bar.git");
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: "PACK", headers: basic(OWNER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(501);
  });

  it("unknown service on workspace info/refs → 400", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    await seedWorkspace(env);
    const res = await app.fetch(req("/@owner/repo/workspaces/myws.git/info/refs"), env);
    expect(res.status).toBe(400);
  });

  it("workspace clone RPC uses a read token", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    await seedWorkspace(env);
    const fetchMock = stubFetch(() => okUpstream());
    await app.fetch(req(WS_UPLOAD, { method: "POST", body: "0000" }), env);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${WS_REMOTE}/git-upload-pack`);
    expect(vi.mocked(freshRepoToken)).toHaveBeenCalledWith(
      expect.anything(),
      WS_REMOTE,
      "read",
      expect.anything(),
    );
  });
});

describe("git smart-HTTP proxy — workspace read/write asymmetry & passthrough", () => {
  it("a reader (non-owner, public project) can clone the workspace but cannot push", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    await seedWorkspace(env);
    stubFetch(() => okUpstream());
    // canReadProject(public) → true for any caller; canWriteProject(non-owner) → false.
    const clone = await app.fetch(req(WS_UPLOAD_ADV, { headers: basic(OTHER_TOKEN) }), env);
    expect(clone.status).toBe(200);

    const fetchMock = stubFetch(() => okUpstream());
    const push = await app.fetch(
      req(WS_RECV, { method: "POST", body: "PACK", headers: basic(OTHER_TOKEN) }),
      env,
    );
    expect(push.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams Artifacts' rejecting (ng) report-status back verbatim", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    await seedWorkspace(env);
    const ngBody = "000eunpack ok\n0026ng refs/heads/main non-fast-forward\n0000";
    stubFetch(
      () =>
        new Response(ngBody, {
          status: 200,
          headers: { "Content-Type": "application/x-git-receive-pack-result" },
        }),
    );
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: WS_MAIN_PUSH, headers: basic(OWNER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(200);
    // We must NOT synthesize outcomes — the client sees Artifacts' verdict unchanged.
    expect(await res.text()).toBe(ngBody);
  });

  it("receive-pack with an empty body still proxies (0-length buffer)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    await seedWorkspace(env);
    const fetchMock = stubFetch(() => new Response("000eunpack ok\n0000", { status: 200 }));
    const res = await app.fetch(req(WS_RECV, { method: "POST", headers: basic(OWNER_TOKEN) }), env);
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init.body as ArrayBuffer).byteLength).toBe(0);
  });
});

// S3 (#130): the workspace proxy no longer forwards a push blind — the pkt-line
// command list is parsed and held to a ref policy first.
describe("git smart-HTTP proxy — workspace push ref policy (S3)", () => {
  async function policyEnv(extra: { branchName?: string } = {}): Promise<Env> {
    const env = makeEnv();
    await seedProject(env, { visibility: "private" });
    await env.STATE.put(
      "workspace:proj_1:myws",
      JSON.stringify({
        name: "myws",
        remote: WS_REMOTE,
        parent: "proj_1",
        createdAt: new Date().toISOString(),
        ...extra,
      }),
    );
    return env;
  }

  async function push(
    env: Env,
    body: BodyInit,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return app.fetch(
      req(WS_RECV, { method: "POST", body, headers: { ...basic(OWNER_TOKEN), ...headers } }),
      env,
    );
  }

  it("refuses a ref DELETE in-protocol; the pack never reaches upstream", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(
      env,
      wsPushBody([`${OID_Y} ${ZERO_OID} refs/heads/main\0report-status`]),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-git-receive-pack-result");
    const text = await res.text();
    expect(text).toContain("unpack ok\n");
    expect(text).toContain("ng refs/heads/main");
    expect(text).toContain("deletion");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a push to a ref outside the workspace branch (refs/heads/other)", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, wsPushBody([`${OID_X} ${OID_Y} refs/heads/other\0report-status`]));
    const text = await res.text();
    expect(text).toContain("ng refs/heads/other");
    expect(text).toContain("only the workspace branch");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // #182 shipped tag pushes to a workspace fork as a verbatim proxy before this
  // policy existed; the policy must not revoke it. Deletion stays refused.
  it("forwards tag pushes (refs/tags/*) to the fork", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, wsPushBody([`${OID_X} ${OID_Y} refs/tags/v1\0report-status`]));
    expect(await res.text()).not.toContain("ng refs/tags/v1");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("refuses a tag DELETION", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, wsPushBody([`${OID_X} ${ZERO_OID} refs/tags/v1\0report-status`]));
    expect(await res.text()).toContain("ng refs/tags/v1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a multi-command push when ANY command is off-policy (all ng)", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(
      env,
      wsPushBody([
        `${OID_X} ${OID_Y} refs/heads/main\0report-status`,
        `${OID_X} ${OID_Y} refs/heads/evil`,
      ]),
    );
    const text = await res.text();
    expect(text).toContain("ng refs/heads/main");
    expect(text).toContain("ng refs/heads/evil");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the workspace's own branch name (refs/heads/myws) as well as main", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, wsPushBody([`${OID_X} ${OID_Y} refs/heads/myws\0report-status`]));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("a forced update (rewritten old-oid) on the working branch is still allowed", async () => {
    // Ownership is already enforced; force-push on the owner's own fork stays legal.
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, wsPushBody([`${OID_Y} ${OID_X} refs/heads/main\0report-status`]));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses branchName (not name) when the entry records one", async () => {
    const env = await policyEnv({ branchName: "custom-branch" });
    const fetchMock = stubFetch(() => okUpstream());
    const ok = await push(
      env,
      wsPushBody([`${OID_X} ${OID_Y} refs/heads/custom-branch\0report-status`]),
    );
    expect(ok.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();

    const bad = await push(env, wsPushBody([`${OID_X} ${OID_Y} refs/heads/myws\0report-status`]));
    expect(await bad.text()).toContain("ng refs/heads/myws");
    expect(fetchMock).toHaveBeenCalledOnce(); // still just the first call
  });

  it("a sideband-negotiating push gets a sideband-framed refusal", async () => {
    const env = await policyEnv();
    stubFetch(() => okUpstream());
    const res = await push(
      env,
      wsPushBody([`${OID_Y} ${ZERO_OID} refs/heads/main\0report-status side-band-64k`]),
    );
    const text = await res.text();
    expect(text).toContain("working branch");
    expect(text).toContain("ng refs/heads/main");
  });

  it("garbage (non-pkt) body → 400, never forwarded (was proxied verbatim before)", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, "PACKDATA-not-pkt-framed");
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("truncated command section → 400", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    // A single command pkt-line with NO flush terminator.
    const res = await push(env, pktLine(`${OID_X} ${OID_Y} refs/heads/main`));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The gzip/deflate branch stops inflating at MAX_COMMAND_SECTION_BYTES (1 MiB).
  // The identity branch used to hand the parser the WHOLE body, so the budget
  // bound every compressing client and no one else. With both capped, a command
  // section that runs past 1 MiB before its flush-pkt is truncated out of view
  // and fails closed — the same answer the compressed path already gave.
  it("uncompressed body: a command section past the 1 MiB budget fails closed", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    // ~1.1 MiB of otherwise-ALLOWED commands, with the flush-pkt beyond the cap.
    const line = `${OID_X} ${OID_Y} refs/heads/main`;
    const count = Math.ceil((1024 * 1024 * 11) / 10 / (line.length + 4));
    const res = await push(env, wsPushBody(Array.from({ length: count }, () => line)));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gzip body: commands are inspected and the COMPRESSED bytes are forwarded", async () => {
    const { gzipSync } = await import("node:zlib");
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const compressed = gzipSync(WS_MAIN_PUSH);
    const res = await push(env, new Uint8Array(compressed), { "Content-Encoding": "gzip" });
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Uint8Array(init.body as ArrayBuffer)).toEqual(new Uint8Array(compressed));
    expect((init.headers as Record<string, string>)["Content-Encoding"]).toBe("gzip");
  });

  it("gzip cannot smuggle an off-policy command past the parser", async () => {
    const { gzipSync } = await import("node:zlib");
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const body = gzipSync(wsPushBody([`${OID_Y} ${ZERO_OID} refs/heads/main\0report-status`]));
    const res = await push(env, new Uint8Array(body), { "Content-Encoding": "gzip" });
    expect(await res.text()).toContain("deletion");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deflate body is inspected too", async () => {
    const { deflateSync } = await import("node:zlib");
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, new Uint8Array(deflateSync(WS_MAIN_PUSH)), {
      "Content-Encoding": "deflate",
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // `Content-Encoding: deflate` is zlib-wrapped per RFC 9110, but clients in the
  // wild send RAW deflate under the same name. DecompressionStream("deflate")
  // throws on those, and this route fails closed, so a legitimate push was
  // refused as unreadable until the raw format was tried as a fallback.
  it("RAW deflate body is inspected too, not refused as unreadable", async () => {
    const { deflateRawSync } = await import("node:zlib");
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, new Uint8Array(deflateRawSync(WS_MAIN_PUSH)), {
      "Content-Encoding": "deflate",
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("raw deflate cannot smuggle an off-policy command past the parser either", async () => {
    const { deflateRawSync } = await import("node:zlib");
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const body = deflateRawSync(
      wsPushBody([`${OID_Y} ${ZERO_OID} refs/heads/main\0report-status`]),
    );
    const res = await push(env, new Uint8Array(body), { "Content-Encoding": "deflate" });
    expect(await res.text()).toContain("deletion");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unknown Content-Encoding fails closed (400), never forwarded", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, WS_MAIN_PUSH, { "Content-Encoding": "br" });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("corrupt gzip fails closed (400), never forwarded", async () => {
    const env = await policyEnv();
    const fetchMock = stubFetch(() => okUpstream());
    const res = await push(env, new Uint8Array([0x1f, 0x8b, 0x00, 0x01, 0x02]), {
      "Content-Encoding": "gzip",
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a PROJECT push with an unknown Content-Encoding fails closed (400)", async () => {
    const env = makeEnv();
    await seedProject(env);
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: { ...basic(OWNER_TOKEN), "Content-Encoding": "br" },
        body: WS_MAIN_PUSH,
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a gzipped PROJECT push is decoded before gating too", async () => {
    const { gzipSync } = await import("node:zlib");
    const env = makeEnv(); // flag off → in-protocol refusal proves the parse worked
    await seedProject(env);
    stubFetch(() => okUpstream());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: { ...basic(OWNER_TOKEN), "Content-Encoding": "gzip" },
        body: new Uint8Array(gzipSync(WS_MAIN_PUSH)),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("project pushes are gated");
  });
});

// S1: within a project many principals may hold project-level write, but a
// workspace fork belongs to its creator. Push must be gated per-workspace.
// Keep the URL namespace (@owner/repo) so getProjectByPath resolves; only flip
// the ownership to org so org access levels drive the authz.
const ORG_OVERRIDES = { ownerId: "org_1", ownerType: "org" as const };

describe("git smart-HTTP proxy — workspace write ownership (S1)", () => {
  it("a project-writer who did NOT create the workspace is DENIED (404, no leak)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private", ...ORG_OVERRIDES });
    // Workspace created by user_owner; user_other has org write but is not creator.
    await seedWorkspace(env, "myws", WS_REMOTE, { createdByUserId: "user_owner" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: "PACK", headers: basic(OTHER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the creator IS allowed to push their own workspace", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private", ...ORG_OVERRIDES });
    // Workspace created by user_other (an org writer, not an admin).
    await seedWorkspace(env, "myws", WS_REMOTE, { createdByUserId: "user_other" });
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: WS_MAIN_PUSH, headers: basic(OTHER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("a project admin (org admin) may push any workspace they did not create", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private", ...ORG_OVERRIDES });
    // Created by user_other; user_owner is the org admin (override).
    await seedWorkspace(env, "myws", WS_REMOTE, { createdByUserId: "user_other" });
    stubFetch(() => okUpstream());
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: WS_MAIN_PUSH, headers: basic(OWNER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("an agent whose owner created the workspace IS allowed (shared principal)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private", ...ORG_OVERRIDES });
    // agent_1 is owned by user_owner; the workspace records user_owner as creator.
    await seedWorkspace(env, "myws", WS_REMOTE, { createdByUserId: "user_owner" });
    stubFetch(() => okUpstream());
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: WS_MAIN_PUSH, headers: basic(AGENT_TOKEN) }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("legacy workspace (no creator) + non-admin project-writer → DENIED", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private", ...ORG_OVERRIDES });
    // No createdByUserId → fail closed to admins only; user_other is a writer.
    await seedWorkspace(env, "myws", WS_REMOTE);
    const fetchMock = stubFetch(() => okUpstream());
    const res = await app.fetch(
      req(WS_RECV, { method: "POST", body: "PACK", headers: basic(OTHER_TOKEN) }),
      env,
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a non-creator writer can still CLONE (read is unaffected)", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "private", ...ORG_OVERRIDES });
    await seedWorkspace(env, "myws", WS_REMOTE, { createdByUserId: "user_owner" });
    stubFetch(() => okUpstream());
    const res = await app.fetch(req(WS_UPLOAD_ADV, { headers: basic(OTHER_TOKEN) }), env);
    expect(res.status).toBe(200);
  });
});

// ── Gated push (ADR 005 slice 2b, GIT_PUSH_GATED_ENABLED) ────────────────────

import { createChangeWithEvaluation, createWorkspaceFork } from "../src/services/change-flow";

describe("git smart-HTTP proxy — gated push (slice 2b)", () => {
  const OID_A = "a".repeat(40);
  const OID_B = "b".repeat(40);
  const ZEROS = "0".repeat(40);

  function pushBody(lines: string[]): Uint8Array {
    const parts = lines.map((l) => pktLine(l));
    const flush = new TextEncoder().encode("0000");
    const total = parts.reduce((n, p) => n + p.byteLength, 0) + flush.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    out.set(flush, off);
    return out;
  }

  const MAIN_PUSH = pushBody([`${OID_A} ${OID_B} refs/heads/main\0report-status`]);

  function gatedEnv(): Env {
    return { ...makeEnv(), GIT_PUSH_GATED_ENABLED: "true" } as Env;
  }

  function upstreamPushOk(): Response {
    return new Response("000eunpack ok\n0000", {
      status: 200,
      headers: { "Content-Type": "application/x-git-receive-pack-result" },
    });
  }

  it("routes a main push through fork → land pack → change, answering a truthful ng", async () => {
    const env = gatedEnv();
    await seedProject(env);
    const fetchMock = stubFetch(() => upstreamPushOk());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    // Truthful outcome: main did not move, so the ref reports ng…
    expect(text).toContain("ng refs/heads/main");
    // …but the reason carries the created change and its verdict.
    expect(text).toContain("chg_push1");
    expect(text).toContain("eval passed");

    // The pack was forwarded to the fork's receive-pack, not the project's.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://acct.artifacts.cloudflare.net/git/@owner/push-abcd1234.git/git-receive-pack",
    );
    expect(vi.mocked(createWorkspaceFork)).toHaveBeenCalledTimes(1);
    const forkArgs = vi.mocked(createWorkspaceFork).mock.calls[0]?.[2];
    expect(forkArgs?.workspaceName).toMatch(/^push-[0-9a-f-]{36}$/);
    expect(forkArgs?.actor.userId).toBe("user_owner");

    const changeArgs = vi.mocked(createChangeWithEvaluation).mock.calls[0]?.[2];
    expect(changeArgs?.projectName).toBe("@owner/repo");
    expect(changeArgs?.workspaceRemote).toContain("push-abcd1234");
  });

  it("an agent push carries the agent identity into the change flow", async () => {
    const env = gatedEnv();
    await seedProject(env);
    stubFetch(() => upstreamPushOk());
    await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(AGENT_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    const changeArgs = vi.mocked(createChangeWithEvaluation).mock.calls[0]?.[2];
    expect(changeArgs?.actor.agentId).toBe("agent_1");
    expect(changeArgs?.actor.userId).toBeUndefined();
  });

  it("refuses multi-ref pushes even with the flag on", async () => {
    const env = gatedEnv();
    await seedProject(env);
    const fetchMock = stubFetch(() => upstreamPushOk());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: pushBody([
          `${OID_A} ${OID_B} refs/heads/main\0report-status`,
          `${OID_A} ${OID_B} refs/heads/dev`,
        ]),
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("only a single push to refs/heads/main");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(createWorkspaceFork)).not.toHaveBeenCalled();
  });

  it("refuses a ref deletion even with the flag on", async () => {
    const env = gatedEnv();
    await seedProject(env);
    stubFetch(() => upstreamPushOk());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: pushBody([`${OID_A} ${ZEROS} refs/heads/main\0report-status`]),
      }),
      env,
    );
    expect(await res.text()).toContain("only a single push to refs/heads/main");
    expect(vi.mocked(createWorkspaceFork)).not.toHaveBeenCalled();
  });

  it("relays the workspace remote's own rejection verbatim and cleans up the fork", async () => {
    const env = gatedEnv();
    await seedProject(env);
    // Correctly framed report-status: "unpack ok\n" (14=0x000e) and the 40-byte
    // (0x0028) ng line — the handler now PARSES this instead of substring-scanning.
    stubFetch(
      () =>
        new Response("000eunpack ok\n0028ng refs/heads/main non-fast-forward\n0000", {
          status: 200,
          headers: { "Content-Type": "application/x-git-receive-pack-result" },
        }),
    );
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("non-fast-forward");
    expect(vi.mocked(createChangeWithEvaluation)).not.toHaveBeenCalled();
    // The pack never landed as a change, so the empty fork must not leak —
    // both the Artifacts repo and the workspace KV entry go.
    expect(vi.mocked(env.ARTIFACTS.delete)).toHaveBeenCalledWith("push-abcd1234");
    expect(await env.STATE.get("workspace:proj_1:push-abcd1234")).toBeNull();
  });

  it("treats a sideband success reply with 'Counting objects' progress as success (regression)", async () => {
    const env = gatedEnv();
    await seedProject(env);
    // Sideband-framed success: band-2 progress whose text contains "ng "
    // ("Counting objects…") plus a band-1 status stream. The old substring
    // scan misread this as a rejection after the pack had already landed.
    function pkt(payload: Uint8Array): Uint8Array {
      const header = new TextEncoder().encode(
        (payload.byteLength + 4).toString(16).padStart(4, "0"),
      );
      const out = new Uint8Array(payload.byteLength + 4);
      out.set(header, 0);
      out.set(payload, 4);
      return out;
    }
    function band(b: number, text: string): Uint8Array {
      const data = new TextEncoder().encode(text);
      const framed = new Uint8Array(data.byteLength + 1);
      framed[0] = b;
      framed.set(data, 1);
      return pkt(framed);
    }
    const status = "000eunpack ok\n0017ok refs/heads/main\n0000";
    const statusBytes = new TextEncoder().encode(status);
    const statusFrame = new Uint8Array(statusBytes.byteLength + 1);
    statusFrame[0] = 1;
    statusFrame.set(statusBytes, 1);
    const bodyParts = [
      band(2, "Counting objects: 100% (3/3), done.\n"),
      pkt(statusFrame),
      new TextEncoder().encode("0000"),
    ];
    const total = bodyParts.reduce((n, p) => n + p.byteLength, 0);
    const upstreamBody = new Uint8Array(total);
    let off = 0;
    for (const p of bodyParts) {
      upstreamBody.set(p, off);
      off += p.byteLength;
    }
    stubFetch(
      () =>
        new Response(upstreamBody, {
          status: 200,
          headers: { "Content-Type": "application/x-git-receive-pack-result" },
        }),
    );
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    const text = await res.text();
    // The pack landed → the change flow ran and reported its id.
    expect(text).toContain("chg_push1");
    expect(vi.mocked(createChangeWithEvaluation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(env.ARTIFACTS.delete)).not.toHaveBeenCalled();
  });

  it("preserves the fork when an HTTP 200 report-status cannot be parsed", async () => {
    const env = gatedEnv();
    await seedProject(env);
    // HTTP 200 with an unknown status line: Artifacts processed the request,
    // so the pack may have landed — deleting the fork could destroy commits.
    stubFetch(
      () =>
        new Response("000eunpack ok\n0017weird refs/heads/x\n0000", {
          status: 200,
          headers: { "Content-Type": "application/x-git-receive-pack-result" },
        }),
    );
    // Pre-seed the fork's KV entry (createWorkspaceFork is mocked, so the
    // real registration never runs) to prove cleanup leaves BOTH resources.
    await seedWorkspace(
      env,
      "push-abcd1234",
      "https://acct.artifacts.cloudflare.net/git/@owner/push-abcd1234.git",
    );
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(env.ARTIFACTS.delete)).not.toHaveBeenCalled();
    expect(await env.STATE.get("workspace:proj_1:push-abcd1234")).not.toBeNull();
    expect(vi.mocked(createChangeWithEvaluation)).not.toHaveBeenCalled();
  });

  it("names the stuck change when post-creation processing fails with a changeId", async () => {
    const env = gatedEnv();
    await seedProject(env);
    stubFetch(() => upstreamPushOk());
    // A real AppError (not a shape-alike cast) so the test binds to the same
    // context contract createChangeWithEvaluation actually produces.
    vi.mocked(createChangeWithEvaluation).mockResolvedValueOnce(
      err(
        new AppError("record eval runs failed", "DATABASE_ERROR", 500, {
          changeId: "chg_stuck1",
        }),
      ),
    );
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    const text = await res.text();
    // The existing change is named so the pusher re-evaluates it, not duplicates it.
    expect(text).toContain("chg_stuck1");
    expect(text).toContain("re-evaluate");
    expect(vi.mocked(env.ARTIFACTS.delete)).not.toHaveBeenCalled();
  });

  it("rejects a push with a permanent, non-re-evaluate message for unsupported submodule content (#258)", async () => {
    const env = gatedEnv();
    await seedProject(env);
    stubFetch(() => upstreamPushOk());
    vi.mocked(createChangeWithEvaluation).mockResolvedValueOnce(
      err(
        new AppError(
          "Repository uses git submodules (found gitlink entry at vendor/lib), which Stratum does not support yet. Remove submodules and retry.",
          "SUBMODULES_UNSUPPORTED",
          400,
          { changeId: "chg_stuck_submodule" },
        ),
      ),
    );
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("push rejected");
    expect(text).toContain("git submodules");
    // Unlike a transient processing failure, this is permanent -- the pusher
    // must not be told to re-evaluate a change that can never pass.
    expect(text).not.toContain("re-evaluate");
  });

  it("leaves no orphaned change or workspace behind when submodules are rejected (#258)", async () => {
    // The change row already exists when the submodule scan rejects, so a bare
    // refusal would strand an open change, a workspace entry and an Artifacts
    // fork -- one full set per retried push.
    const env = gatedEnv();
    await seedProject(env);
    await seedWorkspace(
      env,
      "push-abcd1234",
      "https://acct.artifacts.cloudflare.net/git/@owner/push-abcd1234.git",
    );
    stubFetch(() => upstreamPushOk());
    vi.mocked(createChangeWithEvaluation).mockResolvedValueOnce(
      err(
        new AppError(
          "Repository uses git submodules (found gitlink entry at vendor/lib), which Stratum does not support yet. Remove submodules and retry.",
          "SUBMODULES_UNSUPPORTED",
          400,
          { changeId: "chg_stuck_submodule" },
        ),
      ),
    );

    await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );

    // The change is closed rather than left open in the owner's queue.
    expect(vi.mocked(updateChangeStatus)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "chg_stuck_submodule",
      "rejected",
      expect.objectContaining({ evalPassed: false }),
    );
    // …and the fork + workspace entry it was created from are released.
    expect(vi.mocked(env.ARTIFACTS.delete)).toHaveBeenCalledWith("push-abcd1234");
    expect(await env.STATE.get("workspace:proj_1:push-abcd1234")).toBeNull();
  });

  it("cleans up the fork when the upstream transport fails", async () => {
    const env = gatedEnv();
    await seedProject(env);
    stubFetch(() => new Response("boom", { status: 500 }));
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("upstream git error");
    expect(vi.mocked(env.ARTIFACTS.delete)).toHaveBeenCalledWith("push-abcd1234");
    expect(vi.mocked(createChangeWithEvaluation)).not.toHaveBeenCalled();
  });

  it("gates the push against the project's actual default branch, not literal main", async () => {
    const env = gatedEnv();
    await seedProject(env, { sourceDefaultBranch: "trunk" });
    const fetchMock = stubFetch(() => upstreamPushOk());

    // A push to refs/heads/main is NOT the default branch here → refused, named.
    const mainRes = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    expect(await mainRes.text()).toContain("only a single push to refs/heads/trunk");
    expect(fetchMock).not.toHaveBeenCalled();

    // A push to refs/heads/trunk IS gated.
    const trunkRes = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: pushBody([`${OID_A} ${OID_B} refs/heads/trunk\0report-status`]),
      }),
      env,
    );
    const text = await trunkRes.text();
    expect(text).toContain("ng refs/heads/trunk");
    expect(text).toContain("chg_push1");
    expect(vi.mocked(createChangeWithEvaluation)).toHaveBeenCalledTimes(1);
  });

  it("preserves the workspace pointer when change creation fails after the pack landed", async () => {
    const env = gatedEnv();
    await seedProject(env);
    stubFetch(() => upstreamPushOk());
    vi.mocked(createChangeWithEvaluation).mockResolvedValueOnce(
      err(new AppError("db unavailable", "DATABASE_ERROR", 400)),
    );
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("change creation failed");
    expect(text).toContain("push-abcd1234");
    // The pack DID land: the workspace holds the user's commits and must survive.
    expect(vi.mocked(env.ARTIFACTS.delete)).not.toHaveBeenCalled();
  });

  it("flag off → the plain in-protocol refusal, no fork", async () => {
    const env = makeEnv(); // no GIT_PUSH_GATED_ENABLED
    await seedProject(env);
    stubFetch(() => upstreamPushOk());
    const res = await app.fetch(
      req("/@owner/repo.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: MAIN_PUSH,
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("project pushes are gated");
    expect(vi.mocked(createWorkspaceFork)).not.toHaveBeenCalled();
  });
});
