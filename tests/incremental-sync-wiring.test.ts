import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, Message, MessageBatch, ProjectEntry, SyncJobMessage } from "../src/types";
import { AppError } from "../src/utils/errors";

// ---------------------------------------------------------------------------
// #190 wiring: sync call sites (queue consumer + daily cron) must go through
// the incremental syncFromGitHub for existing projects and must NOT re-run the
// destructive importFromGitHub path. artifactsRepoNameFromRemote stays REAL so
// the gate between the two paths is exercised for real.
// ---------------------------------------------------------------------------

vi.mock("../src/storage/git-ops", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage/git-ops")>();
  return {
    ...actual,
    importFromGitHub: vi.fn(),
    syncFromGitHub: vi.fn(),
  };
});

vi.mock("../src/storage/deletion", () => ({
  isTargetDeleting: vi.fn(async () => false),
}));

vi.mock("../src/storage/imports", () => ({
  isImportCancelled: vi.fn(async () => false),
  updateImportStatus: vi.fn(async () => ({ success: true, data: undefined })),
  deleteImportJob: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("../src/storage/metrics", () => ({
  recordImportStarted: vi.fn(async () => {}),
  recordImportCompleted: vi.fn(async () => {}),
  recordImportFailed: vi.fn(async () => {}),
  recordImportCancelled: vi.fn(async () => {}),
}));

vi.mock("../src/storage/repo-snapshot", () => ({
  writeSnapshotFromRepo: vi.fn(async () => ({ success: true, data: undefined })),
}));

const projects = new Map<string, ProjectEntry>();

vi.mock("../src/storage/state", () => ({
  getProjectByPath: vi.fn(async (_kv: unknown, namespace: string, slug: string) => {
    const project = projects.get(`${namespace}/${slug}`);
    return project
      ? { success: true, data: project }
      : { success: false, error: new Error("not found") };
  }),
  setProject: vi.fn(async (_kv: unknown, project: ProjectEntry) => {
    projects.set(`${project.namespace}/${project.slug}`, project);
    return { success: true, data: project };
  }),
  listProjects: vi.fn(async () => ({ success: true, data: [...projects.values()] })),
}));

vi.mock("../src/storage/sync", () => ({
  recordSyncHistory: vi.fn(async () => {}),
  getProjectProvider: vi.fn(() => null),
  getProjectSourceUrl: vi.fn((project: ProjectEntry) => project.sourceUrl || project.githubUrl),
  // Daily cron gates on an update check first; default to "updates available"
  // so the sync/import routing under test actually runs.
  checkForSyncUpdates: vi.fn(async () => ({
    success: true,
    data: { hasUpdates: true, latestCommit: "sha_latest", commitsBehind: 1 },
  })),
  updateProjectAfterSync: vi.fn(async () => ({ success: true, data: undefined })),
  updateProjectSyncError: vi.fn(async () => ({ success: true, data: undefined })),
}));

vi.mock("../src/storage/git-providers", () => ({
  getProviderFromUrl: vi.fn(() => null),
  buildAuthConfig: vi.fn(() => undefined),
  getProvider: vi.fn(),
  parseRepoUrl: vi.fn(() => null),
}));

vi.mock("../src/queue/events", () => ({
  emitEvent: vi.fn(async () => {}),
}));

import { handleImportQueue } from "../src/queue/import-queue";
import { processSyncJob as processFallbackSyncJob } from "../src/routes/projects";
import { syncAllProjects } from "../src/routes/sync";
import { importFromGitHub, syncFromGitHub } from "../src/storage/git-ops";
import { updateImportStatus } from "../src/storage/imports";
import { writeSnapshotFromRepo } from "../src/storage/repo-snapshot";
import { setProject } from "../src/storage/state";
import {
  recordSyncHistory,
  updateProjectAfterSync,
  updateProjectSyncError,
} from "../src/storage/sync";
import type { Logger } from "../src/utils/logger";

const noopLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => noopLogger),
} as unknown as Logger;

const ARTIFACTS_REMOTE = "https://acct.artifacts.cloudflare.net/git/stratum-prod/test__repo.git";
const LEGACY_REMOTE = "https://artifacts.example.com/repos/test__repo";
const GITHUB_URL = "https://github.com/test/repo";

function makeProject(overrides: Partial<ProjectEntry> = {}): ProjectEntry {
  return {
    id: "proj_1",
    name: "repo",
    slug: "repo",
    namespace: "@test",
    ownerId: "user_1",
    ownerType: "user",
    remote: ARTIFACTS_REMOTE,
    createdAt: new Date().toISOString(),
    githubUrl: GITHUB_URL,
    importCompleted: true,
    autoSyncEnabled: true,
    ...overrides,
  };
}

function makeEnv(): Env {
  return {
    ARTIFACTS: {
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      import: vi.fn(),
    } as unknown as Env["ARTIFACTS"],
    STATE: {} as KVNamespace,
    DB: {} as D1Database,
    EVENTS_QUEUE: { send: vi.fn() } as unknown as Queue,
  } as unknown as Env;
}

function makeSyncMessage(overrides: Partial<SyncJobMessage> = {}): Message<SyncJobMessage> {
  const body: SyncJobMessage = {
    type: "github.sync",
    importId: "sync_1",
    projectId: "proj_1",
    namespace: "@test",
    slug: "repo",
    githubUrl: GITHUB_URL,
    branch: "main",
    depth: 10,
    timestamp: new Date().toISOString(),
    trigger: "webhook",
    ...overrides,
  };
  return {
    id: "msg_1",
    timestamp: new Date().toISOString(),
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<SyncJobMessage>;
}

function makeBatch(messages: Message<SyncJobMessage>[]): MessageBatch<SyncJobMessage> {
  return {
    queue: "stratum-imports",
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<SyncJobMessage>;
}

beforeEach(() => {
  projects.clear();
  vi.mocked(importFromGitHub).mockReset();
  vi.mocked(syncFromGitHub).mockReset();
  vi.mocked(setProject).mockClear();
  vi.mocked(recordSyncHistory).mockClear();
  vi.mocked(writeSnapshotFromRepo).mockClear();
  vi.mocked(updateImportStatus).mockClear();
  vi.mocked(updateProjectSyncError).mockClear();
  vi.mocked(updateProjectAfterSync).mockClear();
});

describe("queue consumer sync jobs (webhook + manual sync)", () => {
  it("syncs an existing project incrementally, keeping the same remote", async () => {
    const project = makeProject();
    projects.set("@test/repo", project);
    vi.mocked(syncFromGitHub).mockResolvedValue({
      success: true,
      data: { status: "fast-forwarded", commit: "newsha" },
    });

    const env = makeEnv();
    const msg = makeSyncMessage();
    await handleImportQueue(makeBatch([msg]), env);

    expect(syncFromGitHub).toHaveBeenCalledWith(
      env.ARTIFACTS,
      ARTIFACTS_REMOTE,
      GITHUB_URL,
      expect.anything(),
      "main",
    );
    // The destructive re-import path must not run for existing projects.
    expect(importFromGitHub).not.toHaveBeenCalled();
    expect(env.ARTIFACTS.delete).not.toHaveBeenCalled();

    const updated = projects.get("@test/repo");
    expect(updated?.remote).toBe(ARTIFACTS_REMOTE);
    expect(updated?.lastSyncStatus).toBe("success");
    expect(recordSyncHistory).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ status: "success", trigger: "webhook" }),
      expect.anything(),
    );
    expect(writeSnapshotFromRepo).toHaveBeenCalledWith(
      env.STATE,
      env.ARTIFACTS,
      expect.objectContaining({ remote: ARTIFACTS_REMOTE }),
      expect.anything(),
    );
    expect(msg.ack).toHaveBeenCalled();
  });

  it("falls back to full import only when the project has no Artifacts remote", async () => {
    const project = makeProject({ remote: LEGACY_REMOTE });
    projects.set("@test/repo", project);
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { remote: ARTIFACTS_REMOTE, token: "tok" } as never,
    });

    const env = makeEnv();
    const msg = makeSyncMessage();
    await handleImportQueue(makeBatch([msg]), env);

    expect(syncFromGitHub).not.toHaveBeenCalled();
    expect(importFromGitHub).toHaveBeenCalledWith(
      env.ARTIFACTS,
      "test__repo",
      GITHUB_URL,
      expect.anything(),
      "main",
      10,
    );
    // The import result's remote is adopted in this (first-import) case.
    expect(projects.get("@test/repo")?.remote).toBe(ARTIFACTS_REMOTE);
    expect(msg.ack).toHaveBeenCalled();
  });

  it("records a failed sync (diverged history) without deleting or re-importing", async () => {
    const project = makeProject();
    projects.set("@test/repo", project);
    vi.mocked(syncFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("Sync aborted: source history has diverged", "SYNC_DIVERGED", 409),
    });

    const env = makeEnv();
    const msg = makeSyncMessage();
    await handleImportQueue(makeBatch([msg]), env);

    expect(importFromGitHub).not.toHaveBeenCalled();
    expect(env.ARTIFACTS.delete).not.toHaveBeenCalled();
    const updated = projects.get("@test/repo");
    expect(updated?.remote).toBe(ARTIFACTS_REMOTE);
    expect(updated?.lastSyncStatus).toBe("failed");
    expect(updated?.lastSyncError).toContain("diverged");
    expect(recordSyncHistory).toHaveBeenCalledWith(
      env.DB,
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(msg.ack).toHaveBeenCalled();
    expect(msg.retry).not.toHaveBeenCalled();
  });
});

describe("syncAllProjects (daily cron)", () => {
  it("syncs existing projects incrementally and legacy projects via import", async () => {
    projects.set("@test/repo", makeProject({ sourceDefaultBranch: "develop" }));
    projects.set(
      "@test/legacy",
      makeProject({ id: "proj_2", slug: "legacy", name: "legacy", remote: LEGACY_REMOTE }),
    );
    projects.set(
      "@test/no-github",
      makeProject({ id: "proj_3", slug: "no-github", name: "no-github", githubUrl: undefined }),
    );
    vi.mocked(syncFromGitHub).mockResolvedValue({
      success: true,
      data: { status: "up-to-date", commit: "sha" },
    });
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { remote: ARTIFACTS_REMOTE, token: "tok" } as never,
    });

    const env = makeEnv();
    const result = await syncAllProjects(env);

    expect(result).toEqual({ synced: 2, failed: 0, skipped: 0 });
    expect(syncFromGitHub).toHaveBeenCalledTimes(1);
    expect(syncFromGitHub).toHaveBeenCalledWith(
      env.ARTIFACTS,
      ARTIFACTS_REMOTE,
      GITHUB_URL,
      expect.anything(),
      "develop",
    );
    expect(importFromGitHub).toHaveBeenCalledTimes(1);
    expect(importFromGitHub).toHaveBeenCalledWith(
      env.ARTIFACTS,
      "test__legacy",
      GITHUB_URL,
      expect.anything(),
      "main",
    );
    // Snapshots refreshed against the surviving remotes.
    expect(writeSnapshotFromRepo).toHaveBeenCalledWith(
      env.STATE,
      env.ARTIFACTS,
      expect.objectContaining({ remote: ARTIFACTS_REMOTE, slug: "repo" }),
      expect.anything(),
    );
    // The legacy project's newly imported Artifacts remote must be persisted —
    // otherwise the next cron run still sees LEGACY_REMOTE and re-runs the
    // destructive full import against an already-existing target.
    expect(updateProjectAfterSync).toHaveBeenCalledWith(
      env.STATE,
      expect.objectContaining({ slug: "legacy", remote: ARTIFACTS_REMOTE }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("counts a diverged incremental sync as failed without re-importing", async () => {
    projects.set("@test/repo", makeProject());
    vi.mocked(syncFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("diverged", "SYNC_DIVERGED", 409),
    });

    const env = makeEnv();
    const result = await syncAllProjects(env);

    expect(result).toEqual({ synced: 0, failed: 1, skipped: 0 });
    expect(importFromGitHub).not.toHaveBeenCalled();
    expect(env.ARTIFACTS.delete).not.toHaveBeenCalled();
    expect(writeSnapshotFromRepo).not.toHaveBeenCalled();
  });

  it("counts a thrown sync as failed and continues", async () => {
    projects.set("@test/repo", makeProject());
    vi.mocked(syncFromGitHub).mockRejectedValue(new Error("boom"));

    const result = await syncAllProjects(makeEnv());

    expect(result).toEqual({ synced: 0, failed: 1, skipped: 0 });
  });
});

describe("projects route processSyncJob (queue-less fallback)", () => {
  it("syncs incrementally into the existing repo", async () => {
    const project = makeProject();
    vi.mocked(syncFromGitHub).mockResolvedValue({
      success: true,
      data: { status: "merged", commit: "mergesha" },
    });

    const env = makeEnv();
    await processFallbackSyncJob(env, project, "sync_1", GITHUB_URL, "main", noopLogger);

    expect(syncFromGitHub).toHaveBeenCalledWith(
      env.ARTIFACTS,
      ARTIFACTS_REMOTE,
      GITHUB_URL,
      expect.anything(),
      "main",
    );
    expect(importFromGitHub).not.toHaveBeenCalled();
    expect(writeSnapshotFromRepo).toHaveBeenCalledWith(
      env.STATE,
      env.ARTIFACTS,
      expect.objectContaining({ remote: ARTIFACTS_REMOTE }),
      expect.anything(),
    );
    expect(updateImportStatus).toHaveBeenCalledWith(
      env.DB,
      "@test",
      "repo",
      "completed",
      expect.anything(),
      expect.any(String),
    );
  });

  it("records a diverged sync as failed without importing or deleting", async () => {
    const project = makeProject();
    vi.mocked(syncFromGitHub).mockResolvedValue({
      success: false,
      error: new AppError("Sync aborted: diverged", "SYNC_DIVERGED", 409),
    });

    const env = makeEnv();
    await processFallbackSyncJob(env, project, "sync_1", GITHUB_URL, "main", noopLogger);

    expect(importFromGitHub).not.toHaveBeenCalled();
    expect(env.ARTIFACTS.delete).not.toHaveBeenCalled();
    expect(updateProjectSyncError).toHaveBeenCalledWith(
      env.STATE,
      project,
      expect.stringContaining("diverged"),
      expect.anything(),
    );
    expect(updateImportStatus).toHaveBeenCalledWith(
      env.DB,
      "@test",
      "repo",
      "failed",
      expect.anything(),
      expect.stringContaining("diverged"),
    );
    expect(writeSnapshotFromRepo).not.toHaveBeenCalled();
  });

  it("falls back to full import for a project without an Artifacts remote", async () => {
    const project = makeProject({ remote: LEGACY_REMOTE });
    vi.mocked(importFromGitHub).mockResolvedValue({
      success: true,
      data: { remote: ARTIFACTS_REMOTE, token: "tok" } as never,
    });

    const env = makeEnv();
    await processFallbackSyncJob(env, project, "sync_1", GITHUB_URL, "main", noopLogger);

    expect(syncFromGitHub).not.toHaveBeenCalled();
    expect(importFromGitHub).toHaveBeenCalledWith(
      env.ARTIFACTS,
      "test__repo",
      GITHUB_URL,
      expect.anything(),
      "main",
      10,
    );
    expect(writeSnapshotFromRepo).toHaveBeenCalledWith(
      env.STATE,
      env.ARTIFACTS,
      expect.objectContaining({ remote: ARTIFACTS_REMOTE }),
      expect.anything(),
    );
    // The newly imported Artifacts remote must be persisted — otherwise the
    // next sync still sees LEGACY_REMOTE and re-runs the destructive full
    // import against an already-existing target.
    expect(updateProjectAfterSync).toHaveBeenCalledWith(
      env.STATE,
      expect.objectContaining({ remote: ARTIFACTS_REMOTE }),
      expect.anything(),
      expect.anything(),
    );
  });
});
