/**
 * S6 (#130): setWorkspace validates the remote at WRITE time and fails closed.
 * A corrupted/injected workspace entry must never be persisted, because the
 * stored remote later reaches freshRepoToken (token mint) and the git proxy.
 */
import { describe, expect, it, vi } from "vitest";
import { getWorkspace, setWorkspace } from "../src/storage/state";
import type { WorkspaceEntry } from "../src/types";
import type { Logger } from "../src/utils/logger";
import { makeFakeKV } from "./helpers/fake-kv";

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const entry = (remote: string): WorkspaceEntry => ({
  name: "myws",
  remote,
  parent: "proj_1",
  branchName: "myws",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("setWorkspace remote validation (S6)", () => {
  it("stores a workspace with a genuine Artifacts remote", async () => {
    const kv = makeFakeKV();
    const result = await setWorkspace(
      kv,
      "proj_1",
      entry("https://acct.artifacts.cloudflare.net/git/@owner/myws.git"),
      logger,
    );
    expect(result.success).toBe(true);
    expect(kv.store.has("workspace:proj_1:myws")).toBe(true);
  });

  it.each([
    ["foreign host", "https://github.com/foo/bar.git"],
    ["http downgrade", "http://acct.artifacts.cloudflare.net/git/@owner/myws.git"],
    ["suffix-spoofed host", "https://evil.example.artifacts.cloudflare.net.evil.io/git/@o/x.git"],
    ["wrong path shape", "https://acct.artifacts.cloudflare.net/not-git/@owner/myws.git"],
    ["not a URL", "not a url at all"],
    ["empty", ""],
  ])("fails closed and writes NOTHING for %s", async (_label, remote) => {
    const kv = makeFakeKV();
    const result = await setWorkspace(kv, "proj_1", entry(remote), logger);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("INVALID_REMOTE");
      // The invalid remote itself stays out of the error message (S5 hygiene).
      expect(result.error.message).not.toContain(remote || "###");
    }
    expect(kv.store.size).toBe(0);
    // Nothing readable either — the token-mint path can never see this entry.
    const read = await getWorkspace(kv, "proj_1", "myws", logger);
    expect(read.success).toBe(false);
  });
});
