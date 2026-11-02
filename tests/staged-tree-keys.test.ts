/**
 * #262: sha-keyed staged-tree copies are disposable and expire under a bucket
 * lifecycle rule. R2 rules match a leading prefix, so the copies must sit under
 * a prefix of their own. Under `repos/` the rule would also reach the
 * latest-tip trees and the backups beside them.
 */
import { describe, expect, it } from "vitest";
import { STAGED_TREE_SHA_PREFIX, stagedTreeKey, stagedTreeShaKey } from "../src/storage/git-ops";

describe("staged-tree R2 keys", () => {
  it("puts every sha-keyed copy under its own lifecycle prefix", () => {
    const key = stagedTreeShaKey("proj_1", "feature", "abc123");
    expect(key).toBe("staged-sha/proj_1/feature/abc123");
    expect(key.startsWith(STAGED_TREE_SHA_PREFIX)).toBe(true);
  });

  it("keeps the latest-tip tree out of that prefix, so the rule cannot expire it", () => {
    expect(stagedTreeKey("proj_1", "feature").startsWith(STAGED_TREE_SHA_PREFIX)).toBe(false);
  });

  it("keeps the prefix off anything under repos/", () => {
    expect(STAGED_TREE_SHA_PREFIX.startsWith("repos/")).toBe(false);
    expect("repos/".startsWith(STAGED_TREE_SHA_PREFIX)).toBe(false);
  });
});
