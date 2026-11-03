import { vi } from "vitest";
import type { OrgAccess, OrgAccessLevel } from "../../src/storage/orgs";

type LevelFn = (
  db: D1Database,
  logger: unknown,
  orgId: string,
  userId: string,
) => Promise<OrgAccessLevel>;

/**
 * For `vi.mock("../src/storage/orgs", …)` factories that stub
 * `getOrgAccessLevel`: authz reads access through `getOrgAccess` (level + IP
 * allowlist in one query, #399), so this derives that from the stubbed level
 * with an empty allowlist. It calls the stub instance itself, so a test's
 * `vi.mocked(getOrgAccessLevel).mockResolvedValueOnce(...)` still steers authz.
 */
export function withOrgAccess<T extends object>(
  mod: T,
): T & { getOrgAccess: (...args: Parameters<LevelFn>) => Promise<OrgAccess> } {
  const level = (mod as { getOrgAccessLevel: LevelFn }).getOrgAccessLevel;
  return {
    ...mod,
    getOrgAccess: vi.fn(async (...args: Parameters<LevelFn>) => ({
      level: await level(...args),
      ipAllowlist: [],
    })),
  };
}
