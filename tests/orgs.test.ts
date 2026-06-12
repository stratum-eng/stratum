import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware } from "../src/middleware/auth";
import { orgsRouter } from "../src/routes/orgs";
import type { Env } from "../src/types";
import { NotFoundError } from "../src/utils/errors";

vi.mock("../src/storage/users", () => ({
  getUserByToken: vi.fn(),
  // Default: no username collides with the org slug.
  getUserByUsername: vi.fn().mockResolvedValue({
    success: false,
    error: new Error("not found"),
  }),
}));

vi.mock("../src/storage/agents", () => ({
  getAgentByToken: vi.fn(),
}));

vi.mock("../src/storage/sessions", () => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
}));

vi.mock("../src/storage/orgs", () => ({
  createOrg: vi.fn(),
  getOrgBySlug: vi.fn(),
  listOrgsForUser: vi.fn(),
  addOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  isOrgAdmin: vi.fn(),
  isOrgMember: vi.fn(),
}));

vi.mock("../src/storage/teams", () => ({
  createTeam: vi.fn(),
  getTeam: vi.fn(),
  listTeams: vi.fn(),
  deleteTeam: vi.fn(),
  addTeamMember: vi.fn(),
  removeTeamMember: vi.fn(),
  listTeamMembers: vi.fn(),
}));

import {
  addOrgMember,
  createOrg,
  getOrgBySlug,
  isOrgAdmin,
  listOrgsForUser,
  removeOrgMember,
} from "../src/storage/orgs";
import { createTeam, deleteTeam, getTeam, listTeams } from "../src/storage/teams";
import { getUserByToken } from "../src/storage/users";

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", authMiddleware);
  app.route("/api/orgs", orgsRouter);
  return app;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const hasBody = body !== undefined;
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  });
}

const mockUser = {
  id: "usr_owner",
  email: "owner@example.com",
  username: "owner",
  tokenHash: "hash",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockOrg = {
  id: "org_abc",
  name: "My Org",
  slug: "my-org",
  ownerId: "usr_owner",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const mockTeam = {
  id: "team_abc",
  orgId: "org_abc",
  name: "Engineers",
  slug: "engineers",
  permissions: "read" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const authHeader = { Authorization: "Bearer stratum_user_token" };

describe("POST /api/orgs", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(createOrg).mockResolvedValue({
      success: true,
      data: mockOrg,
    });
    vi.mocked(addOrgMember).mockResolvedValue({
      success: true,
      data: undefined,
    });
  });

  it("creates org and auto-adds owner as admin", async () => {
    const res = await app.fetch(
      request("POST", "/api/orgs", { name: "My Org", slug: "my-org" }, authHeader),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { org: typeof mockOrg };
    expect(body.org.id).toBe("org_abc");
    expect(body.org.slug).toBe("my-org");
    expect(createOrg).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "usr_owner",
      "My Org",
      "my-org",
    );
    expect(addOrgMember).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "org_abc",
      "usr_owner",
      "admin",
    );
  });

  it("returns 401 without auth", async () => {
    const res = await app.fetch(
      request("POST", "/api/orgs", { name: "My Org", slug: "my-org" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(createOrg).not.toHaveBeenCalled();
  });

  it("returns 400 with invalid slug", async () => {
    const res = await app.fetch(
      request("POST", "/api/orgs", { name: "My Org", slug: "invalid slug!" }, authHeader),
      env,
    );
    expect(res.status).toBe(400);
    expect(createOrg).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.fetch(request("POST", "/api/orgs", { slug: "my-org" }, authHeader), env);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/orgs", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(listOrgsForUser).mockResolvedValue({
      success: true,
      data: [mockOrg],
    });
  });

  it("lists orgs for current user", async () => {
    const res = await app.fetch(request("GET", "/api/orgs", undefined, authHeader), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgs: (typeof mockOrg)[] };
    expect(body.orgs).toHaveLength(1);
    expect(body.orgs[0]?.id).toBe("org_abc");
    expect(listOrgsForUser).toHaveBeenCalledWith(env.DB, expect.any(Object), "usr_owner");
  });

  it("returns 401 when not authenticated", async () => {
    const res = await app.fetch(request("GET", "/api/orgs"), env);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/orgs/:slug", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getOrgBySlug).mockResolvedValue({
      success: true,
      data: mockOrg,
    });
  });

  it("returns org by slug", async () => {
    const res = await app.fetch(request("GET", "/api/orgs/my-org"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { org: typeof mockOrg };
    expect(body.org.slug).toBe("my-org");
    expect(getOrgBySlug).toHaveBeenCalledWith(env.DB, expect.any(Object), "my-org");
  });

  it("returns 404 for unknown slug", async () => {
    vi.mocked(getOrgBySlug).mockResolvedValue({
      success: false,
      error: new NotFoundError("Org", "no-such-org"),
    });
    const res = await app.fetch(request("GET", "/api/orgs/no-such-org"), env);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/orgs/:slug/members", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(getOrgBySlug).mockResolvedValue({
      success: true,
      data: mockOrg,
    });
    vi.mocked(isOrgAdmin).mockResolvedValue({
      success: true,
      data: true,
    });
    vi.mocked(addOrgMember).mockResolvedValue({
      success: true,
      data: undefined,
    });
  });

  it("adds member when caller is org admin", async () => {
    const res = await app.fetch(
      request("POST", "/api/orgs/my-org/members", { userId: "usr_other" }, authHeader),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: boolean; userId: string };
    expect(body.added).toBe(true);
    expect(body.userId).toBe("usr_other");
    expect(addOrgMember).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "org_abc",
      "usr_other",
      "member",
    );
  });

  it("returns 403 when caller is not org admin", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue({
      success: true,
      data: false,
    });
    const res = await app.fetch(
      request("POST", "/api/orgs/my-org/members", { userId: "usr_other" }, authHeader),
      env,
    );
    expect(res.status).toBe(403);
    expect(addOrgMember).not.toHaveBeenCalled();
  });

  it("returns 401 when not authenticated", async () => {
    const res = await app.fetch(
      request("POST", "/api/orgs/my-org/members", { userId: "usr_other" }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/orgs/:slug/members/:uid", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(getOrgBySlug).mockResolvedValue({
      success: true,
      data: mockOrg,
    });
    vi.mocked(isOrgAdmin).mockResolvedValue({
      success: true,
      data: true,
    });
    vi.mocked(removeOrgMember).mockResolvedValue({
      success: true,
      data: undefined,
    });
  });

  it("removes member when caller is org admin", async () => {
    const res = await app.fetch(
      request("DELETE", "/api/orgs/my-org/members/usr_other", undefined, authHeader),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; userId: string };
    expect(body.removed).toBe(true);
    expect(body.userId).toBe("usr_other");
    expect(removeOrgMember).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "org_abc",
      "usr_other",
    );
  });

  it("returns 403 when caller is not org admin", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue({
      success: true,
      data: false,
    });
    const res = await app.fetch(
      request("DELETE", "/api/orgs/my-org/members/usr_other", undefined, authHeader),
      env,
    );
    expect(res.status).toBe(403);
    expect(removeOrgMember).not.toHaveBeenCalled();
  });
});

describe("POST /api/orgs/:slug/teams", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(getOrgBySlug).mockResolvedValue({
      success: true,
      data: mockOrg,
    });
    vi.mocked(isOrgAdmin).mockResolvedValue({
      success: true,
      data: true,
    });
    vi.mocked(createTeam).mockResolvedValue({
      success: true,
      data: mockTeam,
    });
  });

  it("creates team when caller is org admin", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/orgs/my-org/teams",
        { name: "Engineers", slug: "engineers" },
        authHeader,
      ),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { team: typeof mockTeam };
    expect(body.team.id).toBe("team_abc");
    expect(body.team.slug).toBe("engineers");
    expect(createTeam).toHaveBeenCalledWith(
      env.DB,
      expect.any(Object),
      "org_abc",
      "Engineers",
      "engineers",
      "read",
    );
  });

  it("returns 403 when caller is not org admin", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue({
      success: true,
      data: false,
    });
    const res = await app.fetch(
      request(
        "POST",
        "/api/orgs/my-org/teams",
        { name: "Engineers", slug: "engineers" },
        authHeader,
      ),
      env,
    );
    expect(res.status).toBe(403);
    expect(createTeam).not.toHaveBeenCalled();
  });

  it("returns 400 with invalid slug", async () => {
    const res = await app.fetch(
      request(
        "POST",
        "/api/orgs/my-org/teams",
        { name: "Engineers", slug: "bad slug!" },
        authHeader,
      ),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/orgs/:slug/teams/:id", () => {
  let app: ReturnType<typeof makeApp>;
  let env: Env;

  beforeEach(() => {
    app = makeApp();
    env = makeEnv();
    vi.clearAllMocks();
    vi.mocked(getUserByToken).mockResolvedValue({
      success: true,
      data: mockUser,
    });
    vi.mocked(getOrgBySlug).mockResolvedValue({
      success: true,
      data: mockOrg,
    });
    vi.mocked(isOrgAdmin).mockResolvedValue({
      success: true,
      data: true,
    });
    vi.mocked(getTeam).mockResolvedValue({
      success: true,
      data: mockTeam,
    });
    vi.mocked(deleteTeam).mockResolvedValue({
      success: true,
      data: undefined,
    });
    vi.mocked(listTeams).mockResolvedValue({
      success: true,
      data: [mockTeam],
    });
  });

  it("deletes team when caller is org admin", async () => {
    const res = await app.fetch(
      request("DELETE", "/api/orgs/my-org/teams/team_abc", undefined, authHeader),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean; id: string };
    expect(body.deleted).toBe(true);
    expect(body.id).toBe("team_abc");
    expect(deleteTeam).toHaveBeenCalledWith(env.DB, expect.any(Object), "team_abc");
  });

  it("returns 403 when caller is not org admin", async () => {
    vi.mocked(isOrgAdmin).mockResolvedValue({
      success: true,
      data: false,
    });
    const res = await app.fetch(
      request("DELETE", "/api/orgs/my-org/teams/team_abc", undefined, authHeader),
      env,
    );
    expect(res.status).toBe(403);
    expect(deleteTeam).not.toHaveBeenCalled();
  });

  it("returns 404 when team does not exist", async () => {
    vi.mocked(getTeam).mockResolvedValue({
      success: false,
      error: new NotFoundError("Team", "team_missing"),
    });
    const res = await app.fetch(
      request("DELETE", "/api/orgs/my-org/teams/team_missing", undefined, authHeader),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when team belongs to a different org", async () => {
    vi.mocked(getTeam).mockResolvedValue({
      success: true,
      data: { ...mockTeam, orgId: "org_other" },
    });
    const res = await app.fetch(
      request("DELETE", "/api/orgs/my-org/teams/team_abc", undefined, authHeader),
      env,
    );
    expect(res.status).toBe(404);
  });
});
