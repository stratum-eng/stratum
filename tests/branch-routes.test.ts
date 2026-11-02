/**
 * Issue #181: the branch API — listing, creation, deletion, and `?ref=` on the
 * read routes.
 *
 * The git layer is mocked here; its own behaviour is covered against real
 * in-memory repos in `tests/git-branches.test.ts`. What these tests pin down is
 * the route contract: which status code each refusal produces, that a
 * non-writer cannot tell a private project exists, that writes are audited and
 * mint a WRITE token, and that a bad `?ref=` never silently falls back to the
 * default branch.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types";

vi.mock("../src/storage/state", () => ({
  getProjectByPath: vi.fn(),
  listProjectsByNamespace: vi.fn(),
  setProject: vi.fn(),
}));
vi.mock("../src/storage/audit", () => ({ recordAudit: vi.fn(async () => ({ success: true })) }));
vi.mock("../src/storage/deletion", () => ({
  captureDeletionTarget: vi.fn(),
  isTargetDeleting: vi.fn(async () => false),
}));
vi.mock("../src/utils/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/authz")>()),
  canReadProject: vi.fn(async () => true),
  canWriteProject: vi.fn(async () => true),
}));
vi.mock("../src/storage/git-ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/storage/git-ops")>()),
  freshRepoToken: vi.fn(async () => ({ success: true, data: "tok" })),
  listRepoBranches: vi.fn(),
  createBranchRef: vi.fn(),
  deleteBranchRef: vi.fn(),
  resolveBranchRef: vi.fn(),
  listFilesInRepo: vi.fn(async () => ({ success: true, data: ["a.txt"] })),
  getCommitLog: vi.fn(async () => ({ success: true, data: [] })),
}));

import { projectsRouter } from "../src/routes/projects";
import { recordAudit } from "../src/storage/audit";
import { isTargetDeleting } from "../src/storage/deletion";
import {
  createBranchRef,
  deleteBranchRef,
  freshRepoToken,
  listFilesInRepo,
  listRepoBranches,
  resolveBranchRef,
} from "../src/storage/git-ops";
import { getProjectByPath } from "../src/storage/state";
import { canWriteProject } from "../src/utils/authz";

function makeApp(identity: { userId?: string; agentOwnerId?: string } = { userId: "usr_1" }) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    if (identity.userId) c.set("userId", identity.userId);
    if (identity.agentOwnerId) c.set("agentOwnerId", identity.agentOwnerId);
    await next();
  });
  app.route("/api/projects", projectsRouter);
  return app;
}

const env = { DB: {}, STATE: {}, ARTIFACTS: {} } as unknown as Env;
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const project = {
  id: "proj_1",
  name: "api",
  slug: "api",
  namespace: "@alice",
  ownerId: "usr_1",
  ownerType: "user",
  remote: "https://artifacts/x.git",
  sourceDefaultBranch: "trunk",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProjectByPath).mockResolvedValue({ success: true, data: project } as never);
  vi.mocked(freshRepoToken).mockResolvedValue({ success: true, data: "tok" } as never);
  vi.mocked(isTargetDeleting).mockResolvedValue(false as never);
  vi.mocked(canWriteProject).mockResolvedValue(true as never);
});

describe("GET /api/projects/:namespace/:slug/branches", () => {
  it("lists branches and names the project's resolved default branch", async () => {
    vi.mocked(listRepoBranches).mockResolvedValue({
      success: true,
      data: {
        branches: [
          { name: "trunk", oid: "a".repeat(40) },
          { name: "release/2.x", oid: "b".repeat(40) },
        ],
        truncated: false,
        totalBranchCount: 2,
      },
    } as never);

    const res = await makeApp().fetch(req("GET", "/api/projects/@alice/api/branches"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultBranch: string; branches: unknown[] };
    // The project's own default, not a hardcoded "main".
    expect(body.defaultBranch).toBe("trunk");
    expect(body.branches).toHaveLength(2);
    expect(listRepoBranches).toHaveBeenCalledWith(
      project.remote,
      "tok",
      expect.any(Object),
      "trunk",
    );
  });

  it("surfaces truncation rather than presenting a partial list as complete", async () => {
    vi.mocked(listRepoBranches).mockResolvedValue({
      success: true,
      data: {
        branches: [{ name: "trunk", oid: "a".repeat(40) }],
        truncated: true,
        totalBranchCount: 900,
      },
    } as never);

    const res = await makeApp().fetch(req("GET", "/api/projects/@alice/api/branches"), env, ctx);
    const body = (await res.json()) as { truncated: boolean; totalBranchCount: number };
    expect(body.truncated).toBe(true);
    expect(body.totalBranchCount).toBe(900);
  });
});

describe("POST /api/projects/:namespace/:slug/branches", () => {
  it("creates a branch, mints a WRITE token, and audits it", async () => {
    vi.mocked(createBranchRef).mockResolvedValue({
      success: true,
      data: { name: "feature/x", oid: "a".repeat(40) },
    } as never);

    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "feature/x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    // A read token here would fail the push with an opaque 502.
    expect(freshRepoToken).toHaveBeenCalledWith(
      env.ARTIFACTS,
      project.remote,
      "write",
      expect.any(Object),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "branch.created", actorType: "user", actorId: "usr_1" }),
    );
  });

  it("passes the project's default branch, not main, to the git layer", async () => {
    vi.mocked(createBranchRef).mockResolvedValue({
      success: true,
      data: { name: "x", oid: "a".repeat(40) },
    } as never);

    await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "x", startPoint: "trunk" }),
      env,
      ctx,
    );
    expect(createBranchRef).toHaveBeenCalledWith(project.remote, "tok", expect.any(Object), {
      name: "x",
      startPoint: "trunk",
      defaultBranch: "trunk",
    });
  });

  it("credits an agent's write to the agent, not to a bare user", async () => {
    vi.mocked(createBranchRef).mockResolvedValue({
      success: true,
      data: { name: "x", oid: "a".repeat(40) },
    } as never);

    await makeApp({ agentOwnerId: "usr_1" }).fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "x" }),
      env,
      ctx,
    );
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ actorType: "agent", actorId: "usr_1" }),
    );
  });

  it("404s a non-writer without disclosing that the project exists", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(false as never);
    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(createBranchRef).not.toHaveBeenCalled();
  });

  it("409s while the project is being deleted", async () => {
    vi.mocked(isTargetDeleting).mockResolvedValue(true as never);
    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "TARGET_DELETING" });
    expect(createBranchRef).not.toHaveBeenCalled();
  });

  it("400s an invalid branch name before reaching the git layer", async () => {
    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "../heads/trunk" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(createBranchRef).not.toHaveBeenCalled();
  });

  it("409s a branch that already exists", async () => {
    vi.mocked(createBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "exists", name: "feature/x" },
    } as never);
    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "feature/x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "BRANCH_EXISTS" });
  });

  it("400s an unresolvable start point", async () => {
    vi.mocked(createBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "bad-start-point", startPoint: "0".repeat(40) },
    } as never);
    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "x", startPoint: "0".repeat(40) }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("400s a JSON body of null rather than throwing a 500", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/api/projects/@alice/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      }),
      env,
      ctx,
    );
    // `readJsonWithLimit` returns whatever JSON.parse produced, so `null`
    // throws nothing and used to reach the destructure as a TypeError.
    expect(res.status).toBe(400);
    expect(createBranchRef).not.toHaveBeenCalled();
  });

  it("409s a name that collides with an existing branch's ref path", async () => {
    vi.mocked(createBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "conflicts-with", name: "release", existing: "release/2.x" },
    } as never);
    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "release" }),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "BRANCH_NAME_CONFLICT",
    });
  });

  it("409s when the remote does not advertise the project's default branch", async () => {
    vi.mocked(createBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "no-default-branch", name: "trunk" },
    } as never);
    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "NO_DEFAULT_BRANCH" });
  });

  it("409s a branch write while the project's import is still running", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...project, importCompleted: false },
    } as never);
    const res = await makeApp().fetch(
      req("POST", "/api/projects/@alice/api/branches", { name: "x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "IMPORT_IN_PROGRESS" });
    expect(createBranchRef).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before parsing it", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/api/projects/@alice/api/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json", "content-length": String(64 * 1024) },
        body: JSON.stringify({ name: "x" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(413);
    expect(createBranchRef).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/projects/:namespace/:slug/branches/*", () => {
  it("deletes a branch and audits it", async () => {
    vi.mocked(deleteBranchRef).mockResolvedValue({ success: true, data: undefined } as never);
    const res = await makeApp().fetch(
      req("DELETE", "/api/projects/@alice/api/branches/stale"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(deleteBranchRef).toHaveBeenCalledWith(project.remote, "tok", expect.any(Object), {
      name: "stale",
      defaultBranch: "trunk",
    });
    expect(recordAudit).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      expect.objectContaining({ action: "branch.deleted" }),
    );
  });

  it("carries a hierarchical name through the wildcard path intact", async () => {
    vi.mocked(deleteBranchRef).mockResolvedValue({ success: true, data: undefined } as never);
    await makeApp().fetch(req("DELETE", "/api/projects/@alice/api/branches/release/2.x"), env, ctx);
    expect(deleteBranchRef).toHaveBeenCalledWith(
      project.remote,
      "tok",
      expect.any(Object),
      expect.objectContaining({ name: "release/2.x" }),
    );
  });

  it("does not lop the name in half when the project slug is itself 'branches'", async () => {
    vi.mocked(getProjectByPath).mockResolvedValue({
      success: true,
      data: { ...project, slug: "branches", name: "branches" },
    } as never);
    vi.mocked(deleteBranchRef).mockResolvedValue({ success: true, data: undefined } as never);

    await makeApp().fetch(req("DELETE", "/api/projects/@alice/branches/branches/stale"), env, ctx);
    expect(deleteBranchRef).toHaveBeenCalledWith(
      project.remote,
      "tok",
      expect.any(Object),
      expect.objectContaining({ name: "stale" }),
    );
  });

  it("keeps a branch legitimately named refs/branches/x intact", async () => {
    vi.mocked(deleteBranchRef).mockResolvedValue({ success: true, data: undefined } as never);
    await makeApp().fetch(
      req("DELETE", "/api/projects/@alice/api/branches/refs/branches/x"),
      env,
      ctx,
    );
    expect(deleteBranchRef).toHaveBeenCalledWith(
      project.remote,
      "tok",
      expect.any(Object),
      expect.objectContaining({ name: "refs/branches/x" }),
    );
  });

  it("finds the branch name when the namespace arrives percent-encoded", async () => {
    vi.mocked(deleteBranchRef).mockResolvedValue({ success: true, data: undefined } as never);
    // Hono decodes route params with decodeURIComponent but the path with
    // decodeURI, which leaves %40 alone — so a client that builds the URL with
    // encodeURIComponent (as this codebase's own UI does) used to land here
    // with an empty name and a 400.
    const res = await makeApp().fetch(
      req("DELETE", "/api/projects/%40alice/api/branches/stale"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(deleteBranchRef).toHaveBeenCalledWith(
      project.remote,
      "tok",
      expect.any(Object),
      expect.objectContaining({ name: "stale" }),
    );
  });

  it("reads a percent-encoded slash as a real hierarchical name", async () => {
    vi.mocked(deleteBranchRef).mockResolvedValue({ success: true, data: undefined } as never);
    const res = await makeApp().fetch(
      req("DELETE", "/api/projects/@alice/api/branches/release%2F2.x"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    // Either encoding names the same branch.
    expect(deleteBranchRef).toHaveBeenCalledWith(
      project.remote,
      "tok",
      expect.any(Object),
      expect.objectContaining({ name: "release/2.x" }),
    );
  });

  it("409s a delete while the project is being deleted", async () => {
    vi.mocked(isTargetDeleting).mockResolvedValue(true as never);
    const res = await makeApp().fetch(
      req("DELETE", "/api/projects/@alice/api/branches/stale"),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
    expect(deleteBranchRef).not.toHaveBeenCalled();
  });

  it("409s a delete of the default branch", async () => {
    vi.mocked(deleteBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "default-branch", name: "trunk" },
    } as never);
    const res = await makeApp().fetch(
      req("DELETE", "/api/projects/@alice/api/branches/trunk"),
      env,
      ctx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: "DEFAULT_BRANCH_PROTECTED",
    });
  });

  it("404s an unknown branch", async () => {
    vi.mocked(deleteBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "not-found", name: "ghost" },
    } as never);
    const res = await makeApp().fetch(
      req("DELETE", "/api/projects/@alice/api/branches/ghost"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("404s a non-writer", async () => {
    vi.mocked(canWriteProject).mockResolvedValue(false as never);
    const res = await makeApp().fetch(
      req("DELETE", "/api/projects/@alice/api/branches/stale"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(deleteBranchRef).not.toHaveBeenCalled();
  });
});

describe("?ref= on the read routes", () => {
  it("reads the default branch when no ref is given, at no extra cost", async () => {
    const res = await makeApp().fetch(req("GET", "/api/projects/@alice/api/files"), env, ctx);
    expect(res.status).toBe(200);
    // No ref means no advertisement round trip.
    expect(resolveBranchRef).not.toHaveBeenCalled();
    expect(listFilesInRepo).toHaveBeenCalledWith(
      project.remote,
      "tok",
      expect.any(Object),
      "trunk",
    );
  });

  it("reads the requested branch when the ref resolves", async () => {
    vi.mocked(resolveBranchRef).mockResolvedValue({
      success: true,
      data: { name: "release/2.x", oid: "b".repeat(40) },
    } as never);

    const res = await makeApp().fetch(
      req("GET", "/api/projects/@alice/api/files?ref=release/2.x"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ref: string }).toMatchObject({ ref: "release/2.x" });
    expect(listFilesInRepo).toHaveBeenCalledWith(
      project.remote,
      "tok",
      expect.any(Object),
      "release/2.x",
    );
  });

  it("404s an unknown ref instead of quietly serving the default branch", async () => {
    vi.mocked(resolveBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "not-found", name: "ghost" },
    } as never);

    const res = await makeApp().fetch(
      req("GET", "/api/projects/@alice/api/files?ref=ghost"),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
    expect(listFilesInRepo).not.toHaveBeenCalled();
  });

  it("409s a ref that names both a branch and a tag", async () => {
    vi.mocked(resolveBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "ambiguous", name: "v1" },
    } as never);

    const res = await makeApp().fetch(req("GET", "/api/projects/@alice/api/log?ref=v1"), env, ctx);
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "AMBIGUOUS_REF" });
  });

  it("400s a syntactically invalid ref", async () => {
    vi.mocked(resolveBranchRef).mockResolvedValue({
      success: false,
      error: { kind: "invalid", name: "../heads/trunk" },
    } as never);

    const res = await makeApp().fetch(
      req("GET", "/api/projects/@alice/api/files?ref=../heads/trunk"),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
