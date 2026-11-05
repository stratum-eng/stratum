import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, ProjectEntry } from "../src/types";

vi.mock("../src/storage/users", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/users")>()),
  getUser: vi.fn(),
}));
vi.mock("../src/storage/orgs", async (importOriginal) =>
  (await import("./helpers/org-access-mock")).withOrgAccess({
    ...(await importOriginal<typeof import("../src/storage/orgs")>()),
    listOrgsForUser: vi.fn(),
    getOrgAccessLevel: vi.fn(async () => "read" as const),
  }),
);
vi.mock("../src/storage/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/state")>()),
  listProjects: vi.fn(),
  listProjectsByNamespace: vi.fn(),
}));

import { uiRouter } from "../src/routes/ui";
import { listOrgsForUser } from "../src/storage/orgs";
import { listProjects, listProjectsByNamespace } from "../src/storage/state";
import { getUser } from "../src/storage/users";

const alice = {
  id: "usr_1",
  email: "a@b.com",
  username: "alice",
  tokenHash: "h",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function project(
  namespace: string,
  slug: string,
  overrides: Partial<ProjectEntry> = {},
): ProjectEntry {
  return {
    id: `prj_${slug}`,
    name: slug,
    slug,
    namespace,
    ownerId: "usr_1",
    ownerType: "user",
    remote: `https://acct.artifacts.cloudflare.net/git/x/${slug}.git`,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeApp(userId: string | null) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (userId) {
      c.set("userId", userId);
      c.set("authVia", "session");
    }
    await next();
  });
  app.route("/", uiRouter);
  return app;
}

const env = { STATE: {} as KVNamespace, DB: {} as D1Database } as Env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUser).mockResolvedValue({ success: true, data: alice } as never);
});

describe("GET / dashboard listing", () => {
  it("reads no projects at all for a signed-out visitor", async () => {
    const res = await makeApp(null).fetch(new Request("http://localhost/"), env);

    expect(res.status).toBe(200);
    expect(listProjects).not.toHaveBeenCalled();
    expect(listProjectsByNamespace).not.toHaveBeenCalled();
  });

  it("lists only the user's own namespace and their orgs', never the whole instance", async () => {
    vi.mocked(listOrgsForUser).mockResolvedValue({
      success: true,
      data: [{ id: "org_1", slug: "acme" }],
    } as never);
    vi.mocked(listProjectsByNamespace).mockImplementation(async (_kv, ns) => ({
      success: true,
      data:
        ns === "@alice"
          ? [project("@alice", "mine")]
          : [project("@acme", "shared", { ownerType: "org", ownerId: "org_1" })],
    }));

    const res = await makeApp("usr_1").fetch(new Request("http://localhost/"), env);
    const html = await res.text();

    expect(listProjects).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(listProjectsByNamespace)
        .mock.calls.map(([, ns]) => ns)
        .sort(),
    ).toEqual(["@acme", "@alice"]);
    expect(html).toContain("mine");
    expect(html).toContain("shared");
  });

  it("still applies the membership filter to what the namespaces hold", async () => {
    vi.mocked(listOrgsForUser).mockResolvedValue({ success: true, data: [] } as never);
    vi.mocked(listProjectsByNamespace).mockResolvedValue({
      success: true,
      data: [project("@alice", "mine"), project("@alice", "someone-elses", { ownerId: "usr_2" })],
    });

    const html = await (await makeApp("usr_1").fetch(new Request("http://localhost/"), env)).text();

    expect(html).toContain("mine");
    expect(html).not.toContain("someone-elses");
  });

  it("falls back to the full listing when the org lookup fails", async () => {
    vi.mocked(listOrgsForUser).mockResolvedValue({ success: false, error: new Error("d1 down") });
    vi.mocked(listProjects).mockResolvedValue({ success: true, data: [project("@alice", "mine")] });

    const html = await (await makeApp("usr_1").fetch(new Request("http://localhost/"), env)).text();

    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(html).toContain("mine");
  });
});
