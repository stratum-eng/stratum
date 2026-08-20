import git from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncFromGitHub } from "../src/storage/git-ops";
import type { ArtifactsNamespace } from "../src/types";
import type { Logger } from "../src/utils/logger";

// Mock the git plumbing so the network-facing wrapper can be exercised without
// a live Artifacts/GitHub remote. The pure-git decision logic is covered with
// REAL isomorphic-git in tests/git-sync.test.ts.
vi.mock("isomorphic-git", () => ({
  default: {
    clone: vi.fn(),
    addRemote: vi.fn(),
    fetch: vi.fn(),
    resolveRef: vi.fn(),
    merge: vi.fn(),
    push: vi.fn(),
  },
}));

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as Logger;

const REMOTE = "https://acct.artifacts.cloudflare.net/git/stratum-prod/owner__repo.git";
const SOURCE_URL = "https://github.com/owner/repo";

function makeArtifacts() {
  const createToken = vi.fn().mockResolvedValue({ plaintext: "tok_secret?expires=123" });
  const del = vi.fn();
  const importFn = vi.fn();
  const get = vi.fn().mockResolvedValue({ createToken });
  const artifacts = {
    get,
    delete: del,
    import: importFn,
  } as unknown as ArtifactsNamespace;
  return { artifacts, del, importFn, createToken, get };
}

beforeEach(() => {
  vi.mocked(git.clone).mockReset().mockResolvedValue(undefined);
  vi.mocked(git.addRemote).mockReset().mockResolvedValue(undefined);
  vi.mocked(git.fetch)
    .mockReset()
    .mockResolvedValue({} as never);
  vi.mocked(git.resolveRef)
    .mockReset()
    .mockImplementation(async ({ ref }) => {
      if (ref === "FETCH_HEAD") return "srctip";
      if (ref === "main") return "headsha";
      throw new Error(`unexpected ref ${ref}`);
    });
  vi.mocked(git.merge)
    .mockReset()
    .mockResolvedValue({ oid: "srctip", fastForward: true } as never);
  vi.mocked(git.push)
    .mockReset()
    .mockResolvedValue({ ok: true } as never);
});

describe("syncFromGitHub (incremental sync wrapper)", () => {
  it("fast-forwards and pushes new source commits into the EXISTING repo", async () => {
    const { artifacts, del, importFn, createToken } = makeArtifacts();

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger, "main");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ status: "fast-forwarded", commit: "srctip" });

    // Clones the existing Artifacts repo with a write-scoped fresh token.
    expect(createToken).toHaveBeenCalledWith("write", 3600);
    expect(git.clone).toHaveBeenCalledWith(expect.objectContaining({ url: REMOTE, ref: "main" }));
    // Fetches the source branch (shallow) from the public URL.
    expect(git.addRemote).toHaveBeenCalledWith(
      expect.objectContaining({ remote: "source", url: SOURCE_URL }),
    );
    expect(git.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ remote: "source", ref: "main", singleBranch: true, depth: 50 }),
    );
    // Pushes main back to the same remote — the repo is updated, not replaced.
    expect(git.push).toHaveBeenCalledWith(
      expect.objectContaining({ url: REMOTE, ref: "main", remoteRef: "main" }),
    );
    // The destructive delete/re-import cycle must never run.
    expect(del).not.toHaveBeenCalled();
    expect(importFn).not.toHaveBeenCalled();
  });

  it("is a no-op (no push) when already up to date", async () => {
    const { artifacts, del } = makeArtifacts();
    vi.mocked(git.merge).mockResolvedValue({ oid: "headsha", alreadyMerged: true } as never);

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ status: "up-to-date", commit: "headsha" });
    expect(git.push).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("pushes a merge commit when native and source histories both advanced", async () => {
    const { artifacts } = makeArtifacts();
    vi.mocked(git.merge).mockResolvedValue({ oid: "mergesha", mergeCommit: true } as never);

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ status: "merged", commit: "mergesha" });
    expect(git.push).toHaveBeenCalledOnce();
  });

  it("resolves the head when git.merge reports no oid", async () => {
    const { artifacts } = makeArtifacts();
    vi.mocked(git.merge).mockResolvedValue({ mergeCommit: true } as never);

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ status: "merged", commit: "headsha" });
  });

  it("fails when git.merge reports no oid and main cannot be resolved", async () => {
    const { artifacts } = makeArtifacts();
    vi.mocked(git.merge).mockResolvedValue({ mergeCommit: true } as never);
    vi.mocked(git.resolveRef).mockImplementation(async ({ ref }) => {
      if (ref === "FETCH_HEAD") return "srctip";
      throw new Error("corrupt head");
    });

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("Failed to resolve main after sync");
    expect(git.push).not.toHaveBeenCalled();
  });

  it("fails with SYNC_DIVERGED on diverged history and never deletes the repo", async () => {
    const { artifacts, del, importFn } = makeArtifacts();
    vi.mocked(git.merge).mockRejectedValue(new Error("Automatic merge failed"));

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("SYNC_DIVERGED");
    expect(result.error.statusCode).toBe(409);
    expect(result.error.message).toContain("Automatic merge failed");
    expect(result.error.message).toContain("left untouched");
    expect(git.push).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(importFn).not.toHaveBeenCalled();
  });

  it("propagates source fetch failures (auth/network)", async () => {
    const { artifacts, del } = makeArtifacts();
    vi.mocked(git.fetch).mockRejectedValue(new Error("HTTP Error: 401 Unauthorized"));

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger, "develop");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("EXTERNAL_SERVICE_ERROR");
    expect(result.error.message).toContain("Failed to fetch develop from source");
    expect(result.error.message).toContain("401 Unauthorized");
    expect(git.merge).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("propagates clone failures without fetching", async () => {
    const { artifacts } = makeArtifacts();
    vi.mocked(git.clone).mockRejectedValue(new Error("network down"));

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(false);
    expect(git.fetch).not.toHaveBeenCalled();
  });

  it("fails when adding the source remote fails", async () => {
    const { artifacts } = makeArtifacts();
    vi.mocked(git.addRemote).mockRejectedValue(new Error("bad remote"));

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("Failed to add source remote");
    expect(git.fetch).not.toHaveBeenCalled();
  });

  it("fails when token minting fails, before any git operation", async () => {
    const { artifacts, get } = makeArtifacts();
    get.mockRejectedValue(new Error("artifacts down"));

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(false);
    expect(git.clone).not.toHaveBeenCalled();
  });

  it("fails for a remote that is not an Artifacts repo", async () => {
    const { artifacts } = makeArtifacts();

    const result = await syncFromGitHub(
      artifacts,
      "https://github.com/owner/repo.git",
      SOURCE_URL,
      logger,
    );

    expect(result.success).toBe(false);
    expect(artifacts.get).not.toHaveBeenCalled();
    expect(git.clone).not.toHaveBeenCalled();
  });

  it("falls back to the fetched remote ref when FETCH_HEAD is unavailable", async () => {
    const { artifacts } = makeArtifacts();
    vi.mocked(git.resolveRef).mockImplementation(async ({ ref }) => {
      if (ref === "FETCH_HEAD") throw new Error("no FETCH_HEAD");
      if (ref === "refs/remotes/source/develop") return "srctip";
      throw new Error(`unexpected ref ${ref}`);
    });

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger, "develop");

    expect(result.success).toBe(true);
    expect(git.resolveRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "refs/remotes/source/develop" }),
    );
    expect(git.merge).toHaveBeenCalledWith(expect.objectContaining({ theirs: "srctip" }));
  });

  it("fails when neither FETCH_HEAD nor the remote ref resolves", async () => {
    const { artifacts } = makeArtifacts();
    vi.mocked(git.resolveRef).mockRejectedValue(new Error("not found"));

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("Failed to resolve fetched source ref");
    expect(git.merge).not.toHaveBeenCalled();
  });

  it("fails when the push back to Artifacts is rejected", async () => {
    const { artifacts, del } = makeArtifacts();
    vi.mocked(git.push).mockRejectedValue(new Error("non-fast-forward"));

    const result = await syncFromGitHub(artifacts, REMOTE, SOURCE_URL, logger);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toContain("Failed to push synced history");
    expect(del).not.toHaveBeenCalled();
  });
});
