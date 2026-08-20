/**
 * Regression tests for the daily `project-sync` cron helper (issue #191):
 *
 * 1. It must import into the project's Artifacts repo name
 *    (`getArtifactsRepoName(namespace, slug)` = `ns__slug`), not the display
 *    `project.name` — the old behavior imported into a differently-named repo
 *    and then wrote the KV snapshot for `namespace/slug` from that wrong
 *    repo's remote.
 * 2. It must only sync projects that opted in via `autoSyncEnabled`.
 * 3. It must gate the (destructive) re-import on an actual update check and
 *    record the synced commit so the next run's check has a baseline.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncAllProjects } from "../src/routes/sync";
import type { Env, ProjectEntry } from "../src/types";

vi.mock("../src/storage/state", () => ({
  listProjects: vi.fn(),
}));

// Keep the real artifactsRepoNameFromRemote so the sync-vs-import routing
// decision is exercised for real; only the network-touching functions are mocked.
vi.mock("../src/storage/git-ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    importFromGitHub: vi.fn(),
    syncFromGitHub: vi.fn(),
  };
});

vi.mock("../src/storage/repo-snapshot", () => ({
  writeSnapshotFromRepo: vi.fn(async () => undefined),
}));

// Keep the real getProjectSourceUrl so the sourceUrl/githubUrl preference is
// exercised; only the network/KV-touching functions are mocked.
vi.mock("../src/storage/sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/storage/sync")>();
  return {
    ...actual,
    checkForSyncUpdates: vi.fn(),
    updateProjectAfterSync: vi.fn(async () => ({ success: true, data: {} })),
  };
});

import { importFromGitHub } from "../src/storage/git-ops";
import { writeSnapshotFromRepo } from "../src/storage/repo-snapshot";
import { listProjects } from "../src/storage/state";
import { checkForSyncUpdates, updateProjectAfterSync } from "../src/storage/sync";

const mockListProjects = vi.mocked(listProjects);
const mockImport = vi.mocked(importFromGitHub);
const mockCheck = vi.mocked(checkForSyncUpdates);
const mockSnapshot = vi.mocked(writeSnapshotFromRepo);
const mockUpdateAfterSync = vi.mocked(updateProjectAfterSync);

function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "My Display Name",
    slug: "my-repo",
    namespace: "@alice",
    ownerId: "user-1",
    ownerType: "user",
    remote: "https://acct.artifacts.cloudflare.net/alice__my-repo",
    createdAt: "2026-01-01T00:00:00Z",
    githubUrl: "https://github.com/alice/my-repo",
    autoSyncEnabled: true,
    ...overrides,
  } as ProjectEntry;
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {} as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheck.mockResolvedValue({
    success: true,
    data: { hasUpdates: true, latestCommit: "abc1234def", commitsBehind: 2 },
  });
  mockImport.mockResolvedValue({
    success: true,
    data: { remote: "https://acct.artifacts.cloudflare.net/alice__my-repo" },
  } as Awaited<ReturnType<typeof importFromGitHub>>);
});

describe("syncAllProjects (project-sync cron)", () => {
  it("imports into the Artifacts repo name (ns__slug), not the display name", async () => {
    mockListProjects.mockResolvedValue({ success: true, data: [makeProject()] });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 1, failed: 0, skipped: 0 });
    expect(mockImport).toHaveBeenCalledTimes(1);
    expect(mockImport).toHaveBeenCalledWith(
      expect.anything(),
      "alice__my-repo",
      "https://github.com/alice/my-repo",
      expect.anything(),
      "main",
    );
    // Snapshot is written from the imported repo's remote for namespace/slug.
    expect(mockSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        remote: "https://acct.artifacts.cloudflare.net/alice__my-repo",
        namespace: "@alice",
        slug: "my-repo",
      }),
      expect.anything(),
    );
  });

  it("passes the project's resolved default branch to the import", async () => {
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ sourceDefaultBranch: "trunk" })],
    });

    await syncAllProjects(makeEnv());

    expect(mockImport).toHaveBeenCalledWith(
      expect.anything(),
      "alice__my-repo",
      "https://github.com/alice/my-repo",
      expect.anything(),
      "trunk",
    );
  });

  it("prefers sourceDefaultBranch over githubDefaultBranch when both are set", async () => {
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ sourceDefaultBranch: "trunk", githubDefaultBranch: "master" })],
    });

    await syncAllProjects(makeEnv());

    expect(mockImport).toHaveBeenCalledWith(
      expect.anything(),
      "alice__my-repo",
      "https://github.com/alice/my-repo",
      expect.anything(),
      "trunk",
    );
  });

  it("counts the project as failed when recording sync metadata fails", async () => {
    mockUpdateAfterSync.mockResolvedValueOnce({
      success: false,
      error: Object.assign(new Error("KV write failed"), {
        code: "STORAGE_ERROR",
        statusCode: 500,
      }),
    } as Awaited<ReturnType<typeof updateProjectAfterSync>>);
    mockListProjects.mockResolvedValue({ success: true, data: [makeProject()] });

    const result = await syncAllProjects(makeEnv());

    // The import itself succeeded, but a stale lastSyncedCommit would trigger
    // a pointless re-import next run — report it as failed, not synced.
    expect(result).toEqual({ synced: 0, failed: 1, skipped: 0 });
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });

  it("skips projects that have not enabled auto-sync", async () => {
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ autoSyncEnabled: false }), makeProject({ autoSyncEnabled: undefined })],
    });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 0, skipped: 0 });
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("skips projects with no source URL", async () => {
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ githubUrl: undefined, sourceUrl: undefined })],
    });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 0, skipped: 0 });
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("does not re-import when the remote has no updates", async () => {
    mockCheck.mockResolvedValue({ success: true, data: { hasUpdates: false } });
    mockListProjects.mockResolvedValue({ success: true, data: [makeProject()] });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 0, skipped: 1 });
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it("records the synced commit after a successful sync", async () => {
    const project = makeProject();
    mockListProjects.mockResolvedValue({ success: true, data: [project] });

    await syncAllProjects(makeEnv());

    expect(mockUpdateAfterSync).toHaveBeenCalledWith(
      expect.anything(),
      project,
      "abc1234def",
      expect.anything(),
    );
  });

  it("counts a failed update check as failed and does not import", async () => {
    mockCheck.mockResolvedValue({
      success: false,
      error: Object.assign(new Error("provider down"), { code: "SYNC_ERROR", statusCode: 500 }),
    } as Awaited<ReturnType<typeof checkForSyncUpdates>>);
    mockListProjects.mockResolvedValue({ success: true, data: [makeProject()] });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 1, skipped: 0 });
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("returns zeros and imports nothing when listing projects fails", async () => {
    mockListProjects.mockResolvedValue({
      success: false,
      error: Object.assign(new Error("KV down"), { code: "STORAGE_ERROR", statusCode: 500 }),
    } as Awaited<ReturnType<typeof listProjects>>);

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 0, skipped: 0 });
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("prefers sourceUrl over the legacy githubUrl", async () => {
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ sourceUrl: "https://gitlab.com/alice/my-repo" })],
    });

    await syncAllProjects(makeEnv());

    expect(mockImport).toHaveBeenCalledWith(
      expect.anything(),
      "alice__my-repo",
      "https://gitlab.com/alice/my-repo",
      expect.anything(),
      "main",
    );
  });

  it("falls back to githubDefaultBranch when sourceDefaultBranch is unset", async () => {
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ githubDefaultBranch: "master" })],
    });

    await syncAllProjects(makeEnv());

    expect(mockImport).toHaveBeenCalledWith(
      expect.anything(),
      "alice__my-repo",
      "https://github.com/alice/my-repo",
      expect.anything(),
      "master",
    );
  });

  it("counts a synced project without recording a commit when the check has no latestCommit", async () => {
    mockCheck.mockResolvedValue({
      success: true,
      data: { hasUpdates: true, commitsBehind: 1 },
    });
    mockListProjects.mockResolvedValue({ success: true, data: [makeProject()] });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 1, failed: 0, skipped: 0 });
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockUpdateAfterSync).not.toHaveBeenCalled();
  });

  it("counts a thrown exception as failed and continues with the remaining projects", async () => {
    mockListProjects.mockResolvedValue({
      success: true,
      data: [
        makeProject({ slug: "boom", remote: "https://acct.artifacts.cloudflare.net/alice__boom" }),
        makeProject(),
      ],
    });
    mockImport.mockRejectedValueOnce(new Error("network exploded")).mockResolvedValueOnce({
      success: true,
      data: { remote: "https://acct.artifacts.cloudflare.net/alice__my-repo" },
    } as Awaited<ReturnType<typeof importFromGitHub>>);

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 1, failed: 1, skipped: 0 });
    expect(mockImport).toHaveBeenCalledTimes(2);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });

  it("counts a thrown non-Error value as failed", async () => {
    mockListProjects.mockResolvedValue({ success: true, data: [makeProject()] });
    mockImport.mockRejectedValueOnce("string rejection");

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 1, skipped: 0 });
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it("counts a failed import as failed and writes no snapshot", async () => {
    mockImport.mockResolvedValue({
      success: false,
      error: Object.assign(new Error("import blew up"), { code: "IMPORT_ERROR", statusCode: 502 }),
    } as Awaited<ReturnType<typeof importFromGitHub>>);
    mockListProjects.mockResolvedValue({ success: true, data: [makeProject()] });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 1, skipped: 0 });
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(mockUpdateAfterSync).not.toHaveBeenCalled();
  });
});
