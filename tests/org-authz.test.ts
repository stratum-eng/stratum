import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOrgAccessLevel } from "../src/storage/orgs";
import type { ProjectEntry } from "../src/types";
import { canReadProject, canWriteProject, filterReadableProjects } from "../src/utils/authz";
import type { Logger } from "../src/utils/logger";

vi.mock("../src/storage/orgs", () => ({
  getOrgAccessLevel: vi.fn(),
}));

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const db = {} as D1Database;

function makeProject(overrides: Partial<ProjectEntry>): ProjectEntry {
  return {
    id: "proj_1",
    name: "p",
    slug: "p",
    namespace: "@owner",
    ownerId: "user_owner",
    ownerType: "user",
    remote: "remote",
    token: "token",
    createdAt: "2026-01-01T00:00:00.000Z",
    visibility: "private",
    ...overrides,
  };
}

const orgProject = makeProject({ namespace: "@acme", ownerId: "org_1", ownerType: "org" });

describe("org project authorization", () => {
  beforeEach(() => {
    vi.mocked(getOrgAccessLevel).mockReset();
  });

  it("keeps user-owned semantics without touching the database", async () => {
    const project = makeProject({});
    expect(await canWriteProject(db, project, "user_owner")).toBe(true);
    expect(await canWriteProject(db, project, "user_other")).toBe(false);
    expect(await canReadProject(db, project, "user_other")).toBe(false);
    expect(await canReadProject(db, makeProject({ visibility: "public" }), undefined)).toBe(true);
    expect(getOrgAccessLevel).not.toHaveBeenCalled();
  });

  it("grants read to any org member and denies non-members", async () => {
    vi.mocked(getOrgAccessLevel).mockResolvedValueOnce("read");
    expect(await canReadProject(db, orgProject, "user_member")).toBe(true);

    vi.mocked(getOrgAccessLevel).mockResolvedValueOnce("none");
    expect(await canReadProject(db, orgProject, "user_stranger")).toBe(false);
  });

  it("requires write/admin level for org project writes", async () => {
    vi.mocked(getOrgAccessLevel).mockResolvedValueOnce("read");
    expect(await canWriteProject(db, orgProject, "user_member")).toBe(false);

    vi.mocked(getOrgAccessLevel).mockResolvedValueOnce("write");
    expect(await canWriteProject(db, orgProject, "user_team_writer")).toBe(true);

    vi.mocked(getOrgAccessLevel).mockResolvedValueOnce("admin");
    expect(await canWriteProject(db, orgProject, "user_admin")).toBe(true);
  });

  it("agents inherit their owning user's org access", async () => {
    vi.mocked(getOrgAccessLevel).mockResolvedValueOnce("write");
    expect(await canWriteProject(db, orgProject, undefined, "user_agent_owner")).toBe(true);
    expect(getOrgAccessLevel).toHaveBeenCalledWith(
      db,
      expect.any(Object),
      "org_1",
      "user_agent_owner",
    );
  });

  it("denies anonymous callers on private org projects", async () => {
    expect(await canReadProject(db, orgProject, undefined)).toBe(false);
    expect(getOrgAccessLevel).not.toHaveBeenCalled();
  });

  it("filterReadableProjects resolves each org once", async () => {
    vi.mocked(getOrgAccessLevel).mockResolvedValue("read");
    const projects = [
      makeProject({ id: "1", ownerId: "user_me" }),
      makeProject({ id: "2", ownerId: "org_1", ownerType: "org" }),
      makeProject({ id: "3", ownerId: "org_1", ownerType: "org" }),
      makeProject({ id: "4", ownerId: "org_2", ownerType: "org" }),
      makeProject({ id: "5", ownerId: "user_other" }),
    ];

    const readable = await filterReadableProjects(db, projects, "user_me");
    expect(readable.map((p) => p.id)).toEqual(["1", "2", "3", "4"]);
    // org_1 and org_2 — one lookup each despite three org projects.
    expect(getOrgAccessLevel).toHaveBeenCalledTimes(2);
  });

  it("filterReadableProjects hides incomplete org imports from read-level members", async () => {
    vi.mocked(getOrgAccessLevel).mockResolvedValue("read");
    const incomplete = makeProject({
      id: "imp",
      ownerId: "org_1",
      ownerType: "org",
      importCompleted: false,
    });

    const readable = await filterReadableProjects(db, [incomplete], "user_member");
    expect(readable).toHaveLength(0);

    vi.mocked(getOrgAccessLevel).mockResolvedValue("write");
    const writable = await filterReadableProjects(db, [incomplete], "user_writer");
    expect(writable).toHaveLength(1);
  });
});
