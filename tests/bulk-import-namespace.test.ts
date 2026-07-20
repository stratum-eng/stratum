/**
 * BULK-3: a bulk import may only target the caller's OWN namespace. Previously
 * `processRepoImport` trusted a caller-supplied namespace (format-checked only),
 * so a caller could create a project under another user's @handle (squatting /
 * impersonation). The guard returns before any storage I/O.
 */
import { describe, expect, it, vi } from "vitest";
import { processRepoImport } from "../src/routes/bulk-import";
import type { Env } from "../src/types";

// If the guard is bypassed, the import proceeds and touches these — a squatting
// attempt must NOT reach them.
vi.mock("../src/storage/state", () => ({
  getProjectByPath: vi.fn(async () => ({ success: false, error: { code: "NOT_FOUND" } })),
  setProject: vi.fn(),
}));
import { setProject } from "../src/storage/state";

const env = { STATE: {} as KVNamespace, ARTIFACTS: {} } as unknown as Env;

describe("bulk import namespace ownership", () => {
  it("rejects importing into another user's namespace", async () => {
    const result = await processRepoImport(
      env,
      "job_1",
      { url: "https://github.com/acme/api", namespace: "@victim", slug: "api" },
      "user_attacker",
      "attacker",
      0,
      1,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/own namespace/i);
    expect(setProject).not.toHaveBeenCalled();
  });

  it("allows importing into the caller's own namespace", async () => {
    // Own namespace passes the ownership guard (further import work is mocked out
    // via getProjectByPath NOT-FOUND → proceeds; we only assert it clears the gate).
    const result = await processRepoImport(
      env,
      "job_2",
      { url: "https://github.com/acme/api", namespace: "@attacker", slug: "api" },
      "user_attacker",
      "attacker",
      0,
      1,
    );
    // It gets past the ownership gate (may fail later on mocked import internals,
    // but not with the namespace error).
    if (!result.success) {
      expect(result.error).not.toMatch(/own namespace/i);
    }
  });
});
