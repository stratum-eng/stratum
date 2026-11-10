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

// These suites run against a stub database with no `push_mirrors` table. The
// layer-mode guards refuse when a project's mirror state cannot be read (#417),
// so the lookup is answered here: none of these projects has a mirror.
vi.mock("../src/storage/push-mirrors", async (importActual) => ({
  ...(await importActual<typeof import("../src/storage/push-mirrors")>()),
  pushMirrorMode: vi.fn(async () => "layer" as const),
}));

vi.mock("../src/storage/state", () => ({
  listProjects: vi.fn(),
  setProject: vi.fn(async () => ({ success: true, data: undefined })),
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

import { importFromGitHub, syncFromGitHub } from "../src/storage/git-ops";
import { writeSnapshotFromRepo } from "../src/storage/repo-snapshot";
import { listProjects, setProject } from "../src/storage/state";
import { checkForSyncUpdates, updateProjectAfterSync } from "../src/storage/sync";

const mockListProjects = vi.mocked(listProjects);
const mockImport = vi.mocked(importFromGitHub);
const mockSync = vi.mocked(syncFromGitHub);
const mockCheck = vi.mocked(checkForSyncUpdates);
const mockSnapshot = vi.mocked(writeSnapshotFromRepo);
const mockUpdateAfterSync = vi.mocked(updateProjectAfterSync);
const mockSetProject = vi.mocked(setProject);

/**
 * A remote that artifactsRepoNameFromRemote actually parses. Its regex requires
 * a `/git/<owner>/<repo>` pathname; a bare `/<repo>` returns null and routes the
 * project down the legacy full-import branch.
 */
const ARTIFACTS_REMOTE = "https://acct.artifacts.cloudflare.net/git/alice/alice__my-repo";

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
  // clearAllMocks resets calls but not implementations, so the failure case
  // below would otherwise leak into every test that follows it.
  mockSetProject.mockResolvedValue({ success: true, data: undefined } as Awaited<
    ReturnType<typeof setProject>
  >);
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
      // The cron passes no depth; the shared helper forwards it as undefined,
      // so importFromGitHub falls back to its own default.
      undefined,
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
      undefined,
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
      undefined,
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
      // The cron passes no depth; the shared helper forwards it as undefined,
      // so importFromGitHub falls back to its own default.
      undefined,
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
      // The cron passes no depth; the shared helper forwards it as undefined,
      // so importFromGitHub falls back to its own default.
      undefined,
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

  it("persists the imported remote when a legacy fallback import reports no latestCommit", async () => {
    // The legacy branch is chosen by artifactsRepoNameFromRemote(project.remote)
    // returning null, and importFromGitHub then mints a NEW Artifacts remote.
    // With no latestCommit there is no updateProjectAfterSync call to carry that
    // remote into KV, so it has to be written on its own — otherwise the next
    // cron run reads the legacy remote, takes the fallback again, and
    // importFromGitHub deletes the repo this run just created.
    mockCheck.mockResolvedValue({
      success: true,
      data: { hasUpdates: true, commitsBehind: 1 },
    });
    mockImport.mockResolvedValue({
      success: true,
      data: { remote: "https://acct.artifacts.cloudflare.net/alice__my-repo" },
    } as Awaited<ReturnType<typeof importFromGitHub>>);
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ remote: "https://legacy.example.com/alice/my-repo" })],
    });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 1, failed: 0, skipped: 0 });
    expect(mockUpdateAfterSync).not.toHaveBeenCalled();
    expect(mockSetProject).toHaveBeenCalledTimes(1);
    expect(mockSetProject).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        remote: "https://acct.artifacts.cloudflare.net/alice__my-repo",
      }),
      expect.anything(),
    );
    // lastSyncedCommit must stay untouched rather than being stamped with a
    // placeholder, which would poison the next run's commit comparison.
    expect(mockSetProject.mock.calls[0]?.[1]).not.toHaveProperty("lastSyncedCommit");
  });

  it("counts the project as failed when persisting the imported remote fails", async () => {
    mockCheck.mockResolvedValue({
      success: true,
      data: { hasUpdates: true, commitsBehind: 1 },
    });
    mockImport.mockResolvedValue({
      success: true,
      data: { remote: "https://acct.artifacts.cloudflare.net/alice__my-repo" },
    } as Awaited<ReturnType<typeof importFromGitHub>>);
    mockSetProject.mockResolvedValue({
      success: false,
      error: new Error("kv down"),
    } as Awaited<ReturnType<typeof setProject>>);
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ remote: "https://legacy.example.com/alice/my-repo" })],
    });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 1, skipped: 0 });
  });

  it("does not write the remote separately when the incremental path keeps it stable", async () => {
    // Guards the else-if condition: an existing Artifacts remote syncs
    // incrementally, syncedRemote === project.remote, so there is nothing to
    // persist and no redundant KV write should happen.
    //
    // The remote MUST be a real Artifacts URL (`/git/<owner>/<repo>`) or
    // artifactsRepoNameFromRemote returns null and this silently exercises the
    // legacy import path instead — which is what an earlier version of this
    // test did, passing for the wrong reason.
    mockCheck.mockResolvedValue({
      success: true,
      data: { hasUpdates: true, commitsBehind: 1 },
    });
    mockSync.mockResolvedValue({
      success: true,
      data: { status: "fast-forwarded", commit: "abc1234" },
    } as Awaited<ReturnType<typeof syncFromGitHub>>);
    mockListProjects.mockResolvedValue({
      success: true,
      data: [makeProject({ remote: ARTIFACTS_REMOTE })],
    });

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 1, failed: 0, skipped: 0 });
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockSetProject).not.toHaveBeenCalled();
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
