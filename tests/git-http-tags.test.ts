import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env, ProjectEntry } from "../src/types";

// Tag behavior over the git smart-HTTP proxy (#182):
//  - READ: info/refs and upload-pack are proxied to Artifacts unfiltered, so
//    refs/tags/* advertised upstream reach the client byte-identically and tag
//    objects are fetchable. Proven below against a realistic advertisement.
//  - WRITE (project remote): a push touching refs/tags/* is refused in-protocol
//    with a tag-specific reason — the change gate cannot represent a tag.
//  - WRITE (workspace remote): proxied verbatim; tags land on the fork.

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    freshRepoToken: vi.fn(async () => ({ success: true, data: "secret?expires=9999999999" })),
  };
});

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

import { createWorkspaceFork } from "../src/services/change-flow";

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

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    ARTIFACTS: { delete: vi.fn(async () => {}) } as unknown as Env["ARTIFACTS"],
    STATE: makeKV(),
    DB: {} as D1Database,
    ...extra,
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

async function seedWorkspace(env: Env): Promise<void> {
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

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init);
}

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

let originalFetch: typeof fetch;

function stubFetch(impl: (url: string, init: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
    impl(String(input), init),
  );
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── pkt-line helpers ─────────────────────────────────────────────────────────

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);
const OID_TAG = "c".repeat(40);
const ZEROS = "0".repeat(40);

function pktLine(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

/** Real receive-pack framing: every command line ends with LF, and capabilities
 * ride on the FIRST command only. Building it correctly keeps these fixtures from
 * passing on parser tolerance that a real client would never exercise. */
function pushBody(lines: string[]): Uint8Array {
  return new TextEncoder().encode(
    `${lines
      .map((line, index) => pktLine(`${line}${index === 0 ? "\0report-status" : ""}\n`))
      .join("")}0000`,
  );
}

function singleRefPush(oldOid: string, newOid: string, ref: string): Uint8Array {
  return pushBody([`${oldOid} ${newOid} ${ref}`]);
}

/** A realistic upload-pack advertisement carrying branch AND tag refs (with the
 * peeled ^{} entry an annotated tag advertises). */
const TAG_ADVERTISEMENT = [
  pktLine("# service=git-upload-pack\n"),
  "0000",
  pktLine(`${OID_A} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/main\n`),
  pktLine(`${OID_A} refs/heads/main\n`),
  pktLine(`${OID_TAG} refs/tags/v1.0.0\n`),
  pktLine(`${OID_B} refs/tags/v1.0.0^{}\n`),
  pktLine(`${OID_B} refs/tags/v0.9.0\n`),
  "0000",
].join("");

const ADVERTISE = "/@owner/repo.git/info/refs?service=git-upload-pack";

describe("smart-HTTP tag READS pass through the proxy unfiltered", () => {
  it("advertises refs/tags/* byte-identically to the upstream advertisement", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    stubFetch(
      () =>
        new Response(TAG_ADVERTISEMENT, {
          status: 200,
          headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
        }),
    );

    const res = await app.fetch(req(ADVERTISE), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The proxy performs no ref filtering: annotated tag, its peeled entry, and
    // the lightweight tag all reach the client exactly as Artifacts sent them.
    expect(body).toBe(TAG_ADVERTISEMENT);
    expect(body).toContain("refs/tags/v1.0.0");
    expect(body).toContain("refs/tags/v1.0.0^{}");
    expect(body).toContain("refs/tags/v0.9.0");
  });

  it("forwards an upload-pack request wanting a tag oid verbatim", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    const fetchMock = stubFetch(
      () =>
        new Response("PACKDATA", {
          status: 200,
          headers: { "Content-Type": "application/x-git-upload-pack-result" },
        }),
    );

    const want = `${pktLine(`want ${OID_TAG} side-band-64k\n`)}0000${pktLine("done\n")}`;
    const res = await app.fetch(
      req("/@owner/repo.git/git-upload-pack", {
        method: "POST",
        body: want,
        headers: { "Content-Type": "application/x-git-upload-pack-request" },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PACKDATA");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${ARTIFACTS_REMOTE}/git-upload-pack`);
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toContain(`want ${OID_TAG}`);
  });

  it("workspace advertisement passes tags through too", async () => {
    const env = makeEnv();
    await seedProject(env, { visibility: "public" });
    await seedWorkspace(env);
    stubFetch(
      () =>
        new Response(TAG_ADVERTISEMENT, {
          status: 200,
          headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
        }),
    );
    const res = await app.fetch(
      req("/@owner/repo/workspaces/myws.git/info/refs?service=git-upload-pack"),
      env,
    );
    expect(await res.text()).toBe(TAG_ADVERTISEMENT);
  });
});

describe("project-remote tag PUSH policy: explicit in-protocol refusal", () => {
  const RECV = "/@owner/repo.git/git-receive-pack";

  it("refuses a tag creation with a tag-specific ng and guidance (gated flag on)", async () => {
    const env = makeEnv({ GIT_PUSH_GATED_ENABLED: "true" } as Partial<Env>);
    await seedProject(env);
    const fetchMock = stubFetch(() => new Response("nope", { status: 500 }));

    const res = await app.fetch(
      req(RECV, {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: singleRefPush(ZEROS, OID_TAG, "refs/tags/v1.0.0"),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-git-receive-pack-result");
    const text = await res.text();
    expect(text).toContain("unpack ok\n");
    expect(text).toContain("ng refs/tags/v1.0.0");
    expect(text).toContain("tag pushes to the project remote are not supported");
    // Never the misleading branch-gate guidance, never a fork, never upstream.
    expect(text).not.toContain("only a single push to refs/heads/main");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.mocked(createWorkspaceFork)).not.toHaveBeenCalled();
  });

  it("refuses the same way with the gated flag OFF", async () => {
    const env = makeEnv();
    await seedProject(env);
    stubFetch(() => new Response("nope", { status: 500 }));
    const res = await app.fetch(
      req(RECV, {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: singleRefPush(ZEROS, OID_TAG, "refs/tags/v1.0.0"),
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("tag pushes to the project remote are not supported");
    expect(text).not.toContain("project pushes are gated");
  });

  it("a mixed main+tag push is refused for BOTH refs with the tag reason", async () => {
    const env = makeEnv({ GIT_PUSH_GATED_ENABLED: "true" } as Partial<Env>);
    await seedProject(env);
    stubFetch(() => new Response("nope", { status: 500 }));
    const res = await app.fetch(
      req(RECV, {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: pushBody([
          `${OID_A} ${OID_B} refs/heads/main`,
          `${ZEROS} ${OID_TAG} refs/tags/v1.0.0`,
        ]),
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("ng refs/heads/main");
    expect(text).toContain("ng refs/tags/v1.0.0");
    expect(text).toContain("tag pushes to the project remote are not supported");
    expect(vi.mocked(createWorkspaceFork)).not.toHaveBeenCalled();
  });

  it("a tag DELETION is refused with the same tag-specific reason", async () => {
    const env = makeEnv({ GIT_PUSH_GATED_ENABLED: "true" } as Partial<Env>);
    await seedProject(env);
    stubFetch(() => new Response("nope", { status: 500 }));
    const res = await app.fetch(
      req(RECV, {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: singleRefPush(OID_TAG, ZEROS, "refs/tags/v1.0.0"),
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("ng refs/tags/v1.0.0");
    expect(text).toContain("tag pushes to the project remote are not supported");
  });

  it("names the workspace remote in the guidance", async () => {
    const env = makeEnv();
    await seedProject(env);
    stubFetch(() => new Response("nope", { status: 500 }));
    const res = await app.fetch(
      req(RECV, {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        // side-band-64k so guidance is streamed as remote: lines
        body: new TextEncoder().encode(
          `${pktLine(`${ZEROS} ${OID_TAG} refs/tags/v1.0.0\0report-status side-band-64k\n`)}0000`,
        ),
      }),
      env,
    );
    const text = await res.text();
    expect(text).toContain("workspaces/<ws>.git");
  });
});

describe("workspace-remote tag pushes proxy verbatim (unchanged)", () => {
  it("forwards a tag push to the fork and relays its report-status", async () => {
    const env = makeEnv();
    await seedProject(env);
    await seedWorkspace(env);
    const upstreamReport = "000eunpack ok\n0019ok refs/tags/v1.0.0\n0000";
    const fetchMock = stubFetch(
      () =>
        new Response(upstreamReport, {
          status: 200,
          headers: { "Content-Type": "application/x-git-receive-pack-result" },
        }),
    );

    const res = await app.fetch(
      req("/@owner/repo/workspaces/myws.git/git-receive-pack", {
        method: "POST",
        headers: basic(OWNER_TOKEN),
        body: singleRefPush(ZEROS, OID_TAG, "refs/tags/v1.0.0"),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(upstreamReport);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${WS_REMOTE}/git-receive-pack`);
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toContain("refs/tags/v1.0.0");
  });
});
