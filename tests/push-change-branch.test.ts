import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "../src/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../src/storage/state", () => ({
  getWorkspace: vi.fn(),
}));

vi.mock("../src/github/client", () => ({
  getGitHubToken: vi.fn(),
  GitHubClient: vi.fn(),
}));

import { GitHubClient, getGitHubToken } from "../src/github/client";
import { pushChangeToGitHub } from "../src/github/sync";
import { getWorkspace } from "../src/storage/state";
import { createLogger } from "../src/utils/logger";

const logger = createLogger({ component: "test" });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT = {
  id: "proj-1",
  name: "my-repo",
  namespace: "@owner",
  slug: "my-repo",
  ownerId: "user-1",
  ownerType: "user" as const,
  remote: "https://artifacts.example.com/repo",
  token: "token123",
  sourceUrl: "https://github.com/owner/repo",
  sourceDefaultBranch: "main",
  createdAt: new Date().toISOString(),
};

const CHANGE = {
  id: "change-abc12345",
  project: "proj-1",
  workspace: "ws-1234",
  status: "open" as const,
  createdAt: new Date().toISOString(),
};

function makeKv(_workspace?: Partial<WorkspaceEntry>): KVNamespace {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function makeDb(): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    })),
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pushChangeToGitHub — branch resolution", () => {
  it("uses workspace.branchName when present", async () => {
    vi.mocked(getWorkspace).mockResolvedValueOnce({
      success: true,
      data: {
        name: "ws-1234",
        branchName: "ws-1234",
        remote: "https://artifacts.example.com/fork",
        token: "fork-token",
        parent: "proj-1",
        createdAt: new Date().toISOString(),
      },
    });

    vi.mocked(getGitHubToken).mockResolvedValueOnce({
      accessToken: "gh-token",
      userId: "user-1",
      githubUsername: "owner",
    } as Awaited<ReturnType<typeof getGitHubToken>>);

    const createPRMock = vi.fn().mockResolvedValue({
      success: true,
      pr: { number: 42, html_url: "https://github.com/owner/repo/pull/42" },
    });

    vi.mocked(GitHubClient).mockImplementation(
      () =>
        ({
          createPR: createPRMock,
          updatePR: vi.fn(),
        }) as unknown as InstanceType<typeof GitHubClient>,
    );

    const result = await pushChangeToGitHub(
      makeDb(),
      makeKv(),
      { change: CHANGE, project: PROJECT, userId: "user-1" },
      "secret",
      logger,
    );

    expect(createPRMock).toHaveBeenCalledWith(expect.objectContaining({ head: "ws-1234" }));
    expect(result.success).toBe(true);
  });

  it("falls back to workspace.name when branchName is absent", async () => {
    vi.mocked(getWorkspace).mockResolvedValueOnce({
      success: true,
      data: {
        name: "ws-legacy",
        // branchName absent — old workspace
        remote: "https://artifacts.example.com/fork",
        token: "fork-token",
        parent: "proj-1",
        createdAt: new Date().toISOString(),
      },
    });

    vi.mocked(getGitHubToken).mockResolvedValueOnce({
      accessToken: "gh-token",
      userId: "user-1",
      githubUsername: "owner",
    } as Awaited<ReturnType<typeof getGitHubToken>>);

    const createPRMock = vi.fn().mockResolvedValue({
      success: true,
      pr: { number: 7, html_url: "https://github.com/owner/repo/pull/7" },
    });

    vi.mocked(GitHubClient).mockImplementation(
      () =>
        ({
          createPR: createPRMock,
          updatePR: vi.fn(),
        }) as unknown as InstanceType<typeof GitHubClient>,
    );

    const changeWithLegacyWs = { ...CHANGE, workspace: "ws-legacy" };
    const result = await pushChangeToGitHub(
      makeDb(),
      makeKv(),
      { change: changeWithLegacyWs, project: PROJECT, userId: "user-1" },
      "secret",
      logger,
    );

    expect(createPRMock).toHaveBeenCalledWith(expect.objectContaining({ head: "ws-legacy" }));
    expect(result.success).toBe(true);
  });

  it("returns NOT_FOUND when workspace does not exist", async () => {
    vi.mocked(getWorkspace).mockResolvedValueOnce({
      success: false,
      error: { message: "Workspace not found", code: "NOT_FOUND", statusCode: 404 },
    } as Awaited<ReturnType<typeof getWorkspace>>);

    const result = await pushChangeToGitHub(
      makeDb(),
      makeKv(),
      { change: CHANGE, project: PROJECT, userId: "user-1" },
      "secret",
      logger,
    );

    expect(result.success).toBe(false);
    expect(!result.success && result.error.code).toBe("NOT_FOUND");
  });

  it("getWorkspace is called with project.id and change.workspace", async () => {
    vi.mocked(getWorkspace).mockResolvedValueOnce({
      success: false,
      error: { message: "not found", code: "NOT_FOUND", statusCode: 404 },
    } as Awaited<ReturnType<typeof getWorkspace>>);

    const kv = makeKv();
    await pushChangeToGitHub(
      makeDb(),
      kv,
      { change: CHANGE, project: PROJECT, userId: "user-1" },
      "secret",
      logger,
    );

    expect(vi.mocked(getWorkspace)).toHaveBeenCalledWith(
      kv,
      "proj-1",
      "ws-1234",
      expect.anything(),
    );
  });
});
