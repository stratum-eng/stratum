import { describe, expect, it, vi } from "vitest";
import { getOrgAccessLevel } from "../src/storage/orgs";
import type { Logger } from "../src/utils/logger";

const mockLogger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function makeDb(row: { org_role: string; team_level: number | null } | null): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
      }),
    }),
  } as unknown as D1Database;
}

describe("getOrgAccessLevel", () => {
  it("returns none for non-members", async () => {
    expect(await getOrgAccessLevel(makeDb(null), mockLogger, "org_1", "user_1")).toBe("none");
  });

  it("returns admin for org owners and admins", async () => {
    expect(
      await getOrgAccessLevel(
        makeDb({ org_role: "owner", team_level: null }),
        mockLogger,
        "o",
        "u",
      ),
    ).toBe("admin");
    expect(
      await getOrgAccessLevel(makeDb({ org_role: "admin", team_level: 0 }), mockLogger, "o", "u"),
    ).toBe("admin");
  });

  it("returns write for members of write/admin teams", async () => {
    expect(
      await getOrgAccessLevel(makeDb({ org_role: "member", team_level: 2 }), mockLogger, "o", "u"),
    ).toBe("write");
    expect(
      await getOrgAccessLevel(makeDb({ org_role: "member", team_level: 3 }), mockLogger, "o", "u"),
    ).toBe("write");
  });

  it("returns read for plain members and read-team members", async () => {
    expect(
      await getOrgAccessLevel(
        makeDb({ org_role: "member", team_level: null }),
        mockLogger,
        "o",
        "u",
      ),
    ).toBe("read");
    expect(
      await getOrgAccessLevel(makeDb({ org_role: "member", team_level: 1 }), mockLogger, "o", "u"),
    ).toBe("read");
  });

  it("fails closed on database errors", async () => {
    const badDb = {
      prepare: () => {
        throw new Error("D1 down");
      },
    } as unknown as D1Database;
    expect(await getOrgAccessLevel(badDb, mockLogger, "o", "u")).toBe("none");
  });
});
